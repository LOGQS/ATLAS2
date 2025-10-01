"""Unit tests for router response format validation."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from utils.format_validator import extract_route_choice, validate_router_response_format


class TestExtractRouteChoice(unittest.TestCase):
    """Test extraction of route choice from router responses."""

    @patch('utils.config.available_routes', [
        {"route_name": "simple"},
        {"route_name": "complex"},
        {"route_name": "fast"}
    ])
    def test_extracts_valid_route_choice(self):
        """Valid route choice should be extracted correctly."""
        response = "<ROUTE><CHOICE>simple</CHOICE></ROUTE>"
        self.assertEqual(extract_route_choice(response), "simple")

    @patch('utils.config.available_routes', [
        {"route_name": "simple"},
        {"route_name": "complex"}
    ])
    def test_extracts_with_whitespace(self):
        """Route choice with surrounding whitespace should be trimmed."""
        response = """
        <ROUTE>
            <CHOICE>  complex  </CHOICE>
        </ROUTE>
        """
        self.assertEqual(extract_route_choice(response), "complex")

    @patch('utils.config.available_routes', [
        {"route_name": "simple"}
    ])
    def test_raises_on_missing_choice_tag(self):
        """Missing CHOICE tag should raise ValueError."""
        response = "<ROUTE>no choice here</ROUTE>"
        with self.assertRaises(ValueError) as ctx:
            extract_route_choice(response)
        self.assertIn("<CHOICE>", str(ctx.exception))

    @patch('utils.config.available_routes', [
        {"route_name": "simple"}
    ])
    def test_raises_on_missing_route_tag(self):
        """Missing ROUTE tag should still attempt extraction."""
        response = "<CHOICE>simple</CHOICE>"
        self.assertEqual(extract_route_choice(response), "simple")

    @patch('utils.config.available_routes', [
        {"route_name": "simple"},
        {"route_name": "complex"}
    ])
    def test_raises_on_invalid_route_name(self):
        """Invalid route name should raise ValueError."""
        response = "<ROUTE><CHOICE>nonexistent</CHOICE></ROUTE>"
        with self.assertRaises(ValueError) as ctx:
            extract_route_choice(response)
        self.assertIn("Invalid route choice", str(ctx.exception))

    @patch('utils.config.available_routes', [
        {"route_name": "simple"}
    ])
    def test_raises_on_empty_response(self):
        """Empty response should raise ValueError."""
        with self.assertRaises(ValueError) as ctx:
            extract_route_choice("")
        self.assertIn("empty", str(ctx.exception))

    @patch('utils.config.available_routes', [
        {"route_name": "simple"}
    ])
    def test_case_insensitive_tag_matching(self):
        """Tag matching should be case-insensitive."""
        response = "<route><choice>simple</choice></route>"
        self.assertEqual(extract_route_choice(response), "simple")

    @patch('utils.config.available_routes', [
        {"route_name": "test-route"}
    ])
    def test_handles_hyphenated_route_names(self):
        """Route names with hyphens should work."""
        response = "<ROUTE><CHOICE>test-route</CHOICE></ROUTE>"
        self.assertEqual(extract_route_choice(response), "test-route")


class TestValidateRouterResponseFormat(unittest.TestCase):
    """Test validation of router response format."""

    def test_accepts_complete_response(self):
        """Response with all required tags should pass validation."""
        response = "<ROUTE><CHOICE>simple</CHOICE></ROUTE>"
        self.assertTrue(validate_router_response_format(response))

    def test_accepts_multiline_response(self):
        """Multiline response with all tags should pass."""
        response = """
        <ROUTE>
            <CHOICE>complex</CHOICE>
        </ROUTE>
        """
        self.assertTrue(validate_router_response_format(response))

    def test_rejects_missing_opening_route_tag(self):
        """Response missing opening ROUTE tag should fail."""
        response = "<CHOICE>simple</CHOICE></ROUTE>"
        self.assertFalse(validate_router_response_format(response))

    def test_rejects_missing_closing_route_tag(self):
        """Response missing closing ROUTE tag should fail."""
        response = "<ROUTE><CHOICE>simple</CHOICE>"
        self.assertFalse(validate_router_response_format(response))

    def test_rejects_missing_opening_choice_tag(self):
        """Response missing opening CHOICE tag should fail."""
        response = "<ROUTE>simple</CHOICE></ROUTE>"
        self.assertFalse(validate_router_response_format(response))

    def test_rejects_missing_closing_choice_tag(self):
        """Response missing closing CHOICE tag should fail."""
        response = "<ROUTE><CHOICE>simple</ROUTE>"
        self.assertFalse(validate_router_response_format(response))

    def test_rejects_empty_response(self):
        """Empty response should fail validation."""
        self.assertFalse(validate_router_response_format(""))

    def test_tag_order_does_not_matter(self):
        """Tags in any order should pass as long as all are present."""
        response = "</ROUTE><CHOICE>test</CHOICE><ROUTE>"
        self.assertTrue(validate_router_response_format(response))


if __name__ == "__main__":
    unittest.main()
