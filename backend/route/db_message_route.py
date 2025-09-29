# status: complete
"""Database route handler for message operations"""

import time
from typing import Tuple
from flask import Flask, request, jsonify
from utils.db_utils import db
from utils.logger import get_logger
from utils.cancellation_manager import cancellation_manager
from utils.db_route_utils import (
    DBRouteConstants,
    ResponseBuilder,
    handle_route_error,
    ensure_chat_exists,
    get_request_data,
    validate_api_parameters
)

logger = get_logger(__name__)


class MessageRoute:
    """Handler for message-level operations including cascade delete, retry, and file management"""

    def __init__(self, app: Flask):
        self.app = app
        self._register_routes()

    def _register_routes(self):
        """Register all message-related routes"""
        self.app.route('/api/db/messages/<string:message_id>/cascade-delete', methods=['DELETE'])(self.cascade_delete_message)
        self.app.route('/api/db/messages/<string:message_id>/retry', methods=['POST'])(self.retry_message)
        self.app.route('/api/db/chat/<chat_id>/cancel-streaming', methods=['POST'])(self.cancel_chat_streaming)
        self.app.route('/api/db/messages/<string:message_id>/content', methods=['PUT'])(self.update_message_content)
        self.app.route('/api/db/messages/<string:message_id>/files/link', methods=['POST'])(self.link_files_to_message)
        self.app.route('/api/db/messages/<string:message_id>/files/<string:file_id>', methods=['DELETE'])(self.unlink_file_from_message)

    def _handle_route_error(self, operation: str, error: Exception, context: dict = None) -> Tuple:
        """Wrapper for standardized error handling"""
        return handle_route_error(operation, error, context, logger)

    def cancel_chat_streaming(self, chat_id: str):
        """Cancel active streaming for a chat"""
        try:
            from chat.chat import cancel_chat_process, force_cleanup_chat_process

            error_response = ensure_chat_exists(chat_id, db)
            if error_response:
                return error_response

            success = cancel_chat_process(chat_id)

            time.sleep(DBRouteConstants.CANCELLATION_SLEEP_TIME)

            cancellation_manager.clear_chat_cancelled_state(chat_id)

            force_cleanup_chat_process(chat_id)

            logger.info(f"Cancelled streaming for chat {chat_id}, success: {success}")
            return ResponseBuilder.success(
                message='Streaming cancelled successfully',
                chat_id=chat_id
            )

        except Exception as e:
            return self._handle_route_error("cancelling streaming for chat", e, {"chat_id": chat_id})

    def cascade_delete_message(self, message_id: str):
        """Delete a message and all messages after it"""
        try:
            is_valid, error_msg = validate_api_parameters(message_id=message_id)
            if not is_valid:
                return ResponseBuilder.error(error_msg, 400)

            data, error = get_request_data(request, ['chat_id'])
            if error:
                return error

            chat_id = data.get('chat_id')
            error_response = ensure_chat_exists(chat_id, db)
            if error_response:
                return error_response

            deleted_count = db.cascade_delete_message(message_id, chat_id)

            return ResponseBuilder.success(
                message=f'Deleted {deleted_count} messages',
                deleted_count=deleted_count,
                message_id=message_id,
                chat_id=chat_id
            )

        except Exception as e:
            return self._handle_route_error("deleting message", e, {"message_id": message_id})

    def retry_message(self, message_id: str):
        """Retry generation from a specific message"""
        try:
            is_valid, error_msg = validate_api_parameters(message_id=message_id)
            if not is_valid:
                return ResponseBuilder.error(error_msg, 400)

            data, error = get_request_data(request, ['chat_id'])
            if error:
                return error

            chat_id = data.get('chat_id')
            message_role = data.get('message_role', 'user')

            error_response = ensure_chat_exists(chat_id, db)
            if error_response:
                return error_response

            chat_history = db.get_chat_history(chat_id)

            deleted_count = db.cascade_delete_message_after(message_id, chat_id)

            last_user_message = None
            requires_regeneration = False

            if message_role == 'user':
                retried_message = next((msg for msg in chat_history if msg['id'] == message_id), None)
                if retried_message and retried_message['role'] == 'user':
                    last_user_message = {
                        'id': retried_message['id'],
                        'content': retried_message['content'],
                        'attached_files': retried_message.get('attachedFiles', [])
                    }
                    requires_regeneration = True
            else:
                message_index = next((i for i, msg in enumerate(chat_history) if msg['id'] == message_id), -1)
                if message_index > 0:
                    for i in range(message_index - 1, -1, -1):
                        if chat_history[i]['role'] == 'user':
                            user_msg = chat_history[i]
                            last_user_message = {
                                'id': user_msg['id'],
                                'content': user_msg['content'],
                                'attached_files': user_msg.get('attachedFiles', [])
                            }
                            requires_regeneration = True
                            break

            return ResponseBuilder.success(
                message=f'Prepared retry from message {message_id}',
                deleted_count=deleted_count,
                message_id=message_id,
                chat_id=chat_id,
                requires_regeneration=requires_regeneration,
                last_user_message=last_user_message
            )

        except Exception as e:
            return self._handle_route_error("retrying from message", e, {"message_id": message_id})

    def update_message_content(self, message_id: str):
        """Update message content with optional edit handling"""
        try:
            is_valid, error_msg = validate_api_parameters(message_id=message_id)
            if not is_valid:
                return ResponseBuilder.error(error_msg, 400)

            data = request.get_json() or {}
            content = data.get('content')
            thoughts = data.get('thoughts')
            chat_id = data.get('chat_id')
            is_edit = data.get('is_edit', False)

            if content is None:
                return ResponseBuilder.error('content is required', 400)

            if is_edit and not chat_id:
                return ResponseBuilder.error('chat_id is required for edit operations', 400)

            success = db.update_message(message_id, content, thoughts)

            if not success:
                return ResponseBuilder.error('Failed to update message or message not found', 404)

            response_data = {
                'message': 'Message updated successfully',
                'message_id': message_id
            }

            if is_edit and chat_id:
                chat_history = db.get_chat_history(chat_id)
                edited_message = next((msg for msg in chat_history if msg['id'] == message_id), None)

                if edited_message and edited_message['role'] == 'user':
                    deleted_count = db.cascade_delete_message_after(message_id, chat_id)

                    last_user_message = {
                        'id': edited_message['id'],
                        'content': content,
                        'attached_files': edited_message.get('attachedFiles', [])
                    }

                    response_data.update({
                        'deleted_count': deleted_count,
                        'requires_regeneration': True,
                        'last_user_message': last_user_message
                    })
                else:
                    response_data.update({
                        'deleted_count': 0,
                        'requires_regeneration': False,
                        'last_user_message': None
                    })

            return ResponseBuilder.success(data=response_data)

        except Exception as e:
            return self._handle_route_error("updating message", e, {"message_id": message_id})

    def link_files_to_message(self, message_id: str):
        """Link one or more existing files to a message using file IDs

        Body: { "file_ids": ["file_id1", "file_id2", ...] }
        Returns updated attached files for the message.
        """
        try:
            is_valid, error_msg = validate_api_parameters(message_id=message_id)
            if not is_valid:
                return ResponseBuilder.error(error_msg, 400)

            data = request.get_json() or {}
            file_ids = data.get('file_ids', [])

            if not isinstance(file_ids, list) or not file_ids:
                return ResponseBuilder.error('file_ids array is required', 400)

            message_rec = db.get_message(message_id)
            if not message_rec or str(message_id).startswith(DBRouteConstants.TEMP_MESSAGE_PREFIX):
                return ResponseBuilder.error('Invalid or temporary message_id — cannot attach files', 400)

            valid_file_ids = []
            for fid in file_ids:
                try:
                    if db.file_exists(fid):
                        valid_file_ids.append(fid)
                except Exception:
                    pass

            if not valid_file_ids:
                return ResponseBuilder.error('No valid file IDs provided', 400)

            ok = db.link_files_to_message(message_id, valid_file_ids)
            if not ok:
                return ResponseBuilder.error('Failed to link files to message', 500)

            updated_files = db.get_message_files(message_id)
            return ResponseBuilder.success(
                message='Files linked successfully',
                message_id=message_id,
                attached_files=updated_files
            )

        except Exception as e:
            return self._handle_route_error("linking files to message", e, {"message_id": message_id})

    def unlink_file_from_message(self, message_id: str, file_id: str):
        """Unlink a file from a message without deleting the file itself"""
        try:
            is_valid, error_msg = validate_api_parameters(message_id=message_id)
            if not is_valid:
                return ResponseBuilder.error(error_msg, 400)

            if not file_id or not isinstance(file_id, str):
                return ResponseBuilder.error('file_id is required', 400)

            ok = db.unlink_file_from_message(message_id, file_id)
            if not ok:
                return ResponseBuilder.error('Failed to unlink file from message', 404)

            updated_files = db.get_message_files(message_id)
            return ResponseBuilder.success(
                message='File unlinked from message successfully',
                message_id=message_id,
                attached_files=updated_files
            )
        except Exception as e:
            return self._handle_route_error("unlinking file from message", e, {"message_id": message_id, "file_id": file_id})


def register_db_message_routes(app: Flask):
    """Helper function to register message routes"""
    MessageRoute(app)