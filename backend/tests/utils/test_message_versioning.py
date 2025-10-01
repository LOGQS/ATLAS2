"""Unit tests for message versioning utilities."""

import sqlite3
import sys
import unittest
from pathlib import Path
from typing import Optional
from unittest.mock import Mock, patch

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from utils.message_versioning import MessageVersioning


class InMemoryDBManager:
    """Lightweight stand-in for DatabaseManager using an in-memory SQLite DB for integration testing."""

    def __init__(self):
        self.conn = sqlite3.connect(":memory:")
        self._create_schema()

    def _create_schema(self):
        self.conn.execute(
            """
            CREATE TABLE message_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                original_message_id TEXT NOT NULL,
                version_number INTEGER NOT NULL,
                chat_version_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                content TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        self.conn.execute(
            """
            CREATE TABLE chats (
                id TEXT PRIMARY KEY,
                belongsto TEXT,
                isversion INTEGER DEFAULT 0
            )
            """
        )
        self.conn.commit()

    def insert_chat(self, chat_id: str, belongsto: Optional[str], is_version: int):
        self.conn.execute(
            "INSERT INTO chats (id, belongsto, isversion) VALUES (?, ?, ?)",
            (chat_id, belongsto, is_version),
        )
        self.conn.commit()

    def _transaction_wrapper(self, operation: str, func, *args, **kwargs):
        cursor = self.conn.cursor()
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            result = func(self.conn, cursor, *args, **kwargs)
            self.conn.commit()
            return result
        except Exception:
            self.conn.rollback()
            raise

    def _execute_with_connection(self, operation: str, func, return_on_error=None, reraise: bool = False):
        try:
            cursor = self.conn.cursor()
            return func(self.conn, cursor)
        except Exception:
            if reraise:
                raise
            return return_on_error

    def close(self):
        self.conn.close()


class TestMessageVersioningValidation(unittest.TestCase):
    """Test input validation for message versioning operations."""

    def setUp(self):
        """Set up mock database manager."""
        self.mock_db = Mock()
        self.versioning = MessageVersioning(self.mock_db)

    def test_record_message_version_rejects_empty_message_id(self):
        """Empty original_message_id should raise ValueError."""
        with self.assertRaises(ValueError) as cm:
            self.versioning.record_message_version(
                original_message_id="",
                chat_version_id="chat123",
                operation="edit",
                content="test"
            )
        self.assertIn("Invalid original_message_id", str(cm.exception))

    def test_record_message_version_rejects_non_string_message_id(self):
        """Non-string original_message_id should raise ValueError."""
        with self.assertRaises(ValueError) as cm:
            self.versioning.record_message_version(
                original_message_id=12345,
                chat_version_id="chat123",
                operation="edit",
                content="test"
            )
        self.assertIn("Invalid original_message_id", str(cm.exception))

    def test_record_message_version_rejects_empty_chat_version_id(self):
        """Empty chat_version_id should raise ValueError."""
        with self.assertRaises(ValueError) as cm:
            self.versioning.record_message_version(
                original_message_id="msg123",
                chat_version_id="",
                operation="edit",
                content="test"
            )
        self.assertIn("Invalid chat_version_id", str(cm.exception))

    def test_record_message_version_rejects_invalid_operation(self):
        """Invalid operation should raise ValueError."""
        with self.assertRaises(ValueError) as cm:
            self.versioning.record_message_version(
                original_message_id="msg123",
                chat_version_id="chat123",
                operation="invalid_operation",
                content="test"
            )
        self.assertIn("Invalid operation", str(cm.exception))
        self.assertIn("original", str(cm.exception))
        self.assertIn("edit", str(cm.exception))
        self.assertIn("retry", str(cm.exception))

    def test_record_message_version_accepts_valid_operations(self):
        """All valid operations should be accepted."""
        valid_operations = ['original', 'edit', 'retry']

        for operation in valid_operations:
            with self.subTest(operation=operation):
                self.mock_db._transaction_wrapper = Mock(return_value=1)

                result = self.versioning.record_message_version(
                    original_message_id="msg123",
                    chat_version_id="chat123",
                    operation=operation,
                    content="test content"
                )

                self.assertEqual(result, 1)
                self.mock_db._transaction_wrapper.assert_called_once()
                self.mock_db._transaction_wrapper.reset_mock()


class TestMessageVersioningRecording(unittest.TestCase):
    """Test message version recording functionality."""

    def setUp(self):
        """Set up mock database manager."""
        self.mock_db = Mock()
        self.versioning = MessageVersioning(self.mock_db)

    def test_record_message_version_increments_version_number(self):
        """Version numbers should increment automatically."""
        def mock_transaction(desc, callback):
            mock_conn = Mock()
            mock_cursor = Mock()
            mock_cursor.fetchone.return_value = (3,)
            return callback(mock_conn, mock_cursor)

        self.mock_db._transaction_wrapper = mock_transaction

        result = self.versioning.record_message_version(
            original_message_id="msg_1",
            chat_version_id="chat_v2",
            operation="edit",
            content="edited content"
        )

        self.assertEqual(result, 3)

    def test_record_message_version_stores_content(self):
        """Content should be stored in the version record."""
        captured_params = []

        def mock_transaction(desc, callback):
            mock_conn = Mock()
            mock_cursor = Mock()

            def capture_execute(query, params):
                captured_params.append(params)
                if 'INSERT' in query:
                    return None
                elif 'SELECT' in query:
                    mock_cursor.fetchone.return_value = (1,)

            mock_cursor.execute = capture_execute
            return callback(mock_conn, mock_cursor)

        self.mock_db._transaction_wrapper = mock_transaction

        self.versioning.record_message_version(
            original_message_id="msg_1",
            chat_version_id="chat_v1",
            operation="retry",
            content="retry content"
        )

        insert_params = captured_params[0]
        self.assertIn("retry content", insert_params)

    def test_record_message_version_handles_none_content(self):
        """None content should be acceptable."""
        self.mock_db._transaction_wrapper = Mock(return_value=1)

        result = self.versioning.record_message_version(
            original_message_id="msg_1",
            chat_version_id="chat_v1",
            operation="original",
            content=None
        )

        self.assertEqual(result, 1)


class TestMessageVersioningRetrieval(unittest.TestCase):
    """Test retrieval of message versions."""

    def setUp(self):
        """Set up mock database manager."""
        self.mock_db = Mock()
        self.versioning = MessageVersioning(self.mock_db)

    def test_get_message_versions_returns_empty_for_invalid_id(self):
        """Invalid message ID should return empty list."""
        result = self.versioning.get_message_versions("")
        self.assertEqual(result, [])

        result = self.versioning.get_message_versions(None)
        self.assertEqual(result, [])

        result = self.versioning.get_message_versions(12345)
        self.assertEqual(result, [])

    def test_get_message_versions_returns_ordered_versions(self):
        """Versions should be returned in order by version number."""
        mock_rows = [
            (1, 'chat_v1', 'original', 'original content', '2024-01-01'),
            (2, 'chat_v2', 'edit', 'edited content', '2024-01-02'),
            (3, 'chat_v3', 'retry', 'retry content', '2024-01-03')
        ]

        def mock_execute(desc, callback, **kwargs):
            mock_conn = Mock()
            mock_cursor = Mock()
            mock_cursor.fetchall.return_value = mock_rows
            return callback(mock_conn, mock_cursor)

        self.mock_db._execute_with_connection = mock_execute

        versions = self.versioning.get_message_versions("msg_1")

        self.assertEqual(len(versions), 3)
        self.assertEqual(versions[0]['version_number'], 1)
        self.assertEqual(versions[0]['operation'], 'original')
        self.assertEqual(versions[1]['version_number'], 2)
        self.assertEqual(versions[1]['operation'], 'edit')
        self.assertEqual(versions[2]['version_number'], 3)
        self.assertEqual(versions[2]['operation'], 'retry')

    def test_get_message_versions_handles_no_versions(self):
        """Messages with no versions should return empty list."""
        def mock_execute(desc, callback, **kwargs):
            mock_conn = Mock()
            mock_cursor = Mock()
            mock_cursor.fetchall.return_value = []
            return callback(mock_conn, mock_cursor)

        self.mock_db._execute_with_connection = mock_execute

        versions = self.versioning.get_message_versions("msg_no_versions")
        self.assertEqual(versions, [])


class TestMessageVersioningCleanup(unittest.TestCase):
    """Test cleanup operations for message versions."""

    def setUp(self):
        """Set up mock database manager."""
        self.mock_db = Mock()
        self.versioning = MessageVersioning(self.mock_db)

    def test_cleanup_chat_versions_rejects_invalid_chat_id(self):
        """Invalid chat_id should return 0 without database operations."""
        result = self.versioning.cleanup_chat_versions("")
        self.assertEqual(result, 0)

        result = self.versioning.cleanup_chat_versions(None)
        self.assertEqual(result, 0)

    def test_cleanup_chat_versions_removes_related_versions(self):
        """All versions related to a chat should be removed."""
        deleted_count = 0

        def mock_transaction(desc, callback):
            mock_conn = Mock()
            mock_cursor = Mock()
            mock_cursor.fetchall.return_value = []  
            mock_cursor.rowcount = 5  
            nonlocal deleted_count
            deleted_count = callback(mock_conn, mock_cursor)
            return deleted_count

        self.mock_db._transaction_wrapper = mock_transaction

        result = self.versioning.cleanup_chat_versions("chat_1")

        self.assertGreater(result, 0)

    def test_cleanup_chat_versions_handles_nested_versions(self):
        """Cleanup should handle nested version chats."""
        def mock_transaction(desc, callback):
            mock_conn = Mock()
            mock_cursor = Mock()

            mock_cursor.fetchall.side_effect = [
                [('chat_v1',), ('chat_v2',)], 
                [('chat_v1_1',)],
                [], 
                []  
            ]
            mock_cursor.rowcount = 3

            return callback(mock_conn, mock_cursor)

        self.mock_db._transaction_wrapper = mock_transaction

        result = self.versioning.cleanup_chat_versions("chat_main")
        self.assertIsInstance(result, int)


class TestMessageVersioningVersionChain(unittest.TestCase):
    """Test version chain retrieval."""

    def setUp(self):
        """Set up mock database manager."""
        self.mock_db = Mock()
        self.versioning = MessageVersioning(self.mock_db)

    def test_get_version_chain_returns_ordered_chat_versions(self):
        """Version chain should return chat version IDs in order."""
        mock_versions = [
            {'version_number': 1, 'chat_version_id': 'chat_v1', 'operation': 'original', 'content': 'a', 'created_at': '2024-01-01'},
            {'version_number': 2, 'chat_version_id': 'chat_v2', 'operation': 'edit', 'content': 'b', 'created_at': '2024-01-02'},
            {'version_number': 3, 'chat_version_id': 'chat_v3', 'operation': 'retry', 'content': 'c', 'created_at': '2024-01-03'}
        ]

        with patch.object(self.versioning, 'get_message_versions', return_value=mock_versions):
            chain = self.versioning.get_version_chain("msg_1")

        self.assertEqual(chain, ['chat_v1', 'chat_v2', 'chat_v3'])

    def test_get_version_chain_handles_invalid_message_id(self):
        """Invalid message ID should return empty list."""
        chain = self.versioning.get_version_chain("")
        self.assertEqual(chain, [])

        chain = self.versioning.get_version_chain(None)
        self.assertEqual(chain, [])


class TestMessageVersioningOriginalMessageFinder(unittest.TestCase):
    """Test finding original message from version chat message IDs."""

    def setUp(self):
        """Set up mock database manager."""
        self.mock_db = Mock()
        self.versioning = MessageVersioning(self.mock_db)

    def test_find_original_message_returns_input_for_non_version(self):
        """Non-version message IDs should be returned as-is."""
        result = self.versioning.find_original_message("chat_1_5")
        self.assertEqual(result, "chat_1_5")

        result = self.versioning.find_original_message("normal_msg_123")
        self.assertEqual(result, "normal_msg_123")

    def test_find_original_message_handles_invalid_input(self):
        """Invalid input should return None."""
        result = self.versioning.find_original_message("")
        self.assertIsNone(result)

        result = self.versioning.find_original_message(None)
        self.assertIsNone(result)

    def test_find_original_message_resolves_version_chat_message(self):
        """Version chat message IDs should resolve to original message ID."""
        def mock_execute(desc, callback, **kwargs):
            mock_conn = Mock()
            mock_cursor = Mock()
            mock_cursor.fetchone.return_value = ('chat_main',)
            return callback(mock_conn, mock_cursor)

        self.mock_db._execute_with_connection = mock_execute

        result = self.versioning.find_original_message("version_chat_v1_3")
        self.assertEqual(result, "chat_main_3")

    def test_find_original_message_handles_nested_versions(self):
        """Nested version chats should resolve to root original message."""
        def mock_execute(desc, callback, **kwargs):
            mock_conn = Mock()
            mock_cursor = Mock()

            mock_cursor.fetchone.side_effect = [
                ('version_chat_v1',), 
                ('chat_main',),        
                None                   
            ]

            return callback(mock_conn, mock_cursor)

        self.mock_db._execute_with_connection = mock_execute

        result = self.versioning.find_original_message("version_chat_v2_10")
        self.assertEqual(result, "chat_main_10")

    def test_find_original_message_handles_malformed_version_id(self):
        """Malformed version message IDs should return None."""
        result = self.versioning.find_original_message("version_")
        self.assertIsNone(result)

        result = self.versioning.find_original_message("version_chat")
        self.assertIsNone(result)

        result = self.versioning.find_original_message("version_chat_abc")
        self.assertIsNone(result)


class TestMessageVersioningMessagesWithVersions(unittest.TestCase):
    """Test retrieval of all messages with versions in a chat."""

    def setUp(self):
        """Set up mock database manager."""
        self.mock_db = Mock()
        self.versioning = MessageVersioning(self.mock_db)

    def test_get_messages_with_versions_handles_invalid_chat_id(self):
        """Invalid chat_id should return empty dict."""
        result = self.versioning.get_messages_with_versions("")
        self.assertEqual(result, {})

        result = self.versioning.get_messages_with_versions(None)
        self.assertEqual(result, {})

    def test_get_messages_with_versions_groups_by_message(self):
        """Versions should be grouped by original message ID."""
        mock_rows = [
            ('chat_1_msg1', 1, 'chat_v1', 'original', 'content 1', '2024-01-01'),
            ('chat_1_msg1', 2, 'chat_v2', 'edit', 'content 2', '2024-01-02'),
            ('chat_1_msg2', 1, 'chat_v1', 'original', 'content 3', '2024-01-03'),
        ]

        def mock_execute(desc, callback, **kwargs):
            mock_conn = Mock()
            mock_cursor = Mock()
            mock_cursor.fetchall.return_value = mock_rows
            return callback(mock_conn, mock_cursor)

        self.mock_db._execute_with_connection = mock_execute

        result = self.versioning.get_messages_with_versions("chat_1")

        self.assertEqual(len(result), 2)
        self.assertIn('chat_1_msg1', result)
        self.assertIn('chat_1_msg2', result)
        self.assertEqual(len(result['chat_1_msg1']), 2)
        self.assertEqual(len(result['chat_1_msg2']), 1)

    def test_get_messages_with_versions_handles_version_chats(self):
        """Should extract base chat ID from version chat IDs."""
        def mock_execute(desc, callback, **kwargs):
            mock_conn = Mock()
            mock_cursor = Mock()
            mock_cursor.fetchall.return_value = []

            callback(mock_conn, mock_cursor)
            return {}

        self.mock_db._execute_with_connection = mock_execute

        result = self.versioning.get_messages_with_versions("chat_1_version_v5")
        self.assertEqual(result, {})


class TestMessageVersioningIntegration(unittest.TestCase):
    """Integration-style tests using real SQLite database to validate SQL queries and data flow."""

    def setUp(self):
        """Set up in-memory database for integration testing."""
        self.db = InMemoryDBManager()
        self.versioning = MessageVersioning(self.db)

    def tearDown(self):
        """Clean up database connection."""
        self.db.close()

    def test_record_message_version_assigns_incremental_numbers(self):
        """Version numbers should increment correctly in real database."""
        version_one = self.versioning.record_message_version(
            original_message_id="chat123_1",
            chat_version_id="chat123",
            operation=MessageVersioning.OPERATION_ORIGINAL,
            content="base",
        )
        version_two = self.versioning.record_message_version(
            original_message_id="chat123_1",
            chat_version_id="version_branch",
            operation=MessageVersioning.OPERATION_EDIT,
            content="edit",
        )

        self.assertEqual(version_one, 1)
        self.assertEqual(version_two, 2)

        versions = self.versioning.get_message_versions("chat123_1")
        self.assertEqual(len(versions), 2)
        self.assertEqual([v["version_number"] for v in versions], [1, 2])
        self.assertEqual(versions[1]["operation"], MessageVersioning.OPERATION_EDIT)

    def test_get_messages_with_versions_filters_by_base_chat(self):
        """SQL should correctly filter messages by base chat ID."""
        self.versioning.record_message_version(
            "chatABC_1", "chatABC", MessageVersioning.OPERATION_ORIGINAL, "v1"
        )
        self.versioning.record_message_version(
            "chatABC_1", "version_A", MessageVersioning.OPERATION_EDIT, "v2"
        )
        self.versioning.record_message_version(
            "chatXYZ_1", "chatXYZ", MessageVersioning.OPERATION_ORIGINAL, "x1"
        )

        result = self.versioning.get_messages_with_versions("chatABC")

        self.assertIn("chatABC_1", result)
        self.assertNotIn("chatXYZ_1", result)
        self.assertEqual(len(result["chatABC_1"]), 2)

    def test_cleanup_chat_versions_removes_related_records(self):
        """Cleanup should recursively delete all related version records."""
        self.db.insert_chat("chat_root", None, 0)
        self.db.insert_chat("version_child", "chat_root", 1)
        self.db.insert_chat("version_grand", "version_child", 1)
        self.db.insert_chat("other_chat", None, 0)

        self.versioning.record_message_version(
            "chat_root_1", "chat_root", MessageVersioning.OPERATION_ORIGINAL, "base"
        )
        self.versioning.record_message_version(
            "chat_root_1", "version_child", MessageVersioning.OPERATION_EDIT, "edit"
        )
        self.versioning.record_message_version(
            "chat_root_1", "version_grand", MessageVersioning.OPERATION_RETRY, "retry"
        )
        self.versioning.record_message_version(
            "other_chat_1", "other_chat", MessageVersioning.OPERATION_ORIGINAL, "keep"
        )

        deleted = self.versioning.cleanup_chat_versions("chat_root")

        self.assertGreaterEqual(deleted, 3)
        self.assertEqual(self.versioning.get_message_versions("chat_root_1"), [])
        remaining = self.versioning.get_messages_with_versions("other_chat")
        self.assertIn("other_chat_1", remaining)

    def test_get_version_chain_returns_chat_sequence(self):
        """Version chain should return correct sequence of chat version IDs."""
        self.versioning.record_message_version(
            "chat777_2", "chat777", MessageVersioning.OPERATION_ORIGINAL, "start"
        )
        self.versioning.record_message_version(
            "chat777_2", "version_split", MessageVersioning.OPERATION_EDIT, "edit"
        )

        chain = self.versioning.get_version_chain("chat777_2")
        self.assertEqual(chain, ["chat777", "version_split"])

    def test_find_original_message_traverses_version_lineage(self):
        """SQL traversal should correctly resolve nested version lineage."""
        self.db.insert_chat("chat_base", None, 0)
        self.db.insert_chat("version_child", "version_parent", 1)
        self.db.insert_chat("version_parent", "chat_base", 1)

        resolved = self.versioning.find_original_message("version_child_5")
        self.assertEqual(resolved, "chat_base_5")

        self.assertEqual(self.versioning.find_original_message("chat_base_5"), "chat_base_5")
        self.assertIsNone(self.versioning.find_original_message("version_child_no_number"))
        self.assertIsNone(self.versioning.find_original_message("version_missing"))

    def test_record_message_version_validates_inputs(self):
        """Input validation should work correctly in integration context."""
        with self.assertRaises(ValueError):
            self.versioning.record_message_version("", "chat", MessageVersioning.OPERATION_ORIGINAL)

        with self.assertRaises(ValueError):
            self.versioning.record_message_version("orig", "", MessageVersioning.OPERATION_ORIGINAL)

        with self.assertRaises(ValueError):
            self.versioning.record_message_version(
                "orig", "chat", "invalid_op"
            )


if __name__ == "__main__":
    unittest.main()
