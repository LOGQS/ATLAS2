# status: complete


class Config:
    """Configuration class for ATLAS application settings."""
    
    DEFAULT_PROVIDER = "gemini"
    
    DEFAULT_MODEL = "gemini-2.5-flash"

    DEFAULT_STREAMING = True
    
    @classmethod
    def get_default_provider(cls) -> str:
        """Get the default provider name."""
        return cls.DEFAULT_PROVIDER
    
    @classmethod
    def get_default_model(cls) -> str:
        """Get the default model name."""
        return cls.DEFAULT_MODEL
    
    @classmethod
    def get_default_streaming(cls) -> bool:
        """Get the default streaming mode."""
        return cls.DEFAULT_STREAMING
    
    @classmethod
    def get_defaults(cls) -> dict:
        """Get all default configurations."""
        return {
            "provider": cls.DEFAULT_PROVIDER,
            "model": cls.DEFAULT_MODEL,
            "streaming": cls.DEFAULT_STREAMING
        }