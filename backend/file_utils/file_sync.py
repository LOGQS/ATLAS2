# status: complete

import os
from pathlib import Path
from typing import Dict, Any, Set
from utils.logger import get_logger
from utils.db_utils import db
from file_utils.markdown_processor import setup_filespace

logger = get_logger(__name__)

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

def _iter_file_names(directory: Path) -> Set[str]:
    names: Set[str] = set()
    if not directory.exists():
        return names
    try:
        with os.scandir(directory) as iterator:
            for entry in iterator:
                if entry.is_file() and entry.name != '.gitkeep':
                    names.add(entry.name)
    except OSError as err:
        logger.warning(f"Failed to scan directory {directory}: {err}")
    return names

def sync_files_with_database():
    """Sync database with actual files in the files folder at startup"""
    try:
        files_dir = Path(setup_filespace())
        md_ver_dir = files_dir / "md_ver"

        logger.info("Starting file system sync with database...")

        db_files = list(db.get_all_files())
        db_file_map = {}
        db_md_files = set()
        for record in db_files:
            db_file_map[record['stored_filename']] = record
            md_name = record.get('md_filename')
            if md_name:
                db_md_files.add(md_name)

        actual_files = _iter_file_names(files_dir)
        actual_md_files = _iter_file_names(md_ver_dir)

        orphaned_records = 0
        deleted_ids = set()
        for stored_filename, file_record in list(db_file_map.items()):
            file_exists = stored_filename in actual_files
            md_name = file_record.get('md_filename')
            md_exists = True if not md_name else md_name in actual_md_files

            if not file_exists:
                db.delete_file_record(file_record['id'])
                orphaned_records += 1
                deleted_ids.add(file_record['id'])
                db_file_map.pop(stored_filename, None)
                if md_name:
                    db_md_files.discard(md_name)
                logger.warning(f"Removed orphaned database record: {file_record['id']} - {file_record['original_name']}")
            elif md_name and not md_exists:
                db.update_file_md_info(file_record['id'], None)
                db_md_files.discard(md_name)
                logger.info(f"Cleared missing markdown reference for: {file_record['id']}")

        if deleted_ids:
            db_files = [record for record in db_files if record['id'] not in deleted_ids]

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
        for file_record in db_files:
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
