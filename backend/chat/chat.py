# status: complete

import uuid
import multiprocessing
import threading
from typing import Dict, Any, Optional, Generator, List
from utils.config import get_provider_map, Config
from utils.db_utils import db
from utils.logger import get_logger
from utils.cancellation_manager import cancellation_manager

logger = get_logger(__name__)

PROCESS_TERMINATE_TIMEOUT = 1.0
PROCESS_KILL_TIMEOUT = 2.0
CANCEL_RESPONSE_TIMEOUT = 2.0
INIT_RESPONSE_TIMEOUT = 20.0
POLL_INTERVAL = 0.1

_chat_processes_lock = threading.Lock()
_chat_processes: Dict[str, multiprocessing.Process] = {}
_chat_process_connections: Dict[str, Any] = {}
_chat_process_status: Dict[str, str] = {}

def _terminate_process_safely(process: multiprocessing.Process, chat_id: str) -> None:
    """Safely terminate a process with proper error handling"""
    if not process or not process.is_alive():
        return
    
    try:
        logger.info(f"Terminating process for chat {chat_id}")
        process.terminate()
        process.join(timeout=PROCESS_TERMINATE_TIMEOUT)
        if process.is_alive():
            logger.warning(f"Force killing process for chat {chat_id}")
            process.kill()
            process.join(timeout=0.5)
    except (OSError, AttributeError) as e:
        logger.warning(f"Error terminating process for {chat_id}: {e}")
    except Exception as e:
        logger.error(f"Unexpected error during process cleanup for {chat_id}: {e}")

def _close_connection_safely(conn: Any, chat_id: str) -> None:
    """Safely close a connection with proper error handling"""
    if not conn:
        return
    
    try:
        if hasattr(conn, 'close'):
            conn.close()
    except (OSError, BrokenPipeError) as e:
        logger.debug(f"Expected error closing connection for {chat_id}: {e}")
    except Exception as e:
        logger.warning(f"Unexpected error closing connection for {chat_id}: {e}")

def get_chat_process_status(chat_id: str) -> Optional[str]:
    """Get the status of a chat's background process"""
    with _chat_processes_lock:
        return _chat_process_status.get(chat_id)

def is_chat_processing(chat_id: str) -> bool:
    """Check if a chat is currently being processed in background"""
    with _chat_processes_lock:
        status = _chat_process_status.get(chat_id)
        if status in ['completed', 'cancelled']:
            return False
            
        return (chat_id in _chat_processes and 
                _chat_processes[chat_id].is_alive() and 
                status == 'running')

def cleanup_completed_processes():
    """Clean up completed/dead processes"""
    with _chat_processes_lock:
        completed_chats = []
        for chat_id, process in list(_chat_processes.items()):
            status = _chat_process_status.get(chat_id)
            if not process.is_alive() or status in ['completed', 'cancelled']:
                completed_chats.append(chat_id)
        
        for chat_id in completed_chats:
            if chat_id in _chat_processes:
                process = _chat_processes[chat_id]
                _terminate_process_safely(process, chat_id)
                del _chat_processes[chat_id]
            if chat_id in _chat_process_connections:
                conn = _chat_process_connections[chat_id]
                _close_connection_safely(conn, chat_id)
                del _chat_process_connections[chat_id]
            _chat_process_status.pop(chat_id, None)
            cancellation_manager.cleanup_chat(chat_id)
            logger.info(f"Cleaned up completed process for chat {chat_id}")

def cancel_chat_process(chat_id: str) -> bool:
    """Cancel a running background process for a chat"""
    with _chat_processes_lock:
        if chat_id in _chat_process_connections:
            logger.info(f"Cancelling background process for chat {chat_id}")
            try:
                conn = _chat_process_connections[chat_id]
                conn.send({'command': 'cancel'})
                
                if conn.poll(CANCEL_RESPONSE_TIMEOUT):
                    response = conn.recv()
                    logger.info(f"Cancel response for {chat_id}: {response}")
                
                _chat_process_status[chat_id] = 'cancelled'
                cancellation_manager.cancel_chat(chat_id)
                return True
            except (OSError, BrokenPipeError) as e:
                logger.warning(f"Connection error sending cancel command to {chat_id}: {e}")
                if chat_id in _chat_processes:
                    process = _chat_processes[chat_id]
                    _terminate_process_safely(process, chat_id)
                return True
            except Exception as e:
                logger.error(f"Unexpected error sending cancel command to {chat_id}: {e}")
                if chat_id in _chat_processes:
                    process = _chat_processes[chat_id]
                    _terminate_process_safely(process, chat_id)
                return True
        return False


