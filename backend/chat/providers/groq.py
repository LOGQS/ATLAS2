# status: complete

from typing import Dict, Any, Generator, List, Optional
from dotenv import load_dotenv
import os
from utils.logger import get_logger
from utils.rate_limiter import get_rate_limiter
from utils.config import Config

load_dotenv()

logger = get_logger(__name__)

class Groq:
    """
    Groq API
    """

    AVAILABLE_MODELS = {
        "groq/compound": {
            "name": "Groq Compound",
            "supports_reasoning": False
        },
        "meta-llama/llama-4-maverick-17b-128e-instruct": {
            "name": "Llama 4 Maverick 17B",
            "supports_reasoning": False
        },
        "meta-llama/llama-4-scout-17b-16e-instruct": {
            "name": "Llama 4 Scout 17B",
            "supports_reasoning": False
        },
        "moonshotai/kimi-k2-instruct-0905": {
            "name": "Kimi K2 Instruct",
            "supports_reasoning": False
        },
        "openai/gpt-oss-120b": {
            "name": "GPT-OSS 120B",
            "supports_reasoning": True
        }
    }

    BASE_URL = "https://api.groq.com/openai/v1/chat/completions"

    def __init__(self):
        self.api_key = os.getenv("GROQ_API_KEY")
        self.status = "enabled" if self.api_key else "disabled"
        self.client = None

        if self.api_key:
            try:
                from groq import Groq as GroqClient
                self.client = GroqClient(api_key=self.api_key)
                logger.info("Groq text generation client initialized successfully")
            except ImportError:
                logger.error("groq package not installed. Please run: pip install groq")
                self.status = "disabled"
            except Exception as e:
                logger.error(f"Failed to initialize Groq client: {str(e)}")
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
            logger.warning(f"Groq tiktoken counting failed: {e}, using fallback")
            return max(1, len(text) // 4)

    def _execute_with_rate_limit(self, operation_name: str, method, *args, **kwargs):
        """Common rate limiting wrapper for all API calls"""
        limiter = get_rate_limiter(
            Config.get_rate_limit_requests_per_minute(),
            Config.get_rate_limit_burst_size()
        )
        return limiter.execute(method, operation_name, *args, **kwargs)

    def _format_chat_history(self, chat_history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        """Convert database chat history to Groq/OpenAI format"""
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
                if key in ["temperature", "max_completion_tokens", "max_tokens", "top_p", "stop", "stream"]:
                    if key == "max_tokens":
                        request_params["max_completion_tokens"] = value
                    else:
                        request_params[key] = value

        if include_thoughts and self.supports_reasoning(model):
            request_params["include_reasoning"] = True

        try:
            response = self._execute_with_rate_limit(
                f"groq:{model}",
                self.client.chat.completions.create,
                **request_params
            )

            thoughts = None
            content = ""

            if response and response.choices and len(response.choices) > 0:
                message = response.choices[0].message
                content = message.content or ""

                if hasattr(message, 'reasoning') and message.reasoning:
                    thoughts = message.reasoning
                elif model == "groq/compound" and hasattr(message, 'executed_tools'):
                    thoughts = str(message.executed_tools) if message.executed_tools else None

            # Extract usage metadata if available
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
            logger.error(f"Groq API request failed: {str(e)}")
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
                if key in ["temperature", "max_completion_tokens", "max_tokens", "top_p", "stop"]:
                    if key == "max_tokens":
                        request_params["max_completion_tokens"] = value
                    else:
                        request_params[key] = value

        if include_thoughts and self.supports_reasoning(model):
            request_params["include_reasoning"] = True

        try:
            response = self._execute_with_rate_limit(
                f"groq:{model}",
                self.client.chat.completions.create,
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

            # Extract usage from last chunk if available
            if last_chunk and hasattr(last_chunk, 'usage') and last_chunk.usage:
                usage_metadata = {
                    'prompt_tokens': last_chunk.usage.prompt_tokens if hasattr(last_chunk.usage, 'prompt_tokens') else 0,
                    'completion_tokens': last_chunk.usage.completion_tokens if hasattr(last_chunk.usage, 'completion_tokens') else 0,
                    'total_tokens': last_chunk.usage.total_tokens if hasattr(last_chunk.usage, 'total_tokens') else 0
                }
                yield {"type": "usage", "usage": usage_metadata}

            yield {"type": "complete"}

        except Exception as e:
            logger.error(f"Groq streaming API request failed: {str(e)}")
            yield {"type": "error", "content": str(e)}

