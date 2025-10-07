"""Comprehensive unit tests for file operations tools.

This module tests all file operation tools including:
- file.read: Read file with duplicate detection
- file.write: Write file with overwrite and create_dirs options
- file.edit: Edit files with line_range and find_replace modes
- file.move: Move/rename files
- file.list_dir: List directory contents with filtering
- file.search: Search for files using glob patterns
- file.move_lines: Move lines between files
- file.grep: Search for text patterns within file contents
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.tools.tool_registry import ToolExecutionContext, ToolResult
from agents.tools.file_ops.read_func import _tool_read_file
from agents.tools.file_ops.write_func import _tool_write_file
from agents.tools.file_ops.edit_func import _tool_edit_file
from agents.tools.file_ops.move_func import _tool_move_file
from agents.tools.file_ops.list_func import _tool_list_dir
from agents.tools.file_ops.search_func import _tool_search_files
from agents.tools.file_ops.move_lines_func import _tool_move_lines
from agents.tools.file_ops.grep_func import _tool_grep_files


class TestFileReadTool(unittest.TestCase):
    """Test file.read tool functionality."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_read"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_read_simple_text_file(self):
        """Should successfully read a simple text file."""
        test_file = self.temp_path / "test.txt"
        content = "Hello, World!\nThis is a test file."
        test_file.write_text(content, encoding='utf-8')

        result = _tool_read_file({"file_path": str(test_file)}, self.ctx)

        self.assertIsInstance(result, ToolResult)
        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["content"], content)
        self.assertEqual(result.output["metadata"]["line_count"], 2)
        self.assertIn("file_size", result.output["metadata"])

    def test_read_nonexistent_file(self):
        """Should raise ValueError for nonexistent file."""
        with self.assertRaises(ValueError) as cm:
            _tool_read_file({"file_path": "nonexistent.txt"}, self.ctx)

        self.assertIn("does not exist", str(cm.exception))

    def test_read_empty_file(self):
        """Should successfully read an empty file."""
        test_file = self.temp_path / "empty.txt"
        test_file.write_text("", encoding='utf-8')

        result = _tool_read_file({"file_path": str(test_file)}, self.ctx)

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["content"], "")

    def test_read_file_with_long_lines(self):
        """Should warn about very long lines."""
        test_file = self.temp_path / "longlines.txt"
        long_line = "x" * 250000 
        test_file.write_text(long_line, encoding='utf-8')

        result = _tool_read_file({"file_path": str(test_file)}, self.ctx)

        self.assertEqual(result.output["status"], "success")
        self.assertIn("warnings", result.output)
        self.assertTrue(len(result.output["warnings"]) > 0)

    def test_read_directory_should_fail(self):
        """Should raise ValueError when trying to read a directory."""
        with self.assertRaises(ValueError) as cm:
            _tool_read_file({"file_path": str(self.temp_path)}, self.ctx)

        self.assertIn("directory", str(cm.exception).lower())

    def test_read_missing_file_path(self):
        """Should raise ValueError when file_path is missing."""
        with self.assertRaises(ValueError) as cm:
            _tool_read_file({}, self.ctx)

        self.assertIn("file_path is required", str(cm.exception))

    def test_read_file_max_size_exceeded(self):
        """Should raise ValueError when file exceeds max_size_mb."""
        test_file = self.temp_path / "large.txt"
        content = "x" * (2 * 1024 * 1024)
        test_file.write_text(content, encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_read_file({"file_path": str(test_file), "max_size_mb": 1}, self.ctx)

        self.assertIn("too large", str(cm.exception))

    @patch('agents.tools.file_ops.read_func.load_context_manifest')
    @patch('agents.tools.file_ops.read_func.save_context_manifest')
    def test_read_duplicate_detection(self, mock_save, mock_load):
        """Should detect when a file has already been read."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("content", encoding='utf-8')

        mock_load.return_value = {"read_files": [str(test_file.resolve())]}

        result = _tool_read_file({"file_path": str(test_file)}, self.ctx)

        self.assertEqual(result.output["status"], "duplicate")
        self.assertIn("already been read", result.output["message"])

    @patch('agents.tools.file_ops.read_func.load_context_manifest')
    @patch('agents.tools.file_ops.read_func.save_context_manifest')
    def test_read_force_reread(self, mock_save, mock_load):
        """Should reread file when force_reread is True."""
        test_file = self.temp_path / "test.txt"
        content = "content"
        test_file.write_text(content, encoding='utf-8')

        mock_load.return_value = {"read_files": [str(test_file.resolve())]}

        result = _tool_read_file(
            {"file_path": str(test_file), "force_reread": True},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["content"], content)


class TestFileWriteTool(unittest.TestCase):
    """Test file.write tool functionality."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_write"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_write_simple_file(self):
        """Should successfully write a simple text file."""
        test_file = self.temp_path / "new.txt"
        content = "Hello, World!"

        result = _tool_write_file(
            {"file_path": str(test_file), "content": content},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["action"], "created")
        self.assertTrue(test_file.exists())
        self.assertEqual(test_file.read_text(encoding='utf-8'), content)

    def test_write_file_without_content(self):
        """Should raise ValueError when content is missing."""
        with self.assertRaises(ValueError) as cm:
            _tool_write_file({"file_path": "test.txt"}, self.ctx)

        self.assertIn("content is required", str(cm.exception))

    def test_write_empty_file(self):
        """Should successfully write an empty file."""
        test_file = self.temp_path / "empty.txt"

        result = _tool_write_file(
            {"file_path": str(test_file), "content": ""},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertTrue(test_file.exists())
        self.assertEqual(test_file.read_text(), "")

    def test_write_overwrite_existing_file(self):
        """Should overwrite existing file when overwrite=True."""
        test_file = self.temp_path / "existing.txt"
        test_file.write_text("old content", encoding='utf-8')

        new_content = "new content"
        result = _tool_write_file(
            {"file_path": str(test_file), "content": new_content, "overwrite": True},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(test_file.read_text(encoding='utf-8'), new_content)

    def test_write_existing_file_without_overwrite(self):
        """Should raise ValueError when file exists and overwrite=False."""
        test_file = self.temp_path / "existing.txt"
        test_file.write_text("old content", encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_write_file(
                {"file_path": str(test_file), "content": "new content"},
                self.ctx
            )

        self.assertIn("already exists", str(cm.exception))

    def test_write_file_create_dirs(self):
        """Should create parent directories when create_dirs=True."""
        test_file = self.temp_path / "subdir1" / "subdir2" / "file.txt"
        content = "content"

        result = _tool_write_file(
            {"file_path": str(test_file), "content": content, "create_dirs": True},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertTrue(test_file.exists())
        self.assertEqual(test_file.read_text(encoding='utf-8'), content)

    def test_write_file_without_create_dirs(self):
        """Should raise ValueError when parent directory doesn't exist."""
        test_file = self.temp_path / "nonexistent" / "file.txt"

        with self.assertRaises(ValueError) as cm:
            _tool_write_file(
                {"file_path": str(test_file), "content": "content"},
                self.ctx
            )

        self.assertIn("does not exist", str(cm.exception))

    def test_write_non_string_content(self):
        """Should raise ValueError for non-string content."""
        test_file = self.temp_path / "test.txt"

        with self.assertRaises(ValueError) as cm:
            _tool_write_file(
                {"file_path": str(test_file), "content": 123},
                self.ctx
            )

        self.assertIn("must be a string", str(cm.exception))

    def test_write_multiline_content(self):
        """Should successfully write multiline content."""
        test_file = self.temp_path / "multiline.txt"
        content = "Line 1\nLine 2\nLine 3"

        result = _tool_write_file(
            {"file_path": str(test_file), "content": content},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["metadata"]["line_count"], 3)


class TestFileEditTool(unittest.TestCase):
    """Test file.edit tool functionality."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_edit"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_edit_line_range_single_line(self):
        """Should edit a single line in a file."""
        test_file = self.temp_path / "test.txt"
        original = "Line 1\nLine 2\nLine 3\n"
        test_file.write_text(original, encoding='utf-8')

        result = _tool_edit_file(
            {
                "file_path": str(test_file),
                "edit_mode": "line_range",
                "start_line": 2,
                "new_content": "Modified Line 2\n",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        content = test_file.read_text(encoding='utf-8')
        self.assertEqual(content, "Line 1\nModified Line 2\nLine 3\n")

    def test_edit_line_range_multiple_lines(self):
        """Should edit multiple lines in a file."""
        test_file = self.temp_path / "test.txt"
        original = "Line 1\nLine 2\nLine 3\nLine 4\n"
        test_file.write_text(original, encoding='utf-8')

        result = _tool_edit_file(
            {
                "file_path": str(test_file),
                "edit_mode": "line_range",
                "start_line": 2,
                "end_line": 3,
                "new_content": "New Line\n",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        content = test_file.read_text(encoding='utf-8')
        self.assertEqual(content, "Line 1\nNew Line\nLine 4\n")

    def test_edit_line_range_out_of_bounds(self):
        """Should raise ValueError for out of bounds line numbers."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("Line 1\nLine 2\n", encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_edit_file(
                {
                    "file_path": str(test_file),
                    "edit_mode": "line_range",
                    "start_line": 5,
                    "new_content": "New"
                },
                self.ctx
            )

        self.assertIn("out of range", str(cm.exception))

    def test_edit_find_replace_simple(self):
        """Should find and replace text in a file."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("Hello World\nHello Again", encoding='utf-8')

        result = _tool_edit_file(
            {
                "file_path": str(test_file),
                "edit_mode": "find_replace",
                "find_text": "Hello",
                "replace_text": "Hi",
                "replace_all": True,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["replacements_made"], 2)
        content = test_file.read_text(encoding='utf-8')
        self.assertEqual(content, "Hi World\nHi Again")

    def test_edit_find_replace_first_only(self):
        """Should replace only first occurrence when replace_all=False."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("Hello World\nHello Again", encoding='utf-8')

        result = _tool_edit_file(
            {
                "file_path": str(test_file),
                "edit_mode": "find_replace",
                "find_text": "Hello",
                "replace_text": "Hi",
                "replace_all": False,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["replacements_made"], 1)
        content = test_file.read_text(encoding='utf-8')
        self.assertEqual(content, "Hi World\nHello Again")

    def test_edit_find_replace_regex(self):
        """Should use regex for find and replace."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("Test123 and Test456", encoding='utf-8')

        result = _tool_edit_file(
            {
                "file_path": str(test_file),
                "edit_mode": "find_replace",
                "find_text": r"Test\d+",
                "replace_text": "Result",
                "use_regex": True,
                "replace_all": True,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["replacements_made"], 2)
        content = test_file.read_text(encoding='utf-8')
        self.assertEqual(content, "Result and Result")

    def test_edit_find_replace_no_matches(self):
        """Should raise ValueError when no matches found."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("Hello World", encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_edit_file(
                {
                    "file_path": str(test_file),
                    "edit_mode": "find_replace",
                    "find_text": "Goodbye",
                    "replace_text": "Hi",
                    "create_backup": False
                },
                self.ctx
            )

        self.assertIn("No matches found", str(cm.exception))

    def test_edit_invalid_mode(self):
        """Should raise ValueError for invalid edit_mode."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("content", encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_edit_file(
                {
                    "file_path": str(test_file),
                    "edit_mode": "invalid_mode"
                },
                self.ctx
            )

        self.assertIn("Invalid edit_mode", str(cm.exception))

    def test_edit_nonexistent_file(self):
        """Should raise ValueError for nonexistent file."""
        with self.assertRaises(ValueError) as cm:
            _tool_edit_file(
                {
                    "file_path": "nonexistent.txt",
                    "edit_mode": "line_range",
                    "start_line": 1,
                    "new_content": "new"
                },
                self.ctx
            )

        self.assertIn("does not exist", str(cm.exception))


class TestFileMoveTool(unittest.TestCase):
    """Test file.move tool functionality."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_move"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_move_file_to_new_location(self):
        """Should successfully move a file to a new location."""
        source = self.temp_path / "source.txt"
        dest = self.temp_path / "dest.txt"
        content = "test content"
        source.write_text(content, encoding='utf-8')

        result = _tool_move_file(
            {"source_path": str(source), "destination_path": str(dest)},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertFalse(source.exists())
        self.assertTrue(dest.exists())
        self.assertEqual(dest.read_text(encoding='utf-8'), content)

    def test_move_file_rename(self):
        """Should rename a file."""
        source = self.temp_path / "old_name.txt"
        dest = self.temp_path / "new_name.txt"
        content = "content"
        source.write_text(content, encoding='utf-8')

        result = _tool_move_file(
            {"source_path": str(source), "destination_path": str(dest)},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertFalse(source.exists())
        self.assertTrue(dest.exists())

    def test_move_nonexistent_file(self):
        """Should raise ValueError when source file doesn't exist."""
        with self.assertRaises(ValueError) as cm:
            _tool_move_file(
                {
                    "source_path": "nonexistent.txt",
                    "destination_path": "dest.txt"
                },
                self.ctx
            )

        self.assertIn("does not exist", str(cm.exception))

    def test_move_to_existing_file_without_overwrite(self):
        """Should raise ValueError when destination exists and overwrite=False."""
        source = self.temp_path / "source.txt"
        dest = self.temp_path / "dest.txt"
        source.write_text("source", encoding='utf-8')
        dest.write_text("dest", encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_move_file(
                {"source_path": str(source), "destination_path": str(dest)},
                self.ctx
            )

        self.assertIn("already exists", str(cm.exception))

    def test_move_with_overwrite(self):
        """Should overwrite destination when overwrite=True."""
        source = self.temp_path / "source.txt"
        dest = self.temp_path / "dest.txt"
        source_content = "source content"
        source.write_text(source_content, encoding='utf-8')
        dest.write_text("dest content", encoding='utf-8')

        result = _tool_move_file(
            {
                "source_path": str(source),
                "destination_path": str(dest),
                "overwrite": True
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertFalse(source.exists())
        self.assertTrue(dest.exists())

    def test_move_with_create_dirs(self):
        """Should create parent directories when create_dirs=True."""
        source = self.temp_path / "source.txt"
        dest = self.temp_path / "subdir1" / "subdir2" / "dest.txt"
        content = "content"
        source.write_text(content, encoding='utf-8')

        result = _tool_move_file(
            {
                "source_path": str(source),
                "destination_path": str(dest),
                "create_dirs": True
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertFalse(source.exists())
        self.assertTrue(dest.exists())
        self.assertEqual(dest.read_text(encoding='utf-8'), content)

    def test_move_to_same_path(self):
        """Should raise ValueError when source and destination are the same."""
        source = self.temp_path / "file.txt"
        source.write_text("content", encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_move_file(
                {"source_path": str(source), "destination_path": str(source)},
                self.ctx
            )

        self.assertIn("same file", str(cm.exception))


class TestFileListDirTool(unittest.TestCase):
    """Test file.list_dir tool functionality."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_list"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_list_empty_directory(self):
        """Should list an empty directory."""
        result = _tool_list_dir({"directory_path": str(self.temp_path)}, self.ctx)

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(len(result.output["entries"]), 0)
        self.assertEqual(result.output["summary"]["total_entries"], 0)

    def test_list_directory_with_files(self):
        """Should list directory with files."""
        (self.temp_path / "file1.txt").write_text("content1")
        (self.temp_path / "file2.txt").write_text("content2")

        result = _tool_list_dir({"directory_path": str(self.temp_path)}, self.ctx)

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(len(result.output["entries"]), 2)
        self.assertEqual(result.output["summary"]["files"], 2)

        names = [e["name"] for e in result.output["entries"]]
        self.assertIn("file1.txt", names)
        self.assertIn("file2.txt", names)

    def test_list_directory_with_subdirs(self):
        """Should list directory with subdirectories."""
        (self.temp_path / "dir1").mkdir()
        (self.temp_path / "dir2").mkdir()

        result = _tool_list_dir({"directory_path": str(self.temp_path)}, self.ctx)

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["directories"], 2)

    def test_list_directory_files_only(self):
        """Should list only files when include_dirs=False."""
        (self.temp_path / "file.txt").write_text("content")
        (self.temp_path / "dir").mkdir()

        result = _tool_list_dir(
            {
                "directory_path": str(self.temp_path),
                "include_files": True,
                "include_dirs": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(len(result.output["entries"]), 1)
        self.assertEqual(result.output["entries"][0]["name"], "file.txt")

    def test_list_directory_dirs_only(self):
        """Should list only directories when include_files=False."""
        (self.temp_path / "file.txt").write_text("content")
        (self.temp_path / "dir").mkdir()

        result = _tool_list_dir(
            {
                "directory_path": str(self.temp_path),
                "include_files": False,
                "include_dirs": True
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(len(result.output["entries"]), 1)
        self.assertEqual(result.output["entries"][0]["name"], "dir")

    def test_list_directory_filter_extensions(self):
        """Should filter by file extension."""
        (self.temp_path / "file1.py").write_text("content")
        (self.temp_path / "file2.txt").write_text("content")
        (self.temp_path / "file3.py").write_text("content")

        result = _tool_list_dir(
            {
                "directory_path": str(self.temp_path),
                "filter_extensions": ".py"
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(len(result.output["entries"]), 2)

        names = [e["name"] for e in result.output["entries"]]
        self.assertIn("file1.py", names)
        self.assertIn("file3.py", names)

    def test_list_directory_recursive(self):
        """Should list directory recursively."""
        (self.temp_path / "file1.txt").write_text("content")
        subdir = self.temp_path / "subdir"
        subdir.mkdir()
        (subdir / "file2.txt").write_text("content")

        result = _tool_list_dir(
            {
                "directory_path": str(self.temp_path),
                "recursive": True
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertGreaterEqual(len(result.output["entries"]), 3)  # dir + 2 files

    def test_list_nonexistent_directory(self):
        """Should raise ValueError for nonexistent directory."""
        with self.assertRaises(ValueError) as cm:
            _tool_list_dir({"directory_path": "nonexistent"}, self.ctx)

        self.assertIn("does not exist", str(cm.exception))


class TestFileSearchTool(unittest.TestCase):
    """Test file.search tool functionality."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_search"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_search_simple_pattern(self):
        """Should find files matching simple pattern."""
        (self.temp_path / "test1.py").write_text("content")
        (self.temp_path / "test2.py").write_text("content")
        (self.temp_path / "other.txt").write_text("content")

        result = _tool_search_files(
            {"pattern": "*.py", "search_root": str(self.temp_path)},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["files"], 2)

        names = [m["name"] for m in result.output["matches"]]
        self.assertIn("test1.py", names)
        self.assertIn("test2.py", names)

    def test_search_recursive_pattern(self):
        """Should find files recursively."""
        (self.temp_path / "file1.py").write_text("content")
        subdir = self.temp_path / "subdir"
        subdir.mkdir()
        (subdir / "file2.py").write_text("content")

        result = _tool_search_files(
            {"pattern": "**/*.py", "search_root": str(self.temp_path)},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["files"], 2)

    def test_search_no_matches(self):
        """Should return empty results when no matches found."""
        (self.temp_path / "file.txt").write_text("content")

        result = _tool_search_files(
            {"pattern": "*.py", "search_root": str(self.temp_path)},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(len(result.output["matches"]), 0)
        self.assertIn("message", result.output)

    def test_search_include_directories(self):
        """Should include directories when include_dirs=True."""
        (self.temp_path / "test_dir").mkdir()
        (self.temp_path / "other_dir").mkdir()

        result = _tool_search_files(
            {
                "pattern": "test_*",
                "search_root": str(self.temp_path),
                "include_dirs": True
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertGreater(len(result.output["matches"]), 0)
        self.assertEqual(result.output["matches"][0]["type"], "directory")

    def test_search_missing_pattern(self):
        """Should raise ValueError when pattern is missing."""
        with self.assertRaises(ValueError) as cm:
            _tool_search_files({"search_root": str(self.temp_path)}, self.ctx)

        self.assertIn("pattern or patterns is required", str(cm.exception))

    def test_search_max_results_truncation(self):
        """Should truncate results when exceeding max_results."""
        for i in range(10):
            (self.temp_path / f"file{i}.txt").write_text("content")

        result = _tool_search_files(
            {
                "pattern": "*.txt",
                "search_root": str(self.temp_path),
                "max_results": 5
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(len(result.output["matches"]), 5)
        self.assertTrue(result.output["summary"]["truncated"])
        self.assertIn("warnings", result.output)
        self.assertTrue(any("truncated" in w.lower() for w in result.output["warnings"]))

    def test_search_multiple_patterns(self):
        """Should search with multiple patterns."""
        (self.temp_path / "test.py").write_text("content")
        (self.temp_path / "test.js").write_text("content")
        (self.temp_path / "test.txt").write_text("content")

        result = _tool_search_files(
            {
                "pattern": "*.py",
                "patterns": ["*.js"],
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["files"], 2)
        names = [m["name"] for m in result.output["matches"]]
        self.assertIn("test.py", names)
        self.assertIn("test.js", names)
        self.assertNotIn("test.txt", names)

    def test_search_exclude_patterns(self):
        """Should exclude files matching exclude patterns."""
        (self.temp_path / "include.py").write_text("content")
        (self.temp_path / "exclude.pyc").write_text("content")
        (self.temp_path / "test_exclude.py").write_text("content")

        result = _tool_search_files(
            {
                "pattern": "*",
                "exclude_patterns": ["*.pyc", "test_*"],
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        names = [m["name"] for m in result.output["matches"]]
        self.assertIn("include.py", names)
        self.assertNotIn("exclude.pyc", names)
        self.assertNotIn("test_exclude.py", names)

    def test_search_hidden_files(self):
        """Should control hidden file inclusion."""
        (self.temp_path / ".hidden").write_text("content")
        (self.temp_path / "visible.txt").write_text("content")

        result = _tool_search_files(
            {"pattern": "*", "search_root": str(self.temp_path)},
            self.ctx
        )
        names = [m["name"] for m in result.output["matches"]]
        self.assertNotIn(".hidden", names)
        self.assertGreater(result.output["summary"]["skipped_hidden"], 0)

        result = _tool_search_files(
            {
                "pattern": "*",
                "search_root": str(self.temp_path),
                "include_hidden": True
            },
            self.ctx
        )
        names = [m["name"] for m in result.output["matches"]]
        self.assertIn(".hidden", names)

    def test_search_with_metadata(self):
        """Should include file metadata when requested."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("content" * 100)

        result = _tool_search_files(
            {
                "pattern": "test.txt",
                "search_root": str(self.temp_path),
                "include_metadata": True
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(len(result.output["matches"]), 1)
        match = result.output["matches"][0]
        self.assertIn("metadata", match)
        self.assertIn("size", match["metadata"])
        self.assertIn("size_bytes", match["metadata"])
        self.assertIn("modified_time", match["metadata"])
        self.assertIn("modified_time_str", match["metadata"])
        self.assertGreater(match["metadata"]["size_bytes"], 0)

    def test_search_sort_by_name(self):
        """Should sort results by name."""
        (self.temp_path / "c.txt").write_text("content")
        (self.temp_path / "a.txt").write_text("content")
        (self.temp_path / "b.txt").write_text("content")

        result = _tool_search_files(
            {
                "pattern": "*.txt",
                "search_root": str(self.temp_path),
                "sort_by": "name"
            },
            self.ctx
        )

        names = [m["name"] for m in result.output["matches"]]
        self.assertEqual(names, ["a.txt", "b.txt", "c.txt"])

    def test_search_sort_by_size(self):
        """Should sort results by size (largest first)."""
        (self.temp_path / "small.txt").write_text("x")
        (self.temp_path / "large.txt").write_text("x" * 1000)
        (self.temp_path / "medium.txt").write_text("x" * 100)

        result = _tool_search_files(
            {
                "pattern": "*.txt",
                "search_root": str(self.temp_path),
                "sort_by": "size",
                "include_metadata": True
            },
            self.ctx
        )

        names = [m["name"] for m in result.output["matches"]]
        self.assertEqual(names[0], "large.txt")
        self.assertEqual(names[-1], "small.txt")

    def test_search_max_depth(self):
        """Should limit recursion depth."""
        (self.temp_path / "level0.txt").write_text("content")
        dir1 = self.temp_path / "dir1"
        dir1.mkdir()
        (dir1 / "level1.txt").write_text("content")
        dir2 = dir1 / "dir2"
        dir2.mkdir()
        (dir2 / "level2.txt").write_text("content")

        result = _tool_search_files(
            {
                "pattern": "**/*.txt",
                "search_root": str(self.temp_path),
                "max_depth": 0
            },
            self.ctx
        )
        names = [m["name"] for m in result.output["matches"]]
        self.assertIn("level0.txt", names)
        self.assertNotIn("level1.txt", names)
        self.assertNotIn("level2.txt", names)

        result = _tool_search_files(
            {
                "pattern": "**/*.txt",
                "search_root": str(self.temp_path),
                "max_depth": 1
            },
            self.ctx
        )
        names = [m["name"] for m in result.output["matches"]]
        self.assertIn("level0.txt", names)
        self.assertIn("level1.txt", names)
        self.assertNotIn("level2.txt", names)

    def test_search_case_insensitive(self):
        """Should support case-insensitive sorting."""
        (self.temp_path / "Zebra.txt").write_text("content")
        (self.temp_path / "apple.txt").write_text("content")
        (self.temp_path / "Banana.txt").write_text("content")

        result = _tool_search_files(
            {
                "pattern": "*.txt",
                "search_root": str(self.temp_path),
                "case_sensitive": False,
                "sort_by": "name"
            },
            self.ctx
        )

        names = [m["name"] for m in result.output["matches"]]
        self.assertEqual(names, ["apple.txt", "Banana.txt", "Zebra.txt"])

    def test_search_invalid_sort_by(self):
        """Should raise ValueError for invalid sort_by."""
        with self.assertRaises(ValueError) as cm:
            _tool_search_files(
                {
                    "pattern": "*.txt",
                    "search_root": str(self.temp_path),
                    "sort_by": "invalid"
                },
                self.ctx
            )

        self.assertIn("sort_by must be one of", str(cm.exception))

    def test_search_invalid_max_depth(self):
        """Should raise ValueError for invalid max_depth."""
        with self.assertRaises(ValueError) as cm:
            _tool_search_files(
                {
                    "pattern": "*.txt",
                    "search_root": str(self.temp_path),
                    "max_depth": 25
                },
                self.ctx
            )

        self.assertIn("cannot exceed 20", str(cm.exception))


class TestFileMoveLinesTool(unittest.TestCase):
    """Test file.move_lines tool functionality."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_movelines"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_move_single_line(self):
        """Should move a single line between files."""
        source = self.temp_path / "source.txt"
        dest = self.temp_path / "dest.txt"
        source.write_text("Line 1\nLine 2\nLine 3\n", encoding='utf-8')
        dest.write_text("Dest Line 1\n", encoding='utf-8')

        result = _tool_move_lines(
            {
                "source_path": str(source),
                "start_line": 2,
                "destination_path": str(dest),
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["lines_moved"], 1)

        source_content = source.read_text(encoding='utf-8')
        self.assertEqual(source_content, "Line 1\nLine 3\n")

        dest_content = dest.read_text(encoding='utf-8')
        self.assertEqual(dest_content, "Dest Line 1\nLine 2\n")

    def test_move_multiple_lines(self):
        """Should move multiple lines between files."""
        source = self.temp_path / "source.txt"
        dest = self.temp_path / "dest.txt"
        source.write_text("Line 1\nLine 2\nLine 3\nLine 4\n", encoding='utf-8')
        dest.write_text("", encoding='utf-8')

        result = _tool_move_lines(
            {
                "source_path": str(source),
                "start_line": 2,
                "end_line": 3,
                "destination_path": str(dest),
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["lines_moved"], 2)

        source_content = source.read_text(encoding='utf-8')
        self.assertEqual(source_content, "Line 1\nLine 4\n")

        dest_content = dest.read_text(encoding='utf-8')
        self.assertEqual(dest_content, "Line 2\nLine 3\n")

    def test_move_lines_without_removing_from_source(self):
        """Should copy lines when remove_from_source=False."""
        source = self.temp_path / "source.txt"
        dest = self.temp_path / "dest.txt"
        source.write_text("Line 1\nLine 2\n", encoding='utf-8')
        dest.write_text("", encoding='utf-8')

        result = _tool_move_lines(
            {
                "source_path": str(source),
                "start_line": 1,
                "destination_path": str(dest),
                "remove_from_source": False,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")

        source_content = source.read_text(encoding='utf-8')
        self.assertEqual(source_content, "Line 1\nLine 2\n")

        dest_content = dest.read_text(encoding='utf-8')
        self.assertEqual(dest_content, "Line 1\n")

    def test_move_lines_to_new_file(self):
        """Should create destination file if it doesn't exist."""
        source = self.temp_path / "source.txt"
        dest = self.temp_path / "new_dest.txt"
        source.write_text("Line 1\nLine 2\n", encoding='utf-8')

        result = _tool_move_lines(
            {
                "source_path": str(source),
                "start_line": 1,
                "destination_path": str(dest),
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertTrue(dest.exists())
        dest_content = dest.read_text(encoding='utf-8')
        self.assertEqual(dest_content, "Line 1\n")

    def test_move_lines_insert_at_specific_position(self):
        """Should insert lines at specific position in destination."""
        source = self.temp_path / "source.txt"
        dest = self.temp_path / "dest.txt"
        source.write_text("Insert Me\n", encoding='utf-8')
        dest.write_text("Line 1\nLine 2\nLine 3\n", encoding='utf-8')

        result = _tool_move_lines(
            {
                "source_path": str(source),
                "start_line": 1,
                "destination_path": str(dest),
                "insert_at_line": 2,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")

        dest_content = dest.read_text(encoding='utf-8')
        self.assertEqual(dest_content, "Line 1\nInsert Me\nLine 2\nLine 3\n")

    def test_move_lines_same_file_error(self):
        """Should raise ValueError when source and dest are same file."""
        source = self.temp_path / "file.txt"
        source.write_text("Line 1\nLine 2\n", encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_move_lines(
                {
                    "source_path": str(source),
                    "start_line": 1,
                    "destination_path": str(source)
                },
                self.ctx
            )

        self.assertIn("same file", str(cm.exception))

    def test_move_lines_out_of_range(self):
        """Should raise ValueError for out of range line numbers."""
        source = self.temp_path / "source.txt"
        dest = self.temp_path / "dest.txt"
        source.write_text("Line 1\nLine 2\n", encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_move_lines(
                {
                    "source_path": str(source),
                    "start_line": 5,
                    "destination_path": str(dest),
                    "create_backup": False
                },
                self.ctx
            )

        self.assertIn("out of range", str(cm.exception))


class TestFileGrepTool(unittest.TestCase):
    """Test file.grep tool functionality."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_grep"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_grep_simple_literal_search(self):
        """Should find literal text pattern in files."""
        file1 = self.temp_path / "file1.txt"
        file2 = self.temp_path / "file2.txt"
        file1.write_text("Hello World\nFoo Bar\n", encoding='utf-8')
        file2.write_text("Hello There\nTest\n", encoding='utf-8')

        result = _tool_grep_files(
            {"pattern": "Hello", "search_root": str(self.temp_path)},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["files_with_matches"], 2)
        self.assertEqual(result.output["summary"]["total_matches"], 2)

    def test_grep_case_insensitive(self):
        """Should search case-insensitively when case_sensitive=False."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("Hello\nhello\nHELLO\n", encoding='utf-8')

        result = _tool_grep_files(
            {
                "pattern": "hello",
                "case_sensitive": False,
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["total_matches"], 3)

    def test_grep_case_sensitive(self):
        """Should search case-sensitively by default."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("Hello\nhello\nHELLO\n", encoding='utf-8')

        result = _tool_grep_files(
            {
                "pattern": "hello",
                "case_sensitive": True,
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["total_matches"], 1)

    def test_grep_regex_pattern(self):
        """Should support regex patterns when use_regex=True."""
        test_file = self.temp_path / "test.py"
        test_file.write_text("def foo():\n    pass\ndef bar():\n    pass\n", encoding='utf-8')

        result = _tool_grep_files(
            {
                "pattern": r"def \w+\(",
                "use_regex": True,
                "search_root": str(self.temp_path),
                "file_pattern": "*.py"
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["total_matches"], 2)

    def test_grep_whole_word_match(self):
        """Should match whole words only when whole_word=True."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("test testing tested\ntest\n", encoding='utf-8')

        result = _tool_grep_files(
            {
                "pattern": "test",
                "whole_word": True,
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["total_matches"], 2)

    def test_grep_context_lines(self):
        """Should include context lines before and after matches."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("Line 1\nLine 2\nMATCH\nLine 4\nLine 5\n", encoding='utf-8')

        result = _tool_grep_files(
            {
                "pattern": "MATCH",
                "context_before": 1,
                "context_after": 1,
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        matches = result.output["matches"][0]["matches"]
        self.assertEqual(len(matches), 1)

        context = matches[0]["context"]
        self.assertEqual(len(context), 3)  
        self.assertEqual(context[0]["line_number"], 2)
        self.assertEqual(context[1]["line_number"], 3)
        self.assertEqual(context[1]["is_match"], True)
        self.assertEqual(context[2]["line_number"], 4)

    def test_grep_file_pattern_filter(self):
        """Should filter files by glob pattern."""
        (self.temp_path / "test.py").write_text("python content\n", encoding='utf-8')
        (self.temp_path / "test.txt").write_text("text content\n", encoding='utf-8')

        result = _tool_grep_files(
            {
                "pattern": "content",
                "file_pattern": "*.py",
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["files_with_matches"], 1)
        self.assertIn(".py", result.output["matches"][0]["file_path"])

    def test_grep_max_matches_per_file(self):
        """Should limit matches per file."""
        test_file = self.temp_path / "test.txt"
        content = "\n".join([f"match {i}" for i in range(10)])
        test_file.write_text(content, encoding='utf-8')

        result = _tool_grep_files(
            {
                "pattern": "match",
                "max_matches_per_file": 3,
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(len(result.output["matches"][0]["matches"]), 3)
        self.assertIn("warnings", result.output)

    def test_grep_max_files_limit(self):
        """Should limit number of files with matches."""
        for i in range(5):
            (self.temp_path / f"file{i}.txt").write_text("match\n", encoding='utf-8')

        result = _tool_grep_files(
            {
                "pattern": "match",
                "max_files": 2,
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(len(result.output["matches"]), 2)
        self.assertTrue(result.output["summary"]["truncated"])

    def test_grep_no_matches(self):
        """Should return success with empty results when no matches."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("Hello World\n", encoding='utf-8')

        result = _tool_grep_files(
            {
                "pattern": "nonexistent",
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["total_matches"], 0)
        self.assertIn("message", result.output)

    def test_grep_empty_pattern(self):
        """Should raise ValueError for empty pattern."""
        with self.assertRaises(ValueError) as cm:
            _tool_grep_files(
                {"pattern": "", "search_root": str(self.temp_path)},
                self.ctx
            )

        self.assertIn("pattern is required", str(cm.exception))

    def test_grep_missing_pattern(self):
        """Should raise ValueError when pattern is missing."""
        with self.assertRaises(ValueError) as cm:
            _tool_grep_files(
                {"search_root": str(self.temp_path)},
                self.ctx
            )

        self.assertIn("pattern is required", str(cm.exception))

    def test_grep_invalid_regex(self):
        """Should raise ValueError for invalid regex pattern."""
        with self.assertRaises(ValueError) as cm:
            _tool_grep_files(
                {
                    "pattern": "[invalid(regex",
                    "use_regex": True,
                    "search_root": str(self.temp_path)
                },
                self.ctx
            )

        self.assertIn("Invalid regex pattern", str(cm.exception))

    def test_grep_invalid_search_root(self):
        """Should raise ValueError for nonexistent search root."""
        with self.assertRaises(ValueError) as cm:
            _tool_grep_files(
                {"pattern": "test", "search_root": "nonexistent_dir"},
                self.ctx
            )

        self.assertIn("does not exist", str(cm.exception))

    def test_grep_context_out_of_range(self):
        """Should raise ValueError for context lines out of range."""
        with self.assertRaises(ValueError) as cm:
            _tool_grep_files(
                {
                    "pattern": "test",
                    "context_before": 25,
                    "search_root": str(self.temp_path)
                },
                self.ctx
            )

        self.assertIn("cannot exceed 20", str(cm.exception))

    def test_grep_negative_context(self):
        """Should raise ValueError for negative context values."""
        with self.assertRaises(ValueError) as cm:
            _tool_grep_files(
                {
                    "pattern": "test",
                    "context_before": -1,
                    "search_root": str(self.temp_path)
                },
                self.ctx
            )

        self.assertIn("must be non-negative", str(cm.exception))

    def test_grep_max_matches_out_of_range(self):
        """Should raise ValueError for max_matches_per_file out of range."""
        with self.assertRaises(ValueError) as cm:
            _tool_grep_files(
                {
                    "pattern": "test",
                    "max_matches_per_file": 2000,
                    "search_root": str(self.temp_path)
                },
                self.ctx
            )

        self.assertIn("must be between 1 and 1000", str(cm.exception))

    def test_grep_skips_binary_files(self):
        """Should automatically skip binary files."""
        text_file = self.temp_path / "text.txt"
        binary_file = self.temp_path / "binary.bin"
        text_file.write_text("match\n", encoding='utf-8')
        binary_file.write_bytes(b'\x00\x01\x02\x03match')

        result = _tool_grep_files(
            {
                "pattern": "match",
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        # Should only find match in text file, not binary
        self.assertEqual(result.output["summary"]["files_with_matches"], 1)
        self.assertIn("text.txt", result.output["matches"][0]["file_path"])

    def test_grep_line_numbers(self):
        """Should include correct line numbers in matches."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("Line 1\nLine 2 match\nLine 3\nLine 4 match\n", encoding='utf-8')

        result = _tool_grep_files(
            {
                "pattern": "match",
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        matches = result.output["matches"][0]["matches"]
        self.assertEqual(len(matches), 2)
        self.assertEqual(matches[0]["line_number"], 2)
        self.assertEqual(matches[1]["line_number"], 4)

    def test_grep_recursive_search(self):
        """Should search recursively in subdirectories."""
        subdir = self.temp_path / "subdir"
        subdir.mkdir()
        (self.temp_path / "file1.txt").write_text("match\n", encoding='utf-8')
        (subdir / "file2.txt").write_text("match\n", encoding='utf-8')

        result = _tool_grep_files(
            {
                "pattern": "match",
                "file_pattern": "**/*.txt",
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["files_with_matches"], 2)

    def test_grep_directory_traversal_prevention(self):
        """Should reject file patterns with directory traversal."""
        with self.assertRaises(ValueError) as cm:
            _tool_grep_files(
                {
                    "pattern": "test",
                    "file_pattern": "../*.txt",
                    "search_root": str(self.temp_path)
                },
                self.ctx
            )

        self.assertIn("directory traversal", str(cm.exception))

    def test_grep_no_files_matching_pattern(self):
        """Should handle case when no files match file_pattern."""
        (self.temp_path / "file.txt").write_text("content\n", encoding='utf-8')

        result = _tool_grep_files(
            {
                "pattern": "content",
                "file_pattern": "*.py",
                "search_root": str(self.temp_path)
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["total_files_searched"], 0)
        self.assertIn("message", result.output)


if __name__ == "__main__":
    unittest.main()
