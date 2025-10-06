"""Comprehensive unit tests for file_utils helper functions.

This module tests utility functions used by file operations tools:
- is_likely_binary: Detect binary vs text files
- validate_file_path: Validate file paths
- validate_directory_path: Validate directory paths
- format_file_size: Format file sizes in human-readable format
- check_paths_same: Check if two paths refer to the same file
- is_windows_reserved_name: Check for Windows reserved names
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.tools.file_ops.file_utils import (
    is_likely_binary,
    validate_file_path,
    validate_directory_path,
    format_file_size,
    check_paths_same,
    is_windows_reserved_name,
    BINARY_EXTENSIONS,
    TEXTUAL_EXTENSIONS
)


class TestIsLikelyBinary(unittest.TestCase):
    """Test is_likely_binary function."""

    def setUp(self):
        """Create temporary directory for test files."""
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_binary_extension_detected(self):
        """Should detect binary files by extension."""
        test_file = self.temp_path / "image.png"
        test_file.write_bytes(b"fake png data")

        is_binary, reason = is_likely_binary(test_file)

        self.assertTrue(is_binary)
        self.assertIn(".png", reason)
        self.assertIn("binary format", reason)

    def test_textual_extension_detected(self):
        """Should detect textual files by extension."""
        test_file = self.temp_path / "script.py"
        test_file.write_text("print('hello')", encoding='utf-8')

        is_binary, reason = is_likely_binary(test_file)

        self.assertFalse(is_binary)
        self.assertIn(".py", reason)
        self.assertIn("text format", reason)

    def test_null_bytes_indicate_binary(self):
        """Should detect binary files by null bytes in content."""
        test_file = self.temp_path / "unknown.dat"
        test_file.write_bytes(b"Some text\x00with null bytes")

        is_binary, reason = is_likely_binary(test_file)

        self.assertTrue(is_binary)
        self.assertIn("null bytes", reason)

    def test_utf8_content_detected_as_text(self):
        """Should detect UTF-8 content as textual."""
        test_file = self.temp_path / "unknown.xyz"
        test_file.write_text("Valid UTF-8 text content", encoding='utf-8')

        is_binary, reason = is_likely_binary(test_file)

        self.assertFalse(is_binary)
        self.assertIn("UTF-8", reason)

    def test_non_utf8_content_detected_as_binary(self):
        """Should detect non-UTF-8 content as binary."""
        test_file = self.temp_path / "unknown.xyz"
        test_file.write_bytes(b'\x80\x81\x82\x83\x84\x85')

        is_binary, reason = is_likely_binary(test_file)

        self.assertTrue(is_binary)
        self.assertIn("non-UTF-8", reason)

    def test_all_binary_extensions_recognized(self):
        """Should recognize all binary extensions."""
        for ext in ['.jpg', '.png', '.pdf', '.exe', '.zip']:
            test_file = self.temp_path / f"test{ext}"
            test_file.write_bytes(b"data")

            is_binary, reason = is_likely_binary(test_file)
            self.assertTrue(is_binary, f"Extension {ext} should be binary")

    def test_all_textual_extensions_recognized(self):
        """Should recognize all textual extensions."""
        for ext in ['.py', '.js', '.txt', '.md', '.json']:
            test_file = self.temp_path / f"test{ext}"
            test_file.write_text("content", encoding='utf-8')

            is_binary, reason = is_likely_binary(test_file)
            self.assertFalse(is_binary, f"Extension {ext} should be textual")


class TestValidateFilePath(unittest.TestCase):
    """Test validate_file_path function."""

    def setUp(self):
        """Create temporary directory for test files."""
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_valid_existing_file(self):
        """Should validate an existing file."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("content")

        is_valid, error_msg, resolved_path = validate_file_path(str(test_file))

        self.assertTrue(is_valid)
        self.assertEqual(error_msg, "")
        self.assertIsNotNone(resolved_path)
        self.assertTrue(resolved_path.is_file())

    def test_nonexistent_file_with_must_exist(self):
        """Should fail for nonexistent file when must_exist=True."""
        is_valid, error_msg, resolved_path = validate_file_path(
            "nonexistent.txt",
            must_exist=True
        )

        self.assertFalse(is_valid)
        self.assertIn("does not exist", error_msg)
        self.assertIsNone(resolved_path)

    def test_nonexistent_file_without_must_exist(self):
        """Should succeed for nonexistent file when must_exist=False."""
        is_valid, error_msg, resolved_path = validate_file_path(
            str(self.temp_path / "new.txt"),
            must_exist=False
        )

        self.assertTrue(is_valid)
        self.assertEqual(error_msg, "")
        self.assertIsNotNone(resolved_path)

    def test_directory_when_expecting_file(self):
        """Should fail when path is a directory but file expected."""
        is_valid, error_msg, resolved_path = validate_file_path(
            str(self.temp_path),
            must_exist=True,
            must_be_file=True
        )

        self.assertFalse(is_valid)
        self.assertIn("directory", error_msg.lower())
        self.assertIsNone(resolved_path)

    def test_directory_allowed_when_must_be_file_false(self):
        """Should succeed when directory allowed."""
        is_valid, error_msg, resolved_path = validate_file_path(
            str(self.temp_path),
            must_exist=True,
            must_be_file=False
        )

        self.assertTrue(is_valid)
        self.assertEqual(error_msg, "")
        self.assertIsNotNone(resolved_path)

    def test_relative_path_resolution(self):
        """Should resolve relative paths to absolute."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("content")

        is_valid, error_msg, resolved_path = validate_file_path(str(test_file))

        self.assertTrue(is_valid)
        self.assertTrue(resolved_path.is_absolute())


class TestValidateDirectoryPath(unittest.TestCase):
    """Test validate_directory_path function."""

    def setUp(self):
        """Create temporary directory for tests."""
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_valid_existing_directory(self):
        """Should validate an existing directory."""
        is_valid, error_msg, resolved_path = validate_directory_path(str(self.temp_path))

        self.assertTrue(is_valid)
        self.assertEqual(error_msg, "")
        self.assertIsNotNone(resolved_path)
        self.assertTrue(resolved_path.is_dir())

    def test_nonexistent_directory_with_must_exist(self):
        """Should fail for nonexistent directory when must_exist=True."""
        is_valid, error_msg, resolved_path = validate_directory_path(
            "nonexistent_dir",
            must_exist=True
        )

        self.assertFalse(is_valid)
        self.assertIn("does not exist", error_msg)
        self.assertIsNone(resolved_path)

    def test_nonexistent_directory_without_must_exist(self):
        """Should succeed for nonexistent directory when must_exist=False."""
        is_valid, error_msg, resolved_path = validate_directory_path(
            str(self.temp_path / "new_dir"),
            must_exist=False
        )

        self.assertTrue(is_valid)
        self.assertEqual(error_msg, "")
        self.assertIsNotNone(resolved_path)

    def test_file_when_expecting_directory(self):
        """Should fail when path is a file but directory expected."""
        test_file = self.temp_path / "file.txt"
        test_file.write_text("content")

        is_valid, error_msg, resolved_path = validate_directory_path(
            str(test_file),
            must_exist=True
        )

        self.assertFalse(is_valid)
        self.assertIn("file", error_msg.lower())
        self.assertIsNone(resolved_path)

    def test_relative_path_resolution(self):
        """Should resolve relative paths to absolute."""
        is_valid, error_msg, resolved_path = validate_directory_path(str(self.temp_path))

        self.assertTrue(is_valid)
        self.assertTrue(resolved_path.is_absolute())


class TestFormatFileSize(unittest.TestCase):
    """Test format_file_size function."""

    def test_format_bytes(self):
        """Should format bytes correctly."""
        self.assertEqual(format_file_size(0), "0.00 B")
        self.assertEqual(format_file_size(1), "1.00 B")
        self.assertEqual(format_file_size(512), "512.00 B")

    def test_format_kilobytes(self):
        """Should format kilobytes correctly."""
        self.assertEqual(format_file_size(1024), "1.00 KB")
        self.assertEqual(format_file_size(2048), "2.00 KB")
        self.assertEqual(format_file_size(1536), "1.50 KB")

    def test_format_megabytes(self):
        """Should format megabytes correctly."""
        self.assertEqual(format_file_size(1024 * 1024), "1.00 MB")
        self.assertEqual(format_file_size(5 * 1024 * 1024), "5.00 MB")

    def test_format_gigabytes(self):
        """Should format gigabytes correctly."""
        self.assertEqual(format_file_size(1024 * 1024 * 1024), "1.00 GB")
        self.assertEqual(format_file_size(3 * 1024 * 1024 * 1024), "3.00 GB")

    def test_format_terabytes(self):
        """Should format terabytes correctly."""
        self.assertEqual(format_file_size(1024 * 1024 * 1024 * 1024), "1.00 TB")

    def test_format_petabytes(self):
        """Should format petabytes correctly."""
        size_pb = 1024 * 1024 * 1024 * 1024 * 1024
        result = format_file_size(size_pb)
        self.assertIn("PB", result)

    def test_format_decimal_precision(self):
        """Should maintain 2 decimal places."""
        result = format_file_size(1536)  
        self.assertTrue(result.startswith("1.50"))


class TestCheckPathsSame(unittest.TestCase):
    """Test check_paths_same function."""

    def setUp(self):
        """Create temporary directory for test files."""
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_same_path_returns_true(self):
        """Should return True for identical paths."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("content")

        result = check_paths_same(test_file, test_file)
        self.assertTrue(result)

    def test_different_paths_returns_false(self):
        """Should return False for different paths."""
        file1 = self.temp_path / "file1.txt"
        file2 = self.temp_path / "file2.txt"
        file1.write_text("content1")
        file2.write_text("content2")

        result = check_paths_same(file1, file2)
        self.assertFalse(result)

    def test_relative_vs_absolute_same_path(self):
        """Should recognize same path in different forms."""
        test_file = self.temp_path / "test.txt"
        test_file.write_text("content")

        path1 = test_file.resolve()
        path2 = Path(str(test_file))

        result = check_paths_same(path1, path2)
        self.assertTrue(result)

    def test_nonexistent_paths_handled(self):
        """Should handle nonexistent paths without error."""
        path1 = self.temp_path / "nonexistent1.txt"
        path2 = self.temp_path / "nonexistent2.txt"

        result = check_paths_same(path1, path2)
        self.assertFalse(result)


