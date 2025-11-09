# status: complete

from flask import Flask, request, jsonify, Response
import json
import queue
import time
import threading
from threading import Lock
from collections import deque
from chat.chat import Chat, is_chat_processing, stop_chat_process, send_domain_tool_decision, send_workspace_selected
from utils.config import Config
from utils.logger import get_logger
from utils.db_utils import db
from typing import Optional, Dict, Any, List

logger = get_logger(__name__)

DUPLICATE_WINDOW_SECONDS = 1.0
SSE_TIMEOUT_SECONDS = 30
SSE_RETRY_MS = 1500
TERMINAL_EVENT_POLL_SECONDS = 0.1
QUEUE_DRAIN_TIMEOUT_SECONDS = 2.0
QUEUE_IDLE_GRACE_SECONDS = 0.05
QUEUE_DRAIN_POLL_SECONDS = 0.01
QUEUE_DRAIN_STATUS_LOG_SECONDS = 1.0

_message_cache = {}
_message_cache_lock = Lock()

state_change_queue = queue.Queue()
content_queues = {}
_content_queues_lock = Lock()

_subscribers = []
_sub_lock = Lock()

BACKLOG_EVENT_LIMIT = 500
_backlog_events = deque()
_backlog_lock = Lock()


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

    terminal_chunk = None

    try:
        while True:
            try:
                timeout = TERMINAL_EVENT_POLL_SECONDS if terminal_chunk else SSE_TIMEOUT_SECONDS
                chunk = content_queue.get(timeout=timeout)

                chunk_type = chunk.get('type')
                if chunk_type in ['complete', 'error']:
                    terminal_chunk = chunk
                    continue

                yield format_sse_data(chunk)

            except queue.Empty:
                if terminal_chunk:
                    wait_for_queue_drain(chat_id, timeout=1.0)
                    yield format_sse_data(terminal_chunk)
                    break

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

    backlog = _drain_backlog_events()
    if backlog:
        logger.info(f'[SSE] Replaying {len(backlog)} backlog event(s) to new subscriber')
        for event in backlog:
            try:
                q.put_nowait(event)
            except queue.Full:
                logger.warning('[SSE] Subscriber queue full while replaying backlog; dropping remaining events')
                break
    return q

def _unsubscribe(q):
    with _sub_lock:
        if q in _subscribers:
            _subscribers.remove(q)

def _store_backlog_event(event: dict) -> None:
    with _backlog_lock:
        _backlog_events.append(event.copy())
        if len(_backlog_events) > BACKLOG_EVENT_LIMIT:
            _backlog_events.popleft()
    chat_label = event.get('chat_id') or 'global'
    logger.debug(f'[SSE] Stored backlog event for {chat_label}')


def _drain_backlog_events() -> list[dict]:
    with _backlog_lock:
        if not _backlog_events:
            return []
        drained = list(_backlog_events)
        _backlog_events.clear()
    if drained:
        logger.debug(f'[SSE] Drained {len(drained)} backlog event(s) for replay')
    return drained

def _broadcast(event: dict):
    event_type = event.get('type', 'unknown')
    chat_id = event.get('chat_id', 'global')
    high_volume_event = event_type in {'coder_stream', 'coder_file_operation'}

    with _sub_lock:
        if not _subscribers:
            logger.warning(f'[SSE_BROADCAST] No subscribers for {event_type} event (chat: {chat_id}), storing in backlog')
            _store_backlog_event(event)
            return
        subscribers_snapshot = list(_subscribers)
        if not high_volume_event:
            logger.debug(f'[SSE_BROADCAST] Broadcasting {event_type} event to {len(subscribers_snapshot)} subscriber(s) (chat: {chat_id})')

    delivered = False
    to_remove = []
    for q in subscribers_snapshot:
        try:
            q.put_nowait(event)
            delivered = True
        except queue.Full:
            to_remove.append(q)

    if to_remove:
        with _sub_lock:
            for q in to_remove:
                if q in _subscribers:
                    _subscribers.remove(q)
        logger.warning(f'[SSE] Removed {len(to_remove)} stale subscriber(s) with full queues')

    if delivered:
        if not high_volume_event:
            logger.debug(f'[SSE_BROADCAST] Successfully delivered {event_type} event (chat: {chat_id})')
    else:
        logger.warning(f'[SSE_BROADCAST] Failed to deliver {event_type} event (chat: {chat_id}), storing in backlog')
        _store_backlog_event(event)