def stop_chat_process(chat_id: str) -> bool:
    """Stop a running background process for a chat and finalize the stream."""
    with _chat_processes_lock:
        process = _chat_processes.get(chat_id)
        conn = _chat_process_connections.get(chat_id)
        if not process or not conn:
            logger.info(f"Stop requested for chat {chat_id} but no active process found")
            return False
        _chat_process_status[chat_id] = 'stopping'

    logger.info(f"Stopping background process for chat {chat_id}")
    stop_ack_received = False

    try:
        conn.send({'command': 'stop'})
        if conn.poll(CANCEL_RESPONSE_TIMEOUT):
            response = conn.recv()
            stop_ack_received = True
            logger.info(f"Stop response for {chat_id}: {response}")
        else:
            logger.debug(f"No stop acknowledgement received for chat {chat_id} within timeout")
    except (OSError, BrokenPipeError) as e:
        logger.warning(f"Connection error sending stop command to {chat_id}: {e}")
    except Exception as e:
        logger.error(f"Unexpected error sending stop command to {chat_id}: {e}")

    try:
        process.join(PROCESS_TERMINATE_TIMEOUT)
    except Exception as join_error:
        logger.warning(f"Error waiting for chat process {chat_id} to stop: {join_error}")

    if process.is_alive():
        logger.info(f"Process still alive after stop request for chat {chat_id}, forcing termination")
        _terminate_process_safely(process, chat_id)

    with _chat_processes_lock:
        _chat_process_status[chat_id] = 'completed'

    try:
        db.update_chat_state(chat_id, "static")
    except Exception as state_error:
        logger.warning(f"Failed to update chat state to static for {chat_id}: {state_error}")

    try:
        from route.chat_route import publish_state, publish_content, wait_for_queue_drain
        publish_state(chat_id, "static")
        publish_content(chat_id, 'complete', '')
        if not wait_for_queue_drain(chat_id):
            logger.debug(f"Queue drain timeout while stopping chat {chat_id}")
    except Exception as publish_error:
        logger.warning(f"Failed to publish stop completion events for {chat_id}: {publish_error}")

    with _chat_processes_lock:
        _chat_processes.pop(chat_id, None)
        _chat_process_connections.pop(chat_id, None)
        _chat_process_status.pop(chat_id, None)

    _close_connection_safely(conn, chat_id)
    cancellation_manager.cleanup_chat(chat_id)

    logger.info(f"Stopped chat process for {chat_id} (ack_received={stop_ack_received})")
    return True

def is_chat_cancelled(chat_id: str) -> bool:
    """Check if a chat's processing has been cancelled"""
    return cancellation_manager.is_chat_cancelled(chat_id)

def force_cleanup_chat_process(chat_id: str):
    """Force cleanup of a specific chat's process status"""
    with _chat_processes_lock:
        if chat_id in _chat_processes:
            process = _chat_processes[chat_id]
            _terminate_process_safely(process, chat_id)
            del _chat_processes[chat_id]
        if chat_id in _chat_process_connections:
            conn = _chat_process_connections[chat_id]
            _close_connection_safely(conn, chat_id)
            del _chat_process_connections[chat_id]
        _chat_process_status.pop(chat_id, None)
        cancellation_manager.cleanup_chat(chat_id)
        logger.info(f"Force cleaned up process for chat {chat_id}")

def _prepare_background_process(chat_id: str) -> bool:
    """Check if background process can be started for chat"""
    if chat_id in _chat_processes:
        old_process = _chat_processes[chat_id]
        old_status = _chat_process_status.get(chat_id)
        
        if old_status in ['completed', 'cancelled']:
            logger.info(f"Chat {chat_id} process marked as {old_status}, cleaning up")
            cleanup_completed_processes()
        elif old_process.is_alive():
            logger.warning(f"Chat {chat_id} already has a running process, keeping existing one")
            return False
        else:
            cleanup_completed_processes()
    return True

