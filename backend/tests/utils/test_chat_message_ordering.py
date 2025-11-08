"""Unit tests for chat message ordering logic.

Tests the critical fix for message ordering where messages after position 9
were being sorted lexicographically (1, 10, 2, 3...) instead of numerically (1, 2, 3..., 10).
"""

import sqlite3
import sys
import unittest
from pathlib import Path
from typing import List, Dict, Any
from collections import defaultdict

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))


class InMemoryDBManager:
    """Lightweight in-memory SQLite DB for integration testing message ordering."""

    def __init__(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self._create_schema()

    def _create_schema(self):
        """Create the minimal schema needed for message ordering tests."""
        # Chats table
        self.conn.execute("""
            CREATE TABLE chats (
                id TEXT PRIMARY KEY,
                name TEXT,
                system_prompt TEXT,
                state TEXT DEFAULT 'active',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                isversion INTEGER DEFAULT 0,
                belongsto TEXT,
                last_active TEXT
            )
        """)

        # Messages table
        self.conn.execute("""
            CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
                content TEXT NOT NULL,
                thoughts TEXT,
                provider TEXT,
                model TEXT,
                router_enabled INTEGER DEFAULT 0,
                router_decision TEXT,
                domain_execution TEXT,
                plan_id TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
            )
        """)

        # Files table
        self.conn.execute("""
            CREATE TABLE files (
                id TEXT PRIMARY KEY,
                chat_id TEXT,
                original_name TEXT NOT NULL,
                file_size INTEGER,
                file_type TEXT,
                api_state TEXT,
                provider TEXT,
                api_file_name TEXT,
                upload_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Message-files junction table
        self.conn.execute("""
            CREATE TABLE message_files (
                message_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (message_id, file_id),
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
                FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
            )
        """)

        self.conn.commit()

    def insert_chat(self, chat_id: str, name: str = "Test Chat"):
        """Insert a chat session."""
        self.conn.execute(
            "INSERT INTO chats (id, name) VALUES (?, ?)",
            (chat_id, name)
        )
        self.conn.commit()

    def insert_message(self, message_id: str, chat_id: str, role: str, content: str,
                      thoughts: str = None, provider: str = None, model: str = None,
                      router_enabled: int = 0, router_decision: str = None,
                      plan_id: str = None, domain_execution: str = None):
        """Insert a message."""
        self.conn.execute("""
            INSERT INTO messages (id, chat_id, role, content, thoughts, provider, model,
                                router_enabled, router_decision, plan_id, domain_execution)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (message_id, chat_id, role, content, thoughts, provider, model,
              router_enabled, router_decision, plan_id, domain_execution))
        self.conn.commit()

    def insert_file(self, file_id: str, chat_id: str, original_name: str):
        """Insert a file."""
        self.conn.execute("""
            INSERT INTO files (id, chat_id, original_name, file_size, file_type)
            VALUES (?, ?, ?, ?, ?)
        """, (file_id, chat_id, original_name, 1024, "text/plain"))
        self.conn.commit()

    def attach_file_to_message(self, message_id: str, file_id: str):
        """Attach a file to a message."""
        self.conn.execute("""
            INSERT INTO message_files (message_id, file_id)
            VALUES (?, ?)
        """, (message_id, file_id))
        self.conn.commit()

    def get_chat_history(self, chat_id: str) -> List[Dict[str, Any]]:
        """
        Get chat history - EXACT implementation from db_utils.py with the fix.
        This is the method being tested.
        """
        cursor = self.conn.cursor()

        cursor.execute("""
            SELECT
                m.id as message_id, m.role, m.content, m.thoughts,
                m.provider as message_provider, m.model, m.timestamp,
                m.router_enabled, m.router_decision, m.plan_id, m.domain_execution,
                f.id as file_id, f.original_name, f.file_size, f.file_type,
                f.api_state, f.provider as file_provider, f.api_file_name,
                mf.created_at as file_attached_at
            FROM messages m
            LEFT JOIN message_files mf ON m.id = mf.message_id
            LEFT JOIN files f ON mf.file_id = f.id
            WHERE m.chat_id = ?
            ORDER BY m.timestamp ASC, mf.created_at ASC
        """, (chat_id,))

        messages_map = defaultdict(lambda: {
            "id": None,
            "role": None,
            "content": None,
            "thoughts": None,
            "provider": None,
            "model": None,
            "timestamp": None,
            "routerEnabled": False,
            "routerDecision": None,
            "planId": None,
            "domainExecution": None,
            "attachedFiles": []
        })

        for row in cursor.fetchall():
            message_id = row["message_id"]

            if messages_map[message_id]["id"] is None:
                messages_map[message_id].update({
                    "id": message_id,
                    "role": row["role"],
                    "content": row["content"],
                    "thoughts": row["thoughts"],
                    "provider": row["message_provider"],
                    "model": row["model"],
                    "timestamp": row["timestamp"],
                    "routerEnabled": bool(row["router_enabled"]),
                    "routerDecision": row["router_decision"],
                    "planId": row["plan_id"],
                    "domainExecution": row["domain_execution"]
                })

            if row["file_id"]:
                messages_map[message_id]["attachedFiles"].append({
                    "id": row["file_id"],
                    "name": row["original_name"],
                    "size": row["file_size"],
                    "type": row["file_type"],
                    "api_state": row["api_state"],
                    "provider": row["file_provider"],
                    "api_file_name": row["api_file_name"]
                })

        messages = []
        # THE FIX: Sort by numeric position extracted from message_id (format: {chat_id}_{position})
        for message_id in sorted(messages_map.keys(), key=lambda x: int(x.split('_')[-1])):
            message = dict(messages_map[message_id])
            if not message["attachedFiles"]:
                del message["attachedFiles"]
            messages.append(message)

        return messages

    def close(self):
        self.conn.close()


class TestMessageOrderingBasic(unittest.TestCase):
    """Test basic message ordering scenarios."""

    def setUp(self):
        """Set up test database."""
        self.db = InMemoryDBManager()
        self.chat_id = "test_chat_123"
        self.db.insert_chat(self.chat_id)

    def tearDown(self):
        """Clean up test database."""
        self.db.close()

    def test_empty_chat_returns_empty_list(self):
        """Empty chat should return empty list."""
        history = self.db.get_chat_history(self.chat_id)
        self.assertEqual(history, [])

    def test_single_message_ordering(self):
        """Single message should be retrieved correctly."""
        self.db.insert_message(f"{self.chat_id}_1", self.chat_id, "user", "Hello")

        history = self.db.get_chat_history(self.chat_id)

        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["id"], f"{self.chat_id}_1")
        self.assertEqual(history[0]["content"], "Hello")

    def test_messages_1_to_5_ordering(self):
        """Messages 1-5 should maintain correct order."""
        for i in range(1, 6):
            self.db.insert_message(
                f"{self.chat_id}_{i}",
                self.chat_id,
                "user" if i % 2 == 1 else "assistant",
                f"Message {i}"
            )

        history = self.db.get_chat_history(self.chat_id)

        self.assertEqual(len(history), 5)
        for i, message in enumerate(history, 1):
            self.assertEqual(message["id"], f"{self.chat_id}_{i}")
            self.assertEqual(message["content"], f"Message {i}")

    def test_messages_1_to_15_critical_boundary(self):
        """
        CRITICAL TEST: Messages 1-15 should maintain correct order.
        This tests the 9->10 boundary where lexicographic sorting fails.
        Without the fix, order would be: 1, 10, 11, 12, 13, 14, 15, 2, 3, 4, 5, 6, 7, 8, 9
        With the fix, order should be: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
        """
        # Insert in random order to test sorting
        positions = [1, 5, 10, 3, 15, 7, 2, 12, 8, 4, 11, 6, 9, 13, 14]
        for pos in positions:
            self.db.insert_message(
                f"{self.chat_id}_{pos}",
                self.chat_id,
                "user" if pos % 2 == 1 else "assistant",
                f"Message {pos}"
            )

        history = self.db.get_chat_history(self.chat_id)

        # Verify count
        self.assertEqual(len(history), 15)

        # Verify each message is in correct sequential position
        for i, message in enumerate(history, 1):
            self.assertEqual(
                message["id"],
                f"{self.chat_id}_{i}",
                f"Message at position {i} has incorrect ID: {message['id']}"
            )
            self.assertEqual(
                message["content"],
                f"Message {i}",
                f"Message at position {i} has incorrect content: {message['content']}"
            )

    def test_messages_1_to_105_triple_digit_boundary(self):
        """
        Extended test: Messages 1-105 should maintain correct order.
        This tests the 99->100 boundary for triple digits.
        """
        # Test with a subset to keep test fast, but cover critical boundaries
        critical_positions = list(range(1, 15)) + list(range(95, 106))

        for pos in critical_positions:
            self.db.insert_message(
                f"{self.chat_id}_{pos}",
                self.chat_id,
                "user",
                f"Message {pos}"
            )

        history = self.db.get_chat_history(self.chat_id)

        self.assertEqual(len(history), len(critical_positions))

        # Verify messages are in order
        for idx, pos in enumerate(sorted(critical_positions)):
            self.assertEqual(
                history[idx]["id"],
                f"{self.chat_id}_{pos}",
                f"Message at index {idx} should have position {pos}"
            )


