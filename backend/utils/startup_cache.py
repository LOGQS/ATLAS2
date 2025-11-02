# status: added

"""
Lightweight cross-process startup cache.

Workers can request cacheable initialization data from the parent process so the
first worker that needs to perform an expensive warm-up does the work exactly
once. Subsequent workers reuse the cached payload without repeating the same
external calls (API fetches, warm-ups, etc.).

The cache lives only for the lifetime of the backend process; no disk state is
persisted. Communication happens through the existing multiprocessing Pipe
between the chat worker and the parent process.
"""

from __future__ import annotations

import copy
import threading
import uuid
from collections import deque
from typing import Any, Callable, Deque, Dict, Optional, Tuple

from multiprocessing.connection import Connection

from utils.logger import get_logger

logger = get_logger(__name__)

CacheValue = Any
RequestId = str

# --------------------------------------------------------------------------------------
# Parent-side state
# --------------------------------------------------------------------------------------

_parent_cache: Dict[str, CacheValue] = {}
_parent_pending: Dict[str, Dict[str, Any]] = {}
_parent_lock = threading.Lock()

# --------------------------------------------------------------------------------------
# Worker-side state
# --------------------------------------------------------------------------------------

_worker_conn: Optional[Connection] = None
_worker_cache: Dict[str, CacheValue] = {}
_worker_lock = threading.Lock()
_worker_comm_lock = threading.RLock()


def register_worker_channel(conn: Connection) -> None:
    """Register the worker's Pipe connection so cache helpers can communicate."""
    global _worker_conn
    _worker_conn = conn
    logger.debug("startup_cache: worker channel registered (conn=%s)", id(conn))


def clear_worker_channel() -> None:
    """Clear the worker connection reference (used during shutdown)."""
    global _worker_conn
    _worker_conn = None


def has_worker_channel() -> bool:
    """Return whether a worker channel is registered (primarily for diagnostics)."""
    return _worker_conn is not None

def _copy_payload(value: CacheValue) -> CacheValue:
    """Return a defensive copy of cached payloads to avoid accidental mutation."""
    try:
        return copy.deepcopy(value)
    except Exception:
        # Fallback to shallow copy where deep copy is not supported
        return copy.copy(value) if hasattr(value, "copy") else value


def worker_get_or_initialize(key: str, initializer: Callable[[], CacheValue]) -> CacheValue:
    """
    Retrieve a cached value from the parent process, computing it only once.

    Args:
        key: Cache key identifying the resource.
        initializer: Callable that produces the value if no cache entry exists.

    Returns:
        The cached (or freshly initialized) value.
    """
    with _worker_lock:
        if key in _worker_cache:
            logger.debug("startup_cache: worker cache hit for key %s", key)
            return _copy_payload(_worker_cache[key])

    if _worker_conn is None:
        logger.debug("startup_cache: no worker connection, computing key %s locally", key)
        value = initializer()
        with _worker_lock:
            _worker_cache[key] = value
        return _copy_payload(value)

    with _worker_comm_lock:
        # Re-check cache after acquiring the comm lock in case another caller populated it.
        with _worker_lock:
            if key in _worker_cache:
                logger.debug("startup_cache: worker cache hit after wait for key %s", key)
                return _copy_payload(_worker_cache[key])

        request_id = uuid.uuid4().hex
        _worker_conn.send(
            {
                "type": "startup_cache_request",
                "key": key,
                "request_id": request_id,
            }
        )

        logger.debug("startup_cache: sent request for key %s (request=%s)", key, request_id)

        while True:
            message = _worker_conn.recv()
            if not isinstance(message, dict):
                continue

            msg_type = message.get("type")
            if msg_type == "startup_cache_response" and message.get("request_id") == request_id:
                status = message.get("status")
                if status == "hit":
                    logger.debug("startup_cache: received hit for key %s (request=%s)", key, request_id)
                    value = message.get("value")
                    with _worker_lock:
                        _worker_cache[key] = value
                    return _copy_payload(value)

                if status == "miss":
                    logger.debug("startup_cache: received miss ownership for key %s (request=%s)", key, request_id)
                    try:
                        value = initializer()
                    except Exception as exc:
                        logger.debug(
                            "startup_cache: initializer failed for key %s (request=%s error=%s)",
                            key,
                            request_id,
                            exc,
                        )
                        _worker_conn.send(
                            {
                                "type": "startup_cache_update_failed",
                                "key": key,
                                "request_id": request_id,
                                "error": str(exc),
                            }
                        )
                        _wait_for_ack(request_id)
                        raise

                    _worker_conn.send(
                        {
                            "type": "startup_cache_update",
                            "key": key,
                            "request_id": request_id,
                            "value": value,
                        }
                    )
                    ack = _wait_for_ack(request_id)
                    status = ack.get("status", "ok")
                    if status != "ok":
                        raise RuntimeError(ack.get("error", "Failed to publish cache value"))

                    with _worker_lock:
                        _worker_cache[key] = value
                    return _copy_payload(value)

                if status == "wait":
                    logger.debug("startup_cache: wait for key %s (request=%s)", key, request_id)
                    # Another worker is computing the value. Wait for the next response.
                    continue

            elif msg_type == "startup_cache_ack" and message.get("request_id") == request_id:
                status = message.get("status", "ok")
                if status != "ok":
                    raise RuntimeError(message.get("error", "Cache update failed"))
                with _worker_lock:
                    value = _worker_cache[key]
                return _copy_payload(value)


