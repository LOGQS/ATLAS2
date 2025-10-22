"""Unit tests for configuration utilities."""

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from utils.config import Config, available_routes, ROUTE_MODEL_MAP


class TestConfigTokenCounting(unittest.TestCase):
    """Test token counting configuration."""

    def test_token_counting_methods(self):
        """Verify token counting method for each provider."""
        test_cases = [
            ("gemini", "native"),
            ("groq", "tiktoken"),
            ("openrouter", "tiktoken"),
            ("cerebras", "tiktoken"),
            ("huggingface", "fallback"),
            ("unknown", "fallback")
        ]
        for provider, expected_method in test_cases:
            with self.subTest(provider=provider):
                self.assertEqual(Config.get_token_counting_method(provider), expected_method)


class TestConfigGetDefaults(unittest.TestCase):
    """Test getting all defaults as a dictionary."""

    @patch('utils.config.get_provider_map', return_value={'gemini': MagicMock()})
    def test_get_defaults_contains_correct_values(self, mock_map):
        """Default values in dictionary should match individual getters and contain required keys."""
        defaults = Config.get_defaults()

        required_keys = [
            "provider", "model", "streaming",
            "rate_limit_requests_per_minute",
            "rate_limit_requests_per_hour",
            "rate_limit_requests_per_day",
            "rate_limit_tokens_per_minute",
            "rate_limit_tokens_per_hour",
            "rate_limit_tokens_per_day",
            "rate_limit_burst_size",
            "stt_use_cloud", "stt_provider", "stt_model"
        ]
        for key in required_keys:
            self.assertIn(key, defaults)

        self.assertEqual(defaults["model"], Config.get_default_model())
        self.assertEqual(defaults["streaming"], Config.get_default_streaming())
        rate_limit_defaults = Config.get_rate_limit_config()
        self.assertEqual(defaults["rate_limit_requests_per_minute"],
                         rate_limit_defaults["requests_per_minute"])
        self.assertEqual(defaults["rate_limit_requests_per_hour"],
                         rate_limit_defaults["requests_per_hour"])
        self.assertEqual(defaults["rate_limit_requests_per_day"],
                         rate_limit_defaults["requests_per_day"])
        self.assertEqual(defaults["rate_limit_tokens_per_minute"],
                         rate_limit_defaults["tokens_per_minute"])
        self.assertEqual(defaults["rate_limit_tokens_per_hour"],
                         rate_limit_defaults["tokens_per_hour"])
        self.assertEqual(defaults["rate_limit_tokens_per_day"],
                         rate_limit_defaults["tokens_per_day"])
        self.assertEqual(defaults["rate_limit_burst_size"],
                         rate_limit_defaults["burst_size"])


class TestConfigGetAvailableProviders(unittest.TestCase):
    """Test getting available providers."""

    @patch('utils.config.get_provider_map')
    def test_get_available_providers(self, mock_map):
        """Should return list of all available provider names."""
        mock_map.return_value = {
            'gemini': MagicMock(),
            'openrouter': MagicMock(),
            'groq': MagicMock()
        }

        providers = Config.get_available_providers()

        self.assertEqual(set(providers), {'gemini', 'openrouter', 'groq'})


class TestAvailableRoutes(unittest.TestCase):
    """Test available routes configuration."""

    def test_available_routes_structure(self):
        """Available routes should be a list of route definitions."""
        self.assertIsInstance(available_routes, list)
        self.assertGreater(len(available_routes), 0)

    def test_each_route_has_required_fields(self):
        """Each route should have name, description, and context."""
        for route in available_routes:
            with self.subTest(route=route.get('route_name')):
                self.assertIn('route_name', route)
                self.assertIn('route_description', route)
                self.assertIn('route_context', route)

    def test_route_names_are_unique(self):
        """Route names should be unique."""
        names = [r['route_name'] for r in available_routes]
        self.assertEqual(len(names), len(set(names)))

    def test_standard_routes_exist(self):
        """Core routes should exist."""
        names = [r['route_name'] for r in available_routes]
        expected_routes = {'direct', 'coder', 'web_researcher', 'multi_domain'}
        for route in expected_routes:
            with self.subTest(route=route):
                self.assertIn(route, names)


