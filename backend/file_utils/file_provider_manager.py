# status: complete

import multiprocessing
from pathlib import Path
from typing import Dict, List, Any
from utils.logger import get_logger
from utils.db_utils import db
from utils.cancellation_manager import cancellation_manager
from file_utils.upload_worker import start_upload_process
from utils.config import get_provider_map
from file_utils.markdown_processor import setup_filespace, process_file_to_markdown
import concurrent.futures
import threading

if hasattr(multiprocessing, 'set_start_method'):
    try:
        multiprocessing.set_start_method('spawn', force=True)
    except RuntimeError:
        pass 

logger = get_logger(__name__)

def get_file_path(file_id):
    """Get the physical file path for a file ID."""
    try:
        file_record = db.get_file_record(file_id)
        if not file_record:
            return None
        
        files_dir = Path(setup_filespace())
        return files_dir / file_record['stored_filename']
    
    except Exception as e:
        logger.error(f"Error getting file path: {str(e)}")
        return None

class FileProviderManager:
    """Manages file operations across different providers with state tracking"""
    
    def __init__(self):
        self.providers = get_provider_map()
    
    def get_provider_file_limits(self, provider_name: str) -> Dict[str, Any]:
        """Get provider-specific file limits and restrictions"""
        provider = self.providers.get(provider_name)
        if not provider or not hasattr(provider, 'get_file_size_limit'):
            return {'size_limit': 0, 'supported': False, 'direct_upload_extensions': set()}
        
        direct_extensions = set()
        if hasattr(provider, 'get_direct_upload_extensions'):
            direct_extensions = provider.get_direct_upload_extensions()
        
        return {
            'size_limit': provider.get_file_size_limit(),
            'supported': True,
            'direct_upload_extensions': direct_extensions
        }
    
    def _poll_until_ready(self, api_file_name: str, file_id: str, provider_name: str, timeout_s: int = 300, stop_event: threading.Event = None) -> str:
        """Poll provider until file is truly ready, updating states in real-time"""
        import time
        import random
        
        provider = self.providers.get(provider_name)
        if not provider:
            logger.error(f"Provider {provider_name} not available for polling")
            db.update_file_api_info(file_id, api_state='error')
            return 'error'
        
        stagger_delay = random.uniform(0.1, 0.5)
        time.sleep(stagger_delay)
        
        start_time = time.time()
        poll_interval = 0.5  
        max_interval = 8.0
        
        db.update_file_api_info(file_id, api_state='processing')
        logger.info(f"Starting readiness polling for file {file_id} ({api_file_name}) with {stagger_delay:.2f}s stagger")
        
        while (time.time() - start_time) < timeout_s:
            try:
                if cancellation_manager.is_cancelled(file_id):
                    logger.info(f"[CANCEL] Polling cancelled for file {file_id}")
                    return 'cancelled'
                
                if stop_event and stop_event.is_set():
                    logger.info(f"[CANCEL] Polling stopped by event for file {file_id}")
                    return 'cancelled'
                
                metadata_result = provider.get_file_metadata(api_file_name)

                if not metadata_result['success']:
                    error_msg = metadata_result.get('error', '')
                    error_str = str(error_msg)

                    fatal_error_indicators = [
                        'Failed to convert server response',
                        'INVALID_ARGUMENT',
                        'unsupported',
                        'invalid format',
                        'cannot process'
                    ]

                    is_fatal = any(indicator.lower() in error_str.lower() for indicator in fatal_error_indicators)

                    if '403' in error_str and 'PERMISSION_DENIED' in error_str:
                        logger.error(f"[POLLING] File {file_id} ({api_file_name}) permission denied (likely deleted), stopping polling")
                        db.update_file_api_info(file_id, api_state='error')
                        return 'error'

                    if is_fatal:
                        logger.error(f"[POLLING] Fatal error detected for file {file_id} ({api_file_name}): {error_msg}")
                        logger.error(f"[POLLING] File format likely incompatible with provider, stopping polling")
                        db.update_file_api_info(file_id, api_state='error')
                        return 'error'

                    logger.warning(f"Failed to get metadata for {api_file_name}: {error_msg}")
                    time.sleep(poll_interval)
                    continue
                
                current_state = metadata_result['state']
                elapsed = time.time() - start_time
                logger.info(f"[INDIVIDUAL] File {file_id} state: {current_state} after {elapsed:.1f}s")
                
                if current_state == 'ready':
                    db_record = db.get_file_record(file_id)
                    db_api_file_name = db_record.get('api_file_name') if db_record else None
                    
                    if db_api_file_name and db_api_file_name != 'None':
                        if not cancellation_manager.is_cancelled(file_id):
                            db.update_file_api_info(file_id, api_state='ready')
                        elapsed = time.time() - start_time
                        logger.info(f"File {file_id} is ready after {elapsed:.1f}s of polling (Gemini: ready, DB: {db_api_file_name})")
                        return 'ready'
                    else:
                        logger.info(f"File {file_id}: Gemini reports ready but DB api_file_name is '{db_api_file_name}' - continuing to poll")
                        if not cancellation_manager.is_cancelled(file_id):
                            db.update_file_api_info(file_id, api_state='processing')
                        time.sleep(poll_interval)
                        continue
                elif current_state == 'error':
                    if not cancellation_manager.is_cancelled(file_id):
                        db.update_file_api_info(file_id, api_state='error')
                    logger.error(f"File {file_id} failed during provider processing")
                    return 'error'
                else:
                    if not cancellation_manager.is_cancelled(file_id):
                        db.update_file_api_info(file_id, api_state=current_state)
                
                for _ in range(int(poll_interval * 10)): 
                    if cancellation_manager.is_cancelled(file_id) or (stop_event and stop_event.is_set()):
                        logger.info(f"[CANCEL] Polling cancelled during sleep for file {file_id}")
                        return 'cancelled'
                    time.sleep(0.1)
                
                poll_interval = min(poll_interval * 1.2, max_interval)
                
            except Exception as e:
                logger.error(f"Error during readiness polling for file {file_id}: {str(e)}")
                time.sleep(poll_interval)
        
        logger.warning(f"Readiness polling timeout for file {file_id} after {timeout_s}s")
        db.update_file_api_info(file_id, api_state='error')
        return 'error'
    
    def _start_parallel_polling(self, uploaded_files: List[Dict[str, Any]], provider_name: str):
        """Start parallel readiness polling for multiple files in background threads"""
        import threading
        
        def poll_file_readiness(file_info: Dict[str, Any], stop_event: threading.Event):
            """Background thread function to poll individual file readiness"""
            try:
                file_id = file_info['file_id']
                api_file_name = file_info['api_file_name']
                
                logger.info(f"[BACKGROUND-POLL] Starting readiness polling for file {file_id}")
                final_state = self._poll_until_ready(api_file_name, file_id, provider_name, stop_event=stop_event)
                logger.info(f"[BACKGROUND-POLL] File {file_id} reached final state: {final_state}")
                
            except Exception as e:
                logger.error(f"[BACKGROUND-POLL] Error polling file {file_info.get('file_id', 'unknown')}: {str(e)}")
            finally:
                cancellation_manager.unregister_task(file_id, 'polling_event')
        
        for file_info in uploaded_files:
            file_id = file_info['file_id']
            
            stop_event = threading.Event()
            
            cancellation_manager.register_polling_event(file_id, stop_event)
            
            thread = threading.Thread(
                target=poll_file_readiness,
                args=(file_info, stop_event),
                daemon=True,  
                name=f"ReadinessPoll-{file_id[:8]}"
            )
            thread.start()
            logger.info(f"[BACKGROUND-POLL] Started background polling thread for file {file_id}")
    
    def _batch_upload_to_api(self, upload_infos: List[Dict[str, Any]], provider_name: str) -> List[Dict[str, Any]]:
        """Upload multiple files to API in true parallel using ThreadPoolExecutor"""
        provider = self.providers.get(provider_name)
        if not provider:
            return [{
                'file_id': info['file_id'],
                'success': False,
                'error': f'Provider {provider_name} not available'
            } for info in upload_infos]
        
        results = []
        
        def upload_single_to_api(upload_info: Dict[str, Any]) -> Dict[str, Any]:
            """Upload a single file to API - designed for true parallel execution"""
            file_id = upload_info['file_id']
            upload_path = upload_info['upload_path']
            display_name = upload_info['display_name']
            
            try:
                logger.info(f"[API-UPLOAD] Starting API upload for file {file_id}")
                
                upload_result = provider.upload_file(
                    upload_path, 
                    display_name, 
                    timeout_seconds=300,  
                    file_id=file_id
                )
                
                if upload_result['success']:
                    db.update_file_api_info(
                        file_id, 
                        api_file_name=upload_result['api_file_name'],
                        api_state=upload_result['state'],
                        provider=provider_name
                    )
                    
                    result_data = {
                        'file_id': file_id,
                        'success': True,
                        'api_file_name': upload_result['api_file_name'],
                        'state': upload_result['state']
                    }
                    
                    if upload_info['md_result']:
                        result_data['md_filename'] = upload_info['md_result']['md_filename']
                    
                    logger.info(f"[API-UPLOAD] Successfully uploaded file {file_id} to API")
                    return result_data
                else:
                    db.update_file_api_info(file_id, api_state='error')
                    error_msg = upload_result.get('error', 'Unknown upload error')
                    logger.error(f"[API-UPLOAD] Failed to upload file {file_id}: {error_msg}")
                    return {
                        'file_id': file_id,
                        'success': False,
                        'error': error_msg
                    }
            
            except Exception as e:
                db.update_file_api_info(file_id, api_state='error')
                logger.error(f"[API-UPLOAD] Exception uploading file {file_id}: {str(e)}")
                return {
                    'file_id': file_id,
                    'success': False,
                    'error': str(e)
                }
        
        max_processes = min(len(upload_infos), 8) 
        logger.info(f"[API-UPLOAD] Uploading {len(upload_infos)} files to {provider_name} API with {max_processes} parallel processes")
        
        
        
        active_processes = {}
        
        try:
            for info in upload_infos:
                file_id = info['file_id']
                upload_path = info['upload_path']
                display_name = info['display_name']
                
                logger.info(f"[MULTIPROCESS] Starting upload process for file {file_id}")
                
                process, conn = start_upload_process(upload_path, display_name, file_id)
                active_processes[file_id] = {'process': process, 'conn': conn, 'info': info}
                
                cancellation_manager.register_process(file_id, process)
            
            for file_id, proc_info in active_processes.items():
                process = proc_info['process']
                conn = proc_info['conn']
                info = proc_info['info']
                
                try:
                    if cancellation_manager.is_cancelled(file_id):
                        logger.info(f"[CANCEL] File {file_id} cancelled, terminating process")
                        if process.is_alive():
                            process.terminate()
                            process.join(timeout=2)
                            if process.is_alive():
                                process.kill()
                        results.append({
                            'file_id': file_id,
                            'success': False,
                            'error': 'Upload process cancelled'
                        })
                        continue
                    
                    process.join(timeout=300)
                    
                    if process.is_alive():
                        logger.error(f"[MULTIPROCESS] Upload process for {file_id} timed out, terminating")
                        process.terminate()
                        process.join(timeout=2)
                        if process.is_alive():
                            process.kill()
                        results.append({
                            'file_id': file_id,
                            'success': False,
                            'error': 'Upload process timed out'
                        })
                        continue
                    
                    if conn.poll():
                        try:
                            result = conn.recv()
                            logger.info(f"[MULTIPROCESS] Upload process completed for file {file_id}: {result.get('success')}")
                            results.append(result)
                        except (EOFError, OSError, ConnectionResetError) as e:
                            logger.warning(f"[MULTIPROCESS] Process communication failed for {file_id}: {str(e)}")
                            results.append({
                                'file_id': file_id,
                                'success': False,
                                'error': f'Process communication failed: {str(e)}'
                            })
                    else:
                        logger.error(f"[MULTIPROCESS] No result received from upload process for {file_id}")
                        results.append({
                            'file_id': file_id,
                            'success': False,
                            'error': 'Upload process finished but no result received'
                        })
                
                except Exception as e:
                    logger.error(f"[MULTIPROCESS] Exception handling upload process for {file_id}: {str(e)}")
                    results.append({
                        'file_id': file_id,
                        'success': False,
                        'error': str(e)
                    })
                finally:
                    cancellation_manager.unregister_task(file_id, 'process')
                    try:
                        conn.close()
                    except:
                        pass
        
        except Exception as e:
            logger.error(f"[MULTIPROCESS] Critical error in multiprocessing upload: {str(e)}")
            for file_id, proc_info in active_processes.items():
                process = proc_info['process']
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=1)
                    if process.is_alive():
                        process.kill()
                cancellation_manager.unregister_task(file_id, 'process')
            raise
        
        uploaded_files = []
        for result in results:
            if result.get('success') and result.get('api_file_name'):
                file_id = result['file_id']
                api_file_name = result['api_file_name']
                gemini_state = result.get('state', 'uploaded')
                
                state_mapping = {
                    'active': 'processing',  # Gemini "active" means still processing for us
                    'processing': 'processing',
                    'ready': 'ready',
                    'error': 'error',
                    'failed': 'error'
                }
                api_state = state_mapping.get(gemini_state, 'processing')
                
                db.update_file_api_info(
                    file_id,
                    api_file_name=api_file_name,
                    api_state=api_state,
                    provider=provider_name
                )
                logger.info(f"[MULTIPROCESS-DB] Updated database for file {file_id}: api_file_name={api_file_name}, gemini_state={gemini_state}, db_state={api_state}")
                uploaded_files.append(result)
        
        if uploaded_files:
            logger.info(f"[API-UPLOAD] Starting background readiness polling for {len(uploaded_files)} files")
            self._start_parallel_polling(uploaded_files, provider_name)
        
        logger.info(f"[API-UPLOAD] API upload batch completed: {len(uploaded_files)}/{len(upload_infos)} successful")
        return results
    
    def process_and_upload_files(self, file_ids: List[str], provider_name: str = 'gemini') -> Dict[str, Any]:
        """Process multiple files in parallel: markdown conversion and API upload with state tracking"""
        provider = self.providers.get(provider_name)
        if not provider:
            return {
                'success': False,
                'error': f'Provider {provider_name} not available',
                'results': []
            }
        
        
        
        results = []
        successful_uploads = 0
        
        def process_single_file(file_id: str) -> Dict[str, Any]:
            """Process a single file - designed to run in parallel"""
            try:
                db.update_file_api_info(file_id, provider=provider_name)
                
                file_record = db.get_file_record(file_id)
                if not file_record:
                    return {
                        'file_id': file_id,
                        'success': False,
                        'error': 'File not found in database'
                    }
                
                file_path = get_file_path(file_id)
                if not file_path or not file_path.exists():
                    db.update_file_api_info(file_id, api_state='error')
                    return {
                        'file_id': file_id,
                        'success': False,
                        'error': 'Physical file not found'
                    }
                
                files_dir = Path(setup_filespace())
                file_extension = Path(file_record['original_name']).suffix.lower()
                
                provider_limits = self.get_provider_file_limits(provider_name)
                direct_upload_extensions = provider_limits.get('direct_upload_extensions', set())
                
                non_textual_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', 
                                        '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', 
                                        '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv'}
                
                is_non_textual = file_extension in non_textual_extensions
                
                logger.info(f"[PARALLEL] File {file_id} ({file_record['original_name']}) - Extension: {file_extension}, is_non_textual: {is_non_textual}, direct_upload: {file_extension in direct_upload_extensions}")
                
                upload_info = {
                    'file_id': file_id,
                    'file_record': file_record,
                    'file_path': file_path,
                    'upload_path': None,
                    'display_name': None,
                    'md_result': None
                }
                
                if file_extension in direct_upload_extensions:
                    logger.info(f"[PARALLEL] File {file_id} will take DIRECT UPLOAD path")
                    db.update_file_api_info(file_id, api_state='uploading')
                    upload_info['upload_path'] = str(file_path)
                    upload_info['display_name'] = file_record['original_name']
                elif is_non_textual:
                    logger.info(f"[PARALLEL] File {file_id} will take NON-TEXTUAL path")
                    db.update_file_api_info(file_id, api_state='uploading')
                    upload_info['upload_path'] = str(file_path)
                    upload_info['display_name'] = file_record['original_name']
                else:
                    logger.info(f"[PARALLEL] File {file_id} taking MARKDOWN processing path -> setting processing_md (orange)")
                    db.update_file_api_info(file_id, api_state='processing_md')
                    md_result = process_file_to_markdown(str(file_path), file_id)
                    if not md_result['success']:
                        db.update_file_api_info(file_id, api_state='error')
                        return {
                            'file_id': file_id,
                            'success': False,
                            'error': f'Markdown processing failed: {md_result["error"]}'
                        }
                    
                    db.update_file_api_info(file_id, api_state='uploading')
                    upload_info['md_result'] = md_result
                    
                    md_ver_dir = files_dir / "md_ver"
                    upload_info['upload_path'] = str(md_ver_dir / md_result['md_filename'])
                    upload_info['display_name'] = f"{file_record['original_name']} (processed)"
                
                logger.info(f"[PARALLEL] File {file_id} prepared for batch upload")
                return upload_info
            
            except Exception as e:
                db.update_file_api_info(file_id, api_state='error')
                logger.error(f"[PARALLEL] Error processing file {file_id}: {str(e)}")
                return {
                    'file_id': file_id,
                    'success': False,
                    'error': str(e)
                }
        
        max_workers = min(len(file_ids), 5) 
        logger.info(f"[PARALLEL] Processing {len(file_ids)} files with {max_workers} parallel workers")
        
        upload_infos = []
        processing_errors = []
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_file = {executor.submit(process_single_file, file_id): file_id 
                              for file_id in file_ids}
            
            for future, file_id in future_to_file.items():
                cancellation_manager.register_future(file_id, future)
            
            for future in concurrent.futures.as_completed(future_to_file):
                file_id = future_to_file[future]
                
                try:
                    result = future.result()
                    
                    if result.get('success') == False: 
                        processing_errors.append(result)
                    elif result.get('upload_path'): 
                        upload_infos.append(result)
                    else:
                        logger.error(f"[PARALLEL] Unexpected result format for file {file_id}: {result}")
                        processing_errors.append({
                            'file_id': file_id,
                            'success': False,
                            'error': 'Unexpected result format'
                        })
                    
                    cancellation_manager.unregister_task(file_id, 'future')
                    
                except concurrent.futures.CancelledError:
                    logger.info(f"[CANCEL] Processing task cancelled for file {file_id}")
                    processing_errors.append({
                        'file_id': file_id,
                        'success': False,
                        'error': 'Processing task cancelled'
                    })
                except Exception as e:
                    logger.error(f"[PARALLEL] Exception processing file {file_id}: {str(e)}")
                    processing_errors.append({
                        'file_id': file_id,
                        'success': False,
                        'error': str(e)
                    })
                finally:
                    cancellation_manager.unregister_task(file_id, 'future')
        
        logger.info(f"[PARALLEL] File preparation completed: {len(upload_infos)} ready for upload, {len(processing_errors)} failed")
        
        if upload_infos:
            logger.info(f"[PARALLEL] Starting batch API upload for {len(upload_infos)} files")
            api_results = self._batch_upload_to_api(upload_infos, provider_name)
            results.extend(api_results)
            successful_uploads = len([r for r in api_results if r.get('success')])
        
        results.extend(processing_errors)
        
        return {
            'success': successful_uploads > 0,
            'total_files': len(file_ids),
            'successful_uploads': successful_uploads,
            'failed_uploads': len(file_ids) - successful_uploads,
            'results': results
        }
    
    def check_files_readiness(self, file_ids: List[str], provider_name: str = 'gemini') -> Dict[str, Any]:
        """Check if files are ready for use based on database state (no provider polling needed)"""
        provider = self.providers.get(provider_name)
        if not provider:
            return {
                'all_ready': False,
                'error': f'Provider {provider_name} not available'
            }
        
        files_status = []
        all_ready = True
        
        for file_id in file_ids:
            file_record = db.get_file_record(file_id)
            if not file_record:
                all_ready = False
                files_status.append({
                    'file_id': file_id,
                    'ready': False,
                    'state': 'not_found'
                })
                continue
            
            api_state = file_record.get('api_state', 'local')
            
            is_ready = api_state == 'ready'
            
            logger.debug(f"File {file_id} readiness check: state='{api_state}', ready={is_ready}")
            if not is_ready:
                all_ready = False
            
            files_status.append({
                'file_id': file_id,
                'ready': is_ready,
                'state': api_state,
                'name': file_record['original_name']
            })
        
        return {
            'all_ready': all_ready,
            'files': files_status
        }
    
    def delete_files_from_provider(self, file_ids: List[str], provider_name: str = 'gemini') -> Dict[str, Any]:
        """Delete files from provider API"""
        provider = self.providers.get(provider_name)
        if not provider:
            return {
                'success': False,
                'error': f'Provider {provider_name} not available'
            }
        
        results = []
        successful_deletions = 0
        
        for file_id in file_ids:
            file_record = db.get_file_record(file_id)
            if not file_record or not file_record.get('api_file_name'):
                results.append({
                    'file_id': file_id,
                    'success': True,  
                    'message': 'No API file found'
                })
                continue
            
            delete_result = provider.delete_file(file_record['api_file_name'])
            if delete_result['success']:
                db.update_file_api_info(file_id, api_file_name=None, api_state='local', provider=None)
                successful_deletions += 1
            
            results.append({
                'file_id': file_id,
                'success': delete_result['success'],
                'message': delete_result.get('message', delete_result.get('error'))
            })
        
        return {
            'success': successful_deletions > 0 or len(file_ids) == 0,
            'successful_deletions': successful_deletions,
            'results': results
        }

file_provider_manager = FileProviderManager()