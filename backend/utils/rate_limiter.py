# status: complete

import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Deque, Dict, Optional, Tuple

from utils.logger import get_logger

logger = get_logger(__name__)

WINDOW_SECONDS = {
    "minute": 60.0,
    "hour": 3600.0,
    "day": 86400.0,
}

REQUEST_KEY_TO_WINDOW = {
    "requests_per_minute": "minute",
    "requests_per_hour": "hour",
    "requests_per_day": "day",
}

TOKEN_KEY_TO_WINDOW = {
    "tokens_per_minute": "minute",
    "tokens_per_hour": "hour",
    "tokens_per_day": "day",
}

RateLimitDict = Dict[str, Optional[int]]
UsageGetter = Callable[[Any], Optional[int]]


@dataclass
class _LimiterEntry:
    timestamp: float
    value: int
    call_id: str


@dataclass
class _RateLimiterState:
    """State container for a specific rate limit key."""

    config: RateLimitDict = field(default_factory=dict)
    request_logs: Dict[str, Deque[Tuple[float, str]]] = field(
        default_factory=lambda: {
            "minute": deque(),
            "hour": deque(),
            "day": deque(),
        }
    )
    token_logs: Dict[str, Deque[_LimiterEntry]] = field(
        default_factory=lambda: {
            "minute": deque(),
            "hour": deque(),
            "day": deque(),
        }
    )
    lock: threading.RLock = field(default_factory=threading.RLock)

    def update_config(self, config: RateLimitDict) -> None:
        self.config = dict(config or {})

    def _cleanup(self, now: float) -> None:
        for window, dq in self.request_logs.items():
            cutoff = now - WINDOW_SECONDS[window]
            while dq and dq[0][0] <= cutoff:
                dq.popleft()

        for window, dq in self.token_logs.items():
            cutoff = now - WINDOW_SECONDS[window]
            while dq and dq[0].timestamp <= cutoff:
                dq.popleft()

    def _calculate_request_wait(self, now: float) -> float:
        waits = []
        for field, window in REQUEST_KEY_TO_WINDOW.items():

            limit = self.config.get(field)
            if not limit:
                continue

            dq = self.request_logs[window]
            if len(dq) >= limit:
                wait_until = dq[0][0] + WINDOW_SECONDS[window] - now
                waits.append(wait_until)

        burst = self.config.get("burst_size")
        if burst:
            dq = self.request_logs["minute"]
            if len(dq) >= burst:
                wait_until = dq[0][0] + WINDOW_SECONDS["minute"] - now
                waits.append(wait_until)

        return max(waits) if waits else 0.0

    def _calculate_token_wait(self, now: float, pending_tokens: int) -> float:
        if pending_tokens <= 0:
            return 0.0

        waits = []
        for field, window in TOKEN_KEY_TO_WINDOW.items():
            limit = self.config.get(field)
            if not limit:
                continue

            dq = self.token_logs[window]
            current_total = sum(entry.value for entry in dq)
            projected_total = current_total + pending_tokens
            if projected_total <= limit:
                continue

            excess = projected_total - limit
            recovered = 0
            wait_until = 0.0
            for entry in dq:
                recovered += entry.value
                wait_until = entry.timestamp + WINDOW_SECONDS[window] - now
                if recovered >= excess:
                    break
            waits.append(wait_until)

        return max(waits) if waits else 0.0

    def calculate_wait(self, now: float, pending_tokens: int) -> float:
        request_wait = self._calculate_request_wait(now)
        token_wait = self._calculate_token_wait(now, pending_tokens)
        wait_time = max(request_wait, token_wait)
        return max(wait_time, 0.0)

    def record_request(self, call_id: str, timestamp: float) -> None:
        minute_needed = self.config.get("requests_per_minute") or self.config.get("burst_size")
        if minute_needed:
            self.request_logs["minute"].append((timestamp, call_id))

        if self.config.get("requests_per_hour"):
            self.request_logs["hour"].append((timestamp, call_id))

        if self.config.get("requests_per_day"):
            self.request_logs["day"].append((timestamp, call_id))

    def release_request(self, call_id: str) -> None:
        for dq in self.request_logs.values():
            self._remove_request_entry(dq, call_id)

    @staticmethod
    def _remove_request_entry(dq: Deque[Tuple[float, str]], call_id: str) -> None:
        for _ in range(len(dq)):
            timestamp, current_id = dq.popleft()
            if current_id != call_id:
                dq.append((timestamp, current_id))

    def reserve_tokens(self, call_id: str, timestamp: float, tokens: int) -> None:
        if tokens <= 0:
            return

        entry = _LimiterEntry(timestamp=timestamp, value=tokens, call_id=call_id)

        if self.config.get("tokens_per_minute"):
            self.token_logs["minute"].append(entry)

        if self.config.get("tokens_per_hour"):
            self.token_logs["hour"].append(entry)

        if self.config.get("tokens_per_day"):
            self.token_logs["day"].append(entry)

    def release_tokens(self, call_id: str) -> None:
        for dq in self.token_logs.values():
            self._remove_token_entry(dq, call_id)

    def finalize_tokens(self, call_id: str, tokens_used: Optional[int]) -> None:
        if tokens_used is None:
            return

        for dq in self.token_logs.values():
            self._update_token_entry(dq, call_id, tokens_used)

    @staticmethod
    def _remove_token_entry(dq: Deque[_LimiterEntry], call_id: str) -> None:
        for _ in range(len(dq)):
            entry = dq.popleft()
            if entry.call_id != call_id:
                dq.append(entry)

    @staticmethod
    def _update_token_entry(dq: Deque[_LimiterEntry], call_id: str, new_value: int) -> None:
        for idx, entry in enumerate(dq):
            if entry.call_id == call_id:
                dq[idx] = _LimiterEntry(timestamp=entry.timestamp, value=max(new_value, 0), call_id=entry.call_id)
                return


