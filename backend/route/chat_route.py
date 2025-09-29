# status: complete

from flask import Flask, request, jsonify, Response
import json
import queue
import time
import threading
from threading import Lock
from collections import deque
from chat.chat import Chat, is_chat_processing, stop_chat_process
from utils.config import Config
from utils.logger import get_logger
from utils.db_utils import db
from agentic import AgenticService
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
agentic_service = AgenticService()

_plan_event_subscribers = []
_plan_event_lock = Lock()
_plan_event_backlog = deque(maxlen=BACKLOG_EVENT_LIMIT)


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
    with _sub_lock:
        if not _subscribers:
            _store_backlog_event(event)
            return
        subscribers_snapshot = list(_subscribers)

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

    if not delivered:
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

def publish_router_decision(chat_id: str, selected_route: str, available_routes: list, selected_model: str):
    """Publishes a router decision event via SSE."""
    _broadcast({
        "type": "router_decision",
        "chat_id": chat_id,
        "selected_route": selected_route,
        "available_routes": available_routes,
        "selected_model": selected_model
    })

def _subscribe_plan_events():
    q = queue.Queue()
    with _plan_event_lock:
        _plan_event_subscribers.append(q)
    return q


def _unsubscribe_plan_events(q):
    with _plan_event_lock:
        if q in _plan_event_subscribers:
            _plan_event_subscribers.remove(q)


def _broadcast_plan_event(event: Dict[str, Any]):
    with _plan_event_lock:
        _plan_event_backlog.append(event)
        for subscriber in list(_plan_event_subscribers):
            subscriber.put(event)


def _emit_plan_event(chat_id: str, plan_id: str, event_type: str, payload: Dict[str, Any]):
    event = dict(payload or {})
    event['type'] = event_type
    event['chat_id'] = chat_id
    event['plan_id'] = plan_id
    _broadcast_plan_event(event)

def _build_plan_summary(plan_dict: Dict[str, Any], status: Optional[str] = None) -> Dict[str, Any]:
    """Prepare plan payload for SSE consumers."""
    try:
        safe_plan = json.loads(json.dumps(plan_dict)) if plan_dict else {}
    except (TypeError, ValueError):
        safe_plan = dict(plan_dict or {})
    tasks = safe_plan.get('tasks') or {}
    summary = {
        'plan_id': safe_plan.get('plan_id'),
        'base_ctx_id': safe_plan.get('base_ctx_id'),
        'version': safe_plan.get('version'),
        'metadata': safe_plan.get('metadata', {}),
        'tasks': tasks,
        'task_count': len(tasks),
        'task_ids': list(tasks.keys()),
    }
    if status:
        summary['status'] = status
    return summary



def _broadcast_taskflow_plan(chat_id: str, plan_id: str, fingerprint: str, plan_summary: Dict[str, Any], status: Optional[str] = None, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload_plan = dict(plan_summary or {})
    if status:
        payload_plan['status'] = status
    message = {
        'chat_id': chat_id,
        'type': 'taskflow_plan',
        'plan_id': plan_id,
        'fingerprint': fingerprint,
        'plan': payload_plan,
    }
    if status:
        message['status'] = status
    if extra:
        for key, value in extra.items():
            if value is not None:
                message[key] = value
    _broadcast(message)
    return payload_plan



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
                                       is_edit_regeneration: bool) -> Dict[str, Any]:
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
        user_message_id = db.save_message(chat.chat_id, 'user', message, attached_file_ids=attached_file_ids)

    return {
        'user_message_id': user_message_id,
        'attached_file_ids': attached_file_ids
    }

