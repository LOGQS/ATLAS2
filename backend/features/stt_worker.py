# status: complete

"""
STT worker that runs in a separate process for true cancellation support.
This allows for immediate termination of speech-to-text operations.
"""

import multiprocessing
import sys
import time
from pathlib import Path

def start_stt_process(task_id: str) -> tuple:
    """Start an STT worker process and return process and connection objects"""

    parent_conn, child_conn = multiprocessing.Pipe()

    process = multiprocessing.Process(
        target=stt_worker,
        args=(task_id, child_conn),
        daemon=False
    )
    process.start()

    return process, parent_conn

def stt_worker(task_id: str, child_conn) -> None:
    """
    STT worker function that runs in a separate process.
    When the process is terminated, all operations stop immediately.
    """

    try:
        backend_dir = Path(__file__).parent.parent
        if str(backend_dir) not in sys.path:
            sys.path.insert(0, str(backend_dir))

        from utils.logger import get_logger
        from features.stt_providers import Groq

        worker_logger = get_logger(__name__)
        worker_logger.info(f"[STT-WORKER] Starting STT worker process for task {task_id}")

        provider = None
        processing_active = False

        try:
            provider = Groq()

            worker_logger.info(f"[STT-WORKER] Initialized worker for task {task_id}")

            child_conn.send({'success': True, 'task_id': task_id})

        except Exception as e:
            error_msg = f'STT worker initialization failed: {str(e)}'
            worker_logger.error(f"[STT-WORKER] {error_msg}")
            child_conn.send({'success': False, 'error': error_msg, 'task_id': task_id})
            return

        worker_logger.info(f"[STT-WORKER] Starting command processing loop for task {task_id}")

        while True:
            try:
                if child_conn.poll(0.1):
                    try:
                        command = child_conn.recv()
                        command_type = command.get('command')

                        worker_logger.info(f"[STT-WORKER] Received command {command_type} for task {task_id}")

                        if command_type == 'stop':
                            child_conn.send({'success': True, 'task_id': task_id})
                            break

                        elif command_type == 'cancel':
                            if processing_active:
                                processing_active = False
                                child_conn.send({'success': True, 'cancelled': True, 'task_id': task_id})
                                worker_logger.info(f"[STT-WORKER] Cancelled processing for task {task_id}")
                            else:
                                child_conn.send({'success': True, 'cancelled': False, 'task_id': task_id})

                        elif command_type == 'transcribe':
                            if processing_active:
                                child_conn.send({'success': False, 'error': 'Processing already active', 'task_id': task_id})
                                continue

                            if not provider or not provider.is_available():
                                child_conn.send({'success': False, 'error': 'Provider not available', 'task_id': task_id})
                                continue

                            try:
                                processing_active = True

                                file_path = command.get('file_path')
                                model = command.get('model', 'whisper-large-v3-turbo')
                                language = command.get('language')

                                if not file_path:
                                    raise ValueError("No file path provided")

                                result = provider.transcribe_audio(
                                    file_path=file_path,
                                    model=model,
                                    language=language
                                )

                                child_conn.send({
                                    'type': 'transcription_result',
                                    'result': result,
                                    'task_id': task_id
                                })

                                processing_active = False
                                worker_logger.info(f"[STT-WORKER] Transcription completed for task {task_id}")

                            except Exception as proc_error:
                                processing_active = False
                                error_msg = f'Transcription failed: {str(proc_error)}'
                                worker_logger.error(f"[STT-WORKER] {error_msg}")
                                child_conn.send({'success': False, 'error': error_msg, 'task_id': task_id})

                    except Exception as cmd_error:
                        worker_logger.error(f"[STT-WORKER] Command processing error for task {task_id}: {str(cmd_error)}")
                        child_conn.send({'success': False, 'error': f'Command processing failed: {str(cmd_error)}', 'task_id': task_id})

            except Exception as loop_error:
                worker_logger.error(f"[STT-WORKER] Main loop error for task {task_id}: {str(loop_error)}")
                time.sleep(0.1)

    except Exception as worker_error:
        try:
            child_conn.send({'success': False, 'error': f'Worker crashed: {str(worker_error)}', 'task_id': task_id})
        except:
            pass
    finally:
        try:
            child_conn.close()
        except:
            pass

