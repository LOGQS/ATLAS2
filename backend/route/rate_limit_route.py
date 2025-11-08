# status: complete

from __future__ import annotations

from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request

from utils.config import Config, get_provider_map
from utils.logger import get_logger
from utils.rate_limit_store import (
    get_rate_limit_overrides,
    persist_rate_limit_override,
)
from chat.chat import broadcast_config_reload
from utils.rate_limiter import get_rate_limiter

logger = get_logger(__name__)

rate_limit_bp = Blueprint("rate_limits", __name__, url_prefix="/api/rate-limits")

_LIMIT_FIELDS = {
    "requests_per_minute",
    "requests_per_hour",
    "requests_per_day",
    "tokens_per_minute",
    "tokens_per_hour",
    "tokens_per_day",
    "burst_size",
}

_ALIAS_TO_FIELD = {
    "rpm": "requests_per_minute",
    "rph": "requests_per_hour",
    "rpd": "requests_per_day",
    "tpm": "tokens_per_minute",
    "tph": "tokens_per_hour",
    "tpd": "tokens_per_day",
    "burst": "burst_size",
}


def _serialize_limits(raw: Dict[str, Any]) -> Dict[str, Optional[int]]:
    return {
        "requests_per_minute": raw.get("requests_per_minute"),
        "requests_per_hour": raw.get("requests_per_hour"),
        "requests_per_day": raw.get("requests_per_day"),
        "tokens_per_minute": raw.get("tokens_per_minute"),
        "tokens_per_hour": raw.get("tokens_per_hour"),
        "tokens_per_day": raw.get("tokens_per_day"),
        "burst_size": raw.get("burst_size"),
    }


def _serialize_sources(sources: Dict[str, str]) -> Dict[str, str]:
    """Convert internal source dict to API response format."""
    return {
        "requests_per_minute": sources.get("requests_per_minute", "default"),
        "requests_per_hour": sources.get("requests_per_hour", "default"),
        "requests_per_day": sources.get("requests_per_day", "default"),
        "tokens_per_minute": sources.get("tokens_per_minute", "default"),
        "tokens_per_hour": sources.get("tokens_per_hour", "default"),
        "tokens_per_day": sources.get("tokens_per_day", "default"),
        "burst_size": sources.get("burst_size", "default"),
    }


def _has_any_limits(limits: Dict[str, Optional[int]]) -> bool:
    """Check if any rate limits are defined (not None) for this scope."""
    return any(v is not None for v in limits.values())


def _aggregate_usage_for_scope(all_usage: Dict[str, Dict[str, Any]], scope_filter: Optional[str] = None) -> Dict[str, Any]:
    """
    Aggregate usage data for a specific scope.

    Args:
        all_usage: Dict mapping rate limiter key -> usage data
        scope_filter: Optional prefix filter (e.g., "gemini", "gemini:model-name")

    Returns:
        Dict with aggregated usage including counts and expiration timestamps
    """
    import time

    now = time.time()

    aggregated = {
        "requests_per_minute": 0,
        "requests_per_hour": 0,
        "requests_per_day": 0,
        "tokens_per_minute": 0,
        "tokens_per_hour": 0,
        "tokens_per_day": 0,
        "expires_at": {},
    }

    for key, usage_data in all_usage.items():
        # Apply scope filter if provided
        if scope_filter is not None and not key.startswith(scope_filter):
            continue

        requests = usage_data.get("requests", {})
        tokens = usage_data.get("tokens", {})
        expires_at = usage_data.get("expires_at", {})

        # Only include counts if window hasn't expired (now < expires_at)

        # Requests per minute
        if expires_at.get("requests_minute") and now < expires_at["requests_minute"]:
            aggregated["requests_per_minute"] += requests.get("minute", 0)
            # Track earliest expiration
            current = aggregated["expires_at"].get("requests_minute")
            if current is None or expires_at["requests_minute"] < current:
                aggregated["expires_at"]["requests_minute"] = expires_at["requests_minute"]

        # Requests per hour
        if expires_at.get("requests_hour") and now < expires_at["requests_hour"]:
            aggregated["requests_per_hour"] += requests.get("hour", 0)
            current = aggregated["expires_at"].get("requests_hour")
            if current is None or expires_at["requests_hour"] < current:
                aggregated["expires_at"]["requests_hour"] = expires_at["requests_hour"]

        # Requests per day
        if expires_at.get("requests_day") and now < expires_at["requests_day"]:
            aggregated["requests_per_day"] += requests.get("day", 0)
            current = aggregated["expires_at"].get("requests_day")
            if current is None or expires_at["requests_day"] < current:
                aggregated["expires_at"]["requests_day"] = expires_at["requests_day"]

        # Tokens per minute
        if expires_at.get("tokens_minute") and now < expires_at["tokens_minute"]:
            aggregated["tokens_per_minute"] += tokens.get("minute", 0)
            current = aggregated["expires_at"].get("tokens_minute")
            if current is None or expires_at["tokens_minute"] < current:
                aggregated["expires_at"]["tokens_minute"] = expires_at["tokens_minute"]

        # Tokens per hour
        if expires_at.get("tokens_hour") and now < expires_at["tokens_hour"]:
            aggregated["tokens_per_hour"] += tokens.get("hour", 0)
            current = aggregated["expires_at"].get("tokens_hour")
            if current is None or expires_at["tokens_hour"] < current:
                aggregated["expires_at"]["tokens_hour"] = expires_at["tokens_hour"]

        # Tokens per day
        if expires_at.get("tokens_day") and now < expires_at["tokens_day"]:
            aggregated["tokens_per_day"] += tokens.get("day", 0)
            current = aggregated["expires_at"].get("tokens_day")
            if current is None or expires_at["tokens_day"] < current:
                aggregated["expires_at"]["tokens_day"] = expires_at["tokens_day"]

    return aggregated


