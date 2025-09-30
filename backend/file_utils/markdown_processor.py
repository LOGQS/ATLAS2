# status: complete

from pathlib import Path
from threading import Lock
from typing import Dict, Any, Optional
from utils.logger import get_logger
from utils.db_utils import db
from markitdown import MarkItDown

logger = get_logger(__name__)

_filespace_lock = Lock()
_filespace_path: Optional[Path] = None
_filespace_logged = False


def setup_filespace():
    """Create the files folder in the data directory if it doesn't exist."""
    global _filespace_path, _filespace_logged

    try:
        should_log = False
        with _filespace_lock:
            if _filespace_path is not None and _filespace_path.exists():
                return str(_filespace_path)

            backend_dir = Path(__file__).parent.parent
            project_root = backend_dir.parent
            data_dir = project_root / "data"
            files_dir = data_dir / "files"
            md_ver_dir = files_dir / "md_ver"

            files_dir.mkdir(parents=True, exist_ok=True)
            md_ver_dir.mkdir(parents=True, exist_ok=True)

            should_log = not _filespace_logged
            _filespace_logged = True
            _filespace_path = files_dir

        if should_log:
            logger.info(f"Files directories initialized at: {files_dir}")
        return str(files_dir)

    except Exception as e:
        logger.error(f"Error setting up file space: {str(e)}")
        raise

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