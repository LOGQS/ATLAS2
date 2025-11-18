# status: complete

from typing import Dict, Any, Optional
import json
import os
import requests
import uuid
import base64
import io
from pathlib import Path
from urllib.parse import quote
from PIL import Image
from utils.logger import get_logger
from utils.rate_limiter import get_rate_limiter
from utils.startup_cache import worker_get_or_initialize

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

        base_dir = Path(__file__).resolve().parent.parent.parent
        self.images_dir = base_dir / "data" / "generated_images"
        self.images_dir.mkdir(parents=True, exist_ok=True)

        self.cache_dir = base_dir / "data" / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_file = self.cache_dir / "pollinations_models.json"

        self._cached_models = None
        if not self._load_models_from_disk():
            self._fetch_available_models()

        logger.info(f"[POLLINATIONS-PROVIDER] Pollinations image generation provider initialized. Images directory: {self.images_dir}")

    def is_available(self) -> bool:
        """Check if provider is available"""
        return self.status == "enabled"

    def _load_models_from_disk(self) -> bool:
        """Load cached model list from disk if available."""
        if not self.cache_file.exists():
            return False

        try:
            data = json.loads(self.cache_file.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("Cached model data must be a dict")

            self._cached_models = {name: str(label) for name, label in data.items()}
            logger.info(
                "[POLLINATIONS-PROVIDER] Loaded %d cached models from %s",
                len(self._cached_models),
                self.cache_file,
            )
            return True
        except Exception as exc:
            logger.warning(
                "[POLLINATIONS-PROVIDER] Failed to load cached models (%s); refetching",
                exc,
            )
            try:
                self.cache_file.unlink(missing_ok=True)
            except Exception:
                pass
            return False

    def _save_models_to_disk(self, models: Dict[str, str]) -> None:
        """Persist the fetched model list for future startups."""
        try:
            tmp_file = self.cache_file.with_suffix(".tmp")
            tmp_file.write_text(json.dumps(models, ensure_ascii=True, indent=2), encoding="utf-8")
            tmp_file.replace(self.cache_file)
            logger.debug(
                "[POLLINATIONS-PROVIDER] Cached %d models to %s",
                len(models),
                self.cache_file,
            )
        except Exception as exc:
            logger.warning(
                "[POLLINATIONS-PROVIDER] Failed to cache models to disk: %s",
                exc,
            )

    def _fetch_available_models(self) -> None:
        """
        Fetch available models dynamically from API endpoint.
        Falls back to hardcoded FALLBACK_MODELS if fetch fails.
        """
        def initializer() -> Dict[str, Any]:
            payload: Dict[str, Any] = {}
            try:
                logger.info("[POLLINATIONS-PROVIDER] Fetching available models from API...")
                response = requests.get(self.models_url, timeout=10)
                response.raise_for_status()

                models_list = response.json()

                if not isinstance(models_list, list):
                    raise ValueError(f"Expected list of models, got {type(models_list)}")

                models = {model: model for model in models_list if isinstance(model, str)}
                payload["models"] = models
                payload["fallback"] = False
                logger.info(f"[POLLINATIONS-PROVIDER] Successfully fetched {len(models)} models from API")
            except Exception as exc:
                logger.warning(
                    f"[POLLINATIONS-PROVIDER] Failed to fetch models from API: {exc}. Using fallback models."
                )
                payload["models"] = self.FALLBACK_MODELS.copy()
                payload["fallback"] = True
                payload["error"] = str(exc)
            return payload

        cache_payload = worker_get_or_initialize("pollinations_models", initializer)

        if not isinstance(cache_payload, dict):
            logger.warning("[POLLINATIONS-PROVIDER] Unexpected cache payload type, falling back to defaults")
            self._cached_models = self.FALLBACK_MODELS.copy()
            return

        models = cache_payload.get("models")
        if not isinstance(models, dict) or not models:
            logger.warning("[POLLINATIONS-PROVIDER] Cache payload missing models, falling back to defaults")
            self._cached_models = self.FALLBACK_MODELS.copy()
            return

        self._cached_models = {name: label for name, label in models.items()}

        if not cache_payload.get("fallback"):
            self._save_models_to_disk(self._cached_models)

    def get_available_models(self) -> Dict[str, str]:
        """Get available image generation models for this provider"""
        if self._cached_models is None:
            logger.warning("[POLLINATIONS-PROVIDER] Models not cached, using fallback")
            return self.FALLBACK_MODELS.copy()
        return self._cached_models.copy()

    def generate_image(self, prompt: str, width: int = 1024, height: int = 1024,
                      seed: Optional[int] = None, model: str = "flux",
                      enhance: bool = False, safe: bool = False,
                      nologo: bool = True, private: bool = True,
                      input_image: Optional[str] = None) -> Dict[str, Any]:
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


class Zenmux:
    """
    Zenmux AI provider for image generation using Google GenAI SDK
    """

    AVAILABLE_MODELS = {
        "google/gemini-2.5-flash-image-free": "Gemini 2.5 Flash Image Free"
    }

    def __init__(self):
        self.status = "enabled"
        self.api_key = os.getenv("ZENMUX_API_KEY")
        self.client = None

        if self.api_key:
            try:
                from google import genai
                from google.genai import types

                self.client = genai.Client(
                    api_key=self.api_key,
                    vertexai=True,
                    http_options=types.HttpOptions(
                        api_version='v1',
                        base_url='https://zenmux.ai/api/vertex-ai'
                    )
                )
                logger.info("[ZENMUX-PROVIDER] API client initialized successfully")
            except Exception as e:
                logger.error(f"[ZENMUX-PROVIDER] Failed to initialize client: {e}")
                self.status = "disabled"
        else:
            logger.info("[ZENMUX-PROVIDER] No API key found")
            self.status = "disabled"

        self.rate_limiter = get_rate_limiter()
        self.rate_limit_config = {
            "requests_per_minute": 10,
            "burst_size": 1,
        }

        base_dir = Path(__file__).resolve().parent.parent.parent
        self.images_dir = base_dir / "data" / "generated_images"
        self.images_dir.mkdir(parents=True, exist_ok=True)

        logger.info(f"[ZENMUX-PROVIDER] Zenmux image generation provider initialized. Images directory: {self.images_dir}")

    def is_available(self) -> bool:
        """Check if provider is available"""
        return self.status == "enabled" and self.client is not None

    def get_available_models(self) -> Dict[str, str]:
        """Get available image generation models for this provider"""
        return self.AVAILABLE_MODELS.copy()

    def generate_image(self, prompt: str, width: int = 1024, height: int = 1024,
                      seed: Optional[int] = None, model: str = "google/gemini-2.5-flash-image-free",
                      enhance: bool = False, safe: bool = False,
                      nologo: bool = True, private: bool = True,
                      input_image: Optional[str] = None) -> Dict[str, Any]:
        """
        Generate or edit image using Zenmux AI with Google GenAI SDK

        Args:
            prompt: Text description of the image or editing instructions
            width: Image width in pixels (aspect ratio calculated)
            height: Image height in pixels (aspect ratio calculated)
            seed: Not supported
            model: Model to use for generation
            enhance: Not supported
            safe: Not supported
            nologo: Not supported
            private: Not supported
            input_image: Optional path to input image for editing

        Returns:
            Dict with generation results
        """
        if not self.is_available():
            return {"success": False, "error": "Provider not available"}

        def _generate():
            try:
                from google.genai import types

                # Calculate aspect ratio from width/height
                aspect_ratio = "1:1"  # default
                if width == height:
                    aspect_ratio = "1:1"
                elif width * 3 == height * 4:
                    aspect_ratio = "3:4"
                elif width * 4 == height * 3:
                    aspect_ratio = "4:3"
                elif width * 9 == height * 16:
                    aspect_ratio = "9:16"
                elif width * 16 == height * 9:
                    aspect_ratio = "16:9"

                # Build contents array
                contents = []

                # Add input image if provided (for image editing)
                if input_image:
                    try:
                        logger.info(f"[ZENMUX-PROVIDER] Loading input image from: {input_image}")
                        input_img = Image.open(input_image)
                        contents.append(input_img)
                        logger.info(f"[ZENMUX-PROVIDER] Input image loaded successfully")
                    except Exception as e:
                        logger.error(f"[ZENMUX-PROVIDER] Failed to load input image: {e}")
                        return {
                            "success": False,
                            "error": f"Failed to load input image: {str(e)}"
                        }

                # Add text prompt
                contents.append(prompt)

                mode = "Editing" if input_image else "Generating"
                logger.info(f"[ZENMUX-PROVIDER] {mode} image with prompt: '{prompt[:50]}...' using model: {model}, aspect ratio: {aspect_ratio}")

                # Generate content using Google GenAI SDK
                response = self.client.models.generate_content(
                    model=model,
                    contents=contents
                )

                # Extract image from response - access through candidates structure
                if not response.candidates or len(response.candidates) == 0:
                    logger.error("[ZENMUX-PROVIDER] No candidates in response")
                    return {
                        "success": False,
                        "error": "No candidates in response"
                    }

                candidate = response.candidates[0]
                if not candidate.content or not candidate.content.parts:
                    logger.error("[ZENMUX-PROVIDER] No parts in candidate content")
                    return {
                        "success": False,
                        "error": "No parts in candidate content"
                    }

                for part in candidate.content.parts:
                    if part.inline_data is not None:
                        # Extract image data - Zenmux returns raw bytes, not base64
                        image_data = part.inline_data.data

                        # Data is already bytes from Zenmux
                        if isinstance(image_data, bytes):
                            image_bytes = image_data
                        else:
                            # Fallback: decode from base64 if needed
                            image_bytes = base64.b64decode(image_data)

                        # Open image with PIL
                        image = Image.open(io.BytesIO(image_bytes))

                        # Save image
                        file_id = str(uuid.uuid4())
                        filename = f"{file_id}.png"
                        file_path = self.images_dir / filename
                        image.save(str(file_path))

                        logger.info(f"[ZENMUX-PROVIDER] Image saved successfully: {file_path}")

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
                            "safe": safe
                        }

                logger.error("[ZENMUX-PROVIDER] No image data in response")
                return {
                    "success": False,
                    "error": "No image data in response"
                }

            except Exception as e:
                logger.error(f"[ZENMUX-PROVIDER] Generation failed: {str(e)}")
                return {
                    "success": False,
                    "error": str(e)
                }

        try:
            return self.rate_limiter.execute(
                _generate,
                "zenmux:image",
                limit_config=self.rate_limit_config,
            )
        except Exception as e:
            logger.error(f"[ZENMUX-PROVIDER] Image generation failed: {str(e)}")
            return {"success": False, "error": str(e)}
