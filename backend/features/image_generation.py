# status: complete

"""
Image generation main module providing unified abstraction for image generation providers
"""

from typing import Dict, Any, Optional
from utils.logger import get_logger
from features.image_providers import Pollinations, Zenmux

logger = get_logger(__name__)

class ImageGeneration:
    """
    Main image generation class that manages image generation operations
    """

    def __init__(self, provider_name: Optional[str] = None):
        self.providers = {
            "pollinations": Pollinations(),
            "zenmux": Zenmux()
        }

        if provider_name and provider_name in self.providers:
            self.default_provider = provider_name
        else:
            self.default_provider = "pollinations"

    def is_available(self, provider_name: Optional[str] = None) -> bool:
        """Check if image generation provider is available"""
        provider = self._get_provider(provider_name)
        return provider.is_available() if provider else False

    def get_available_models(self, provider_name: Optional[str] = None) -> Dict[str, str]:
        """Get available models from provider"""
        provider = self._get_provider(provider_name)
        return provider.get_available_models() if provider else {}

    def get_all_available_models(self) -> Dict[str, Dict[str, str]]:
        """Get all models from all providers"""
        all_models = {}
        for provider_name, provider_instance in self.providers.items():
            if provider_instance.is_available():
                models = provider_instance.get_available_models()
                for model_id, model_name in models.items():
                    all_models[model_id] = {
                        "name": model_name,
                        "provider": provider_name
                    }
        return all_models

    def _get_provider(self, provider_name: Optional[str] = None):
        """Get provider instance by name"""
        name = provider_name or self.default_provider
        return self.providers.get(name)

    def _infer_provider_from_model(self, model: str) -> Optional[str]:
        """Infer provider from model name"""
        for provider_name, provider_instance in self.providers.items():
            if provider_instance.is_available():
                models = provider_instance.get_available_models()
                if model in models:
                    return provider_name
        return None

    def generate_image(self, prompt: str, width: int = 768, height: int = 768,
                      seed: Optional[int] = None, model: str = "flux",
                      provider: Optional[str] = None,
                      enhance: bool = False, safe: bool = False,
                      nologo: bool = True, private: bool = True,
                      input_image: Optional[str] = None) -> Dict[str, Any]:
        """
        Generate or edit image from text prompt

        Args:
            prompt: Text description of the image to generate or editing instructions
            width: Image width in pixels
            height: Image height in pixels
            seed: Random seed for reproducible generation
            model: Model to use for generation
            provider: Provider to use (optional, will be inferred from model)
            enhance: Enhance prompt using LLM for more detail
            safe: Strict NSFW filtering
            nologo: Remove Pollinations logo (requires authentication)
            private: Prevent image from appearing in public feed
            input_image: Optional path to input image for editing (Zenmux only)

        Returns:
            Dict with generation results including file path or error
        """
        if not provider:
            provider = self._infer_provider_from_model(model)
            if not provider:
                provider = self.default_provider

        provider_instance = self._get_provider(provider)

        if not provider_instance:
            return {"success": False, "error": f"Provider '{provider}' not found"}

        if not provider_instance.is_available():
            return {"success": False, "error": f"Provider '{provider}' not available"}

        return provider_instance.generate_image(
            prompt=prompt,
            width=width,
            height=height,
            seed=seed,
            model=model,
            enhance=enhance,
            safe=safe,
            nologo=nologo,
            private=private,
            input_image=input_image
        )