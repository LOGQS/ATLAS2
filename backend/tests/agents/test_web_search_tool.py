"""Unit tests for web search tool.

This module tests the web.search tool including:
- Markdown parsing and result extraction
- Text normalization and cleaning
- URL validation and filtering
- CAPTCHA detection
- Search result formatting
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock, AsyncMock

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.tools.tool_registry import ToolExecutionContext, ToolResult
from agents.tools.web_ops.web_search_func import (
    _tool_web_search,
    _normalize_text,
    _clean_url,
    _fallback_source_from_url,
    _is_source_candidate,
    _is_noise_line,
    _extract_date_fragment,
    _detect_captcha,
    _extract_results_from_google_markdown,
    _format_search_results,
)


class TestTextNormalization(unittest.TestCase):
    """Test text normalization utilities."""

    def test_normalize_text_removes_markdown(self):
        """Should remove markdown characters and normalize whitespace."""
        result = _normalize_text("This is **bold** and _italic_ text")
        self.assertEqual(result, "This is bold and italic text")

    def test_normalize_text_collapses_whitespace(self):
        """Should collapse multiple spaces into one."""
        result = _normalize_text("Multiple    spaces   here")
        self.assertEqual(result, "Multiple spaces here")

    def test_normalize_text_strips_special_chars(self):
        """Should strip leading/trailing special characters."""
        result = _normalize_text("  - Content here - ")
        self.assertEqual(result, "Content here")

    def test_normalize_text_empty_string(self):
        """Should handle empty strings."""
        result = _normalize_text("")
        self.assertEqual(result, "")


class TestURLCleaning(unittest.TestCase):
    """Test URL cleaning and validation."""

    def test_clean_url_removes_text_fragments(self):
        """Should remove scroll-to-text fragments."""
        url = "https://example.com/page#:~:text=some%20text"
        result = _clean_url(url)
        self.assertEqual(result, "https://example.com/page")

    def test_clean_url_removes_trailing_punctuation(self):
        """Should remove trailing punctuation."""
        url = "https://example.com/page,;"
        result = _clean_url(url)
        self.assertEqual(result, "https://example.com/page")

    def test_clean_url_preserves_clean_urls(self):
        """Should preserve already clean URLs."""
        url = "https://example.com/page"
        result = _clean_url(url)
        self.assertEqual(result, url)

    def test_fallback_source_from_url(self):
        """Should extract domain name as source."""
        url = "https://www.example.com/article"
        result = _fallback_source_from_url(url)
        self.assertEqual(result, "Example")

    def test_fallback_source_handles_short_domains(self):
        """Should uppercase short domains."""
        url = "https://www.cnn.com/news"
        result = _fallback_source_from_url(url)
        self.assertEqual(result, "CNN")


class TestContentFiltering(unittest.TestCase):
    """Test content filtering utilities."""

    def test_is_source_candidate_valid_source(self):
        """Should identify valid source candidates."""
        self.assertTrue(_is_source_candidate("BBC"))
        self.assertTrue(_is_source_candidate("The New York Times"))

    def test_is_source_candidate_rejects_urls(self):
        """Should reject URLs."""
        self.assertFalse(_is_source_candidate("https://example.com"))
        self.assertFalse(_is_source_candidate("www.example.com"))

    def test_is_source_candidate_rejects_markdown(self):
        """Should reject markdown links."""
        self.assertFalse(_is_source_candidate("[Link text](url)"))
        self.assertFalse(_is_source_candidate("### Header"))

    def test_is_noise_line_detects_noise(self):
        """Should detect noise keywords."""
        self.assertTrue(_is_noise_line("People also ask"))
        self.assertTrue(_is_noise_line("Related searches"))
        self.assertTrue(_is_noise_line("Top stories"))

    def test_is_noise_line_accepts_content(self):
        """Should accept actual content."""
        self.assertFalse(_is_noise_line("This is actual article content"))

    def test_extract_date_fragment_finds_dates(self):
        """Should extract date fragments."""
        text = "Published on Jan 15, 2024 by Author"
        result = _extract_date_fragment(text)
        self.assertEqual(result, "Jan 15, 2024")

    def test_extract_date_fragment_iso_format(self):
        """Should extract ISO format dates."""
        text = "Updated: 2024-01-15"
        result = _extract_date_fragment(text)
        self.assertEqual(result, "2024-01-15")


class TestCaptchaDetection(unittest.TestCase):
    """Test CAPTCHA detection."""

    def test_detect_captcha_finds_indicators(self):
        """Should detect CAPTCHA indicators."""
        content = "We've detected unusual traffic from your network"
        self.assertTrue(_detect_captcha(content))

    def test_detect_captcha_case_insensitive(self):
        """Should be case insensitive."""
        content = "Please verify you're not a ROBOT"
        self.assertTrue(_detect_captcha(content))

    def test_detect_captcha_no_false_positives(self):
        """Should not detect CAPTCHA in normal content."""
        content = "This is a normal search result page"
        self.assertFalse(_detect_captcha(content))


class TestMarkdownExtraction(unittest.TestCase):
    """Test extraction of results from Google markdown."""

    def test_extract_results_from_markdown(self):
        """Should extract structured results from markdown."""
        markdown = """
### [Example Article Title](https://example.com/article)
Example Source
This is a snippet of the article. It contains information about the topic.
Jan 15, 2024
"""
        results = _extract_results_from_google_markdown(markdown)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["title"], "Example Article Title")
        self.assertEqual(results[0]["url"], "https://example.com/article")
        self.assertIn("snippet", results[0])
        self.assertEqual(results[0]["source"], "Example Source")

    def test_extract_results_filters_google_urls(self):
        """Should filter out Google internal URLs."""
        markdown = """
