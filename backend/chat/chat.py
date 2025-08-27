# status: complete

import uuid
import threading
from typing import Dict, Any, Optional, Generator, List
from utils.config import get_provider_map, Config
from utils.db_utils import db
from utils.logger import get_logger
from utils.cancellation_manager import cancellation_manager

logger = get_logger(__name__)

_chat_threads_lock = threading.Lock()
_chat_threads: Dict[str, threading.Thread] = {}
_chat_thread_status: Dict[str, str] = {} 
_chat_thread_cancel_flags: Dict[str, threading.Event] = {}

def get_chat_thread_status(chat_id: str) -> Optional[str]:
    """Get the status of a chat's background thread"""
    with _chat_threads_lock:
        return _chat_thread_status.get(chat_id)

def is_chat_processing(chat_id: str) -> bool:
    """Check if a chat is currently being processed in background"""
    with _chat_threads_lock:
        return (chat_id in _chat_threads and 
                _chat_threads[chat_id].is_alive() and 
                _chat_thread_status.get(chat_id) == 'running')

def cleanup_completed_threads():
    """Clean up completed/dead threads"""
    with _chat_threads_lock:
        completed_chats = []
        for chat_id, thread in list(_chat_threads.items()):
            if not thread.is_alive():
                completed_chats.append(chat_id)
        
        for chat_id in completed_chats:
            del _chat_threads[chat_id]
            _chat_thread_status.pop(chat_id, None)
            _chat_thread_cancel_flags.pop(chat_id, None)
            logger.info(f"Cleaned up completed thread for chat {chat_id}")

def cancel_chat_thread(chat_id: str) -> bool:
    """Cancel a running background thread for a chat (only for explicit user cancellation)"""
    with _chat_threads_lock:
        if chat_id in _chat_thread_cancel_flags:
            logger.info(f"Cancelling background thread for chat {chat_id}")
            _chat_thread_cancel_flags[chat_id].set()
            _chat_thread_status[chat_id] = 'cancelled'
            return True
        return False

def is_chat_cancelled(chat_id: str) -> bool:
    """Check if a chat's processing has been cancelled"""
    return cancellation_manager.is_chat_cancelled(chat_id)

def _start_background_processing(chat_id: str, chat_instance, message: str, provider: str, model: str, include_reasoning: bool, **config_params):
    """Start background processing thread for a chat"""
    with _chat_threads_lock:
        if chat_id in _chat_threads:
            old_thread = _chat_threads[chat_id]
            if old_thread.is_alive():
                logger.warning(f"Chat {chat_id} already has a running thread, keeping existing one")
                return False
            else:
                del _chat_threads[chat_id]
                _chat_thread_status.pop(chat_id, None)
                _chat_thread_cancel_flags.pop(chat_id, None)
        
        cancel_event = threading.Event()
        
        thread = threading.Thread(
            target=_background_process_wrapper,
            args=(chat_id, chat_instance, message, provider, model, include_reasoning, cancel_event),
            kwargs=config_params
        )
        thread.daemon = True
        _chat_threads[chat_id] = thread
        _chat_thread_status[chat_id] = 'running'
        _chat_thread_cancel_flags[chat_id] = cancel_event
        
        cancellation_manager.register_chat_thread(chat_id, thread, cancel_event)
        
        thread.start()
        
        logger.info(f"Started background processing thread for chat {chat_id}")
        return True

def _background_process_wrapper(chat_id: str, chat_instance, message: str, provider: str, model: str, include_reasoning: bool, cancel_event: threading.Event, **config_params):
    """Wrapper for background processing with error handling"""
    try:
        logger.info(f"Background processing started for chat {chat_id}")
        
        chat_instance._process_message_background(message, provider, model, include_reasoning, cancel_event, **config_params)
        
        with _chat_threads_lock:
            _chat_thread_status[chat_id] = 'completed'
        
        logger.info(f"Background processing completed for chat {chat_id}")
        
    except Exception as e:
        logger.error(f"Background processing error for chat {chat_id}: {str(e)}", exc_info=True)
        
        with _chat_threads_lock:
            _chat_thread_status[chat_id] = 'error'
        
        try:
            db.update_chat_state(chat_id, "static")
            logger.info(f"Reset DB state to 'static' for chat {chat_id} after error")
        except Exception as db_error:
            logger.critical(f"CRITICAL: Failed to reset DB state for chat {chat_id}: {str(db_error)}")
        
        try:
            from route.chat_route import publish_state, publish_content
            publish_content(chat_id, "error", str(e))
            publish_state(chat_id, "static")
        except Exception as cleanup_error:
            logger.warning(f"Failed to publish error state (non-critical): {str(cleanup_error)}")
    finally:
        cancellation_manager.unregister_chat_thread(chat_id)

