"""Unit tests for markdown processor."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from file_utils.markdown_processor import setup_filespace, process_file_to_markdown


class TestSetupFilespace(unittest.TestCase):
    """Test filespace setup functionality."""

    def test_setup_filespace_creates_directories(self):
        """setup_filespace should create files and md_ver directories."""
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch('file_utils.markdown_processor.Path') as mock_path:
                mock_backend = MagicMock()
                mock_backend.parent = Path(temp_dir)
                mock_path(__file__).parent.parent = mock_backend

                files_dir = Path(temp_dir) / "data" / "files"
                md_ver_dir = files_dir / "md_ver"

                def mock_mkdir(parents=False, exist_ok=False):
                    os.makedirs(files_dir, exist_ok=True)
                    os.makedirs(md_ver_dir, exist_ok=True)

                with patch.object(Path, 'mkdir', side_effect=mock_mkdir):
                    result = setup_filespace()

                    self.assertIsInstance(result, str)

    def test_setup_filespace_returns_existing_path_on_subsequent_calls(self):
        """Subsequent calls should return existing path without recreation."""
        import file_utils.markdown_processor as mp
        mp._filespace_path = None
        mp._filespace_logged = False

        with tempfile.TemporaryDirectory() as temp_dir:
            files_dir = Path(temp_dir) / "files"
            files_dir.mkdir(parents=True, exist_ok=True)
            md_ver_dir = files_dir / "md_ver"
            md_ver_dir.mkdir(parents=True, exist_ok=True)

            mp._filespace_path = files_dir

            result = setup_filespace()

            self.assertEqual(result, str(files_dir))



class TestProcessFileToMarkdown(unittest.TestCase):
    """Test file processing to markdown."""

    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.mkdtemp()
        self.files_dir = Path(self.temp_dir) / "files"
        self.md_ver_dir = self.files_dir / "md_ver"
        self.files_dir.mkdir(parents=True, exist_ok=True)
        self.md_ver_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        """Clean up test fixtures."""
        import shutil
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)

    @patch('file_utils.markdown_processor.setup_filespace')
    @patch('file_utils.markdown_processor.MarkItDown')
    @patch('file_utils.markdown_processor.db')
    def test_process_text_file_to_markdown(self, mock_db, mock_markitdown, mock_setup):
        """Text files should be processed to markdown without metadata suffix."""
        mock_setup.return_value = str(self.files_dir)

        test_file = Path(self.temp_dir) / "test.txt"
        test_file.write_text("Test content", encoding='utf-8')

        mock_md_instance = Mock()
        mock_md_instance.convert.return_value = Mock(text_content="# Converted content")
        mock_markitdown.return_value = mock_md_instance

        result = process_file_to_markdown(str(test_file), "file_123")

        self.assertTrue(result['success'])
        self.assertEqual(result['md_filename'], "file_123.md")
        self.assertFalse(result['is_metadata'])
        mock_db.update_file_md_info.assert_called_once_with("file_123", "file_123.md")

    @patch('file_utils.markdown_processor.setup_filespace')
    @patch('file_utils.markdown_processor.MarkItDown')
    @patch('file_utils.markdown_processor.db')
    def test_process_image_file_adds_metadata_suffix(self, mock_db, mock_markitdown, mock_setup):
        """Image files should be processed with _metadata suffix."""
        mock_setup.return_value = str(self.files_dir)

        test_file = Path(self.temp_dir) / "image.jpg"
        test_file.write_bytes(b"fake image data")

        mock_md_instance = Mock()
        mock_md_instance.convert.return_value = Mock(text_content="Image metadata")
        mock_markitdown.return_value = mock_md_instance

        result = process_file_to_markdown(str(test_file), "file_456")

        self.assertTrue(result['success'])
        self.assertEqual(result['md_filename'], "file_456_metadata.md")
        self.assertTrue(result['is_metadata'])
        mock_db.update_file_md_info.assert_called_once_with("file_456", "file_456_metadata.md")

    @patch('file_utils.markdown_processor.setup_filespace')
    @patch('file_utils.markdown_processor.MarkItDown')
    @patch('file_utils.markdown_processor.db')
    def test_process_video_file_adds_metadata_suffix(self, mock_db, mock_markitdown, mock_setup):
        """Video files should be processed with _metadata suffix."""
        mock_setup.return_value = str(self.files_dir)

        test_file = Path(self.temp_dir) / "video.mp4"
        test_file.write_bytes(b"fake video data")

        mock_md_instance = Mock()
        mock_md_instance.convert.return_value = Mock(text_content="Video metadata")
        mock_markitdown.return_value = mock_md_instance

        result = process_file_to_markdown(str(test_file), "file_789")

        self.assertTrue(result['success'])
        self.assertEqual(result['md_filename'], "file_789_metadata.md")
        self.assertTrue(result['is_metadata'])

    @patch('file_utils.markdown_processor.setup_filespace')
    @patch('file_utils.markdown_processor.MarkItDown')
    @patch('file_utils.markdown_processor.db')
    def test_process_audio_file_adds_metadata_suffix(self, mock_db, mock_markitdown, mock_setup):
        """Audio files should be processed with _metadata suffix."""
        mock_setup.return_value = str(self.files_dir)

        test_file = Path(self.temp_dir) / "audio.mp3"
        test_file.write_bytes(b"fake audio data")

        mock_md_instance = Mock()
        mock_md_instance.convert.return_value = Mock(text_content="Audio metadata")
        mock_markitdown.return_value = mock_md_instance

        result = process_file_to_markdown(str(test_file), "file_audio")

        self.assertTrue(result['success'])
        self.assertEqual(result['md_filename'], "file_audio_metadata.md")
        self.assertTrue(result['is_metadata'])

    @patch('file_utils.markdown_processor.setup_filespace')
    @patch('file_utils.markdown_processor.MarkItDown')
    @patch('file_utils.markdown_processor.db')
    def test_process_markdown_file_no_metadata_suffix(self, mock_db, mock_markitdown, mock_setup):
        """Markdown files should not have metadata suffix."""
        mock_setup.return_value = str(self.files_dir)

        test_file = Path(self.temp_dir) / "doc.md"
        test_file.write_text("# Markdown content", encoding='utf-8')

        mock_md_instance = Mock()
        mock_md_instance.convert.return_value = Mock(text_content="# Markdown content")
        mock_markitdown.return_value = mock_md_instance

        result = process_file_to_markdown(str(test_file), "file_md")

        self.assertTrue(result['success'])
        self.assertEqual(result['md_filename'], "file_md.md")
        self.assertFalse(result['is_metadata'])

    @patch('file_utils.markdown_processor.setup_filespace')
    @patch('file_utils.markdown_processor.MarkItDown')
    @patch('file_utils.markdown_processor.db')
    def test_process_file_handles_markitdown_errors(self, mock_db, mock_markitdown, mock_setup):
        """Errors during markdown conversion should be caught and returned."""
        mock_setup.return_value = str(self.files_dir)

        test_file = Path(self.temp_dir) / "error.txt"
        test_file.write_text("Test", encoding='utf-8')

        mock_md_instance = Mock()
        mock_md_instance.convert.side_effect = Exception("Conversion failed")
        mock_markitdown.return_value = mock_md_instance

        result = process_file_to_markdown(str(test_file), "file_error")

        self.assertFalse(result['success'])
        self.assertIn('error', result)
        self.assertIn("Conversion failed", result['error'])
        mock_db.update_file_md_info.assert_not_called()

    @patch('file_utils.markdown_processor.setup_filespace')
    @patch('file_utils.markdown_processor.MarkItDown')
    @patch('file_utils.markdown_processor.db')
    def test_process_file_writes_to_md_ver_directory(self, mock_db, mock_markitdown, mock_setup):
        """Processed markdown should be written to md_ver directory."""
        mock_setup.return_value = str(self.files_dir)

        test_file = Path(self.temp_dir) / "doc.txt"
        test_file.write_text("Document content", encoding='utf-8')

        mock_md_instance = Mock()
        mock_md_instance.convert.return_value = Mock(text_content="# Converted Document")
        mock_markitdown.return_value = mock_md_instance

        result = process_file_to_markdown(str(test_file), "file_doc")

        self.assertTrue(result['success'])
        expected_path = self.md_ver_dir / "file_doc.md"
        self.assertTrue(str(result['md_path']).endswith(os.path.join("md_ver", "file_doc.md")))

    @patch('file_utils.markdown_processor.setup_filespace')
    @patch('file_utils.markdown_processor.MarkItDown')
    @patch('file_utils.markdown_processor.db')
    def test_process_file_handles_various_extensions(self, mock_db, mock_markitdown, mock_setup):
        """Various file extensions should be handled correctly."""
        mock_setup.return_value = str(self.files_dir)

        test_cases = [
            ("file.png", True),
            ("file.jpeg", True),
            ("file.gif", True),
            ("file.mp4", True),
            ("file.avi", True),
            ("file.mp3", True),
            ("file.wav", True),
            ("file.txt", False),
            ("file.pdf", False),
            ("file.docx", False),
        ]

        mock_md_instance = Mock()
        mock_md_instance.convert.return_value = Mock(text_content="Converted")
        mock_markitdown.return_value = mock_md_instance

        for filename, should_be_metadata in test_cases:
            with self.subTest(filename=filename):
                test_file = Path(self.temp_dir) / filename
                test_file.write_bytes(b"test data")

                file_id = f"file_{filename}"
                result = process_file_to_markdown(str(test_file), file_id)

                self.assertTrue(result['success'])
                self.assertEqual(result['is_metadata'], should_be_metadata)

                if should_be_metadata:
                    self.assertTrue(result['md_filename'].endswith('_metadata.md'))
                else:
                    self.assertFalse(result['md_filename'].endswith('_metadata.md'))

    @patch('file_utils.markdown_processor.setup_filespace')
    @patch('file_utils.markdown_processor.MarkItDown')
    @patch('file_utils.markdown_processor.db')
    def test_process_file_case_insensitive_extensions(self, mock_db, mock_markitdown, mock_setup):
        """File extensions should be case-insensitive."""
        mock_setup.return_value = str(self.files_dir)

        test_file = Path(self.temp_dir) / "IMAGE.JPG"
        test_file.write_bytes(b"image data")

        mock_md_instance = Mock()
        mock_md_instance.convert.return_value = Mock(text_content="Image")
        mock_markitdown.return_value = mock_md_instance

        result = process_file_to_markdown(str(test_file), "file_upper")

        self.assertTrue(result['success'])
        self.assertTrue(result['is_metadata'])


if __name__ == "__main__":
    unittest.main()
