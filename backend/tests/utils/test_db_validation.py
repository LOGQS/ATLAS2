"""Unit tests for database validation utilities."""

import sys
import unittest
from pathlib import Path

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from utils.db_validation import DatabaseValidator


class TestValidateId(unittest.TestCase):
    """Test ID validation logic."""

    def test_accepts_positive_integers(self):
        """Valid positive integers should pass validation."""
        self.assertTrue(DatabaseValidator.validate_id(1))
        self.assertTrue(DatabaseValidator.validate_id(999))
        self.assertTrue(DatabaseValidator.validate_id(2147483647))

    def test_rejects_zero_and_negative(self):
        """Zero and negative integers should fail validation."""
        self.assertFalse(DatabaseValidator.validate_id(0))
        self.assertFalse(DatabaseValidator.validate_id(-1))
        self.assertFalse(DatabaseValidator.validate_id(-999))

    def test_rejects_non_integers(self):
        """Non-integer types should fail validation."""
        self.assertFalse(DatabaseValidator.validate_id("1"))
        self.assertFalse(DatabaseValidator.validate_id(1.5))
        self.assertFalse(DatabaseValidator.validate_id(None))
        self.assertFalse(DatabaseValidator.validate_id([1]))


class TestValidateString(unittest.TestCase):
    """Test string validation logic."""

    def test_accepts_valid_strings(self):
        """Non-empty strings within length limits should pass."""
        self.assertTrue(DatabaseValidator.validate_string("valid"))
        self.assertTrue(DatabaseValidator.validate_string("a" * 255))
        self.assertTrue(DatabaseValidator.validate_string("test string"))

    def test_rejects_empty_and_whitespace(self):
        """Empty strings and whitespace-only strings should fail."""
        self.assertFalse(DatabaseValidator.validate_string(""))
        self.assertFalse(DatabaseValidator.validate_string(" "))
        self.assertFalse(DatabaseValidator.validate_string("   "))
        self.assertFalse(DatabaseValidator.validate_string("\t\n"))

    def test_rejects_non_strings(self):
        """Non-string types should fail validation."""
        self.assertFalse(DatabaseValidator.validate_string(123))
        self.assertFalse(DatabaseValidator.validate_string(None))
        self.assertFalse(DatabaseValidator.validate_string(["string"]))

    def test_respects_max_length(self):
        """Strings exceeding max_length should fail."""
        self.assertTrue(DatabaseValidator.validate_string("abc", max_length=3))
        self.assertFalse(DatabaseValidator.validate_string("abcd", max_length=3))
        self.assertFalse(DatabaseValidator.validate_string("a" * 256, max_length=255))

    def test_unicode_strings(self):
        """Unicode strings should be handled correctly."""
        self.assertTrue(DatabaseValidator.validate_string("Hello 世界"))
        self.assertTrue(DatabaseValidator.validate_string("émoji 🎉"))


class TestValidateTableColumn(unittest.TestCase):
    """Test table and column name validation (SQL injection prevention)."""

    def test_accepts_all_allowed_tables(self):
        """All whitelisted tables should pass validation."""
        allowed_tables = [
            'chats', 'messages', 'files', 'user_settings',
            'provider_configs', 'message_files', 'message_versions',
            'message_lineage', 'oplog', 'plans', 'tasks', 'tool_calls', 'blobs'
        ]
        for table in allowed_tables:
            with self.subTest(table=table):
                self.assertTrue(DatabaseValidator.validate_table_column(table))

    def test_rejects_unknown_tables(self):
        """Non-whitelisted tables should fail validation."""
        self.assertFalse(DatabaseValidator.validate_table_column("unknown_table"))
        self.assertFalse(DatabaseValidator.validate_table_column("users; DROP TABLE--"))
        self.assertFalse(DatabaseValidator.validate_table_column(""))

    def test_accepts_allowed_columns(self):
        """Whitelisted columns should pass validation."""
        common_columns = ['id', 'chat_id', 'content', 'timestamp', 'role', 'state']
        for col in common_columns:
            with self.subTest(column=col):
                self.assertTrue(DatabaseValidator.validate_table_column("messages", col))

    def test_rejects_unknown_columns(self):
        """Non-whitelisted columns should fail validation."""
        self.assertFalse(DatabaseValidator.validate_table_column("messages", "unknown_col"))
        self.assertFalse(DatabaseValidator.validate_table_column("messages", "id; DROP--"))

    def test_column_validation_requires_valid_table(self):
        """Column validation should fail if table is invalid."""
        self.assertFalse(DatabaseValidator.validate_table_column("invalid_table", "id"))


class TestValidateChatState(unittest.TestCase):
    """Test chat state validation."""

    def test_accepts_all_valid_states(self):
        """All valid chat states should pass validation."""
        valid_states = ['thinking', 'responding', 'static']
        for state in valid_states:
            with self.subTest(state=state):
                self.assertTrue(DatabaseValidator.validate_chat_state(state))

    def test_rejects_invalid_states(self):
        """Invalid chat states should fail validation."""
        invalid_states = ['invalid', 'idle', 'active', '', 'THINKING']
        for state in invalid_states:
            with self.subTest(state=state):
                self.assertFalse(DatabaseValidator.validate_chat_state(state))


class TestValidateRole(unittest.TestCase):
    """Test message role validation."""

    def test_accepts_all_valid_roles(self):
        """All valid message roles should pass validation."""
        valid_roles = ['system', 'user', 'assistant', 'tool']
        for role in valid_roles:
            with self.subTest(role=role):
                self.assertTrue(DatabaseValidator.validate_role(role))

    def test_rejects_invalid_roles(self):
        """Invalid message roles should fail validation."""
        invalid_roles = ['invalid', 'admin', 'bot', '', 'USER']
        for role in invalid_roles:
            with self.subTest(role=role):
                self.assertFalse(DatabaseValidator.validate_role(role))


if __name__ == "__main__":
    unittest.main()