def broadcast_global_event(event: dict) -> None:
    """Expose broadcasting for subsystems that share the SSE stream."""
    _broadcast(event)

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

def publish_content(chat_id: str, chunk_type: str, content: str, **metadata):
    """Publishes a content chunk to the chat's content queue."""
    payload = {"type": chunk_type, "content": content}
    if metadata:
        payload.update({k: v for k, v in metadata.items() if v is not None})

    q = get_content_queue(chat_id)
    q.put(payload)

    broadcast_payload = {"chat_id": chat_id, "type": chunk_type, "content": content}
    if metadata:
        broadcast_payload.update({k: v for k, v in metadata.items() if v is not None})

    _broadcast(broadcast_payload)

def wait_for_queue_drain(chat_id: str,
                         timeout: Optional[float] = QUEUE_DRAIN_TIMEOUT_SECONDS,
                         idle_grace: float = QUEUE_IDLE_GRACE_SECONDS,
                         status_log_interval: Optional[float] = QUEUE_DRAIN_STATUS_LOG_SECONDS) -> bool:
    """Wait for a chat's content queue to drain to avoid race conditions."""
    with _content_queues_lock:
        q = content_queues.get(chat_id)

    if not q:
        return True

    start_time = time.time()
    last_non_empty = start_time
    last_status_log = start_time
    status_logged = False

    while True:
        current_time = time.time()

        if q.empty():
            if current_time - last_non_empty >= idle_grace:
                if timeout is None and status_logged:
                    logger.debug(
                        f"Queue drain completed for chat {chat_id} after {current_time - start_time:.3f}s"
                    )
                return True
        else:
            last_non_empty = current_time

        if timeout is not None and current_time - start_time >= timeout:
            logger.debug(f"Queue drain timeout for chat {chat_id} (queue may still contain pending items)")
            return False

        if (timeout is None and status_log_interval is not None and
                current_time - last_status_log >= status_log_interval):
            logger.debug(
                f"Waiting for content queue to drain for chat {chat_id} "
                f"({current_time - start_time:.3f}s elapsed)"
            )
            last_status_log = current_time
            status_logged = True

        time.sleep(QUEUE_DRAIN_POLL_SECONDS)

def publish_file_state(file_id: str, api_state: str, provider: str = None, temp_id: str = None):
    """Publishes a file state change via SSE."""
    _broadcast({
        "type": "file_state",
        "file_id": file_id,
        "api_state": api_state,
        "provider": provider,
        "temp_id": temp_id
    })

def publish_router_decision(chat_id: str, selected_route: str, available_routes: list, selected_model: str,
                           tools_needed=None, execution_type=None, fastpath_params=None, error=None):
    """Publishes a router decision event via SSE."""
    payload = {
        "type": "router_decision",
        "chat_id": chat_id,
        "selected_route": selected_route,
        "available_routes": available_routes,
        "selected_model": selected_model,
        "tools_needed": tools_needed,
        "execution_type": execution_type,
        "fastpath_params": fastpath_params,
        "error": error
    }
    if error:
        logger.warning(f"[SSE_BROADCAST] Router decision payload with error: route={selected_route}, error={error}")
    else:
        logger.info(f"[SSE_BROADCAST] Router decision payload: route={selected_route}, tools_needed={tools_needed}, execution_type={execution_type}")
    _broadcast(payload)

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



