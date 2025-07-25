# status: to implement, move to later

"""
This module contains logging helper functions for the application.
"""

import logging
from utils.extra import safe_log_data
from utils.data_handler import encoder_cycler


def safe_debug(message, data=None):
    """Safely log debug messages with potentially problematic data"""
    logger = logging.getLogger()
    try:
        safe_message = encoder_cycler(message)
        if data is not None:
            safe_data = encoder_cycler(safe_log_data(data))
            logger.debug(f"{safe_message}: {safe_data}")
        else:
            logger.debug(safe_message)
    except Exception as e:
        logger.debug(f"[Log Error] {encoder_cycler(str(message))}")
        if data is not None:
            logger.debug(f"[Data] {encoder_cycler(str(data)[:100])}...")


def safe_info(message, data=None):
    """Safely log info messages with potentially problematic data"""
    logger = logging.getLogger()
    try:
        safe_message = encoder_cycler(message)
        if data is not None:
            safe_data = encoder_cycler(safe_log_data(data))
            logger.info(f"{safe_message}: {safe_data}")
        else:
            logger.info(safe_message)
    except Exception as e:
        logger.info(f"[Log Error] {encoder_cycler(str(message))}")
        if data is not None:
            logger.info(f"[Data] {encoder_cycler(str(data)[:100])}...")


def safe_warning(message, data=None):
    """Safely log warning messages with potentially problematic data"""
    logger = logging.getLogger()  
    try:
        safe_message = encoder_cycler(message)
        if data is not None:
            safe_data = encoder_cycler(safe_log_data(data))
            logger.warning(f"{safe_message}: {safe_data}")
        else:
            logger.warning(safe_message)
    except Exception as e:
        logger.warning(f"[Log Error] {encoder_cycler(str(message))}")
        if data is not None:
            logger.warning(f"[Data] {encoder_cycler(str(data)[:100])}...")


def safe_error(message, data=None):
    """Safely log error messages with potentially problematic data"""
    logger = logging.getLogger()  
    try:
        safe_message = encoder_cycler(message)
        if data is not None:
            safe_data = encoder_cycler(safe_log_data(data))
            logger.error(f"{safe_message}: {safe_data}")
        else:
            logger.error(safe_message)
    except Exception as e:
        logger.error(f"[Log Error] {encoder_cycler(str(message))}")
        if data is not None:
            logger.error(f"[Data] {encoder_cycler(str(data)[:100])}...")


def safe_exception(message, exception=None):
    """Safely log exceptions with potentially problematic data"""
    logger = logging.getLogger()  
    try:
        if exception is not None:
            safe_exc = encoder_cycler(str(exception))
            safe_msg = encoder_cycler(message)
            logger.exception(f"{safe_msg}: {safe_exc}")
        else:
            logger.exception(encoder_cycler(message))
    except Exception as e:
        logger.exception(f"[Log Error] {encoder_cycler(str(message))}")