def _wait_for_ack(request_id: RequestId) -> Dict[str, Any]:
    """Wait for the parent to acknowledge cache publication."""
    while True:
        message = _worker_conn.recv()  # type: ignore[union-attr]
        if (
            isinstance(message, dict)
            and message.get("type") == "startup_cache_ack"
            and message.get("request_id") == request_id
        ):
            return message


def handle_parent_message(conn: Connection, message: Any) -> bool:
    """
    Parent-side handler for startup cache messages.

    Args:
        conn: The worker's connection.
        message: Incoming payload.

    Returns:
        True if the message was handled as part of the cache protocol.
    """
    if not isinstance(message, dict):
        return False

    msg_type = message.get("type")
    if msg_type == "startup_cache_request":
        _handle_cache_request(conn, message)
        return True

    if msg_type == "startup_cache_update":
        _handle_cache_update(conn, message)
        return True

    if msg_type == "startup_cache_update_failed":
        _handle_cache_update_failed(conn, message)
        return True

    return False


def _handle_cache_request(conn: Connection, message: Dict[str, Any]) -> None:
    key = message.get("key")
    request_id = message.get("request_id")
    if not key or not request_id:
        return

    with _parent_lock:
        if key in _parent_cache:
            logger.debug("startup_cache: hit for key %s (conn=%s)", key, id(conn))
            value = _parent_cache[key]
            conn.send(
                {
                    "type": "startup_cache_response",
                    "request_id": request_id,
                    "status": "hit",
                    "key": key,
                    "value": value,
                }
            )
            return

        entry = _parent_pending.setdefault(
            key, {"owner": None, "waiters": deque()}  # type: ignore[var-annotated]
        )

        if entry["owner"] is None:
            logger.debug("startup_cache: assigning owner for key %s (request=%s conn=%s)", key, request_id, id(conn))
            entry["owner"] = (conn, request_id)
            conn.send(
                {
                    "type": "startup_cache_response",
                    "request_id": request_id,
                    "status": "miss",
                    "key": key,
                }
            )
        else:
            waiters: Deque[Tuple[Connection, RequestId]] = entry["waiters"]
            logger.debug(
                "startup_cache: enqueue waiter for key %s (request=%s conn=%s waiters=%d)",
                key,
                request_id,
                id(conn),
                len(waiters) + 1,
            )
            waiters.append((conn, request_id))
            conn.send(
                {
                    "type": "startup_cache_response",
                    "request_id": request_id,
                    "status": "wait",
                    "key": key,
                }
            )


def _handle_cache_update(conn: Connection, message: Dict[str, Any]) -> None:
    key = message.get("key")
    request_id = message.get("request_id")
    if not key or not request_id:
        return

    value = message.get("value")
    logger.debug("startup_cache: update received for key %s (request=%s conn=%s)", key, request_id, id(conn))

    waiters: Deque[Tuple[Connection, RequestId]] = deque()

    with _parent_lock:
        _parent_cache[key] = value
        entry = _parent_pending.pop(key, None)
        if entry:
            owner = entry.get("owner")
            if owner and owner[1] != request_id:
                # Edge case: owner mismatch - ensure the stored owner gets notified.
                owner_conn, owner_req = owner
                owner_conn.send(
                    {
                        "type": "startup_cache_ack",
                        "request_id": owner_req,
                        "status": "error",
                        "error": "Cache owner mismatch during update",
                    }
                )
            waiters = entry.get("waiters", deque())  # type: ignore[assignment]

    for waiter_conn, waiter_req in waiters:
        logger.debug(
            "startup_cache: fulfilling waiter for key %s (request=%s conn=%s)",
            key,
            waiter_req,
            id(waiter_conn),
        )
        waiter_conn.send(
            {
                "type": "startup_cache_response",
                "request_id": waiter_req,
                "status": "hit",
                "key": key,
                "value": value,
            }
        )

    conn.send(
        {
            "type": "startup_cache_ack",
            "request_id": request_id,
            "status": "ok",
        }
    )


