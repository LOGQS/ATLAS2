"""Unit tests for token counting utilities."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from utils.token_counter import count_tokens


class TestTokenCounterFallback(unittest.TestCase):
    """Test fallback token counting behavior."""

    def test_fallback_used_when_provider_unknown(self):
        """Unknown provider should trigger fallback counting."""
        text = "abcdefgh"
        tokens = count_tokens(text, model="any-model", provider="unknown")
        expected = max(1, len(text) // 4)  
        self.assertEqual(tokens, expected)

    def test_fallback_used_when_model_missing(self):
        """Missing model should trigger fallback counting."""
        text = "abcd"
        tokens = count_tokens(text, model="", provider="gemini")
        expected = max(1, len(text) // 4) 
        self.assertEqual(tokens, expected)

    def test_fallback_ensures_minimum_one_token(self):
        """Fallback should always return at least 1 token."""
        tokens = count_tokens("a", model="", provider="unknown")
        self.assertEqual(tokens, 1)

        tokens = count_tokens("", model="", provider="unknown")
        self.assertEqual(tokens, 1)

    def test_fallback_with_longer_text(self):
        """Fallback should scale with text length."""
        text = "a" * 100  
        tokens = count_tokens(text, model="", provider="unknown")
        expected = 100 // 4  
        self.assertEqual(tokens, expected)


class TestTokenCounterDelegation(unittest.TestCase):
    """Test delegation to context_manager for actual counting."""

    @patch("utils.token_counter.context_manager")
    def test_delegates_to_context_manager_with_valid_params(self, mock_context_manager):
        """Valid model and provider should delegate to context_manager."""
        mock_context_manager.count_tokens.return_value = 123

        tokens = count_tokens("hello world", model="flash", provider="gemini")

        mock_context_manager.count_tokens.assert_called_once_with(
            "hello world", "flash", "gemini"
        )
        self.assertEqual(tokens, 123)

    @patch("utils.token_counter.context_manager")
    def test_delegates_for_different_providers(self, mock_context_manager):
        """Different providers should all delegate when valid."""
        mock_context_manager.count_tokens.return_value = 50

        providers = ["gemini", "openrouter", "groq", "huggingface"]
        for provider in providers:
            with self.subTest(provider=provider):
                tokens = count_tokens("test text", model="some-model", provider=provider)
                self.assertEqual(tokens, 50)

    @patch("utils.token_counter.context_manager")
    def test_handles_empty_text(self, mock_context_manager):
        """Empty text should still delegate when provider is valid."""
        mock_context_manager.count_tokens.return_value = 0

        tokens = count_tokens("", model="model", provider="gemini")

        mock_context_manager.count_tokens.assert_called_once_with("", "model", "gemini")
        self.assertEqual(tokens, 0)

    @patch("utils.token_counter.context_manager")
    def test_handles_large_text(self, mock_context_manager):
        """Large text should delegate correctly."""
        mock_context_manager.count_tokens.return_value = 5000
        large_text = "word " * 1000  

        tokens = count_tokens(large_text, model="model", provider="gemini")

        self.assertEqual(tokens, 5000)


class TestTokenCounterEdgeCases(unittest.TestCase):
    """Test edge cases and boundary conditions."""

    def test_handles_various_text_types_in_fallback(self):
        """Special chars, unicode, and whitespace should all use fallback calculation."""
        test_cases = [
            ("!@#$%^&*()", "special characters"),
            ("Hello 世界 🌍", "unicode text"),
            ("line1\nline2\n\n\tline3", "newlines and whitespace")
        ]
        for text, description in test_cases:
            with self.subTest(text_type=description):
                tokens = count_tokens(text, model="", provider="unknown")
                expected = max(1, len(text) // 4)
                self.assertEqual(tokens, expected)

    @patch("utils.token_counter.context_manager")
    def test_provider_case_sensitive(self, mock_context_manager):
        """Provider name comparison should be case-sensitive."""
        mock_context_manager.count_tokens.return_value = 10

        tokens = count_tokens("test", model="m", provider="GEMINI")

        mock_context_manager.count_tokens.assert_called_once()


if __name__ == "__main__":
    unittest.main()
