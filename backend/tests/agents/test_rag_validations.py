# status: stable

"""
Unit tests for RAG tools validation logic.

These tests focus on input validation without requiring llama_index dependencies.
"""

import sys
import unittest
from pathlib import Path

backend_dir = Path(__file__).parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))


class TestRAGIndexValidations(unittest.TestCase):
    """Tests for RAG index validation logic."""

    def setUp(self):
        """Set up test context."""
        from agents.tools.tool_registry import ToolExecutionContext
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx"
        )

    def test_index_name_empty(self):
        """Test that empty index_name is rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        with self.assertRaises(ValueError) as cm:
            _tool_rag_index(
                {"content": "test", "index_name": ""},
                self.ctx
            )
        self.assertIn("cannot be empty", str(cm.exception))

    def test_index_name_whitespace_only(self):
        """Test that whitespace-only index_name is rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        with self.assertRaises(ValueError) as cm:
            _tool_rag_index(
                {"content": "test", "index_name": "   "},
                self.ctx
            )
        self.assertIn("cannot be empty", str(cm.exception))

    def test_index_name_invalid_chars(self):
        """Test that invalid characters in index_name are rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        invalid_names = ["test<>", "test:name", "test|name", "test?", "test*"]
        for name in invalid_names:
            with self.assertRaises(ValueError) as cm:
                _tool_rag_index(
                    {"content": "test", "index_name": name},
                    self.ctx
                )
            self.assertIn("invalid characters", str(cm.exception))

    def test_index_name_too_long(self):
        """Test that very long index_name is rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        long_name = "a" * 201
        with self.assertRaises(ValueError) as cm:
            _tool_rag_index(
                {"content": "test", "index_name": long_name},
                self.ctx
            )
        self.assertIn("too long", str(cm.exception))

    def test_chunk_size_too_small(self):
        """Test that chunk_size < 100 is rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        with self.assertRaises(ValueError) as cm:
            _tool_rag_index(
                {"content": "test", "index_name": "test", "chunk_size": 50},
                self.ctx
            )
        self.assertIn("too small", str(cm.exception))

    def test_chunk_size_too_large(self):
        """Test that chunk_size > 50000 is rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        with self.assertRaises(ValueError) as cm:
            _tool_rag_index(
                {"content": "test", "index_name": "test", "chunk_size": 60000},
                self.ctx
            )
        self.assertIn("too large", str(cm.exception))

    def test_overlap_negative(self):
        """Test that negative overlap is rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        with self.assertRaises(ValueError) as cm:
            _tool_rag_index(
                {"content": "test", "index_name": "test", "overlap": -10},
                self.ctx
            )
        self.assertIn("cannot be negative", str(cm.exception))

    def test_overlap_gte_chunk_size(self):
        """Test that overlap >= chunk_size is rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        with self.assertRaises(ValueError) as cm:
            _tool_rag_index(
                {"content": "test", "index_name": "test", "chunk_size": 1000, "overlap": 1000},
                self.ctx
            )
        self.assertIn("must be less than chunk_size", str(cm.exception))

    def test_content_empty(self):
        """Test that empty content is rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        with self.assertRaises(ValueError) as cm:
            _tool_rag_index(
                {"content": "", "index_name": "test"},
                self.ctx
            )
        self.assertIn("cannot be empty", str(cm.exception))

    def test_content_whitespace_only(self):
        """Test that whitespace-only content is rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        with self.assertRaises(ValueError) as cm:
            _tool_rag_index(
                {"content": "   \n\t  ", "index_name": "test"},
                self.ctx
            )
        self.assertIn("cannot be empty", str(cm.exception))

    def test_content_too_large(self):
        """Test that content > 50MB is rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        # Create content larger than 50MB
        large_content = "x" * (51 * 1024 * 1024)
        with self.assertRaises(ValueError) as cm:
            _tool_rag_index(
                {"content": large_content, "index_name": "test"},
                self.ctx
            )
        self.assertIn("too large", str(cm.exception))

    def test_file_paths_empty(self):
        """Test that empty file_paths list is rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        with self.assertRaises(ValueError) as cm:
            _tool_rag_index(
                {"file_paths": [], "index_name": "test"},
                self.ctx
            )
        self.assertIn("cannot be empty", str(cm.exception))

    def test_file_paths_nonexistent(self):
        """Test that non-existent file paths are rejected."""
        from agents.tools.rag.index_func import _tool_rag_index

        with self.assertRaises(ValueError) as cm:
            _tool_rag_index(
                {"file_paths": ["/nonexistent/path.txt"], "index_name": "test"},
                self.ctx
            )
        self.assertIn("do not exist", str(cm.exception))


