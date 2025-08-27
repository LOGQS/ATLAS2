# status: complete

from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional, Callable
from enum import Enum
import time
from utils.logger import get_logger
from utils.config import Config

logger = get_logger(__name__)


class TTSState(Enum):
    """TTS engine states"""
    IDLE = "idle"
    SPEAKING = "speaking"
    PAUSED = "paused"
    STOPPED = "stopped"
    ERROR = "error"


class TTSMessage:
    """TTS message container"""
    def __init__(self, text: str, message_id: str, priority: int = 0, callback: Optional[Callable] = None):
        self.text = text
        self.message_id = message_id
        self.priority = priority
        self.callback = callback
        self.timestamp = time.time()
    
    def __lt__(self, other):
        return self.priority > other.priority
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for process communication"""
        return {
            'text': self.text,
            'message_id': self.message_id,
            'priority': self.priority,
            'timestamp': self.timestamp
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'TTSMessage':
        """Create from dictionary for process communication"""
        message = cls(data['text'], data['message_id'], data.get('priority', 0))
        message.timestamp = data.get('timestamp', time.time())
        return message


class TTSCommand:
    """TTS command structure for process communication"""
    
    SPEAK = "speak"
    CONFIGURE = "configure"
    GET_VOICES = "get_voices"
    PAUSE = "pause"
    RESUME = "resume"
    STOP = "stop"
    
    def __init__(self, command_type: str, data: Optional[Dict[str, Any]] = None):
        self.command_type = command_type
        self.data = data or {}
        self.timestamp = time.time()
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'command_type': self.command_type,
            'data': self.data,
            'timestamp': self.timestamp
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'TTSCommand':
        cmd = cls(data['command_type'], data.get('data', {}))
        cmd.timestamp = data.get('timestamp', time.time())
        return cmd


class TTSResponse:
    """TTS response structure for process communication"""
    
    SUCCESS = "success"
    ERROR = "error"
    STATE_UPDATE = "state_update"
    VOICES_LIST = "voices_list"
    
    def __init__(self, response_type: str, data: Optional[Dict[str, Any]] = None, success: bool = True):
        self.response_type = response_type
        self.data = data or {}
        self.success = success
        self.timestamp = time.time()
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'response_type': self.response_type,
            'data': self.data,
            'success': self.success,
            'timestamp': self.timestamp
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'TTSResponse':
        resp = cls(data['response_type'], data.get('data', {}), data.get('success', True))
        resp.timestamp = data.get('timestamp', time.time())
        return resp


class TTSManager(ABC):
    """Abstract base class for TTS providers that unifies different TTS engines"""
    
    def __init__(self, tts_id: str):
        self.tts_id = tts_id
        self.state = TTSState.IDLE
        
        self.voice = Config.get_default_tts_voice()
        self.rate = Config.get_default_tts_rate()
        self.volume = Config.get_default_tts_volume()
        
        logger.info(f"[TTS] Initialized TTS manager {self.tts_id}")
    
    @abstractmethod
    def start(self) -> bool:
        """Start the TTS system"""
        pass
    
    @abstractmethod
    def stop(self):
        """Stop the TTS system and cleanup"""
        pass
    
    @abstractmethod
    def speak(self, text: str, message_id: str, priority: int = 0, callback: Optional[Callable] = None) -> bool:
        """Queue text to be spoken"""
        pass
    
    @abstractmethod
    def pause(self) -> bool:
        """Pause TTS playback"""
        pass
    
    @abstractmethod
    def resume(self) -> bool:
        """Resume TTS playback"""
        pass
    
    @abstractmethod
    def configure(self, voice: Optional[str] = None, rate: Optional[int] = None, volume: Optional[float] = None) -> bool:
        """Configure TTS settings"""
        pass
    
    @abstractmethod
    def get_voices(self) -> List[Dict[str, Any]]:
        """Get available voices"""
        pass
    
    @abstractmethod
    def get_state(self) -> TTSState:
        """Get current TTS state"""
        pass
    
    @abstractmethod
    def is_cancelled(self) -> bool:
        """Check if TTS has been cancelled"""
        pass


def create_tts_provider(provider_type: str = None, tts_id: str = None) -> Optional[TTSManager]:
    """Factory function to create TTS provider instances"""
    
    if not Config.get_tts_enabled():
        logger.info("[TTS] TTS is disabled in configuration")
        return None
    
    provider_type = provider_type or Config.get_default_tts_provider()
    tts_id = tts_id or f"tts_{int(time.time())}"
    
    if provider_type == "pyttsx3":
        from features.tts_providers import PytTSX3Provider
        return PytTSX3Provider(tts_id)
    else:
        logger.error(f"[TTS] Unknown TTS provider type: {provider_type}")
        return None


_global_tts_instance = None
_tts_lock = None


def get_global_tts() -> Optional[TTSManager]:
    """Get or create global TTS instance"""
    global _global_tts_instance, _tts_lock
    
    if _tts_lock is None:
        import threading
        _tts_lock = threading.Lock()
    
    with _tts_lock:
        if not _global_tts_instance:
            _global_tts_instance = create_tts_provider(tts_id="global_tts")
            if _global_tts_instance:
                _global_tts_instance.start()
        
        return _global_tts_instance


def cleanup_global_tts():
    """Cleanup global TTS instance"""
    global _global_tts_instance, _tts_lock
    
    if _tts_lock is None:
        return
        
    with _tts_lock:
        if _global_tts_instance:
            _global_tts_instance.stop()
            _global_tts_instance = None
            logger.info("[TTS] Global TTS instance cleaned up")