def start_local_stt_process(task_id: str) -> tuple:
    """Start a local STT worker process for faster_whisper"""

    parent_conn, child_conn = multiprocessing.Pipe()

    process = multiprocessing.Process(
        target=local_stt_worker,
        args=(task_id, child_conn),
        daemon=False
    )
    process.start()

    return process, parent_conn

def local_stt_worker(task_id: str, child_conn) -> None:
    """
    Local STT worker using faster_whisper library.
    Runs in a separate process for cancellation support.
    """

    try:
        backend_dir = Path(__file__).parent.parent
        if str(backend_dir) not in sys.path:
            sys.path.insert(0, str(backend_dir))

        from utils.logger import get_logger

        worker_logger = get_logger(__name__)
        worker_logger.info(f"[LOCAL-STT-WORKER] Starting local STT worker for task {task_id}")

        model = None
        processing_active = False

        try:
            try:
                from faster_whisper import WhisperModel
                faster_whisper_available = True
            except ImportError:
                faster_whisper_available = False
                worker_logger.warning("[LOCAL-STT-WORKER] faster_whisper not installed")

            if not faster_whisper_available:
                child_conn.send({
                    'success': False,
                    'error': 'faster_whisper library not installed. Install with: pip install faster-whisper',
                    'task_id': task_id
                })
                return

            child_conn.send({'success': True, 'task_id': task_id})

        except Exception as e:
            error_msg = f'Local STT worker initialization failed: {str(e)}'
            worker_logger.error(f"[LOCAL-STT-WORKER] {error_msg}")
            child_conn.send({'success': False, 'error': error_msg, 'task_id': task_id})
            return

        worker_logger.info(f"[LOCAL-STT-WORKER] Starting command processing loop for task {task_id}")

        while True:
            try:
                if child_conn.poll(0.1):
                    try:
                        command = child_conn.recv()
                        command_type = command.get('command')

                        worker_logger.info(f"[LOCAL-STT-WORKER] Received command {command_type}")

                        if command_type == 'stop':
                            child_conn.send({'success': True, 'task_id': task_id})
                            break

                        elif command_type == 'cancel':
                            if processing_active:
                                processing_active = False
                                child_conn.send({'success': True, 'cancelled': True, 'task_id': task_id})
                            else:
                                child_conn.send({'success': True, 'cancelled': False, 'task_id': task_id})

                        elif command_type == 'transcribe':
                            if processing_active:
                                child_conn.send({'success': False, 'error': 'Processing already active', 'task_id': task_id})
                                continue

                            if not model:
                                model = WhisperModel("base", device="cpu", compute_type="int8")

                            try:
                                processing_active = True

                                file_path = command.get('file_path')
                                language = command.get('language')
                                model_size = command.get('model_size', 'base')

                                if not file_path:
                                    raise ValueError("No file path provided")

                                if model_size != 'base':
                                    model = WhisperModel(model_size, device="cpu", compute_type="int8")

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
                                    if not processing_active: 
                                        break

                                    transcription += segment.text + " "
                                    segment_list.append({
                                        "start": segment.start,
                                        "end": segment.end,
                                        "text": segment.text
                                    })

                                result = {
                                    'success': True,
                                    'text': transcription.strip(),
                                    'language': info.language,
                                    'segments': segment_list
                                }

                                child_conn.send({
                                    'type': 'transcription_result',
                                    'result': result,
                                    'task_id': task_id
                                })

                                processing_active = False

                            except Exception as proc_error:
                                processing_active = False
                                error_msg = f'Local transcription failed: {str(proc_error)}'
                                worker_logger.error(f"[LOCAL-STT-WORKER] {error_msg}")
                                child_conn.send({'success': False, 'error': error_msg, 'task_id': task_id})

                    except Exception as cmd_error:
                        worker_logger.error(f"[LOCAL-STT-WORKER] Command error: {str(cmd_error)}")
                        child_conn.send({'success': False, 'error': str(cmd_error), 'task_id': task_id})

            except Exception as loop_error:
                worker_logger.error(f"[LOCAL-STT-WORKER] Loop error: {str(loop_error)}")
                time.sleep(0.1)

    except Exception as worker_error:
        try:
            child_conn.send({'success': False, 'error': f'Worker crashed: {str(worker_error)}', 'task_id': task_id})
        except:
            pass
    finally:
        try:
            child_conn.close()
        except:
            pass