class TestMessageOrderingEdgeCases(unittest.TestCase):
    """Test edge cases for message ordering."""

    def setUp(self):
        """Set up test database."""
        self.db = InMemoryDBManager()

    def tearDown(self):
        """Clean up test database."""
        self.db.close()

    def test_chat_id_with_underscores(self):
        """
        Chat IDs with underscores should work correctly.
        The split('_')[-1] should extract the last segment.
        """
        chat_id = "main_chat_abc_123"
        self.db.insert_chat(chat_id)

        for i in range(1, 12):
            self.db.insert_message(
                f"{chat_id}_{i}",
                chat_id,
                "user",
                f"Message {i}"
            )

        history = self.db.get_chat_history(chat_id)

        self.assertEqual(len(history), 11)
        for i, message in enumerate(history, 1):
            self.assertEqual(message["id"], f"{chat_id}_{i}")

    def test_uuid_format_chat_id(self):
        """UUID format chat IDs should work correctly."""
        chat_id = "550e8400-e29b-41d4-a716-446655440000"
        self.db.insert_chat(chat_id)

        for i in range(1, 12):
            self.db.insert_message(
                f"{chat_id}_{i}",
                chat_id,
                "user",
                f"Message {i}"
            )

        history = self.db.get_chat_history(chat_id)

        self.assertEqual(len(history), 11)
        for i, message in enumerate(history, 1):
            self.assertEqual(message["id"], f"{chat_id}_{i}")

    def test_large_position_numbers(self):
        """Very large position numbers should sort correctly."""
        chat_id = "test_large_pos"
        self.db.insert_chat(chat_id)

        positions = [1, 99, 100, 999, 1000, 9999]
        for pos in positions:
            self.db.insert_message(
                f"{chat_id}_{pos}",
                chat_id,
                "user",
                f"Message {pos}"
            )

        history = self.db.get_chat_history(chat_id)

        self.assertEqual(len(history), len(positions))
        for idx, pos in enumerate(sorted(positions)):
            self.assertEqual(
                history[idx]["id"],
                f"{chat_id}_{pos}",
                f"Large position {pos} not in correct order"
            )


