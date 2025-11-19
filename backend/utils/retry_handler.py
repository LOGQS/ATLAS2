# status: complete

"""
Retry handler for API calls with rate limit and overload detection.
Provides unified retry logic for both async and sync execution paths.
"""

import re
import time
from typing import Optional, Callable, Dict, Any
from utils.logger import get_logger

logger = get_logger(__name__)


class RetryContext:
    """Context for tracking retry state across attempts"""
    def __init__(self, max_retries: int = 5):
        self.max_retries = max_retries
        self.attempt = 0
        self.retry_delays = [1, 2, 4, 8, 16]  # Exponential backoff for overload errors


class RetryHandler:
    """
    Handles retry logic for API calls with smart delay calculation.

    Supports:
    - Rate limit errors (429, RESOURCE_EXHAUSTED, quota exceeded) -> Uses API-provided delay
    - Overload errors (503, overloaded, UNAVAILABLE) -> Uses exponential backoff
    - Custom retry event callbacks for frontend notification
    """

    def __init__(self, max_retries: int = 5):
        self.max_retries = max_retries
        self.retry_delays = [1, 2, 4, 8, 16]  # seconds for overload errors (exponential backoff)
        self.rate_limit_delays = [2, 5, 20, 40, 60]  # seconds for rate limits without API delay (progressive backoff)

    def is_retryable_error(self, error_message: str) -> tuple[bool, Optional[str], Optional[float], bool]:
        """
        Check if an error is retryable and extract retry information.

        Returns:
            tuple: (is_retryable, retry_reason, api_provided_delay, is_rate_limit)
        """
        error_lower = error_message.lower()

        # Rate limit detection (highest priority since API gives us delay)
        if ("429" in error_message or "RESOURCE_EXHAUSTED" in error_message or
            "exceeded your current quota" in error_lower or
            "quota exceeded" in error_lower):

            retry_reason = "Rate limit exceeded"
            api_provided_delay = self._extract_api_delay(error_message)
            return True, retry_reason, api_provided_delay, True

        # Overload detection
        elif ("overloaded" in error_lower or "503" in error_message or "UNAVAILABLE" in error_message or
              "experiencing high traffic" in error_lower or "queue_exceeded" in error_lower):
            retry_reason = "Model overloaded"
            return True, retry_reason, None, False

        return False, None, None, False

    def _extract_api_delay(self, error_message: str) -> Optional[float]:
        """
        Extract retry delay from API error message.
        Handles formats like: "Please retry in 29.64243146s" or "Please retry in 92.795152ms"

        Returns:
            Delay in seconds, or None if not found
        """
        match = re.search(r"retry in ([\d.]+)(m?s)", error_message, re.IGNORECASE)
        if match:
            delay_value = float(match.group(1))
            unit = match.group(2).lower()
            # Convert milliseconds to seconds
            return delay_value / 1000.0 if unit == 'ms' else delay_value
        return None

    def calculate_delay(
        self,
        attempt: int,
        is_rate_limit: bool,
        api_provided_delay: Optional[float]
    ) -> tuple[float, str]:
        """
        Calculate retry delay based on error type and attempt number.

        Args:
            attempt: Current attempt number (1-indexed)
            is_rate_limit: Whether this is a rate limit error
            api_provided_delay: API-provided delay in seconds (for rate limits)

        Returns:
            tuple: (delay_seconds, delay_description)
        """
        if is_rate_limit:
            if api_provided_delay is None:
                # Some providers (like Zenmux) don't provide retry-after headers
                # Use progressive backoff: starts short, increases if rate limit persists
                delay_idx = min(attempt - 1, len(self.rate_limit_delays) - 1)
                delay = self.rate_limit_delays[delay_idx]
                delay_str = f"{delay}s (progressive backoff, attempt {attempt})"
                logger.warning(f"[RETRY] Rate limit detected without API-provided delay, using progressive backoff: {delay_str}")
                return delay, delay_str
            # Add 1.5s tolerance buffer to avoid immediate re-trigger
            tolerance_buffer = 1.5
            delay = api_provided_delay + tolerance_buffer
            delay_str = f"{delay:.1f}s (API: {api_provided_delay:.1f}s + {tolerance_buffer}s buffer)"
            return delay, delay_str
        else:
            # Overload: Use exponential backoff
            delay_idx = min(attempt - 1, len(self.retry_delays) - 1)
            delay = self.retry_delays[delay_idx]
            delay_str = f"{delay}s (exponential backoff)"
            return delay, delay_str

    def should_retry(
        self,
        error_message: str,
        attempt: int,
        logger_instance=None,
        event_callback: Optional[Callable] = None,
        event_context: Optional[Dict[str, Any]] = None,
        model: Optional[str] = None
    ) -> tuple[bool, Optional[float]]:
        """
        Determine if we should retry and calculate the delay.

        Args:
            error_message: The error message to check
            attempt: Current attempt number (0-indexed)
            logger_instance: Logger to use for warning messages
            event_callback: Optional callback for emitting retry events
            event_context: Optional context dict for retry events (chat_id, task_id, etc.)
            model: Model name for logging

        Returns:
            tuple: (should_retry, delay_seconds) - delay is None if should not retry
        """
        if logger_instance is None:
            logger_instance = logger

        is_retryable, retry_reason, api_provided_delay, is_rate_limit = self.is_retryable_error(error_message)

        if not is_retryable:
            return False, None

        # Check if we've exceeded max retries
        if attempt >= self.max_retries:
            logger_instance.warning(
                f"[RETRY] {retry_reason} persisted after {self.max_retries} attempts. Giving up."
            )
            return False, None

        # Calculate delay
        next_attempt = attempt + 1
        try:
            delay, delay_str = self.calculate_delay(next_attempt, is_rate_limit, api_provided_delay)
        except ValueError as e:
            logger_instance.error(f"[RETRY] Failed to calculate delay: {e}. Error: {error_message}")
            return False, None

        # Log retry
        logger_instance.warning(
            f"[RETRY] {retry_reason}, retrying in {delay_str} (attempt {next_attempt}/{self.max_retries})"
        )

        # Emit retry event if callback provided
        if event_callback and event_context:
            retry_event = {
                "event": "model_retry",
                "payload": {
                    "attempt": next_attempt,
                    "max_attempts": self.max_retries,
                    "delay_seconds": delay,
                    "model": model or "unknown",
                    "reason": retry_reason,
                    "error_preview": error_message[:200] if len(error_message) > 200 else error_message
                }
            }
            # Merge event_context into retry_event
            retry_event.update(event_context)

            try:
                event_callback(retry_event)
            except Exception as cb_error:
                logger_instance.warning(f"[RETRY] Failed to emit retry event: {cb_error}")

        return True, delay

    def sleep_with_logging(self, delay: float, logger_instance=None):
        """Sleep for specified delay with optional logging"""
        if logger_instance:
            logger_instance.debug(f"[RETRY] Sleeping for {delay}s before retry")
        time.sleep(delay)
