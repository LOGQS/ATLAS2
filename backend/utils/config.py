# status: complete

from typing import Dict, Any
import threading


_provider_cache = None
_provider_lock = threading.Lock()


def get_provider_map() -> Dict[str, Any]:
    """Get map of all available provider instances (cached as singletons)."""
    global _provider_cache

    if _provider_cache is not None:
        return _provider_cache

    with _provider_lock:
        if _provider_cache is not None:
            return _provider_cache

        from chat.providers import Gemini, HuggingFace, OpenRouter, Groq

        _provider_cache = {
            "gemini": Gemini(),
            "huggingface": HuggingFace(),
            "openrouter": OpenRouter(),
            "groq": Groq()
        }

        return _provider_cache

available_routes = [
    {
        "route_name": "simple",
        "route_description": "Simple queries and basic conversations",
        "route_context": "Use for greetings, simple Q&A, basic information requests, casual conversation"
    },
    {
        "route_name": "complex",
        "route_description": "Complex reasoning and analysis tasks",
        "route_context": "Use for code generation, detailed analysis, multi-step problems, technical questions"
    },
    {
        "route_name": "fast",
        "route_description": "Fast responses",
        "route_context": "Use when the user requests a fast response, prioritizing speed over depth."
    },
    {
        "route_name": "taskflow",
        "route_description": "Structured multi-step planning and tool execution",
        "route_context": "Use when the request needs orchestration of tools, parallel subtasks, or durable context management"
    }
]

ROUTE_MODEL_MAP = {
    "simple": "gemini-2.5-flash",
    "complex": "gemini-2.5-pro",
    "fast": "openai/gpt-oss-120b",
    "taskflow": "gemini-2.5-pro"
}

def get_router_map():
    """Get map of all available routes and their descriptions."""
    return ROUTE_MODEL_MAP

def infer_provider_from_model(model: str) -> str:
    """Automatically infer the provider from the model name by checking available models in each provider."""
    provider_map = get_provider_map()

    for provider_name, provider_instance in provider_map.items():
        if provider_instance.is_available():
            available_models = provider_instance.get_available_models()
            if model in available_models:
                return provider_name

    return Config.get_default_provider()


class Config:
    """Configuration class for ATLAS application settings."""

    DEFAULT_PROVIDER = "gemini"

    DEFAULT_MODEL = "gemini-2.5-flash"

    DEFAULT_ROUTER_ENABLED = True
    DEFAULT_ROUTER_MODEL = "gemini-2.5-flash-lite"

    DEFAULT_STREAMING = True

    RATE_LIMIT_REQUESTS_PER_MINUTE = 60
    RATE_LIMIT_BURST_SIZE = 10

    STT_USE_CLOUD = True
    STT_PROVIDER = "groq"
    STT_MODEL = "whisper-large-v3-turbo"

    WORKER_POOL_SIZE = 4
    WORKER_MAX_PARALLEL_SPAWN = 5
    WORKER_INIT_TIMEOUT = 20.0
    
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
    def get_default_router_state(cls) -> bool:
        """Get the default router state."""
        return cls.DEFAULT_ROUTER_ENABLED

    @classmethod
    def get_router_model(cls) -> str:
        """Get the router model to use."""
        return cls.DEFAULT_ROUTER_MODEL
    
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
    def get_stt_use_cloud(cls) -> bool:
        """Get whether to use cloud STT."""
        return cls.STT_USE_CLOUD

    @classmethod
    def get_stt_provider(cls) -> str:
        """Get STT provider."""
        return cls.STT_PROVIDER

    @classmethod
    def get_stt_model(cls) -> str:
        """Get STT model."""
        return cls.STT_MODEL

    @classmethod
    def get_defaults(cls) -> dict:
        """Get all default configurations."""
        return {
            "provider": cls.get_default_provider(),
            "model": cls.DEFAULT_MODEL,
            "streaming": cls.DEFAULT_STREAMING,
            "rate_limit_requests_per_minute": cls.RATE_LIMIT_REQUESTS_PER_MINUTE,
            "rate_limit_burst_size": cls.RATE_LIMIT_BURST_SIZE,
            "stt_use_cloud": cls.STT_USE_CLOUD,
            "stt_provider": cls.STT_PROVIDER,
            "stt_model": cls.STT_MODEL
        }
    
    @classmethod
    def get_available_providers(cls) -> list:
        """Get list of available provider names."""
        return list(get_provider_map().keys())

    @classmethod
    def get_worker_pool_size(cls) -> int:
        """Get worker pool size."""
        return cls.WORKER_POOL_SIZE

    @classmethod
    def get_worker_max_parallel_spawn(cls) -> int:
        """Get max parallel worker spawn count."""
        return cls.WORKER_MAX_PARALLEL_SPAWN

    @classmethod
    def get_worker_init_timeout(cls) -> float:
        """Get worker initialization timeout."""
        return cls.WORKER_INIT_TIMEOUT