def _initialize_chat_process(chat_id: str):
    """Initialize a new chat process - try pool first, then spawn if needed"""
    from chat.worker_pool import get_pooled_worker, get_pool
    import time

    pool = get_pool()
    if pool:
        stats = pool.get_stats()
        logger.info(f"[CHAT-INIT] Pool available for {chat_id} - ready={stats['ready_workers']}, spawning={stats['spawning_workers']}")
    else:
        logger.info(f"[CHAT-INIT] No pool available for {chat_id}, will spawn directly")

    start_time = time.time()
    pooled = get_pooled_worker(chat_id)

    is_pooled = False
    if pooled:
        process, conn = pooled
        is_pooled = True
        elapsed = time.time() - start_time
        logger.info(f"[CHAT-INIT] ✓ POOLED worker acquired for {chat_id} in {elapsed:.3f}s (ZERO SPAWN TIME!)")
    else:
        logger.warning(f"[CHAT-INIT] ✗ Pool miss for {chat_id}, falling back to direct spawn")
        from chat.chat_worker import start_chat_process
        spawn_start = time.time()
        process, conn = start_chat_process(chat_id)
        spawn_elapsed = time.time() - spawn_start
        logger.info(f"[CHAT-INIT] Direct spawn completed for {chat_id} in {spawn_elapsed:.3f}s")

    _chat_processes[chat_id] = process
    _chat_process_connections[chat_id] = conn
    _chat_process_status[chat_id] = 'starting'
    cancellation_manager.register_process(chat_id, process)
    return process, conn, is_pooled

def _configure_chat_process(conn, chat_id: str, message: str, provider: str, model: str,
                          include_reasoning: bool, attached_file_ids: List[str],
                          user_message_id: int, is_retry: bool, is_pooled: bool = False) -> bool:
    """Configure and start the chat process"""
    if is_pooled:
        logger.debug(f"[CHAT-CONFIG] Using pre-initialized pooled worker for {chat_id}")
        _chat_process_status[chat_id] = 'running'
        logger.info(f"[CHAT-CONFIG] Pooled worker ready for {chat_id}")
    else:
        if conn.poll(INIT_RESPONSE_TIMEOUT):
            init_response = conn.recv()
            if init_response and init_response.get('success'):
                _chat_process_status[chat_id] = 'running'
                logger.info(f"[CHAT-CONFIG] New worker initialized for {chat_id}")
            else:
                error = init_response.get('error', 'Unknown initialization error') if init_response else 'No response'
                logger.error(f"[CHAT-CONFIG] Failed to initialize chat process {chat_id}: {error}")
                cleanup_completed_processes()
                return False
        else:
            logger.error(f"[CHAT-CONFIG] Chat process initialization timeout for {chat_id}")
            cleanup_completed_processes()
            return False

    conn.send({
        'command': 'process',
        'chat_id': chat_id,
        'message': message,
        'provider': provider,
        'model': model,
        'include_reasoning': include_reasoning,
        'attached_file_ids': attached_file_ids,
        'user_message_id': user_message_id,
        'is_retry': is_retry
    })

    relay_thread = threading.Thread(
        target=_relay_worker_messages,
        args=(chat_id, conn),
        daemon=True
    )
    relay_thread.start()

    logger.info(f"Started background processing for chat {chat_id}")
    return True

def _start_background_processing(chat_id: str, message: str, provider: str, model: str, include_reasoning: bool, attached_file_ids: List[str], user_message_id: int, is_retry: bool = False):
    """Start background processing using multiprocessing"""
    
    with _chat_processes_lock:
        if not _prepare_background_process(chat_id):
            return False
        
        try:
            process, conn, is_pooled = _initialize_chat_process(chat_id)
            return _configure_chat_process(conn, chat_id, message, provider, model,
                                         include_reasoning, attached_file_ids,
                                         user_message_id, is_retry, is_pooled)
                
        except (OSError, IOError) as e:
            logger.error(f"System error starting chat process for {chat_id}: {str(e)}")
            cleanup_completed_processes()
            return False
        except Exception as e:
            logger.error(f"Unexpected error starting chat process for {chat_id}: {str(e)}")
            cleanup_completed_processes()
            return False


