"""Tests for rate limit API endpoint and usage aggregation."""

import sys
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, Mock

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

# Mock flask before importing route module
sys.modules['flask'] = Mock()

from route.rate_limit_route import _aggregate_usage_for_scope, _has_any_limits  # noqa: E402


class TestUsageAggregation(unittest.TestCase):
    """Test usage aggregation across multiple scopes."""

    def test_aggregates_counts_across_keys(self):
        """Should sum usage counts from all matching keys with valid expirations."""
        now = time.time()
        all_usage = {
            "gemini:model-a": {
                "requests": {"minute": 5, "hour": 20, "day": 100},
                "tokens": {"minute": 1000, "hour": 5000, "day": 20000},
                "expires_at": {
                    "requests_minute": now + 30,  # Valid
                    "requests_hour": now + 1800,
                    "requests_day": now + 43200,
                    "tokens_minute": now + 30,
                    "tokens_hour": now + 1800,
                    "tokens_day": now + 43200,
                }
            },
            "gemini:model-b": {
                "requests": {"minute": 3, "hour": 10, "day": 50},
                "tokens": {"minute": 500, "hour": 2500, "day": 10000},
                "expires_at": {
                    "requests_minute": now + 45,  # Valid
                    "requests_hour": now + 2000,
                    "requests_day": now + 50000,
                    "tokens_minute": now + 45,
                    "tokens_hour": now + 2000,
                    "tokens_day": now + 50000,
                }
            },
            "openai:gpt-4": {
                "requests": {"minute": 2, "hour": 8, "day": 40},
                "tokens": {"minute": 400, "hour": 2000, "day": 8000},
                "expires_at": {
                    "requests_minute": now + 20,  # Valid
                    "requests_hour": now + 1500,
                    "requests_day": now + 40000,
                    "tokens_minute": now + 20,
                    "tokens_hour": now + 1500,
                    "tokens_day": now + 40000,
                }
            }
        }

        result = _aggregate_usage_for_scope(all_usage, "gemini")

        # Should only sum gemini models (all still valid)
        self.assertEqual(result["requests_per_minute"], 8)  # 5 + 3
        self.assertEqual(result["requests_per_hour"], 30)   # 20 + 10
        self.assertEqual(result["requests_per_day"], 150)   # 100 + 50
        self.assertEqual(result["tokens_per_minute"], 1500) # 1000 + 500
        self.assertEqual(result["tokens_per_hour"], 7500)   # 5000 + 2500
        self.assertEqual(result["tokens_per_day"], 30000)   # 20000 + 10000

    def test_aggregates_all_when_no_filter(self):
        """Without scope filter, should aggregate all keys."""
        now = time.time()
        all_usage = {
            "gemini:model-a": {
                "requests": {"minute": 5, "hour": 20, "day": 100},
                "tokens": {"minute": 1000, "hour": 5000, "day": 20000},
                "expires_at": {
                    "requests_minute": now + 30,
                    "tokens_hour": now + 1800,
                }
            },
            "openai:gpt-4": {
                "requests": {"minute": 2, "hour": 8, "day": 40},
                "tokens": {"minute": 400, "hour": 2000, "day": 8000},
                "expires_at": {
                    "requests_minute": now + 45,
                    "tokens_hour": now + 2000,
                }
            }
        }

        result = _aggregate_usage_for_scope(all_usage, scope_filter=None)

        # Should sum everything
        self.assertEqual(result["requests_per_minute"], 7)   # 5 + 2
        self.assertEqual(result["tokens_per_hour"], 7000)    # 5000 + 2000

    def test_excludes_expired_usage_from_aggregation(self):
        """CRITICAL: Should exclude expired entries from aggregation counts."""
        now = time.time()
        all_usage = {
            "gemini:model-a": {
                "requests": {"minute": 5, "hour": 20, "day": 100},
                "tokens": {"minute": 1000, "hour": 5000, "day": 20000},
                "expires_at": {
                    "requests_minute": now - 10,  # EXPIRED (10 seconds ago)
                    "requests_hour": now + 1800,  # Valid
                    "requests_day": now + 43200,  # Valid
                    "tokens_minute": now + 30,    # Valid
                    "tokens_hour": now - 100,     # EXPIRED
                    "tokens_day": now + 43200,    # Valid
                }
            },
            "gemini:model-b": {
                "requests": {"minute": 3, "hour": 10, "day": 50},
                "tokens": {"minute": 500, "hour": 2500, "day": 10000},
                "expires_at": {
                    "requests_minute": now + 45,  # Valid
                    "requests_hour": now + 2000,  # Valid
                    "requests_day": now - 5000,   # EXPIRED
                    "tokens_minute": now + 45,    # Valid
                    "tokens_hour": now + 2000,    # Valid
                    "tokens_day": now + 50000,    # Valid
                }
            }
        }

        result = _aggregate_usage_for_scope(all_usage, "gemini")

        # Minute: model-a expired (5), only model-b counted (3)
        self.assertEqual(result["requests_per_minute"], 3)  # NOT 8!

        # Hour: both valid (20 + 10)
        self.assertEqual(result["requests_per_hour"], 30)

        # Day: model-b expired (50), only model-a counted (100)
        self.assertEqual(result["requests_per_day"], 100)  # NOT 150!

        # Tokens minute: both valid (1000 + 500)
        self.assertEqual(result["tokens_per_minute"], 1500)

        # Tokens hour: model-a expired (5000), only model-b counted (2500)
        self.assertEqual(result["tokens_per_hour"], 2500)  # NOT 7500!

        # Tokens day: both valid (20000 + 10000)
        self.assertEqual(result["tokens_per_day"], 30000)

    def test_tracks_earliest_expiration_per_window(self):
        """Should track the earliest expiration timestamp for each window."""
        now = time.time()
        all_usage = {
            "gemini:model-a": {
                "requests": {"minute": 2},
                "tokens": {"minute": 1000},
                "expires_at": {
                    "requests_minute": now + 50,  # Later expiration
                    "tokens_minute": now + 30,    # Earlier expiration
                }
            },
            "gemini:model-b": {
                "requests": {"minute": 3},
                "tokens": {"minute": 500},
                "expires_at": {
                    "requests_minute": now + 40,  # Earlier expiration
                    "tokens_minute": now + 45,    # Later expiration
                }
            }
        }

        result = _aggregate_usage_for_scope(all_usage, "gemini")

        # Should pick earliest (soonest) expiration from each window
        self.assertAlmostEqual(
            result["expires_at"]["requests_minute"],
            now + 40,  # Earlier of 50 and 40
            delta=0.01
        )
        self.assertAlmostEqual(
            result["expires_at"]["tokens_minute"],
            now + 30,  # Earlier of 30 and 45
            delta=0.01
        )

    def test_excludes_none_expirations(self):
        """None expiration timestamps should be ignored in aggregation."""
        now = time.time()
        all_usage = {
            "gemini:model-a": {
                "requests": {"minute": 2},
                "tokens": {},
                "expires_at": {
                    "requests_minute": now + 30,
                }
            },
            "gemini:model-b": {
                "requests": {"minute": 3},
                "tokens": {},
                "expires_at": {
                    "requests_minute": None,  # Should be ignored
                }
            }
        }

        result = _aggregate_usage_for_scope(all_usage, "gemini")

        # Should only use model-a's expiration
        self.assertAlmostEqual(
            result["expires_at"]["requests_minute"],
            now + 30,
            delta=0.01
        )
        # model-a valid (2) + model-b has None expiration so ignored (0)
        self.assertEqual(result["requests_per_minute"], 2)

    def test_handles_missing_usage_data(self):
        """Should handle keys with missing or incomplete usage data."""
        now = time.time()
        all_usage = {
            "gemini:model-a": {
                "requests": {"minute": 5},
                "tokens": {},
                "expires_at": {
                    "requests_minute": now + 20,
                }
            },
            "gemini:model-b": {
                "requests": {},  # No requests
                "tokens": {"minute": 1000},
                "expires_at": {
                    "tokens_minute": now + 40,
                }
            }
        }

        result = _aggregate_usage_for_scope(all_usage, "gemini")

        self.assertEqual(result["requests_per_minute"], 5)
        self.assertEqual(result["tokens_per_minute"], 1000)
        self.assertEqual(len(result["expires_at"]), 2)  # Should have both entries


