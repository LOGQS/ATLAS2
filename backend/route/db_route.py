# status: complete

from flask import Flask, request, jsonify
import json
from utils.db_utils import db
from utils.logger import get_logger
from utils.config import Config
from utils.cancellation_manager import cancellation_manager

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
        self.app.route('/api/db/chats/bulk-export', methods=['POST'])(self.bulk_export_chats)
        self.app.route('/api/db/chats/bulk-import', methods=['POST'])(self.bulk_import_chats)
        self.app.route('/api/db/chats/bulk-delete', methods=['POST'])(self.bulk_delete_chats)
        self.app.route('/api/db/files/verify/<chat_id>', methods=['POST'])(self.verify_chat_files)
    
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
        """Get specific chat with full history and verify file availability"""
        try:
            if not db.chat_exists(chat_id):
                return jsonify({'error': 'Chat not found'}), 404
            
            verification_result = db.verify_files_availability(chat_id)
            logger.info(f"File verification for chat {chat_id}: {verification_result}")
            
            history = db.get_chat_history(chat_id)
            
            response_data = {
                'chat_id': chat_id,
                'history': history
            }
            
            if verification_result.get('total_checked', 0) > 0:
                response_data['file_verification'] = {
                    'verified_count': verification_result.get('verified_count', 0),
                    'unavailable_count': verification_result.get('unavailable_count', 0),
                    'total_checked': verification_result.get('total_checked', 0)
                }
            
            return jsonify(response_data)
            
        except Exception as e:
            logger.error(f"Error getting chat {chat_id}: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def delete_chat(self, chat_id: str):
        """Delete a specific chat"""
        try:
            if not db.chat_exists(chat_id):
                return jsonify({'error': 'Chat not found'}), 404
            
            logger.info(f"[CANCEL] Cancelling active processing for chat {chat_id} before deletion")
            cancellation_manager.cancel_chat(chat_id)
            
            success = db.delete_chat(chat_id)
            
            if success:
                cancellation_manager.cleanup_chat(chat_id)
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
    
    def bulk_export_chats(self):
        """Export multiple chats with their full history"""
        try:
            data = request.get_json()
            chat_ids = data.get('chat_ids', [])
            
            if not chat_ids:
                return jsonify({'error': 'chat_ids array is required'}), 400
            
            exported_chats = []
            
            for chat_id in chat_ids:
                if not db.chat_exists(chat_id):
                    logger.warning(f"Skipping non-existent chat: {chat_id}")
                    continue
                
                all_chats = db.get_all_chats()
                chat_meta = next((chat for chat in all_chats if chat['id'] == chat_id), None)
                
                if not chat_meta:
                    continue
                
                history = db.get_chat_history(chat_id)
                
                exported_chat = {
                    'id': chat_meta['id'],
                    'name': chat_meta['name'],
                    'system_prompt': chat_meta['system_prompt'],
                    'created_at': chat_meta['created_at'],
                    'messages': history
                }
                
                exported_chats.append(exported_chat)
            
            return jsonify({
                'exported_chats': exported_chats,
                'export_count': len(exported_chats)
            })
            
        except Exception as e:
            logger.error(f"Error bulk exporting chats: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def bulk_import_chats(self):
        """Import multiple chats from exported data"""
        try:
            data = request.get_json()
            chats_data = data.get('chats', [])
            
            if not chats_data:
                return jsonify({'error': 'chats array is required'}), 400
            
            imported_count = 0
            skipped_count = 0
            errors = []
            
            for chat_data in chats_data:
                try:
                    chat_id = chat_data.get('id')
                    name = chat_data.get('name', 'Imported Chat')
                    system_prompt = chat_data.get('system_prompt')
                    messages = chat_data.get('messages', [])
                    
                    if not chat_id:
                        errors.append("Chat missing ID, skipping")
                        continue
                    
                    if db.chat_exists(chat_id):
                        import time
                        import random
                        new_chat_id = f"imported_{int(time.time())}_{random.randint(1000, 9999)}"
                        chat_id = new_chat_id
                    
                    success = db.create_chat(chat_id, system_prompt, name)
                    if not success:
                        errors.append(f"Failed to create chat {chat_id}")
                        continue
                    
                    for message in messages:
                        db.save_message(
                            chat_id=chat_id,
                            role=message.get('role', 'user'),
                            content=message.get('content', ''),
                            thoughts=message.get('thoughts'),
                            provider=message.get('provider'),
                            model=message.get('model')
                        )
                    
                    imported_count += 1
                    
                except Exception as e:
                    errors.append(f"Error importing chat: {str(e)}")
                    skipped_count += 1
            
            return jsonify({
                'message': f'Import completed: {imported_count} imported, {skipped_count} skipped',
                'imported_count': imported_count,
                'skipped_count': skipped_count,
                'errors': errors
            })
            
        except Exception as e:
            logger.error(f"Error bulk importing chats: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def bulk_delete_chats(self):
        """Delete multiple chats"""
        try:
            data = request.get_json()
            chat_ids = data.get('chat_ids', [])
            
            if not chat_ids:
                return jsonify({'error': 'chat_ids array is required'}), 400
            
            deleted_count = 0
            errors = []
            
            for chat_id in chat_ids:
                try:
                    if not db.chat_exists(chat_id):
                        errors.append(f"Chat {chat_id} does not exist")
                        continue
                    
                    logger.info(f"[CANCEL] Bulk cancelling active processing for chat {chat_id} before deletion")
                    cancellation_manager.cancel_chat(chat_id)
                    
                    success = db.delete_chat(chat_id)
                    if success:
                        cancellation_manager.cleanup_chat(chat_id)
                        deleted_count += 1
                    else:
                        errors.append(f"Failed to delete chat {chat_id}")
                        
                except Exception as e:
                    errors.append(f"Error deleting chat {chat_id}: {str(e)}")
            
            return jsonify({
                'message': f'Deleted {deleted_count} chats',
                'deleted_count': deleted_count,
                'errors': errors
            })
            
        except Exception as e:
            logger.error(f"Error bulk deleting chats: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def verify_chat_files(self, chat_id: str):
        """Verify file availability for a specific chat"""
        try:
            if not db.chat_exists(chat_id):
                return jsonify({'error': 'Chat not found'}), 404
            
            result = db.verify_files_availability(chat_id)
            
            if result['success']:
                return jsonify({
                    'success': True,
                    'chat_id': chat_id,
                    'verified_count': result['verified_count'],
                    'unavailable_count': result['unavailable_count'],
                    'total_checked': result.get('total_checked', 0),
                    'message': f"File verification completed: {result['verified_count']} available, {result['unavailable_count']} unavailable"
                })
            else:
                return jsonify({
                    'success': False,
                    'chat_id': chat_id,
                    'error': result.get('error', 'File verification failed'),
                    'verified_count': 0,
                    'unavailable_count': 0
                }), 500
                
        except Exception as e:
            logger.error(f"Error verifying files for chat {chat_id}: {str(e)}")
            return jsonify({'error': str(e)}), 500

def register_db_routes(app: Flask):
    """Helper function to register database routes"""
    DatabaseRoute(app)