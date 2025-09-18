# status: complete

from typing import Dict, Any, Optional
import os
import requests
import uuid
from pathlib import Path
from urllib.parse import quote
from utils.logger import get_logger

logger = get_logger(__name__)

class Pollinations:
    """
    Pollinations AI provider for image generation
    """

    AVAILABLE_MODELS = {
        "flux": "Flux (Default, high quality)",
        "flux-realism": "Flux Realism",
        "flux-anime": "Flux Anime Style",
        "flux-3d": "Flux 3D Style",
        "flux-pro": "Flux Pro"
    }

    def __init__(self):
        self.base_url = "https://pollinations.ai/p"
        self.status = "enabled"

        self.images_dir = Path(__file__).resolve().parent.parent.parent / "data" / "generated_images"
        self.images_dir.mkdir(parents=True, exist_ok=True)

        logger.info(f"[POLLINATIONS-PROVIDER] Pollinations image generation provider initialized. Images directory: {self.images_dir}")

    def is_available(self) -> bool:
        """Check if provider is available"""
        return self.status == "enabled"

    def get_available_models(self) -> Dict[str, str]:
        """Get available image generation models for this provider"""
        return self.AVAILABLE_MODELS.copy()

    def generate_image(self, prompt: str, width: int = 1024, height: int = 1024,
                      seed: Optional[int] = None, model: str = "flux") -> Dict[str, Any]:
        """
        Generate image using Pollinations AI

        Args:
            prompt: Text description of the image
            width: Image width in pixels
            height: Image height in pixels
            seed: Random seed for reproducible generation
            model: Model to use for generation

        Returns:
            Dict with generation results
        """
        if not self.is_available():
            return {"success": False, "error": "Provider not available"}

        try:
            encoded_prompt = quote(prompt)

            url = f"{self.base_url}/{encoded_prompt}"
            params = {
                "width": width,
                "height": height,
                "model": model
            }

            if seed is not None:
                params["seed"] = seed

            logger.info(f"[POLLINATIONS-PROVIDER] Generating image with prompt: '{prompt[:50]}...' using model: {model}")

            response = requests.get(url, params=params, timeout=60)

            if response.status_code != 200:
                logger.error(f"[POLLINATIONS-PROVIDER] Failed to generate image: HTTP {response.status_code}")
                return {
                    "success": False,
                    "error": f"Failed to generate image: HTTP {response.status_code}"
                }

            file_id = str(uuid.uuid4())
            file_extension = ".jpg"
            filename = f"{file_id}{file_extension}"
            file_path = self.images_dir / filename

            with open(file_path, 'wb') as f:
                f.write(response.content)

            logger.info(f"[POLLINATIONS-PROVIDER] Image saved successfully: {file_path}")

            return {
                "success": True,
                "file_path": str(file_path),
                "filename": filename,
                "prompt": prompt,
                "model": model,
                "width": width,
                "height": height,
                "seed": seed,
                "url": response.url 
            }

        except requests.RequestException as e:
            logger.error(f"[POLLINATIONS-PROVIDER] Request failed: {str(e)}")
            return {"success": False, "error": f"Request failed: {str(e)}"}
        except Exception as e:
            logger.error(f"[POLLINATIONS-PROVIDER] Image generation failed: {str(e)}")
            return {"success": False, "error": str(e)}