class TestHasAnyLimits(unittest.TestCase):
    """Test _has_any_limits helper function."""

    def test_returns_true_when_any_limit_defined(self):
        """Should return True if at least one limit is not None."""
        limits = {
            "requests_per_minute": None,
            "requests_per_hour": None,
            "tokens_per_minute": 1000,
            "tokens_per_hour": None,
            "burst_size": None,
        }

        self.assertTrue(_has_any_limits(limits))

    def test_returns_false_when_all_none(self):
        """Should return False if all limits are None."""
        limits = {
            "requests_per_minute": None,
            "requests_per_hour": None,
            "tokens_per_minute": None,
            "burst_size": None,
        }

        self.assertFalse(_has_any_limits(limits))

    def test_returns_false_for_empty_dict(self):
        """Should return False for empty dict."""
        self.assertFalse(_has_any_limits({}))

    def test_returns_true_for_zero_limit(self):
        """Zero is a valid limit (blocks all requests), should return True."""
        limits = {
            "requests_per_minute": 0,
            "tokens_per_minute": None,
        }

        self.assertTrue(_has_any_limits(limits))


class TestScopeFiltering(unittest.TestCase):
    """Test that scope filtering works correctly with startswith logic."""

    def test_exact_match_filtering(self):
        """Should match keys that start with exact scope."""
        now = time.time()
        all_usage = {
            "gemini:model-a": {
                "requests": {"minute": 5},
                "tokens": {},
                "expires_at": {
                    "requests_minute": now + 30,
                }
            },
            "gemini-2:model-b": {  # Should not match "gemini"
                "requests": {"minute": 3},
                "tokens": {},
                "expires_at": {
                    "requests_minute": now + 30,
                }
            }
        }

        result = _aggregate_usage_for_scope(all_usage, "gemini:")

        # Only gemini:model-a should match
        self.assertEqual(result["requests_per_minute"], 5)

    def test_provider_scope_matches_all_models(self):
        """Provider scope should match all models under that provider."""
        now = time.time()
        all_usage = {
            "gemini:flash": {
                "requests": {"minute": 2},
                "tokens": {},
                "expires_at": {
                    "requests_minute": now + 30,
                }
            },
            "gemini:pro": {
                "requests": {"minute": 3},
                "tokens": {},
                "expires_at": {
                    "requests_minute": now + 30,
                }
            },
            "openai:gpt-4": {
                "requests": {"minute": 5},
                "tokens": {},
                "expires_at": {
                    "requests_minute": now + 30,
                }
            }
        }

        result = _aggregate_usage_for_scope(all_usage, "gemini")

        # Should match both gemini models
        self.assertEqual(result["requests_per_minute"], 5)

    def test_global_scope_matches_everything(self):
        """Global scope (no filter) should match all keys."""
        now = time.time()
        all_usage = {
            "gemini:model": {
                "requests": {"minute": 2},
                "tokens": {},
                "expires_at": {
                    "requests_minute": now + 30,
                }
            },
            "openai:model": {
                "requests": {"minute": 3},
                "tokens": {},
                "expires_at": {
                    "requests_minute": now + 30,
                }
            },
            "global": {  # Even global key itself
                "requests": {"minute": 1},
                "tokens": {},
                "expires_at": {
                    "requests_minute": now + 30,
                }
            }
        }

        result = _aggregate_usage_for_scope(all_usage, scope_filter=None)

        # Should sum all
        self.assertEqual(result["requests_per_minute"], 6)


if __name__ == "__main__":
    unittest.main()
