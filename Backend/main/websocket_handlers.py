"""
WebSocket handlers module for ATLAS backend.
Contains all SocketIO event handlers and related functionality.
"""

from flask import request
from flask_socketio import emit, join_room, leave_room
from utils.logger import safe_info, safe_exception


def register_socketio_handlers(socketio, background_processor, settings):
    """
    Register all SocketIO event handlers with the socketio instance.
    
    Args:
        socketio: The SocketIO instance
        background_processor: The BackgroundChatProcessor instance
        settings: Global settings dictionary
    """
    
    @socketio.on('connect')
    def handle_connect():
        safe_info(f"Client connected: {request.sid}")
        emit('connected', {'status': 'Connected to ATLAS backend'})
        
    @socketio.on('disconnect')
    def handle_disconnect():
        safe_info(f"Client disconnected: {request.sid}")
        
    @socketio.on('join_chat')
    def handle_join_chat(data):
        chat_id = data.get('chat_id')
        if chat_id:
            join_room(f'chat_{chat_id}')
            safe_info(f"Client {request.sid} joined chat room: {chat_id}")
            
            # Send current chat status
            status = background_processor.get_chat_status(chat_id)
            emit('chat_status', {
                'chat_id': chat_id,
                'status': status
            })
            
    @socketio.on('leave_chat')
    def handle_leave_chat(data):
        chat_id = data.get('chat_id')
        if chat_id:
            leave_room(f'chat_{chat_id}')
            safe_info(f"Client {request.sid} left chat room: {chat_id}")
            
    @socketio.on('start_background_chat')
    def handle_start_background_chat(data):
        """Start background processing for a chat"""
        try:
            chat_id = data.get('chat_id')
            messages = data.get('messages', [])
            model_name = data.get('model', settings['model'])
            kwargs = {
                'temperature': data.get('temperature'),
                'max_tokens': data.get('max_tokens')
            }
            
            if not chat_id or not messages:
                emit('error', {'message': 'Invalid chat data'})
                return
                
            # Start background processing
            background_processor.start_background_processing(
                chat_id, messages, model_name, **kwargs
            )
            
            emit('background_started', {
                'chat_id': chat_id,
                'status': 'processing'
            })
            
        except Exception as e:
            safe_exception("Error starting background chat", e)
            emit('error', {'message': str(e)})