class TestMessageOrderingWithFiles(unittest.TestCase):
    """Test message ordering with attached files."""

    def setUp(self):
        """Set up test database."""
        self.db = InMemoryDBManager()
        self.chat_id = "test_chat_files"
        self.db.insert_chat(self.chat_id)

    def tearDown(self):
        """Clean up test database."""
        self.db.close()

    def test_messages_with_files_maintain_order(self):
        """Messages with attached files should maintain correct order."""
        # Create messages 1-12 with files on some messages
        for i in range(1, 13):
            message_id = f"{self.chat_id}_{i}"
            self.db.insert_message(message_id, self.chat_id, "user", f"Message {i}")

            # Attach files to messages 5, 10, and 11
            if i in [5, 10, 11]:
                file_id = f"file_{i}"
                self.db.insert_file(file_id, self.chat_id, f"document_{i}.txt")
                self.db.attach_file_to_message(message_id, file_id)

        history = self.db.get_chat_history(self.chat_id)

        # Verify count and order
        self.assertEqual(len(history), 12)
        for i, message in enumerate(history, 1):
            self.assertEqual(message["id"], f"{self.chat_id}_{i}")

            # Verify files are attached to correct messages
            if i in [5, 10, 11]:
                self.assertIn("attachedFiles", message)
                self.assertEqual(len(message["attachedFiles"]), 1)
                self.assertEqual(message["attachedFiles"][0]["name"], f"document_{i}.txt")
            else:
                self.assertNotIn("attachedFiles", message)

    def test_message_with_multiple_files(self):
        """Message with multiple files should maintain order."""
        for i in range(1, 11):
            message_id = f"{self.chat_id}_{i}"
            self.db.insert_message(message_id, self.chat_id, "user", f"Message {i}")

            # Attach multiple files to message 10
            if i == 10:
                for j in range(1, 4):
                    file_id = f"file_{i}_{j}"
                    self.db.insert_file(file_id, self.chat_id, f"doc_{i}_{j}.txt")
                    self.db.attach_file_to_message(message_id, file_id)

        history = self.db.get_chat_history(self.chat_id)

        self.assertEqual(len(history), 10)
        # Message 10 should have 3 files and be in position 10 (not position 2 due to sorting bug)
        message_10 = history[9]  # 0-indexed, so position 10 is index 9
        self.assertEqual(message_10["id"], f"{self.chat_id}_10")
        self.assertEqual(len(message_10["attachedFiles"]), 3)


