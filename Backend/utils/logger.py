# status: to implement, move to later

"""
This module contains logging helper functions for the application.
"""

import logging
from utils.extra import safe_log_data


def safe_debug(message, data=None):
    """Safely log debug messages with potentially problematic data"""
    logger = logging.getLogger(__name__)
    try:
        # Encode the message safely to handle Unicode characters on Windows
        safe_message = message.encode('utf-8', errors='replace').decode('utf-8')
        if data is not None:
            safe_data = safe_log_data(data)
            logger.debug(f"{safe_message}: {safe_data}")
        else:
            logger.debug(safe_message)
    except (UnicodeEncodeError, UnicodeDecodeError) as e:
        # Fallback: log a simplified message without problematic characters
        simple_message = str(message).encode('ascii', errors='replace').decode('ascii')
        logger.debug(f"[Unicode Error in Log] {simple_message}")
        if data is not None:
            logger.debug(f"[Data] {str(data)[:100]}...")


def safe_info(message, data=None):
    """Safely log info messages with potentially problematic data"""
    logger = logging.getLogger(__name__)
    try:
        # Remove emojis and other Unicode characters that cause issues
        safe_message = str(message).encode('ascii', errors='ignore').decode('ascii')
        if data is not None:
            safe_data = safe_log_data(data)
            logger.info(f"{safe_message}: {safe_data}")
        else:
            logger.info(safe_message)
    except Exception as e:
        simple_message = str(message).encode('ascii', errors='replace').decode('ascii')
        logger.info(f"[Log Error] {simple_message}")
        if data is not None:
            logger.info(f"[Data] {str(data)[:100]}...")


def safe_warning(message, data=None):
    """Safely log warning messages with potentially problematic data"""
    logger = logging.getLogger(__name__)
    try:
        # Remove emojis and other Unicode characters that cause issues
        safe_message = str(message).encode('ascii', errors='ignore').decode('ascii')
        if data is not None:
            safe_data = safe_log_data(data)
            logger.warning(f"{safe_message}: {safe_data}")
        else:
            logger.warning(safe_message)
    except Exception as e:
        simple_message = str(message).encode('ascii', errors='replace').decode('ascii')
        logger.warning(f"[Unicode Error in Log] {simple_message}")
        if data is not None:
            logger.warning(f"[Data] {str(data)[:100]}...")


def safe_error(message, data=None):
    """Safely log error messages with potentially problematic data"""
    logger = logging.getLogger(__name__)
    try:
        safe_message = message.encode('utf-8', errors='replace').decode('utf-8')
        if data is not None:
            safe_data = safe_log_data(data)
            logger.error(f"{safe_message}: {safe_data}")
        else:
            logger.error(safe_message)
    except (UnicodeEncodeError, UnicodeDecodeError) as e:
        simple_message = str(message).encode('ascii', errors='replace').decode('ascii')
        logger.error(f"[Unicode Error in Log] {simple_message}")
        if data is not None:
            logger.error(f"[Data] {str(data)[:100]}...")


def safe_exception(message, exception=None):
    """Safely log exceptions with potentially problematic data"""
    logger = logging.getLogger(__name__)
    if exception is not None:
        safe_exc = str(exception).encode('utf-8', errors='replace').decode('utf-8')
        logger.exception(f"{message}: {safe_exc}")
    else:
        logger.exception(message)
