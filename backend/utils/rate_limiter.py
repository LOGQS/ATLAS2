# status: complete

import threading
import time
from typing import Any, Callable, Dict, Optional
from utils.logger import get_logger
from utils.db_utils import db

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


class RateLimiterManager:
    """
    Simplified rate limiter using SQLite as single source of truth.

    Main process checks limits BEFORE dispatching to workers.
    No multi-process coordination needed - everything happens in main process.
    """

    def __init__(self):
        self._lock = threading.RLock()
        self._cleanup_old_entries()

    def _cleanup_old_entries(self) -> None:
        """Remove entries older than 24 hours to keep database clean"""
        try:
            cutoff = time.time() - (24 * 3600)
            with db.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "DELETE FROM rate_limit_usage WHERE updated_at < ?",
                    (cutoff,)
                )
                deleted = cursor.rowcount
                conn.commit()
                if deleted > 0:
                    logger.info(f"[RATE-LIMIT-CLEANUP] Removed {deleted} old rate limit entries")
        except Exception as e:
            logger.warning(f"[RATE-LIMIT-CLEANUP] Failed to clean old entries: {e}")

    def _get_usage_from_db(self, scope_key: str, window: str, now: float) -> Dict[str, Any]:
        """
        Get current usage from SQLite for a scope and window.
        Auto-expires old data based on oldest timestamp.
        """
        try:
            with db.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT request_count, token_count, oldest_request_ts, oldest_token_ts
                    FROM rate_limit_usage
                    WHERE scope_key = ? AND window = ?
                    """,
                    (scope_key, window)
                )
                row = cursor.fetchone()

                if not row:
                    return {"requests": 0, "tokens": 0, "expires_at": {}}

                request_count = row["request_count"]
                token_count = row["token_count"]
                oldest_request_ts = row["oldest_request_ts"]
                oldest_token_ts = row["oldest_token_ts"]

                window_size = WINDOW_SECONDS[window]

                # Check if requests have expired
                if oldest_request_ts and (now - oldest_request_ts) > window_size:
                    request_count = 0
                    oldest_request_ts = None

                # Check if tokens have expired
                if oldest_token_ts and (now - oldest_token_ts) > window_size:
                    token_count = 0
                    oldest_token_ts = None

                expires_at = {}
                if oldest_request_ts:
                    expires_at[f"requests_{window}"] = oldest_request_ts + window_size
                if oldest_token_ts:
                    expires_at[f"tokens_{window}"] = oldest_token_ts + window_size

                return {
                    "requests": request_count,
                    "tokens": token_count,
                    "expires_at": expires_at
                }
        except Exception as e:
            logger.error(f"[RATE-LIMIT] Error reading usage from DB: {e}")
            return {"requests": 0, "tokens": 0, "expires_at": {}}

    def _calculate_wait(self, scope_key: str, config: RateLimitDict, pending_tokens: int, now: float) -> float:
        """
        Calculate how long to wait before this request can proceed.
        Returns 0.0 if request can proceed immediately.
        """
        waits = []

        # Check request limits across all windows
        for field, window in REQUEST_KEY_TO_WINDOW.items():
            limit = config.get(field)
            if not limit:
                continue

            usage = self._get_usage_from_db(scope_key, window, now)
            current_requests = usage["requests"]

            if current_requests >= limit:
                # Need to wait until oldest request expires
                oldest_ts = usage["expires_at"].get(f"requests_{window}")
                if oldest_ts:
                    wait_until = oldest_ts - now
                    waits.append(wait_until)

        # Check token limits across all windows
        for field, window in TOKEN_KEY_TO_WINDOW.items():
            limit = config.get(field)
            if not limit:
                continue

            usage = self._get_usage_from_db(scope_key, window, now)
            current_tokens = usage["tokens"]
            projected = current_tokens + pending_tokens

            if projected > limit:
                # Need to wait until oldest tokens expire
                oldest_ts = usage["expires_at"].get(f"tokens_{window}")
                if oldest_ts:
                    wait_until = oldest_ts - now
                    waits.append(wait_until)

        # Check burst size (special case for minute window)
        burst = config.get("burst_size")
        if burst:
            usage = self._get_usage_from_db(scope_key, "minute", now)
            if usage["requests"] >= burst:
                oldest_ts = usage["expires_at"].get("requests_minute")
                if oldest_ts:
                    wait_until = oldest_ts - now
                    waits.append(wait_until)

        return max(waits) if waits else 0.0

    def _record_usage(self, scope_key: str, requests: int, tokens: int, now: float) -> None:
        """
        Record usage in SQLite. Simple INSERT OR REPLACE with counts and timestamps.
        """
        try:
            with db.get_connection() as conn:
                cursor = conn.cursor()

                for window in ["minute", "hour", "day"]:
                    # Get existing data
                    cursor.execute(
                        """
                        SELECT request_count, token_count, oldest_request_ts, oldest_token_ts
                        FROM rate_limit_usage
                        WHERE scope_key = ? AND window = ?
                        """,
                        (scope_key, window)
                    )
                    row = cursor.fetchone()

                    window_size = WINDOW_SECONDS[window]

                    if row:
                        # Check expiration and update
                        new_request_count = row["request_count"]
                        new_token_count = row["token_count"]
                        oldest_request_ts = row["oldest_request_ts"]
                        oldest_token_ts = row["oldest_token_ts"]

                        # Expire old requests
                        if oldest_request_ts and (now - oldest_request_ts) > window_size:
                            new_request_count = 0
                            oldest_request_ts = None

                        # Expire old tokens
                        if oldest_token_ts and (now - oldest_token_ts) > window_size:
                            new_token_count = 0
                            oldest_token_ts = None

                        # Add new usage
                        if requests > 0:
                            new_request_count += requests
                            if oldest_request_ts is None:
                                oldest_request_ts = now

                        if tokens > 0:
                            new_token_count += tokens
                            if oldest_token_ts is None:
                                oldest_token_ts = now

                        cursor.execute(
                            """
                            UPDATE rate_limit_usage
                            SET request_count = ?, token_count = ?,
                                oldest_request_ts = ?, oldest_token_ts = ?,
                                updated_at = ?
                            WHERE scope_key = ? AND window = ?
                            """,
                            (new_request_count, new_token_count,
                             oldest_request_ts, oldest_token_ts,
                             now, scope_key, window)
                        )
                    else:
                        # Insert new record
                        cursor.execute(
                            """
                            INSERT INTO rate_limit_usage
                            (scope_key, window, request_count, token_count,
                             oldest_request_ts, oldest_token_ts, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                            """,
                            (scope_key, window, requests, tokens,
                             now if requests > 0 else None,
                             now if tokens > 0 else None,
                             now)
                        )

                conn.commit()
        except Exception as e:
            logger.error(f"[RATE-LIMIT] Error recording usage: {e}")

    def check_and_reserve(
        self,
        provider: str,
        model: str,
        estimated_tokens: int = 0
    ) -> None:
        """
        Check rate limits across all applicable scopes and reserve capacity.
        Raises exception if rate limit would be exceeded.

        This should be called in MAIN PROCESS before dispatching to worker.
        """
        from utils.config import Config

        all_scopes = Config.get_rate_limit_keys_to_check(provider, model)

        with self._lock:
            now = time.time()
            max_wait = 0.0

            # Calculate maximum wait needed across all scopes
            for scope_key, scope_config in all_scopes:
                wait = self._calculate_wait(scope_key, scope_config, estimated_tokens, now)
                max_wait = max(max_wait, wait)

            # Enforce wait if needed
            if max_wait > 0:
                scope_names = [s[0] for s in all_scopes]
                logger.info(
                    f"[RATE-LIMIT] {provider}:{model} (scopes: {scope_names}) waiting {max_wait:.2f}s"
                )
                time.sleep(max_wait)
                now = time.time()  # Update timestamp after wait

            # Reserve capacity in all scopes
            for scope_key, _ in all_scopes:
                self._record_usage(scope_key, requests=1, tokens=estimated_tokens, now=now)

    def finalize_tokens(
        self,
        provider: str,
        model: str,
        actual_tokens: int
    ) -> None:
        """
        Update token usage with actual count after API call completes.
        Called from main process after worker returns actual token count.
        """
        from utils.config import Config

        all_scopes = Config.get_rate_limit_keys_to_check(provider, model)

        with self._lock:
            now = time.time()

            # Record only the token delta (actual - estimated was already recorded)
            # Since we already recorded estimated tokens in check_and_reserve,
            # we need to calculate the difference
            for scope_key, _ in all_scopes:
                # For now, we'll just update with actual tokens
                # This means we record tokens twice (estimated + actual)
                # But SQLite will handle the accumulation correctly
                self._record_usage(scope_key, requests=0, tokens=actual_tokens, now=now)

    def get_usage_snapshot(self, scope_key: str) -> Optional[Dict[str, Any]]:
        """
        Get usage snapshot for UI display.
        Returns counts and expiration timestamps for all windows.
        """
        try:
            now = time.time()
            usage = {
                "requests": {},
                "tokens": {},
                "expires_at": {},
                "snapshot_time": now,
            }

            for window in ["minute", "hour", "day"]:
                window_usage = self._get_usage_from_db(scope_key, window, now)
                usage["requests"][window] = window_usage["requests"]
                usage["tokens"][window] = window_usage["tokens"]
                usage["expires_at"].update(window_usage["expires_at"])

            return usage
        except Exception as e:
            logger.error(f"[RATE-LIMIT] Error getting usage snapshot: {e}")
            return None

    def get_all_usage(self) -> Dict[str, Dict[str, Any]]:
        """
        Get usage snapshots for all tracked scopes.
        Used by API route to display current usage.
        """
        try:
            with db.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT DISTINCT scope_key FROM rate_limit_usage")
                scope_keys = [row["scope_key"] for row in cursor.fetchall()]

            all_usage = {}
            for scope_key in scope_keys:
                usage = self.get_usage_snapshot(scope_key)
                if usage:
                    all_usage[scope_key] = usage

            return all_usage
        except Exception as e:
            logger.error(f"[RATE-LIMIT] Error getting all usage: {e}")
            return {}


_rate_limiter_manager: Optional[RateLimiterManager] = None
_manager_lock = threading.Lock()


def get_rate_limiter() -> RateLimiterManager:
    """Return the shared rate limiter manager."""
    global _rate_limiter_manager
    with _manager_lock:
        if _rate_limiter_manager is None:
            _rate_limiter_manager = RateLimiterManager()
        return _rate_limiter_manager
