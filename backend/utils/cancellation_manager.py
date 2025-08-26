# status: complete

import threading
import multiprocessing
from typing import Dict, List, Any, Set
from utils.logger import get_logger

logger = get_logger(__name__)

class CancellationManager:
    """Global manager for handling file processing cancellation"""
    
    def __init__(self):
        self._cancelled_files: Set[str] = set()
        self._active_tasks: Dict[str, Dict[str, Any]] = {}
        self._active_processes: Dict[str, multiprocessing.Process] = {}
        self._lock = threading.Lock()
    
    def is_cancelled(self, file_id: str) -> bool:
        """Check if a file has been cancelled"""
        with self._lock:
            return file_id in self._cancelled_files
    
    def cancel_file(self, file_id: str):
        """Mark a file as cancelled and stop all its active tasks"""
        with self._lock:
            self._cancelled_files.add(file_id)
            logger.info(f"[CANCEL] File {file_id} marked for cancellation")
            
            if file_id in self._active_processes:
                process = self._active_processes[file_id]
                if process.is_alive():
                    logger.info(f"[CANCEL] Terminating upload process for file {file_id}")
                    process.terminate()
                    process.join(timeout=2)
                    if process.is_alive():
                        logger.warning(f"[CANCEL] Force killing upload process for file {file_id}")
                        try:
                            process.kill()
                        except AttributeError:
                            pass  
                    logger.info(f"[CANCEL] Upload process terminated for file {file_id}")
                del self._active_processes[file_id]
            
            if file_id in self._active_tasks:
                task_info = self._active_tasks[file_id]
                
                if 'future' in task_info and not task_info['future'].done():
                    cancelled = task_info['future'].cancel()
                    if cancelled:
                        logger.info(f"[CANCEL] Successfully cancelled future for file {file_id}")
                
                if 'polling_event' in task_info:
                    task_info['polling_event'].set()
    
    def cancel_files(self, file_ids: List[str]):
        """Cancel multiple files at once"""
        if not file_ids:
            return
        
        for file_id in file_ids:
            self.cancel_file(file_id)
    
    def register_future(self, file_id: str, future: Any):
        """Register a ThreadPoolExecutor future for cancellation tracking"""
        with self._lock:
            if file_id not in self._active_tasks:
                self._active_tasks[file_id] = {}
            self._active_tasks[file_id]['future'] = future
    
    def register_polling_event(self, file_id: str, stop_event: threading.Event):
        """Register a polling thread's stop event for cancellation"""
        with self._lock:
            if file_id not in self._active_tasks:
                self._active_tasks[file_id] = {}
            self._active_tasks[file_id]['polling_event'] = stop_event
    
    def unregister_task(self, file_id: str, task_type: str):
        """Unregister a completed task"""
        with self._lock:
            if task_type == 'process' and file_id in self._active_processes:
                del self._active_processes[file_id]
                logger.debug(f"[CANCEL] Unregistered process for file {file_id}")
            elif file_id in self._active_tasks and task_type in self._active_tasks[file_id]:
                del self._active_tasks[file_id][task_type]
                if not self._active_tasks[file_id]:
                    del self._active_tasks[file_id]
                logger.debug(f"[CANCEL] Unregistered {task_type} for file {file_id}")
    
    def register_process(self, file_id: str, process: multiprocessing.Process):
        """Register a upload process for cancellation tracking"""
        with self._lock:
            self._active_processes[file_id] = process
    
    def unregister_process(self, file_id: str):
        """Unregister a completed upload process"""
        with self._lock:
            if file_id in self._active_processes:
                del self._active_processes[file_id]
    
    def cleanup_file(self, file_id: str):
        """Clean up all tracking for a file"""
        with self._lock:
            self._cancelled_files.discard(file_id)
            if file_id in self._active_tasks:
                del self._active_tasks[file_id]
            if file_id in self._active_processes:
                del self._active_processes[file_id]

cancellation_manager = CancellationManager()