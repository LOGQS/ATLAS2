"""Unit tests for configuration utilities."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

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

        required_keys = ["provider", "model", "streaming", "rate_limit_requests_per_minute",
                        "rate_limit_burst_size", "stt_use_cloud", "stt_provider", "stt_model"]
        for key in required_keys:
            self.assertIn(key, defaults)

        self.assertEqual(defaults["model"], Config.get_default_model())
        self.assertEqual(defaults["streaming"], Config.get_default_streaming())
        self.assertEqual(defaults["rate_limit_requests_per_minute"],
                        Config.get_rate_limit_requests_per_minute())


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
        """Standard routes (simple, complex, fast, taskflow) should exist."""
        names = [r['route_name'] for r in available_routes]
        self.assertIn('simple', names)
        self.assertIn('complex', names)


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


if __name__ == "__main__":
    unittest.main()