def _handle_cache_update_failed(conn: Connection, message: Dict[str, Any]) -> None:
    key = message.get("key")
    request_id = message.get("request_id")
    error = message.get("error", "Unknown error")
    if not key or not request_id:
        return

    next_owner: Optional[Tuple[Connection, RequestId]] = None

    with _parent_lock:
        entry = _parent_pending.get(key)
        if entry:
            owner = entry.get("owner")
            if owner and owner[1] == request_id:
                logger.debug(
                    "startup_cache: update failed for key %s (request=%s conn=%s error=%s)",
                    key,
                    request_id,
                    id(conn),
                    error,
                )
                waiters: Deque[Tuple[Connection, RequestId]] = entry.get("waiters", deque())
                if waiters:
                    next_owner = waiters.popleft()
                    entry["owner"] = next_owner
                else:
                    _parent_pending.pop(key, None)

    conn.send(
        {
            "type": "startup_cache_ack",
            "request_id": request_id,
            "status": "error",
            "error": error,
        }
    )

    if next_owner:
        logger.debug(
            "startup_cache: promoting next waiter for key %s (request=%s conn=%s)",
            key,
            next_owner[1],
            id(next_owner[0]),
        )
        _notify_new_owner(key, next_owner)


def cleanup_for_connection(conn: Connection) -> None:
    """Remove any pending ownership for a connection that is shutting down."""

    promotions: Deque[Tuple[str, Tuple[Connection, RequestId]]] = deque()

    with _parent_lock:
        keys_to_delete = []
        for key, entry in _parent_pending.items():
            owner = entry.get("owner")
            waiters: Deque[Tuple[Connection, RequestId]] = entry.get("waiters", deque())

            if owner and owner[0] is conn:
                logger.debug(
                    "startup_cache: cleaning up owner for key %s (request=%s conn=%s)",
                    key,
                    owner[1],
                    id(conn),
                )
                if waiters:
                    next_owner = waiters.popleft()
                    entry["owner"] = next_owner
                    promotions.append((key, next_owner))
                else:
                    entry["owner"] = None
                    keys_to_delete.append(key)

            filtered_waiters = deque((c, req) for c, req in waiters if c is not conn)
            entry["waiters"] = filtered_waiters

            if entry.get("owner") is None and not entry["waiters"]:
                keys_to_delete.append(key)

        for key in keys_to_delete:
            _parent_pending.pop(key, None)

    while promotions:
        promote_key, owner = promotions.popleft()
        _notify_new_owner(promote_key, owner)


def _notify_new_owner(key: str, owner: Tuple[Connection, RequestId]) -> None:
    """Assign a new owner for cache initialization, retrying as needed."""

    conn, req_id = owner
    logger.debug(
        "startup_cache: notifying new owner for key %s (request=%s conn=%s)",
        key,
        req_id,
        id(conn),
    )
    try:
        conn.send(
            {
                "type": "startup_cache_response",
                "request_id": req_id,
                "status": "miss",
                "key": key,
            }
        )
    except Exception:
        logger.debug(
            "startup_cache: failed to notify owner for key %s (request=%s conn=%s)",
            key,
            req_id,
            id(conn),
        )
        _promote_next_waiter(key, failed_conn=conn)


def _promote_next_waiter(key: str, failed_conn: Optional[Connection] = None) -> None:
    """Promote the next waiter to owner after a failed notification."""

    next_owner: Optional[Tuple[Connection, RequestId]] = None

    with _parent_lock:
        entry = _parent_pending.get(key)
        if not entry:
            return

        if failed_conn is not None:
            owner = entry.get("owner")
            if owner and owner[0] is failed_conn:
                entry["owner"] = None

            waiters: Deque[Tuple[Connection, RequestId]] = entry.get("waiters", deque())
            filtered_waiters = deque((c, req) for c, req in waiters if c is not failed_conn)
            entry["waiters"] = filtered_waiters

        if entry.get("owner") is None and entry.get("waiters"):
            waiters = entry["waiters"]
            next_owner = waiters.popleft()
            entry["owner"] = next_owner
        elif entry.get("owner") is None and not entry.get("waiters"):
            _parent_pending.pop(key, None)

    if next_owner:
        _notify_new_owner(key, next_owner)
