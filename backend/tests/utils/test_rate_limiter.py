"""Unit tests for rate limiter functionality."""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

import utils.rate_limiter as rate_limiter_module  # noqa: E402
from utils.rate_limiter import RateLimiterManager, get_rate_limiter  # noqa: E402


class RateLimiterManagerTests(unittest.TestCase):
    """Tests for the rate limiter manager covering request and token limits."""

    def setUp(self) -> None:
        patcher_sleep = patch("utils.rate_limiter.time.sleep")
        self.addCleanup(patcher_sleep.stop)
        self.mock_sleep = patcher_sleep.start()

        self.manager = RateLimiterManager()

    def test_execute_without_limits_runs_immediately(self):
        """When no limits are configured the callback should run without waiting."""
        callback = MagicMock(return_value="done")
        result = self.manager.execute(callback, "no_limits", limit_config={})

        callback.assert_called_once_with()
        self.mock_sleep.assert_not_called()
        self.assertEqual(result, "done")

    def test_request_rate_limit_enforced(self):
        """Requests should be delayed when exceeding the configured per-minute limit."""
        with patch.dict(rate_limiter_module.WINDOW_SECONDS, {"minute": 0.1, "hour": 1.0, "day": 1.0}, clear=False):
            config = {"requests_per_minute": 1, "burst_size": 1}

            self.manager.execute(lambda: None, "req", limit_config=config)
            self.mock_sleep.assert_not_called()

            self.manager.execute(lambda: None, "req", limit_config=config)
            self.assertTrue(self.mock_sleep.called)
            waited = self.mock_sleep.call_args[0][0]
            self.assertGreater(waited, 0)

    def test_token_rate_limit_enforced(self):
        """Token limits should trigger waits once the configured capacity is exceeded."""
        with patch.dict(
            rate_limiter_module.WINDOW_SECONDS,
            {"minute": 0.1, "hour": 0.2, "day": 0.3},
            clear=False,
        ):
            config = {
                "requests_per_minute": 100,
                "tokens_per_minute": 100,
                "burst_size": 100,
            }

            self.manager.execute(lambda: None, "tokens", limit_config=config, estimated_tokens=80)
            self.mock_sleep.assert_not_called()

            self.manager.execute(lambda: None, "tokens", limit_config=config, estimated_tokens=30)
            self.assertTrue(self.mock_sleep.called)

    def test_usage_getter_updates_token_reservation(self):
        """Actual usage reported by usage_getter should replace estimated tokens."""
        with patch.dict(
            rate_limiter_module.WINDOW_SECONDS,
            {"minute": 0.5, "hour": 1.0, "day": 1.0},
            clear=False,
        ):
            config = {
                "requests_per_minute": 10,
                "tokens_per_minute": 100,
                "burst_size": 10,
            }

            def callback():
                return "response"

            def usage_getter(_response):
                return 40

            self.manager.execute(
                callback,
                "usage-key",
                limit_config=config,
                estimated_tokens=80,
                usage_getter=usage_getter,
            )

            state = self.manager._get_state("usage-key")  # type: ignore[attr-defined]
            minute_log = list(state.token_logs["minute"])  # type: ignore[attr-defined]
            self.assertEqual(len(minute_log), 1)
            self.assertEqual(minute_log[0].value, 40)


class GlobalRateLimiterHelperTests(unittest.TestCase):
    """Tests covering the global get_rate_limiter helper."""

    def tearDown(self) -> None:
        rate_limiter_module._rate_limiter_manager = None

    def test_get_rate_limiter_returns_singleton(self):
        first = get_rate_limiter()
        second = get_rate_limiter()
        self.assertIs(first, second)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
