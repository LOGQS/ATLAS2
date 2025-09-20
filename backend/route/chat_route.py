# status: complete

from flask import Flask, request, jsonify, Response
import json
import queue
import time
from threading import Lock
from chat.chat import Chat, is_chat_processing, stop_chat_process
from utils.config import Config
from utils.logger import get_logger
from utils.db_utils import db

logger = get_logger(__name__)

DUPLICATE_WINDOW_SECONDS = 1.0
SSE_TIMEOUT_SECONDS = 30
SSE_RETRY_MS = 1500

_message_cache = {}
_message_cache_lock = Lock()

state_change_queue = queue.Queue()
content_queues = {}
_content_queues_lock = Lock()

_subscribers = []
_sub_lock = Lock()

def get_sse_headers(include_cors=False):
    """Get standardized SSE headers"""
    headers = {
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    }
    if include_cors:
        headers['Access-Control-Allow-Origin'] = '*'
    return headers

def format_sse_data(data, ensure_ascii=None):
    """Format data as SSE message"""
    if ensure_ascii is None:
        json_str = json.dumps(data)  
    else:
        json_str = json.dumps(data, ensure_ascii=ensure_ascii)
    return f"data: {json_str}\n\n"

def _is_duplicate_message(chat_id: str, message: str) -> bool:
    """Check if the message is a duplicate within the time window"""
    with _message_cache_lock:
        current_time = time.time()
        cache_key = f"{chat_id}:{message}"
        
        expired_keys = [key for key, timestamp in _message_cache.items() 
                       if current_time - timestamp > DUPLICATE_WINDOW_SECONDS]
        for key in expired_keys:
            del _message_cache[key]
        
        if cache_key in _message_cache:
            time_diff = current_time - _message_cache[cache_key]
            if time_diff <= DUPLICATE_WINDOW_SECONDS:
                logger.info(f"Duplicate message blocked for chat {chat_id}: '{message[:50]}...' (submitted {time_diff:.3f}s ago)")
                return True
        
        _message_cache[cache_key] = current_time
        return False

def stream_from_content_queue(chat_id: str, initial_state=None):
    """Unified generator for streaming from content queue"""
    content_queue = get_content_queue(chat_id)
    
    if initial_state:
        yield format_sse_data({'type': 'chat_state', 'chat_id': chat_id, 'state': initial_state})
    
    try:
        while True:
            try:
                chunk = content_queue.get(timeout=SSE_TIMEOUT_SECONDS)
                
                if chunk['type'] in ['complete', 'error']:
                    yield format_sse_data(chunk)
                    break
                
                yield format_sse_data(chunk)
                
            except queue.Empty:
                yield ": keep-alive\n\n"
                
                if not is_chat_processing(chat_id):
                    logger.info(f"Background processing completed for chat {chat_id} while client was connected")
                    break
    except GeneratorExit:
        logger.info(f"Client disconnected from stream for chat {chat_id} - backend continues")
    except Exception as e:
        logger.error(f"Error in stream for chat {chat_id}: {e}")

def create_sse_response(generator_func, include_cors=False):
    """Create standardized SSE response with proper headers"""
    return Response(
        generator_func(), 
        mimetype='text/event-stream', 
        headers=get_sse_headers(include_cors)
    )

def _subscribe():
    q = queue.Queue()
    with _sub_lock:
        _subscribers.append(q)
    return q

def _unsubscribe(q):
    with _sub_lock:
        if q in _subscribers:
            _subscribers.remove(q)

def _broadcast(event: dict):
    with _sub_lock:
        for q in list(_subscribers):
            try:
                q.put(event, block=False)
            except queue.Full:
                _subscribers.remove(q)

def get_active_streaming_chats():
    """Get all chats currently in thinking or responding state"""
    try:
        chats = db.get_all_chats()
        active_streams = []
        for chat in chats:
            if chat.get('state') and chat['state'] != 'static':
                active_streams.append({
                    'chat_id': chat['id'],
                    'state': chat['state']
                })
        return active_streams
    except Exception as e:
        logger.error(f"Error getting active streaming chats: {e}")
        return []