class TestMessageOrderingWithMetadata(unittest.TestCase):
    """Test message ordering with various metadata fields."""

    def setUp(self):
        """Set up test database."""
        self.db = InMemoryDBManager()
        self.chat_id = "test_chat_metadata"
        self.db.insert_chat(self.chat_id)

    def tearDown(self):
        """Clean up test database."""
        self.db.close()

    def test_messages_with_router_data(self):
        """Messages with router data should maintain correct order."""
        for i in range(1, 12):
            self.db.insert_message(
                f"{self.chat_id}_{i}",
                self.chat_id,
                "user" if i % 2 == 1 else "assistant",
                f"Message {i}",
                router_enabled=1 if i == 10 else 0,
                router_decision='{"route": "test"}' if i == 10 else None
            )

        history = self.db.get_chat_history(self.chat_id)

        self.assertEqual(len(history), 11)
        # Message 10 should be at index 9, not index 1
        self.assertEqual(history[9]["id"], f"{self.chat_id}_10")
        self.assertTrue(history[9]["routerEnabled"])

    def test_messages_with_thoughts(self):
        """Messages with thoughts should maintain correct order."""
        for i in range(1, 12):
            self.db.insert_message(
                f"{self.chat_id}_{i}",
                self.chat_id,
                "assistant",
                f"Message {i}",
                thoughts=f"Thought process {i}" if i >= 10 else None
            )

        history = self.db.get_chat_history(self.chat_id)

        self.assertEqual(len(history), 11)
        # Messages 10 and 11 should have thoughts and be at the end
        self.assertEqual(history[9]["id"], f"{self.chat_id}_10")
        self.assertEqual(history[9]["thoughts"], "Thought process 10")
        self.assertEqual(history[10]["id"], f"{self.chat_id}_11")
        self.assertEqual(history[10]["thoughts"], "Thought process 11")

    def test_mixed_roles_maintain_order(self):
        """Messages with different roles should maintain correct order."""
        roles = ["system", "user", "assistant", "user", "assistant", "tool",
                "user", "assistant", "user", "assistant", "user"]

        for i, role in enumerate(roles, 1):
            self.db.insert_message(
                f"{self.chat_id}_{i}",
                self.chat_id,
                role,
                f"Message {i}",
                provider="test_provider" if role == "assistant" else None,
                model="test-model-1" if role == "assistant" else None
            )

        history = self.db.get_chat_history(self.chat_id)

        self.assertEqual(len(history), 11)
        for i, message in enumerate(history, 1):
            self.assertEqual(message["id"], f"{self.chat_id}_{i}")
            self.assertEqual(message["role"], roles[i-1])


