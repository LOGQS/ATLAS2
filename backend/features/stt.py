# status: complete

"""
Speech-to-Text main module providing unified abstraction for STT providers
and local STT implementation using faster_whisper
"""

import uuid
import multiprocessing
import threading
import time
from typing import Dict, Any, Optional
from utils.logger import get_logger
from utils.cancellation_manager import cancellation_manager
from features.stt_worker import start_stt_process, start_local_stt_process
from features.stt_providers import Groq
from faster_whisper import WhisperModel

logger = get_logger(__name__)

PROCESS_TERMINATE_TIMEOUT = 1.0
CANCEL_RESPONSE_TIMEOUT = 2.0
INIT_RESPONSE_TIMEOUT = 20.0
POLL_INTERVAL = 0.1

_stt_processes_lock = threading.Lock()
_stt_processes: Dict[str, multiprocessing.Process] = {}
_stt_process_connections: Dict[str, Any] = {}
_stt_process_status: Dict[str, str] = {}

def _terminate_process_safely(process: multiprocessing.Process, task_id: str) -> None:
    """Safely terminate a process with proper error handling"""
    if not process or not process.is_alive():
        return

    try:
        logger.info(f"Terminating STT process for task {task_id}")
        process.terminate()
        process.join(timeout=PROCESS_TERMINATE_TIMEOUT)
        if process.is_alive():
            logger.warning(f"Force killing STT process for task {task_id}")
            process.kill()
            process.join(timeout=0.5)
    except (OSError, AttributeError) as e:
        logger.warning(f"Error terminating STT process for {task_id}: {e}")
    except Exception as e:
        logger.error(f"Unexpected error during STT process cleanup for {task_id}: {e}")

def _close_connection_safely(conn: Any, task_id: str) -> None:
    """Safely close a connection with proper error handling"""
    if not conn:
        return

    try:
        if hasattr(conn, 'close'):
            conn.close()
    except (OSError, BrokenPipeError) as e:
        logger.debug(f"Expected error closing STT connection for {task_id}: {e}")
    except Exception as e:
        logger.warning(f"Unexpected error closing STT connection for {task_id}: {e}")

def cleanup_completed_stt_processes():
    """Clean up completed/dead STT processes"""
    with _stt_processes_lock:
        completed_tasks = []
        for task_id, process in list(_stt_processes.items()):
            status = _stt_process_status.get(task_id)
            if not process.is_alive() or status in ['completed', 'cancelled']:
                completed_tasks.append(task_id)

        for task_id in completed_tasks:
            if task_id in _stt_processes:
                process = _stt_processes[task_id]
                _terminate_process_safely(process, task_id)
                del _stt_processes[task_id]
            if task_id in _stt_process_connections:
                conn = _stt_process_connections[task_id]
                _close_connection_safely(conn, task_id)
                del _stt_process_connections[task_id]
            _stt_process_status.pop(task_id, None)
            cancellation_manager.cleanup_file(task_id)
            logger.info(f"Cleaned up completed STT process for task {task_id}")

def cancel_stt_task(task_id: str) -> bool:
    """Cancel a running STT task"""
    with _stt_processes_lock:
        if task_id in _stt_process_connections:
            logger.info(f"Cancelling STT task {task_id}")
            try:
                conn = _stt_process_connections[task_id]
                conn.send({'command': 'cancel'})

                if conn.poll(CANCEL_RESPONSE_TIMEOUT):
                    response = conn.recv()
                    logger.info(f"Cancel response for STT task {task_id}: {response}")

                _stt_process_status[task_id] = 'cancelled'
                cancellation_manager.cancel_file(task_id)
                return True
            except (OSError, BrokenPipeError) as e:
                logger.warning(f"Connection error cancelling STT task {task_id}: {e}")
                if task_id in _stt_processes:
                    process = _stt_processes[task_id]
                    _terminate_process_safely(process, task_id)
                return True
            except Exception as e:
                logger.error(f"Unexpected error cancelling STT task {task_id}: {e}")
                return False
        return False

