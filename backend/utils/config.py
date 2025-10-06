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

        from chat.providers import Gemini, HuggingFace, OpenRouter, Groq, Cerebras

        _provider_cache = {
            "gemini": Gemini(),
            "huggingface": HuggingFace(),
            "openrouter": OpenRouter(),
            "groq": Groq(),
            "cerebras": Cerebras()
        }

        return _provider_cache

available_routes = [
    # Capability-based routes (no tools needed)
    {
        "route_name": "creative_writing",
        "route_description": "Creative content generation",
        "route_context": "Stories, poems, marketing copy, creative narratives. Native capabilities sufficient."
    },
    {
        "route_name": "math_reasoning",
        "route_description": "Mathematical reasoning and calculations",
        "route_context": "Math problems, proofs, logic problems, calculations. Native reasoning sufficient."
    },
    {
        "route_name": "code_reasoning",
        "route_description": "Code analysis and review without execution",
        "route_context": "Algorithm explanation, code review, complexity analysis. File already in context."
    },
    {
        "route_name": "visual_reasoning",
        "route_description": "Visual analysis of uploaded media",
        "route_context": "Image/video analysis, description, understanding. Media already in context."
    },
    {
        "route_name": "general_conversation",
        "route_description": "General questions and conversations",
        "route_context": "Q&A, advice, explanations, discussions. Native reasoning sufficient."
    },

    # Execution mode routes (tools needed)
    {
        "route_name": "direct",
        "route_description": "Single tool call with immediate execution",
        "route_context": "One straightforward tool operation where all parameters are explicitly provided. Examples: reading a specific file, listing a directory, attaching a file. Result is returned directly to the model."
    },

    # Single domain routes
    {
        "route_name": "searcher",
        "route_description": "Research and information gathering",
        "route_context": "Web search, academic databases, document extraction, summarization. Agent iterates autonomously."
    },
    {
        "route_name": "coder",
        "route_description": "Complex software development requiring multiple operations",
        "route_context": "Multi-step file operations: editing files, running tests, debugging, refactoring, building projects. Requires planning and sequential execution across multiple files or tools."
    },
    {
        "route_name": "web_controller",
        "route_description": "Browser automation and web interaction",
        "route_context": "Browser navigation, scraping, form filling, web automation. Visual capabilities needed."
    },
    {
        "route_name": "data_ops",
        "route_description": "Data transformation and API operations",
        "route_context": "JSON/CSV/SQL operations, API calls, data validation, format conversion."
    },
    {
        "route_name": "rag",
        "route_description": "Knowledge base operations",
        "route_context": "Indexing, vector search, embedding, chunking. Knowledge base integration."
    },
    {
        "route_name": "memory",
        "route_description": "Persistent memory management",
        "route_context": "Store, retrieve, search, habit tracking. User preference management."
    },
    {
        "route_name": "system_agent",
        "route_description": "Operating system control",
        "route_context": "Windows registry, processes, network config, system operations. Requires elevated permissions."
    },
    {
        "route_name": "teacher",
        "route_description": "Educational assistance",
        "route_context": "Explanation generation, quiz creation, assessment, curriculum building."
    },
    {
        "route_name": "creative",
        "route_description": "Multimodal content generation with tools",
        "route_context": "Image generation, video creation, audio synthesis, template rendering. Requires generation tools."
    },
    {
        "route_name": "gui_control",
        "route_description": "Application automation",
        "route_context": "GUI interaction, window management, application automation. Visual understanding needed."
    },

    # Multi-agent orchestration routes
    {
        "route_name": "multi_domain",
        "route_description": "Multi-domain orchestration with planning",
        "route_context": "Multiple domains or context-isolated parallel work. Requires planning and coordination."
    },
    {
        "route_name": "iterative",
        "route_description": "Iterative refinement with evaluation loops",
        "route_context": "Generate-evaluate-refine cycles. Self-critique or multi-agent evaluation until quality threshold met."
    }
]

ROUTE_MODEL_MAP = {
    # Capability-based (no tools)
    "creative_writing": "gemini-2.5-pro",  # Creative tasks benefit from stronger model
    "math_reasoning": "gemini-2.5-pro",     # Math requires strong reasoning
    "code_reasoning": "gemini-2.5-pro",     # Code analysis needs strong model
    "visual_reasoning": "gemini-2.5-flash", # Vision tasks, flash supports multimodal
    "general_conversation": "gemini-2.5-flash", # General queries can use fast model

    # Execution modes (tools needed)
    "direct": "gemini-2.5-flash",           # FastPath optimization, quick execution

    # Single domains
    "searcher": "gemini-2.5-flash",         # Research with iteration
    "coder": "gemini-2.5-pro",              # Code generation needs strong model
    "web_controller": "gemini-2.5-flash",   # Browser automation
    "data_ops": "gemini-2.5-flash",         # Data operations can use fast model
    "rag": "gemini-2.5-flash",              # RAG operations optimized for speed
    "memory": "gemini-2.5-flash",           # Memory operations are straightforward
    "system_agent": "gemini-2.5-flash",     # System operations
    "teacher": "gemini-2.5-pro",            # Educational content needs quality
    "creative": "gemini-2.5-pro",           # Creative generation with tools
    "gui_control": "gemini-2.5-flash",      # GUI automation

    # Multi-agent orchestration
    "multi_domain": "gemini-2.5-flash",     # Planning uses fast model, agents use their own
    "iterative": "gemini-2.5-pro"           # Refinement benefits from strong evaluation
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


    TOKEN_COUNTING_METHODS = {
        "gemini": "native",
        "groq": "tiktoken",
        "openrouter": "tiktoken",
        "cerebras": "tiktoken",
        "huggingface": "fallback"
    }

    TIKTOKEN_ENCODING = "cl100k_base"

    FALLBACK_CHARS_PER_TOKEN = 4

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

    @classmethod
    def get_token_counting_method(cls, provider: str) -> str:
        """
        Get the token counting method for a provider.

        Args:
            provider: Provider name

        Returns:
            Token counting method: 'native', 'tiktoken', or 'fallback'
        """
        return cls.TOKEN_COUNTING_METHODS.get(provider, "fallback")

    @classmethod
    def get_tiktoken_encoding(cls) -> str:
        """Get the tiktoken encoding name to use."""
        return cls.TIKTOKEN_ENCODING

    @classmethod
    def get_fallback_chars_per_token(cls) -> int:
        """Get the character-to-token ratio for fallback counting."""
        return cls.FALLBACK_CHARS_PER_TOKEN

    @classmethod
    def get_router_provider(cls) -> str:
        """Get the provider used for router model."""
        router_model = cls.get_router_model()
        return infer_provider_from_model(router_model)