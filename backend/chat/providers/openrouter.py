# status: complete

from typing import Any, Dict, Generator, List, Optional
from dotenv import load_dotenv
import os
import json
import requests
from utils.logger import get_logger

load_dotenv()

logger = get_logger(__name__)

class OpenRouter:
    """
    OpenRouter API
    """

    AVAILABLE_MODELS = {
        "deepseek/deepseek-chat-v3.1:free": {
            "name": "DeepSeek Chat v3.1",
            "supports_reasoning": True
        },
        "z-ai/glm-4.5-air:free": {
            "name": "GLM 4.5 Air",
            "supports_reasoning": False
        },
        "qwen/qwen3-coder:free": {
            "name": "Qwen3 Coder",
            "supports_reasoning": True
        },
        "moonshotai/kimi-k2:free": {
            "name": "Kimi K2",
            "supports_reasoning": False
        },
        "alibaba/tongyi-deepresearch-30b-a3b:free": {
            "name": "Tongyi Deep Research",
            "supports_reasoning": True
        },
        "openai/gpt-oss-120b": {
            "name": "GPT OSS 120B",
            "supports_reasoning": True
        }
    }

    BASE_URL = "https://openrouter.ai/api/v1/chat/completions"

    def __init__(self):
        self.api_key = os.getenv("OPENROUTER_API_KEY")
        self.status = "enabled" if self.api_key else "disabled"
        self.async_client = None

        if self.api_key:
            logger.info("OpenRouter client initialized successfully")

            # Conditionally initialize async client based on execution mode
            from utils.config import Config
            if Config.should_init_async_clients():
                try:
                    self._ensure_async_client()
                    logger.debug("OpenRouter async client initialized eagerly at startup")
                except Exception as e:
                    logger.warning(f"Failed to initialize OpenRouter async client at startup: {e}")
            else:
                logger.debug("OpenRouter async client initialization skipped (execution mode: %s)", Config.get_chat_execution_mode())
        else:
            logger.warning("OpenRouter API key not found, provider disabled")

    def is_available(self) -> bool:
        return self.status == "enabled" and self.api_key is not None

    def get_available_models(self) -> Dict[str, Any]:
        """Get available models for this provider"""
        return self.AVAILABLE_MODELS.copy()

    def supports_reasoning(self, model: str) -> bool:
        """Check if specific model supports reasoning"""
        return self.AVAILABLE_MODELS.get(model, {}).get("supports_reasoning", False)

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
            logger.warning(f"OpenRouter tiktoken counting failed: {e}, using fallback")
            return max(1, len(text) // 4)

    @staticmethod
    def _usage_from_response(response: Any) -> Optional[int]:
        try:
            payload = response.json()
        except Exception:
            return None

        usage = payload.get("usage")
        if not isinstance(usage, dict):
            return None
        total = usage.get("total_tokens")
        return int(total) if isinstance(total, int) else None



    def _format_chat_history(self, chat_history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        """Convert database chat history to OpenRouter/OpenAI format"""
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

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:5000",
            "X-Title": "ATLAS2"
        }

        data = {
            "model": model,
            "messages": messages
        }

        if config_params:
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
            response = requests.post(self.BASE_URL,
                headers=headers,
                json=data,
                timeout=30
            )

            response.raise_for_status()
            result = response.json()

            if "choices" in result and len(result["choices"]) > 0:
                message = result["choices"][0]["message"]
                content = message.get("content", "")
                reasoning = message.get("reasoning", "")

                # Extract usage metadata if available
                usage_metadata = None
                if "usage" in result:
                    usage = result["usage"]
                    usage_metadata = {
                        'prompt_tokens': usage.get('prompt_tokens', 0),
                        'completion_tokens': usage.get('completion_tokens', 0),
                        'total_tokens': usage.get('total_tokens', 0)
                    }
                    # OpenRouter specific: cached tokens
                    prompt_details = usage.get('prompt_tokens_details', {})
                    if prompt_details and 'cached_tokens' in prompt_details:
                        usage_metadata['cached_tokens'] = prompt_details.get('cached_tokens', 0)

                return {
                    "text": content,
                    "thoughts": reasoning if reasoning else None,
                    "model": model,
                    "usage": usage_metadata
                }
            else:
                logger.warning(f"Unexpected response format from OpenRouter: {result}")
                return {
                    "text": None,
                    "thoughts": None,
                    "error": "Invalid response format"
                }

        except requests.exceptions.RequestException as e:
            logger.error(f"OpenRouter API request failed: {str(e)}")
            return {
                "text": None,
                "thoughts": None,
                "error": str(e)
            }
        except Exception as e:
            logger.error(f"Unexpected error in OpenRouter generate_text: {str(e)}")
            return {
                "text": None,
                "thoughts": None,
                "error": str(e)
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

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:5000",
            "X-Title": "ATLAS2"
        }

        data = {
            "model": model,
            "messages": messages,
            "stream": True
        }

        if config_params:
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
            response = requests.post(self.BASE_URL,
                headers=headers,
                json=data,
                stream=True,
                timeout=30
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

                            # OpenRouter sends usage in a chunk with empty choices at the end
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

            # Extract usage from last chunk if available
            if last_chunk_with_usage and "usage" in last_chunk_with_usage:
                usage = last_chunk_with_usage["usage"]
                usage_metadata = {
                    'prompt_tokens': usage.get('prompt_tokens', 0),
                    'completion_tokens': usage.get('completion_tokens', 0),
                    'total_tokens': usage.get('total_tokens', 0)
                }
                # OpenRouter specific: cached tokens
                prompt_details = usage.get('prompt_tokens_details', {})
                if prompt_details and 'cached_tokens' in prompt_details:
                    usage_metadata['cached_tokens'] = prompt_details.get('cached_tokens', 0)
                yield {"type": "usage", "usage": usage_metadata}

            yield {"type": "complete"}

        except requests.exceptions.RequestException as e:
            logger.error(f"OpenRouter streaming API request failed: {str(e)}")
            yield {"type": "error", "content": str(e)}
        except Exception as e:
            logger.error(f"Unexpected error in OpenRouter generate_text_stream: {str(e)}")
            yield {"type": "error", "content": str(e)}

    # ==================== ASYNC METHODS ====================

    def _ensure_async_client(self):
        """Initialize async httpx client for async operations"""
        if not self.is_available():
            return None

        if self.async_client is not None:
            return self.async_client

        try:
            import httpx
            # Create a persistent async client (will be reused across requests)
            self.async_client = httpx.AsyncClient(timeout=30.0)
            logger.info("OpenRouter async client (httpx) initialized successfully")
            return self.async_client
        except ImportError:
            logger.error("httpx package not installed. Please run: pip install httpx")
            return None
        except Exception as exc:
            logger.error(f"Failed to initialize OpenRouter async client: {exc}")
            return None

    async def generate_text_async(self, prompt: str, model: str = "",
                                 include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                                 file_attachments: List[str] = None,
                                 **config_params) -> Dict[str, Any]:
        """Async version of generate_text using httpx"""
        if not self.is_available():
            return {"text": None, "thoughts": None, "error": "Provider not available"}

        estimated_tokens = config_params.pop("rate_limit_estimated_tokens", None)

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:5000",
            "X-Title": "ATLAS2"
        }

        data = {
            "model": model,
            "messages": messages
        }

        if config_params:
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

                usage_metadata = None
                if "usage" in result:
                    usage = result["usage"]
                    usage_metadata = {
                        'prompt_tokens': usage.get('prompt_tokens', 0),
                        'completion_tokens': usage.get('completion_tokens', 0),
                        'total_tokens': usage.get('total_tokens', 0)
                    }
                    prompt_details = usage.get('prompt_tokens_details', {})
                    if prompt_details and 'cached_tokens' in prompt_details:
                        usage_metadata['cached_tokens'] = prompt_details.get('cached_tokens', 0)

                return {
                    "text": content,
                    "thoughts": reasoning if reasoning else None,
                    "model": model,
                    "usage": usage_metadata
                }
            else:
                logger.warning(f"Unexpected response format from OpenRouter: {result}")
                return {
                    "text": None,
                    "thoughts": None,
                    "error": "Invalid response format"
                }

        except Exception as e:
            logger.error(f"OpenRouter async API request failed: {str(e)}")
            return {
                "text": None,
                "thoughts": None,
                "error": str(e)
            }

    async def generate_text_stream_async(self, prompt: str, model: str = "",
                                       include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                                       file_attachments: List[str] = None,
                                       **config_params):
        """Async generator version of generate_text_stream using httpx"""
        if not self.is_available():
            yield {"type": "error", "content": "Provider not available"}
            return

        estimated_tokens = config_params.pop("rate_limit_estimated_tokens", None)

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:5000",
            "X-Title": "ATLAS2"
        }

        data = {
            "model": model,
            "messages": messages,
            "stream": True
        }

        if config_params:
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
            yield {"type": "error", "content": "Async client not available"}
            return

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
                prompt_details = usage.get('prompt_tokens_details', {})
                if prompt_details and 'cached_tokens' in prompt_details:
                    usage_metadata['cached_tokens'] = prompt_details.get('cached_tokens', 0)
                yield {"type": "usage", "usage": usage_metadata}

            yield {"type": "complete"}

        except Exception as e:
            logger.error(f"OpenRouter async streaming API request failed: {str(e)}")
            yield {"type": "error", "content": str(e)}
