# status: complete

from typing import Any, Dict, Generator, List, Optional
from dotenv import load_dotenv
import json
import os
import threading
from pathlib import Path
from utils.logger import get_logger
from utils.startup_cache import worker_get_or_initialize, has_worker_channel

load_dotenv()

logger = get_logger(__name__)

class Cerebras:
    """
    Cerebras Cloud API
    """

    AVAILABLE_MODELS = {
        "qwen-3-235b-a22b-instruct-2507": {
            "name": "Qwen 3 235B Instruct",
            "supports_reasoning": False,
            "reasoning_param": None
        },
        "qwen-3-32b": {
            "name": "Qwen 3 32B",
            "supports_reasoning": False,
            "reasoning_param": None
        },
        "llama3.1-8b": {
            "name": "Llama 3.1 8B",
            "supports_reasoning": False,
            "reasoning_param": None
        },
        "llama-3.3-70b": {
            "name": "Llama 3.3 70B",
            "supports_reasoning": False,
            "reasoning_param": None
        },
        "gpt-oss-120b": {
            "name": "OpenAI GPT OSS 120B",
            "supports_reasoning": True,
            "reasoning_param": "effort"  # Uses reasoning_effort parameter
        },
        "zai-glm-4.6": {
            "name": "GLM 4.6",
            "supports_reasoning": True,
            "reasoning_param": "disable"  # Uses disable_reasoning parameter
        }
    }

    BASE_URL = "https://api.cerebras.ai/v1/chat/completions"

    def __init__(self):
        self.api_key = os.getenv("CEREBRAS_API_KEY")
        self.status = "enabled" if self.api_key else "disabled"
        self._client = None
        self._async_client = None
        self._client_lock = threading.Lock()

        base_dir = Path(__file__).resolve().parents[3]
        self.cache_dir = base_dir / "data" / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.warmup_file = self.cache_dir / "cerebras_warmup.json"

        if not self.api_key:
            logger.warning("Cerebras provider disabled: CEREBRAS_API_KEY not configured")
            self.status = "disabled"
        else:
            # Conditionally initialize async client based on execution mode
            from utils.config import Config
            if Config.should_init_async_clients():
                try:
                    self._ensure_async_client()
                    logger.debug("Cerebras async client initialized eagerly at startup")
                except Exception as e:
                    logger.warning(f"Failed to initialize Cerebras async client at startup: {e}")
            else:
                logger.debug("Cerebras async client initialization skipped (execution mode: %s)", Config.get_chat_execution_mode())

    def is_available(self) -> bool:
        return self.status == "enabled"

    def get_available_models(self) -> Dict[str, Any]:
        """Get available models for this provider"""
        return self.AVAILABLE_MODELS.copy()

    def supports_reasoning(self, model: str) -> bool:
        """Check if specific model supports reasoning"""
        return self.AVAILABLE_MODELS.get(model, {}).get("supports_reasoning", False)

    def _warmup_once(self, client) -> None:
        if not client or not hasattr(client, "tcp_warming"):
            return

        logger.debug("Checking disk warmup cache at %s", self.warmup_file)
        if self._load_warmup_cache():
            logger.info("Cerebras TCP warmup already cached on disk (%s); skipping", self.warmup_file)
            return

        logger.debug("Disk cache miss; requesting TCP warmup via startup cache")
        logger.debug("Startup cache connection available: %s", has_worker_channel())
        def initializer() -> Dict[str, Any]:
            try:
                client.tcp_warming()
                logger.info("Cerebras TCP warmup completed successfully")
                return {"success": True}
            except Exception as exc:
                logger.warning(f"Cerebras TCP warmup failed: {exc}")
                return {"success": False, "error": str(exc)}

        result = worker_get_or_initialize("cerebras_tcp_warmup", initializer)
        if isinstance(result, dict) and result.get("success"):
            logger.info("Cerebras TCP warmup obtained from cache or computed; writing to disk")
            self._write_warmup_cache()
        elif isinstance(result, dict) and not result.get("success", True):
            logger.warning(
                "Cerebras warmup previously failed (%s); proceeding without cached warm state",
                result.get("error", "unknown error"),
            )
        else:
            logger.warning("Received unexpected warmup cache payload: %r", result)

    def _ensure_client(self):
        if not self.is_available():
            return None

        if self._client is not None:
            return self._client

        with self._client_lock:
            if self._client is not None:
                return self._client

            try:
                from cerebras.cloud.sdk import Cerebras as CerebrasClient
            except ImportError:
                logger.error("cerebras_cloud_sdk package not installed. Please run: pip install cerebras_cloud_sdk")
                self.status = "disabled"
                return None

            try:
                client = CerebrasClient(api_key=self.api_key)
                logger.info("Cerebras text generation client initialized successfully")
            except Exception as exc:
                logger.error(f"Failed to initialize Cerebras client: {exc}")
                self.status = "disabled"
                return None

            if hasattr(client, "tcp_warming"):
                logger.debug("Starting Cerebras TCP warmup check for new client")
                self._warmup_once(client)
            else:
                logger.debug("Cerebras client does not expose tcp_warming; skipping explicit warmup")

            self._client = client
            return self._client

    def _load_warmup_cache(self) -> bool:
        if not self.warmup_file.exists():
            logger.debug("Cerebras warmup cache file %s not found", self.warmup_file)
            return False
        try:
            data = json.loads(self.warmup_file.read_text(encoding="utf-8"))
            ttl = data.get("ttl_hours", 6)
            timestamp = data.get("timestamp")
            if timestamp is None:
                raise ValueError("missing timestamp")
            import time
            age_seconds = time.time() - float(timestamp)
            if age_seconds > ttl * 3600:
                logger.debug(
                    "Cerebras warmup cache expired (age=%.1fs, ttl_hours=%s)",
                    age_seconds,
                    ttl,
                )
                raise ValueError("warmup cache expired")
            logger.info("Cerebras warmup cache hit from %s", self.warmup_file)
            return True
        except Exception as exc:
            logger.info("Cerebras warmup cache at %s invalid or expired; refreshing (%s)", self.warmup_file, exc)
            try:
                self.warmup_file.unlink(missing_ok=True)
            except Exception:
                pass
            return False

    def _write_warmup_cache(self) -> None:
        try:
            import time
            payload = {"timestamp": time.time(), "ttl_hours": 6}
            tmp = self.warmup_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(self.warmup_file)
            logger.debug("Cerebras warmup cache written to %s", self.warmup_file)
        except Exception as exc:
            logger.warning(f"Cerebras warmup cache write failed: {exc}")

    def count_tokens(self, text: str, model: str) -> int:
        """Count tokens using tiktoken for OpenAI-compatible models"""
        if not text:
            return 0

        try:
            import tiktoken
            encoding = tiktoken.get_encoding("cl100k_base")
            return len(encoding.encode(text))
        except ImportError:
            logger.warning("tiktoken not installed, using fallback char approximation")
            return max(1, len(text) // 4)
        except Exception as e:
            logger.warning(f"Cerebras tiktoken counting failed: {e}, using fallback")
            return max(1, len(text) // 4)

    @staticmethod
    def _usage_from_response(response: Any) -> Optional[int]:
        usage = getattr(response, "usage", None)
        if usage is None:
            return None
        total = getattr(usage, "total_tokens", None)
        return int(total) if total is not None else None

    def _extract_error_message(self, error: Exception) -> str:
        """Extract a user-friendly error message from Cerebras exceptions"""
        error_str = str(error)

        # Check for high traffic / queue exceeded errors
        if "experiencing high traffic" in error_str.lower() or "queue_exceeded" in error_str.lower():
            return "Cerebras is experiencing high traffic right now. Please try again soon."

        # Check for other overload conditions
        if "overloaded" in error_str.lower() or "503" in error_str:
            return "Cerebras is temporarily overloaded. Please try again shortly."

        # Return original error message if no specific pattern matched
        return error_str if error_str else "Cerebras request failed. Please try again."


    def _format_chat_history(self, chat_history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        """Convert database chat history to Cerebras/OpenAI format"""
        formatted_history = []

        for message in chat_history:
            role = message.get("role")
            content = message.get("content", "")

            if role == "user":
                formatted_history.append({"role": "user", "content": content})
            elif role == "assistant":
                formatted_history.append({"role": "assistant", "content": content})

        return formatted_history

    def generate_text(self, prompt: str, model: str = "",
                     include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                     file_attachments: List[str] = None,
                     **config_params) -> Dict[str, Any]:
        """Generate text response with chat history context"""
        if not self.is_available():
            return {"text": None, "thoughts": None, "error": "Provider not available"}

        estimated_tokens = config_params.pop("rate_limit_estimated_tokens", None)

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        request_params = {
            "model": model,
            "messages": messages
        }

        if config_params:
            for key, value in config_params.items():
                if key in ["temperature", "max_completion_tokens", "max_tokens", "top_p", "stop", "stream", "reasoning_effort"]:
                    if key == "max_tokens":
                        request_params["max_completion_tokens"] = value
                    else:
                        request_params[key] = value

        if include_thoughts and self.supports_reasoning(model):
            reasoning_param = self.AVAILABLE_MODELS.get(model, {}).get("reasoning_param")
            if reasoning_param == "effort":
                # OpenAI-style reasoning with reasoning_effort parameter (gpt-oss-120b)
                if "reasoning_effort" not in request_params:
                    request_params["reasoning_effort"] = "medium"
            elif reasoning_param == "disable":
                # Z.ai-style reasoning with disable_reasoning parameter (zai-glm-4.6)
                # Non-standard parameters must be passed via extra_body
                if "extra_body" not in request_params:
                    request_params["extra_body"] = {}
                request_params["extra_body"]["disable_reasoning"] = False

        client = self._ensure_client()
        if client is None:
            return {
                "text": None,
                "thoughts": None,
                "error": "Provider not available",
            }

        try:
            response = client.chat.completions.create(**request_params)

            content = ""
            thoughts = None

            if response and response.choices and len(response.choices) > 0:
                message = response.choices[0].message
                content = message.content or ""

                if hasattr(message, 'reasoning') and message.reasoning:
                    thoughts = message.reasoning

            usage_metadata = None
            if hasattr(response, 'usage') and response.usage:
                usage_metadata = {
                    'prompt_tokens': response.usage.prompt_tokens if hasattr(response.usage, 'prompt_tokens') else 0,
                    'completion_tokens': response.usage.completion_tokens if hasattr(response.usage, 'completion_tokens') else 0,
                    'total_tokens': response.usage.total_tokens if hasattr(response.usage, 'total_tokens') else 0
                }

            return {
                "text": content,
                "thoughts": thoughts,
                "model": model,
                "usage": usage_metadata
            }

        except Exception as e:
            error_message = self._extract_error_message(e)
            logger.error(f"Cerebras API request failed: {error_message}")
            return {
                "text": None,
                "thoughts": None,
                "error": error_message
            }

    def generate_text_stream(self, prompt: str, model: str = "",
                           include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                           file_attachments: List[str] = None,
                           **config_params) -> Generator[Dict[str, Any], None, None]:
        """Generate streaming text response with chat history context"""
        if not self.is_available():
            yield {"type": "error", "content": "Provider not available"}
            return

        estimated_tokens = config_params.pop("rate_limit_estimated_tokens", None)

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        request_params = {
            "model": model,
            "messages": messages,
            "stream": True
        }

        if config_params:
            for key, value in config_params.items():
                if key in ["temperature", "max_completion_tokens", "max_tokens", "top_p", "stop", "reasoning_effort"]:
                    if key == "max_tokens":
                        request_params["max_completion_tokens"] = value
                    else:
                        request_params[key] = value

        if include_thoughts and self.supports_reasoning(model):
            reasoning_param = self.AVAILABLE_MODELS.get(model, {}).get("reasoning_param")
            if reasoning_param == "effort":
                # OpenAI-style reasoning with reasoning_effort parameter (gpt-oss-120b)
                if "reasoning_effort" not in request_params:
                    request_params["reasoning_effort"] = "medium"
            elif reasoning_param == "disable":
                # Z.ai-style reasoning with disable_reasoning parameter (zai-glm-4.6)
                # Non-standard parameters must be passed via extra_body
                if "extra_body" not in request_params:
                    request_params["extra_body"] = {}
                request_params["extra_body"]["disable_reasoning"] = False

        client = self._ensure_client()
        if client is None:
            yield {"type": "error", "content": "Provider not available"}
            return

        try:
            response = client.chat.completions.create(**request_params)

            answer_started = False
            thoughts_started = False
            last_chunk = None

            for chunk in response:
                last_chunk = chunk
                if chunk.choices and len(chunk.choices) > 0:
                    delta = chunk.choices[0].delta

                    if hasattr(delta, 'reasoning') and delta.reasoning:
                        if not thoughts_started:
                            yield {"type": "thoughts_start"}
                            thoughts_started = True
                        yield {"type": "thoughts", "content": delta.reasoning}

                    if delta.content:
                        if not answer_started:
                            yield {"type": "answer_start"}
                            answer_started = True
                        yield {"type": "answer", "content": delta.content}

            if last_chunk and hasattr(last_chunk, 'usage') and last_chunk.usage:
                usage_metadata = {
                    'prompt_tokens': last_chunk.usage.prompt_tokens if hasattr(last_chunk.usage, 'prompt_tokens') else 0,
                    'completion_tokens': last_chunk.usage.completion_tokens if hasattr(last_chunk.usage, 'completion_tokens') else 0,
                    'total_tokens': last_chunk.usage.total_tokens if hasattr(last_chunk.usage, 'total_tokens') else 0
                }
                yield {"type": "usage", "usage": usage_metadata}

            yield {"type": "complete"}

        except Exception as e:
            error_message = self._extract_error_message(e)
            logger.error(f"Cerebras streaming API request failed: {error_message}")
            raise RuntimeError(error_message) from e

    # ==================== ASYNC METHODS ====================

    def _ensure_async_client(self):
        """Initialize async Cerebras client for async operations"""
        if not self.is_available():
            return None

        if self._async_client is not None:
            return self._async_client

        with self._client_lock:
            if self._async_client is not None:
                return self._async_client

            try:
                from cerebras.cloud.sdk import AsyncCerebras
            except ImportError:
                logger.error("cerebras_cloud_sdk package not installed. Please run: pip install cerebras_cloud_sdk")
                self.status = "disabled"
                return None

            try:
                client = AsyncCerebras(api_key=self.api_key)
                logger.info("Cerebras async client initialized successfully")
                self._async_client = client
                return self._async_client
            except Exception as exc:
                logger.error(f"Failed to initialize Cerebras async client: {exc}")
                return None

    async def generate_text_async(self, prompt: str, model: str = "",
                                 include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                                 file_attachments: List[str] = None,
                                 **config_params) -> Dict[str, Any]:
        """Async version of generate_text"""
        if not self.is_available():
            return {"text": None, "thoughts": None, "error": "Provider not available"}

        estimated_tokens = config_params.pop("rate_limit_estimated_tokens", None)

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        request_params = {
            "model": model,
            "messages": messages
        }

        if config_params:
            for key, value in config_params.items():
                if key in ["temperature", "max_completion_tokens", "max_tokens", "top_p", "stop", "stream", "reasoning_effort"]:
                    if key == "max_tokens":
                        request_params["max_completion_tokens"] = value
                    else:
                        request_params[key] = value

        if include_thoughts and self.supports_reasoning(model):
            reasoning_param = self.AVAILABLE_MODELS.get(model, {}).get("reasoning_param")
            if reasoning_param == "effort":
                # OpenAI-style reasoning with reasoning_effort parameter (gpt-oss-120b)
                if "reasoning_effort" not in request_params:
                    request_params["reasoning_effort"] = "medium"
            elif reasoning_param == "disable":
                # Z.ai-style reasoning with disable_reasoning parameter (zai-glm-4.6)
                # Non-standard parameters must be passed via extra_body
                if "extra_body" not in request_params:
                    request_params["extra_body"] = {}
                request_params["extra_body"]["disable_reasoning"] = False

        client = self._ensure_async_client()
        if client is None:
            return {
                "text": None,
                "thoughts": None,
                "error": "Async client not available",
            }

        try:
            response = await client.chat.completions.create(**request_params)

            content = ""
            thoughts = None

            if response and response.choices and len(response.choices) > 0:
                message = response.choices[0].message
                content = message.content or ""

                if hasattr(message, 'reasoning') and message.reasoning:
                    thoughts = message.reasoning

            usage_metadata = None
            if hasattr(response, 'usage') and response.usage:
                usage_metadata = {
                    'prompt_tokens': response.usage.prompt_tokens if hasattr(response.usage, 'prompt_tokens') else 0,
                    'completion_tokens': response.usage.completion_tokens if hasattr(response.usage, 'completion_tokens') else 0,
                    'total_tokens': response.usage.total_tokens if hasattr(response.usage, 'total_tokens') else 0
                }

            return {
                "text": content,
                "thoughts": thoughts,
                "model": model,
                "usage": usage_metadata
            }

        except Exception as e:
            error_message = self._extract_error_message(e)
            logger.error(f"Cerebras async API request failed: {error_message}")
            return {
                "text": None,
                "thoughts": None,
                "error": error_message
            }

    async def generate_text_stream_async(self, prompt: str, model: str = "",
                                       include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                                       file_attachments: List[str] = None,
                                       **config_params):
        """Async generator version of generate_text_stream"""
        if not self.is_available():
            yield {"type": "error", "content": "Provider not available"}
            return

        estimated_tokens = config_params.pop("rate_limit_estimated_tokens", None)

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        request_params = {
            "model": model,
            "messages": messages,
            "stream": True
        }

        if config_params:
            for key, value in config_params.items():
                if key in ["temperature", "max_completion_tokens", "max_tokens", "top_p", "stop", "reasoning_effort"]:
                    if key == "max_tokens":
                        request_params["max_completion_tokens"] = value
                    else:
                        request_params[key] = value

        if include_thoughts and self.supports_reasoning(model):
            reasoning_param = self.AVAILABLE_MODELS.get(model, {}).get("reasoning_param")
            if reasoning_param == "effort":
                # OpenAI-style reasoning with reasoning_effort parameter (gpt-oss-120b)
                if "reasoning_effort" not in request_params:
                    request_params["reasoning_effort"] = "medium"
            elif reasoning_param == "disable":
                # Z.ai-style reasoning with disable_reasoning parameter (zai-glm-4.6)
                # Non-standard parameters must be passed via extra_body
                if "extra_body" not in request_params:
                    request_params["extra_body"] = {}
                request_params["extra_body"]["disable_reasoning"] = False

        client = self._ensure_async_client()
        if client is None:
            yield {"type": "error", "content": "Async client not available"}
            return

        try:
            response = await client.chat.completions.create(**request_params)

            answer_started = False
            thoughts_started = False
            last_chunk = None

            async for chunk in response:
                last_chunk = chunk
                if chunk.choices and len(chunk.choices) > 0:
                    delta = chunk.choices[0].delta

                    if hasattr(delta, 'reasoning') and delta.reasoning:
                        if not thoughts_started:
                            yield {"type": "thoughts_start"}
                            thoughts_started = True
                        yield {"type": "thoughts", "content": delta.reasoning}

                    if delta.content:
                        if not answer_started:
                            yield {"type": "answer_start"}
                            answer_started = True
                        yield {"type": "answer", "content": delta.content}

            if last_chunk and hasattr(last_chunk, 'usage') and last_chunk.usage:
                usage_metadata = {
                    'prompt_tokens': last_chunk.usage.prompt_tokens if hasattr(last_chunk.usage, 'prompt_tokens') else 0,
                    'completion_tokens': last_chunk.usage.completion_tokens if hasattr(last_chunk.usage, 'completion_tokens') else 0,
                    'total_tokens': last_chunk.usage.total_tokens if hasattr(last_chunk.usage, 'total_tokens') else 0
                }
                yield {"type": "usage", "usage": usage_metadata}

            yield {"type": "complete"}

        except Exception as e:
            error_message = self._extract_error_message(e)
            logger.error(f"Cerebras async streaming API request failed: {error_message}")
            raise RuntimeError(error_message) from e
