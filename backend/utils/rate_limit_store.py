# status: complete

import json
import threading
from pathlib import Path
from typing import Any, Dict, Optional

from utils.config import Config
from utils.logger import get_logger

logger = get_logger(__name__)

_STORE_LOCK = threading.RLock()
_DATA_DIR = Path(__file__).resolve().parents[2] / "data"
_STORE_PATH = _DATA_DIR / "rate_limits.json"

_CACHE: Dict[str, Any] = {}


def _ensure_data_dir() -> None:
    if not _DATA_DIR.exists():
        _DATA_DIR.mkdir(parents=True, exist_ok=True)


def _load_from_disk() -> Dict[str, Any]:
    if not _STORE_PATH.exists():
        return {}
    try:
        with _STORE_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
            if isinstance(data, dict):
                return data
    except Exception as exc:
        logger.warning("Failed to load rate limit overrides: %s", exc)
    return {}


def _write_to_disk(data: Dict[str, Any]) -> None:
    _ensure_data_dir()
    try:
        with _STORE_PATH.open("w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
    except Exception as exc:
        logger.error("Failed to persist rate limit overrides: %s", exc)


def _prune_limits(limits: Dict[str, Optional[int]]) -> Dict[str, Optional[int]]:
    return {key: value for key, value in limits.items() if value is not None}


def load_rate_limit_overrides() -> None:
    """Load persisted overrides from disk and apply to Config."""
    global _CACHE
    with _STORE_LOCK:
        data = _load_from_disk()
        _CACHE = data

        global_limits = data.get("global")
        if isinstance(global_limits, dict):
            Config.set_rate_limit_override(None, None, global_limits)

        providers_data = data.get("providers", {})
        if isinstance(providers_data, dict):
            for provider, payload in providers_data.items():
                if not isinstance(payload, dict):
                    continue
                provider_limits = payload.get("limits")
                if isinstance(provider_limits, dict):
                    Config.set_rate_limit_override(provider, None, provider_limits)

                model_map = payload.get("models", {})
                if not isinstance(model_map, dict):
                    continue
                for model_name, model_limits in model_map.items():
                    if isinstance(model_limits, dict):
                        Config.set_rate_limit_override(provider, model_name, model_limits)


def get_rate_limit_overrides() -> Dict[str, Any]:
    """Return a snapshot of the currently persisted overrides."""
    with _STORE_LOCK:
        return json.loads(json.dumps(_CACHE))


def persist_rate_limit_override(
    provider: Optional[str],
    model: Optional[str],
    limits: Dict[str, Any],
) -> Dict[str, Optional[int]]:
    """Persist a rate limit override and apply it to configuration."""
    global _CACHE
    sanitized = Config._sanitize_rate_limit_dict(limits or {})
    # Check for .env conflicts - will raise ValueError if conflict detected
    Config.set_rate_limit_override(provider, model, sanitized, check_env_conflicts=True)

    pruned = _prune_limits(sanitized)

    with _STORE_LOCK:
        data = _load_from_disk()

        if provider and model:
            providers = data.setdefault("providers", {})
            provider_entry = providers.setdefault(provider, {"models": {}})
            models_entry = provider_entry.setdefault("models", {})

            if pruned:
                models_entry[model] = pruned
            else:
                models_entry.pop(model, None)
                if not models_entry:
                    provider_entry.pop("models", None)
                    if not provider_entry.get("limits"):
                        providers.pop(provider, None)

        elif provider:
            providers = data.setdefault("providers", {})
            if pruned:
                entry = providers.setdefault(provider, {"models": {}})
                entry["limits"] = pruned
            else:
                entry = providers.get(provider)
                if entry:
                    entry.pop("limits", None)
                    if not entry.get("models"):
                        providers.pop(provider, None)
        else:
            if pruned:
                data["global"] = pruned
            else:
                data.pop("global", None)

        _write_to_disk(data)
        _CACHE = data

    return Config.get_rate_limit_config(provider=provider, model=model)