class Chat:
    """
    Main chat class that unifies all providers and manages chat sessions
    """
    
    def __init__(self, system_prompt: Optional[str] = None, chat_id: Optional[str] = None):
        self.chat_id = chat_id or self._generate_unique_id()
        self.system_prompt = system_prompt
        
        self.providers = get_provider_map()
        
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
    
    def _prepare_streaming_context(self, provider: str, model: str, **config_params):
        """Common setup logic for streaming methods"""
        if provider is None:
            provider = Config.get_default_provider()
        if model is None:
            model = Config.get_default_model()
        
        if provider not in self.providers or not self.providers[provider].is_available():
            available = self.get_available_providers()
            return None, f"Provider '{provider}' not available. Available: {available}"
        
        use_reasoning = config_params.pop('include_reasoning', True) and self.supports_reasoning(provider, model)
        
        chat_history = self.get_chat_history()
        if chat_history and chat_history[-1]["role"] == "user":
            chat_history = chat_history[:-1]
        
        file_attachments = []
        if hasattr(self.providers[provider], 'get_file_attachments_for_request'):
            file_attachments = self.providers[provider].get_file_attachments_for_request(self.chat_id)
        
        new_file_ids = config_params.pop("attached_file_ids", None) or []
        if new_file_ids:
            new_file_attachments = self._resolve_api_file_names(new_file_ids, provider)
            existing_names = set(file_attachments)
            for new_file in new_file_attachments:
                if new_file not in existing_names:
                    file_attachments.append(new_file)
        
        return {
            'provider': provider,
            'model': model,
            'use_reasoning': use_reasoning,
            'chat_history': chat_history,
            'file_attachments': file_attachments,
            'config_params': config_params  
        }, None
    
    def _resolve_api_file_names(self, file_ids, provider):
        """Resolve file IDs to API file names for ready files only"""
        from utils.db_utils import db
        names = []
        for fid in file_ids:
            rec = db.get_file_record(fid)
            if rec:
                file_provider = rec.get('provider')
                api_file_name = rec.get('api_file_name')
                api_state = rec.get('api_state')
                
                logger.info(f"[FILE-RESOLVE] File {fid}: provider='{file_provider}', api_file_name='{api_file_name}', api_state='{api_state}', requested_provider='{provider}'")
                
                effective_provider = file_provider or 'gemini'
                
                if effective_provider == provider and api_file_name and api_state == 'ready':
                    names.append(api_file_name)
                    logger.info(f"[FILE-RESOLVE] ✅ File {fid} ({rec.get('original_name')}) resolved to API name: {api_file_name}")
                else:
                    logger.warning(f"[FILE-RESOLVE] ❌ File {fid} ({rec.get('original_name')}) not ready - provider: '{effective_provider}' (want: '{provider}'), api_file_name: '{api_file_name}', state: '{api_state}'")
            else:
                logger.warning(f"[FILE-RESOLVE] ❌ File {fid} not found in database")
        
        logger.info(f"[FILE-RESOLVE] Resolved {len(names)}/{len(file_ids)} files for chat with {provider}")
        return names

    def generate_text(self, message: str, provider: str = "", 
                     model: Optional[str] = None, include_reasoning: bool = True,
                     attached_file_ids: List[str] = None, **config_params) -> Dict[str, Any]:
        """
        Generate text response using specified provider
        
        Args:
            message: User message
            provider: Provider to use
            model: Model to use
            include_reasoning: Whether to include reasoning/thoughts
            attached_file_ids: List of file IDs to attach to the user message
            **config_params: Additional configuration parameters
            
        Returns:
            Dict with response, reasoning, and metadata
        """
        db.save_message(self.chat_id, "user", message, attached_file_ids=attached_file_ids or [])
        
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
        
        file_attachments = []
        if hasattr(self.providers[provider], 'get_file_attachments_for_request'):
            file_attachments = self.providers[provider].get_file_attachments_for_request(self.chat_id)
        
        new_file_ids = attached_file_ids or config_params.get("attached_file_ids") or []
        config_params.pop("attached_file_ids", None)
        if new_file_ids:
            new_file_attachments = self._resolve_api_file_names(new_file_ids, provider)
            existing_names = set(file_attachments)
            for new_file in new_file_attachments:
                if new_file not in existing_names:
                    file_attachments.append(new_file)
        
        logger.info(f"Generating text with {provider}:{model} for chat {self.chat_id} with {len(chat_history)} previous messages and {len(file_attachments)} file attachments")
        response = self.providers[provider].generate_text(
            message, model=model, include_thoughts=use_reasoning, 
            chat_history=chat_history, file_attachments=file_attachments, **config_params
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
    
    def generate_text_stream(self, message: str, provider: Optional[str] = None,
                           model: Optional[str] = None, include_reasoning: bool = True,
                           attached_file_ids: List[str] = None, **config_params) -> Generator[Dict[str, Any], None, None]:
        """
        Generate streaming text response
        
        Args:
            message: User message
            provider: Provider to use
            model: Model to use
            include_reasoning: Whether to include reasoning/thoughts
            attached_file_ids: List of file IDs to attach to the user message
            **config_params: Additional configuration parameters
            
        Yields:
            Streaming response chunks
        """
        from route.chat_route import publish_state
        db.save_message(self.chat_id, "user", message, attached_file_ids=attached_file_ids or [])
        
        config_params['include_reasoning'] = include_reasoning
        if attached_file_ids:
            config_params['attached_file_ids'] = attached_file_ids
        context, error = self._prepare_streaming_context(provider, model, **config_params)
        if error:
            yield {"type": "error", "content": error}
            return
        
        provider = context['provider']
        model = context['model']
        use_reasoning = context['use_reasoning']
        chat_history = context['chat_history']
        file_attachments = context['file_attachments']
        config_params = context['config_params']
 
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
        
        logger.info(f"Generating streaming text with {provider}:{model} for chat {self.chat_id} with {len(chat_history)} previous messages and {len(file_attachments)} file attachments")
        
        if use_reasoning:
            db.update_chat_state(self.chat_id, "thinking")
            publish_state(self.chat_id, "thinking")
            current_state = "thinking"
        else:
            db.update_chat_state(self.chat_id, "responding")
            publish_state(self.chat_id, "responding")
            current_state = "responding"
        
        for chunk in self.providers[provider].generate_text_stream(
            message, model=model, include_thoughts=use_reasoning, 
            chat_history=chat_history, file_attachments=file_attachments, **config_params
        ):

            if chunk.get("type") == "thoughts":
                full_thoughts += chunk.get("content", "")
            elif chunk.get("type") == "answer":
                full_text += chunk.get("content", "")
                if current_state == "thinking":
                    db.update_chat_state(self.chat_id, "responding")
                    publish_state(self.chat_id, "responding")
                    current_state = "responding"
            

            if assistant_message_id and (full_text or full_thoughts):
                db.update_message(
                    assistant_message_id,
                    full_text,
                    thoughts=full_thoughts if full_thoughts else None
                )
            
            yield chunk
        
        db.update_chat_state(self.chat_id, "static")
        publish_state(self.chat_id, "static")
    
    
    def _process_message_background(self, message: str, provider: Optional[str] = None,
                                  model: Optional[str] = None, include_reasoning: bool = True,
                                  cancel_event: Optional[threading.Event] = None, **config_params):
        """
        Process message in background thread - writes only to DB, no HTTP streaming
        This runs independently of frontend connection state
        """
        from route.chat_route import publish_state
        
        config_params['include_reasoning'] = include_reasoning
        context, error = self._prepare_streaming_context(provider, model, **config_params)
        if error:
            logger.error(f"Background processing error for chat {self.chat_id}: {error}")
            return
        
        provider = context['provider']
        model = context['model']
        use_reasoning = context['use_reasoning']
        chat_history = context['chat_history']
        file_attachments = context['file_attachments']
        config_params = context['config_params']
 
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
        
        logger.info(f"Background processing streaming text with {provider}:{model} for chat {self.chat_id} with {len(chat_history)} previous messages and {len(file_attachments)} file attachments")
        
        try:
            if use_reasoning:
                db.update_chat_state(self.chat_id, "thinking")
                publish_state(self.chat_id, "thinking")
                current_state = "thinking"
                logger.info(f"Chat {self.chat_id} entering thinking state")
            else:
                db.update_chat_state(self.chat_id, "responding")
                publish_state(self.chat_id, "responding")
                current_state = "responding"
                logger.info(f"Chat {self.chat_id} entering responding state")
        except Exception as state_error:
            logger.error(f"Failed to set initial state for chat {self.chat_id}: {state_error}")
            current_state = "responding"
        
        for chunk in self.providers[provider].generate_text_stream(
            message, model=model, include_thoughts=use_reasoning, 
            chat_history=chat_history, file_attachments=file_attachments, **config_params
        ):
            if cancel_event and cancel_event.is_set():
                logger.info(f"[CANCEL] Chat {self.chat_id} processing cancelled, stopping stream")
                break
            
            if cancellation_manager.is_chat_cancelled(self.chat_id):
                logger.info(f"[CANCEL] Chat {self.chat_id} marked as cancelled, stopping stream")
                break
            
            if chunk.get("type") == "thoughts":
                full_thoughts += chunk.get("content", "")
                try:
                    from route.chat_route import publish_content
                    publish_content(self.chat_id, "thoughts", chunk.get("content", ""))
                except Exception as pub_error:
                    logger.warning(f"Failed to publish thoughts chunk for chat {self.chat_id}: {pub_error}")
                
            elif chunk.get("type") == "answer":
                full_text += chunk.get("content", "")
                try:
                    from route.chat_route import publish_content
                    publish_content(self.chat_id, "answer", chunk.get("content", ""))
                except Exception as pub_error:
                    logger.warning(f"Failed to publish answer chunk for chat {self.chat_id}: {pub_error}")
                
                if current_state == "thinking":
                    try:
                        db.update_chat_state(self.chat_id, "responding")
                        publish_state(self.chat_id, "responding")
                        current_state = "responding"
                    except Exception as state_error:
                        logger.warning(f"Failed to update state to responding for chat {self.chat_id}: {state_error}")
            
            if assistant_message_id and (full_text or full_thoughts):
                try:
                    db.update_message(
                        assistant_message_id,
                        full_text,
                        thoughts=full_thoughts if full_thoughts else None
                    )
                except Exception as db_error:
                    logger.error(f"Error updating message in DB for chat {self.chat_id}: {db_error}")
        
        try:
            db.update_chat_state(self.chat_id, "static")
            logger.info(f"Successfully updated DB state to 'static' for chat {self.chat_id}")
        except Exception as db_error:
            logger.critical(f"CRITICAL: Failed to mark chat {self.chat_id} as static in DB: {db_error}")
            logger.critical(f"Chat {self.chat_id} may be stuck in non-static state in DB")
        
        try:
            publish_state(self.chat_id, "static")
            # Prevent circular import
            from route.chat_route import publish_content
            publish_content(self.chat_id, "complete", "")
            logger.info(f"Background processing completed successfully for chat {self.chat_id}")
        except Exception as publish_error:
            logger.warning(f"Failed to publish completion (non-critical): {publish_error}")
    
    def start_background_processing(self, message: str, provider: Optional[str] = None,
                                  model: Optional[str] = None, include_reasoning: bool = True,
                                  attached_file_ids: List[str] = None, **config_params) -> bool:
        """
        Start background processing of a message (non-blocking)
        Returns True if started successfully, False if already running
        """
        db.save_message(self.chat_id, "user", message, attached_file_ids=attached_file_ids or [])
        
        if attached_file_ids:
            config_params['attached_file_ids'] = attached_file_ids
        return _start_background_processing(
            self.chat_id, self, message, provider, model, include_reasoning, **config_params
        )