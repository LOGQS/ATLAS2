"""Tests for multi-scope rate limiting behavior with SQLite backend."""

import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from utils.config import Config  # noqa: E402
from utils.rate_limiter import RateLimiterManager  # noqa: E402
from utils.db_utils import db  # noqa: E402


class TestMultiScopeRateLimiting(unittest.TestCase):
    """Test multi-scope rate limiting where requests check model + provider + global."""

    def setUp(self):
        """Set up test with fresh rate limiter and clean database."""
        self.manager = RateLimiterManager()
        # Clean up rate limit usage table before each test
        with db.get_connection() as conn:
            conn.execute("DELETE FROM rate_limit_usage")
            conn.commit()

    def tearDown(self):
        """Clean up after test."""
        with db.get_connection() as conn:
            conn.execute("DELETE FROM rate_limit_usage")
            conn.commit()

    @patch.object(Config, 'get_rate_limit_keys_to_check')
    def test_check_and_reserve_records_in_all_scopes(self, mock_get_keys):
        """Should record usage in model, provider, and global scopes."""
        mock_get_keys.return_value = [
            ("gemini:model-a", {"requests_per_minute": 100}),
            ("gemini", {"requests_per_minute": 100}),
            ("global", {"requests_per_minute": 100}),
        ]

        # Reserve capacity
        self.manager.check_and_reserve("gemini", "model-a", estimated_tokens=1000)

        # Check that all three scopes have usage recorded in SQLite
        with db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT scope_key, request_count FROM rate_limit_usage WHERE window = 'minute'")
            results = {row["scope_key"]: row["request_count"] for row in cursor.fetchall()}

        self.assertEqual(results.get("gemini:model-a"), 1)
        self.assertEqual(results.get("gemini"), 1)
        self.assertEqual(results.get("global"), 1)

    @patch.object(Config, 'get_rate_limit_keys_to_check')
    def test_enforces_strictest_limit_across_scopes(self, mock_get_keys):
        """When multiple scopes have limits, the strictest one should cause wait."""
        mock_get_keys.return_value = [
            ("gemini:model-a", {"requests_per_minute": 10}),
            ("gemini", {"requests_per_minute": 2}),  # Stricter
        ]

        with patch("utils.rate_limiter.time.sleep") as mock_sleep:
            # First two requests should succeed
            self.manager.check_and_reserve("gemini", "model-a", 0)
            self.manager.check_and_reserve("gemini", "model-a", 0)
            self.assertEqual(mock_sleep.call_count, 0)

            # Third request hits provider limit
            self.manager.check_and_reserve("gemini", "model-a", 0)
            self.assertTrue(mock_sleep.called, "Should wait when hitting provider limit")

    def test_usage_snapshot_reflects_sqlite_data(self):
        """Usage snapshot should read from SQLite."""
        # Manually insert data into SQLite
        now = time.time()
        with db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO rate_limit_usage
                (scope_key, window, request_count, token_count, oldest_request_ts, oldest_token_ts, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ("test-scope", "minute", 5, 1000, now - 30, now - 30, now)
            )
            conn.commit()

        # Get snapshot
        snapshot = self.manager.get_usage_snapshot("test-scope")

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["requests"]["minute"], 5)
        self.assertEqual(snapshot["tokens"]["minute"], 1000)

    def test_expired_entries_not_counted(self):
        """Entries older than window should not be counted in usage."""
        now = time.time()

        # Insert expired entry (65 seconds ago for minute window)
        with db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO rate_limit_usage
                (scope_key, window, request_count, token_count, oldest_request_ts, oldest_token_ts, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ("test-expired", "minute", 5, 1000, now - 65, now - 65, now - 65)
            )
            conn.commit()

        # Get snapshot - should show 0 because entry is expired
        snapshot = self.manager.get_usage_snapshot("test-expired")

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["requests"]["minute"], 0, "Expired entries should not be counted")
        self.assertEqual(snapshot["tokens"]["minute"], 0, "Expired tokens should not be counted")


class TestConfigGetRateLimitKeysToCheck(unittest.TestCase):
    """Test Config.get_rate_limit_keys_to_check returns correct scopes."""

    @patch.object(Config, 'get_rate_limit_config')
    def test_always_includes_model_scope(self, mock_get_config):
        """Model scope should always be included."""
        mock_get_config.return_value = {}

        keys = Config.get_rate_limit_keys_to_check("gemini", "model-a")

        self.assertEqual(len(keys), 1)
        self.assertEqual(keys[0][0], "gemini:model-a")

    @patch.object(Config, 'get_rate_limit_config')
    def test_includes_provider_when_has_limits(self, mock_get_config):
        """Provider scope included only if it has defined limits."""
        def config_side_effect(provider=None, model=None):
            if model:
                return {}  # Model has no limits
            elif provider:
                return {"requests_per_minute": 10}  # Provider has limit
            return {}

        mock_get_config.side_effect = config_side_effect

        keys = Config.get_rate_limit_keys_to_check("gemini", "model-a")

        self.assertEqual(len(keys), 2)
        self.assertEqual(keys[0][0], "gemini:model-a")
        self.assertEqual(keys[1][0], "gemini")

    @patch.object(Config, 'get_rate_limit_config')
    def test_includes_global_when_has_limits(self, mock_get_config):
        """Global scope included only if it has defined limits."""
        def config_side_effect(provider=None, model=None):
            if model:
                return {}
            elif provider:
                return {}
            return {"tokens_per_hour": 1000000}  # Global has limit

        mock_get_config.side_effect = config_side_effect

        keys = Config.get_rate_limit_keys_to_check("gemini", "model-a")

        self.assertEqual(len(keys), 2)
        self.assertEqual(keys[0][0], "gemini:model-a")
        self.assertEqual(keys[1][0], "global")


if __name__ == "__main__":
    unittest.main()