def _relay_worker_messages(chat_id: str, conn):
    """Relay messages from worker process to SSE system"""
    try:
        from route.chat_route import (
            publish_state,
            publish_content,
            publish_router_decision,
            wait_for_queue_drain,
        )

        logger.info(f"Started message relay for chat {chat_id}")

        queue_drained = False
        while True:
            try:
                if conn.poll(POLL_INTERVAL):
                    message = conn.recv()
                    message_type = message.get('type')

                    if not message_type:
                        continue

                    if message_type == 'state_update':
                        state = message.get('state')
                        if state:
                            publish_state(chat_id, state)
                            logger.debug(f"[RELAY] Published state update for {chat_id}: {state}")

                    elif message_type == 'router_decision':
                        publish_router_decision(
                            chat_id,
                            message.get('selected_route'),
                            message.get('available_routes', []),
                            message.get('selected_model')
                        )
                        logger.debug(f"[RELAY] Published router decision for {chat_id}: {message.get('selected_route')}")

                    elif message_type == 'content':
                        content_type = message.get('content_type')
                        content = message.get('content', '')
                        if content_type:
                            extras = {
                                key: value for key, value in message.items()
                                if key not in {'type', 'content_type', 'content', 'chat_id'}
                            }
                            publish_content(chat_id, content_type, content, **extras)
                            logger.debug(f"[RELAY] Published content for {chat_id}: {content_type}")

                    if message_type == 'content' and message.get('content_type') == 'complete':
                        logger.info(f"[RELAY] Processing completed for chat {chat_id}")
                        with _chat_processes_lock:
                            _chat_process_status[chat_id] = 'completed'

                        drained = wait_for_queue_drain(chat_id, timeout=0.5)
                        if not drained:
                            logger.info(f"[RELAY] No active client for {chat_id}, force clearing queue and cleaning up process")
                            from route.chat_route import content_queues, _content_queues_lock
                            with _content_queues_lock:
                                q = content_queues.get(chat_id)
                                if q:
                                    drained_count = 0
                                    try:
                                        while not q.empty():
                                            q.get_nowait()
                                            drained_count += 1
                                    except:
                                        pass
                                    logger.info(f"[RELAY] Force drained {drained_count} items from queue for {chat_id}")
                            threading.Thread(target=cleanup_completed_processes, daemon=True).start()

                        queue_drained = drained
                        break
                
                with _chat_processes_lock:
                    process = _chat_processes.get(chat_id)
                    if not process or not process.is_alive():
                        logger.info(f"[RELAY] Chat process {chat_id} ended, stopping relay")
                        break
                        
            except (OSError, EOFError) as relay_error:
                logger.warning(f"[RELAY] Connection error relaying message for {chat_id}: {str(relay_error)}")
                break
            except Exception as relay_error:
                logger.error(f"[RELAY] Unexpected error relaying message for {chat_id}: {str(relay_error)}")
                break
                
    except Exception as e:
        logger.error(f"[RELAY] Fatal error in message relay for {chat_id}: {str(e)}")
    finally:
        logger.info(f"[RELAY] Message relay stopped for {chat_id}")
        if not queue_drained:
            wait_for_queue_drain(chat_id)
        with _chat_processes_lock:
            if chat_id in _chat_process_status:
                _chat_process_status[chat_id] = 'completed'
        
        threading.Thread(target=cleanup_completed_processes, daemon=True).start()