def _normalize_limits_payload(limits: Dict[str, Any]) -> Dict[str, Optional[int]]:
    normalized: Dict[str, Optional[int]] = {}
    for key, value in (limits or {}).items():
        field = _ALIAS_TO_FIELD.get(key, key)
        if field not in _LIMIT_FIELDS:
            continue

        if value in (None, "", "null"):
            normalized[field] = None
            continue

        try:
            normalized[field] = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Invalid integer for {field}: {value}") from exc

    return normalized


def _build_provider_entry(
    provider_name: str,
    provider_map: Dict[str, Any],
    overrides_snapshot: Dict[str, Any],
    all_usage: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    provider_instance = provider_map.get(provider_name)

    provider_limits = Config.get_rate_limit_config(provider=provider_name)
    provider_sources = Config.get_rate_limit_sources(provider=provider_name)
    provider_overrides = overrides_snapshot.get("providers", {}).get(provider_name, {})
    provider_limits_override = (
        provider_overrides.get("limits", {}) if isinstance(provider_overrides, dict) else {}
    )

    models: list[Dict[str, Any]] = []
    available_models: Dict[str, Any] = {}
    if provider_instance:
        try:
            model_data = provider_instance.get_available_models()
            if isinstance(model_data, dict):
                available_models = model_data
        except Exception as exc:
            logger.warning("Failed to list models for provider %s: %s", provider_name, exc)

    model_overrides_map = {}
    if isinstance(provider_overrides, dict):
        model_overrides_map = provider_overrides.get("models", {})

    for model_id, model_info in available_models.items():
        display_name = model_id
        if isinstance(model_info, dict):
            display_name = model_info.get("name", model_id)
        model_limits = Config.get_rate_limit_config(provider=provider_name, model=model_id)
        model_sources = Config.get_rate_limit_sources(provider=provider_name, model=model_id)
        model_overrides = (
            model_overrides_map.get(model_id, {}) if isinstance(model_overrides_map, dict) else {}
        )

        # Aggregate usage for this specific model
        model_usage = _aggregate_usage_for_scope(all_usage, f"{provider_name}:{model_id}")

        models.append(
            {
                "id": model_id,
                "display_name": display_name,
                "limits": _serialize_limits(model_limits),
                "overrides": _serialize_limits(model_overrides),
                "sources": _serialize_sources(model_sources),
                "usage": model_usage,
            }
        )

    models.sort(key=lambda item: item["id"])

    # Only include usage if provider has limits defined
    result = {
        "id": provider_name,
        "display_name": provider_name.title(),
        "limits": _serialize_limits(provider_limits),
        "overrides": _serialize_limits(provider_limits_override),
        "sources": _serialize_sources(provider_sources),
        "models": models,
    }

    if _has_any_limits(provider_limits):
        provider_usage = _aggregate_usage_for_scope(all_usage, provider_name)
        result["usage"] = provider_usage

    return result


@rate_limit_bp.get("")
def get_rate_limits():
    overrides_snapshot = get_rate_limit_overrides()
    limiter = get_rate_limiter()
    all_usage = limiter.get_all_usage()

    provider_map = get_provider_map()
    providers = [
        _build_provider_entry(provider_name, provider_map, overrides_snapshot, all_usage)
        for provider_name in sorted(provider_map.keys())
    ]

    global_sources = Config.get_rate_limit_sources()
    global_limits = Config.get_rate_limit_config()

    global_data = {
        "limits": _serialize_limits(global_limits),
        "overrides": _serialize_limits(overrides_snapshot.get("global", {})),
        "sources": _serialize_sources(global_sources),
    }

    # Only include usage if global has limits defined
    if _has_any_limits(global_limits):
        global_usage = _aggregate_usage_for_scope(all_usage)  # No filter = all keys
        global_data["usage"] = global_usage

    response = {
        "global": global_data,
        "providers": providers,
    }

    return jsonify(response)


@rate_limit_bp.post("")
def update_rate_limits():
    payload = request.get_json(silent=True) or {}
    scope = (payload.get("scope") or "provider").lower()
    provider = payload.get("provider")
    model = payload.get("model")
    limits_payload = payload.get("limits", {})

    try:
        normalized_limits = _normalize_limits_payload(limits_payload)
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400

    if scope == "global":
        provider = None
        model = None
    elif scope == "provider":
        if not provider:
            return (
                jsonify({"success": False, "error": "provider is required for provider scope"}),
                400,
            )
        model = None
    elif scope == "model":
        if not provider or not model:
            return (
                jsonify({"success": False, "error": "provider and model are required for model scope"}),
                400,
            )
    else:
        return jsonify({"success": False, "error": f"Unknown scope '{scope}'"}), 400

    provider_map = get_provider_map()
    if provider and provider not in provider_map:
        return jsonify({"success": False, "error": f"Provider '{provider}' not found"}), 404

    # Check for conflicts with .env values
    try:
        updated_limits = persist_rate_limit_override(provider, model, normalized_limits)
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 409

    reload_result = broadcast_config_reload()
    logger.info(f"Config reload broadcast: {reload_result['success_count']}/{reload_result['total']} workers updated")

    return jsonify(
        {
            "success": True,
            "scope": scope,
            "provider": provider,
            "model": model,
            "limits": _serialize_limits(updated_limits),
            "workers_reloaded": reload_result['success_count'],
            "workers_failed": reload_result['failure_count'],
        }
    )


def register_rate_limit_routes(app) -> None:
    app.register_blueprint(rate_limit_bp)