class TestIsWindowsReservedName(unittest.TestCase):
    """Test is_windows_reserved_name function."""

    @patch('platform.system', return_value='Windows')
    def test_reserved_names_on_windows(self, mock_platform):
        """Should detect Windows reserved names on Windows."""
        reserved_names = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1']

        for name in reserved_names:
            self.assertTrue(is_windows_reserved_name(name), f"{name} should be reserved")
            self.assertTrue(is_windows_reserved_name(name.lower()), f"{name.lower()} should be reserved")

    @patch('platform.system', return_value='Windows')
    def test_non_reserved_names_on_windows(self, mock_platform):
        """Should not detect non-reserved names as reserved."""
        normal_names = ['test.txt', 'file.py', 'document.docx', 'README.md']

        for name in normal_names:
            self.assertFalse(is_windows_reserved_name(name), f"{name} should not be reserved")

    @patch('platform.system', return_value='Linux')
    def test_no_reserved_names_on_linux(self, mock_platform):
        """Should not detect any reserved names on Linux."""
        names = ['CON', 'PRN', 'AUX', 'COM1', 'test.txt']

        for name in names:
            self.assertFalse(is_windows_reserved_name(name), f"{name} should not be reserved on Linux")

    @patch('platform.system', return_value='Windows')
    def test_reserved_name_with_extension(self, mock_platform):
        """Should detect reserved names even with extensions."""
        self.assertTrue(is_windows_reserved_name("CON.txt"))
        self.assertTrue(is_windows_reserved_name("con.txt"))

    @patch('platform.system', return_value='Windows')
    def test_all_com_ports(self, mock_platform):
        """Should detect all COM port names (COM1-COM9)."""
        for i in range(1, 10):
            self.assertTrue(is_windows_reserved_name(f"COM{i}"))

    @patch('platform.system', return_value='Windows')
    def test_all_lpt_ports(self, mock_platform):
        """Should detect all LPT port names (LPT1-LPT9)."""
        for i in range(1, 10):
            self.assertTrue(is_windows_reserved_name(f"LPT{i}"))


