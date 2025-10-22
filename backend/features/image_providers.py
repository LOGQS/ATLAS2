# status: complete

from typing import Dict, Any, Optional
import os
import requests
import uuid
from pathlib import Path
from urllib.parse import quote
from utils.logger import get_logger
from utils.rate_limiter import get_rate_limiter

logger = get_logger(__name__)

class Pollinations:
    """
    Pollinations AI provider for image generation
    """

    FALLBACK_MODELS = {
        "flux": "Flux (Default, high quality)",
        "flux-realism": "Flux Realism",
        "flux-anime": "Flux Anime Style",
        "flux-3d": "Flux 3D Style",
        "flux-pro": "Flux Pro"
    }

    def __init__(self):
        self.base_url = "https://image.pollinations.ai/prompt"
        self.models_url = "https://image.pollinations.ai/models"
        self.status = "enabled"

        self.api_key = os.getenv("POLLINATIONS_API_KEY")

        if self.api_key:
            requests_per_minute = 12  
            logger.info("[POLLINATIONS-PROVIDER] API key loaded - using authenticated tier (5s rate limit)")
        else:
            requests_per_minute = 4  
            logger.info("[POLLINATIONS-PROVIDER] No API key found - using anonymous tier (15s rate limit)")

        self.rate_limiter = get_rate_limiter()
        self.rate_limit_config = {
            "requests_per_minute": requests_per_minute,
            "burst_size": 1,
        }

        self.images_dir = Path(__file__).resolve().parent.parent.parent / "data" / "generated_images"
        self.images_dir.mkdir(parents=True, exist_ok=True)

        self._cached_models = None
        self._fetch_available_models()

        logger.info(f"[POLLINATIONS-PROVIDER] Pollinations image generation provider initialized. Images directory: {self.images_dir}")

    def is_available(self) -> bool:
        """Check if provider is available"""
        return self.status == "enabled"

    def _fetch_available_models(self) -> None:
        """
        Fetch available models dynamically from API endpoint.
        Falls back to hardcoded FALLBACK_MODELS if fetch fails.
        """
        try:
            logger.info("[POLLINATIONS-PROVIDER] Fetching available models from API...")
            response = requests.get(self.models_url, timeout=10)
            response.raise_for_status()

            models_list = response.json()

            if not isinstance(models_list, list):
                raise ValueError(f"Expected list of models, got {type(models_list)}")

            self._cached_models = {model: model for model in models_list if isinstance(model, str)}

            logger.info(f"[POLLINATIONS-PROVIDER] Successfully fetched {len(self._cached_models)} models from API")

        except Exception as e:
            logger.warning(f"[POLLINATIONS-PROVIDER] Failed to fetch models from API: {e}. Using fallback models.")
            self._cached_models = self.FALLBACK_MODELS.copy()

    def get_available_models(self) -> Dict[str, str]:
        """Get available image generation models for this provider"""
        if self._cached_models is None:
            logger.warning("[POLLINATIONS-PROVIDER] Models not cached, using fallback")
            return self.FALLBACK_MODELS.copy()
        return self._cached_models.copy()

    def generate_image(self, prompt: str, width: int = 1024, height: int = 1024,
                      seed: Optional[int] = None, model: str = "flux",
                      enhance: bool = False, safe: bool = False,
                      nologo: bool = True, private: bool = True) -> Dict[str, Any]:
        """
        Generate image using Pollinations AI 

        Args:
            prompt: Text description of the image
            width: Image width in pixels
            height: Image height in pixels
            seed: Random seed for reproducible generation
            model: Model to use for generation
            enhance: Enhance prompt using LLM for more detail
            safe: Strict NSFW filtering, throws error if detected 
            nologo: Remove Pollinations logo (requires authentication) 
            private: Prevent image from appearing in public feed 

        Returns:
            Dict with generation results
        """
        if not self.is_available():
            return {"success": False, "error": "Provider not available"}

        def _generate():
            encoded_prompt = quote(prompt)

            url = f"{self.base_url}/{encoded_prompt}"
            params = {
                "width": width,
                "height": height,
                "model": model
            }

            if seed is not None:
                params["seed"] = seed
            if enhance:
                params["enhance"] = "true"
            if safe:
                params["safe"] = "true"
            if nologo:
                params["nologo"] = "true"
            if private:
                params["private"] = "true"

            headers = {}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"

            logger.info(f"[POLLINATIONS-PROVIDER] Generating image with prompt: '{prompt[:50]}...' using model: {model}, size: {width}x{height}")

            response = requests.get(url, params=params, headers=headers, timeout=300)

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
                "enhance": enhance,
                "safe": safe,
                "url": response.url
            }

        try:
            return self.rate_limiter.execute(
                _generate,
                "pollinations:image",
                limit_config=self.rate_limit_config,
            )
        except requests.RequestException as e:
            logger.error(f"[POLLINATIONS-PROVIDER] Request failed: {str(e)}")
            return {"success": False, "error": f"Request failed: {str(e)}"}
        except Exception as e:
            logger.error(f"[POLLINATIONS-PROVIDER] Image generation failed: {str(e)}")
            return {"success": False, "error": str(e)}