def _prepare_user_message_for_agentic(chat: Chat, message: str, attached_file_ids: List[str],
                                       is_retry: bool, existing_message_id: Optional[str],
                                       is_edit_regeneration: bool, router_info: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    attached_file_ids = attached_file_ids or []

    if is_edit_regeneration and existing_message_id:
        user_message_id = existing_message_id
        if not attached_file_ids:
            try:
                files = db.get_message_files(existing_message_id)
                attached_file_ids = [f.get('id') for f in files if f.get('id')]
            except Exception as exc:
                logger.warning(f"Failed to load files for {existing_message_id}: {exc}")
    elif is_retry:
        existing_history = db.get_chat_history(chat.chat_id)
        user_message_id = None
        preserved_ids: List[str] = []
        for msg in reversed(existing_history):
            if msg.get('role') == 'user':
                user_message_id = msg.get('id')
                preserved_ids = [f.get('id') for f in msg.get('attachedFiles', []) if f.get('id')]
                break
        if not attached_file_ids and preserved_ids:
            attached_file_ids = preserved_ids
    else:
        router_enabled = router_info is not None
        router_decision = None
        if router_info:
            import json
            router_decision = json.dumps({
                'route': router_info['route'],
                'available_routes': router_info['available_routes'],
                'selected_model': router_info['model'],
                'selected_provider': router_info['provider']
            })
        user_message_id = db.save_message(
            chat.chat_id,
            'user',
            message,
            attached_file_ids=attached_file_ids,
            router_enabled=router_enabled,
            router_decision=router_decision
        )

    return {
        'user_message_id': user_message_id,
        'attached_file_ids': attached_file_ids
    }


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

    @app.route('/api/chats/<chat_id>/domain/<task_id>/tool/<call_id>/decision', methods=['POST'])
    def domain_tool_decision(chat_id: str, task_id: str, call_id: str):
        """Handle user accept/reject decisions for domain tool calls."""
        try:
            payload = request.get_json() or {}
            decision = (payload.get('decision') or '').lower()
            assistant_message_id = payload.get('assistant_message_id')
            batch_mode = payload.get('batch_mode', True)  # Default to batch mode
            pre_executed_calls = payload.get('pre_executed_calls', {})  # Map of call_id -> bool
            pre_execution_state = payload.get('pre_execution_state', {})  # Map of call_id -> state

            pre_exec_count = sum(1 for v in pre_executed_calls.values() if v)
            logger.info(f"[ROUTE][PRE-EXEC] Received {decision} for task {task_id}: {pre_exec_count}/{len(pre_executed_calls)} tools pre-executed, {len(pre_execution_state)} revert states")

            if decision not in {'accept', 'reject'}:
                return jsonify({'success': False, 'error': "decision must be 'accept' or 'reject'"}), 400

            response = send_domain_tool_decision(
                chat_id=chat_id,
                task_id=task_id,
                call_id=call_id,
                decision=decision,
                assistant_message_id=assistant_message_id,
                batch_mode=batch_mode,
                pre_executed_calls=pre_executed_calls,
                pre_execution_state=pre_execution_state
            )
            status_code = 200 if response.get('success') else 400
            return jsonify(response), status_code
        except Exception as e:
            import traceback
            logger.error(f"[DOMAIN_TOOL_DECISION] Error processing decision for {chat_id}/{task_id}/{call_id}: {str(e)}")
            logger.error(f"[DOMAIN_TOOL_DECISION] Traceback: {traceback.format_exc()}")
            return jsonify({'success': False, 'error': f'Internal server error: {str(e)}'}), 500

    @app.route('/api/chats/<chat_id>/workspace_selected', methods=['POST'])
    def workspace_selected_notification(chat_id: str):
        """Notify worker that workspace has been selected."""
        response = send_workspace_selected(chat_id=chat_id)
        status_code = 200 if response.get('success') else 400
        return jsonify(response), status_code

    @app.route('/api/chat/send', methods=['POST'])
    def send_message():
        """Handle non-streaming message request"""
        try:
            data = request.get_json()
            message = data.get('message')
            chat_id = data.get('chat_id')
            provider = data.get('provider', Config.get_default_provider())
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
            provider = data.get('provider', Config.get_default_provider())
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

            router_info: Optional[Dict[str, Any]] = None
            if message and Config.get_default_router_state():
                try:
                    from agents.roles.router import router as route_agent
                    chat_history = chat.get_chat_history()
                    router_info = route_agent.route_request(message, chat_history)
                    router_error = router_info.get('error')
                    if router_error:
                        logger.warning(f"[ROUTE_HANDLER_ROUTER] Router returned with error for {chat.chat_id}: {router_error}, falling back to default")
                    else:
                        logger.info(f"[ROUTE_HANDLER_ROUTER] Router returned for {chat.chat_id}: route={router_info.get('route')}, tools_needed={router_info.get('tools_needed')} (type: {type(router_info.get('tools_needed'))})")
                    publish_router_decision(
                        chat.chat_id,
                        router_info.get('route'),
                        router_info.get('available_routes', []),
                        router_info.get('model'),
                        router_info.get('tools_needed'),
                        router_info.get('execution_type'),
                        router_info.get('fastpath_params'),
                        router_error
                    )
                    if router_info.get('provider'):
                        provider = router_info.get('provider')
                    if router_info.get('model'):
                        model = router_info.get('model')
                except Exception as router_exc:
                    logger.error(f"[BACKEND_STREAMING] Router preflight failed: {router_exc}")
                    router_info = None

            def generate():
                """Unified generator for streaming response using helper functions"""
                logger.info(f"[BACKEND_STREAMING] Starting streaming generation for chat {chat_id}")
                logger.info(f"[UX_PERF][BACKEND] stream_request_received chat={chat_id} message_len={len(message or '')}")
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
                        is_edit_regeneration=is_edit_regeneration,
                        router_override=router_info
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
                'default_provider': Config.get_default_provider()
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

    # Web Browser Profile Management Routes
    @app.route('/api/web/profile/status', methods=['GET'])
    def get_web_profile_status():
        """Get current browser profile status"""
        try:
            from agents.tools.web_ops import get_profile_status

            status = get_profile_status()
            return jsonify(status)

        except Exception as e:
            logger.error(f"Error getting profile status: {str(e)}")
            return jsonify({'error': str(e)}), 500

    @app.route('/api/web/profile/setup', methods=['POST'])
    def launch_web_profile_setup():
        """Launch browser profile setup wizard"""
        try:
            from agents.tools.web_ops import launch_profile_setup

            result = launch_profile_setup()

            if result.get('success'):
                return jsonify(result), 200
            else:
                return jsonify(result), 500

        except Exception as e:
            logger.error(f"Error launching profile setup: {str(e)}")
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    @app.route('/api/web/profiles', methods=['GET'])
    def list_web_profiles():
        """List all available browser profiles"""
        try:
            from agents.tools.web_ops import get_profile_dir
            from pathlib import Path

            managed_browser_dir = get_profile_dir().parent
            profiles = []

            if managed_browser_dir.exists():
                for profile_path in managed_browser_dir.iterdir():
                    if profile_path.is_dir():
                        # Count files to determine if valid
                        try:
                            file_count = sum(1 for _ in profile_path.rglob('*') if _.is_file())
                            is_valid = file_count > 0
                        except Exception:
                            file_count = 0
                            is_valid = False

                        profiles.append({
                            'name': profile_path.name,
                            'path': str(profile_path),
                            'file_count': file_count,
                            'valid': is_valid,
                            'is_default': profile_path.name == 'google_serp'
                        })

            return jsonify({
                'profiles': profiles,
                'count': len(profiles)
            })

        except Exception as e:
            logger.error(f"Error listing profiles: {str(e)}")
            return jsonify({'error': str(e)}), 500

    @app.route('/api/web/profiles/<profile_name>', methods=['DELETE'])
    def delete_web_profile(profile_name: str):
        """Delete a browser profile"""
        try:
            from agents.tools.web_ops import get_profile_dir
            import shutil

            # Security: Prevent directory traversal
            if '..' in profile_name or '/' in profile_name or '\\' in profile_name:
                return jsonify({
                    'success': False,
                    'error': 'Invalid profile name'
                }), 400

            # Prevent deletion of default profile if it's the only one
            if profile_name == 'google_serp':
                return jsonify({
                    'success': False,
                    'error': 'Cannot delete default profile'
                }), 400

            managed_browser_dir = get_profile_dir().parent
            profile_path = managed_browser_dir / profile_name

            if not profile_path.exists():
                return jsonify({
                    'success': False,
                    'error': f'Profile "{profile_name}" not found'
                }), 404

            # Ensure it's a subdirectory of managed_browser
            if not str(profile_path).startswith(str(managed_browser_dir)):
                return jsonify({
                    'success': False,
                    'error': 'Invalid profile path'
                }), 400

            shutil.rmtree(profile_path)
            logger.info(f"Deleted browser profile: {profile_name}")

            return jsonify({
                'success': True,
                'message': f'Profile "{profile_name}" deleted successfully'
            })

        except Exception as e:
            logger.error(f"Error deleting profile {profile_name}: {str(e)}")
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500