class RateLimiterManager:
    """Manage rate limiting across multiple keys."""

    def __init__(self):
        self._states: Dict[str, _RateLimiterState] = {}
        self._lock = threading.RLock()

    def _get_state(self, key: str) -> _RateLimiterState:
        with self._lock:
            if key not in self._states:
                self._states[key] = _RateLimiterState()
            return self._states[key]

    def execute(
        self,
        callback: Callable[..., Any],
        key: str,
        *callback_args: Any,
        limit_config: Optional[RateLimitDict] = None,
        usage_getter: Optional[UsageGetter] = None,
        estimated_tokens: Optional[int] = None,
        **callback_kwargs: Any,
    ) -> Any:
        """
        Execute callback respecting configured rate limits.

        Args:
            callback: Callable to execute.
            key: Unique key representing the rate limit dimension.
            config: Rate limit configuration dictionary.
            usage_getter: Optional callable extracting token usage from callback result.
            estimated_tokens: Optional estimated token usage prior to execution.
            *callback_args/**callback_kwargs: Arguments for the callback.
        """
        if limit_config is None:
            limit_config = {}

        state = self._get_state(key)
        call_id = uuid.uuid4().hex
        estimated = max(int(estimated_tokens or 0), 0)

        with state.lock:
            state.update_config(limit_config)
            now = time.time()
            state._cleanup(now)
            wait_time = state.calculate_wait(now, estimated)
            scheduled_time = now + wait_time
            state.record_request(call_id, scheduled_time)
            if estimated > 0:
                state.reserve_tokens(call_id, scheduled_time, estimated)

        if wait_time > 0:
            logger.info("Rate limiting %s, waiting %.2fs", key, wait_time)
            time.sleep(wait_time)

        try:
            result = callback(*callback_args, **callback_kwargs)
        except Exception:
            with state.lock:
                state.release_request(call_id)
                state.release_tokens(call_id)
            raise

        tokens_used = None
        if usage_getter:
            try:
                tokens_used = usage_getter(result)
            except Exception as exc:
                logger.warning("Failed to extract token usage for %s: %s", key, exc)
                tokens_used = None

        with state.lock:
            state.finalize_tokens(call_id, tokens_used)

        return result


_rate_limiter_manager: Optional[RateLimiterManager] = None
_manager_lock = threading.Lock()


def get_rate_limiter() -> RateLimiterManager:
    """Return the shared rate limiter manager."""
    global _rate_limiter_manager
    with _manager_lock:
        if _rate_limiter_manager is None:
            _rate_limiter_manager = RateLimiterManager()
        return _rate_limiter_manager


def rate_limited(
    key: str,
    config: Optional[RateLimitDict] = None,
    usage_getter: Optional[UsageGetter] = None,
    estimated_tokens: Optional[int] = None,
):
    """Decorator wrapper to execute a function under rate limiting constraints."""

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            limiter = get_rate_limiter()
            return limiter.execute(
                func,
                key,
                *args,
                limit_config=config,
                usage_getter=usage_getter,
                estimated_tokens=estimated_tokens,
                **kwargs,
            )

        return wrapper

    return decorator
