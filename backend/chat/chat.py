# status: complete

import uuid
from typing import Dict, Any, Optional, Generator, List
from chat.providers import Gemini, HuggingFace, OpenRouter
from utils.db_utils import db
from utils.logger import get_logger

logger = get_logger(__name__)

class Chat:
    """
    Main chat class that unifies all providers and manages chat sessions
    """
    
    def __init__(self, system_prompt: Optional[str] = None, chat_id: Optional[str] = None):
        self.chat_id = chat_id or self._generate_unique_id()
        self.system_prompt = system_prompt
        
        self.providers = {
            "gemini": Gemini(),
            "huggingface": HuggingFace(),
            "openrouter": OpenRouter()
        }
        
        if not db.chat_exists(self.chat_id):
            logger.info(f"Creating new chat: {self.chat_id}")
            db.create_chat(self.chat_id, self.system_prompt)
    
    def _generate_unique_id(self) -> str:
        """Generate unique chat ID"""
        chat_id = str(uuid.uuid4())
        while db.chat_exists(chat_id):
            chat_id = str(uuid.uuid4())
        return chat_id
    
    def get_available_providers(self) -> Dict[str, bool]:
        """Get list of available providers"""
        return {name: provider.is_available() for name, provider in self.providers.items()}
    
    def get_chat_history(self) -> List[Dict[str, Any]]:
        """Get full chat history for current session"""
        return db.get_chat_history(self.chat_id)
    
    def supports_reasoning(self, provider: str, model: str) -> bool:
        """Check if provider/model combination supports reasoning"""
        if (provider in self.providers and 
            self.providers[provider].is_available() and 
            hasattr(self.providers[provider], 'supports_reasoning')):
            return self.providers[provider].supports_reasoning(model)
        return False
    
    def get_all_available_models(self) -> Dict[str, Dict[str, Any]]:
        """Get all available models from all providers"""
        all_models = {}
        for provider_name, provider in self.providers.items():
            if provider.is_available() and hasattr(provider, 'get_available_models'):
                models = provider.get_available_models()
                for model_id, model_info in models.items():
                    all_models[f"{provider_name}:{model_id}"] = {
                        **model_info,
                        "provider": provider_name,
                        "model_id": model_id
                    }
        return all_models
    
    def generate_text(self, message: str, provider: str = "", 
                     model: Optional[str] = None, include_reasoning: bool = True,
                     **config_params) -> Dict[str, Any]:
        """
        Generate text response using specified provider
        
        Args:
            message: User message
            provider: Provider to use
            model: Model to use
            include_reasoning: Whether to include reasoning/thoughts
            **config_params: Additional configuration parameters
            
        Returns:
            Dict with response, reasoning, and metadata
        """
        db.save_message(self.chat_id, "user", message)
        
        if provider not in self.providers or not self.providers[provider].is_available():
            available = self.get_available_providers()
            return {
                "text": None,
                "thoughts": None,
                "error": f"Provider '{provider}' not available. Available: {available}"
            }
        
        use_reasoning = include_reasoning and self.supports_reasoning(provider, model)
        
        chat_history = self.get_chat_history()
        if chat_history and chat_history[-1]["role"] == "user":
            chat_history = chat_history[:-1]
        
        logger.info(f"Generating text with {provider}:{model} for chat {self.chat_id} with {len(chat_history)} previous messages")
        response = self.providers[provider].generate_text(
            message, model=model, include_thoughts=use_reasoning, 
            chat_history=chat_history, **config_params
        )
        

        if response.get("text"):
            db.save_message(
                self.chat_id,
                "assistant", 
                response["text"], 
                thoughts=response.get("thoughts"),
                provider=provider,
                model=model
            )
        
        return response
    
    def generate_text_stream(self, message: str, provider: str = "gemini",
                           model: Optional[str] = None, include_reasoning: bool = True,
                           **config_params) -> Generator[Dict[str, Any], None, None]:
        """
        Generate streaming text response
        
        Args:
            message: User message
            provider: Provider to use
            model: Model to use
            include_reasoning: Whether to include reasoning/thoughts
            **config_params: Additional configuration parameters
            
        Yields:
            Streaming response chunks
        """
        db.save_message(self.chat_id, "user", message)
        
        if provider not in self.providers or not self.providers[provider].is_available():
            available = self.get_available_providers()
            yield {
                "type": "error",
                "content": f"Provider '{provider}' not available. Available: {available}"
            }
            return
        
        use_reasoning = include_reasoning and self.supports_reasoning(provider, model)
        
        chat_history = self.get_chat_history()
        if chat_history and chat_history[-1]["role"] == "user":
            chat_history = chat_history[:-1]
 
        assistant_message_id = db.save_message(
            self.chat_id,
            "assistant", 
            "",
            thoughts=None,
            provider=provider,
            model=model
        )
        
        full_text = ""
        full_thoughts = ""
        
        logger.info(f"Generating streaming text with {provider}:{model} for chat {self.chat_id} with {len(chat_history)} previous messages")
        
        if use_reasoning:
            db.update_chat_state(self.chat_id, "thinking")
            current_state = "thinking"
        else:
            db.update_chat_state(self.chat_id, "responding")
            current_state = "responding"
        
        for chunk in self.providers[provider].generate_text_stream(
            message, model=model, include_thoughts=use_reasoning, 
            chat_history=chat_history, **config_params
        ):

            if chunk.get("type") == "thoughts":
                full_thoughts += chunk.get("content", "")
            elif chunk.get("type") == "answer":
                full_text += chunk.get("content", "")
                if current_state == "thinking":
                    db.update_chat_state(self.chat_id, "responding")
                    current_state = "responding"
            

            if assistant_message_id and (full_text or full_thoughts):
                db.update_message(
                    assistant_message_id,
                    full_text,
                    thoughts=full_thoughts if full_thoughts else None
                )
            
            yield chunk
        
        db.update_chat_state(self.chat_id, "static")