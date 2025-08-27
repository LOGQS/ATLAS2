# status: complete

"""
TTS worker that runs in a separate process.
This allows for true process termination that immediately stops TTS operations.
"""

import multiprocessing
import sys
import time
import queue
from pathlib import Path
from typing import Dict, Any

from features.tts_interface import TTSState, TTSMessage, TTSCommand, TTSResponse


def tts_worker(tts_config: Dict[str, Any], tts_id: str, child_conn) -> None:
    """
    TTS worker function that runs in a separate process.
    This function initializes the TTS engine and handles TTS operations.
    When the process is terminated, all TTS operations stop immediately.
    """
    
    try:
        backend_dir = Path(__file__).parent.parent
        if str(backend_dir) not in sys.path:
            sys.path.insert(0, str(backend_dir))
        
        from utils.logger import get_logger
        
        worker_logger = get_logger(__name__)
        worker_logger.info(f"[TTS-WORKER] Starting TTS worker process for {tts_id}")
        
        engine = None
        state = TTSState.IDLE
        message_queue = queue.PriorityQueue()
        
        try:
            import pyttsx3
            engine = pyttsx3.init()
            if not engine:
                child_conn.send(TTSResponse(TTSResponse.ERROR, {
                    'error': 'Failed to initialize pyttsx3 engine',
                    'tts_id': tts_id
                }, False).to_dict())
                return
            
            rate = tts_config.get('rate', 200)
            volume = tts_config.get('volume', 0.9)
            voice = tts_config.get('voice')
            
            engine.setProperty('rate', rate)
            engine.setProperty('volume', max(0.0, min(1.0, volume)))
            
            if voice:
                voices = engine.getProperty('voices')
                if voices:
                    for v in voices:
                        if v.id == voice:
                            engine.setProperty('voice', v.id)
                            break
            
            worker_logger.info(f"[TTS-WORKER] TTS engine initialized for {tts_id}")
            
            child_conn.send(TTSResponse(TTSResponse.SUCCESS, {
                'tts_id': tts_id,
                'state': state.value
            }).to_dict())
            
        except ImportError:
            child_conn.send(TTSResponse(TTSResponse.ERROR, {
                'error': 'pyttsx3 not available',
                'tts_id': tts_id
            }, False).to_dict())
            return
        except Exception as e:
            child_conn.send(TTSResponse(TTSResponse.ERROR, {
                'error': f'TTS initialization failed: {str(e)}',
                'tts_id': tts_id
            }, False).to_dict())
            return
        
        worker_logger.info(f"[TTS-WORKER] Starting command processing loop for {tts_id}")
        
        while True:
            try:
                if child_conn.poll(0.1):
                    try:
                        command_data = child_conn.recv()
                        command = TTSCommand.from_dict(command_data)
                        
                        worker_logger.info(f"[TTS-WORKER] Received command {command.command_type} for {tts_id}")
                        
                        if command.command_type == TTSCommand.STOP:
                            state = TTSState.STOPPED
                            child_conn.send(TTSResponse(TTSResponse.SUCCESS, {
                                'tts_id': tts_id,
                                'state': state.value
                            }).to_dict())
                            break
                        
                        elif command.command_type == TTSCommand.SPEAK:
                            message_data = command.data.get('message')
                            if message_data:
                                message = TTSMessage.from_dict(message_data)
                                message_queue.put(message)
                                child_conn.send(TTSResponse(TTSResponse.SUCCESS, {
                                    'tts_id': tts_id,
                                    'message_id': message.message_id,
                                    'queued': True
                                }).to_dict())
                        
                        elif command.command_type == TTSCommand.CONFIGURE:
                            success = True
                            try:
                                if 'rate' in command.data:
                                    engine.setProperty('rate', command.data['rate'])
                                if 'volume' in command.data:
                                    vol = max(0.0, min(1.0, command.data['volume']))
                                    engine.setProperty('volume', vol)
                                if 'voice' in command.data:
                                    voices = engine.getProperty('voices')
                                    if voices:
                                        for v in voices:
                                            if v.id == command.data['voice']:
                                                engine.setProperty('voice', v.id)
                                                break
                            except Exception as e:
                                success = False
                                worker_logger.error(f"[TTS-WORKER] Configure failed for {tts_id}: {str(e)}")
                            
                            child_conn.send(TTSResponse(TTSResponse.SUCCESS if success else TTSResponse.ERROR, {
                                'tts_id': tts_id,
                                'configured': success
                            }, success).to_dict())
                        
                        elif command.command_type == TTSCommand.GET_VOICES:
                            try:
                                voices = engine.getProperty('voices')
                                voice_list = []
                                if voices:
                                    for i, voice in enumerate(voices):
                                        voice_info = {
                                            'id': voice.id,
                                            'name': voice.name if hasattr(voice, 'name') else f'Voice {i}',
                                            'gender': getattr(voice, 'gender', 'unknown'),
                                            'age': getattr(voice, 'age', 'unknown'),
                                            'languages': getattr(voice, 'languages', [])
                                        }
                                        voice_list.append(voice_info)
                                
                                child_conn.send(TTSResponse(TTSResponse.VOICES_LIST, {
                                    'tts_id': tts_id,
                                    'voices': voice_list
                                }).to_dict())
                            except Exception as e:
                                child_conn.send(TTSResponse(TTSResponse.ERROR, {
                                    'error': f'Failed to get voices: {str(e)}',
                                    'tts_id': tts_id
                                }, False).to_dict())
                        
                        elif command.command_type == TTSCommand.PAUSE:
                            if state == TTSState.SPEAKING:
                                state = TTSState.PAUSED
                            child_conn.send(TTSResponse(TTSResponse.STATE_UPDATE, {
                                'tts_id': tts_id,
                                'state': state.value
                            }).to_dict())
                        
                        elif command.command_type == TTSCommand.RESUME:
                            if state == TTSState.PAUSED:
                                state = TTSState.IDLE
                            child_conn.send(TTSResponse(TTSResponse.STATE_UPDATE, {
                                'tts_id': tts_id,
                                'state': state.value
                            }).to_dict())
                    
                    except EOFError:
                        worker_logger.info(f"[TTS-WORKER] Connection closed for {tts_id}")
                        break
                    except Exception as e:
                        worker_logger.error(f"[TTS-WORKER] Command processing error for {tts_id}: {str(e)}")
                        child_conn.send(TTSResponse(TTSResponse.ERROR, {
                            'error': str(e),
                            'tts_id': tts_id
                        }, False).to_dict())
                
                if state != TTSState.PAUSED and not message_queue.empty():
                    try:
                        message = message_queue.get_nowait()
                        state = TTSState.SPEAKING
                        
                        child_conn.send(TTSResponse(TTSResponse.STATE_UPDATE, {
                            'tts_id': tts_id,
                            'state': state.value,
                            'speaking_message_id': message.message_id
                        }).to_dict())
                        
                        engine.say(message.text)
                        engine.runAndWait()
                        
                        state = TTSState.IDLE
                        
                        child_conn.send(TTSResponse(TTSResponse.SUCCESS, {
                            'tts_id': tts_id,
                            'message_id': message.message_id,
                            'completed': True,
                            'state': state.value
                        }).to_dict())
                        
                        worker_logger.info(f"[TTS-WORKER] Completed speaking message {message.message_id} for {tts_id}")
                        
                    except queue.Empty:
                        pass
                    except Exception as e:
                        state = TTSState.ERROR
                        worker_logger.error(f"[TTS-WORKER] Speaking error for {tts_id}: {str(e)}")
                        child_conn.send(TTSResponse(TTSResponse.ERROR, {
                            'error': str(e),
                            'tts_id': tts_id,
                            'message_id': getattr(message, 'message_id', 'unknown'),
                            'state': state.value
                        }, False).to_dict())
                        time.sleep(0.1) 
                        state = TTSState.IDLE
                
            except KeyboardInterrupt:
                worker_logger.info(f"[TTS-WORKER] TTS worker interrupted for {tts_id}")
                break
            except Exception as e:
                worker_logger.error(f"[TTS-WORKER] Worker loop error for {tts_id}: {str(e)}")
                time.sleep(0.1)
        
        if engine:
            try:
                engine.stop()
            except:
                pass
        
        worker_logger.info(f"[TTS-WORKER] TTS worker process ended for {tts_id}")
        
    except Exception as e:
        try:
            child_conn.send(TTSResponse(TTSResponse.ERROR, {
                'error': f'Worker process error: {str(e)}',
                'tts_id': tts_id
            }, False).to_dict())
        except:
            pass
    finally:
        try:
            child_conn.close()
        except:
            pass


def _tts_process_runner(tts_config: Dict[str, Any], tts_id: str, child_conn):
    """Process target function - must be at module level for pickling"""
    try:
        tts_worker(tts_config, tts_id, child_conn)
    except Exception as e:
        try:
            child_conn.send(TTSResponse(TTSResponse.ERROR, {
                'error': f'Process runner error: {str(e)}',
                'tts_id': tts_id
            }, False).to_dict())
        except:
            pass
    finally:
        try:
            child_conn.close()
        except:
            pass


def start_tts_process(tts_config: Dict[str, Any], tts_id: str):
    """
    Start a TTS process and return the process and connection for communication.
    """
    parent_conn, child_conn = multiprocessing.Pipe(duplex=True)
    
    process = multiprocessing.Process(
        target=_tts_process_runner,
        args=(tts_config, tts_id, child_conn),
        daemon=True
    )
    process.start()
    
    return process, parent_conn