# status: complete
"""Database route handler for chat storage management"""

import json
from typing import Tuple
from flask import Flask, request, jsonify
from utils.db_utils import db
from utils.logger import get_logger
from utils.config import Config
from utils.cancellation_manager import cancellation_manager
from chat.chat import force_cleanup_chat_process
from route.db_route_utils import (
    DBRouteConstants,
    ResponseBuilder,
    handle_route_error,
    ensure_chat_exists,
    get_request_data
)

logger = get_logger(__name__)


class ChatManagementRoute:
    """Handler for chat CRUD operations and settings management"""

    def __init__(self, app: Flask):
        self.app = app
        self._register_routes()

    def _register_routes(self):
        """Register all chat management routes"""
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
        self.app.route('/api/db/files/verify/<chat_id>', methods=['POST'])(self.verify_chat_files)

    def _handle_route_error(self, operation: str, error: Exception, context: dict = None) -> Tuple:
        """Wrapper for standardized error handling"""
        return handle_route_error(operation, error, context, logger)

    def get_all_chats(self):
        """Get all chat sessions with basic info - only return main chats (isversion: false)"""
        try:
            all_chats = db.get_all_chats()
            current_active_chat = db.get_user_setting('active_chat', DBRouteConstants.DEFAULT_ACTIVE_CHAT)

            main_chat_to_highlight = db.find_main_chat(current_active_chat)
            logger.debug(f"[GET_ALL_CHATS] Active chat: {current_active_chat} -> Main chat to highlight: {main_chat_to_highlight}")
            if main_chat_to_highlight is None:
                main_chat_to_highlight = current_active_chat
                logger.debug(f"[GET_ALL_CHATS] find_main_chat returned None, falling back to active chat: {main_chat_to_highlight}")

            enhanced_chats = []
            for chat in all_chats:
                if not chat.get('isversion', False):
                    is_highlighted = chat['id'] == main_chat_to_highlight
                    enhanced_chats.append({
                        'id': chat['id'],
                        'name': chat.get('name') or 'New Chat',
                        'isActive': is_highlighted,
                        'state': chat.get('state', 'static'),
                        'created_at': chat['created_at'],
                        'system_prompt': chat['system_prompt'],
                        'isversion': chat.get('isversion', False),
                        'belongsto': chat.get('belongsto'),
                        'last_active': chat.get('last_active')
                    })
                    if is_highlighted:
                        logger.debug(f"[SidebarHighlight] Applied highlighting to: {chat['id']} ({chat.get('name') or 'New Chat'})")

            return ResponseBuilder.success(chats=enhanced_chats)

        except Exception as e:
            return self._handle_route_error("getting all chats", e)

    def get_chat(self, chat_id: str):
        """Get specific chat with full history and verify file availability"""
        try:
            if not db.chat_exists(chat_id):
                logger.info(f"Chat {chat_id} doesn't exist yet, returning empty history")
                return ResponseBuilder.success(data={
                    'chat_id': chat_id,
                    'history': []
                })

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

            return ResponseBuilder.success(data=response_data)

        except Exception as e:
            return self._handle_route_error("getting chat", e, {"chat_id": chat_id})

    def delete_chat(self, chat_id: str):
        """Delete a specific chat"""
        try:
            error_response = ensure_chat_exists(chat_id, db)
            if error_response:
                return error_response

            logger.info(f"[CANCEL] Force terminating chat process for {chat_id} before deletion")
            force_cleanup_chat_process(chat_id)

            current_active_chat = db.get_user_setting('active_chat', DBRouteConstants.DEFAULT_ACTIVE_CHAT)
            will_delete_active_chat = False
            descendants = []

            if current_active_chat != DBRouteConstants.DEFAULT_ACTIVE_CHAT:
                descendants = db.find_all_descendants(chat_id)
                all_chats_to_delete = [chat_id] + descendants

                if current_active_chat in all_chats_to_delete:
                    will_delete_active_chat = True
                    logger.info(f"[CASCADE_DELETE] Current active chat {current_active_chat} will be deleted, clearing active chat")

                for descendant_id in descendants:
                    logger.info(f"[CANCEL] Force terminating descendant process {descendant_id}")
                    force_cleanup_chat_process(descendant_id)

            success = db.delete_chat(chat_id)

            if success:
                all_deleted_chats = [chat_id] + descendants

                if will_delete_active_chat:
                    db.save_user_setting('active_chat', DBRouteConstants.DEFAULT_ACTIVE_CHAT)
                    logger.info(f"[CASCADE_DELETE] Cleared active chat setting")
                return ResponseBuilder.success(
                    message='Chat deleted successfully',
                    chat_id=chat_id,
                    cascade_deleted=len(descendants) > 0,
                    total_deleted=len(all_deleted_chats),
                    deleted_chats=all_deleted_chats
                )
            else:
                return ResponseBuilder.error('Failed to delete chat', 500)

        except Exception as e:
            return self._handle_route_error("deleting chat", e, {"chat_id": chat_id})

    def update_chat_name(self, chat_id: str):
        """Update chat name using user settings"""
        try:
            error_response = ensure_chat_exists(chat_id, db)
            if error_response:
                return error_response

            data, error = get_request_data(request, ['name'])
            if error:
                return error

            new_name = data.get('name')
            success = db.update_chat_name(chat_id, new_name)

            if success:
                return ResponseBuilder.success(
                    message='Chat name updated successfully',
                    chat_id=chat_id,
                    name=new_name
                )
            else:
                return ResponseBuilder.error('Failed to update chat name', 500)

        except Exception as e:
            return self._handle_route_error("updating chat name", e, {"chat_id": chat_id})

    def create_chat(self):
        """Create a new chat session"""
        try:
            data, error = get_request_data(request, ['chat_id'])
            if error:
                return error

            chat_id = data.get('chat_id')
            system_prompt = data.get('system_prompt')

            if db.chat_exists(chat_id):
                logger.info(f"Chat {chat_id} already exists, returning success (idempotent operation)")
                return ResponseBuilder.success(
                    message='Chat already exists',
                    chat_id=chat_id
                )

            success = db.create_chat(chat_id, system_prompt)

            if success:
                return ResponseBuilder.success(
                    message='Chat created successfully',
                    chat_id=chat_id
                )
            else:
                return ResponseBuilder.error('Failed to create chat', 500)

        except Exception as e:
            return self._handle_route_error("creating chat", e)

    def get_user_setting(self, key: str):
        """Get a user setting"""
        try:
            value = db.get_user_setting(key)
            return ResponseBuilder.success(key=key, value=value)
        except Exception as e:
            return self._handle_route_error("getting user setting", e, {"key": key})

    def save_user_setting(self):
        """Save a user setting"""
        try:
            data, error = get_request_data(request, ['key'])
            if error:
                return error

            key = data.get('key')
            value = data.get('value')

            value_str = json.dumps(value) if not isinstance(value, str) else value
            success = db.save_user_setting(key, value_str)

            if success:
                return ResponseBuilder.success(
                    message='Setting saved successfully',
                    key=key,
                    value=value
                )
            else:
                return ResponseBuilder.error('Failed to save setting', 500)

        except Exception as e:
            return self._handle_route_error("saving user setting", e)

    def get_config(self):
        """Get application configuration defaults"""
        try:
            config_data = Config.get_defaults()
            return ResponseBuilder.success(data=config_data)
        except Exception as e:
            return self._handle_route_error("getting config", e)

    def get_active_chat(self):
        """Get current active chat ID"""
        try:
            active_chat = db.get_user_setting('active_chat', DBRouteConstants.DEFAULT_ACTIVE_CHAT)
            return ResponseBuilder.success(active_chat=active_chat)
        except Exception as e:
            return self._handle_route_error("getting active chat", e)

    def set_active_chat(self):
        """Set current active chat ID and update version memory"""
        try:
            data = request.get_json()
            chat_id = data.get('chat_id', DBRouteConstants.DEFAULT_ACTIVE_CHAT)

            success = db.save_user_setting('active_chat', chat_id)

            if not success:
                return ResponseBuilder.error('Failed to set active chat', 500)

            if chat_id != DBRouteConstants.DEFAULT_ACTIVE_CHAT:
                main_chat_id = db.find_main_chat(chat_id)
                if main_chat_id and main_chat_id != chat_id:
                    db.update_chat_last_active(main_chat_id, chat_id)
                    logger.info(f"Updated version memory: main chat {main_chat_id} -> last active: {chat_id}")
                elif main_chat_id == chat_id:
                    db.update_chat_last_active(main_chat_id, chat_id)
                    logger.info(f"Updated version memory: main chat {main_chat_id} -> last active: {chat_id} (itself)")

            logger.info(f"Active chat set to: {chat_id}")
            logger.info(f"[ActiveChatId] Backend confirmed active chat change: {chat_id}")
            return ResponseBuilder.success(
                message='Active chat updated successfully',
                active_chat=chat_id
            )

        except Exception as e:
            return self._handle_route_error("setting active chat", e)

    def get_chat_state(self, chat_id: str):
        """Get current chat state"""
        try:
            error_response = ensure_chat_exists(chat_id, db)
            if error_response:
                return error_response

            state = db.get_chat_state(chat_id)
            return ResponseBuilder.success(
                chat_id=chat_id,
                state=state or 'static'
            )

        except Exception as e:
            return self._handle_route_error("getting chat state", e, {"chat_id": chat_id})

    def verify_chat_files(self, chat_id: str):
        """Verify file availability for a specific chat"""
        try:
            error_response = ensure_chat_exists(chat_id, db)
            if error_response:
                return error_response

            result = db.verify_files_availability(chat_id)

            if result['success']:
                return ResponseBuilder.success(
                    success=True,
                    chat_id=chat_id,
                    verified_count=result['verified_count'],
                    unavailable_count=result['unavailable_count'],
                    total_checked=result.get('total_checked', 0),
                    message=f"File verification completed: {result['verified_count']} available, {result['unavailable_count']} unavailable"
                )
            else:
                return jsonify({
                    'success': False,
                    'chat_id': chat_id,
                    'error': result.get('error', 'File verification failed'),
                    'verified_count': 0,
                    'unavailable_count': 0
                }), 500

        except Exception as e:
            return self._handle_route_error("verifying files for chat", e, {"chat_id": chat_id})


def register_db_chat_management_routes(app: Flask):
    """Helper function to register chat management routes"""
    ChatManagementRoute(app)