# status: complete

from flask import Flask, request, jsonify, Response
import json
import queue
from threading import Lock
from chat.chat import Chat, is_chat_processing
from utils.config import Config
from utils.logger import get_logger
from utils.db_utils import db

logger = get_logger(__name__)

state_change_queue = queue.Queue()
content_queues = {} 

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

def stream_from_content_queue(chat_id: str, initial_state=None):
    """Unified generator for streaming from content queue"""
    content_queue = get_content_queue(chat_id)
    
    if initial_state:
        yield format_sse_data({'type': 'chat_state', 'chat_id': chat_id, 'state': initial_state})
    
    try:
        while True:
            try:
                chunk = content_queue.get(timeout=30)
                
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

def _subscribe():
    q = queue.Queue()
    with _sub_lock:
        _subscribers.append(q)
    return q

def _unsubscribe(q):
    with _sub_lock:
        if q in _subscribers: _subscribers.remove(q)

def _broadcast(event: dict):
    with _sub_lock:
        for q in list(_subscribers):
            try:
                q.put(event, block=False)
            except queue.Full:
                _subscribers.remove(q)

def publish_state(chat_id: str, state: str):
    """Publishes a chat state change to the queue."""
    state_change_queue.put({'chat_id': chat_id, 'state': state})
    _broadcast({"chat_id": chat_id, "type": "chat_state", "state": state})

def publish_content(chat_id: str, chunk_type: str, content: str):
    """Publishes a content chunk to the chat's content queue."""
    if chat_id not in content_queues:
        content_queues[chat_id] = queue.Queue()
    content_queues[chat_id].put({'type': chunk_type, 'content': content})
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

def get_content_queue(chat_id: str):
    """Get or create content queue for a chat."""
    if chat_id not in content_queues:
        content_queues[chat_id] = queue.Queue()
        logger.info(f"Created new content queue for chat {chat_id}")
    return content_queues[chat_id]

def cleanup_content_queue(chat_id: str):
    """Clean up content queue when chat processing is complete (not just when client disconnects)."""
    if chat_id in content_queues:
        if not is_chat_processing(chat_id):
            queue_obj = content_queues[chat_id]
            drained_count = 0
            try:
                while not queue_obj.empty():
                    queue_obj.get_nowait()
                    drained_count += 1
            except:
                pass
            
            del content_queues[chat_id]
            logger.info(f"Cleaned up content queue for completed chat {chat_id} (drained {drained_count} items)")
        else:
            logger.info(f"Keeping content queue for still-processing chat {chat_id}")


def register_chat_routes(app: Flask):
    """Register chat routes directly"""
    
    @app.route('/api/chat/state/stream')
    def chat_state_stream():
        """SSE endpoint to stream chat state changes."""
        def generate():
            yield "retry: 1000\n\n"
            while True:
                try:
                    data = state_change_queue.get(timeout=30)
                    yield format_sse_data(data)
                except queue.Empty:
                    yield ": keep-alive\n\n"
        
        return Response(generate(), mimetype='text/event-stream', headers=get_sse_headers())
    
    @app.route('/api/chat/stream/all', methods=['GET'])
    def stream_all():
        """SSE endpoint for all chat streams - single global stream"""
        def generate():
            q = _subscribe()
            try:
                yield 'event: ping\ndata: {}\n\n'
                while True:
                    ev = q.get()
                    yield format_sse_data(ev, ensure_ascii=False) 
            finally:
                _unsubscribe(q)
        return Response(generate(), mimetype='text/event-stream', headers=get_sse_headers(include_cors=True))

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
            
            if not message:
                logger.warning("Chat request missing message")
                return jsonify({'error': 'Message is required'}), 400
            
            chat = Chat(chat_id=chat_id)
            
            response = chat.generate_text(
                message=message,
                provider=provider,
                model=model,
                include_reasoning=include_reasoning
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
            
            if attached_file_ids:
                from utils.db_utils import db
                for file_id in attached_file_ids:
                    try:
                        db.associate_file_with_chat(file_id, chat_id)
                    except Exception as e:
                        logger.warning(f"Failed to associate file {file_id} with chat {chat_id}: {str(e)}")
                logger.info(f"Associated {len(attached_file_ids)} files with chat {chat_id}")
            
            if not message:
                if not is_chat_processing(chat_id):
                    logger.warning("Streaming chat request missing message and no running job")
                    return jsonify({'error': 'Message is required'}), 400
            
            chat = Chat(chat_id=chat_id)
            
            def generate():
                """Unified generator for streaming response using helper functions"""
                yield "retry: 1500\n\n"
                yield format_sse_data({'type': 'chat_id', 'content': chat.chat_id})
                
                if not message:
                    from utils.db_utils import db
                    current_state = db.get_chat_state(chat_id)
                    yield from stream_from_content_queue(chat_id, current_state)
                    return
                
                success = chat.start_background_processing(
                    message=message,
                    provider=provider,
                    model=model,
                    include_reasoning=include_reasoning,
                    attached_file_ids=attached_file_ids
                )
                
                if not success:
                    logger.info(f"Chat {chat_id} already processing, connecting client to ongoing stream")
                    from utils.db_utils import db
                    current_state = db.get_chat_state(chat_id)
                    yield from stream_from_content_queue(chat_id, current_state)
                    return
                
                yield from stream_from_content_queue(chat_id)
                cleanup_content_queue(chat_id)
                yield format_sse_data({'type': 'complete'})
            
            return Response(generate(), mimetype='text/event-stream', headers=get_sse_headers(include_cors=True))
            
        except Exception as e:
            logger.error(f"Error in stream_message: {str(e)}")
            def error_stream():
                yield format_sse_data({'type': 'error', 'content': str(e)})
            
            return Response(error_stream(), mimetype='text/event-stream', headers=get_sse_headers(include_cors=True))
    
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
        """Get available providers"""
        try:
            chat = Chat()
            providers = chat.get_available_providers()
            
            return jsonify({
                'providers': providers,
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