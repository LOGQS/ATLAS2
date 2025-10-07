# status: complete

"""
Image generation main module providing unified abstraction for image generation providers
"""

from typing import Dict, Any, Optional
from utils.logger import get_logger
from features.image_providers import Pollinations

logger = get_logger(__name__)

class ImageGeneration:
    """
    Main image generation class that manages image generation operations
    """

    def __init__(self):
        self.provider = Pollinations()

    def is_available(self) -> bool:
        """Check if image generation provider is available"""
        return self.provider.is_available()

    def get_available_models(self) -> Dict[str, str]:
        """Get available models from provider"""
        return self.provider.get_available_models()

    def generate_image(self, prompt: str, width: int = 768, height: int = 768,
                      seed: Optional[int] = None, model: str = "flux",
                      enhance: bool = False, safe: bool = False,
                      nologo: bool = True, private: bool = True) -> Dict[str, Any]:
        """
        Generate image from text prompt

        Args:
            prompt: Text description of the image to generate
            width: Image width in pixels
            height: Image height in pixels
            seed: Random seed for reproducible generation
            model: Model to use for generation
            enhance: Enhance prompt using LLM for more detail
            safe: Strict NSFW filtering
            nologo: Remove Pollinations logo (requires authentication)
            private: Prevent image from appearing in public feed

        Returns:
            Dict with generation results including file path or error
        """
        if not self.provider.is_available():
            return {"success": False, "error": "Provider not available"}

        return self.provider.generate_image(
            prompt=prompt,
            width=width,
            height=height,
            seed=seed,
            model=model,
            enhance=enhance,
            safe=safe,
            nologo=nologo,
            private=private
        )