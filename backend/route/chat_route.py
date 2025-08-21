# status: complete

from flask import Flask, request, jsonify, Response
import json
from chat.chat import Chat
from utils.config import Config
from utils.logger import get_logger

logger = get_logger(__name__)


def register_chat_routes(app: Flask):
    """Register chat routes directly"""
    
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
                logger.warning("Streaming chat request missing message")
                return jsonify({'error': 'Message is required'}), 400
            
            chat = Chat(chat_id=chat_id)
            
            def generate():
                """Generator for streaming response"""
                yield f"data: {json.dumps({'type': 'chat_id', 'content': chat.chat_id})}\n\n"
                
                for chunk in chat.generate_text_stream(
                    message=message,
                    provider=provider,
                    model=model,
                    include_reasoning=include_reasoning
                ):
                    if chunk.get('type') == 'thoughts' and chunk.get('content'):
                        yield f"data: {json.dumps({'type': 'chat_state', 'state': 'thinking', 'chat_id': chat.chat_id})}\n\n"
                    elif chunk.get('type') == 'answer' and chunk.get('content'):
                        yield f"data: {json.dumps({'type': 'chat_state', 'state': 'responding', 'chat_id': chat.chat_id})}\n\n"
                    
                    yield f"data: {json.dumps(chunk)}\n\n"
                
                yield f"data: {json.dumps({'type': 'chat_state', 'state': 'static', 'chat_id': chat.chat_id})}\n\n"
                yield f"data: {json.dumps({'type': 'complete'})}\n\n"
            
            return Response(
                generate(),
                mimetype='text/event-stream',
                headers={
                    'Cache-Control': 'no-cache',
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
                    'Cache-Control': 'no-cache',
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