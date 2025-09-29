# status: complete
"""Shared utilities for database route handlers"""

from flask import jsonify
from typing import List, Optional, Tuple


class DBRouteConstants:
    """Constants for database route operations"""
    MAX_PARAM_LENGTH = 255

    DEFAULT_ACTIVE_CHAT = 'none'
    TEMP_MESSAGE_PREFIX = 'temp_'

    CANCELLATION_SLEEP_TIME = 0.1

    IMPORT_ID_RANDOM_MIN = 1000
    IMPORT_ID_RANDOM_MAX = 9999

    CHAT_NOT_FOUND = 'Chat not found'
    REQUEST_BODY_REQUIRED = 'Request body required'
    INVALID_MESSAGE_ID = 'Invalid message ID format'
    CHAT_ID_REQUIRED = 'chat_id is required'
    MESSAGE_ID_REQUIRED = 'message_id is required'


class ResponseBuilder:
    """Helper class for building consistent JSON responses"""

    @staticmethod
    def success(message: str = None, data: dict = None, **kwargs):
        """Build a success response"""
        response = {}
        if message:
            response['message'] = message
        if data:
            response.update(data)
        response.update(kwargs)
        return jsonify(response)

    @staticmethod
    def error(message: str, status_code: int = 400):
        """Build an error response"""
        return jsonify({'error': message}), status_code


def validate_api_parameters(**params) -> Tuple[bool, str]:
    """
    Validate API parameters for proper types and ranges.
    Returns (is_valid, error_message)
    """
    for param_name, param_value in params.items():
        if param_value is None:
            return False, f"Parameter '{param_name}' is required"

        if param_name in ['message_id'] and isinstance(param_value, str):
            if not param_value.strip():
                return False, "Parameter 'message_id' cannot be empty"
            if not '_' in param_value:
                return False, "Parameter 'message_id' must be in format 'chatid_position'"
            if len(param_value) > DBRouteConstants.MAX_PARAM_LENGTH:
                return False, "Parameter 'message_id' is too long"

        if param_name == 'chat_id' and isinstance(param_value, str):
            if not param_value.strip():
                return False, "Parameter 'chat_id' cannot be empty"
            if len(param_value) > DBRouteConstants.MAX_PARAM_LENGTH:
                return False, "Parameter 'chat_id' is too long"

    return True, ""


def handle_route_error(operation: str, error: Exception, context: dict = None, logger=None) -> Tuple:
    """Standardized error handling for all routes"""
    context_str = ""
    if context:
        context_str = " " + ", ".join(f"{k}={v}" for k, v in context.items())
    error_msg = f"Error {operation}{context_str}: {str(error)}"
    if logger:
        logger.error(error_msg)
    return ResponseBuilder.error(str(error), 500)


def ensure_chat_exists(chat_id: str, db) -> Optional[Tuple]:
    """Ensure chat exists, return error response if not"""
    if not db.chat_exists(chat_id):
        return ResponseBuilder.error(DBRouteConstants.CHAT_NOT_FOUND, 404)
    return None


def get_request_data(request, required_fields: List[str] = None) -> Tuple:
    """Get and validate JSON request data"""
    data = request.get_json()
    if not data and required_fields:
        return None, ResponseBuilder.error(DBRouteConstants.REQUEST_BODY_REQUIRED, 400)

    if required_fields:
        for field in required_fields:
            if field not in data or data.get(field) is None:
                return None, ResponseBuilder.error(f'{field} is required', 400)

    return data, None