class Chat:
    """
    Main chat class that unifies all providers and manages chat sessions
    """
    
    def __init__(self, system_prompt: Optional[str] = None, chat_id: Optional[str] = None):
        self.chat_id = chat_id or self._generate_unique_id()
        self.system_prompt = system_prompt
        
        self.providers = get_provider_map()
        
        if not self.chat_id.startswith("router_temp_"):
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
        if self.chat_id.startswith("router_temp_"):
            return []
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
        new_file_ids = config_params.pop("attached_file_ids", None) or []
        if new_file_ids:
            file_attachments = self._resolve_api_file_names(new_file_ids, provider)
        
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
        if not file_ids:
            return []
            
        from utils.db_utils import db
        resolved_names = []
        
        for fid in file_ids:
            rec = db.get_file_record(fid)
            if not rec:
                logger.warning(f"[FILE-RESOLVE] File {fid} not found in database")
                continue
                
            file_provider = rec.get('provider')
            api_file_name = rec.get('api_file_name')
            api_state = rec.get('api_state')
            
            effective_provider = file_provider or 'gemini'
            
            if effective_provider == provider and api_file_name and api_state == 'ready':
                resolved_names.append(api_file_name)
                logger.debug(f"[FILE-RESOLVE] File {fid} ({rec.get('original_name')}) resolved to {api_file_name}")
            else:
                logger.debug(f"[FILE-RESOLVE] File {fid} ({rec.get('original_name')}) not ready for {provider} - provider: '{effective_provider}', state: '{api_state}'")
        
        logger.info(f"[FILE-RESOLVE] Resolved {len(resolved_names)}/{len(file_ids)} files for {provider}")
        return resolved_names

    def generate_text(self, message: str, provider: str = "",
                     model: Optional[str] = None, include_reasoning: bool = True,
                     attached_file_ids: List[str] = None, use_router: bool = True, **config_params) -> Dict[str, Any]:
        """
        Generate text response using specified provider

        Args:
            message: User message
            provider: Provider to use
            model: Model to use
            include_reasoning: Whether to include reasoning/thoughts
            attached_file_ids: List of file IDs to attach to the user message
            use_router: Whether to use the router for model selection
            **config_params: Additional configuration parameters

        Returns:
            Dict with response, reasoning, and metadata
        """
        is_router_call = self.chat_id.startswith("router_temp_")

        if not is_router_call:
            if use_router and Config.get_default_router_state():
                from agents.roles.router import router
                chat_history = self.get_chat_history()
                selected_model = router.route_request(message, chat_history)
                model = selected_model
                logger.info(f"Router selected model: {model}")

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
        new_file_ids = attached_file_ids or config_params.get("attached_file_ids") or []
        config_params.pop("attached_file_ids", None)
        if new_file_ids:
            file_attachments = self._resolve_api_file_names(new_file_ids, provider)
        
        logger.info(f"Generating text with {provider}:{model} for chat {self.chat_id} with {len(chat_history)} previous messages and {len(file_attachments)} file attachments")
        response = self.providers[provider].generate_text(
            message, model=model, include_thoughts=use_reasoning, 
            chat_history=chat_history, file_attachments=file_attachments, **config_params
        )
        

        if response.get("text") and not is_router_call:
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
    
    
    
    def start_background_processing(self, message: str, provider: Optional[str] = None,
                                  model: Optional[str] = None, include_reasoning: bool = True,
                                  attached_file_ids: List[str] = None, **config_params) -> bool:
        """
        Start background processing of a message (non-blocking)
        Returns True if started successfully, False if already running
        """
        if provider is None:
            provider = Config.get_default_provider()
        if model is None:
            model = Config.get_default_model()
            
        is_edit_regeneration = config_params.get('is_edit_regeneration', False)
        existing_message_id = config_params.get('existing_message_id')
        
        attached_file_ids = attached_file_ids or []

        if is_edit_regeneration and existing_message_id:
            user_message_id = existing_message_id
            logger.info(f"[DUPLICATE_FIX] Edit regeneration - using existing edited message {user_message_id}")

            if not attached_file_ids:
                try:
                    files = db.get_message_files(existing_message_id)
                    attached_file_ids = [f.get('id') for f in files if f.get('id')]
                    logger.info(f"[DUPLICATE_FIX] Edit regeneration - preserved {len(attached_file_ids)} attached files from message {existing_message_id}")
                except Exception as e:
                    logger.warning(f"[DUPLICATE_FIX] Failed to load files for {existing_message_id}: {e}")

        elif config_params.get('is_retry', False):
            existing_history = db.get_chat_history(self.chat_id)
            user_message_id = None
            last_user_attached_ids = []
            for msg in reversed(existing_history):
                if msg['role'] == 'user':
                    user_message_id = msg['id']
                    try:
                        file_objs = msg.get('attachedFiles', [])
                        last_user_attached_ids = [f.get('id') for f in file_objs if f.get('id')]
                    except Exception:
                        last_user_attached_ids = []
                    break
            logger.info(f"Retry detected - reusing existing user message {user_message_id}")
            if not attached_file_ids and last_user_attached_ids:
                attached_file_ids = last_user_attached_ids
                logger.info(f"Retry preserved {len(attached_file_ids)} attached files from last user message {user_message_id}")
        else:
            user_message_id = db.save_message(self.chat_id, "user", message, attached_file_ids=attached_file_ids)
            logger.info(f"[DUPLICATE_FIX] Normal flow - created new user message {user_message_id}")
        
        return _start_background_processing(
            self.chat_id, message, provider, model, include_reasoning, 
            attached_file_ids, user_message_id, config_params.get('is_retry', False)
        )

