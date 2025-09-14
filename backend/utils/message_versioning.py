# status: complete

from typing import List, Dict, Optional
from utils.logger import get_logger
from utils.db_validation import DatabaseValidator

logger = get_logger(__name__)

class MessageVersioning:
    """
    Manages message-level versioning.

    Each message can have multiple versions (original, edit1, edit2, retry1, etc.)
    Each version is associated with a chat version where that change exists.
    """

    OPERATION_ORIGINAL = 'original'
    OPERATION_EDIT = 'edit'
    OPERATION_RETRY = 'retry'
    VALID_OPERATIONS = [OPERATION_ORIGINAL, OPERATION_EDIT, OPERATION_RETRY]

    VERSION_CHAT_PREFIX = 'version_'

    def __init__(self, db_manager):
        """Initialize with db_utils DatabaseManager instance"""
        self.db = db_manager
        self._validator = DatabaseValidator
    
    def record_message_version(self,
                              original_message_id: str,
                              chat_version_id: str,
                              operation: str,
                              content: str = None) -> int:
        """
        Record a new version of a message.

        Returns the version number assigned.
        """
        if not original_message_id or not isinstance(original_message_id, str):
            raise ValueError(f"Invalid original_message_id: {original_message_id}")
        if not chat_version_id or not isinstance(chat_version_id, str):
            raise ValueError(f"Invalid chat_version_id: {chat_version_id}")
        if operation not in self.VALID_OPERATIONS:
            raise ValueError(f"Invalid operation: {operation}. Must be one of {self.VALID_OPERATIONS}")

        def _record_version(conn, cursor):
            try:
                cursor.execute("""
                    INSERT INTO message_versions
                    (original_message_id, version_number, chat_version_id, operation, content)
                    VALUES (
                        ?,
                        COALESCE(
                            (SELECT MAX(version_number) FROM message_versions WHERE original_message_id = ?),
                            0
                        ) + 1,
                        ?, ?, ?
                    )
                """, (original_message_id, original_message_id, chat_version_id, operation, content))

                cursor.execute("""
                    SELECT version_number FROM message_versions
                    WHERE original_message_id = ? AND chat_version_id = ?
                """, (original_message_id, chat_version_id))

                result = cursor.fetchone()
                if result:
                    version_number = result[0]
                    logger.info(f"Recorded version {version_number} of message {original_message_id} in chat {chat_version_id}")
                    return version_number
                else:
                    raise Exception("Failed to retrieve inserted version number")

            except Exception as e:
                logger.error(f"Error recording message version: {e}")
                raise

        return self.db._transaction_wrapper(
            "recording message version",
            _record_version
        )
    
    def get_message_versions(self, original_message_id: str) -> List[Dict]:
        """
        Get all versions of a specific message.

        Returns list of version info including which chat version contains each.
        """
        if not original_message_id or not isinstance(original_message_id, str):
            logger.warning(f"Invalid original_message_id: {original_message_id}")
            return []

        def _get_versions(conn, cursor):
            cursor.execute("""
                SELECT
                    version_number,
                    chat_version_id,
                    operation,
                    content,
                    created_at
                FROM message_versions
                WHERE original_message_id = ?
                ORDER BY version_number
            """, (original_message_id,))

            versions = []
            for row in cursor.fetchall():
                versions.append({
                    'version_number': row[0],
                    'chat_version_id': row[1],
                    'operation': row[2],
                    'content': row[3],
                    'created_at': row[4]
                })

            return versions

        return self.db._execute_with_connection(
            "getting message versions",
            _get_versions,
            return_on_error=[]
        )
    
    def get_messages_with_versions(self, chat_id: str) -> Dict[str, List]:
        """
        Get all messages in a chat that have versions.

        Returns a dict mapping message IDs to their version info.
        """
        if not chat_id or not isinstance(chat_id, str):
            logger.warning(f"Invalid chat_id: {chat_id}")
            return {}

        base_chat_id = chat_id.split('_')[0] if '_' in chat_id else chat_id

        def _get_messages_with_versions(conn, cursor):
            cursor.execute("""
                SELECT
                    mv.original_message_id,
                    mv.version_number,
                    mv.chat_version_id,
                    mv.operation,
                    mv.content,
                    mv.created_at
                FROM message_versions mv
                WHERE mv.original_message_id LIKE ? || '_%'
                ORDER BY mv.original_message_id, mv.version_number
            """, (base_chat_id,))

            result = {}
            for row in cursor.fetchall():
                message_id = row[0]
                if message_id not in result:
                    result[message_id] = []

                result[message_id].append({
                    'version_number': row[1],
                    'chat_version_id': row[2],
                    'operation': row[3],
                    'content': row[4],
                    'created_at': row[5]
                })

            return result

        return self.db._execute_with_connection(
            "getting messages with versions",
            _get_messages_with_versions,
            return_on_error={}
        )
    
    def cleanup_chat_versions(self, chat_id: str) -> int:
        """
        Remove all message version records for a chat and its versions.
        Called when a chat is deleted.
        """
        if not chat_id or not isinstance(chat_id, str):
            logger.warning(f"Invalid chat_id for cleanup: {chat_id}")
            return 0

        def _cleanup_versions(conn, cursor):
            related_chat_ids = set([chat_id])
            to_check = [chat_id]

            while to_check:
                current_id = to_check.pop()
                cursor.execute("""
                    SELECT id FROM chats
                    WHERE belongsto = ?
                """, (current_id,))

                for row in cursor.fetchall():
                    child_id = row[0]
                    if child_id not in related_chat_ids:
                        related_chat_ids.add(child_id)
                        to_check.append(child_id)

            related_chat_ids = list(related_chat_ids)

            deleted_count = 0

            cursor.execute("""
                DELETE FROM message_versions
                WHERE original_message_id LIKE ? || '_%'
            """, (chat_id,))
            deleted_count += cursor.rowcount

            cursor.execute("""
                DELETE FROM message_versions
                WHERE chat_version_id = ?
            """, (chat_id,))
            deleted_count += cursor.rowcount

            if len(related_chat_ids) > 1:  
                placeholders = ','.join('?' * len(related_chat_ids))
                cursor.execute(f"""
                    DELETE FROM message_versions
                    WHERE chat_version_id LIKE ?
                    AND chat_version_id IN ({placeholders})
                """, (self.VERSION_CHAT_PREFIX + '%', *related_chat_ids))
                deleted_count += cursor.rowcount

            logger.info(f"Cleaned up {deleted_count} message version records for chat {chat_id}")
            return deleted_count

        return self.db._transaction_wrapper(
            "cleaning up chat versions",
            _cleanup_versions
        )
    
    def get_version_chain(self, original_message_id: str) -> List[str]:
        """
        Get the chain of chat versions for a message.
        Useful for the UI version switcher.

        Returns list of chat version IDs in order.
        """
        if not original_message_id or not isinstance(original_message_id, str):
            logger.warning(f"Invalid original_message_id: {original_message_id}")
            return []

        versions = self.get_message_versions(original_message_id)
        return [v['chat_version_id'] for v in versions]
    
    def find_original_message(self, message_id: str) -> Optional[str]:
        """
        Given a message ID that might be in a version chat,
        find the original message ID it corresponds to.
        """
        if not message_id or not isinstance(message_id, str):
            logger.warning(f"Invalid message_id: {message_id}")
            return None

        if not message_id.startswith(self.VERSION_CHAT_PREFIX):
            return message_id

        if '_' not in message_id:
            return None

        parts = message_id.rsplit('_', 1)
        if len(parts) != 2 or not parts[1].isdigit():
            return None

        version_chat_id = parts[0]
        position = parts[1]

        def _find_original(conn, cursor):
            cursor.execute("""
                SELECT belongsto FROM chats
                WHERE id = ? AND isversion = 1
            """, (version_chat_id,))

            result = cursor.fetchone()
            if not result:
                return None

            parent_chat_id = result[0]

            while parent_chat_id and parent_chat_id.startswith(self.VERSION_CHAT_PREFIX):
                cursor.execute("""
                    SELECT belongsto FROM chats
                    WHERE id = ? AND isversion = 1
                """, (parent_chat_id,))

                result = cursor.fetchone()
                if not result:
                    break
                parent_chat_id = result[0]

            if parent_chat_id:
                return f"{parent_chat_id}_{position}"

            return None

        return self.db._execute_with_connection(
            "finding original message",
            _find_original,
            return_on_error=None
        )
