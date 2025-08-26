# status: complete

"""
Multiprocessing upload worker that runs in a separate process.
This allows for true process termination that immediately releases file handles.
"""
import multiprocessing
import sys
from pathlib import Path
from typing import Dict, Any, Optional


def upload_worker(file_path: str, display_name: Optional[str], provider_config: Dict[str, Any], file_id: str) -> Dict[str, Any]:
    """
    Upload worker function that runs in a separate process.
    This function opens the file and performs the upload, so all file handles belong to this process.
    When the process is terminated, all handles are immediately released.
    """
    try:
        backend_dir = Path(__file__).parent.parent
        if str(backend_dir) not in sys.path:
            sys.path.insert(0, str(backend_dir))
        
        from chat.providers import Gemini
        from utils.rate_limiter import get_rate_limiter
        from utils.config import Config
        from utils.logger import get_logger
        
        logger = get_logger(__name__)
        logger.info(f"[WORKER] Starting upload process for file {file_id}: {file_path}")
        
        file_path_obj = Path(file_path)
        if not file_path_obj.exists():
            return {
                'success': False,
                'error': 'File does not exist',
                'state': 'error',
                'file_id': file_id
            }
        
        provider = Gemini()
        if not provider.is_available():
            return {
                'success': False,
                'error': 'Gemini provider not available',
                'state': 'error',
                'file_id': file_id
            }
        
        file_size = file_path_obj.stat().st_size
        if file_size > provider.FILE_SIZE_LIMIT:
            return {
                'success': False,
                'error': f'File size {file_size} exceeds limit of {provider.FILE_SIZE_LIMIT} bytes',
                'state': 'error',
                'file_id': file_id
            }
            
        limiter = get_rate_limiter(
            Config.get_rate_limit_requests_per_minute(),
            Config.get_rate_limit_burst_size()
        )
        
        upload_kwargs = {"file": str(file_path)}
        if file_path_obj.suffix.lower() == '.md':
            upload_kwargs["config"] = {"mime_type": "text/markdown"}
        
        logger.info(f"[WORKER] Executing upload for file {file_id}")
        
        uploaded_file = limiter.execute(
            provider.client.files.upload,
            "gemini:upload", 
            **upload_kwargs
        )
        
        logger.info(f"[WORKER] Upload completed for file {file_id}: {uploaded_file.name}")
        
        return {
            'success': True,
            'api_file_name': uploaded_file.name,
            'display_name': display_name or file_path_obj.name,
            'state': uploaded_file.state.name.lower() if hasattr(uploaded_file.state, 'name') else 'uploaded',
            'file_id': file_id
        }
        
    except KeyboardInterrupt:
        logger.info(f"[WORKER] Upload process interrupted for file {file_id}")
        return {
            'success': False,
            'error': 'Upload process terminated',
            'state': 'error',
            'file_id': file_id
        }
        
    except Exception as e:
        logger.error(f"[WORKER] Upload failed for file {file_id}: {str(e)}")
        return {
            'success': False,
            'error': str(e),
            'state': 'error',
            'file_id': file_id
        }


def _process_runner(file_path: str, display_name: Optional[str], file_id: str, child_conn):
    """Process target function - must be at module level for pickling"""
    try:
        provider_config = {'provider_type': 'gemini'}
        result = upload_worker(file_path, display_name, provider_config, file_id)
        child_conn.send(result)
    except Exception as e:
        child_conn.send({
            'success': False,
            'error': f'Worker process error: {str(e)}',
            'state': 'error',
            'file_id': file_id
        })
    finally:
        child_conn.close()


def start_upload_process(file_path: str, display_name: Optional[str], file_id: str):
    """
    Start an upload process and return the process and connection for result retrieval.
    """
    parent_conn, child_conn = multiprocessing.Pipe(duplex=False)
    
    process = multiprocessing.Process(
        target=_process_runner, 
        args=(file_path, display_name, file_id, child_conn),
        daemon=True
    )
    process.start()
    
    return process, parent_conn