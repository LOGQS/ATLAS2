# status: complete

import copy
import json
import os
import threading
from typing import Any, Dict, Optional

from utils.logger import get_logger

logger = get_logger(__name__)


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
        "route_name": "web_researcher",
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
        "route_name": "data_processor",
        "route_description": "Data transformation and API operations",
        "route_context": "JSON/CSV/SQL operations, API calls, data validation, format conversion."
    },
    {
        "route_name": "memory",
        "route_description": "Persistent memory management",
        "route_context": "Store, retrieve, search, habit tracking. User preference management."
    },
    {
        "route_name": "system_manager",
        "route_description": "Operating system control",
        "route_context": "Windows registry, processes, network config, system operations. Requires elevated permissions."
    },
    {
        "route_name": "teacher",
        "route_description": "Educational assistance",
        "route_context": "Explanation generation, quiz creation, assessment, curriculum building."
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
    "creative_writing": "moonshotai/kimi-k2-instruct-0905",  # Creative tasks benefit from stronger model
    "math_reasoning": "gemini-2.5-pro",     # Math requires strong reasoning
    "code_reasoning": "gemini-2.5-pro",     # Code analysis needs strong model
    "visual_reasoning": "gemini-2.5-flash-preview-09-2025", # Vision tasks, flash supports multimodal
    "general_conversation": "gemini-2.5-flash-preview-09-2025", # General queries can use fast model

    # Execution modes (tools needed)
    "direct": "gemini-2.5-flash-preview-09-2025",           # FastPath optimization, quick execution

    # Single domains
    "web_researcher": "gemini-2.5-flash-preview-09-2025",   # Research with iteration
    "coder": "gemini-2.5-flash-preview-09-2025",              # Code generation needs strong model
    "web_controller": "gemini-2.5-flash-preview-09-2025",   # Browser automation
    "data_processor": "gemini-2.5-flash-preview-09-2025",   # Data operations can use fast model
    "memory": "gemini-2.5-flash-preview-09-2025",           # Memory operations are straightforward
    "system_manager": "gemini-2.5-flash-preview-09-2025",   # System operations
    "teacher": "gemini-2.5-pro",            # Educational content needs quality
    "gui_control": "gemini-2.5-flash-preview-09-2025",      # GUI automation

    # Multi-agent orchestration
    "multi_domain": "gemini-2.5-flash-preview-09-2025",     # Planning uses fast model, agents use their own
    "iterative": "gemini-2.5-pro"           # Refinement benefits from strong evaluation
}

