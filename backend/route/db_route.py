# status: complete

from flask import Flask, request, jsonify
import json
from utils.db_utils import db
from utils.logger import get_logger
from utils.config import Config

logger = get_logger(__name__)

class DatabaseRoute:
    """Database route handler for chat storage management"""
    
    def __init__(self, app: Flask):
        self.app = app
        self._register_routes()
    
    def _register_routes(self):
        """Register all database-related routes"""
        self.app.route('/api/db/chats', methods=['GET'])(self.get_all_chats)
        self.app.route('/api/db/chat/<chat_id>', methods=['GET'])(self.get_chat)
        self.app.route('/api/db/chat/<chat_id>', methods=['DELETE'])(self.delete_chat)
        self.app.route('/api/db/chat/<chat_id>/name', methods=['PUT'])(self.update_chat_name)
        self.app.route('/api/db/chat', methods=['POST'])(self.create_chat)
        self.app.route('/api/db/settings/<key>', methods=['GET'])(self.get_user_setting)
        self.app.route('/api/db/settings', methods=['POST'])(self.save_user_setting)
        self.app.route('/api/db/config', methods=['GET'])(self.get_config)
        self.app.route('/api/db/active-chat', methods=['GET'])(self.get_active_chat)
        self.app.route('/api/db/active-chat', methods=['POST'])(self.set_active_chat)
        self.app.route('/api/db/chat/<chat_id>/state', methods=['GET'])(self.get_chat_state)
    
    def get_all_chats(self):
        """Get all chat sessions with basic info"""
        try:
            chats = db.get_all_chats()
            
            enhanced_chats = []
            for chat in chats:
                enhanced_chats.append({
                    'id': chat['id'],
                    'name': chat.get('name') or 'New Chat',
                    'isActive': False,
                    'state': chat.get('state', 'static'),
                    'created_at': chat['created_at'],
                    'system_prompt': chat['system_prompt']
                })
            
            return jsonify({
                'chats': enhanced_chats
            })
            
        except Exception as e:
            logger.error(f"Error getting all chats: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def get_chat(self, chat_id: str):
        """Get specific chat with full history"""
        try:
            if not db.chat_exists(chat_id):
                return jsonify({'error': 'Chat not found'}), 404
            
            history = db.get_chat_history(chat_id)
            
            return jsonify({
                'chat_id': chat_id,
                'history': history
            })
            
        except Exception as e:
            logger.error(f"Error getting all chats: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def delete_chat(self, chat_id: str):
        """Delete a specific chat"""
        try:
            if not db.chat_exists(chat_id):
                return jsonify({'error': 'Chat not found'}), 404
            
            success = db.delete_chat(chat_id)
            
            if success:
                return jsonify({
                    'message': 'Chat deleted successfully',
                    'chat_id': chat_id
                })
            else:
                return jsonify({'error': 'Failed to delete chat'}), 500
                
        except Exception as e:
            logger.error(f"Error deleting chat: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def update_chat_name(self, chat_id: str):
        """Update chat name using user settings"""
        try:
            if not db.chat_exists(chat_id):
                return jsonify({'error': 'Chat not found'}), 404
            
            data = request.get_json()
            new_name = data.get('name')
            
            if not new_name:
                return jsonify({'error': 'name is required'}), 400
            
            success = db.update_chat_name(chat_id, new_name)
            
            if success:
                return jsonify({
                    'message': 'Chat name updated successfully',
                    'chat_id': chat_id,
                    'name': new_name
                })
            else:
                return jsonify({'error': 'Failed to update chat name'}), 500
                
        except Exception as e:
            logger.error(f"Error updating chat name: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def create_chat(self):
        """Create a new chat session"""
        try:
            data = request.get_json()
            chat_id = data.get('chat_id')
            system_prompt = data.get('system_prompt')
            
            if not chat_id:
                return jsonify({'error': 'chat_id is required'}), 400
            
            if db.chat_exists(chat_id):
                return jsonify({'error': 'Chat already exists'}), 409
            
            success = db.create_chat(chat_id, system_prompt)
            
            if success:
                return jsonify({
                    'message': 'Chat created successfully',
                    'chat_id': chat_id
                })
            else:
                return jsonify({'error': 'Failed to create chat'}), 500
                
        except Exception as e:
            logger.error(f"Error getting all chats: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def get_user_setting(self, key: str):
        """Get a user setting"""
        try:
            value = db.get_user_setting(key)
            
            return jsonify({
                'key': key,
                'value': value
            })
            
        except Exception as e:
            logger.error(f"Error getting all chats: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def save_user_setting(self):
        """Save a user setting"""
        try:
            data = request.get_json()
            key = data.get('key')
            value = data.get('value')
            
            if not key:
                return jsonify({'error': 'key is required'}), 400
            

            value_str = json.dumps(value) if not isinstance(value, str) else value
            
            success = db.save_user_setting(key, value_str)
            
            if success:
                return jsonify({
                    'message': 'Setting saved successfully',
                    'key': key,
                    'value': value
                })
            else:
                return jsonify({'error': 'Failed to save setting'}), 500
                
        except Exception as e:
            logger.error(f"Error saving user setting: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def get_config(self):
        """Get application configuration defaults"""
        try:
            config_data = Config.get_defaults()
            return jsonify(config_data)
        except Exception as e:
            logger.error(f"Error getting config: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def get_active_chat(self):
        """Get current active chat ID"""
        try:
            active_chat = db.get_user_setting('active_chat', 'none')
            
            return jsonify({
                'active_chat': active_chat
            })
            
        except Exception as e:
            logger.error(f"Error getting active chat: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def set_active_chat(self):
        """Set current active chat ID"""
        try:
            data = request.get_json()
            chat_id = data.get('chat_id', 'none')
            
            success = db.save_user_setting('active_chat', chat_id)
            
            if success:
                logger.info(f"Active chat set to: {chat_id}")
                return jsonify({
                    'message': 'Active chat updated successfully',
                    'active_chat': chat_id
                })
            else:
                return jsonify({'error': 'Failed to set active chat'}), 500
                
        except Exception as e:
            logger.error(f"Error setting active chat: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def get_chat_state(self, chat_id: str):
        """Get current chat state"""
        try:
            if not db.chat_exists(chat_id):
                return jsonify({'error': 'Chat not found'}), 404
            
            state = db.get_chat_state(chat_id)
            
            return jsonify({
                'chat_id': chat_id,
                'state': state or 'static'
            })
            
        except Exception as e:
            logger.error(f"Error getting chat state: {str(e)}")
            return jsonify({'error': str(e)}), 500

def register_db_routes(app: Flask):
    """Helper function to register database routes"""
    DatabaseRoute(app)