def handle_taskflow_stream(chat: Chat, message: str, router_info: Optional[Dict[str, Any]],
                         attached_file_ids: List[str], is_retry: bool,
                         existing_message_id: Optional[str], is_edit_regeneration: bool):
    """Streaming handler for taskflow route."""

    def generate():
        yield f"retry: {SSE_RETRY_MS}\n\n"
        yield format_sse_data({'type': 'chat_id', 'content': chat.chat_id})

        if not message:
            yield format_sse_data({'type': 'error', 'content': 'Message is required for taskflow route'})
            return

        try:
            message_info = _prepare_user_message_for_agentic(
                chat,
                message,
                attached_file_ids,
                is_retry,
                existing_message_id,
                is_edit_regeneration
            )
            attached_ids = message_info['attached_file_ids']
            logger.info(f"[TASKFLOW] Prepared user message with {len(attached_ids)} attached files")
        except Exception as exc:
            logger.error(f"Taskflow preparation failed: {exc}")
            yield format_sse_data({'type': 'error', 'content': str(exc)})
            return

        db.update_chat_state(chat.chat_id, 'thinking')
        publish_state(chat.chat_id, 'thinking')

        try:
            logger.info(f"[TASKFLOW] Generating plan for chat {chat.chat_id}")
            plan = agentic_service.generate_plan(chat.chat_id, message)
            logger.info(f"[TASKFLOW] Plan generated successfully: {plan.plan_id}")
            plan_dict = plan.to_dict()
            fingerprint = plan.fingerprint()
            plan_summary = _build_plan_summary(plan_dict, status='PENDING_APPROVAL')
            logger.info(f"[TASKFLOW] Plan serialization complete, fingerprint: {fingerprint[:8]}")
        except Exception as plan_exc:
            logger.error(f"[TASKFLOW] Plan generation failed: {plan_exc}")
            yield format_sse_data({'type': 'error', 'content': f'Plan generation failed: {str(plan_exc)}'})
            return

        # Emit plan event for separate SSE endpoint (optional)
        try:
            _emit_plan_event(chat.chat_id, plan.plan_id, 'plan_created', {'plan': plan_summary, 'fingerprint': fingerprint, 'status': 'PENDING_APPROVAL'})
        except Exception as emit_exc:
            logger.warning(f"[TASKFLOW] Plan event emission failed: {emit_exc}")

        # Send plan via main chat stream (primary method)
        logger.info(f"[TASKFLOW] Sending taskflow_plan event via SSE for plan {plan.plan_id}")
        try:
            sse_plan = _broadcast_taskflow_plan(
                chat.chat_id,
                plan.plan_id,
                fingerprint,
                plan_summary,
                status='PENDING_APPROVAL'
            )

            yield format_sse_data({
                'type': 'taskflow_plan',
                'plan_id': plan.plan_id,
                'fingerprint': fingerprint,
                'plan': sse_plan,
                'status': 'PENDING_APPROVAL'
            })
            logger.info(f"[TASKFLOW] taskflow_plan event sent successfully")
        except Exception as sse_exc:
            logger.error(f"[TASKFLOW] Failed to send taskflow_plan event: {sse_exc}")
            yield format_sse_data({'type': 'error', 'content': f'Plan display failed: {str(sse_exc)}'})
            return

        # Set chat state to waiting for approval
        logger.info(f"[TASKFLOW] Setting chat {chat.chat_id} to static state")
        db.update_chat_state(chat.chat_id, 'static')
        publish_state(chat.chat_id, 'static')

        # End stream - waiting for user approval via separate API endpoints
        logger.info(f"[TASKFLOW] Sending plan_pending_approval event for plan {plan.plan_id}")
        yield format_sse_data({
            'type': 'plan_pending_approval',
            'plan_id': plan.plan_id,
            'message': 'Plan generated. Waiting for approval.'
        })

        logger.info(f"[TASKFLOW] Completing SSE stream for chat {chat.chat_id}")
        yield format_sse_data({'type': 'complete'})

    return create_sse_response(generate, include_cors=True)


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

    @app.route('/sse/plan_events')
    def plan_events_stream():
        """SSE endpoint for plan execution events."""
        chat_filter = request.args.get('chat_id')
        plan_filter = request.args.get('plan_id')

        def generate():
            q = _subscribe_plan_events()
            try:
                with _plan_event_lock:
                    for event in list(_plan_event_backlog):
                        if chat_filter and event.get('chat_id') != chat_filter:
                            continue
                        if plan_filter and event.get('plan_id') != plan_filter:
                            continue
                        yield format_sse_data(event)
                while True:
                    try:
                        event = q.get(timeout=SSE_TIMEOUT_SECONDS)
                    except queue.Empty:
                        yield ': keep-alive\n\n'
                        continue
                    if chat_filter and event.get('chat_id') != chat_filter:
                        continue
                    if plan_filter and event.get('plan_id') != plan_filter:
                        continue
                    yield format_sse_data(event)
            finally:
                _unsubscribe_plan_events(q)

        return create_sse_response(generate, include_cors=True)

    @app.route('/api/chats/<chat_id>/plan/<plan_id>/approve', methods=['POST'])
    def approve_agentic_plan(chat_id: str, plan_id: str):
        """Approve a plan and optionally execute it."""
        payload = request.get_json() or {}
        auto_execute = payload.get('auto_execute', True)

        record = agentic_service.get_plan_record(plan_id)
        if not record or record.get('chat_id') != chat_id:
            return jsonify({'error': 'Plan not found'}), 404

        already_approved = record.get('status') == 'APPROVED'
        updated_record = record
        if not already_approved:
            updated = agentic_service.update_plan_status(plan_id, 'APPROVED')
            if updated:
                updated_record = updated

        plan_dict = dict(updated_record.get('ir') or {})
        plan_dict.setdefault('plan_id', plan_id)
        plan_dict.setdefault('base_ctx_id', updated_record.get('base_ctx_id'))
        fingerprint = updated_record.get('fingerprint', '')
        plan_summary = _build_plan_summary(plan_dict, status='APPROVED')

        _emit_plan_event(chat_id, plan_id, 'plan_approved', {
            'plan': plan_summary,
            'fingerprint': fingerprint,
            'status': 'APPROVED'
        })
        _broadcast_taskflow_plan(chat_id, plan_id, fingerprint, plan_summary, status='APPROVED')

        response = {'plan_id': plan_id, 'status': 'APPROVED'}
        if already_approved and not payload.get('force', False):
            return jsonify(response)

        if not auto_execute:
            return jsonify(response)

        def run_execution():
            emitter = agentic_service.build_event_emitter()
            emitter.subscribe(lambda event_type, data: _emit_plan_event(chat_id, plan_id, event_type, data))
            try:
                publish_state(chat_id, 'thinking')
                execution = agentic_service.execute_plan(chat_id, plan_id, events=emitter)
                final_output = execution.get('final_output')
                final_task_id = execution.get('final_task_id')
                _emit_plan_event(chat_id, plan_id, 'execution_complete', {
                    'final_output': final_output,
                    'final_task_id': final_task_id
                })
                extra = {'final_output': final_output} if final_output else None
                _broadcast_taskflow_plan(chat_id, plan_id, fingerprint, plan_summary, status='COMPLETED', extra=extra)
                if final_output:
                    publish_state(chat_id, 'responding')
                    publish_content(
                        chat_id,
                        'answer',
                        final_output,
                        message_id=execution.get('assistant_message_id'),
                        provider=execution.get('final_provider'),
                        model=execution.get('final_model'),
                        plan_id=plan_id
                    )
                publish_state(chat_id, 'static')
            except Exception as exc:
                logger.error(f"[TASKFLOW] Plan execution failed: {exc}")
                error_message = str(exc)
                _emit_plan_event(chat_id, plan_id, 'execution_failed', {'error': error_message})
                _broadcast_taskflow_plan(chat_id, plan_id, fingerprint, plan_summary, status='FAILED', extra={'error': error_message})
                publish_state(chat_id, 'static')

        threading.Thread(target=run_execution, name=f'plan-exec-{plan_id}', daemon=True).start()
        return jsonify(response)

    @app.route('/api/chats/<chat_id>/plan/<plan_id>/deny', methods=['POST'])
    def deny_agentic_plan(chat_id: str, plan_id: str):
        """Deny a generated plan and keep chat static."""
        payload = request.get_json() or {}
        record = agentic_service.get_plan_record(plan_id)
        if not record or record.get('chat_id') != chat_id:
            return jsonify({'error': 'Plan not found'}), 404

        if record.get('status') == 'DENIED':
            return jsonify({'plan_id': plan_id, 'status': 'DENIED'})

        updated = agentic_service.update_plan_status(plan_id, 'DENIED')
        plan_record = updated or record

        plan_dict = dict(plan_record.get('ir') or {})
        plan_dict.setdefault('plan_id', plan_id)
        plan_dict.setdefault('base_ctx_id', plan_record.get('base_ctx_id'))
        fingerprint = plan_record.get('fingerprint', '')
        plan_summary = _build_plan_summary(plan_dict, status='DENIED')
        reason = payload.get('reason')

        event_payload = {
            'plan': plan_summary,
            'fingerprint': fingerprint,
            'status': 'DENIED'
        }
        if reason:
            event_payload['reason'] = reason

        _emit_plan_event(chat_id, plan_id, 'plan_denied', event_payload)
        _broadcast_taskflow_plan(chat_id, plan_id, fingerprint, plan_summary, status='DENIED', extra={'reason': reason} if reason else None)

        publish_state(chat_id, 'static')
        return jsonify({'plan_id': plan_id, 'status': 'DENIED'})

    @app.route('/api/chats/<chat_id>/plan', methods=['POST'])
    def create_agentic_plan(chat_id: str):
        """Generate and persist a plan for a chat."""
        data = request.get_json() or {}
        message = data.get('message')
        if not message:
            return jsonify({'error': 'Message is required'}), 400
        plan = agentic_service.generate_plan(chat_id, message)
        return jsonify({'plan': plan.to_dict(), 'fingerprint': plan.fingerprint()})

    @app.route('/api/chats/<chat_id>/execute', methods=['POST'])
    def execute_agentic_plan(chat_id: str):
        """Execute a stored plan immediately."""
        data = request.get_json() or {}
        plan_id = data.get('plan_id')
        if not plan_id:
            return jsonify({'error': 'plan_id is required'}), 400
        emitter = agentic_service.build_event_emitter()
        emitter.subscribe(lambda event_type, payload: _emit_plan_event(chat_id, plan_id, event_type, payload))
        result = agentic_service.execute_plan(chat_id, plan_id, events=emitter)
        return jsonify(result)

    @app.route('/api/chats/<chat_id>/context/<ctx_id>', methods=['GET'])
    def get_context_snapshot_endpoint(chat_id: str, ctx_id: str):
        """Return a specific context snapshot for a chat."""
        snapshot = agentic_service.get_context_snapshot(chat_id, ctx_id)
        if not snapshot:
            return jsonify({'error': 'Context snapshot not found'}), 404
        return jsonify(snapshot)

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
                    publish_router_decision(chat.chat_id, router_info.get('route'), router_info.get('available_routes', []), router_info.get('model'))
                    if router_info.get('route') == 'taskflow':
                        return handle_taskflow_stream(chat, message, router_info, attached_file_ids, is_retry, existing_message_id, is_edit_regeneration)
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