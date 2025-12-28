"""Comprehensive unit tests for context_manager.py"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

backend_dir = Path(__file__).resolve().parents[3]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.context.context_manager import ContextManager


class TestTruncateChatHistory(unittest.TestCase):
    """Test _truncate_chat_history method."""

    def setUp(self):
        self.cm = ContextManager()

    def test_empty_history_returns_empty(self):
        result = self.cm._truncate_chat_history([], 1000)
        self.assertEqual(result, [])

    def test_history_within_budget_unchanged(self):
        history = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"}
        ]
        result = self.cm._truncate_chat_history(history, 100000)
        self.assertEqual(result, history)

    def test_history_over_budget_truncates_oldest(self):
        """History over budget should truncate oldest messages, keeping newest."""
        history = [
            {"role": "user", "content": "a" * 500},      # 600 chars (500 capped + 100 overhead)
            {"role": "assistant", "content": "b" * 500},  # 600 chars
            {"role": "user", "content": "c" * 500},      # 600 chars
            {"role": "assistant", "content": "d" * 500},  # 600 chars
        ]
        # Budget of 1500 allows ~2 messages (1200 chars)
        result = self.cm._truncate_chat_history(history, 1500)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0], history[-2])  # Second-to-last kept
        self.assertEqual(result[1], history[-1])  # Last message kept

    def test_always_keeps_at_least_newest_message(self):
        history = [
            {"role": "user", "content": "a" * 10000},
            {"role": "assistant", "content": "b" * 10000},
        ]
        result = self.cm._truncate_chat_history(history, 100)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0], history[-1])

    def test_handles_missing_content_field(self):
        history = [
            {"role": "user"},
            {"role": "assistant", "content": "Hello"}
        ]
        result = self.cm._truncate_chat_history(history, 10000)
        self.assertEqual(len(result), 2)

    def test_truncates_long_content_in_calculation(self):
        """Should truncate content over 500 chars for calculation."""
        history = [
            {"role": "user", "content": "a" * 1000},  # Counted as 600 (500+100)
            {"role": "assistant", "content": "b" * 100}  # Counted as 200
        ]
        result = self.cm._truncate_chat_history(history, 1000)
        self.assertEqual(len(result), 2)


class TestFormatAttachedFiles(unittest.TestCase):
    """Test _format_attached_files method."""

    def setUp(self):
        self.cm = ContextManager()

    def test_returns_none_for_empty_list(self):
        result = self.cm._format_attached_files([])
        self.assertIsNone(result)

    def test_returns_none_for_none_input(self):
        result = self.cm._format_attached_files(None)
        self.assertIsNone(result)

    def test_formats_single_file_correctly(self):
        files = [{"name": "test.txt"}]
        result = self.cm._format_attached_files(files)
        self.assertEqual(result, "[Attached: test.txt]")

    def test_formats_multiple_files_with_commas(self):
        files = [
            {"name": "file1.txt"},
            {"name": "file2.pdf"},
            {"name": "file3.jpg"}
        ]
        result = self.cm._format_attached_files(files)
        self.assertEqual(result, "[Attached: file1.txt, file2.pdf, file3.jpg]")

    def test_handles_missing_name_key(self):
        """Files without 'name' key should use 'unknown'."""
        files = [{"path": "/some/path"}, {"name": "real.txt"}]
        result = self.cm._format_attached_files(files)
        self.assertEqual(result, "[Attached: unknown, real.txt]")


class TestBuildRouterContext(unittest.TestCase):
    """Test build_router_context method."""

    def setUp(self):
        self.cm = ContextManager()

    @patch('agents.tools.tool_registry.tool_registry')
    def test_empty_inputs_produce_minimal_output(self, mock_registry):
        """Empty inputs with no tools should produce empty string."""
        mock_registry.get_all_tools.return_value = []
        result = self.cm.build_router_context(None, None, None)
        self.assertIsInstance(result, str)
        self.assertEqual(result, "")

    @patch('agents.tools.tool_registry.tool_registry')
    def test_includes_truncated_history(self, mock_registry):
        mock_registry.get_all_tools.return_value = []
        history = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi"}
        ]
        result = self.cm.build_router_context(history, None, None)
        self.assertIn("Chat History", result)
        self.assertIn("USER: Hello", result)
        self.assertIn("ASSISTANT: Hi", result)

    @patch('agents.tools.tool_registry.tool_registry')
    def test_includes_current_message(self, mock_registry):
        mock_registry.get_all_tools.return_value = []
        result = self.cm.build_router_context(None, "What is the weather?", None)
        self.assertIn("Current Request", result)
        self.assertIn("What is the weather?", result)

    @patch('agents.tools.tool_registry.tool_registry')
    def test_includes_attached_files_formatting(self, mock_registry):
        mock_registry.get_all_tools.return_value = []
        files = [{"name": "data.csv"}]
        result = self.cm.build_router_context(None, "Analyze this", files)
        self.assertIn("[Attached: data.csv]", result)

    @patch('agents.tools.tool_registry.tool_registry')
    def test_includes_available_tools(self, mock_registry):
        mock_tool = MagicMock()
        mock_tool.name = "file_read"
        mock_tool.description = "Read a file"
        mock_tool.in_schema = {
            "properties": {
                "path": {"type": "string"},
                "encoding": {"type": "string"}
            },
            "required": ["path"]
        }
        mock_registry.get_all_tools.return_value = [mock_tool]

        result = self.cm.build_router_context(None, None, None)
        self.assertIn("file_read", result)
        self.assertIn("Read a file", result)
        self.assertIn("path: string (required)", result)
        self.assertIn("encoding: string", result)

    @patch('agents.tools.tool_registry.tool_registry')
    @patch.object(ContextManager, 'ROUTER_HISTORY_MAX_CHARS', 1000)
    def test_shows_omitted_message_count(self, mock_registry):
        mock_registry.get_all_tools.return_value = []
        # With patched limit of 1000 chars, 5 messages of 600 chars each will trigger truncation
        history = [{"role": "user", "content": "a" * 500} for _ in range(5)]
        result = self.cm.build_router_context(history, None, None)
        self.assertIn("older messages omitted", result)


class TestCountTokens(unittest.TestCase):
    """Test count_tokens method."""

    def setUp(self):
        self.cm = ContextManager()
        self.cm._provider_map = None  # Reset cache before each test

    def test_empty_text_returns_zero(self):
        result = self.cm.count_tokens("", "model", "provider")
        self.assertEqual(result, 0)

    @patch('agents.context.context_manager.get_provider_map')
    def test_delegates_to_provider_when_available(self, mock_get_map):
        mock_provider = MagicMock()
        mock_provider.count_tokens.return_value = 42
        mock_get_map.return_value = {"gemini": mock_provider}

        result = self.cm.count_tokens("Hello world", "flash", "gemini")
        self.assertEqual(result, 42)
        mock_provider.count_tokens.assert_called_once_with("Hello world", "flash")

    @patch('agents.context.context_manager.get_provider_map')
    def test_falls_back_when_provider_fails(self, mock_get_map):
        """Should use fallback when provider method raises exception."""
        mock_provider = MagicMock()
        mock_provider.count_tokens.side_effect = Exception("API Error")
        mock_get_map.return_value = {"gemini": mock_provider}

        with patch.object(self.cm, '_fallback_count', return_value=10) as mock_fallback:
            result = self.cm.count_tokens("Hello", "model", "gemini")
            self.assertEqual(result, 10)
            mock_fallback.assert_called_once_with("Hello")

    @patch('agents.context.context_manager.get_provider_map')
    def test_falls_back_for_unknown_provider(self, mock_get_map):
        mock_get_map.return_value = {}

        with patch.object(self.cm, '_fallback_count', return_value=5) as mock_fallback:
            result = self.cm.count_tokens("Test", "model", "unknown")
            self.assertEqual(result, 5)

    @patch('agents.context.context_manager.get_provider_map')
    def test_falls_back_when_provider_has_no_method(self, mock_get_map):
        """Should use fallback when provider has no count_tokens method."""
        mock_provider = MagicMock(spec=[])  # No count_tokens method
        mock_get_map.return_value = {"provider": mock_provider}

        with patch.object(self.cm, '_fallback_count', return_value=7) as mock_fallback:
            result = self.cm.count_tokens("Text", "model", "provider")
            self.assertEqual(result, 7)


class TestFallbackCount(unittest.TestCase):
    """Test _fallback_count method."""

    def setUp(self):
        self.cm = ContextManager()

    @patch('agents.context.context_manager.Config')
    def test_returns_at_least_one(self, mock_config):
        mock_config.get_fallback_chars_per_token.return_value = 4
        result = self.cm._fallback_count("a")
        self.assertGreaterEqual(result, 1)

    @patch('agents.context.context_manager.Config')
    def test_scales_with_text_length(self, mock_config):
        mock_config.get_fallback_chars_per_token.return_value = 4
        short = self.cm._fallback_count("ab")      # 2 chars → max(1, 2//4) = 1
        long = self.cm._fallback_count("a" * 100)  # 100 chars → 100//4 = 25
        self.assertEqual(short, 1)
        self.assertEqual(long, 25)

    @patch('agents.context.context_manager.Config')
    def test_uses_config_ratio(self, mock_config):
        mock_config.get_fallback_chars_per_token.return_value = 4
        result = self.cm._fallback_count("a" * 100)
        self.assertEqual(result, 25)


class TestGetMethodInfo(unittest.TestCase):
    """Test _get_method_info method."""

    def setUp(self):
        self.cm = ContextManager()

    def test_api_source_returns_provider_api_not_estimated(self):
        method, is_estimated = self.cm._get_method_info("gemini", "api")
        self.assertEqual(method, "gemini_api")
        self.assertFalse(is_estimated)

    @patch('agents.context.context_manager.Config')
    def test_native_method_returns_correct_display(self, mock_config):
        mock_config.get_token_counting_method.return_value = "native"
        method, is_estimated = self.cm._get_method_info("gemini", "counting")
        self.assertEqual(method, "gemini_native")
        self.assertFalse(is_estimated)

    @patch('agents.context.context_manager.Config')
    def test_tiktoken_method_returns_correct_display(self, mock_config):
        mock_config.get_token_counting_method.return_value = "tiktoken"
        mock_config.get_tiktoken_encoding.return_value = "cl100k_base"
        method, is_estimated = self.cm._get_method_info("openrouter", "counting")
        self.assertEqual(method, "tiktoken_cl100k_base")
        self.assertFalse(is_estimated)

    @patch('agents.context.context_manager.Config')
    def test_fallback_method_returns_is_estimated_true(self, mock_config):
        mock_config.get_token_counting_method.return_value = "fallback"
        method, is_estimated = self.cm._get_method_info("unknown", "counting")
        self.assertEqual(method, "char_approximation")
        self.assertTrue(is_estimated)

    @patch('agents.context.context_manager.Config')
    def test_unknown_method_defaults_to_char_approximation(self, mock_config):
        """is_estimated only True when method is literally 'fallback'."""
        mock_config.get_token_counting_method.return_value = "unknown_method"
        method, is_estimated = self.cm._get_method_info("provider", "counting")
        self.assertEqual(method, "char_approximation")
        self.assertFalse(is_estimated)


class TestGetImageDimensions(unittest.TestCase):
    """Test _get_image_dimensions method."""

    def setUp(self):
        self.cm = ContextManager()

    @patch('PIL.Image.open')
    def test_returns_dimensions_for_valid_image(self, mock_open):
        mock_img = MagicMock()
        mock_img.width = 1920
        mock_img.height = 1080
        mock_open.return_value.__enter__.return_value = mock_img

        width, height = self.cm._get_image_dimensions(Path("/fake/image.jpg"))
        self.assertEqual(width, 1920)
        self.assertEqual(height, 1080)

    @patch('PIL.Image.open')
    def test_returns_none_tuple_when_pil_fails(self, mock_open):
        mock_open.side_effect = Exception("Cannot open image")

        width, height = self.cm._get_image_dimensions(Path("/fake/bad.jpg"))
        self.assertIsNone(width)
        self.assertIsNone(height)


class TestGetMediaDuration(unittest.TestCase):
    """Test _get_media_duration method."""

    def setUp(self):
        self.cm = ContextManager()

    @patch('file_utils.file_converter._check_ffmpeg_available')
    @patch('subprocess.run')
    def test_returns_duration_for_valid_media(self, mock_run, mock_ffmpeg):
        mock_ffmpeg.return_value = True
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = b"125.5"
        mock_run.return_value = mock_result

        duration = self.cm._get_media_duration(Path("/fake/video.mp4"))
        self.assertEqual(duration, 125.5)

    @patch('file_utils.file_converter._check_ffmpeg_available')
    def test_returns_none_when_ffmpeg_unavailable(self, mock_ffmpeg):
        mock_ffmpeg.return_value = False
        duration = self.cm._get_media_duration(Path("/fake/video.mp4"))
        self.assertIsNone(duration)

    @patch('file_utils.file_converter._check_ffmpeg_available')
    @patch('subprocess.run')
    def test_returns_none_when_ffprobe_fails(self, mock_run, mock_ffmpeg):
        mock_ffmpeg.return_value = True
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_run.return_value = mock_result

        duration = self.cm._get_media_duration(Path("/fake/bad.mp4"))
        self.assertIsNone(duration)

    @patch('file_utils.file_converter._check_ffmpeg_available')
    @patch('subprocess.run')
    def test_handles_subprocess_exception(self, mock_run, mock_ffmpeg):
        mock_ffmpeg.return_value = True
        mock_run.side_effect = Exception("Subprocess error")

        duration = self.cm._get_media_duration(Path("/fake/video.mp4"))
        self.assertIsNone(duration)


class TestEstimateFileTokensGeneric(unittest.TestCase):
    """Test _estimate_file_tokens_generic method."""

    def setUp(self):
        self.cm = ContextManager()

    def test_missing_file_record_returns_fallback(self):
        mock_db = MagicMock()
        mock_db.get_file_record.return_value = None

        tokens, method = self.cm._estimate_file_tokens_generic("missing.txt", mock_db)
        self.assertEqual(tokens, 250)
        self.assertEqual(method, "fallback_missing")

    @patch.object(ContextManager, '_get_image_dimensions')
    @patch('file_utils.file_provider_manager.get_file_path')
    def test_image_estimation_via_dimensions(self, mock_get_path, mock_get_dims):
        mock_db = MagicMock()
        mock_db.get_file_record.return_value = {
            "file_extension": ".jpg",
            "file_size": 100000
        }
        mock_path = MagicMock()
        mock_path.exists.return_value = True
        mock_get_path.return_value = mock_path
        mock_get_dims.return_value = (1920, 1080)

        tokens, method = self.cm._estimate_file_tokens_generic("image.jpg", mock_db)
        expected_tokens = (1920 * 1080) // 1500
        self.assertEqual(tokens, expected_tokens)
        self.assertEqual(method, "image_dimensions")

    @patch.object(ContextManager, '_get_image_dimensions')
    @patch('file_utils.file_provider_manager.get_file_path')
    def test_image_fallback_when_pil_fails(self, mock_get_path, mock_get_dims):
        mock_db = MagicMock()
        mock_db.get_file_record.return_value = {
            "file_extension": ".png",
            "file_size": 100000
        }
        mock_path = MagicMock()
        mock_path.exists.return_value = True
        mock_get_path.return_value = mock_path
        mock_get_dims.return_value = (None, None)

        tokens, method = self.cm._estimate_file_tokens_generic("image.png", mock_db)
        self.assertEqual(tokens, 1400)
        self.assertEqual(method, "image_fallback")

    @patch.object(ContextManager, '_get_media_duration')
    @patch('file_utils.file_provider_manager.get_file_path')
    def test_audio_estimation_via_duration(self, mock_get_path, mock_get_duration):
        mock_db = MagicMock()
        mock_db.get_file_record.return_value = {
            "file_extension": ".mp3",
            "file_size": 500000
        }
        mock_path = MagicMock()
        mock_path.exists.return_value = True
        mock_get_path.return_value = mock_path
        mock_get_duration.return_value = 180.0  # 3 minutes

        tokens, method = self.cm._estimate_file_tokens_generic("audio.mp3", mock_db)
        self.assertEqual(tokens, int(180 * 18))
        self.assertEqual(method, "audio_duration")

    @patch.object(ContextManager, '_get_media_duration')
    @patch('file_utils.file_provider_manager.get_file_path')
    def test_video_estimation_via_duration(self, mock_get_path, mock_get_duration):
        mock_db = MagicMock()
        mock_db.get_file_record.return_value = {
            "file_extension": ".mp4",
            "file_size": 5000000
        }
        mock_path = MagicMock()
        mock_path.exists.return_value = True
        mock_get_path.return_value = mock_path
        mock_get_duration.return_value = 60.0  # 1 minute

        tokens, method = self.cm._estimate_file_tokens_generic("video.mp4", mock_db)
        self.assertEqual(tokens, int(60 * 200))
        self.assertEqual(method, "video_duration")

    @patch.object(ContextManager, '_read_markdown_content')
    def test_text_file_via_markdown_content(self, mock_read_md):
        mock_db = MagicMock()
        mock_db.get_file_record.return_value = {
            "file_extension": ".txt",
            "file_size": 1000,
            "md_filename": "file.md"
        }
        mock_read_md.return_value = "a" * 400

        tokens, method = self.cm._estimate_file_tokens_generic("file.txt", mock_db)
        self.assertEqual(tokens, 100)  # 400 chars / 4 chars_per_token
        self.assertEqual(method, "markdown_content")

    def test_document_size_based_estimation(self):
        mock_db = MagicMock()
        mock_db.get_file_record.return_value = {
            "file_extension": ".pdf",
            "file_size": 10000
        }

        tokens, method = self.cm._estimate_file_tokens_generic("doc.pdf", mock_db)
        self.assertEqual(tokens, 1000)  # 10000 bytes / 10 bytes_per_token
        self.assertEqual(method, "document_size_fallback")

    def test_unknown_extension_fallback(self):
        mock_db = MagicMock()
        mock_db.get_file_record.return_value = {
            "file_extension": ".xyz",
            "file_size": 5000
        }

        tokens, method = self.cm._estimate_file_tokens_generic("file.xyz", mock_db)
        self.assertEqual(tokens, 250)
        self.assertEqual(method, "fallback_unknown")

    def test_handles_exception_gracefully(self):
        mock_db = MagicMock()
        mock_db.get_file_record.side_effect = Exception("DB Error")

        tokens, method = self.cm._estimate_file_tokens_generic("file.txt", mock_db)
        self.assertEqual(tokens, 250)
        self.assertEqual(method, "fallback_error")


class TestEstimateSingleFileTokens(unittest.TestCase):
    """Test _estimate_single_file_tokens method."""

    def setUp(self):
        self.cm = ContextManager()

    def test_returns_cached_value_when_available(self):
        mock_db = MagicMock()
        mock_db.get_file_token_count.return_value = {
            "token_count": 500,
            "method": "image_dimensions"
        }

        tokens, method, was_cached = self.cm._estimate_single_file_tokens(
            "file.jpg", "gemini", "flash", mock_db, None
        )
        self.assertEqual(tokens, 500)
        self.assertEqual(method, "image_dimensions_cached")
        self.assertTrue(was_cached)

    def test_uses_provider_method_when_available(self):
        mock_db = MagicMock()
        mock_db.get_file_token_count.return_value = None
        mock_db.get_file_record.return_value = {"file_extension": ".jpg"}

        mock_provider = MagicMock()
        mock_provider.estimate_file_tokens.return_value = {
            "tokens": 1200,
            "method": "gemini_vision"
        }

        tokens, method, was_cached = self.cm._estimate_single_file_tokens(
            "file.jpg", "gemini", "flash", mock_db, mock_provider
        )
        self.assertEqual(tokens, 1200)
        self.assertEqual(method, "gemini_vision")
        self.assertFalse(was_cached)
        mock_db.update_file_token_count.assert_called_once()

    def test_falls_back_to_generic_when_no_provider_method(self):
        mock_db = MagicMock()
        mock_db.get_file_token_count.return_value = None
        mock_db.get_file_record.return_value = {"file_extension": ".txt", "file_size": 400}

        mock_provider = MagicMock(spec=[])  # No estimate_file_tokens method

        with patch.object(self.cm, '_estimate_file_tokens_generic', return_value=(100, "text_size_fallback")):
            tokens, method, was_cached = self.cm._estimate_single_file_tokens(
                "file.txt", "provider", "model", mock_db, mock_provider
            )
            self.assertEqual(tokens, 100)
            self.assertEqual(method, "text_size_fallback")
            self.assertFalse(was_cached)

    def test_caches_new_estimates(self):
        mock_db = MagicMock()
        mock_db.get_file_token_count.return_value = None
        mock_db.get_file_record.return_value = {"file_extension": ".jpg"}

        mock_provider = MagicMock()
        mock_provider.estimate_file_tokens.return_value = {
            "tokens": 800,
            "method": "provider_vision"
        }

        self.cm._estimate_single_file_tokens(
            "file.jpg", "gemini", "flash", mock_db, mock_provider
        )

        mock_db.update_file_token_count.assert_called_once_with(
            "file.jpg", 800, "gemini", "flash", "provider_vision"
        )


class TestCountMessagesTokens(unittest.TestCase):
    """Test count_messages_tokens method."""

    def setUp(self):
        self.cm = ContextManager()
        self.cm._provider_map = None  # Reset cache before each test

    def test_empty_messages_returns_zeros(self):
        result = self.cm.count_messages_tokens([], "model", "provider")
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["per_message"], [])
        self.assertEqual(result["method"], "none")

    @patch('agents.context.context_manager.get_provider_map')
    @patch('agents.context.context_manager.Config')
    def test_batches_messages_correctly(self, mock_config, mock_get_map):
        """Uses native provider for counting."""
        mock_config.get_token_counting_method.return_value = "native"
        mock_provider = MagicMock()
        mock_provider.count_tokens.return_value = 10
        mock_get_map.return_value = {"provider": mock_provider}

        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"}
        ]

        result = self.cm.count_messages_tokens(messages, "model", "provider")

        self.assertEqual(result["total"], 10 + 8)  # 10 content + 2*4 overhead
        self.assertEqual(len(result["per_message"]), 2)
        self.assertEqual(result["method"], "provider_native")

    @patch('agents.context.context_manager.get_provider_map')
    @patch('agents.context.context_manager.Config')
    def test_distributes_tokens_proportionally(self, mock_config, mock_get_map):
        mock_config.get_token_counting_method.return_value = "fallback"
        mock_config.get_fallback_chars_per_token.return_value = 4
        mock_get_map.return_value = {}

        messages = [
            {"role": "user", "content": "a" * 40},
            {"role": "assistant", "content": "b" * 60}
        ]

        result = self.cm.count_messages_tokens(messages, "model", "provider")

        # "user: <40 a's>\nassistant: <60 b's>" = 118 chars / 4 = 29 tokens + 8 overhead
        self.assertEqual(result["total"], 37)
        self.assertEqual(len(result["per_message"]), 2)
        self.assertNotEqual(result["per_message"][0], result["per_message"][1])

    def test_handles_empty_message_content(self):
        """Should handle messages with no content - still counts role lengths."""
        messages = [
            {"role": "user", "content": ""},
            {"role": "assistant", "content": ""}
        ]

        result = self.cm.count_messages_tokens(messages, "model", "provider")
        # Role names ("user" + "assistant") still have length (4+9=13 chars)
        # So batched_text = "user: \nassistant: " = 18 chars → 4 tokens (18/4) + 8 overhead = 12
        self.assertEqual(result["total"], 12)
        self.assertEqual(len(result["per_message"]), 2)
        # Not 'empty_messages' because role names have length
        self.assertEqual(result["method"], "char_approximation")


class TestEstimateRequestTokens(unittest.TestCase):
    """Test estimate_request_tokens method."""

    def setUp(self):
        self.cm = ContextManager()
        self.cm._provider_map = None  # Reset cache before each test

    @patch.object(ContextManager, 'count_tokens')
    @patch.object(ContextManager, 'count_messages_tokens')
    def test_estimates_all_components(self, mock_count_msgs, mock_count):
        mock_count.side_effect = [100, 50]  # system_prompt, current_message
        mock_count_msgs.return_value = {
            "total": 200,
            "per_message": [80, 120],
            "method": "tiktoken_cl100k_base"
        }

        history = [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello"}
        ]

        result = self.cm.estimate_request_tokens(
            role="assistant",
            provider="gemini",
            model="flash",
            system_prompt="You are a helpful assistant",
            chat_history=history,
            current_message="What is the weather?",
            file_attachments=None
        )

        self.assertEqual(result["estimated_tokens"]["system_prompt"], 100)
        self.assertEqual(result["estimated_tokens"]["chat_history"], 200)
        self.assertEqual(result["estimated_tokens"]["current_message"], 50)
        self.assertEqual(result["estimated_tokens"]["file_attachments"], 0)
        self.assertEqual(result["estimated_tokens"]["total"], 350)

    @patch.object(ContextManager, 'count_tokens')
    @patch.object(ContextManager, 'count_messages_tokens')
    def test_returns_correct_breakdown_structure(self, mock_count_msgs, mock_count):
        mock_count.return_value = 10
        mock_count_msgs.return_value = {
            "total": 50,
            "per_message": [25, 25],
            "method": "native"
        }

        result = self.cm.estimate_request_tokens(
            role="assistant",
            provider="gemini",
            model="flash",
            system_prompt="Test",
            chat_history=[{"role": "user", "content": "Hi"}],
            current_message="Hello"
        )

        self.assertIn("role", result)
        self.assertIn("estimated_tokens", result)
        self.assertIn("method", result)
        self.assertIn("model", result)
        self.assertIn("provider", result)
        self.assertIn("breakdown_details", result)

        details = result["breakdown_details"]
        self.assertIn("system_prompt_tokens", details)
        self.assertIn("history_messages_count", details)
        self.assertIn("per_message_breakdown", details)
        self.assertIn("file_breakdown", details)

    @patch('utils.db_utils.db')
    @patch('agents.context.context_manager.get_provider_map')
    @patch.object(ContextManager, 'count_tokens')
    @patch.object(ContextManager, 'count_messages_tokens')
    @patch.object(ContextManager, '_estimate_single_file_tokens')
    def test_handles_file_attachments(self, mock_est_file, mock_count_msgs, mock_count, mock_get_map, mock_db):
        mock_count.return_value = 0
        mock_count_msgs.return_value = {"total": 0, "per_message": [], "method": "none"}
        mock_get_map.return_value = {"gemini": MagicMock()}
        mock_est_file.return_value = (500, "image_dimensions", False)

        result = self.cm.estimate_request_tokens(
            role="assistant",
            provider="gemini",
            model="flash",
            file_attachments=["file1.jpg"]
        )

        self.assertEqual(result["estimated_tokens"]["file_attachments"], 500)
        self.assertEqual(len(result["breakdown_details"]["file_breakdown"]), 1)
        self.assertEqual(result["breakdown_details"]["file_breakdown"][0]["estimated_tokens"], 500)

    @patch.object(ContextManager, 'count_tokens')
    @patch.object(ContextManager, 'count_messages_tokens')
    def test_handles_missing_optional_params(self, mock_count_msgs, mock_count):
        mock_count.return_value = 0
        mock_count_msgs.return_value = {"total": 0, "per_message": [], "method": "none"}

        result = self.cm.estimate_request_tokens(
            role="assistant",
            provider="gemini",
            model="flash"
        )

        self.assertEqual(result["estimated_tokens"]["system_prompt"], 0)
        self.assertEqual(result["estimated_tokens"]["chat_history"], 0)
        self.assertEqual(result["estimated_tokens"]["current_message"], 0)
        self.assertEqual(result["estimated_tokens"]["file_attachments"], 0)


class TestExtractActualTokensFromResponse(unittest.TestCase):
    """Test extract_actual_tokens_from_response method."""

    def setUp(self):
        self.cm = ContextManager()
        self.cm._provider_map = None  # Reset cache before each test

    def test_returns_none_for_empty_response(self):
        result = self.cm.extract_actual_tokens_from_response(None, "gemini")
        self.assertIsNone(result)

        result = self.cm.extract_actual_tokens_from_response({}, "gemini")
        self.assertIsNone(result)

    @patch('agents.context.context_manager.get_provider_map')
    def test_delegates_to_provider_method(self, mock_get_map):
        mock_provider = MagicMock()
        mock_provider.extract_usage_from_response.return_value = {
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "total_tokens": 150,
            "cached_tokens": None
        }
        mock_get_map.return_value = {"gemini": mock_provider}

        response = {"usage": {"promptTokens": 100}}
        result = self.cm.extract_actual_tokens_from_response(response, "gemini")

        self.assertEqual(result["prompt_tokens"], 100)
        self.assertEqual(result["completion_tokens"], 50)
        mock_provider.extract_usage_from_response.assert_called_once_with(response)

    @patch('agents.context.context_manager.get_provider_map')
    def test_returns_none_for_unsupported_provider(self, mock_get_map):
        """Should return None for provider without extract method."""
        mock_provider = MagicMock(spec=[])  # No extract method
        mock_get_map.return_value = {"provider": mock_provider}

        result = self.cm.extract_actual_tokens_from_response({"data": "test"}, "provider")
        self.assertIsNone(result)


class TestReconstructRouterPrompt(unittest.TestCase):
    """Test _reconstruct_router_prompt method."""

    def setUp(self):
        self.cm = ContextManager()

    @patch('agents.prompts.router_prompt.router_system_prompt', "System: {available_routes} | Info: {available_information} | Domains: {available_domains}")
    @patch('utils.config.available_routes', [])
    @patch('agents.domains.domain_registry.domain_registry')
    @patch.object(ContextManager, 'build_router_context')
    def test_builds_correct_segment_structure(self, mock_build_ctx, mock_registry):
        mock_registry.get_domain_descriptions_for_router.return_value = "Web, Coder"
        mock_build_ctx.return_value = "Chat: Hi"

        full_prompt, segments = self.cm._reconstruct_router_prompt([], "Test")

        self.assertIsInstance(segments, list)
        self.assertGreater(len(segments), 0)
        # Verify segment structure: list of (label, text) tuples
        labels = [label for label, _ in segments]
        self.assertTrue(all(isinstance(label, str) for label in labels))
        # Full prompt should contain all segment texts
        for _, text in segments:
            self.assertIn(text, full_prompt)

    @patch('agents.prompts.router_prompt.router_system_prompt', "No placeholders here")
    @patch('utils.config.available_routes', [])
    @patch('agents.domains.domain_registry.domain_registry')
    @patch.object(ContextManager, 'build_router_context')
    def test_handles_template_split_failure_gracefully(self, mock_build_ctx, mock_registry):
        mock_registry.get_domain_descriptions_for_router.return_value = ""
        mock_build_ctx.return_value = ""

        full_prompt, segments = self.cm._reconstruct_router_prompt([], "Test")

        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0][0], "Router Prompt")


class TestAnalyzePromptSegments(unittest.TestCase):
    """Test _analyze_prompt_segments method."""

    def setUp(self):
        self.cm = ContextManager()

    @patch.object(ContextManager, 'count_tokens')
    @patch.object(ContextManager, '_get_method_info')
    def test_counts_tokens_for_each_segment(self, mock_get_info, mock_count):
        mock_count.side_effect = [10, 20, 30]
        mock_get_info.return_value = ("tiktoken_cl100k_base", False)

        segments = [
            ("Segment 1", "text1"),
            ("Segment 2", "text2"),
            ("Segment 3", "text3")
        ]

        result = self.cm._analyze_prompt_segments(segments, "model", "provider")

        self.assertEqual(len(result), 3)
        self.assertEqual(result[0]["tokens"], 10)
        self.assertEqual(result[1]["tokens"], 20)
        self.assertEqual(result[2]["tokens"], 30)

    @patch.object(ContextManager, 'count_tokens')
    @patch.object(ContextManager, '_get_method_info')
    def test_returns_correct_structure_with_method_info(self, mock_get_info, mock_count):
        mock_count.return_value = 15
        mock_get_info.return_value = ("char_approximation", True)

        segments = [("Label", "text")]

        result = self.cm._analyze_prompt_segments(segments, "model", "provider")

        self.assertEqual(result[0]["label"], "Label")
        self.assertEqual(result[0]["tokens"], 15)
        self.assertEqual(result[0]["method"], "char_approximation")
        self.assertEqual(result[0]["is_estimated"], True)
        self.assertEqual(result[0]["char_count"], 4)


class TestAnalyzeLatestInteraction(unittest.TestCase):
    """Test analyze_latest_interaction method (heavily mocked)."""

    def setUp(self):
        self.cm = ContextManager()
        self.cm._provider_map = None  # Reset cache before each test

    @patch('utils.db_utils.db')
    def test_returns_empty_analysis_for_no_history(self, mock_db):
        mock_db.get_chat_history.return_value = []
        mock_db.get_chat_system_prompt.return_value = "System"

        result = self.cm.analyze_latest_interaction("chat123")

        self.assertEqual(result["chat_id"], "chat123")
        self.assertEqual(result["system_prompt"]["content"], "System")
        self.assertEqual(len(result["requests"]), 0)

    @patch('utils.db_utils.db')
    @patch('agents.context.context_manager.Config')
    @patch.object(ContextManager, 'estimate_request_tokens')
    @patch.object(ContextManager, 'count_tokens')
    @patch.object(ContextManager, '_get_method_info')
    def test_finds_latest_assistant_user_messages(self, mock_get_info, mock_count, mock_estimate, mock_config, mock_db):
        history = [
            {"role": "user", "content": "Hello", "attachedFiles": []},
            {"role": "assistant", "content": "Hi there", "provider": "gemini", "model": "flash"}
        ]
        mock_db.get_chat_history.return_value = history
        mock_db.get_chat_system_prompt.return_value = ""
        mock_db.get_most_recent_token_usage.return_value = None
        mock_get_info.return_value = ("tiktoken", False)
        mock_count.return_value = 10
        mock_estimate.return_value = {
            "estimated_tokens": {"system_prompt": 0, "chat_history": 0, "current_message": 10, "file_attachments": 0, "total": 10},
            "breakdown_details": {"file_breakdown": []}
        }
        mock_config.get_default_provider.return_value = "gemini"
        mock_config.get_default_model.return_value = "flash"

        result = self.cm.analyze_latest_interaction("chat123")

        self.assertEqual(len(result["requests"]), 1)
        self.assertEqual(result["requests"][0]["role"], "assistant")

    @patch('utils.db_utils.db')
    @patch.object(ContextManager, '_reconstruct_router_prompt')
    @patch.object(ContextManager, '_analyze_prompt_segments')
    @patch.object(ContextManager, 'estimate_request_tokens')
    @patch.object(ContextManager, 'count_tokens')
    @patch.object(ContextManager, '_get_method_info')
    def test_includes_router_analysis_when_available(self, mock_get_info, mock_count, mock_estimate, mock_analyze_segs, mock_reconstruct, mock_db):
        """Should include router analysis when usage data available."""
        history = [
            {"role": "user", "content": "Test", "attachedFiles": []},
            {"role": "assistant", "content": "Response", "routerDecision": {"route": "web"}}
        ]
        mock_db.get_chat_history.return_value = history
        mock_db.get_chat_system_prompt.return_value = ""
        mock_db.get_most_recent_token_usage.side_effect = [
            {"provider": "openrouter", "model": "mimo", "prompt_tokens": 50, "request_id": "req1"},
            {"provider": "gemini", "model": "flash", "prompt_tokens": 100, "request_id": "req1"}
        ]
        mock_reconstruct.return_value = ("Full prompt", [("System", "text")])
        mock_analyze_segs.return_value = [{"label": "System", "tokens": 50}]
        mock_get_info.return_value = ("tiktoken", False)
        mock_count.return_value = 10
        mock_estimate.return_value = {
            "estimated_tokens": {"system_prompt": 0, "chat_history": 0, "current_message": 10, "file_attachments": 0, "total": 10},
            "breakdown_details": {"file_breakdown": []}
        }

        result = self.cm.analyze_latest_interaction("chat123")

        self.assertEqual(len(result["requests"]), 2)
        self.assertEqual(result["requests"][0]["role"], "router")
        self.assertEqual(result["requests"][0]["input"]["total"]["tokens"], 50)

    @patch('utils.db_utils.db')
    @patch('agents.context.context_manager.Config')
    @patch.object(ContextManager, 'estimate_request_tokens')
    @patch.object(ContextManager, 'count_tokens')
    @patch.object(ContextManager, '_get_method_info')
    def test_uses_api_tokens_when_available(self, mock_get_info, mock_count, mock_estimate, mock_config, mock_db):
        history = [
            {"role": "user", "content": "Test", "attachedFiles": []},
            {"role": "assistant", "content": "Response"}
        ]
        mock_db.get_chat_history.return_value = history
        mock_db.get_chat_system_prompt.return_value = ""
        mock_db.get_most_recent_token_usage.side_effect = [
            None,  # No router usage
            {"provider": "gemini", "model": "flash", "prompt_tokens": 100, "completion_tokens": 50, "request_id": "req1"}
        ]
        mock_get_info.return_value = ("tiktoken", False)
        mock_count.return_value = 10
        mock_estimate.return_value = {
            "estimated_tokens": {"system_prompt": 0, "chat_history": 0, "current_message": 10, "file_attachments": 0, "total": 10},
            "breakdown_details": {"file_breakdown": []}
        }
        mock_config.get_default_provider.return_value = "gemini"
        mock_config.get_default_model.return_value = "flash"

        result = self.cm.analyze_latest_interaction("chat123")

        self.assertEqual(result["requests"][0]["input"]["total"]["tokens"], 100)
        self.assertEqual(result["requests"][0]["output"]["total"]["tokens"], 50)
        self.assertEqual(result["requests"][0]["input"]["total"]["method"], "gemini_api")

    @patch('utils.db_utils.db')
    @patch('agents.context.context_manager.Config')
    @patch.object(ContextManager, 'estimate_request_tokens')
    @patch.object(ContextManager, 'count_tokens')
    @patch.object(ContextManager, '_get_method_info')
    def test_falls_back_to_counting_when_no_api_tokens(self, mock_get_info, mock_count, mock_estimate, mock_config, mock_db):
        history = [
            {"role": "user", "content": "Test", "attachedFiles": []},
            {"role": "assistant", "content": "Response"}
        ]
        mock_db.get_chat_history.return_value = history
        mock_db.get_chat_system_prompt.return_value = ""
        mock_db.get_most_recent_token_usage.return_value = None
        mock_get_info.return_value = ("char_approximation", True)
        mock_count.return_value = 15
        mock_estimate.return_value = {
            "estimated_tokens": {"system_prompt": 0, "chat_history": 0, "current_message": 15, "file_attachments": 0, "total": 15},
            "breakdown_details": {"file_breakdown": []}
        }
        mock_config.get_default_provider.return_value = "gemini"
        mock_config.get_default_model.return_value = "flash"

        result = self.cm.analyze_latest_interaction("chat123")

        self.assertEqual(result["requests"][0]["input"]["total"]["method"], "char_approximation")
        self.assertTrue(result["requests"][0]["input"]["total"]["is_estimated"])


if __name__ == "__main__":
    unittest.main()
