# status: complete

import shutil
import uuid
import multiprocessing
from pathlib import Path
from typing import Dict, List, Any
from utils.logger import get_logger
from utils.db_utils import db
from utils.cancellation_manager import cancellation_manager
from utils.upload_worker import start_upload_process
from chat.providers import Gemini
from markitdown import MarkItDown
import concurrent.futures
import threading

if hasattr(multiprocessing, 'set_start_method'):
    try:
        multiprocessing.set_start_method('spawn', force=True)
    except RuntimeError:
        pass 

logger = get_logger(__name__)

def setup_filespace():
    """Create the files folder in the data directory if it doesn't exist."""
    try:
        backend_dir = Path(__file__).parent.parent
        project_root = backend_dir.parent
        data_dir = project_root / "data"
        files_dir = data_dir / "files"
        md_ver_dir = files_dir / "md_ver"
        
        files_dir.mkdir(parents=True, exist_ok=True)
        md_ver_dir.mkdir(parents=True, exist_ok=True)
        
        logger.info(f"Files directories initialized at: {files_dir}")
        return str(files_dir)
    
    except Exception as e:
        logger.error(f"Error setting up file space: {str(e)}")
        raise

def save_file(source_path, filename=None, file_type=None, chat_id=None, temp_id=None):
    """Copy a file to the files directory with unique ID tracking."""
    try:
        files_dir = Path(setup_filespace())
        
        source = Path(source_path)
        if not source.exists():
            raise FileNotFoundError(f"Source file does not exist: {source_path}")
        
        original_name = filename or source.name
        
        file_id = str(uuid.uuid4())
        
        file_extension = Path(original_name).suffix.lower()
        
        stored_filename = f"{file_id}_{original_name}"
        target_path = files_dir / stored_filename
        
        shutil.copy2(source, target_path)
        file_size = target_path.stat().st_size
        
        success = db.save_file_record(
            file_id=file_id,
            original_name=original_name,
            stored_filename=stored_filename,
            file_type=file_type or '',
            file_extension=file_extension,
            file_size=file_size,
            chat_id=chat_id,
            api_state='local',
            temp_id=temp_id  
        )
        
        if not success:
            target_path.unlink()
            raise Exception("Failed to save file record to database")
        
        logger.info(f"File saved with ID {file_id}: {source} -> {target_path}")
        return {
            'success': True,
            'file_id': file_id,
            'original_name': original_name,
            'stored_filename': stored_filename,
            'path': str(target_path),
            'size': file_size,
            'file_type': file_type,
            'file_extension': file_extension
        }
    
    except Exception as e:
        logger.error(f"Error saving file: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }

def delete_file(file_id):
    """Delete a file by its unique ID (handles both local and API deletion)."""
    try:
        logger.info(f"[CANCEL] Cancelling active processing for file {file_id} before deletion")
        cancellation_manager.cancel_file(file_id)
        
        file_record = db.get_file_record(file_id)
        if not file_record:
            return {
                'success': False,
                'error': 'File not found in database'
            }
        
        files_dir = Path(setup_filespace())
        
        file_path = files_dir / file_record['stored_filename']
        if file_path.exists():
            max_retries = 3
            for attempt in range(max_retries):
                try:
                    file_path.unlink()
                    logger.info(f"Physical file deleted: {file_path}")
                    break
                except PermissionError as e:
                    if attempt == max_retries - 1:
                        logger.warning(f"Could not delete file after {max_retries} attempts (file may be in use by upload): {file_path}")
                    else:
                        logger.info(f"File in use, retrying deletion attempt {attempt + 2}/{max_retries}: {file_path}")
                        import time
                        time.sleep(0.5)
        
        if file_record.get('md_filename'):
            md_path = files_dir / "md_ver" / file_record['md_filename']
            if md_path.exists():
                md_path.unlink()
                logger.info(f"Markdown file deleted: {md_path}")
        
        if file_record.get('api_file_name') and file_record.get('provider'):
            api_delete_result = file_provider_manager.delete_files_from_provider(
                [file_id], 
                file_record['provider']
            )
            if not api_delete_result['success']:
                logger.warning(f"Failed to delete file from API: {api_delete_result}")
        
        db_success = db.delete_file_record(file_id)
        if not db_success:
            return {
                'success': False,
                'error': 'Failed to delete file record from database'
            }
        
        logger.info(f"File deleted: {file_id} - {file_record['original_name']}")
        
        cancellation_manager.cleanup_file(file_id)
        
        return {
            'success': True,
            'message': f'File {file_record["original_name"]} deleted successfully'
        }
    
    except Exception as e:
        logger.error(f"Error deleting file: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }

def batch_delete_files(file_ids):
    """Delete multiple files by their IDs in a single operation."""
    try:
        if not file_ids:
            return {
                'success': False,
                'error': 'No file IDs provided'
            }
        
        logger.info(f"[CANCEL] Cancelling active processing for {len(file_ids)} files before deletion")
        cancellation_manager.cancel_files(file_ids)
        
        files_dir = Path(setup_filespace())
        successful_deletions = []
        failed_deletions = []
        
        for file_id in file_ids:
            try:
                file_record = db.get_file_record(file_id)
                if not file_record:
                    failed_deletions.append({
                        'file_id': file_id,
                        'error': 'File not found in database'
                    })
                    continue
                
                file_path = files_dir / file_record['stored_filename']
                if file_path.exists():
                    max_retries = 3
                    for attempt in range(max_retries):
                        try:
                            file_path.unlink()
                            logger.debug(f"Physical file deleted: {file_path}")
                            break
                        except PermissionError as e:
                            if attempt == max_retries - 1:
                                logger.warning(f"Could not delete file after {max_retries} attempts (file may be in use by upload): {file_path}")
                            else:
                                logger.debug(f"File in use, retrying deletion attempt {attempt + 2}/{max_retries}: {file_path}")
                                import time
                                time.sleep(0.5)
                
                if file_record.get('md_filename'):
                    md_path = files_dir / "md_ver" / file_record['md_filename']
                    if md_path.exists():
                        md_path.unlink()
                        logger.debug(f"Markdown file deleted: {md_path}")
                
                if file_record.get('api_file_name') and file_record.get('provider'):
                    try:
                        logger.info(f"[CLEANUP] Deleting file {file_id} from {file_record['provider']} API")
                        api_delete_result = file_provider_manager.delete_files_from_provider(
                            [file_id], 
                            file_record['provider']
                        )
                        if api_delete_result['success']:
                            logger.info(f"[CLEANUP] Successfully deleted file {file_id} from API")
                        else:
                            logger.warning(f"[CLEANUP] Failed to delete file {file_id} from API: {api_delete_result}")
                    except Exception as e:
                        logger.error(f"[CLEANUP] Error deleting file {file_id} from API: {str(e)}")
                
                db_success = db.delete_file_record(file_id)
                if not db_success:
                    failed_deletions.append({
                        'file_id': file_id,
                        'file_name': file_record['original_name'],
                        'error': 'Failed to delete file record from database'
                    })
                    continue
                
                successful_deletions.append({
                    'file_id': file_id,
                    'file_name': file_record['original_name']
                })
                logger.debug(f"File deleted: {file_id} - {file_record['original_name']}")
                
                cancellation_manager.cleanup_file(file_id)
                
            except Exception as e:
                failed_deletions.append({
                    'file_id': file_id,
                    'error': str(e)
                })
                logger.error(f"Error deleting file {file_id}: {str(e)}")
        
        if not failed_deletions:
            logger.info(f"Batch delete successful: {len(successful_deletions)} files deleted")
            return {
                'success': True,
                'message': f'{len(successful_deletions)} files deleted successfully',
                'deleted_files': successful_deletions
            }
        elif not successful_deletions:
            all_not_found = all('not found' in failure.get('error', '').lower() for failure in failed_deletions)
            if all_not_found:
                logger.info(f"Batch delete: all {len(failed_deletions)} files were not found (likely temp files or race condition)")
                return {
                    'success': True,
                    'message': f'No files needed deletion (all were temporary or already deleted)',
                    'deleted_files': [],
                    'skipped_files': failed_deletions
                }
            else:
                logger.error(f"Batch delete failed: all {len(failed_deletions)} files failed")
                return {
                    'success': False,
                    'error': 'All file deletions failed',
                    'failed_files': failed_deletions
                }
        else:
            logger.warning(f"Batch delete partial: {len(successful_deletions)} succeeded, {len(failed_deletions)} failed")
            return {
                'success': True,
                'message': f'{len(successful_deletions)} files deleted, {len(failed_deletions)} failed',
                'deleted_files': successful_deletions,
                'failed_files': failed_deletions
            }
    
    except Exception as e:
        logger.error(f"Error in batch delete files: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }

def edit_filename(file_id, new_original_name):
    """Update the original filename for a file (doesn't change stored filename)."""
    try:
        file_record = db.get_file_record(file_id)
        if not file_record:
            return {
                'success': False,
                'error': 'File not found in database'
            }
        
        new_extension = Path(new_original_name).suffix.lower()
        
        with db._connect() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE files 
                SET original_name = ?, file_extension = ?
                WHERE id = ?
            """, (new_original_name, new_extension, file_id))
            conn.commit()
            
            if cursor.rowcount == 0:
                return {
                    'success': False,
                    'error': 'Failed to update file record'
                }
        
        logger.info(f"File renamed: {file_record['original_name']} -> {new_original_name}")
        return {
            'success': True,
            'message': f'File renamed to {new_original_name}',
            'new_original_name': new_original_name,
            'file_id': file_id
        }
    
    except Exception as e:
        logger.error(f"Error renaming file: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }

def list_files(chat_id=None):
    """List all files from database, optionally filtered by chat_id."""
    try:
        file_records = db.get_all_files(chat_id=chat_id)
        
        files_list = []
        for record in file_records:
            files_list.append({
                'id': record['id'],
                'name': record['original_name'], 
                'stored_filename': record['stored_filename'], 
                'size': record['file_size'],
                'file_type': record['file_type'],
                'file_extension': record['file_extension'],
                'upload_timestamp': record['upload_timestamp'],
                'chat_id': record['chat_id'],
                'api_state': record.get('api_state', 'local'),
                'provider': record.get('provider'),
                'api_file_name': record.get('api_file_name'),
                'md_filename': record.get('md_filename')
            })
        
        return files_list
    
    except Exception as e:
        logger.error(f"Error listing files: {str(e)}")
        return []

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

def process_file_to_markdown(file_path: str, file_id: str) -> Dict[str, Any]:
    """Process a file to markdown using markitdown and save to md_ver folder"""
    try:
        files_dir = Path(setup_filespace())
        md_ver_dir = files_dir / "md_ver"
        
        file_path_obj = Path(file_path)
        file_extension = file_path_obj.suffix.lower()
        
        md = MarkItDown()
        
        result = md.convert(file_path)
        
        metadata_only_extensions = {'.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv',
                                   '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a',
                                   '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'}
        
        is_metadata = file_extension in metadata_only_extensions
        
        md_filename = f"{file_id}{'_metadata' if is_metadata else ''}.md"
        md_path = md_ver_dir / md_filename
        
        with open(md_path, 'w', encoding='utf-8') as f:
            f.write(result.text_content)
        
        db.update_file_md_info(file_id, md_filename)
        
        logger.info(f"Processed file to markdown: {file_path} -> {md_path}")
        
        return {
            'success': True,
            'md_filename': md_filename,
            'md_path': str(md_path),
            'is_metadata': is_metadata
        }
    
    except Exception as e:
        logger.error(f"Error processing file to markdown: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }

class FileProviderManager:
    """Manages file operations across different providers with state tracking"""
    
    def __init__(self):
        self.providers = {
            'gemini': Gemini()
        }
    
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
                    
                    if '403' in str(error_msg) and 'PERMISSION_DENIED' in str(error_msg):
                        logger.info(f"File {file_id} ({api_file_name}) was likely deleted, stopping polling")
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
                
                poll_interval = min(poll_interval * 1.2, max_interval)  # Exponential backoff
                
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
                
                textual_extensions = {'.txt', '.md', '.rst', '.py', '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.json', '.xml', '.yaml', '.yml', '.csv', '.log'}
                non_textual_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', 
                                        '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', 
                                        '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv'}
                
                is_textual = file_extension in textual_extensions
                is_non_textual = file_extension in non_textual_extensions
                
                logger.info(f"[PARALLEL] File {file_id} ({file_record['original_name']}) - Extension: {file_extension}, is_textual: {is_textual}, is_non_textual: {is_non_textual}, direct_upload: {file_extension in direct_upload_extensions}")
                
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
                    
                    if is_textual:
                        md_ver_dir = files_dir / "md_ver"
                        upload_info['upload_path'] = str(md_ver_dir / md_result['md_filename'])
                        upload_info['display_name'] = f"{file_record['original_name']} (processed)"
                    else:
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

def clear_files_from_attached_list(chat_id: str) -> Dict[str, Any]:
    """Clear files from the attached list for a specific chat after message is sent
    This doesn't delete the files, just removes them from being attached to future messages"""
    try:
        logger.info(f"Files cleared from attached list for chat {chat_id} (handled by frontend)")
        return {
            'success': True,
            'message': f'Files cleared from attached list for chat {chat_id}'
        }
    except Exception as e:
        logger.error(f"Error clearing files from attached list: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }

def sync_files_with_database():
    """Sync database with actual files in the files folder at startup"""
    try:
        files_dir = Path(setup_filespace())
        md_ver_dir = files_dir / "md_ver"
        
        logger.info("Starting file system sync with database...")
        
        db_files = db.get_all_files()
        db_file_map = {f['stored_filename']: f for f in db_files}
        
        actual_files = set()
        if files_dir.exists():
            for file_path in files_dir.iterdir():
                if file_path.is_file() and file_path.name != '.gitkeep':
                    actual_files.add(file_path.name)
        
        actual_md_files = set()
        if md_ver_dir.exists():
            for md_path in md_ver_dir.iterdir():
                if md_path.is_file() and md_path.name != '.gitkeep':
                    actual_md_files.add(md_path.name)
        
        orphaned_records = 0
        for stored_filename, file_record in db_file_map.items():
            file_exists = stored_filename in actual_files
            md_exists = True
            if file_record.get('md_filename'):
                md_exists = file_record['md_filename'] in actual_md_files
            
            if not file_exists:
                db.delete_file_record(file_record['id'])
                orphaned_records += 1
                logger.warning(f"Removed orphaned database record: {file_record['id']} - {file_record['original_name']}")
            elif file_record.get('md_filename') and not md_exists:
                db.update_file_md_info(file_record['id'], None)
                logger.info(f"Cleared missing markdown reference for: {file_record['id']}")
        
        orphaned_files = 0
        for filename in actual_files:
            if filename not in db_file_map:
                orphaned_file_path = files_dir / filename
                try:
                    orphaned_file_path.unlink()
                    orphaned_files += 1
                    logger.warning(f"Removed orphaned file: {filename}")
                except Exception as e:
                    logger.error(f"Failed to remove orphaned file {filename}: {str(e)}")
        
        orphaned_md_files = 0
        db_md_files = {f.get('md_filename') for f in db_files if f.get('md_filename')}
        for md_filename in actual_md_files:
            if md_filename not in db_md_files:
                orphaned_md_path = md_ver_dir / md_filename
                try:
                    orphaned_md_path.unlink()
                    orphaned_md_files += 1
                    logger.warning(f"Removed orphaned markdown file: {md_filename}")
                except Exception as e:
                    logger.error(f"Failed to remove orphaned markdown file {md_filename}: {str(e)}")
        
        interrupted_files = 0
        for file_record in db.get_all_files():
            api_state = file_record.get('api_state', 'local')
            if api_state in ['uploading', 'processing_md']:
                db.update_file_api_info(file_record['id'], api_state='local')
                interrupted_files += 1
                logger.info(f"Reset interrupted processing state for: {file_record['id']}")
        
        sync_summary = {
            'orphaned_records_removed': orphaned_records,
            'orphaned_files_removed': orphaned_files,
            'orphaned_md_files_removed': orphaned_md_files,
            'interrupted_files_reset': interrupted_files
        }
        
        logger.info(f"File system sync completed: {sync_summary}")
        return {
            'success': True,
            'summary': sync_summary
        }
    
    except Exception as e:
        logger.error(f"Error during file system sync: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }

file_provider_manager = FileProviderManager()