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
) -> Dict[str, Any]:
    provider_instance = provider_map.get(provider_name)

    provider_limits = Config.get_rate_limit_config(provider=provider_name)
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
        model_overrides = (
            model_overrides_map.get(model_id, {}) if isinstance(model_overrides_map, dict) else {}
        )

        models.append(
            {
                "id": model_id,
                "display_name": display_name,
                "limits": _serialize_limits(model_limits),
                "overrides": _serialize_limits(model_overrides),
            }
        )

    models.sort(key=lambda item: item["id"])

    return {
        "id": provider_name,
        "display_name": provider_name.title(),
        "limits": _serialize_limits(provider_limits),
        "overrides": _serialize_limits(provider_limits_override),
        "models": models,
    }


@rate_limit_bp.get("")
def get_rate_limits():
    overrides_snapshot = get_rate_limit_overrides()

    provider_map = get_provider_map()
    providers = [
        _build_provider_entry(provider_name, provider_map, overrides_snapshot)
        for provider_name in sorted(provider_map.keys())
    ]

    response = {
        "global": {
            "limits": _serialize_limits(Config.get_rate_limit_config()),
            "overrides": _serialize_limits(overrides_snapshot.get("global", {})),
        },
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

    updated_limits = persist_rate_limit_override(provider, model, normalized_limits)

    return jsonify(
        {
            "success": True,
            "scope": scope,
            "provider": provider,
            "model": model,
            "limits": _serialize_limits(updated_limits),
        }
    )


def register_rate_limit_routes(app) -> None:
    app.register_blueprint(rate_limit_bp)