class TestMessageOrderingRegressions(unittest.TestCase):
    """Test specific regression scenarios."""

    def setUp(self):
        """Set up test database."""
        self.db = InMemoryDBManager()
        self.chat_id = "regression_test"
        self.db.insert_chat(self.chat_id)

    def tearDown(self):
        """Clean up test database."""
        self.db.close()

    def test_exact_user_reported_bug(self):
        """
        Reproduce exact user-reported bug: messages after 10 appear in wrong order.
        Without fix: 1, 10, 2, 3, 4, 5, 6, 7, 8, 9
        With fix: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
        """
        # Create exactly 10 messages as user reported
        for i in range(1, 11):
            self.db.insert_message(
                f"{self.chat_id}_{i}",
                self.chat_id,
                "user",
                f"Message {i}"
            )

        history = self.db.get_chat_history(self.chat_id)

        # Extract just the position numbers from IDs
        positions = [int(msg["id"].split('_')[-1]) for msg in history]

        # Should be [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        # NOT [1, 10, 2, 3, 4, 5, 6, 7, 8, 9]
        self.assertEqual(positions, list(range(1, 11)))

        # Explicitly check that message 10 is at the end, not position 2
        self.assertEqual(history[-1]["id"], f"{self.chat_id}_10")
        self.assertEqual(history[-1]["content"], "Message 10")

        # Explicitly check that message 2 is at position 2, not after 10
        self.assertEqual(history[1]["id"], f"{self.chat_id}_2")
        self.assertEqual(history[1]["content"], "Message 2")

    def test_no_messages_lost_in_sorting(self):
        """Ensure sorting doesn't lose any messages."""
        message_count = 20
        for i in range(1, message_count + 1):
            self.db.insert_message(
                f"{self.chat_id}_{i}",
                self.chat_id,
                "user",
                f"Message {i}"
            )

        history = self.db.get_chat_history(self.chat_id)

        # Verify count
        self.assertEqual(len(history), message_count)

        # Verify all message IDs are present
        retrieved_positions = {int(msg["id"].split('_')[-1]) for msg in history}
        expected_positions = set(range(1, message_count + 1))
        self.assertEqual(retrieved_positions, expected_positions)

    def test_no_duplicate_messages(self):
        """Ensure sorting doesn't create duplicate messages."""
        for i in range(1, 15):
            self.db.insert_message(
                f"{self.chat_id}_{i}",
                self.chat_id,
                "user",
                f"Message {i}"
            )

        history = self.db.get_chat_history(self.chat_id)

        # Check for duplicates
        message_ids = [msg["id"] for msg in history]
        self.assertEqual(len(message_ids), len(set(message_ids)),
                        "Duplicate messages found in history")


if __name__ == "__main__":
    unittest.main()