class STT:
    """
    Main STT class that manages speech-to-text operations
    """

    def __init__(self):
        self.provider = Groq()

    def _generate_task_id(self) -> str:
        """Generate unique task ID"""
        return f"stt_{uuid.uuid4().hex[:8]}"

    def is_available(self) -> bool:
        """Check if STT provider is available"""
        return self.provider.is_available()

    def get_available_models(self) -> Dict[str, str]:
        """Get available models from provider"""
        return self.provider.get_available_models()

    def transcribe(self, file_path: str, model: str = "whisper-large-v3-turbo",
                  language: Optional[str] = None,
                  use_multiprocessing: bool = True) -> Dict[str, Any]:
        """
        Transcribe audio to text

        Args:
            file_path: Path to audio file
            model: Model to use for transcription
            language: Language of the audio (optional)
            use_multiprocessing: Whether to use multiprocessing for cancellation

        Returns:
            Dict with transcription results
        """
        task_id = self._generate_task_id()

        if use_multiprocessing:
            return self._transcribe_with_multiprocessing(
                task_id, file_path, model, language
            )
        else:
            if not self.provider.is_available():
                return {"success": False, "error": "Provider not available"}

            return self.provider.transcribe_audio(
                file_path=file_path,
                model=model,
                language=language
            )

    def _transcribe_with_multiprocessing(self, task_id: str, file_path: str,
                                        model: str, language: str) -> Dict[str, Any]:
        """Transcribe using multiprocessing for cancellation support"""

        with _stt_processes_lock:
            cleanup_completed_stt_processes()

            try:
                process, conn = start_stt_process(task_id)
                _stt_processes[task_id] = process
                _stt_process_connections[task_id] = conn
                _stt_process_status[task_id] = 'starting'
                cancellation_manager.register_process(task_id, process)

                if conn.poll(INIT_RESPONSE_TIMEOUT):
                    response = conn.recv()
                    if not response.get('success'):
                        error = response.get('error', 'Unknown initialization error')
                        logger.error(f"Failed to initialize STT process {task_id}: {error}")
                        cleanup_completed_stt_processes()
                        return {"success": False, "error": error}
                else:
                    logger.error(f"STT process initialization timeout for {task_id}")
                    cleanup_completed_stt_processes()
                    return {"success": False, "error": "Initialization timeout"}

                _stt_process_status[task_id] = 'running'

                command = {
                    'command': 'transcribe',
                    'file_path': file_path,
                    'model': model,
                    'language': language
                }

                conn.send(command)

                timeout = 300 
                start_time = time.time()

                while time.time() - start_time < timeout:
                    if conn.poll(POLL_INTERVAL):
                        try:
                            message = conn.recv()
                            if message.get('type') == 'transcription_result':
                                result = message.get('result', {})
                                _stt_process_status[task_id] = 'completed'
                                cleanup_completed_stt_processes()
                                return result
                            elif message.get('error'):
                                _stt_process_status[task_id] = 'error'
                                cleanup_completed_stt_processes()
                                return {"success": False, "error": message.get('error')}
                        except (OSError, EOFError):
                            break

                    if not process.is_alive():
                        _stt_process_status[task_id] = 'error'
                        cleanup_completed_stt_processes()
                        return {"success": False, "error": "Process terminated unexpectedly"}

                _stt_process_status[task_id] = 'timeout'
                cleanup_completed_stt_processes()
                return {"success": False, "error": "Transcription timeout"}

            except Exception as e:
                logger.error(f"Error in STT multiprocessing for {task_id}: {str(e)}")
                cleanup_completed_stt_processes()
                return {"success": False, "error": str(e)}

    def cancel_task(self, task_id: str) -> bool:
        """Cancel a running STT task"""
        return cancel_stt_task(task_id)