### [Search Result](https://example.com/article)
Example
Content here

### [Google Link](https://www.google.com/search?q=test)
Google
More content
"""
        results = _extract_results_from_google_markdown(markdown)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["url"], "https://example.com/article")

    def test_extract_results_deduplicates_urls(self):
        """Should deduplicate URLs."""
        markdown = """
### [First](https://example.com/page)
Source
Content

### [Duplicate](https://example.com/page)
Source
Content
"""
        results = _extract_results_from_google_markdown(markdown)

        self.assertEqual(len(results), 1)

    def test_extract_results_handles_missing_dates(self):
        """Should handle results without dates."""
        markdown = """
### [Article](https://example.com/article)
Source
Content without date information
"""
        results = _extract_results_from_google_markdown(markdown)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["date"], "N/A")


class TestResultFormatting(unittest.TestCase):
    """Test search result formatting."""

    def test_format_search_results_success(self):
        """Should format successful search results."""
        results_by_query = {
            "test query": {
                "status": "success",
                "results": [
                    {
                        "title": "Test Article",
                        "url": "https://example.com/article",
                        "snippet": "Article snippet",
                        "date": "Jan 15, 2024",
                        "source": "Example"
                    }
                ]
            }
        }

        formatted = _format_search_results(results_by_query)

        self.assertIn("test query", formatted)
        self.assertIn("Test Article", formatted)
        self.assertIn("https://example.com/article", formatted)
        self.assertIn("Article snippet", formatted)

    def test_format_search_results_error(self):
        """Should format error results."""
        results_by_query = {
            "test query": {
                "status": "error",
                "error": "Network error",
                "results": []
            }
        }

        formatted = _format_search_results(results_by_query)

        self.assertIn("ERROR", formatted)
        self.assertIn("Network error", formatted)

    def test_format_search_results_no_results(self):
        """Should handle no results."""
        results_by_query = {
            "test query": {
                "status": "success",
                "results": []
            }
        }

        formatted = _format_search_results(results_by_query)

        self.assertIn("No results found", formatted)


class TestWebSearchTool(unittest.TestCase):
    """Test the main web.search tool function."""

    def setUp(self):
        """Create test context."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_search"
        )

    def test_web_search_validates_query_param(self):
        """Should validate query parameter is provided."""
        with self.assertRaises(ValueError) as cm:
            _tool_web_search({}, self.ctx)

        self.assertIn("query parameter is required", str(cm.exception))

    def test_web_search_accepts_string_query(self):
        """Should accept string query and convert to list."""
        with patch('agents.tools.web_ops.web_search_func._search_google_with_retry') as mock_search:
            mock_search.return_value = []

            result = _tool_web_search({"query": "test query"}, self.ctx)

            self.assertIsInstance(result, ToolResult)
            self.assertEqual(result.output["queries_processed"], 1)

    def test_web_search_accepts_list_query(self):
        """Should accept list of queries."""
        with patch('agents.tools.web_ops.web_search_func._search_google_with_retry') as mock_search:
            mock_search.return_value = []

            result = _tool_web_search({"query": ["query1", "query2"]}, self.ctx)

            self.assertIsInstance(result, ToolResult)
            self.assertEqual(result.output["queries_processed"], 2)

    def test_web_search_validates_results_per_query(self):
        """Should validate results_per_query parameter."""
        with self.assertRaises(ValueError) as cm:
            _tool_web_search({"query": "test", "results_per_query": 0}, self.ctx)

        self.assertIn("positive integer", str(cm.exception))

    def test_web_search_enforces_max_results(self):
        """Should enforce maximum results limit."""
        with self.assertRaises(ValueError) as cm:
            _tool_web_search({"query": "test", "results_per_query": 15}, self.ctx)

        self.assertIn("cannot exceed 10", str(cm.exception))

    @patch('utils.web_browser_profile.check_profile_exists')
    @patch('utils.web_browser_profile.get_profile_status')
    @patch('agents.tools.web_ops.web_search_func._search_google_with_retry')
    def test_web_search_successful_search(self, mock_search, mock_status, mock_profile):
        """Should successfully perform search and return results."""
        mock_profile.return_value = True
        mock_status.return_value = {"path": "/fake/path"}
        mock_search.return_value = [
            {
                "title": "Test Result",
                "url": "https://example.com",
                "snippet": "Test snippet",
                "date": "Jan 15, 2024",
                "source": "Example"
            }
        ]

        result = _tool_web_search({"query": "test", "results_per_query": 5}, self.ctx)

        self.assertIsInstance(result, ToolResult)
        self.assertEqual(result.output["status"], "completed")
        self.assertEqual(result.output["queries_successful"], 1)
        self.assertEqual(result.output["queries_failed"], 0)
        self.assertEqual(result.output["total_results"], 1)
        self.assertTrue(result.output["profile_ready"])

    @patch('utils.web_browser_profile.check_profile_exists')
    @patch('utils.web_browser_profile.get_profile_status')
    @patch('agents.tools.web_ops.web_search_func._search_google_with_retry')
    def test_web_search_handles_errors(self, mock_search, mock_status, mock_profile):
        """Should handle search errors gracefully."""
        mock_profile.return_value = False
        mock_status.return_value = {"path": "/fake/path"}
        mock_search.side_effect = RuntimeError("Network error")

        result = _tool_web_search({"query": "test"}, self.ctx)

        self.assertIsInstance(result, ToolResult)
        self.assertEqual(result.output["queries_failed"], 1)
        self.assertIn("error", result.output["results_by_query"]["test"])


if __name__ == "__main__":
    unittest.main()
