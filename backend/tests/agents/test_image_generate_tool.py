"""Comprehensive unit tests for media.image_generate tool.

This module tests the image generation tool including:
- Basic image generation with default parameters
- Custom dimensions, models, and seed handling
- Parameter validation (prompt, dimensions, model, seed)
- Provider availability checks
- Error handling for generation failures
- File path verification
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.tools.tool_registry import ToolExecutionContext, ToolResult
from agents.tools.media_generation.image_generate_func import _tool_image_generate


class TestImageGenerateTool(unittest.TestCase):
    """Test media.image_generate tool functionality."""

    def setUp(self):
        """Create test context."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_image_gen"
        )

    @patch('features.image_generation.ImageGeneration')
    def test_generate_image_with_defaults(self, mock_image_gen_class):
        """Should generate image with default parameters."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {
            "flux": "Flux (Default)",
            "flux-realism": "Flux Realism"
        }
        mock_instance.generate_image.return_value = {
            "success": True,
            "file_path": "/path/to/generated/image.jpg",
            "filename": "image.jpg",
            "url": "https://example.com/image.jpg"
        }

        result = _tool_image_generate({"prompt": "A beautiful sunset"}, self.ctx)

        self.assertIsInstance(result, ToolResult)
        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["file_path"], "/path/to/generated/image.jpg")
        self.assertEqual(result.output["prompt"], "A beautiful sunset")
        self.assertEqual(result.output["model"], "flux")
        self.assertEqual(result.output["dimensions"]["width"], 768)
        self.assertEqual(result.output["dimensions"]["height"], 768)

        mock_instance.generate_image.assert_called_once_with(
            prompt="A beautiful sunset",
            width=768,
            height=768,
            seed=None,
            model="flux",
            enhance=False,
            safe=False,
            nologo=True,
            private=True
        )

    @patch('features.image_generation.ImageGeneration')
    def test_generate_image_with_custom_dimensions(self, mock_image_gen_class):
        """Should generate image with custom dimensions."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {"flux": "Flux"}
        mock_instance.generate_image.return_value = {
            "success": True,
            "file_path": "/path/to/image.jpg",
            "filename": "image.jpg"
        }

        result = _tool_image_generate(
            {
                "prompt": "A cat",
                "width": 512,
                "height": 768
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["dimensions"]["width"], 512)
        self.assertEqual(result.output["dimensions"]["height"], 768)

        mock_instance.generate_image.assert_called_once_with(
            prompt="A cat",
            width=512,
            height=768,
            seed=None,
            model="flux",
            enhance=False,
            safe=False,
            nologo=True,
            private=True
        )

    @patch('features.image_generation.ImageGeneration')
    def test_generate_image_with_custom_model(self, mock_image_gen_class):
        """Should generate image with custom model."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {
            "flux": "Flux",
            "flux-anime": "Flux Anime"
        }
        mock_instance.generate_image.return_value = {
            "success": True,
            "file_path": "/path/to/image.jpg",
            "filename": "image.jpg"
        }

        result = _tool_image_generate(
            {
                "prompt": "An anime character",
                "model": "flux-anime"
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["model"], "flux-anime")

        mock_instance.generate_image.assert_called_once_with(
            prompt="An anime character",
            width=768,
            height=768,
            seed=None,
            model="flux-anime",
            enhance=False,
            safe=False,
            nologo=True,
            private=True
        )

    @patch('features.image_generation.ImageGeneration')
    def test_generate_image_with_seed(self, mock_image_gen_class):
        """Should generate reproducible image with seed."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {"flux": "Flux"}
        mock_instance.generate_image.return_value = {
            "success": True,
            "file_path": "/path/to/image.jpg",
            "filename": "image.jpg"
        }

        result = _tool_image_generate(
            {
                "prompt": "A landscape",
                "seed": 42
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["seed"], 42)
        self.assertTrue(result.metadata["has_seed"])

        mock_instance.generate_image.assert_called_once_with(
            prompt="A landscape",
            width=768,
            height=768,
            seed=42,
            model="flux",
            enhance=False,
            safe=False,
            nologo=True,
            private=True
        )

    def test_missing_prompt(self):
        """Should raise ValueError when prompt is missing."""
        with self.assertRaises(ValueError) as cm:
            _tool_image_generate({}, self.ctx)

        self.assertIn("prompt is required", str(cm.exception))

    def test_empty_prompt(self):
        """Should raise ValueError for empty prompt."""
        with self.assertRaises(ValueError) as cm:
            _tool_image_generate({"prompt": "   "}, self.ctx)

        self.assertIn("non-empty string", str(cm.exception))

    def test_non_string_prompt(self):
        """Should raise ValueError for non-string prompt."""
        with self.assertRaises(ValueError) as cm:
            _tool_image_generate({"prompt": 123}, self.ctx)

        self.assertIn("non-empty string", str(cm.exception))

    def test_invalid_width_too_small(self):
        """Should raise ValueError for width below minimum."""
        with self.assertRaises(ValueError) as cm:
            _tool_image_generate(
                {"prompt": "test", "width": 64},
                self.ctx
            )

        self.assertIn("width must be between 128 and 1536", str(cm.exception))

    def test_invalid_width_too_large(self):
        """Should raise ValueError for width above maximum."""
        with self.assertRaises(ValueError) as cm:
            _tool_image_generate(
                {"prompt": "test", "width": 2000},
                self.ctx
            )

        self.assertIn("width must be between 128 and 1536", str(cm.exception))

    def test_invalid_height_too_small(self):
        """Should raise ValueError for height below minimum."""
        with self.assertRaises(ValueError) as cm:
            _tool_image_generate(
                {"prompt": "test", "height": 100},
                self.ctx
            )

        self.assertIn("height must be between 128 and 1536", str(cm.exception))

    def test_invalid_height_too_large(self):
        """Should raise ValueError for height above maximum."""
        with self.assertRaises(ValueError) as cm:
            _tool_image_generate(
                {"prompt": "test", "height": 2000},
                self.ctx
            )

        self.assertIn("height must be between 128 and 1536", str(cm.exception))

    def test_total_pixel_count_exceeded(self):
        """Should raise ValueError when total pixel count exceeds 768x768 limit."""
        with self.assertRaises(ValueError) as cm:
            _tool_image_generate(
                {"prompt": "test", "width": 1024, "height": 1024},
                self.ctx
            )

        self.assertIn("Total pixel count", str(cm.exception))
        self.assertIn("589,824", str(cm.exception))

    def test_non_integer_dimensions(self):
        """Should raise ValueError for non-integer dimensions."""
        with self.assertRaises(ValueError) as cm:
            _tool_image_generate(
                {"prompt": "test", "width": "512", "height": 512},
                self.ctx
            )

        self.assertIn("must be integers", str(cm.exception))

    def test_negative_seed(self):
        """Should raise ValueError for negative seed."""
        with self.assertRaises(ValueError) as cm:
            _tool_image_generate(
                {"prompt": "test", "seed": -1},
                self.ctx
            )

        self.assertIn("non-negative integer", str(cm.exception))

    def test_non_integer_seed(self):
        """Should raise ValueError for non-integer seed."""
        with self.assertRaises(ValueError) as cm:
            _tool_image_generate(
                {"prompt": "test", "seed": 42.5},
                self.ctx
            )

        self.assertIn("seed must be an integer", str(cm.exception))

    def test_non_string_model(self):
        """Should raise ValueError for non-string model."""
        with self.assertRaises(ValueError) as cm:
            _tool_image_generate(
                {"prompt": "test", "model": 123},
                self.ctx
            )

        self.assertIn("model must be a string", str(cm.exception))

    @patch('features.image_generation.ImageGeneration')
    def test_invalid_model_name(self, mock_image_gen_class):
        """Should raise ValueError for invalid model name."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {
            "flux": "Flux",
            "flux-anime": "Flux Anime"
        }

        with self.assertRaises(ValueError) as cm:
            _tool_image_generate(
                {"prompt": "test", "model": "invalid-model"},
                self.ctx
            )

        self.assertIn("Invalid model", str(cm.exception))
        self.assertIn("Available models:", str(cm.exception))

    @patch('features.image_generation.ImageGeneration')
    def test_provider_not_available(self, mock_image_gen_class):
        """Should raise RuntimeError when provider is not available."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = False

        with self.assertRaises(RuntimeError) as cm:
            _tool_image_generate({"prompt": "test"}, self.ctx)

        self.assertIn("not available", str(cm.exception))

    @patch('features.image_generation.ImageGeneration')
    def test_generation_failure(self, mock_image_gen_class):
        """Should raise RuntimeError when generation fails."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {"flux": "Flux"}
        mock_instance.generate_image.return_value = {
            "success": False,
            "error": "API rate limit exceeded"
        }

        with self.assertRaises(RuntimeError) as cm:
            _tool_image_generate({"prompt": "test"}, self.ctx)

        self.assertIn("Image generation failed", str(cm.exception))
        self.assertIn("rate limit", str(cm.exception))

    @patch('features.image_generation.ImageGeneration')
    def test_missing_file_path_in_response(self, mock_image_gen_class):
        """Should raise RuntimeError when file_path is missing from successful response."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {"flux": "Flux"}
        mock_instance.generate_image.return_value = {
            "success": True,
        }

        with self.assertRaises(RuntimeError) as cm:
            _tool_image_generate({"prompt": "test"}, self.ctx)

        self.assertIn("no file path was returned", str(cm.exception))

    @patch('features.image_generation.ImageGeneration')
    def test_import_error_handling(self, mock_image_gen_class):
        """Should raise RuntimeError with helpful message on import error."""
        mock_image_gen_class.side_effect = ImportError("No module named 'features'")

        with self.assertRaises(RuntimeError) as cm:
            _tool_image_generate({"prompt": "test"}, self.ctx)

        self.assertIn("Could not import", str(cm.exception))
        self.assertIn("image generation module", str(cm.exception))

    @patch('features.image_generation.ImageGeneration')
    def test_boundary_dimensions_minimum(self, mock_image_gen_class):
        """Should accept minimum valid dimensions (128x128)."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {"flux": "Flux"}
        mock_instance.generate_image.return_value = {
            "success": True,
            "file_path": "/path/to/image.jpg",
            "filename": "image.jpg"
        }

        result = _tool_image_generate(
            {"prompt": "test", "width": 128, "height": 128},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["dimensions"]["width"], 128)
        self.assertEqual(result.output["dimensions"]["height"], 128)

    @patch('features.image_generation.ImageGeneration')
    def test_boundary_dimensions_maximum(self, mock_image_gen_class):
        """Should accept maximum valid dimensions (768x768)."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {"flux": "Flux"}
        mock_instance.generate_image.return_value = {
            "success": True,
            "file_path": "/path/to/image.jpg",
            "filename": "image.jpg"
        }

        result = _tool_image_generate(
            {"prompt": "test", "width": 768, "height": 768},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["dimensions"]["width"], 768)
        self.assertEqual(result.output["dimensions"]["height"], 768)

    @patch('features.image_generation.ImageGeneration')
    def test_aspect_ratio_within_pixel_limit(self, mock_image_gen_class):
        """Should accept aspect ratios within 589,824 pixel limit."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {"flux": "Flux"}
        mock_instance.generate_image.return_value = {
            "success": True,
            "file_path": "/path/to/image.jpg",
            "filename": "image.jpg"
        }

        result = _tool_image_generate(
            {"prompt": "test", "width": 1536, "height": 384},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["dimensions"]["width"], 1536)
        self.assertEqual(result.output["dimensions"]["height"], 384)

    @patch('features.image_generation.ImageGeneration')
    def test_seed_zero_is_valid(self, mock_image_gen_class):
        """Should accept seed value of 0."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {"flux": "Flux"}
        mock_instance.generate_image.return_value = {
            "success": True,
            "file_path": "/path/to/image.jpg",
            "filename": "image.jpg"
        }

        result = _tool_image_generate(
            {"prompt": "test", "seed": 0},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["seed"], 0)

        mock_instance.generate_image.assert_called_once_with(
            prompt="test",
            width=768,
            height=768,
            seed=0,
            model="flux",
            enhance=False,
            safe=False,
            nologo=True,
            private=True
        )

    @patch('features.image_generation.ImageGeneration')
    def test_metadata_includes_all_fields(self, mock_image_gen_class):
        """Should include all expected fields in metadata."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {"flux": "Flux"}
        mock_instance.generate_image.return_value = {
            "success": True,
            "file_path": "/path/to/image.jpg",
            "filename": "image.jpg"
        }

        result = _tool_image_generate(
            {"prompt": "test", "seed": 42},
            self.ctx
        )

        self.assertIn("file_path", result.metadata)
        self.assertIn("model", result.metadata)
        self.assertIn("dimensions", result.metadata)
        self.assertIn("has_seed", result.metadata)
        self.assertTrue(result.metadata["has_seed"])
        self.assertEqual(result.metadata["dimensions"], "768x768")

    @patch('features.image_generation.ImageGeneration')
    def test_long_prompt_handling(self, mock_image_gen_class):
        """Should handle very long prompts correctly."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {"flux": "Flux"}
        mock_instance.generate_image.return_value = {
            "success": True,
            "file_path": "/path/to/image.jpg",
            "filename": "image.jpg"
        }

        long_prompt = "A detailed landscape " * 100 

        result = _tool_image_generate({"prompt": long_prompt}, self.ctx)

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["prompt"], long_prompt)

        call_args = mock_instance.generate_image.call_args
        self.assertEqual(call_args.kwargs["prompt"], long_prompt)

    @patch('features.image_generation.ImageGeneration')
    def test_special_characters_in_prompt(self, mock_image_gen_class):
        """Should handle special characters in prompt."""
        mock_instance = MagicMock()
        mock_image_gen_class.return_value = mock_instance
        mock_instance.is_available.return_value = True
        mock_instance.get_available_models.return_value = {"flux": "Flux"}
        mock_instance.generate_image.return_value = {
            "success": True,
            "file_path": "/path/to/image.jpg",
            "filename": "image.jpg"
        }

        special_prompt = "A café with émojis 🎨 & symbols: @#$%"

        result = _tool_image_generate({"prompt": special_prompt}, self.ctx)

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["prompt"], special_prompt)


if __name__ == "__main__":
    unittest.main()