class TestExtensionSets(unittest.TestCase):
    """Test that extension sets are properly defined."""

    def test_binary_extensions_exist(self):
        """Should have binary extensions defined."""
        self.assertGreater(len(BINARY_EXTENSIONS), 0)
        self.assertIn('.jpg', BINARY_EXTENSIONS)
        self.assertIn('.png', BINARY_EXTENSIONS)
        self.assertIn('.pdf', BINARY_EXTENSIONS)

    def test_textual_extensions_exist(self):
        """Should have textual extensions defined."""
        self.assertGreater(len(TEXTUAL_EXTENSIONS), 0)
        self.assertIn('.py', TEXTUAL_EXTENSIONS)
        self.assertIn('.js', TEXTUAL_EXTENSIONS)
        self.assertIn('.txt', TEXTUAL_EXTENSIONS)

    def test_no_overlap_between_sets(self):
        """Binary and textual extensions should not overlap."""
        overlap = BINARY_EXTENSIONS & TEXTUAL_EXTENSIONS
        self.assertEqual(len(overlap), 0, f"Found overlapping extensions: {overlap}")

    def test_extensions_lowercase(self):
        """All extensions should be lowercase."""
        for ext in BINARY_EXTENSIONS:
            self.assertEqual(ext, ext.lower(), f"Extension {ext} is not lowercase")

        for ext in TEXTUAL_EXTENSIONS:
            self.assertEqual(ext, ext.lower(), f"Extension {ext} is not lowercase")

    def test_extensions_start_with_dot(self):
        """All extensions should start with a dot."""
        for ext in BINARY_EXTENSIONS:
            self.assertTrue(ext.startswith('.'), f"Extension {ext} doesn't start with dot")

        for ext in TEXTUAL_EXTENSIONS:
            self.assertTrue(ext.startswith('.'), f"Extension {ext} doesn't start with dot")


if __name__ == "__main__":
    unittest.main()
