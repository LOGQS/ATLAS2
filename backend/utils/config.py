# status: complete

from typing import Dict, Any


def get_provider_map() -> Dict[str, Any]:
    """Get map of all available provider instances."""
    from chat.providers import Gemini, HuggingFace, OpenRouter
    
    return {
        "gemini": Gemini(),
        "huggingface": HuggingFace(), 
        "openrouter": OpenRouter()
    }


class Config:
    """Configuration class for ATLAS application settings."""
    
    DEFAULT_PROVIDER = "gemini"
    
    DEFAULT_MODEL = "gemini-2.5-flash"

    DEFAULT_STREAMING = True
    
    RATE_LIMIT_REQUESTS_PER_MINUTE = 60
    RATE_LIMIT_BURST_SIZE = 10
    
    DEFAULT_TTS_PROVIDER = "pyttsx3"
    DEFAULT_TTS_VOICE = None  
    DEFAULT_TTS_RATE = 200    
    DEFAULT_TTS_VOLUME = 0.9  
    TTS_ENABLED = True
    
    @classmethod
    def get_default_provider(cls) -> str:
        """Get the default provider name, validated against available providers."""
        available_providers = list(get_provider_map().keys())
        if cls.DEFAULT_PROVIDER in available_providers:
            return cls.DEFAULT_PROVIDER
        return available_providers[0] if available_providers else cls.DEFAULT_PROVIDER
    
    @classmethod
    def get_default_model(cls) -> str:
        """Get the default model name."""
        return cls.DEFAULT_MODEL
    
    @classmethod
    def get_default_streaming(cls) -> bool:
        """Get the default streaming mode."""
        return cls.DEFAULT_STREAMING
    
    @classmethod
    def get_rate_limit_requests_per_minute(cls) -> int:
        """Get rate limit requests per minute."""
        return cls.RATE_LIMIT_REQUESTS_PER_MINUTE
    
    @classmethod
    def get_rate_limit_burst_size(cls) -> int:
        """Get rate limit burst size."""
        return cls.RATE_LIMIT_BURST_SIZE
    
    @classmethod
    def get_tts_enabled(cls) -> bool:
        """Get TTS enabled state."""
        return cls.TTS_ENABLED
    
    @classmethod
    def get_default_tts_provider(cls) -> str:
        """Get the default TTS provider name."""
        return cls.DEFAULT_TTS_PROVIDER
    
    @classmethod
    def get_default_tts_voice(cls):
        """Get the default TTS voice."""
        return cls.DEFAULT_TTS_VOICE
    
    @classmethod
    def get_default_tts_rate(cls) -> int:
        """Get the default TTS speech rate."""
        return cls.DEFAULT_TTS_RATE
    
    @classmethod
    def get_default_tts_volume(cls) -> float:
        """Get the default TTS volume."""
        return cls.DEFAULT_TTS_VOLUME
    
    @classmethod
    def get_defaults(cls) -> dict:
        """Get all default configurations."""
        return {
            "provider": cls.get_default_provider(),
            "model": cls.DEFAULT_MODEL,
            "streaming": cls.DEFAULT_STREAMING,
            "rate_limit_requests_per_minute": cls.RATE_LIMIT_REQUESTS_PER_MINUTE,
            "rate_limit_burst_size": cls.RATE_LIMIT_BURST_SIZE,
            "tts_enabled": cls.TTS_ENABLED,
            "tts_provider": cls.DEFAULT_TTS_PROVIDER,
            "tts_voice": cls.DEFAULT_TTS_VOICE,
            "tts_rate": cls.DEFAULT_TTS_RATE,
            "tts_volume": cls.DEFAULT_TTS_VOLUME
        }
    
    @classmethod
    def get_available_providers(cls) -> list:
        """Get list of available provider names."""
        return list(get_provider_map().keys())