class TestRouteModelMap(unittest.TestCase):
    """Test route to model mapping."""

    def test_route_model_map_structure(self):
        """Route model map should be a dictionary."""
        self.assertIsInstance(ROUTE_MODEL_MAP, dict)

    def test_all_routes_have_models(self):
        """All defined routes should have model mappings."""
        route_names = [r['route_name'] for r in available_routes]
        for name in route_names:
            with self.subTest(route=name):
                self.assertIn(name, ROUTE_MODEL_MAP)

    def test_model_values_are_strings(self):
        """All model values should be strings."""
        for route, model in ROUTE_MODEL_MAP.items():
            with self.subTest(route=route):
                self.assertIsInstance(model, str)
                self.assertGreater(len(model), 0)


class TestRateLimitConfigOverrides(unittest.TestCase):
    """Test environment overrides for rate limit configuration."""

    def tearDown(self):
        os.environ.pop("ATLAS_RATE_LIMIT_REQUESTS_PER_MINUTE", None)
        os.environ.pop("ATLAS_RATE_LIMIT_REQUESTS_PER_HOUR", None)
        os.environ.pop("ATLAS_RATE_LIMIT_REQUESTS_PER_DAY", None)
        os.environ.pop("ATLAS_RATE_LIMIT_TOKENS_PER_MINUTE", None)
        os.environ.pop("ATLAS_RATE_LIMIT_TOKENS_PER_HOUR", None)
        os.environ.pop("ATLAS_RATE_LIMIT_TOKENS_PER_DAY", None)
        os.environ.pop("ATLAS_RATE_LIMIT_BURST_SIZE", None)

    def test_requests_per_minute_env_override(self):
        """Environment variable should override default RPM."""
        with patch.dict(os.environ, {"ATLAS_RATE_LIMIT_REQUESTS_PER_MINUTE": "15"}, clear=False):
            self.assertEqual(Config.get_rate_limit_requests_per_minute(), 15)

    def test_requests_per_minute_invalid_env_ignored(self):
        """Invalid RPM overrides should fall back to default."""
        with patch.dict(os.environ, {"ATLAS_RATE_LIMIT_REQUESTS_PER_MINUTE": "-5"}, clear=False):
            self.assertEqual(
                Config.get_rate_limit_requests_per_minute(),
                Config.RATE_LIMIT_REQUESTS_PER_MINUTE,
            )

    def test_burst_size_env_override_clamped(self):
        """Burst size override should be clamped to RPM and non-negative."""
        with patch.dict(os.environ, {
            "ATLAS_RATE_LIMIT_REQUESTS_PER_MINUTE": "12",
            "ATLAS_RATE_LIMIT_BURST_SIZE": "25",
        }, clear=False):
            self.assertEqual(Config.get_rate_limit_burst_size(), 12)

    def test_tokens_per_minute_env_override(self):
        """Environment variable should override token-per-minute limit."""
        with patch.dict(os.environ, {"ATLAS_RATE_LIMIT_TOKENS_PER_MINUTE": "150"}, clear=False):
            config = Config.get_rate_limit_config()
            self.assertEqual(config["tokens_per_minute"], 150)

    def test_burst_size_invalid_env_ignored(self):
        """Invalid burst overrides should fall back to default."""
        with patch.dict(os.environ, {"ATLAS_RATE_LIMIT_BURST_SIZE": "-1"}, clear=False):
            self.assertEqual(
                Config.get_rate_limit_burst_size(),
                Config.RATE_LIMIT_BURST_SIZE,
            )


