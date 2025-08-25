import shutil
import uuid
from pathlib import Path
from typing import Dict, List, Any
from utils.logger import get_logger
from utils.db_utils import db
from chat.providers import Gemini
from markitdown import MarkItDown

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

def save_file(source_path, filename=None, file_type=None, chat_id=None):
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
            api_state='local'
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
        file_record = db.get_file_record(file_id)
        if not file_record:
            return {
                'success': False,
                'error': 'File not found in database'
            }
        
        files_dir = Path(setup_filespace())
        
        file_path = files_dir / file_record['stored_filename']
        if file_path.exists():
            file_path.unlink()
            logger.info(f"Physical file deleted: {file_path}")
        
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
                    file_path.unlink()
                    logger.debug(f"Physical file deleted: {file_path}")
                
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
    
    def process_and_upload_files(self, file_ids: List[str], provider_name: str = 'gemini') -> Dict[str, Any]:
        """Process multiple files: markdown conversion and API upload with state tracking"""
        provider = self.providers.get(provider_name)
        if not provider:
            return {
                'success': False,
                'error': f'Provider {provider_name} not available',
                'results': []
            }
        
        results = []
        successful_uploads = 0
        
        for file_id in file_ids:
            try:
                # Don't set uploading yet - we need to do local processing first
                db.update_file_api_info(file_id, provider=provider_name)
                
                file_record = db.get_file_record(file_id)
                if not file_record:
                    results.append({
                        'file_id': file_id,
                        'success': False,
                        'error': 'File not found in database'
                    })
                    continue
                
                file_path = get_file_path(file_id)
                if not file_path or not file_path.exists():
                    results.append({
                        'file_id': file_id,
                        'success': False,
                        'error': 'Physical file not found'
                    })
                    db.update_file_api_info(file_id, api_state='error')
                    continue
                
                files_dir = Path(setup_filespace())
                file_extension = Path(file_record['original_name']).suffix.lower()
                
                provider_limits = self.get_provider_file_limits(provider_name)
                direct_upload_extensions = provider_limits.get('direct_upload_extensions', set())
                
                # Define textual file extensions
                textual_extensions = {'.txt', '.md', '.rst', '.py', '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.json', '.xml', '.yaml', '.yml', '.csv', '.log'}
                # Define non-textual file extensions (images, audio, video)
                non_textual_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', 
                                        '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', 
                                        '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv'}
                
                is_textual = file_extension in textual_extensions
                is_non_textual = file_extension in non_textual_extensions
                
                # DEBUG: Log file processing decision
                logger.info(f"File {file_id} ({file_record['original_name']}) - Extension: {file_extension}, is_textual: {is_textual}, is_non_textual: {is_non_textual}, direct_upload: {file_extension in direct_upload_extensions}")
                
                # Determine upload strategy based on file type and provider support
                if file_extension in direct_upload_extensions:
                    # Provider supports this extension directly, upload original file
                    logger.info(f"File {file_id} taking DIRECT UPLOAD path -> setting uploading (blue)")
                    db.update_file_api_info(file_id, api_state='uploading')
                    upload_result = provider.upload_file(str(file_path), file_record['original_name'])
                elif is_non_textual:
                    # Non-textual file: upload original file directly without markdown processing
                    logger.info(f"File {file_id} taking NON-TEXTUAL path -> setting uploading (blue)")
                    db.update_file_api_info(file_id, api_state='uploading')
                    upload_result = provider.upload_file(str(file_path), file_record['original_name'])
                else:
                    # Textual files and unknown files: process to markdown first (orange spinner)
                    logger.info(f"File {file_id} taking MARKDOWN processing path -> setting processing_md (orange)")
                    db.update_file_api_info(file_id, api_state='processing_md')
                    md_result = process_file_to_markdown(str(file_path), file_id)
                    if not md_result['success']:
                        results.append({
                            'file_id': file_id,
                            'success': False,
                            'error': f'Markdown processing failed: {md_result["error"]}'
                        })
                        db.update_file_api_info(file_id, api_state='error')
                        continue
                    
                    # Now upload to API (blue spinner)
                    db.update_file_api_info(file_id, api_state='uploading')
                    
                    if is_textual:
                        # Textual file: upload only MD version unless in provider's allowed list
                        md_ver_dir = files_dir / "md_ver"
                        upload_result = provider.upload_file(
                            str(md_ver_dir / md_result['md_filename']), 
                            f"{file_record['original_name']} (processed)"
                        )
                    else:
                        # Unknown file type: upload MD version as fallback
                        md_ver_dir = files_dir / "md_ver"
                        upload_result = provider.upload_file(
                            str(md_ver_dir / md_result['md_filename']), 
                            f"{file_record['original_name']} (processed)"
                        )
                
                if upload_result['success']:
                    db.update_file_api_info(
                        file_id, 
                        api_file_name=upload_result['api_file_name'],
                        api_state=upload_result['state'],
                        provider=provider_name
                    )
                    
                    successful_uploads += 1
                    result_data = {
                        'file_id': file_id,
                        'success': True,
                        'api_file_name': upload_result['api_file_name'],
                        'state': upload_result['state']
                    }
                    
                    # Only include md_filename if markdown processing was done
                    if 'md_result' in locals() and md_result.get('md_filename'):
                        result_data['md_filename'] = md_result['md_filename']
                    
                    results.append(result_data)
                    logger.info(f"Successfully processed and uploaded file {file_id}")
                else:
                    db.update_file_api_info(file_id, api_state='error')
                    results.append({
                        'file_id': file_id,
                        'success': False,
                        'error': upload_result['error']
                    })
                    logger.error(f"Failed to upload file {file_id}: {upload_result['error']}")
            
            except Exception as e:
                db.update_file_api_info(file_id, api_state='error')
                results.append({
                    'file_id': file_id,
                    'success': False,
                    'error': str(e)
                })
                logger.error(f"Error processing file {file_id}: {str(e)}")
        
        return {
            'success': successful_uploads > 0,
            'total_files': len(file_ids),
            'successful_uploads': successful_uploads,
            'failed_uploads': len(file_ids) - successful_uploads,
            'results': results
        }
    
    def check_files_readiness(self, file_ids: List[str], provider_name: str = 'gemini') -> Dict[str, Any]:
        """Check if files are ready for use (both local and API processing complete)"""
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
            
            if api_state in ['uploaded', 'processing'] and file_record.get('api_file_name'):
                metadata_result = provider.get_file_metadata(file_record['api_file_name'])
                if metadata_result['success']:
                    new_state = metadata_result['state']
                    if new_state != api_state:
                        db.update_file_api_info(file_id, api_state=new_state)
                        api_state = new_state
            
            is_ready = api_state == 'ready'
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