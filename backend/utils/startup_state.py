"""Lightweight module to expose backend startup state to route handlers."""

from __future__ import annotations

from threading import Lock
from time import time
from typing import Any, Dict, Optional

_state_lock = Lock()
_state: Dict[str, Any] = {
    "status": "unknown",  # one of unknown, initializing, ready, degraded
    "started_at": None,
    "completed": False,
    "success": None,
    "error": None,
    "summary": None,
    "reset_count": 0,
}


def mark_initializing() -> None:
    """Mark the startup housekeeping as in progress."""
    with _state_lock:
        _state["status"] = "initializing"
        _state["started_at"] = time()
        _state["completed"] = False
        _state["success"] = None
        _state["error"] = None
        _state["summary"] = None
        _state["reset_count"] = 0


def set_housekeeping_result(sync_result: Optional[Dict[str, Any]], reset_count: int) -> None:
    """Store the outcome of startup housekeeping."""
    with _state_lock:
        success = bool(sync_result.get("success")) if isinstance(sync_result, dict) else False
        _state["status"] = "ready" if success else "degraded"
        _state["completed"] = True
        _state["success"] = success
        _state["error"] = sync_result.get("error") if isinstance(sync_result, dict) else None
        _state["summary"] = sync_result.get("summary") if isinstance(sync_result, dict) else None
        _state["reset_count"] = reset_count


def get_backend_state() -> Dict[str, Any]:
    """Return a shallow copy of the current backend startup state."""
    with _state_lock:
        return dict(_state)
