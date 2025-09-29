# status: complete
"""Database route handler for bulk operations"""

import random
import time
from typing import List, Tuple
from flask import Flask, request
from utils.db_utils import db
from utils.logger import get_logger
from utils.cancellation_manager import cancellation_manager
from chat.chat import force_cleanup_chat_process
from utils.db_route_utils import (
    DBRouteConstants,
    ResponseBuilder,
    handle_route_error,
    get_request_data
)

logger = get_logger(__name__)


class BulkRoute:
    """Handler for bulk operations including import, export, and bulk delete"""

    def __init__(self, app: Flask):
        self.app = app
        self._register_routes()

    def _register_routes(self):
        """Register all bulk operation routes"""
        self.app.route('/api/db/chats/bulk-export', methods=['POST'])(self.bulk_export_chats)
        self.app.route('/api/db/chats/bulk-import', methods=['POST'])(self.bulk_import_chats)
        self.app.route('/api/db/chats/bulk-delete', methods=['POST'])(self.bulk_delete_chats)

    def _handle_route_error(self, operation: str, error: Exception, context: dict = None) -> Tuple:
        """Wrapper for standardized error handling"""
        return handle_route_error(operation, error, context, logger)

    def _handle_active_chat_deletion(self, chats_to_delete: List[str]) -> bool:
        """Handle active chat clearing if it will be deleted"""
        current_active = db.get_user_setting('active_chat', DBRouteConstants.DEFAULT_ACTIVE_CHAT)
        if current_active != DBRouteConstants.DEFAULT_ACTIVE_CHAT and current_active in chats_to_delete:
            db.save_user_setting('active_chat', DBRouteConstants.DEFAULT_ACTIVE_CHAT)
            logger.info(f"Cleared active chat setting: {current_active}")
            return True
        return False

    def bulk_export_chats(self):
        """Export multiple chats with their full history"""
        try:
            data, error = get_request_data(request, ['chat_ids'])
            if error:
                return error

            chat_ids = data.get('chat_ids', [])
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

            return ResponseBuilder.success(
                exported_chats=exported_chats,
                export_count=len(exported_chats)
            )

        except Exception as e:
            return self._handle_route_error("bulk exporting chats", e)

    def bulk_import_chats(self):
        """Import multiple chats from exported data"""
        try:
            data, error = get_request_data(request, ['chats'])
            if error:
                return error

            chats_data = data.get('chats', [])
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
                        new_chat_id = f"imported_{int(time.time())}_{random.randint(DBRouteConstants.IMPORT_ID_RANDOM_MIN, DBRouteConstants.IMPORT_ID_RANDOM_MAX)}"
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

            return ResponseBuilder.success(
                message=f'Import completed: {imported_count} imported, {skipped_count} skipped',
                imported_count=imported_count,
                skipped_count=skipped_count,
                errors=errors
            )

        except Exception as e:
            return self._handle_route_error("bulk importing chats", e)

    def bulk_delete_chats(self):
        """Delete multiple chats with proper versioning cascade handling"""
        try:
            data, error = get_request_data(request, ['chat_ids'])
            if error:
                return error

            chat_ids = data.get('chat_ids', [])
            all_chats_to_delete = set()
            chat_hierarchies = {}

            for chat_id in chat_ids:
                if not db.chat_exists(chat_id):
                    continue

                descendants = db.find_all_descendants(chat_id)
                hierarchy = [chat_id] + descendants
                chat_hierarchies[chat_id] = hierarchy
                all_chats_to_delete.update(hierarchy)

            optimized_chat_ids = []
            for chat_id in chat_ids:
                if not db.chat_exists(chat_id):
                    continue

                is_redundant = False
                for other_chat_id in chat_ids:
                    if other_chat_id != chat_id and chat_id in chat_hierarchies.get(other_chat_id, []):
                        is_redundant = True
                        logger.info(f"[BULK_DELETE] Skipping {chat_id} as it will be cascade deleted by {other_chat_id}")
                        break

                if not is_redundant:
                    optimized_chat_ids.append(chat_id)

            will_delete_active_chat = self._handle_active_chat_deletion(list(all_chats_to_delete))

            deleted_count = 0
            errors = []
            all_deleted_chats = []

            for chat_id in optimized_chat_ids:
                try:
                    logger.info(f"[CANCEL] Force terminating chat process for {chat_id} before deletion")
                    force_cleanup_chat_process(chat_id)

                    hierarchy = chat_hierarchies.get(chat_id, [chat_id])
                    for descendant_id in hierarchy:
                        if descendant_id != chat_id:
                            logger.info(f"[CANCEL] Force terminating descendant process {descendant_id}")
                            force_cleanup_chat_process(descendant_id)

                    success = db.delete_chat(chat_id)
                    if success:
                        deleted_count += len(hierarchy)
                        all_deleted_chats.extend(hierarchy)
                        logger.info(f"[BULK_CASCADE_DELETE] Successfully deleted {chat_id} and {len(hierarchy)-1} descendants")
                    else:
                        errors.append(f"Failed to delete chat {chat_id}")

                except Exception as e:
                    errors.append(f"Error deleting chat {chat_id}: {str(e)}")

            return ResponseBuilder.success(
                message=f'Bulk deleted {len(optimized_chat_ids)} primary chats with {deleted_count} total chats (including cascade deletions)',
                requested_count=len(chat_ids),
                optimized_count=len(optimized_chat_ids),
                total_deleted_count=deleted_count,
                deleted_chats=all_deleted_chats,
                cascade_deleted=len(all_deleted_chats) > len(optimized_chat_ids),
                active_chat_cleared=will_delete_active_chat,
                errors=errors
            )

        except Exception as e:
            return self._handle_route_error("bulk deleting chats", e)


def register_db_bulk_routes(app: Flask):
    """Helper function to register bulk operation routes"""
    BulkRoute(app)