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
                    yield f"data: {json.dumps(data)}\n\n"
                except queue.Empty:
                    yield ": keep-alive\n\n"
        
        return Response(generate(), mimetype='text/event-stream', headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        })
    
    @app.route('/api/chat/stream/all', methods=['GET'])
    def stream_all():
        """SSE endpoint for all chat streams - single global stream"""
        def generate():
            q = _subscribe()
            try:
                yield 'event: ping\ndata: {}\n\n'
                while True:
                    ev = q.get()
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            finally:
                _unsubscribe(q)
        return Response(generate(), mimetype='text/event-stream', headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*'
        })

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
            
            if not message:
                if not is_chat_processing(chat_id):
                    logger.warning("Streaming chat request missing message and no running job")
                    return jsonify({'error': 'Message is required'}), 400
            
            chat = Chat(chat_id=chat_id)
            
            def generate():
                """Generator for streaming response using event-driven queues"""
                yield "retry: 1500\n\n"
                yield f"data: {json.dumps({'type': 'chat_id', 'content': chat.chat_id})}\n\n"
                
                if not message:
                    content_queue = get_content_queue(chat_id)
                    
                    try:
                        from utils.db_utils import db
                        current_state = db.get_chat_state(chat_id)
                        if current_state:
                            yield f"data: {json.dumps({'type': 'chat_state', 'chat_id': chat_id, 'state': current_state})}\n\n"
                        
                        while True:
                            try:
                                chunk = content_queue.get(timeout=30)
                                
                                if chunk['type'] == 'complete':
                                    yield f"data: {json.dumps(chunk)}\n\n"
                                    break
                                elif chunk['type'] == 'error':
                                    yield f"data: {json.dumps(chunk)}\n\n"
                                    break
                                
                                yield f"data: {json.dumps(chunk)}\n\n"
                                
                            except queue.Empty:
                                yield ": keep-alive\n\n"
                                
                                if not is_chat_processing(chat_id):
                                    logger.info(f"Background processing completed for chat {chat_id} while client was connected")
                                    break
                    except GeneratorExit:
                        logger.info(f"Client disconnected from ongoing stream for chat {chat_id} - backend continues")
                        pass
                    except Exception as e:
                        logger.error(f"Error connecting to ongoing stream for chat {chat_id}: {e}")
                    
                    return
                else:
                    success = chat.start_background_processing(
                        message=message,
                        provider=provider,
                        model=model,
                        include_reasoning=include_reasoning
                    )
                    
                    if not success:
                        logger.info(f"Chat {chat_id} already processing, connecting client to ongoing stream")
                        content_queue = get_content_queue(chat_id)
                        
                        try:
                            # Send current chat state first
                            from utils.db_utils import db
                            current_state = db.get_chat_state(chat_id)
                            if current_state:
                                yield f"data: {json.dumps({'type': 'chat_state', 'chat_id': chat_id, 'state': current_state})}\n\n"
                            
                            # Stream from queue without artificial delays
                            while True:
                                try:
                                    chunk = content_queue.get(timeout=30)
                                    
                                    if chunk['type'] == 'complete':
                                        yield f"data: {json.dumps(chunk)}\n\n"
                                        break
                                    elif chunk['type'] == 'error':
                                        yield f"data: {json.dumps(chunk)}\n\n"
                                        break
                                    
                                    yield f"data: {json.dumps(chunk)}\n\n"
                                    
                                except queue.Empty:
                                    yield ": keep-alive\n\n"
                                    
                                    if not is_chat_processing(chat_id):
                                        logger.info(f"Background processing completed for chat {chat_id} while client was connected")
                                        break
                        except GeneratorExit:
                            logger.info(f"Client disconnected from ongoing stream for chat {chat_id} - backend continues")
                            pass
                        except Exception as e:
                            logger.error(f"Error connecting to ongoing stream for chat {chat_id}: {e}")
                        
                        return
                    
                    # Stream from content queue (event-driven, no polling)
                    content_queue = get_content_queue(chat_id)
                    
                    try:
                        while True:
                            try:
                                # Block until content is available (no polling)
                                chunk = content_queue.get(timeout=30)
                                
                                if chunk['type'] == 'complete':
                                    yield f"data: {json.dumps(chunk)}\n\n"
                                    break
                                elif chunk['type'] == 'error':
                                    yield f"data: {json.dumps(chunk)}\n\n"
                                    break
                                    
                                yield f"data: {json.dumps(chunk)}\n\n"
                                
                            except queue.Empty:
                                # Send keep-alive if no content for 30 seconds
                                yield ": keep-alive\n\n"
                                
                                # Check if background thread is still running
                                if not is_chat_processing(chat_id):
                                    break
                    except GeneratorExit:
                        # Client disconnected - DON'T cancel background processing
                        logger.info(f"Client disconnected from chat {chat_id} stream, but background processing continues")
                        pass
                    except Exception as e:
                        logger.error(f"Error in streaming for chat {chat_id}: {e}")
                    finally:
                        # Don't clean up content queue immediately - other clients might connect
                        # Only clean up after a delay or when processing is complete
                        pass
                
                # Final cleanup only when processing is truly complete
                cleanup_content_queue(chat_id)
                yield f"data: {json.dumps({'type': 'complete'})}\n\n"
            
            return Response(
                generate(),
                mimetype='text/event-stream',
                headers={
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                    'Access-Control-Allow-Origin': '*'
                }
            )
            
        except Exception as e:
            logger.error(f"Error in stream_message: {str(e)}")
            def error_stream():
                yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
            
            return Response(
                error_stream(),
                mimetype='text/event-stream',
                headers={
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                    'Access-Control-Allow-Origin': '*'
                }
            )
    
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