class TestRAGSearchValidations(unittest.TestCase):
    """Tests for RAG search validation logic."""

    def setUp(self):
        """Set up test context."""
        from agents.tools.tool_registry import ToolExecutionContext
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx"
        )

    def test_query_empty(self):
        """Test that empty query is rejected."""
        from agents.tools.rag.rag_search_func import _tool_rag_search

        with self.assertRaises(ValueError) as cm:
            _tool_rag_search(
                {"query": "", "index_name": "test"},
                self.ctx
            )
        self.assertIn("cannot be empty", str(cm.exception))

    def test_query_whitespace_only(self):
        """Test that whitespace-only query is rejected."""
        from agents.tools.rag.rag_search_func import _tool_rag_search

        with self.assertRaises(ValueError) as cm:
            _tool_rag_search(
                {"query": "   \n\t  ", "index_name": "test"},
                self.ctx
            )
        self.assertIn("cannot be empty", str(cm.exception))

    def test_query_too_long(self):
        """Test that very long query is rejected."""
        from agents.tools.rag.rag_search_func import _tool_rag_search

        long_query = "x" * 5001
        with self.assertRaises(ValueError) as cm:
            _tool_rag_search(
                {"query": long_query, "index_name": "test"},
                self.ctx
            )
        self.assertIn("too long", str(cm.exception))

    def test_index_name_empty(self):
        """Test that empty index_name is rejected."""
        from agents.tools.rag.rag_search_func import _tool_rag_search

        with self.assertRaises(ValueError) as cm:
            _tool_rag_search(
                {"query": "test", "index_name": ""},
                self.ctx
            )
        self.assertIn("cannot be empty", str(cm.exception))

    def test_top_k_negative(self):
        """Test that negative top_k is rejected."""
        from agents.tools.rag.rag_search_func import _tool_rag_search

        with self.assertRaises(ValueError) as cm:
            _tool_rag_search(
                {"query": "test", "index_name": "test", "top_k": -5},
                self.ctx
            )
        self.assertIn("positive integer", str(cm.exception))

    def test_top_k_zero(self):
        """Test that zero top_k is rejected."""
        from agents.tools.rag.rag_search_func import _tool_rag_search

        with self.assertRaises(ValueError) as cm:
            _tool_rag_search(
                {"query": "test", "index_name": "test", "top_k": 0},
                self.ctx
            )
        self.assertIn("positive integer", str(cm.exception))

    def test_top_k_too_large(self):
        """Test that top_k > 1000 is rejected."""
        from agents.tools.rag.rag_search_func import _tool_rag_search

        with self.assertRaises(ValueError) as cm:
            _tool_rag_search(
                {"query": "test", "index_name": "test", "top_k": 1500},
                self.ctx
            )
        self.assertIn("too large", str(cm.exception))

    def test_similarity_invalid(self):
        """Test that invalid similarity measure is rejected."""
        from agents.tools.rag.rag_search_func import _tool_rag_search

        with self.assertRaises(ValueError) as cm:
            _tool_rag_search(
                {"query": "test", "index_name": "test", "similarity": "invalid"},
                self.ctx
            )
        self.assertIn("not valid", str(cm.exception))
        self.assertIn("cosine", str(cm.exception))

    def test_index_not_exist(self):
        """Test that non-existent index is rejected with helpful message."""
        from agents.tools.rag.rag_search_func import _tool_rag_search

        with self.assertRaises(ValueError) as cm:
            _tool_rag_search(
                {"query": "test", "index_name": "nonexistent_index_xyz"},
                self.ctx
            )
        self.assertIn("does not exist", str(cm.exception))
        self.assertIn("Create the index first", str(cm.exception))


def run_tests():
    """Run all tests and print results."""
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return result.wasSuccessful()


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)