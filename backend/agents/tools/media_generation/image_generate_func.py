from __future__ import annotations

from typing import Any, Dict, Optional

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec, ProcessingMode

_logger = get_logger(__name__)


def _tool_image_generate(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Generate an image from a text prompt using AI image generation models.

    This tool:
    - Validates input parameters (prompt, dimensions, model, options)
    - Generates images using the configured image generation provider with rate limiting
    - Saves generated images to disk
    - Returns the file path and generation metadata
    - Supports multiple models, customizable dimensions, and enhancement options
    """
    prompt = params.get("prompt")
    width = params.get("width", 768)
    height = params.get("height", 768)
    seed = params.get("seed")
    model = params.get("model", "flux")
    provider = params.get("provider")
    safe = params.get("safe", False)
    nologo = params.get("nologo", True)
    private = params.get("private", True) 

    if not prompt:
        raise ValueError("prompt is required")

    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt must be a non-empty string")

    if not isinstance(width, int) or not isinstance(height, int):
        raise ValueError("width and height must be integers")

    if width < 128 or width > 1536:
        raise ValueError(
            f"width must be between 128 and 1536 pixels (got {width}). "
            "Use reasonable dimensions to avoid excessive resource usage."
        )

    if height < 128 or height > 1536:
        raise ValueError(
            f"height must be between 128 and 1536 pixels (got {height}). "
            "Use reasonable dimensions to avoid excessive resource usage."
        )

    total_pixels = width * height
    MAX_PIXELS = 589824 
    if total_pixels > MAX_PIXELS:
        raise ValueError(
            f"Total pixel count ({total_pixels:,}) exceeds API limit of {MAX_PIXELS:,} pixels. "
            f"Requested {width}x{height}. Maximum square: 768x768. "
            f"For aspect ratios, ensure width × height ≤ {MAX_PIXELS:,}."
        )

    if seed is not None:
        if not isinstance(seed, int):
            raise ValueError("seed must be an integer when provided")
        if seed < 0:
            raise ValueError("seed must be a non-negative integer")

    if not isinstance(model, str):
        raise ValueError("model must be a string")

    for param_name, param_value in [("safe", safe), ("nologo", nologo), ("private", private)]:
        if not isinstance(param_value, bool):
            raise ValueError(f"{param_name} must be a boolean")

    try:
        from features.image_generation import ImageGeneration

        image_gen = ImageGeneration()

        all_models = image_gen.get_all_available_models()
        if model not in all_models:
            available_list = ", ".join(all_models.keys())
            raise ValueError(
                f"Invalid model '{model}'. Available models: {available_list}"
            )

        _logger.info(
            f"Generating image for task {ctx.task_id}: "
            f"prompt='{prompt[:50]}...', model={model}, size={width}x{height}, safe={safe}"
        )


        result = image_gen.generate_image(
            prompt=prompt,
            width=width,
            height=height,
            seed=seed,
            model=model,
            provider=provider,
            enhance=False,
            safe=safe,
            nologo=nologo,
            private=private
        )

        if not result.get("success"):
            error_msg = result.get("error", "Unknown error occurred")
            raise RuntimeError(f"Image generation failed: {error_msg}")

        file_path = result.get("file_path")
        if not file_path:
            raise RuntimeError("Image generation succeeded but no file path was returned")

        _logger.info(f"Successfully generated image at '{file_path}'")

        output = {
            "status": "success",
            "file_path": file_path,
            "filename": result.get("filename"),
            "prompt": prompt,
            "model": model,
            "dimensions": {
                "width": width,
                "height": height
            },
            "seed": seed,
            "safe": safe,
            "url": result.get("url")
        }

        metadata = {
            "file_path": file_path,
            "model": model,
            "dimensions": f"{width}x{height}",
            "has_seed": seed is not None,
            "safe_mode": safe
        }

        return ToolResult(output=output, metadata=metadata)

    except ImportError as e:
        raise RuntimeError(
            f"Could not import image generation module: {e}. "
            "Please ensure the image generation feature is properly configured."
        )
    except Exception as e:
        _logger.error(f"Image generation failed for task {ctx.task_id}: {str(e)}")
        raise


image_generate_spec = ToolSpec(
    name="media.image_generate",
    version="1.0",
    description=(
        "Generate an image from a text prompt using AI image generation models with rate limiting (5 sec interval). "
        "Supports multiple models (flux, flux-realism, flux-anime, flux-3d, flux-pro, kontext) "
        "and customizable dimensions. Includes safety filtering and privacy options. "
        "Returns the file path of the generated image."
    ),
    effects=["net", "disk"],
    in_schema={
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Text description of the image to generate"
            },
            "width": {
                "type": "integer",
                "default": 768,
                "description": "Image width in pixels (128-1536, default: 768). Max total: 589,824 pixels (768x768)"
            },
            "height": {
                "type": "integer",
                "default": 768,
                "description": "Image height in pixels (128-1536, default: 768). Max total: 589,824 pixels (768x768)"
            },
            "seed": {
                "type": "integer",
                "description": "Random seed for reproducible generation (optional)"
            },
            "model": {
                "type": "string",
                "default": "flux",
                "description": (
                    "Model to use for generation. Available models: "
                    "flux (default, high quality), flux-realism, flux-anime, "
                    "flux-3d, flux-pro, kontext (image-to-image)"
                )
            },
            "safe": {
                "type": "boolean",
                "default": False,
                "description": "Enable strict NSFW filtering, throws error if detected (default: false)"
            },
            "nologo": {
                "type": "boolean",
                "default": True,
                "description": "Remove Pollinations logo from image (default: true)"
            },
            "private": {
                "type": "boolean",
                "default": True,
                "description": "Prevent image from appearing in public feed (default: true)"
            }
        },
        "required": ["prompt"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "file_path": {"type": "string"},
            "filename": {"type": "string"},
            "prompt": {"type": "string"},
            "model": {"type": "string"},
            "dimensions": {"type": "object"},
            "seed": {"type": "integer"},
            "url": {"type": "string"}
        }
    },
    fn=_tool_image_generate,
    rate_key="media.image_generate",
    timeout_seconds=120.0,  # Image generation API calls
    processing_mode=ProcessingMode.ASYNC,
)
