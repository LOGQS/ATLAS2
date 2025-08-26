# status: complete

import shutil
import uuid
from pathlib import Path
from utils.logger import get_logger
from utils.db_utils import db
from utils.cancellation_manager import cancellation_manager
from file_utils.markdown_processor import setup_filespace

logger = get_logger(__name__)

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
            from file_utils.file_provider_manager import file_provider_manager
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
                        from file_utils.file_provider_manager import file_provider_manager
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