class LocalSTT:
    """
    Local STT implementation using faster_whisper library
    """

    def __init__(self, model_size: str = "base"):
        """
        Initialize LocalSTT

        Args:
            model_size: Whisper model size (tiny, base, small, medium, large)
        """
        self.model_size = model_size
        self.model_loaded = False

    def _generate_task_id(self) -> str:
        """Generate unique task ID"""
        return f"local_stt_{uuid.uuid4().hex[:8]}"

    def is_available(self) -> bool:
        """Check if faster_whisper is installed"""

    def transcribe(self, file_path: str,
                  language: Optional[str] = None,
                  use_multiprocessing: bool = True) -> Dict[str, Any]:
        """
        Transcribe audio using local Whisper model

        Args:
            file_path: Path to audio file
            language: Language code for audio
            use_multiprocessing: Whether to use multiprocessing

        Returns:
            Dict with transcription results
        """
        if not self.is_available():
            return {
                "success": False,
                "error": "faster_whisper not installed. Install with: pip install faster-whisper"
            }

        task_id = self._generate_task_id()

        if use_multiprocessing:
            return self._transcribe_with_multiprocessing(
                task_id, file_path, language
            )
        else:
            try:

                model = WhisperModel(self.model_size, device="cpu", compute_type="int8")
                segments, info = model.transcribe(
                    file_path,
                    beam_size=5,
                    language=language,
                    vad_filter=True,
                    vad_parameters=dict(min_silence_duration_ms=500)
                )

                transcription = ""
                segment_list = []

                for segment in segments:
                    transcription += segment.text + " "
                    segment_list.append({
                        "start": segment.start,
                        "end": segment.end,
                        "text": segment.text
                    })

                return {
                    'success': True,
                    'text': transcription.strip(),
                    'language': info.language,
                    'segments': segment_list
                }

            except Exception as e:
                logger.error(f"Local transcription failed: {str(e)}")
                return {"success": False, "error": str(e)}

    def _transcribe_with_multiprocessing(self, task_id: str, file_path: str,
                                        language: str) -> Dict[str, Any]:
        """Transcribe using multiprocessing for cancellation support"""

        with _stt_processes_lock:
            cleanup_completed_stt_processes()

            try:
                process, conn = start_local_stt_process(task_id)
                _stt_processes[task_id] = process
                _stt_process_connections[task_id] = conn
                _stt_process_status[task_id] = 'starting'
                cancellation_manager.register_process(task_id, process)

                if conn.poll(INIT_RESPONSE_TIMEOUT):
                    response = conn.recv()
                    if not response.get('success'):
                        cleanup_completed_stt_processes()
                        return {"success": False, "error": response.get('error')}
                else:
                    cleanup_completed_stt_processes()
                    return {"success": False, "error": "Initialization timeout"}

                _stt_process_status[task_id] = 'running'

                conn.send({
                    'command': 'transcribe',
                    'file_path': file_path,
                    'language': language,
                    'model_size': self.model_size
                })

                timeout = 300
                start_time = time.time()

                while time.time() - start_time < timeout:
                    if conn.poll(POLL_INTERVAL):
                        try:
                            message = conn.recv()
                            if message.get('type') == 'transcription_result':
                                result = message.get('result', {})
                                _stt_process_status[task_id] = 'completed'
                                cleanup_completed_stt_processes()
                                return result
                            elif message.get('error'):
                                _stt_process_status[task_id] = 'error'
                                cleanup_completed_stt_processes()
                                return {"success": False, "error": message.get('error')}
                        except (OSError, EOFError):
                            break

                    if not process.is_alive():
                        _stt_process_status[task_id] = 'error'
                        cleanup_completed_stt_processes()
                        return {"success": False, "error": "Process terminated unexpectedly"}

                _stt_process_status[task_id] = 'timeout'
                cleanup_completed_stt_processes()
                return {"success": False, "error": "Transcription timeout"}

            except Exception as e:
                logger.error(f"Error in local STT multiprocessing for {task_id}: {str(e)}")
                cleanup_completed_stt_processes()
                return {"success": False, "error": str(e)}

    def cancel_task(self, task_id: str) -> bool:
        """Cancel a running local STT task"""
        return cancel_stt_task(task_id)