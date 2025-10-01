"""Unit tests for rate limiter functionality."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

import utils.rate_limiter as rate_limiter_module
from utils.rate_limiter import RateLimiter, get_rate_limiter


class TestRateLimiterBurstBehavior(unittest.TestCase):
    """Test burst allowance behavior."""

    def tearDown(self):
        """Reset global rate limiter after each test."""
        rate_limiter_module._rate_limiter = None

    def test_allows_burst_requests_without_delay(self):
        """Burst-size requests should execute immediately without waiting."""
        limiter = RateLimiter(requests_per_minute=5, burst_size=2)
        calls = []

        def callback(value):
            calls.append(value)
            return value * 2

        result_one = limiter.execute(callback, "burst_test", 21)
        result_two = limiter.execute(callback, "burst_test", 3)

        self.assertEqual(result_one, 42)
        self.assertEqual(result_two, 6)
        self.assertEqual(calls, [21, 3])

        tracker, _ = limiter._get_tracker("burst_test")
        self.assertEqual(len(tracker), 2)

    def test_burst_size_of_zero_enforces_strict_limiting(self):
        """Burst size of 0 should enforce rate limit on first request."""
        limiter = RateLimiter(requests_per_minute=60, burst_size=0)

        with patch("utils.rate_limiter.time.time", return_value=100.0):
            tracker, lock = limiter._get_tracker("strict")
            with lock:
                tracker.append(100.0)

        callback = Mock(return_value="done")

        with patch("utils.rate_limiter.time.time", return_value=100.5), \
                patch("utils.rate_limiter.time.sleep") as mock_sleep:
            result = limiter.execute(callback, "strict")

        mock_sleep.assert_called_once()
        self.assertGreater(mock_sleep.call_args[0][0], 0)


class TestRateLimiterWaitCalculation(unittest.TestCase):
    """Test wait time calculation and enforcement."""

    def tearDown(self):
        """Reset global rate limiter after each test."""
        rate_limiter_module._rate_limiter = None

    def test_calculates_correct_wait_time_after_burst(self):
        """After burst is exhausted, wait time should be calculated correctly."""
        limiter = RateLimiter(requests_per_minute=2, burst_size=1)
        tracker, lock = limiter._get_tracker("wait_calc")

        with lock:
            tracker.append(0.0)

        callback = Mock(return_value="done")

        with patch("utils.rate_limiter.time.time", return_value=0.0), \
                patch("utils.rate_limiter.time.sleep") as mock_sleep:
            result = limiter.execute(callback, "wait_calc")

        mock_sleep.assert_called_once()
        wait_time = mock_sleep.call_args[0][0]
        expected_wait = 30.0  
        self.assertAlmostEqual(wait_time, expected_wait, places=1)
        callback.assert_called_once_with()
        self.assertEqual(result, "done")

    def test_validates_wait_time_calculation(self):
        """Wait time should be correctly bounded by 60 second window."""
        limiter = RateLimiter(requests_per_minute=2, burst_size=0)
        tracker, lock = limiter._get_tracker("bounded")

        with lock:
            tracker.extend([0.0, 30.0])

        with patch("utils.rate_limiter.time.time", return_value=31.0):
            wait_time = limiter._calculate_wait_time(tracker, 31.0)
            self.assertAlmostEqual(wait_time, 29.0, places=1)


class TestRateLimiterTrackerManagement(unittest.TestCase):
    """Test tracker creation and cleanup."""

    def tearDown(self):
        """Reset global rate limiter after each test."""
        rate_limiter_module._rate_limiter = None

    def test_creates_separate_trackers_for_different_keys(self):
        """Each unique key should have its own tracker."""
        limiter = RateLimiter(requests_per_minute=5, burst_size=2)

        limiter.execute(lambda: "a", "key_a")
        limiter.execute(lambda: "b", "key_b")

        tracker_a, _ = limiter._get_tracker("key_a")
        tracker_b, _ = limiter._get_tracker("key_b")

        self.assertEqual(len(tracker_a), 1)
        self.assertEqual(len(tracker_b), 1)
        self.assertIsNot(tracker_a, tracker_b)

    def test_cleanup_removes_old_requests(self):
        """Requests older than 60 seconds should be removed from tracker."""
        limiter = RateLimiter(requests_per_minute=10, burst_size=5)
        tracker, lock = limiter._get_tracker("cleanup_test")

        with lock:
            tracker.extend([0.0, 30.0, 65.0, 100.0])

        current_time = 125.0  
        limiter._cleanup_old(tracker, current_time)

        self.assertEqual(len(tracker), 2)
        self.assertEqual(list(tracker), [65.0, 100.0])


class TestRateLimiterStatusCheck(unittest.TestCase):
    """Test status reporting functionality."""

    def tearDown(self):
        """Reset global rate limiter after each test."""
        rate_limiter_module._rate_limiter = None

    def test_check_status_reports_accurate_state(self):
        """Status should accurately reflect current limiter state."""
        limiter = RateLimiter(requests_per_minute=5, burst_size=2)
        tracker, lock = limiter._get_tracker("status_check")

        with lock:
            tracker.extend([10.0, 50.0])

        with patch("utils.rate_limiter.time.time", return_value=55.0):
            status = limiter.check_status("status_check")

        self.assertEqual(status["requests_in_window"], 2)
        self.assertEqual(status["requests_per_minute"], 5)
        self.assertEqual(status["burst_size"], 2)
        self.assertAlmostEqual(status["next_available"], 62.0, places=1)

    def test_check_status_for_new_key(self):
        """Status for a new key should show empty state."""
        limiter = RateLimiter(requests_per_minute=10, burst_size=5)

        status = limiter.check_status("new_key")

        self.assertEqual(status["requests_in_window"], 0)
        self.assertEqual(status["requests_per_minute"], 10)


class TestRateLimiterSingleton(unittest.TestCase):
    """Test singleton pattern for global rate limiter."""

    def tearDown(self):
        """Reset global rate limiter after each test."""
        rate_limiter_module._rate_limiter = None

    def test_get_rate_limiter_returns_singleton(self):
        """Multiple calls should return the same instance."""
        rate_limiter_module._rate_limiter = None

        limiter_one = get_rate_limiter(requests_per_minute=7, burst_size=3)
        limiter_two = get_rate_limiter()

        self.assertIs(limiter_one, limiter_two)
        self.assertEqual(limiter_two.requests_per_minute, 7)
        self.assertEqual(limiter_two.burst_size, 3)

    def test_singleton_ignores_subsequent_parameters(self):
        """After initialization, new parameters should be ignored."""
        rate_limiter_module._rate_limiter = None

        limiter_one = get_rate_limiter(requests_per_minute=10, burst_size=5)
        limiter_two = get_rate_limiter(requests_per_minute=999, burst_size=999)

        self.assertIs(limiter_one, limiter_two)
        self.assertEqual(limiter_two.requests_per_minute, 10)
        self.assertEqual(limiter_two.burst_size, 5)


class TestRateLimiterEdgeCases(unittest.TestCase):
    """Test edge cases and error handling."""

    def tearDown(self):
        """Reset global rate limiter after each test."""
        rate_limiter_module._rate_limiter = None

    def test_handles_callback_exceptions(self):
        """Exceptions in callbacks should propagate correctly."""
        limiter = RateLimiter(requests_per_minute=10, burst_size=5)

        def failing_callback():
            raise ValueError("Test error")

        with self.assertRaises(ValueError) as ctx:
            limiter.execute(failing_callback, "error_test")

        self.assertEqual(str(ctx.exception), "Test error")

        tracker, _ = limiter._get_tracker("error_test")
        self.assertEqual(len(tracker), 1)

    def test_passes_arguments_to_callback(self):
        """Callback should receive all args and kwargs correctly."""
        limiter = RateLimiter(requests_per_minute=10, burst_size=5)

        def callback_with_args(a, b, c=None):
            return f"{a}-{b}-{c}"

        result = limiter.execute(callback_with_args, "args_test", "x", "y", c="z")

        self.assertEqual(result, "x-y-z")


if __name__ == "__main__":
    unittest.main()
