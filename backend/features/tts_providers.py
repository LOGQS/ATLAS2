# status: complete

"""
TTS providers that manage multiprocessing TTS workers.
"""

from typing import Dict, Any, List, Optional, Callable

from features.tts_interface import TTSManager, TTSState, TTSMessage, TTSCommand, TTSResponse
from features.tts_worker import start_tts_process
from utils.logger import get_logger
from utils.cancellation_manager import cancellation_manager

logger = get_logger(__name__)


class PytTSX3Provider(TTSManager):
    """pyttsx3-based TTS provider using multiprocessing for instant cancellation"""
    
    def __init__(self, tts_id: str):
        super().__init__(tts_id)
        self.process = None
        self.conn = None
        self.is_running = False
        self._response_callbacks = {}
        
    def start(self) -> bool:
        """Start the TTS process"""
        if self.is_running:
            logger.warning(f"[TTS] TTS {self.tts_id} already running")
            return True
        
        try:
            tts_config = {
                'rate': self.rate,
                'volume': self.volume,
                'voice': self.voice,
                'provider': 'pyttsx3'
            }
            
            self.process, self.conn = start_tts_process(tts_config, self.tts_id)
            
            cancellation_manager.register_process(self.tts_id, self.process)
            
            if self.conn.poll(5):
                try:
                    response_data = self.conn.recv()
                    response = TTSResponse.from_dict(response_data)
                    
                    if response.success:
                        self.is_running = True
                        self.state = TTSState.IDLE
                        logger.info(f"[TTS] Successfully started TTS process for {self.tts_id}")
                        return True
                    else:
                        error = response.data.get('error', 'Unknown error')
                        logger.error(f"[TTS] Failed to initialize TTS {self.tts_id}: {error}")
                        self._cleanup_process()
                        return False
                        
                except Exception as e:
                    logger.error(f"[TTS] Failed to receive initialization response for {self.tts_id}: {str(e)}")
                    self._cleanup_process()
                    return False
            else:
                logger.error(f"[TTS] TTS initialization timeout for {self.tts_id}")
                self._cleanup_process()
                return False
                
        except Exception as e:
            logger.error(f"[TTS] Failed to start TTS process for {self.tts_id}: {str(e)}")
            self._cleanup_process()
            return False
    
    def stop(self):
        """Stop the TTS process"""
        if not self.is_running:
            return
        
        logger.info(f"[TTS] Stopping TTS {self.tts_id}")
        
        try:
            if self.conn and self.process and self.process.is_alive():
                stop_command = TTSCommand(TTSCommand.STOP)
                self.conn.send(stop_command.to_dict())
                
                if self.conn.poll(2):
                    self.conn.recv()
                    
        except Exception as e:
            logger.warning(f"[TTS] Error sending stop command to {self.tts_id}: {str(e)}")
        
        self._cleanup_process()
        
        self.state = TTSState.STOPPED
        self.is_running = False
        
        logger.info(f"[TTS] Stopped TTS {self.tts_id}")
    
    def speak(self, text: str, message_id: str, priority: int = 0, callback: Optional[Callable] = None) -> bool:
        """Queue text to be spoken"""
        if not self.is_running:
            logger.warning(f"[TTS] TTS {self.tts_id} not running, cannot speak")
            return False
        
        if not self.is_process_healthy():
            return False
        
        if not text or not text.strip():
            logger.warning(f"[TTS] Empty text provided to TTS {self.tts_id}")
            return False
        
        try:
            message = TTSMessage(text.strip(), message_id, priority, callback)
            
            if callback:
                self._response_callbacks[message_id] = callback
            
            speak_command = TTSCommand(TTSCommand.SPEAK, {
                'message': message.to_dict()
            })
            
            self.conn.send(speak_command.to_dict())
            logger.info(f"[TTS] Sent speak command for message {message_id} to TTS {self.tts_id}")
            
            return True
            
        except Exception as e:
            logger.error(f"[TTS] Failed to send speak command for {self.tts_id}: {str(e)}")
            return False
    
    def pause(self) -> bool:
        """Pause TTS playback"""
        if not self.is_running:
            return False
        
        try:
            pause_command = TTSCommand(TTSCommand.PAUSE)
            self.conn.send(pause_command.to_dict())
            return True
        except Exception as e:
            logger.error(f"[TTS] Failed to pause TTS {self.tts_id}: {str(e)}")
            return False
    
    def resume(self) -> bool:
        """Resume TTS playback"""
        if not self.is_running:
            return False
        
        try:
            resume_command = TTSCommand(TTSCommand.RESUME)
            self.conn.send(resume_command.to_dict())
            return True
        except Exception as e:
            logger.error(f"[TTS] Failed to resume TTS {self.tts_id}: {str(e)}")
            return False
    
    def configure(self, voice: Optional[str] = None, rate: Optional[int] = None, volume: Optional[float] = None) -> bool:
        """Configure TTS settings"""
        if not self.is_running:
            return False
        
        try:
            config_data = {}
            if voice is not None:
                config_data['voice'] = voice
                self.voice = voice
            if rate is not None:
                config_data['rate'] = rate
                self.rate = rate
            if volume is not None:
                config_data['volume'] = volume
                self.volume = volume
            
            configure_command = TTSCommand(TTSCommand.CONFIGURE, config_data)
            self.conn.send(configure_command.to_dict())
            
            return True
            
        except Exception as e:
            logger.error(f"[TTS] Failed to configure TTS {self.tts_id}: {str(e)}")
            return False
    
    def get_voices(self) -> List[Dict[str, Any]]:
        """Get available voices"""
        if not self.is_running:
            return []
        
        try:
            voices_command = TTSCommand(TTSCommand.GET_VOICES)
            self.conn.send(voices_command.to_dict())
            
            if self.conn.poll(5):
                response_data = self.conn.recv()
                response = TTSResponse.from_dict(response_data)
                
                if response.success and response.response_type == TTSResponse.VOICES_LIST:
                    return response.data.get('voices', [])
            
            return []
            
        except Exception as e:
            logger.error(f"[TTS] Failed to get voices for TTS {self.tts_id}: {str(e)}")
            return []
    
    def get_state(self) -> TTSState:
        """Get current TTS state"""
        return self.state
    
    def is_cancelled(self) -> bool:
        """Check if TTS has been cancelled"""
        return cancellation_manager.is_cancelled(self.tts_id) or not self.is_running
    
    def is_process_healthy(self) -> bool:
        """Check if TTS process is alive and responsive"""
        if not self.is_running or not self.process or not self.conn:
            return False
        
        if not self.process.is_alive():
            logger.warning(f"[TTS] Process {self.tts_id} died unexpectedly")
            self._handle_process_death()
            return False
        
        return True
    
    def _handle_process_death(self):
        """Handle unexpected process death"""
        logger.error(f"[TTS] Handling unexpected death of TTS process {self.tts_id}")
        self.state = TTSState.ERROR
        self.is_running = False
        self._cleanup_process()
    
    def _sync_state_from_response(self, response: TTSResponse):
        """Synchronize provider state from worker response"""
        if response.response_type == TTSResponse.STATE_UPDATE:
            new_state = response.data.get('state')
            if new_state:
                try:
                    self.state = TTSState(new_state)
                    logger.debug(f"[TTS] State synchronized to {self.state} for {self.tts_id}")
                except ValueError:
                    logger.warning(f"[TTS] Invalid state received: {new_state} for {self.tts_id}")
        
        elif response.response_type == TTSResponse.ERROR:
            self.state = TTSState.ERROR
            error_msg = response.data.get('error', 'Unknown error')
            logger.error(f"[TTS] Worker error for {self.tts_id}: {error_msg}")
            
            if not self.is_process_healthy():
                self._handle_process_death()
    
    def _cleanup_process(self):
        """Clean up the TTS process"""
        try:
            if self.process:
                if self.process.is_alive():
                    self.process.terminate()
                    self.process.join(timeout=2)
                    if self.process.is_alive():
                        try:
                            self.process.kill()
                        except AttributeError:
                            pass
                
                cancellation_manager.unregister_process(self.tts_id)
                cancellation_manager.cleanup_process(self.tts_id)
                
            if self.conn:
                try:
                    self.conn.close()
                except:
                    pass
                self.conn = None
                
            self.process = None
            
        except Exception as e:
            logger.error(f"[TTS] Error cleaning up process for {self.tts_id}: {str(e)}")
    
    def poll_responses(self) -> Optional[TTSResponse]:
        """Poll for responses from TTS process (non-blocking)"""
        if not self.is_running or not self.conn:
            return None
        
        if not self.is_process_healthy():
            return None
        
        try:
            if self.conn.poll(0):
                response_data = self.conn.recv()
                response = TTSResponse.from_dict(response_data)
                
                self._sync_state_from_response(response)
                
                if response.response_type == TTSResponse.SUCCESS:
                    message_id = response.data.get('message_id')
                    if message_id and message_id in self._response_callbacks:
                        callback = self._response_callbacks.pop(message_id)
                        try:
                            callback(message_id, response.success)
                        except Exception as e:
                            logger.error(f"[TTS] Callback error for {message_id}: {str(e)}")
                
                return response
                
        except Exception as e:
            logger.error(f"[TTS] Error polling responses for {self.tts_id}: {str(e)}")
            if not self.is_process_healthy():
                self._handle_process_death()
        
        return None