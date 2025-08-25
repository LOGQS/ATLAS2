# status: complete

from typing import Dict, Any, Generator, List
from dotenv import load_dotenv
import os
from google import genai
from google.genai import types
from utils.logger import get_logger
from utils.rate_limiter import get_rate_limiter
from utils.config import Config

load_dotenv()

logger = get_logger(__name__)

class Gemini:
    """
    Gemini API from Google
    """
    
    AVAILABLE_MODELS = {
        "gemini-2.5-flash": {
            "name": "Gemini 2.5 Flash",
            "supports_reasoning": True
        },
        "gemini-2.5-pro": {
            "name": "Gemini 2.5 Pro", 
            "supports_reasoning": True
        }
    }
    
    def __init__(self):
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.status = "enabled" if self.api_key else "disabled"
        self.client = None
        
        if self.api_key:
            try:
                self.client = genai.Client(api_key=self.api_key)
                logger.info("Gemini client initialized successfully")
            except Exception as e:
                logger.error(f"Failed to initialize Gemini client: {str(e)}")
                self.status = "disabled"
    
    def is_available(self) -> bool:
        return self.status == "enabled" and self.client is not None
    
    def get_available_models(self) -> Dict[str, Any]:
        """Get available models for this provider"""
        return self.AVAILABLE_MODELS.copy()
    
    def supports_reasoning(self, model: str) -> bool:
        """Check if specific model supports reasoning"""
        return self.AVAILABLE_MODELS.get(model, {}).get("supports_reasoning", False)
    
    def _format_chat_history(self, chat_history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        """Convert database chat history to Gemini format"""
        formatted_history = []
        
        for message in chat_history:
            role = message.get("role")
            content = message.get("content", "")
            
            if role == "user":
                formatted_history.append({"role": "user", "parts": [{"text": content}]})
            elif role == "assistant":
                formatted_history.append({"role": "model", "parts": [{"text": content}]})
                
        return formatted_history
    
    def count_tokens(self, contents: Any, model: str) -> int:
        """Count tokens using Gemini API specific method"""
        if not self.is_available():
            return 0
        
        try:
            limiter = get_rate_limiter(
                Config.get_rate_limit_requests_per_minute(),
                Config.get_rate_limit_burst_size()
            )
            result = limiter.execute(
                self.client.models.count_tokens,
                f"gemini:{model}",
                model=model, contents=contents
            )
            return result.total_tokens
        except Exception as e:
            logger.error(f"Token counting failed: {e}")
            return 0
    
    def generate_text(self, prompt: str, model: str = "", 
                     include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None, 
                     **config_params) -> Dict[str, Any]:
        """Generate text response with chat history context"""
        if not self.is_available():
            return {"text": None, "thoughts": None, "error": "Provider not available"}
        
        config = types.GenerateContentConfig(**config_params)
        if include_thoughts:
            config.thinking_config = types.ThinkingConfig(include_thoughts=True)
        
        contents = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            contents.extend(formatted_history)
        contents.append({"role": "user", "parts": [{"text": prompt}]})
            
        limiter = get_rate_limiter(
            Config.get_rate_limit_requests_per_minute(),
            Config.get_rate_limit_burst_size()
        )
        response = limiter.execute(
            self.client.models.generate_content,
            f"gemini:{model}",
            model=model,
            contents=contents,
            config=config
        )
        
        thoughts = ""
        answer = ""
        
        for part in response.candidates[0].content.parts:
            if not part.text:
                continue
            if part.thought:
                thoughts += part.text
            else:
                answer += part.text
        
        return {
            "text": answer,
            "thoughts": thoughts if thoughts else None,
            "model": model
        }
    
    def generate_text_stream(self, prompt: str, model: str = "", 
                           include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                           **config_params) -> Generator[Dict[str, Any], None, None]:
        """Generate streaming text response with chat history context"""
        if not self.is_available():
            yield {"type": "error", "content": "Provider not available"}
            return
            
        config = types.GenerateContentConfig(**config_params)
        if include_thoughts:
            config.thinking_config = types.ThinkingConfig(include_thoughts=True)
        
        contents = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            contents.extend(formatted_history)
        contents.append({"role": "user", "parts": [{"text": prompt}]})
        
        thoughts = ""
        answer = ""
        
        limiter = get_rate_limiter(
            Config.get_rate_limit_requests_per_minute(),
            Config.get_rate_limit_burst_size()
        )
        stream = limiter.execute(
            self.client.models.generate_content_stream,
            f"gemini:{model}",
            model=model,
            contents=contents,
            config=config
        )
        
        for chunk in stream:
            for part in chunk.candidates[0].content.parts:
                if not part.text:
                    continue
                elif part.thought:
                    if not thoughts:
                        yield {"type": "thoughts_start"}
                    yield {"type": "thoughts", "content": part.text}
                    thoughts += part.text
                else:
                    if not answer:
                        yield {"type": "answer_start"}
                    yield {"type": "answer", "content": part.text}
                    answer += part.text

class HuggingFace:
    """
    HuggingFace API
    """
    pass

class OpenRouter:
    """
    OpenRouter API
    """
    pass