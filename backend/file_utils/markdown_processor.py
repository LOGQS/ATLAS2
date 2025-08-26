# status: complete

from pathlib import Path
from typing import Dict, Any
from utils.logger import get_logger
from utils.db_utils import db
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