class TestProviderModelOptions(unittest.TestCase):
    """Test provider and model specific option merging."""

    def setUp(self):
        self.provider_patch = patch.object(
            Config,
            "PROVIDER_DEFAULT_OPTIONS",
            {
                "gemini": {
                    "rate_limit": {
                        "requests_per_minute": 7
                    }
                }
            },
        )
        self.model_patch = patch.object(
            Config,
            "MODEL_DEFAULT_OPTIONS",
            {
                "gemini": {
                    "gemini-2.5-pro": {
                        "rate_limit": {
                            "burst_size": 2
                        }
                    }
                }
            },
        )
        self.provider_patch.start()
        self.model_patch.start()

        os.environ.pop("ATLAS_PROVIDER_OPTIONS_GEMINI", None)
        os.environ.pop("ATLAS_MODEL_OPTIONS_GEMINI_GEMINI_2_5_PRO", None)

    def tearDown(self):
        self.provider_patch.stop()
        self.model_patch.stop()
        os.environ.pop("ATLAS_PROVIDER_OPTIONS_GEMINI", None)
        os.environ.pop("ATLAS_MODEL_OPTIONS_GEMINI_GEMINI_2_5_PRO", None)

    def test_provider_options_override_global_defaults(self):
        """Provider defaults should override global settings."""
        rate_config = Config.get_rate_limit_config(provider="gemini")
        self.assertEqual(rate_config["requests_per_minute"], 7)
        # Burst falls back to global (10) but clamps to rpm (7).
        self.assertEqual(rate_config["burst_size"], 7)

    def test_model_options_override_provider_defaults(self):
        """Model options should override provider options."""
        rate_config = Config.get_rate_limit_config(
            provider="gemini",
            model="gemini-2.5-pro",
        )
        self.assertEqual(rate_config["requests_per_minute"], 7)
        self.assertEqual(rate_config["burst_size"], 2)

    def test_environment_model_options_take_precedence(self):
        """Environment supplied model options should override defaults."""
        with patch.dict(os.environ, {
            "ATLAS_MODEL_OPTIONS_GEMINI_GEMINI_2_5_PRO": '{"rate_limit": {"requests_per_minute": 5, "burst_size": 4}}'
        }, clear=False):
            rate_config = Config.get_rate_limit_config(
                provider="gemini",
                model="gemini-2.5-pro",
            )
        self.assertEqual(rate_config["requests_per_minute"], 5)
        self.assertEqual(rate_config["burst_size"], 4)




class TestSetRateLimitOverride(unittest.TestCase):
    """Test applying rate limit overrides via Config."""

    def setUp(self):
        self.patchers = [
            patch.object(Config, "PROVIDER_DEFAULT_OPTIONS", {}, create=True),
            patch.object(Config, "MODEL_DEFAULT_OPTIONS", {}, create=True),
            patch.object(Config, "RATE_LIMIT_REQUESTS_PER_MINUTE", 10),
            patch.object(Config, "RATE_LIMIT_REQUESTS_PER_HOUR", None),
            patch.object(Config, "RATE_LIMIT_REQUESTS_PER_DAY", None),
            patch.object(Config, "RATE_LIMIT_TOKENS_PER_MINUTE", None),
            patch.object(Config, "RATE_LIMIT_TOKENS_PER_HOUR", None),
            patch.object(Config, "RATE_LIMIT_TOKENS_PER_DAY", None),
            patch.object(Config, "RATE_LIMIT_BURST_SIZE", 10),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()

    def test_global_override_updates_defaults(self):
        Config.set_rate_limit_override(None, None, {"requests_per_minute": 20, "tokens_per_day": 1000})
        config = Config.get_rate_limit_config()
        self.assertEqual(config["requests_per_minute"], 20)
        self.assertEqual(config["tokens_per_day"], 1000)

    def test_provider_override_applied(self):
        Config.set_rate_limit_override("gemini", None, {"tokens_per_hour": 500})
        provider_config = Config.get_rate_limit_config(provider="gemini")
        self.assertEqual(provider_config["tokens_per_hour"], 500)
        self.assertEqual(provider_config["requests_per_minute"], 10)

    def test_provider_override_can_be_cleared(self):
        Config.set_rate_limit_override("openrouter", None, {"requests_per_minute": 5})
        self.assertEqual(Config.get_rate_limit_config(provider="openrouter")["requests_per_minute"], 5)
        Config.set_rate_limit_override("openrouter", None, {})
        self.assertEqual(Config.get_rate_limit_config(provider="openrouter"), Config.get_rate_limit_config())

    def test_model_override_applied(self):
        Config.set_rate_limit_override("gemini", "gemini-2.5-pro", {"burst_size": 3})
        model_config = Config.get_rate_limit_config(provider="gemini", model="gemini-2.5-pro")
        self.assertEqual(model_config["burst_size"], 3)

if __name__ == "__main__":
    unittest.main()