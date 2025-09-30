"""
Comprehensive unit tests for file operations tools.

Tests cover:
- read_file: Reading textual files, duplicate detection, binary file rejection
- write_file: Creating new files, directory creation, overwrite protection
- edit_file: Line-based and pattern-based editing
- move_file: Moving/renaming files, directory creation
- move_lines: Moving lines between files, source removal options
- search_files: Glob pattern matching, result limiting
- list_dir: Directory listing, recursive options, filtering
- attach_file: File attachment functionality (mocked)
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock

import sys
backend_dir = Path(__file__).parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.tools.tool_registry import ToolExecutionContext
from agents.tools.file_ops.read_func import _tool_read_file
from agents.tools.file_ops.write_func import _tool_write_file
from agents.tools.file_ops.edit_func import _tool_edit_file
from agents.tools.file_ops.move_func import _tool_move_file
from agents.tools.file_ops.move_lines_func import _tool_move_lines
from agents.tools.file_ops.search_func import _tool_search_files
from agents.tools.file_ops.list_func import _tool_list_dir


class TestFileOpsBase(unittest.TestCase):
    """Base class for file operations tests with common setup."""

    def setUp(self):
        """Create temporary directory and test context."""
        self.test_dir = tempfile.mkdtemp()
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx"
        )

    def tearDown(self):
        import shutil
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)

    def create_test_file(self, filename: str, content: str) -> str:
        filepath = os.path.join(self.test_dir, filename)
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        return filepath

    def create_test_binary_file(self, filename: str) -> str:
        filepath = os.path.join(self.test_dir, filename)
        with open(filepath, 'wb') as f:
            f.write(b'\x00\x01\x02\x03\x04\x05')
        return filepath


class TestReadFile(TestFileOpsBase):

    def test_read_simple_file(self):
        filepath = self.create_test_file("test.txt", "Hello, World!\nLine 2\n")

        result = _tool_read_file({"file_path": filepath}, self.ctx)

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["content"], "Hello, World!\nLine 2\n")
        self.assertEqual(result.output["metadata"]["line_count"], 3)

    def test_read_nonexistent_file(self):
        filepath = os.path.join(self.test_dir, "nonexistent.txt")

        with self.assertRaises(ValueError) as cm:
            _tool_read_file({"file_path": filepath}, self.ctx)

        self.assertIn("does not exist", str(cm.exception))

    def test_read_directory(self):
        dirpath = os.path.join(self.test_dir, "testdir")
        os.makedirs(dirpath)

        with self.assertRaises(ValueError) as cm:
            _tool_read_file({"file_path": dirpath}, self.ctx)

        self.assertIn("directory", str(cm.exception).lower())
        self.assertIn("list_dir", str(cm.exception))

    def test_read_binary_file(self):
        filepath = self.create_test_binary_file("test.bin")

        with self.assertRaises(ValueError) as cm:
            _tool_read_file({"file_path": filepath}, self.ctx)

        self.assertIn("binary", str(cm.exception).lower())
        self.assertIn("attach_file", str(cm.exception))

    def test_read_file_size_limit(self):
        large_content = "x" * (2 * 1024 * 1024)
        filepath = self.create_test_file("large.txt", large_content)

        with self.assertRaises(ValueError) as cm:
            _tool_read_file({"file_path": filepath, "max_size_mb": 1}, self.ctx)

        self.assertIn("too large", str(cm.exception))

    def test_duplicate_detection(self):
        filepath = self.create_test_file("test.txt", "content")

        result1 = _tool_read_file({"file_path": filepath}, self.ctx)
        self.assertEqual(result1.output["status"], "success")

        result2 = _tool_read_file({"file_path": filepath}, self.ctx)
        self.assertEqual(result2.output["status"], "duplicate")
        self.assertIn("already been read", result2.output["message"])

    def test_force_reread(self):
        filepath = self.create_test_file("test.txt", "content")

        _tool_read_file({"file_path": filepath}, self.ctx)

        result = _tool_read_file(
            {"file_path": filepath, "force_reread": True},
            self.ctx
        )
        self.assertEqual(result.output["status"], "success")

    def test_long_line_warning(self):
        long_line = "x" * 250000
        filepath = self.create_test_file("long.txt", f"short line\n{long_line}\nshort line\n")

        result = _tool_read_file({"file_path": filepath}, self.ctx)

        self.assertEqual(result.output["status"], "success")
        self.assertIn("warnings", result.output)
        self.assertIn("very long lines", result.output["warnings"][0])
        self.assertIn("250000", result.output["warnings"][0])
        self.assertIn("tokens", result.output["warnings"][0])


class TestWriteFile(TestFileOpsBase):

    def test_write_simple_file(self):
        filepath = os.path.join(self.test_dir, "new.txt")
        content = "Hello, World!"

        result = _tool_write_file(
            {"file_path": filepath, "content": content},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertTrue(os.path.exists(filepath))
        with open(filepath, 'r') as f:
            self.assertEqual(f.read(), content)

    def test_write_prevents_overwrite(self):
        filepath = self.create_test_file("existing.txt", "original")

        with self.assertRaises(ValueError) as cm:
            _tool_write_file(
                {"file_path": filepath, "content": "new"},
                self.ctx
            )

        self.assertIn("already exists", str(cm.exception))
        self.assertIn("overwrite=true", str(cm.exception))

    def test_write_with_overwrite(self):
        filepath = self.create_test_file("existing.txt", "original")

        result = _tool_write_file(
            {"file_path": filepath, "content": "new", "overwrite": True},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        with open(filepath, 'r') as f:
            self.assertEqual(f.read(), "new")

    def test_write_without_parent_dir(self):
        filepath = os.path.join(self.test_dir, "nested", "deep", "file.txt")

        with self.assertRaises(ValueError) as cm:
            _tool_write_file(
                {"file_path": filepath, "content": "test"},
                self.ctx
            )

        self.assertIn("does not exist", str(cm.exception))
        self.assertIn("create_dirs=true", str(cm.exception))

    def test_write_reserved_name(self):
        import platform
        if platform.system() != 'Windows':
            self.skipTest("Windows-specific test")

        filepath = os.path.join(self.test_dir, "CON.txt")

        with self.assertRaises(ValueError) as cm:
            _tool_write_file(
                {"file_path": filepath, "content": "test"},
                self.ctx
            )

        self.assertIn("reserved filename", str(cm.exception))

    def test_write_large_content(self):
        large_content = "x" * (51 * 1024 * 1024)
        filepath = os.path.join(self.test_dir, "large.txt")

        with self.assertRaises(ValueError) as cm:
            _tool_write_file(
                {"file_path": filepath, "content": large_content},
                self.ctx
            )

        self.assertIn("too large", str(cm.exception).lower())

    def test_write_with_create_dirs(self):
        filepath = os.path.join(self.test_dir, "nested", "deep", "file.txt")

        result = _tool_write_file(
            {"file_path": filepath, "content": "test", "create_dirs": True},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertTrue(os.path.exists(filepath))

    def test_write_to_directory_path(self):
        dirpath = os.path.join(self.test_dir, "testdir")
        os.makedirs(dirpath)

        with self.assertRaises(ValueError) as cm:
            _tool_write_file(
                {"file_path": dirpath, "content": "test", "overwrite": True},
                self.ctx
            )

        error_msg = str(cm.exception).lower()
        self.assertTrue(
            "directory" in error_msg or "permission denied" in error_msg,
            f"Expected directory or permission error, got: {cm.exception}"
        )


class TestEditFile(TestFileOpsBase):

    def test_edit_line_range(self):
        filepath = self.create_test_file(
            "test.txt",
            "line 1\nline 2\nline 3\nline 4\n"
        )

        result = _tool_edit_file(
            {
                "file_path": filepath,
                "edit_mode": "line_range",
                "start_line": 2,
                "end_line": 3,
                "new_content": "new line 2\nnew line 3\n",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        with open(filepath, 'r') as f:
            content = f.read()
        self.assertEqual(content, "line 1\nnew line 2\nnew line 3\nline 4\n")

    def test_edit_single_line(self):
        filepath = self.create_test_file(
            "test.txt",
            "line 1\nline 2\nline 3\n"
        )

        result = _tool_edit_file(
            {
                "file_path": filepath,
                "edit_mode": "line_range",
                "start_line": 2,
                "new_content": "replaced line 2\n",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        with open(filepath, 'r') as f:
            content = f.read()
        self.assertEqual(content, "line 1\nreplaced line 2\nline 3\n")

    def test_edit_find_replace(self):
        filepath = self.create_test_file(
            "test.txt",
            "foo bar foo baz"
        )

        result = _tool_edit_file(
            {
                "file_path": filepath,
                "edit_mode": "find_replace",
                "find_text": "foo",
                "replace_text": "qux",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["replacements_made"], 2)
        with open(filepath, 'r') as f:
            content = f.read()
        self.assertEqual(content, "qux bar qux baz")

    def test_edit_find_replace_single(self):
        filepath = self.create_test_file(
            "test.txt",
            "foo bar foo baz"
        )

        result = _tool_edit_file(
            {
                "file_path": filepath,
                "edit_mode": "find_replace",
                "find_text": "foo",
                "replace_text": "qux",
                "replace_all": False,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["replacements_made"], 1)
        with open(filepath, 'r') as f:
            content = f.read()
        self.assertEqual(content, "qux bar foo baz")

    def test_edit_with_regex(self):
        filepath = self.create_test_file(
            "test.txt",
            "number 123 and 456"
        )

        result = _tool_edit_file(
            {
                "file_path": filepath,
                "edit_mode": "find_replace",
                "find_text": r"\d+",
                "replace_text": "XXX",
                "use_regex": True,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        with open(filepath, 'r') as f:
            content = f.read()
        self.assertEqual(content, "number XXX and XXX")

    def test_edit_line_range_invalid(self):
        filepath = self.create_test_file("test.txt", "line 1\nline 2\n")

        with self.assertRaises(ValueError) as cm:
            _tool_edit_file(
                {
                    "file_path": filepath,
                    "edit_mode": "line_range",
                    "start_line": 10,
                    "new_content": "test"
                },
                self.ctx
            )

        self.assertIn("out of range", str(cm.exception))

    def test_edit_find_no_matches(self):
        filepath = self.create_test_file("test.txt", "foo bar")

        with self.assertRaises(ValueError) as cm:
            _tool_edit_file(
                {
                    "file_path": filepath,
                    "edit_mode": "find_replace",
                    "find_text": "notfound",
                    "replace_text": "test"
                },
                self.ctx
            )

        self.assertIn("No matches found", str(cm.exception))

    def test_edit_empty_find_text(self):
        filepath = self.create_test_file("test.txt", "foo bar")

        with self.assertRaises(ValueError) as cm:
            _tool_edit_file(
                {
                    "file_path": filepath,
                    "edit_mode": "find_replace",
                    "find_text": "",
                    "replace_text": "test"
                },
                self.ctx
            )

        self.assertIn("cannot be empty", str(cm.exception))


class TestMoveFile(TestFileOpsBase):

    def test_move_simple(self):
        src = self.create_test_file("source.txt", "content")
        dst = os.path.join(self.test_dir, "dest.txt")

        result = _tool_move_file(
            {"source_path": src, "destination_path": dst},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertFalse(os.path.exists(src))
        self.assertTrue(os.path.exists(dst))

    def test_move_rename(self):
        src = self.create_test_file("old_name.txt", "content")
        dst = os.path.join(self.test_dir, "new_name.txt")

        result = _tool_move_file(
            {"source_path": src, "destination_path": dst},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertTrue(os.path.exists(dst))

    def test_move_prevents_overwrite(self):
        src = self.create_test_file("source.txt", "content1")
        dst = self.create_test_file("dest.txt", "content2")

        with self.assertRaises(ValueError) as cm:
            _tool_move_file(
                {"source_path": src, "destination_path": dst},
                self.ctx
            )

        self.assertIn("already exists", str(cm.exception))

    def test_move_with_overwrite(self):
        src = self.create_test_file("source.txt", "new")
        dst = self.create_test_file("dest.txt", "old")

        result = _tool_move_file(
            {
                "source_path": src,
                "destination_path": dst,
                "overwrite": True
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        with open(dst, 'r') as f:
            self.assertEqual(f.read(), "new")

    def test_move_with_create_dirs(self):
        src = self.create_test_file("source.txt", "content")
        dst = os.path.join(self.test_dir, "nested", "dest.txt")

        result = _tool_move_file(
            {
                "source_path": src,
                "destination_path": dst,
                "create_dirs": True
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertTrue(os.path.exists(dst))

    def test_move_to_self(self):
        src = self.create_test_file("source.txt", "content")

        with self.assertRaises(ValueError) as cm:
            _tool_move_file(
                {"source_path": src, "destination_path": src},
                self.ctx
            )

        self.assertIn("same file", str(cm.exception))


class TestMoveLines(TestFileOpsBase):

    def test_move_lines_simple(self):
        src = self.create_test_file(
            "source.txt",
            "line 1\nline 2\nline 3\nline 4\n"
        )
        dst = self.create_test_file("dest.txt", "dest line 1\n")

        result = _tool_move_lines(
            {
                "source_path": src,
                "start_line": 2,
                "end_line": 3,
                "destination_path": dst,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["lines_moved"], 2)

        with open(src, 'r') as f:
            src_content = f.read()
        self.assertEqual(src_content, "line 1\nline 4\n")

        with open(dst, 'r') as f:
            dst_content = f.read()
        self.assertEqual(dst_content, "dest line 1\nline 2\nline 3\n")

    def test_move_lines_without_removal(self):
        src = self.create_test_file(
            "source.txt",
            "line 1\nline 2\nline 3\n"
        )
        dst = self.create_test_file("dest.txt", "")

        result = _tool_move_lines(
            {
                "source_path": src,
                "start_line": 2,
                "end_line": 2,
                "destination_path": dst,
                "remove_from_source": False,
                "create_backup": False
            },
            self.ctx
        )

        with open(src, 'r') as f:
            src_content = f.read()
        self.assertEqual(src_content, "line 1\nline 2\nline 3\n")

    def test_move_lines_to_new_file(self):
        src = self.create_test_file("source.txt", "line 1\nline 2\n")
        dst = os.path.join(self.test_dir, "new_dest.txt")

        result = _tool_move_lines(
            {
                "source_path": src,
                "start_line": 1,
                "end_line": 1,
                "destination_path": dst,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertTrue(os.path.exists(dst))

    def test_move_lines_with_insert_position(self):
        src = self.create_test_file("source.txt", "src line\n")
        dst = self.create_test_file(
            "dest.txt",
            "dest line 1\ndest line 2\n"
        )

        result = _tool_move_lines(
            {
                "source_path": src,
                "start_line": 1,
                "destination_path": dst,
                "insert_at_line": 2,
                "create_backup": False
            },
            self.ctx
        )

        with open(dst, 'r') as f:
            dst_content = f.read()
        self.assertEqual(dst_content, "dest line 1\nsrc line\ndest line 2\n")

    def test_move_lines_to_self(self):
        src = self.create_test_file("source.txt", "line 1\nline 2\nline 3\n")

        with self.assertRaises(ValueError) as cm:
            _tool_move_lines(
                {
                    "source_path": src,
                    "start_line": 1,
                    "destination_path": src,
                    "create_backup": False
                },
                self.ctx
            )

        self.assertIn("same file", str(cm.exception))
        self.assertIn("corrupt", str(cm.exception).lower())


class TestSearchFiles(TestFileOpsBase):

    def test_search_simple_pattern(self):
        self.create_test_file("test1.py", "")
        self.create_test_file("test2.py", "")
        self.create_test_file("test.txt", "")

        result = _tool_search_files(
            {"pattern": "*.py", "search_root": self.test_dir},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["summary"]["total_matches"], 2)

    def test_search_recursive_pattern(self):
        self.create_test_file("dir1/test1.py", "")
        self.create_test_file("dir2/test2.py", "")
        self.create_test_file("test.py", "")

        result = _tool_search_files(
            {"pattern": "**/*.py", "search_root": self.test_dir},
            self.ctx
        )

        self.assertEqual(result.output["summary"]["total_matches"], 3)

    def test_search_no_matches(self):
        self.create_test_file("test.txt", "")

        result = _tool_search_files(
            {"pattern": "*.py", "search_root": self.test_dir},
            self.ctx
        )

        self.assertEqual(result.output["summary"]["total_matches"], 0)
        self.assertIn("No files matching", result.output["message"])

    def test_search_max_results(self):
        for i in range(20):
            self.create_test_file(f"test{i}.py", "")

        result = _tool_search_files(
            {
                "pattern": "*.py",
                "search_root": self.test_dir,
                "max_results": 10
            },
            self.ctx
        )

        self.assertEqual(len(result.output["matches"]), 10)
        self.assertTrue(result.output["summary"]["truncated"])

    def test_search_directory_traversal(self):
        self.create_test_file("test.py", "")

        with self.assertRaises(ValueError) as cm:
            _tool_search_files(
                {"pattern": "../*.py", "search_root": self.test_dir},
                self.ctx
            )

        self.assertIn("directory traversal", str(cm.exception).lower())


class TestListDir(TestFileOpsBase):

    def test_list_simple(self):
        self.create_test_file("file1.txt", "")
        self.create_test_file("file2.txt", "")
        os.makedirs(os.path.join(self.test_dir, "subdir"))

        result = _tool_list_dir(
            {"directory_path": self.test_dir},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        summary = result.output["summary"]
        self.assertEqual(summary["files"], 2)
        self.assertEqual(summary["directories"], 1)

    def test_list_files_only(self):
        self.create_test_file("file.txt", "")
        os.makedirs(os.path.join(self.test_dir, "subdir"))

        result = _tool_list_dir(
            {
                "directory_path": self.test_dir,
                "include_files": True,
                "include_dirs": False
            },
            self.ctx
        )

        summary = result.output["summary"]
        self.assertEqual(summary["files"], 1)
        self.assertEqual(summary["directories"], 0)

    def test_list_dirs_only(self):
        self.create_test_file("file.txt", "")
        os.makedirs(os.path.join(self.test_dir, "subdir"))

        result = _tool_list_dir(
            {
                "directory_path": self.test_dir,
                "include_files": False,
                "include_dirs": True
            },
            self.ctx
        )

        summary = result.output["summary"]
        self.assertEqual(summary["files"], 0)
        self.assertEqual(summary["directories"], 1)

    def test_list_with_filter(self):
        self.create_test_file("file1.py", "")
        self.create_test_file("file2.txt", "")
        self.create_test_file("file3.py", "")

        result = _tool_list_dir(
            {
                "directory_path": self.test_dir,
                "filter_extensions": [".py"]
            },
            self.ctx
        )

        summary = result.output["summary"]
        self.assertEqual(summary["files"], 2)

    def test_list_recursive(self):
        self.create_test_file("file1.txt", "")
        self.create_test_file("subdir/file2.txt", "")
        self.create_test_file("subdir/nested/file3.txt", "")

        result = _tool_list_dir(
            {
                "directory_path": self.test_dir,
                "recursive": True,
                "include_dirs": False
            },
            self.ctx
        )

        summary = result.output["summary"]
        self.assertEqual(summary["files"], 3)


class TestAttachFile(TestFileOpsBase):

    def test_attach_nonexistent_file(self):
        filepath = os.path.join(self.test_dir, "nonexistent.txt")

        from agents.tools.file_ops.attach_func import _tool_attach_file

        with self.assertRaises(ValueError) as cm:
            _tool_attach_file({"file_path": filepath}, self.ctx)

        self.assertIn("does not exist", str(cm.exception))

    def test_attach_directory(self):
        dirpath = os.path.join(self.test_dir, "testdir")
        os.makedirs(dirpath)

        from agents.tools.file_ops.attach_func import _tool_attach_file

        with self.assertRaises(ValueError) as cm:
            _tool_attach_file({"file_path": dirpath}, self.ctx)

        self.assertIn("directory", str(cm.exception).lower())


def run_tests():
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return result.wasSuccessful()


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)