# Embedding model mapping for RAG tools
EMBEDDING_MODEL_MAP = {
    "fast": "intfloat/e5-small-v2",           # ~33MB, 384-dim, faster inference
    "slow": "Alibaba-NLP/gte-multilingual-base",  # ~305MB, 768-dim, SOTA multilingual, 8192 ctx
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

    DEFAULT_MODEL = "gemini-2.5-flash-preview-09-2025"

    DEFAULT_ROUTER_ENABLED = True
    DEFAULT_ROUTER_MODEL = "gemini-2.5-flash-lite"

    DEFAULT_STREAMING = True

    RATE_LIMIT_REQUESTS_PER_MINUTE: Optional[int] = None
    RATE_LIMIT_REQUESTS_PER_HOUR: Optional[int] = None
    RATE_LIMIT_REQUESTS_PER_DAY: Optional[int] = None
    RATE_LIMIT_TOKENS_PER_MINUTE: Optional[int] = None
    RATE_LIMIT_TOKENS_PER_HOUR: Optional[int] = None
    RATE_LIMIT_TOKENS_PER_DAY: Optional[int] = None
    RATE_LIMIT_BURST_SIZE: Optional[int] = None
    PROVIDER_DEFAULT_OPTIONS: Dict[str, Dict[str, Any]] = {}
    MODEL_DEFAULT_OPTIONS: Dict[str, Dict[str, Dict[str, Any]]] = {}
    _RATE_LIMIT_FIELDS = (
        "requests_per_minute",
        "requests_per_hour",
        "requests_per_day",
        "tokens_per_minute",
        "tokens_per_hour",
        "tokens_per_day",
        "burst_size",
    )
    _rate_limit_lock = threading.RLock()
    _rate_limit_sources: Dict[str, Dict[str, str]] = {}  # Maps scope_key -> {field -> source}

    STT_USE_CLOUD = True
    STT_PROVIDER = "groq"
    STT_MODEL = "whisper-large-v3-turbo"

    WORKER_POOL_SIZE = 4
    WORKER_MAX_PARALLEL_SPAWN = 5
    WORKER_INIT_TIMEOUT = 40.0
    WORKER_SPAWN_RETRY_DELAY = 1.0
    WORKER_SPAWN_RETRY_DELAY_MAX = 8.0
    WORKER_SLOW_START_THRESHOLD = 12.0


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
    def _env_slug(cls, value: str) -> str:
        """Transform provider/model ids into env-safe tokens."""
        return "".join(ch if ch.isalnum() else "_" for ch in value.upper())

    @classmethod
    def _load_json_env(cls, env_key: str) -> Dict[str, Any]:
        """Parse JSON options from environment variables."""
        raw = os.getenv(env_key)
        if not raw:
            return {}
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                return data
            logger.warning("Ignoring non-dict options for %s", env_key)
        except json.JSONDecodeError:
            logger.warning("Failed to decode JSON for %s", env_key, exc_info=True)
        return {}

    @classmethod
    def _get_scope_key(cls, provider: Optional[str] = None, model: Optional[str] = None) -> str:
        """Generate a unique key for tracking rate limit sources."""
        if provider and model:
            return f"model:{provider}:{model}"
        elif provider:
            return f"provider:{provider}"
        return "global"

    @classmethod
    def _record_rate_limit_source(
        cls,
        provider: Optional[str],
        model: Optional[str],
        field: str,
        source: str
    ) -> None:
        """Record the source of a rate limit value."""
        scope_key = cls._get_scope_key(provider, model)
        if scope_key not in cls._rate_limit_sources:
            cls._rate_limit_sources[scope_key] = {}
        cls._rate_limit_sources[scope_key][field] = source

    @classmethod
    def get_rate_limit_sources(
        cls,
        provider: Optional[str] = None,
        model: Optional[str] = None
    ) -> Dict[str, str]:
        """
        Get the source information for rate limit values.
        Returns a dict mapping field names to their sources ('env', 'file', 'default').
        """
        scope_key = cls._get_scope_key(provider, model)
        return cls._rate_limit_sources.get(scope_key, {}).copy()

    @staticmethod
    def _coerce_positive_int(value: Any) -> Optional[int]:
        """Convert value to positive int, returning None on failure."""
        try:
            number = int(value)
        except (TypeError, ValueError):
            return None
        return number if number > 0 else None

    @staticmethod
    def _coerce_non_negative_int(value: Any) -> Optional[int]:
        """Convert value to non-negative int, returning None on failure."""
        try:
            number = int(value)
        except (TypeError, ValueError):
            return None
        return number if number >= 0 else None

    @classmethod
    def _deep_merge(cls, base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
        """Recursively merge dictionaries without mutating inputs."""
        merged = copy.deepcopy(base)
        for key, value in (override or {}).items():
            if (
                key in merged
                and isinstance(merged[key], dict)
                and isinstance(value, dict)
            ):
                merged[key] = cls._deep_merge(merged[key], value)
            else:
                merged[key] = copy.deepcopy(value)
        return merged

    @classmethod
    def _sanitize_rate_limit_dict(cls, limits: Dict[str, Any]) -> Dict[str, Optional[int]]:
        """Return sanitized rate limit dictionary containing only known fields."""
        sanitized: Dict[str, Optional[int]] = {}
        for field in cls._RATE_LIMIT_FIELDS:
            raw_value = limits.get(field)
            if raw_value is None or raw_value == "":
                sanitized[field] = None
                continue

            if field == "burst_size":
                coerced = cls._coerce_non_negative_int(raw_value)
            else:
                coerced = cls._coerce_positive_int(raw_value)

            sanitized[field] = coerced

        rpm = sanitized.get("requests_per_minute")
        burst = sanitized.get("burst_size")
        if rpm is not None and burst is not None:
            sanitized["burst_size"] = min(burst, rpm)
        return sanitized

    @classmethod
    def _get_global_rate_limit_config(cls) -> Dict[str, Optional[int]]:
        """Return global rate limit settings with environment overrides."""
        # Track which fields come from .env
        env_values = {
            "requests_per_minute": cls._coerce_positive_int(
                os.getenv("ATLAS_RATE_LIMIT_REQUESTS_PER_MINUTE")
            ),
            "requests_per_hour": cls._coerce_positive_int(
                os.getenv("ATLAS_RATE_LIMIT_REQUESTS_PER_HOUR")
            ),
            "requests_per_day": cls._coerce_positive_int(
                os.getenv("ATLAS_RATE_LIMIT_REQUESTS_PER_DAY")
            ),
            "tokens_per_minute": cls._coerce_positive_int(
                os.getenv("ATLAS_RATE_LIMIT_TOKENS_PER_MINUTE")
            ),
            "tokens_per_hour": cls._coerce_positive_int(
                os.getenv("ATLAS_RATE_LIMIT_TOKENS_PER_HOUR")
            ),
            "tokens_per_day": cls._coerce_positive_int(
                os.getenv("ATLAS_RATE_LIMIT_TOKENS_PER_DAY")
            ),
            "burst_size": cls._coerce_non_negative_int(
                os.getenv("ATLAS_RATE_LIMIT_BURST_SIZE")
            ),
        }

        raw_limits = {
            "requests_per_minute": env_values["requests_per_minute"] or cls.RATE_LIMIT_REQUESTS_PER_MINUTE,
            "requests_per_hour": env_values["requests_per_hour"] or cls.RATE_LIMIT_REQUESTS_PER_HOUR,
            "requests_per_day": env_values["requests_per_day"] or cls.RATE_LIMIT_REQUESTS_PER_DAY,
            "tokens_per_minute": env_values["tokens_per_minute"] or cls.RATE_LIMIT_TOKENS_PER_MINUTE,
            "tokens_per_hour": env_values["tokens_per_hour"] or cls.RATE_LIMIT_TOKENS_PER_HOUR,
            "tokens_per_day": env_values["tokens_per_day"] or cls.RATE_LIMIT_TOKENS_PER_DAY,
            "burst_size": env_values["burst_size"] if env_values["burst_size"] is not None else cls.RATE_LIMIT_BURST_SIZE,
        }

        # Record sources for each field
        for field in cls._RATE_LIMIT_FIELDS:
            if env_values.get(field) is not None:
                cls._record_rate_limit_source(None, None, field, "env")
            else:
                cls._record_rate_limit_source(None, None, field, "default")

        return cls._sanitize_rate_limit_dict(raw_limits)

    @classmethod
    def _get_global_options(cls) -> Dict[str, Any]:
        """Base options that apply to every provider/model."""
        return {
            "rate_limit": cls._get_global_rate_limit_config()
        }

    @classmethod
    def _get_provider_specific_options(cls, provider: str) -> Dict[str, Any]:
        """Default and environment options for a provider."""
        if not provider:
            return {}

        defaults = cls.PROVIDER_DEFAULT_OPTIONS.get(provider, {})
        env_key = f"ATLAS_PROVIDER_OPTIONS_{cls._env_slug(provider)}"
        env_options = cls._load_json_env(env_key)
        merged = cls._deep_merge(defaults, env_options)

        # Track sources for provider rate limits
        if "rate_limit" in env_options:
            env_rate_limits = env_options["rate_limit"]
            for field in cls._RATE_LIMIT_FIELDS:
                if field in env_rate_limits:
                    cls._record_rate_limit_source(provider, None, field, "env")

        if "rate_limit" in merged:
            merged["rate_limit"] = cls._sanitize_rate_limit_dict(merged["rate_limit"])
        return merged

    @classmethod
    def _get_model_specific_options(cls, provider: Optional[str], model: str) -> Dict[str, Any]:
        """Default and environment options for a model."""
        if not model:
            return {}

        defaults: Dict[str, Any] = {}
        if provider:
            defaults = cls.MODEL_DEFAULT_OPTIONS.get(provider, {}).get(model, {})
        else:
            for provider_models in cls.MODEL_DEFAULT_OPTIONS.values():
                if model in provider_models:
                    defaults = provider_models[model]
                    break

        env_parts = ["ATLAS_MODEL_OPTIONS"]
        if provider:
            env_parts.append(cls._env_slug(provider))
        env_parts.append(cls._env_slug(model))
        env_key = "_".join(env_parts)
        env_options = cls._load_json_env(env_key)
        merged = cls._deep_merge(defaults, env_options)

        # Track sources for model rate limits
        if "rate_limit" in env_options:
            env_rate_limits = env_options["rate_limit"]
            for field in cls._RATE_LIMIT_FIELDS:
                if field in env_rate_limits:
                    cls._record_rate_limit_source(provider, model, field, "env")

        if "rate_limit" in merged:
            merged["rate_limit"] = cls._sanitize_rate_limit_dict(merged["rate_limit"])
        return merged

    @classmethod
    def get_options(cls, provider: Optional[str] = None, model: Optional[str] = None) -> Dict[str, Any]:
        """Return merged options for the given provider/model hierarchy."""
        options = copy.deepcopy(cls._get_global_options())

        if provider:
            provider_options = cls._get_provider_specific_options(provider)
            options = cls._deep_merge(options, provider_options)

        if model:
            model_options = cls._get_model_specific_options(provider, model)
            options = cls._deep_merge(options, model_options)

        options["rate_limit"] = cls._sanitize_rate_limit_dict(options.get("rate_limit", {}))
        return options

    @classmethod
    def get_provider_options(cls, provider: str) -> Dict[str, Any]:
        """Options effective for the given provider."""
        return cls.get_options(provider=provider)

    @classmethod
    def get_model_options(cls, provider: str, model: str) -> Dict[str, Any]:
        """Options effective for the given provider/model combination."""
        return cls.get_options(provider=provider, model=model)

    @classmethod
    def set_rate_limit_override(
        cls,
        provider: Optional[str],
        model: Optional[str],
        limits: Optional[Dict[str, Any]],
        check_env_conflicts: bool = False
    ) -> Dict[str, Optional[int]]:
        """
        Set or clear rate limit overrides for a provider/model combination.

        Passing a limits dict with all values set to None removes the override.
        If check_env_conflicts is True, raises ValueError if trying to override .env values.
        """
        sanitized = cls._sanitize_rate_limit_dict(limits or {})
        has_limit = any(value is not None for value in sanitized.values())

        # Check for conflicts with .env values if requested
        if check_env_conflicts and has_limit:
            sources = cls.get_rate_limit_sources(provider, model)
            env_conflicts = [
                field for field, source in sources.items()
                if source == "env" and field in sanitized and sanitized[field] is not None
            ]
            if env_conflicts:
                raise ValueError(
                    f"Cannot override .env values for fields: {', '.join(env_conflicts)}"
                )

        with cls._rate_limit_lock:
            if provider and model:
                provider_models = cls.MODEL_DEFAULT_OPTIONS.setdefault(provider, {})
                if not has_limit:
                    existing = provider_models.get(model)
                    if existing and "rate_limit" in existing:
                        existing.pop("rate_limit", None)
                    if existing is not None and not existing:
                        provider_models.pop(model, None)
                    if not provider_models:
                        cls.MODEL_DEFAULT_OPTIONS.pop(provider, None)
                else:
                    entry = provider_models.setdefault(model, {})
                    entry["rate_limit"] = sanitized
                    # Record source as 'file' for non-.env fields
                    sources = cls.get_rate_limit_sources(provider, model)
                    for field in cls._RATE_LIMIT_FIELDS:
                        if field in sanitized and sources.get(field) != "env":
                            cls._record_rate_limit_source(provider, model, field, "file")
            elif provider:
                if not has_limit:
                    existing = cls.PROVIDER_DEFAULT_OPTIONS.get(provider)
                    if existing and "rate_limit" in existing:
                        existing.pop("rate_limit", None)
                    if existing is not None and not existing:
                        cls.PROVIDER_DEFAULT_OPTIONS.pop(provider, None)
                else:
                    entry = cls.PROVIDER_DEFAULT_OPTIONS.setdefault(provider, {})
                    entry["rate_limit"] = sanitized
                    # Record source as 'file' for non-.env fields
                    sources = cls.get_rate_limit_sources(provider, None)
                    for field in cls._RATE_LIMIT_FIELDS:
                        if field in sanitized and sources.get(field) != "env":
                            cls._record_rate_limit_source(provider, None, field, "file")
            else:
                # Update global defaults
                if not has_limit:
                    # Reset to class defaults
                    cls.RATE_LIMIT_REQUESTS_PER_MINUTE = 10
                    cls.RATE_LIMIT_REQUESTS_PER_HOUR = None
                    cls.RATE_LIMIT_REQUESTS_PER_DAY = None
                    cls.RATE_LIMIT_TOKENS_PER_MINUTE = None
                    cls.RATE_LIMIT_TOKENS_PER_HOUR = None
                    cls.RATE_LIMIT_TOKENS_PER_DAY = None
                    cls.RATE_LIMIT_BURST_SIZE = 10
                else:
                    cls.RATE_LIMIT_REQUESTS_PER_MINUTE = sanitized.get("requests_per_minute") or cls.RATE_LIMIT_REQUESTS_PER_MINUTE
                    cls.RATE_LIMIT_REQUESTS_PER_HOUR = sanitized.get("requests_per_hour")
                    cls.RATE_LIMIT_REQUESTS_PER_DAY = sanitized.get("requests_per_day")
                    cls.RATE_LIMIT_TOKENS_PER_MINUTE = sanitized.get("tokens_per_minute")
                    cls.RATE_LIMIT_TOKENS_PER_HOUR = sanitized.get("tokens_per_hour")
                    cls.RATE_LIMIT_TOKENS_PER_DAY = sanitized.get("tokens_per_day")
                    cls.RATE_LIMIT_BURST_SIZE = sanitized.get("burst_size") or cls.RATE_LIMIT_BURST_SIZE
                    # Record source as 'file' for non-.env fields
                    sources = cls.get_rate_limit_sources(None, None)
                    for field in cls._RATE_LIMIT_FIELDS:
                        if field in sanitized and sources.get(field) != "env":
                            cls._record_rate_limit_source(None, None, field, "file")

        return cls.get_rate_limit_config(provider=provider, model=model)

    @classmethod
    def get_rate_limit_config(cls, provider: Optional[str] = None, model: Optional[str] = None) -> Dict[str, Optional[int]]:
        """Return the effective rate limit configuration."""
        options = cls.get_options(provider=provider, model=model)
        rate_options = options.get("rate_limit", {}) if isinstance(options.get("rate_limit"), dict) else {}

        merged = dict(cls._get_global_rate_limit_config())
        for field in cls._RATE_LIMIT_FIELDS:
            if field in rate_options:
                merged[field] = rate_options[field]

        return cls._sanitize_rate_limit_dict(merged)

    @classmethod
    def get_rate_limit_keys_to_check(cls, provider: str, model: str) -> list:
        """
        Returns list of (key, config) tuples for all scopes that should be checked.
        Only includes scopes that have actual limits defined.

        Args:
            provider: Provider name (e.g., "gemini")
            model: Model name (e.g., "gemini-2.5-flash")

        Returns:
            List of (key_string, config_dict) tuples in order of specificity
        """
        keys_and_configs = []

        # Always check model-specific limits
        model_config = cls.get_rate_limit_config(provider=provider, model=model)
        keys_and_configs.append((f"{provider}:{model}", model_config))

        # Check provider limits if any are defined
        provider_config = cls.get_rate_limit_config(provider=provider)
        if any(v is not None for v in provider_config.values()):
            keys_and_configs.append((provider, provider_config))

        # Check global limits if any are defined
        global_config = cls.get_rate_limit_config()
        if any(v is not None for v in global_config.values()):
            keys_and_configs.append(("global", global_config))

        return keys_and_configs

    @classmethod
    def get_rate_limit_requests_per_minute(cls, provider: Optional[str] = None, model: Optional[str] = None) -> int:
        """Get rate limit requests per minute."""
        config = cls.get_rate_limit_config(provider=provider, model=model)
        rpm = config.get("requests_per_minute")
        if rpm is None:
            return cls.RATE_LIMIT_REQUESTS_PER_MINUTE or 0
        return rpm
    
    @classmethod
    def get_rate_limit_burst_size(cls, provider: Optional[str] = None, model: Optional[str] = None) -> int:
        """Get rate limit burst size."""
        config = cls.get_rate_limit_config(provider=provider, model=model)
        burst = config.get("burst_size")
        if burst is None:
            fallback = cls.RATE_LIMIT_BURST_SIZE
            if isinstance(fallback, int):
                return fallback
            return config.get("requests_per_minute") or 0
        return burst

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
        rate_limit_defaults = cls.get_rate_limit_config()
        return {
            "provider": cls.get_default_provider(),
            "model": cls.DEFAULT_MODEL,
            "streaming": cls.DEFAULT_STREAMING,
            "rate_limit_requests_per_minute": rate_limit_defaults["requests_per_minute"],
            "rate_limit_requests_per_hour": rate_limit_defaults["requests_per_hour"],
            "rate_limit_requests_per_day": rate_limit_defaults["requests_per_day"],
            "rate_limit_tokens_per_minute": rate_limit_defaults["tokens_per_minute"],
            "rate_limit_tokens_per_hour": rate_limit_defaults["tokens_per_hour"],
            "rate_limit_tokens_per_day": rate_limit_defaults["tokens_per_day"],
            "rate_limit_burst_size": rate_limit_defaults["burst_size"],
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
    def get_worker_spawn_retry_delay(cls) -> float:
        """Get base delay before retrying a failed worker spawn."""
        return cls.WORKER_SPAWN_RETRY_DELAY

    @classmethod
    def get_worker_spawn_retry_delay_max(cls) -> float:
        """Get maximum delay before retrying a failed worker spawn."""
        return cls.WORKER_SPAWN_RETRY_DELAY_MAX

    @classmethod
    def get_worker_slow_start_threshold(cls) -> float:
        """Get threshold (seconds) for logging slow worker startups."""
        return cls.WORKER_SLOW_START_THRESHOLD

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
