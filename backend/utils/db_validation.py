# status: complete

"""
Database validation utilities for ATLAS application.
Provides validation methods for database operations to ensure data integrity.
"""

from typing import Optional
from utils.logger import get_logger

logger = get_logger(__name__)


class DatabaseValidator:
    """Validation utilities for database operations"""

    DEFAULT_STRING_MAX_LENGTH = 255
    SETTING_VALUE_MAX_LENGTH = 1000

    ALLOWED_TABLES = {
        'chats', 'messages', 'files', 'user_settings',
        'provider_configs', 'message_files', 'message_versions', 'message_lineage',
        'oplog', 'plans', 'tasks', 'tool_calls', 'blobs'
    }

    ALLOWED_COLUMNS = {
        'id', 'chat_id', 'file_id', 'message_id', 'key', 'name', 'role',
        'content', 'thoughts', 'provider', 'model', 'timestamp', 'state',
        'system_prompt', 'created_at', 'isversion', 'belongsto', 'last_active',
        'value', 'updated_at', 'config', 'is_enabled', 'original_name',
        'stored_filename', 'file_type', 'file_extension', 'file_size',
        'upload_timestamp', 'md_filename', 'api_file_name', 'api_state',
        'temp_id', 'original_message_id', 'version_number', 'chat_version_id',
        'operation', 'parent_message_id', 'root_message_id',
        'base_ctx_id', 'new_ctx_id', 'op_json', 'ts', 'plan_id', 'fingerprint',
        'ir_json', 'def_json', 'attempt', 'error', 'cost', 'tokens', 'tool',
        'task_id', 'input_hash', 'output_hash', 'ops_json', 'latency_ms', 'hash', 'bytes'
    }

    @classmethod
    def validate_id(cls, id_value, id_name: str = "ID") -> bool:
        """
        Validate that an ID is a positive integer.

        Args:
            id_value: The ID value to validate
            id_name: Name of the ID field for logging

        Returns:
            bool: True if valid, False otherwise
        """
        if not isinstance(id_value, int) or id_value <= 0:
            logger.warning(f"Invalid {id_name}: {id_value}")
            return False
        return True

    @classmethod
    def validate_string(cls, string_value, string_name: str = "string",
                       max_length: Optional[int] = None) -> bool:
        """
        Validate that a string is non-empty and within length limits.

        Args:
            string_value: The string value to validate
            string_name: Name of the string field for logging
            max_length: Maximum allowed length (defaults to DEFAULT_STRING_MAX_LENGTH)

        Returns:
            bool: True if valid, False otherwise
        """
        if max_length is None:
            max_length = cls.DEFAULT_STRING_MAX_LENGTH

        if not isinstance(string_value, str) or not string_value.strip():
            logger.warning(f"Invalid {string_name}: empty or not a string")
            return False

        if len(string_value) > max_length:
            logger.warning(f"Invalid {string_name}: too long ({len(string_value)} > {max_length})")
            return False

        return True

    @classmethod
    def validate_table_column(cls, table: str, column: Optional[str] = None) -> bool:
        """
        Validate table and column names to prevent SQL injection.

        Args:
            table: Table name to validate
            column: Optional column name to validate

        Returns:
            bool: True if valid, False otherwise
        """
        if table not in cls.ALLOWED_TABLES:
            logger.error(f"Invalid table name: {table}")
            return False

        if column and column not in cls.ALLOWED_COLUMNS:
            logger.error(f"Invalid column name: {column}")
            return False

        return True

    @classmethod
    def validate_chat_state(cls, state: str) -> bool:
        """
        Validate chat state value.

        Args:
            state: Chat state to validate

        Returns:
            bool: True if valid, False otherwise
        """
        valid_states = ['thinking', 'responding', 'static']
        if state not in valid_states:
            logger.warning(f"Invalid chat state: {state}")
            return False
        return True

    @classmethod
    def validate_role(cls, role: str) -> bool:
        """
        Validate message role value.

        Args:
            role: Message role to validate

        Returns:
            bool: True if valid, False otherwise
        """
        valid_roles = ['system', 'user', 'assistant', 'tool']
        if role not in valid_roles:
            logger.warning(f"Invalid message role: {role}")
            return False
        return True