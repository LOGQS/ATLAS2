# status: complete

from file_utils.file_operations import save_file,delete_file, batch_delete_files, edit_filename, list_files
from file_utils.markdown_processor import setup_filespace, process_file_to_markdown
from file_utils.file_provider_manager import FileProviderManager,file_provider_manager, get_file_path
from file_utils.file_sync import clear_files_from_attached_list, sync_files_with_database
import multiprocessing

if hasattr(multiprocessing, 'set_start_method'):
    try:
        multiprocessing.set_start_method('spawn', force=True)
    except RuntimeError:
        pass

__all__ = [
    'setup_filespace',
    'save_file',
    'delete_file',
    'batch_delete_files',
    'edit_filename',
    'list_files',
    'get_file_path',
    'process_file_to_markdown',
    'FileProviderManager',
    'file_provider_manager',
    'clear_files_from_attached_list',
    'sync_files_with_database'
]