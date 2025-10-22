# status: complete

from typing import Any, Callable, Dict, Generator, List, Optional
from dotenv import load_dotenv
import os
from utils.logger import get_logger
from utils.rate_limiter import get_rate_limiter
from utils.config import Config

load_dotenv()

logger = get_logger(__name__)

class Cerebras:
    """
    Cerebras Cloud API
    """

    AVAILABLE_MODELS = {
        "llama-4-scout-17b-16e-instruct": {
            "name": "Llama 4 Scout 17B",
            "supports_reasoning": False
        },
        "llama3.1-8b": {
            "name": "Llama 3.1 8B",
            "supports_reasoning": False
        },
        "llama-3.3-70b": {
            "name": "Llama 3.3 70B",
            "supports_reasoning": False
        },
        "gpt-oss-120b": {
            "name": "OpenAI GPT OSS 120B",
            "supports_reasoning": True
        },
        "qwen-3-32b": {
            "name": "Qwen 3 32B",
            "supports_reasoning": False
        },
        "llama-4-maverick-17b-128e-instruct": {
            "name": "Llama 4 Maverick 17B",
            "supports_reasoning": False
        },
        "qwen-3-235b-a22b-instruct-2507": {
            "name": "Qwen 3 235B Instruct",
            "supports_reasoning": False
        },
        "qwen-3-235b-a22b-thinking-2507": {
            "name": "Qwen 3 235B Thinking",
            "supports_reasoning": False
        },
        "qwen-3-coder-480b": {
            "name": "Qwen 3 Coder 480B",
            "supports_reasoning": False
        }
    }

    BASE_URL = "https://api.cerebras.ai/v1/chat/completions"

    def __init__(self):
        self.api_key = os.getenv("CEREBRAS_API_KEY")
        self.status = "enabled" if self.api_key else "disabled"
        self.client = None

        if self.api_key:
            try:
                from cerebras.cloud.sdk import Cerebras as CerebrasClient
                self.client = CerebrasClient(api_key=self.api_key)
                logger.info("Cerebras text generation client initialized successfully")
            except ImportError:
                logger.error("cerebras_cloud_sdk package not installed. Please run: pip install cerebras_cloud_sdk")
                self.status = "disabled"
            except Exception as e:
                logger.error(f"Failed to initialize Cerebras client: {str(e)}")
                self.status = "disabled"

    def is_available(self) -> bool:
        return self.status == "enabled" and self.client is not None

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
            logger.warning(f"Cerebras tiktoken counting failed: {e}, using fallback")
            return max(1, len(text) // 4)

    @staticmethod
    def _usage_from_response(response: Any) -> Optional[int]:
        usage = getattr(response, "usage", None)
        if usage is None:
            return None
        total = getattr(usage, "total_tokens", None)
        return int(total) if total is not None else None

    def _execute_with_rate_limit(
        self,
        operation_name: str,
        method,
        *args,
        estimated_tokens: Optional[int] = None,
        usage_getter: Optional[Callable[[Any], Optional[int]]] = None,
        **kwargs,
    ):
        """Common rate limiting wrapper for all API calls"""
        json_payload = kwargs.get("json") if isinstance(kwargs.get("json"), dict) else {}
        model_name = json_payload.get("model") or kwargs.get("model")
        rate_config = Config.get_rate_limit_config(provider="cerebras", model=model_name)
        limiter = get_rate_limiter()
        return limiter.execute(
            method,
            operation_name,
            *args,
            limit_config=rate_config,
            usage_getter=usage_getter or self._usage_from_response,
            estimated_tokens=estimated_tokens,
            **kwargs,
        )

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
            if "reasoning_effort" not in request_params:
                request_params["reasoning_effort"] = "medium"

        try:
            response = self._execute_with_rate_limit(
                f"cerebras:{model}",
                self.client.chat.completions.create,
                estimated_tokens=estimated_tokens,
                **request_params
            )

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
            logger.error(f"Cerebras API request failed: {str(e)}")
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
            if "reasoning_effort" not in request_params:
                request_params["reasoning_effort"] = "medium"

        try:
            response = self._execute_with_rate_limit(
                f"cerebras:{model}",
                self.client.chat.completions.create,
                usage_getter=None,
                estimated_tokens=estimated_tokens,
                **request_params
            )

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
            logger.error(f"Cerebras streaming API request failed: {str(e)}")
            yield {"type": "error", "content": str(e)}