# status: complete

import json
from typing import Any, Dict, Generator, List, Optional

import requests

from utils.logger import get_logger
from utils.provider_errors import ProviderStreamError

logger = get_logger(__name__)


class CLIProxy:
    """
    CLIProxy provider - uses cli-proxy-api to access models via OAuth subscriptions.

    Supported OAuth providers:
    - Gemini CLI (Google account - FREE)
    - Claude Code (Claude Pro/Max subscription)
    - Codex (ChatGPT Plus/Pro subscription)
    - Qwen Code (FREE)
    - iFlow (FREE - DeepSeek, Kimi, GLM)
    - Antigravity (FREE)

    This provider implements the same interface as other providers (OpenRouter, Gemini, etc.)
    and routes requests through the local cli-proxy-api.exe which handles OAuth token management.
    """

    # Models are populated dynamically from authenticated providers
    AVAILABLE_MODELS: Dict[str, Dict[str, Any]] = {}

    BASE_URL = "http://127.0.0.1:8317/v1/chat/completions"

    def __init__(self):
        self.async_client = None
        self._manager = None
        self._models_loaded = False

        # Lazy initialization - don't start proxy in __init__
        self.status = "disabled"

        try:
            from services.cliproxy.manager import get_cliproxy_manager
            self._manager = get_cliproxy_manager()

            # Check if user has existing auth (determines if provider should be enabled)
            if self._manager.has_existing_auth():
                self.status = "enabled"
                logger.info("CLIProxy provider enabled (existing auth found)")
            else:
                logger.info("CLIProxy provider disabled (no auth files found)")

        except Exception as e:
            logger.warning(f"CLIProxy initialization failed: {e}")
            self.status = "disabled"

    def _ensure_manager(self):
        """Ensure manager is available and proxy is running."""
        if self._manager is None:
            from services.cliproxy.manager import get_cliproxy_manager
            self._manager = get_cliproxy_manager()
        return self._manager.ensure_running()

    def _load_models(self):
        """Load available models based on authenticated providers."""
        if self._models_loaded:
            return

        if not self._ensure_manager():
            return

        try:
            models = self._manager.get_available_models()
            self.AVAILABLE_MODELS = models
            self._models_loaded = True
            logger.info(f"CLIProxy loaded {len(models)} available models")
        except Exception as e:
            logger.error(f"Failed to load CLIProxy models: {e}")

    def is_available(self) -> bool:
        """Check if provider is available (has authenticated accounts)."""
        if self.status != "enabled":
            return False

        # Ensure models are loaded
        if not self._models_loaded:
            self._load_models()

        return len(self.AVAILABLE_MODELS) > 0

    def get_available_models(self) -> Dict[str, Any]:
        """Get available models from authenticated providers."""
        if not self._models_loaded:
            self._load_models()
        return self.AVAILABLE_MODELS.copy()

    def supports_reasoning(self, model: str) -> bool:
        """Check if specific model supports reasoning/thinking tokens."""
        if not self._models_loaded:
            self._load_models()
        return self.AVAILABLE_MODELS.get(model, {}).get("supports_reasoning", False)

    def count_tokens(self, text: str, model: str) -> int:
        """Count tokens using tiktoken for OpenAI-compatible models."""
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
            logger.warning(f"CLIProxy tiktoken counting failed: {e}, using fallback")
            return max(1, len(text) // 4)

    def _get_api_key(self) -> str:
        """Get API key for proxy authentication."""
        if self._manager:
            return self._manager.get_api_key()
        return "sk-proxy-demo"

    def _format_chat_history(self, chat_history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        """Convert database chat history to OpenAI format."""
        formatted_history = []

        for message in chat_history:
            role = message.get("role")
            content = message.get("content", "")

            if role == "user":
                formatted_history.append({"role": "user", "content": content})
            elif role == "assistant":
                formatted_history.append({"role": "assistant", "content": content})

        return formatted_history

    @staticmethod
    def _usage_from_response(response: Any) -> Optional[Dict[str, int]]:
        """Extract usage metadata from response."""
        try:
            if hasattr(response, 'json'):
                payload = response.json()
            else:
                payload = response
        except Exception:
            return None

        usage = payload.get("usage")
        if not isinstance(usage, dict):
            return None

        return {
            'prompt_tokens': usage.get('prompt_tokens', 0),
            'completion_tokens': usage.get('completion_tokens', 0),
            'total_tokens': usage.get('total_tokens', 0)
        }

    def generate_text(self, prompt: str, model: str = "",
                     include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                     file_attachments: List[str] = None,
                     **config_params) -> Dict[str, Any]:
        """Generate text response with chat history context."""
        if not self.is_available():
            return {"text": None, "thoughts": None, "error": "Provider not available"}

        if not self._ensure_manager():
            return {"text": None, "thoughts": None, "error": "Failed to start CLIProxy"}

        config_params.pop("rate_limit_estimated_tokens", None)

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self._get_api_key()}",
            "Content-Type": "application/json",
        }

        data = {
            "model": model,
            "messages": messages,
        }

        # Add config params
        for key, value in config_params.items():
            if key in ["temperature", "max_tokens", "top_p", "frequency_penalty", "presence_penalty"]:
                data[key] = value

        # Enable reasoning if supported
        if include_thoughts and self.supports_reasoning(model):
            data["reasoning"] = {
                "effort": "medium",
                "exclude": False,
                "enabled": True
            }

        try:
            response = requests.post(
                self.BASE_URL,
                headers=headers,
                json=data,
                timeout=120
            )

            response.raise_for_status()
            result = response.json()

            if "choices" in result and len(result["choices"]) > 0:
                message = result["choices"][0]["message"]
                content = message.get("content", "")
                reasoning = message.get("reasoning", "")

                usage_metadata = self._usage_from_response(result)

                return {
                    "text": content,
                    "thoughts": reasoning if reasoning else None,
                    "model": model,
                    "usage": usage_metadata
                }
            else:
                logger.warning(f"Unexpected response format from CLIProxy: {result}")
                return {
                    "text": None,
                    "thoughts": None,
                    "error": "Invalid response format"
                }

        except requests.exceptions.RequestException as e:
            logger.error(f"CLIProxy API request failed: {str(e)}")
            return {
                "text": None,
                "thoughts": None,
                "error": str(e)
            }
        except Exception as e:
            logger.error(f"Unexpected error in CLIProxy generate_text: {str(e)}")
            return {
                "text": None,
                "thoughts": None,
                "error": str(e)
            }

    def generate_text_stream(self, prompt: str, model: str = "",
                           include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                           file_attachments: List[str] = None,
                           **config_params) -> Generator[Dict[str, Any], None, None]:
        """Generate streaming text response with chat history context."""
        if not self.is_available():
            yield {"type": "error", "content": "Provider not available"}
            return

        if not self._ensure_manager():
            yield {"type": "error", "content": "Failed to start CLIProxy"}
            return

        config_params.pop("rate_limit_estimated_tokens", None)

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self._get_api_key()}",
            "Content-Type": "application/json",
        }

        data = {
            "model": model,
            "messages": messages,
            "stream": True
        }

        for key, value in config_params.items():
            if key in ["temperature", "max_tokens", "top_p", "frequency_penalty", "presence_penalty"]:
                data[key] = value

        if include_thoughts and self.supports_reasoning(model):
            data["reasoning"] = {
                "effort": "medium",
                "exclude": False,
                "enabled": True
            }

        try:
            response = requests.post(
                self.BASE_URL,
                headers=headers,
                json=data,
                stream=True,
                timeout=120
            )

            response.raise_for_status()

            answer_started = False
            thoughts_started = False
            last_chunk_with_usage = None

            for line in response.iter_lines():
                if line:
                    line_str = line.decode('utf-8')
                    if line_str.startswith('data: '):
                        line_str = line_str[6:]
                        if line_str == '[DONE]':
                            break

                        try:
                            chunk = json.loads(line_str)

                            # Track usage from final chunk
                            if "usage" in chunk and chunk["usage"]:
                                last_chunk_with_usage = chunk

                            if "choices" in chunk and len(chunk["choices"]) > 0:
                                delta = chunk["choices"][0].get("delta", {})
                                content = delta.get("content", "")
                                reasoning = delta.get("reasoning", "")

                                if reasoning:
                                    if not thoughts_started:
                                        yield {"type": "thoughts_start"}
                                        thoughts_started = True
                                    yield {"type": "thoughts", "content": reasoning}

                                if content:
                                    if not answer_started:
                                        yield {"type": "answer_start"}
                                        answer_started = True
                                    yield {"type": "answer", "content": content}

                        except json.JSONDecodeError:
                            logger.warning(f"Failed to parse chunk: {line_str}")
                            continue

            # Emit usage if available
            if last_chunk_with_usage and "usage" in last_chunk_with_usage:
                usage = last_chunk_with_usage["usage"]
                usage_metadata = {
                    'prompt_tokens': usage.get('prompt_tokens', 0),
                    'completion_tokens': usage.get('completion_tokens', 0),
                    'total_tokens': usage.get('total_tokens', 0)
                }
                yield {"type": "usage", "usage": usage_metadata}

            yield {"type": "complete"}

        except requests.exceptions.RequestException as e:
            logger.error(f"CLIProxy streaming API request failed: {str(e)}")
            yield {"type": "error", "content": str(e)}
        except Exception as e:
            logger.error(f"Unexpected error in CLIProxy generate_text_stream: {str(e)}")
            yield {"type": "error", "content": str(e)}

    # ==================== ASYNC METHODS ====================

    def _ensure_async_client(self):
        """Initialize async httpx client for async operations."""
        if not self.is_available():
            return None

        if self.async_client is not None:
            return self.async_client

        try:
            import httpx
            self.async_client = httpx.AsyncClient(timeout=120.0)
            logger.info("CLIProxy async client (httpx) initialized successfully")
            return self.async_client
        except ImportError:
            logger.error("httpx package not installed. Please run: pip install httpx")
            return None
        except Exception as exc:
            logger.error(f"Failed to initialize CLIProxy async client: {exc}")
            return None

    async def generate_text_async(self, prompt: str, model: str = "",
                                 include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                                 file_attachments: List[str] = None,
                                 **config_params) -> Dict[str, Any]:
        """Async version of generate_text using httpx."""
        if not self.is_available():
            return {"text": None, "thoughts": None, "error": "Provider not available"}

        if not self._ensure_manager():
            return {"text": None, "thoughts": None, "error": "Failed to start CLIProxy"}

        config_params.pop("rate_limit_estimated_tokens", None)

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self._get_api_key()}",
            "Content-Type": "application/json",
        }

        data = {
            "model": model,
            "messages": messages
        }

        for key, value in config_params.items():
            if key in ["temperature", "max_tokens", "top_p", "frequency_penalty", "presence_penalty"]:
                data[key] = value

        if include_thoughts and self.supports_reasoning(model):
            data["reasoning"] = {
                "effort": "medium",
                "exclude": False,
                "enabled": True
            }

        client = self._ensure_async_client()
        if client is None:
            return {"text": None, "thoughts": None, "error": "Async client not available"}

        try:
            response = await client.post(self.BASE_URL, json=data, headers=headers)
            response.raise_for_status()
            result = response.json()

            if "choices" in result and len(result["choices"]) > 0:
                message = result["choices"][0]["message"]
                content = message.get("content", "")
                reasoning = message.get("reasoning", "")

                usage_metadata = self._usage_from_response(result)

                return {
                    "text": content,
                    "thoughts": reasoning if reasoning else None,
                    "model": model,
                    "usage": usage_metadata
                }
            else:
                logger.warning(f"Unexpected response format from CLIProxy: {result}")
                return {
                    "text": None,
                    "thoughts": None,
                    "error": "Invalid response format"
                }

        except Exception as e:
            logger.error(f"CLIProxy async API request failed: {str(e)}")
            return {
                "text": None,
                "thoughts": None,
                "error": str(e)
            }

    async def generate_text_stream_async(self, prompt: str, model: str = "",
                                       include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                                       file_attachments: List[str] = None,
                                       **config_params):
        """Async generator version of generate_text_stream using httpx."""
        if not self.is_available():
            raise ProviderStreamError("CLIProxy provider not available")

        if not self._ensure_manager():
            raise ProviderStreamError("Failed to start CLIProxy")

        config_params.pop("rate_limit_estimated_tokens", None)

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self._get_api_key()}",
            "Content-Type": "application/json",
        }

        data = {
            "model": model,
            "messages": messages,
            "stream": True
        }

        for key, value in config_params.items():
            if key in ["temperature", "max_tokens", "top_p", "frequency_penalty", "presence_penalty"]:
                data[key] = value

        if include_thoughts and self.supports_reasoning(model):
            data["reasoning"] = {
                "effort": "medium",
                "exclude": False,
                "enabled": True
            }

        client = self._ensure_async_client()
        if client is None:
            raise ProviderStreamError("CLIProxy async client not available")

        try:
            async with client.stream("POST", self.BASE_URL, json=data, headers=headers) as response:
                response.raise_for_status()

                answer_started = False
                thoughts_started = False
                last_chunk_with_usage = None

                async for line in response.aiter_lines():
                    if line:
                        if line.startswith('data: '):
                            line_str = line[6:]
                            if line_str == '[DONE]':
                                break

                            try:
                                chunk = json.loads(line_str)

                                if "usage" in chunk and chunk["usage"]:
                                    last_chunk_with_usage = chunk

                                if "choices" in chunk and len(chunk["choices"]) > 0:
                                    delta = chunk["choices"][0].get("delta", {})
                                    content = delta.get("content", "")
                                    reasoning = delta.get("reasoning", "")

                                    if reasoning:
                                        if not thoughts_started:
                                            yield {"type": "thoughts_start"}
                                            thoughts_started = True
                                        yield {"type": "thoughts", "content": reasoning}

                                    if content:
                                        if not answer_started:
                                            yield {"type": "answer_start"}
                                            answer_started = True
                                        yield {"type": "answer", "content": content}

                            except json.JSONDecodeError:
                                logger.warning(f"Failed to parse chunk: {line_str}")
                                continue

            if last_chunk_with_usage and "usage" in last_chunk_with_usage:
                usage = last_chunk_with_usage["usage"]
                usage_metadata = {
                    'prompt_tokens': usage.get('prompt_tokens', 0),
                    'completion_tokens': usage.get('completion_tokens', 0),
                    'total_tokens': usage.get('total_tokens', 0)
                }
                yield {"type": "usage", "usage": usage_metadata}

            yield {"type": "complete"}

        except Exception as e:
            logger.error(f"CLIProxy async streaming API request failed: {str(e)}")
            raise ProviderStreamError(str(e))

    # ==================== MANAGEMENT METHODS ====================

    def get_auth_status(self) -> Dict[str, Any]:
        """Get authentication status for all OAuth providers."""
        if self._manager:
            return self._manager.get_auth_status()
        return {"error": "Manager not initialized", "providers": {}}

    def start_login(self, provider_id: str) -> Dict[str, Any]:
        """Start OAuth login flow for a provider."""
        if self._manager:
            return self._manager.start_oauth_login(provider_id)
        return {"success": False, "error": "Manager not initialized"}

    def poll_login_status(self, state: str) -> Dict[str, Any]:
        """Poll OAuth login completion status."""
        if self._manager:
            return self._manager.poll_oauth_status(state)
        return {"status": "error", "error": "Manager not initialized"}

    def logout(self, filename: str) -> Dict[str, Any]:
        """Remove an authenticated account."""
        if self._manager:
            result = self._manager.logout_account(filename)
            if result.get("success"):
                # Reload models after logout
                self._models_loaded = False
                self._load_models()
            return result
        return {"success": False, "error": "Manager not initialized"}

    def refresh_models(self):
        """Force refresh of available models."""
        self._models_loaded = False
        self._load_models()
        # Update status based on available models
        if len(self.AVAILABLE_MODELS) > 0:
            self.status = "enabled"
        else:
            self.status = "disabled"