def publish_state(chat_id: str, state: str):
    """Publishes a chat state change to the queue."""
    state_change_queue.put({'chat_id': chat_id, 'state': state})
    _broadcast({"chat_id": chat_id, "type": "chat_state", "state": state})

def publish_content(chat_id: str, chunk_type: str, content: str):
    """Publishes a content chunk to the chat's content queue."""
    q = get_content_queue(chat_id)
    q.put({'type': chunk_type, 'content': content})
    _broadcast({"chat_id": chat_id, "type": chunk_type, "content": content})

def publish_file_state(file_id: str, api_state: str, provider: str = None, temp_id: str = None):
    """Publishes a file state change via SSE."""
    _broadcast({
        "type": "file_state",
        "file_id": file_id,
        "api_state": api_state,
        "provider": provider,
        "temp_id": temp_id
    })

def publish_router_decision(chat_id: str, selected_route: str, available_routes: list, selected_model: str):
    """Publishes a router decision event via SSE."""
    _broadcast({
        "type": "router_decision",
        "chat_id": chat_id,
        "selected_route": selected_route,
        "available_routes": available_routes,
        "selected_model": selected_model
    })

def get_content_queue(chat_id: str):
    """Get or create content queue for a chat."""
    with _content_queues_lock:
        q = content_queues.get(chat_id)
        if q is None:
            q = queue.Queue()
            content_queues[chat_id] = q
            logger.info(f"Created new content queue for chat {chat_id}")
    return q

def cleanup_content_queue(chat_id: str):
    """Clean up content queue when chat processing is complete (not just when client disconnects)."""
    if not is_chat_processing(chat_id):
        with _content_queues_lock:
            q = content_queues.pop(chat_id, None)
        if q:
            drained_count = 0
            try:
                while not q.empty():
                    q.get_nowait()
                    drained_count += 1
            except queue.Empty:
                pass
            except Exception as e:
                logger.warning(f"Error draining queue for chat {chat_id}: {e}")

            logger.info(f"Cleaned up content queue for completed chat {chat_id} (drained {drained_count} items)")
    else:
        logger.info(f"Keeping content queue for still-processing chat {chat_id}")


