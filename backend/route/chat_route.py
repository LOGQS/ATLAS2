# status: complete

from flask import Flask, request, jsonify, Response
import json
import queue
import time
from chat.chat import Chat, is_chat_processing, cleanup_completed_threads
from utils.config import Config
from utils.logger import get_logger
from utils.db_utils import db

logger = get_logger(__name__)

state_change_queue = queue.Queue()
content_queues = {}  # chat_id -> queue for content chunks

def publish_state(chat_id: str, state: str):
    """Publishes a chat state change to the queue."""
    state_change_queue.put({'chat_id': chat_id, 'state': state})

def publish_content(chat_id: str, chunk_type: str, content: str):
    """Publishes a content chunk to the chat's content queue."""
    if chat_id not in content_queues:
        content_queues[chat_id] = queue.Queue()
    content_queues[chat_id].put({'type': chunk_type, 'content': content})

def get_content_queue(chat_id: str):
    """Get or create content queue for a chat."""
    if chat_id not in content_queues:
        content_queues[chat_id] = queue.Queue()
        logger.info(f"Created new content queue for chat {chat_id}")
    return content_queues[chat_id]

def cleanup_content_queue(chat_id: str):
    """Clean up content queue when chat processing is complete (not just when client disconnects)."""
    if chat_id in content_queues:
        # Only cleanup if chat is not actively processing
        if not is_chat_processing(chat_id):
            # Drain the queue before deleting to prevent memory leaks
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
            resume = data.get('resume', False)
            
            if not message and not resume:
                logger.warning("Streaming chat request missing message")
                return jsonify({'error': 'Message is required'}), 400
            
            chat = Chat(chat_id=chat_id)
            
            def generate():
                """Generator for streaming response using event-driven queues"""
                yield "retry: 1500\n\n"
                yield f"data: {json.dumps({'type': 'chat_id', 'content': chat.chat_id})}\n\n"
                
                if resume:
                    # For resume, use the existing resume logic
                    for chunk in chat.resume_text_stream():
                        yield f"data: {json.dumps(chunk)}\n\n"
                else:
                    # For new messages, start background processing and stream from queue
                    success = chat.start_background_processing(
                        message=message,
                        provider=provider,
                        model=model,
                        include_reasoning=include_reasoning
                    )
                    
                    if not success:
                        # If chat is already processing, connect to existing stream
                        logger.info(f"Chat {chat_id} already processing, connecting client to ongoing stream")
                        content_queue = get_content_queue(chat_id)
                        
                        try:
                            # Send current chat state first
                            from utils.db_utils import db
                            current_state = db.get_chat_state(chat_id)
                            if current_state:
                                yield f"data: {json.dumps({'type': 'chat_state', 'chat_id': chat_id, 'state': current_state})}\n\n"
                            
                            # Check if there are queued chunks and send them in batches to prevent overwhelming
                            chunks_sent = 0
                            max_burst = 10  # Max chunks to send in rapid succession
                            
                            while True:
                                try:
                                    chunk = content_queue.get(timeout=30)
                                    
                                    if chunk['type'] == 'complete':
                                        break
                                    elif chunk['type'] == 'error':
                                        yield f"data: {json.dumps(chunk)}\n\n"
                                        break
                                    
                                    yield f"data: {json.dumps(chunk)}\n\n"
                                    chunks_sent += 1
                                    
                                    # Add small delay after burst to prevent overwhelming frontend
                                    if chunks_sent >= max_burst:
                                        chunks_sent = 0
                                        import time
                                        time.sleep(0.01)  # 10ms pause
                                    
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
                        chunks_sent = 0
                        max_burst = 10  # Max chunks to send in rapid succession
                        
                        while True:
                            try:
                                # Block until content is available (no polling)
                                chunk = content_queue.get(timeout=30)
                                
                                if chunk['type'] == 'complete':
                                    break
                                elif chunk['type'] == 'error':
                                    yield f"data: {json.dumps(chunk)}\n\n"
                                    break
                                    
                                yield f"data: {json.dumps(chunk)}\n\n"
                                chunks_sent += 1
                                
                                # Add small delay after burst to prevent overwhelming frontend
                                if chunks_sent >= max_burst:
                                    chunks_sent = 0
                                    import time
                                    time.sleep(0.01)  # 10ms pause
                                
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