def register_chat_routes(app: Flask):
    """Register chat routes directly"""

    db.set_file_state_callback(publish_file_state)

    @app.route('/api/chat/state/stream')
    def chat_state_stream():
        """SSE endpoint to stream chat state changes."""
        def generate():
            yield "retry: 1000\n\n"
            while True:
                try:
                    data = state_change_queue.get(timeout=SSE_TIMEOUT_SECONDS)
                    yield format_sse_data(data)
                except queue.Empty:
                    yield ": keep-alive\n\n"
        
        return create_sse_response(generate)
    
    @app.route('/api/chat/stream/all', methods=['GET'])
    def stream_all():
        """SSE endpoint for all chat streams - single global stream"""
        def generate():
            q = _subscribe()
            try:
                yield 'event: ping\ndata: {}\n\n'

                active_streams = get_active_streaming_chats()
                for stream in active_streams:
                    logger.info(f"[SSE_RECONNECT] Emitting active stream state: chat_id={stream['chat_id']}, state={stream['state']}")
                    yield format_sse_data({
                        "chat_id": stream['chat_id'],
                        "type": "chat_state",
                        "state": stream['state']
                    }, ensure_ascii=False)

                while True:
                    ev = q.get()
                    yield format_sse_data(ev, ensure_ascii=False)
            finally:
                _unsubscribe(q)
        return create_sse_response(generate, include_cors=True)

    @app.route('/api/chat/send', methods=['POST'])
    def send_message():
        """Handle non-streaming message request"""
        try:
            data = request.get_json()
            message = data.get('message')
            chat_id = data.get('chat_id')
            provider = data.get('provider', 'gemini')
            model = data.get('model', Config.get_default_model())
            include_reasoning = data.get('include_reasoning', True)
            attached_file_ids = data.get('attached_file_ids', [])
            
            if not message:
                logger.warning("Chat request missing message")
                return jsonify({'error': 'Message is required'}), 400
            
            chat = Chat(chat_id=chat_id)
            
            response = chat.generate_text(
                message=message,
                provider=provider,
                model=model,
                include_reasoning=include_reasoning,
                attached_file_ids=attached_file_ids
            )
            
            return jsonify({
                'chat_id': chat.chat_id,
                'response': response
            })
            
        except Exception as e:
            logger.error(f"Error in send_message: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    @app.route('/api/chat/stream', methods=['POST'])
    def stream_message():
        """Handle streaming message request"""
        try:
            data = request.get_json()
            message = data.get('message')
            chat_id = data.get('chat_id')
            provider = data.get('provider', 'gemini')
            model = data.get('model', Config.get_default_model())
            include_reasoning = data.get('include_reasoning', True)
            attached_file_ids = data.get('attached_file_ids', [])
            is_retry = data.get('is_retry', False)
            existing_message_id = data.get('existing_message_id')
            is_edit_regeneration = data.get('is_edit_regeneration', False)
            
            if is_edit_regeneration and existing_message_id:
                logger.info(f"[BACKEND_STREAMING] Edit regeneration requested for message {existing_message_id}")
                try:
                    existing_msg = db.get_message(existing_message_id)
                    logger.info(f"[BACKEND_STREAMING] Database query result for {existing_message_id}: {existing_msg is not None}")
                    if existing_msg:
                        message = existing_msg.get('content')
                        logger.info(f"[DUPLICATE_FIX] Edit regeneration using existing message {existing_message_id}: {message[:50] if message else 'NO_CONTENT'}...")
                        logger.info(f"[BACKEND_STREAMING] Successfully retrieved message content: {len(message) if message else 0} chars")
                    else:
                        logger.error(f"[DUPLICATE_FIX] Existing message {existing_message_id} not found in database")
                        logger.error(f"[BACKEND_STREAMING] Database returned None for message {existing_message_id}")
                        return jsonify({'error': 'Existing message not found'}), 400
                except Exception as e:
                    logger.error(f"[BACKEND_STREAMING] Database error getting message {existing_message_id}: {str(e)}")
                    return jsonify({'error': f'Database error: {str(e)}'}), 500
            
            if not message:
                if not is_chat_processing(chat_id):
                    logger.warning("Streaming chat request missing message and no running job")
                    return jsonify({'error': 'Message is required'}), 400
            else:
                if not is_retry and not is_edit_regeneration and _is_duplicate_message(chat_id, message):
                    def duplicate_stream():
                        yield format_sse_data({'type': 'error', 'content': 'Duplicate message blocked - please wait before sending the same message again'})
                    return create_sse_response(duplicate_stream, include_cors=True)
            
            chat = Chat(chat_id=chat_id)
            
            def generate():
                """Unified generator for streaming response using helper functions"""
                logger.info(f"[BACKEND_STREAMING] Starting streaming generation for chat {chat_id}")
                logger.info(f"[BACKEND_STREAMING] Parameters: message={message[:50] if message else 'None'}..., provider={provider}, model={model}")
                logger.info(f"[BACKEND_STREAMING] Flags: is_retry={is_retry}, is_edit_regeneration={is_edit_regeneration}, existing_message_id={existing_message_id}")
                
                try:
                    yield f"retry: {SSE_RETRY_MS}\n\n"
                    yield format_sse_data({'type': 'chat_id', 'content': chat.chat_id})
                    
                    if not message:
                        logger.info(f"[BACKEND_STREAMING] No message provided, streaming from content queue")
                        current_state = db.get_chat_state(chat_id)
                        logger.info(f"[BACKEND_STREAMING] Current chat state: {current_state}")
                        yield from stream_from_content_queue(chat_id, current_state)
                        return
                    
                    logger.info(f"[BACKEND_STREAMING] Starting background processing with message: {message[:100]}...")
                    success = chat.start_background_processing(
                        message=message,
                        provider=provider,
                        model=model,
                        include_reasoning=include_reasoning,
                        attached_file_ids=attached_file_ids,
                        is_retry=is_retry,
                        existing_message_id=existing_message_id if is_edit_regeneration else None,
                        is_edit_regeneration=is_edit_regeneration
                    )
                    logger.info(f"[BACKEND_STREAMING] Background processing started successfully: {success}")
                except Exception as e:
                    logger.error(f"[BACKEND_STREAMING] Error in generate function: {str(e)}")
                    logger.error(f"[BACKEND_STREAMING] Exception type: {type(e)}")
                    logger.error(f"[BACKEND_STREAMING] Exception args: {e.args}")
                    import traceback
                    logger.error(f"[BACKEND_STREAMING] Full traceback: {traceback.format_exc()}")
                    yield format_sse_data({'type': 'error', 'content': f'Streaming error: {str(e)}'})
                    return
                
                if not success:
                    logger.info(f"Chat {chat_id} already processing, connecting client to ongoing stream")
                    current_state = db.get_chat_state(chat_id)
                    yield from stream_from_content_queue(chat_id, current_state)
                    return
                
                yield from stream_from_content_queue(chat_id)
                cleanup_content_queue(chat_id)
                yield format_sse_data({'type': 'complete'})
            
            return create_sse_response(generate, include_cors=True)
            
        except Exception as e:
            logger.error(f"Error in stream_message: {str(e)}")
            def error_stream():
                yield format_sse_data({'type': 'error', 'content': str(e)})
            
            return create_sse_response(error_stream, include_cors=True)
    

    @app.route('/api/chat/<chat_id>/stop', methods=['POST'])
    def stop_chat(chat_id: str):
        """Stop active streaming for a chat."""
        try:
            if not db.chat_exists(chat_id):
                return jsonify({'error': 'Chat not found'}), 404

            stopped = stop_chat_process(chat_id)
            if not stopped:
                return jsonify({
                    'success': False,
                    'chat_id': chat_id,
                    'message': 'No active stream to stop'
                })

            return jsonify({
                'success': True,
                'chat_id': chat_id
            })
        except Exception as e:
            logger.error(f"Error stopping chat {chat_id}: {e}")
            return jsonify({'error': str(e)}), 500
        
    @app.route('/api/chat/history/<chat_id>', methods=['GET'])
    def get_chat_history(chat_id: str):
        """Get chat history for a specific chat"""
        try:
            chat = Chat(chat_id=chat_id)
            history = chat.get_chat_history()
            
            return jsonify({
                'chat_id': chat_id,
                'history': history
            })
            
        except Exception as e:
            logger.error(f"Error getting chat history: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    @app.route('/api/chat/providers', methods=['GET'])
    def get_providers():
        """Get available providers with their file size limits"""
        try:
            chat = Chat()
            providers_availability = chat.get_available_providers()

            providers_info = {}
            for provider_name, is_available in providers_availability.items():
                provider_info = {
                    'available': is_available,
                    'fileSizeLimit': None
                }

                if is_available and provider_name in chat.providers:
                    provider_instance = chat.providers[provider_name]
                    if hasattr(provider_instance, 'get_file_size_limit'):
                        try:
                            provider_info['fileSizeLimit'] = provider_instance.get_file_size_limit()
                        except Exception as e:
                            logger.warning(f"Could not get file size limit for {provider_name}: {e}")

                providers_info[provider_name] = provider_info

            return jsonify({
                'providers': providers_info,
                'default_provider': 'gemini'
            })

        except Exception as e:
            logger.error(f"Error getting providers: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    @app.route('/api/chat/models', methods=['GET'])
    def get_models():
        """Get available models from all providers"""
        try:
            chat = Chat()
            models = chat.get_all_available_models()
            
            return jsonify({
                'models': models,
                'default_model': Config.get_default_model()
            })
            
        except Exception as e:
            logger.error(f"Error getting models: {str(e)}")
            return jsonify({'error': str(e)}), 500