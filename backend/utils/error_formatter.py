# status: complete

"""
Error formatting utilities for consistent error handling across the application.
"""

from typing import Optional, Dict, Any
from utils.logger import get_logger

logger = get_logger(__name__)


class ErrorFormatter:
    """
    Formats error messages consistently across different components.
    Provides user-friendly error summaries and extracts key error information.
    """

    @staticmethod
    def format_error_message(
        error: Exception,
        context: str = "Operation",
        include_type: bool = True
    ) -> str:
        """
        Format an exception into a user-friendly error message.

        Args:
            error: The exception to format
            context: Context string describing what operation failed
            include_type: Whether to include the exception type in the message

        Returns:
            Formatted error message string
        """
        error_str = str(error)
        error_type = type(error).__name__

        if include_type and error_type != "RuntimeError":
            return f"{context} failed: [{error_type}] {error_str}"
        else:
            return f"{context} failed: {error_str}"

    @staticmethod
    def extract_error_info(error: Exception) -> Dict[str, Any]:
        """
        Extract structured information from an exception.

        Returns:
            Dict with keys: type, message, retryable, preview
        """
        from utils.retry_handler import RetryHandler

        error_str = str(error)
        error_type = type(error).__name__

        # Check if error is retryable
        retry_handler = RetryHandler()
        is_retryable, retry_reason, _, _ = retry_handler.is_retryable_error(error_str)

        # Create error preview (first 200 chars)
        preview = error_str[:200] if len(error_str) > 200 else error_str

        return {
            "type": error_type,
            "message": error_str,
            "retryable": is_retryable,
            "retry_reason": retry_reason,
            "preview": preview
        }

    @staticmethod
    def format_log_message(
        component: str,
        action: str,
        message: str,
        **kwargs
    ) -> str:
        """
        Format a log message with consistent [COMPONENT-ACTION] prefix.

        Args:
            component: Component name (e.g., "ROUTER", "CHAT", "TOOL")
            action: Action being performed (e.g., "RETRY", "ERROR", "SUCCESS")
            message: The log message
            **kwargs: Additional key-value pairs to include

        Returns:
            Formatted log message
        """
        prefix = f"[{component}-{action}]"
        suffix = " ".join(f"{k}={v}" for k, v in kwargs.items())
        if suffix:
            return f"{prefix} {message} ({suffix})"
        return f"{prefix} {message}"

    @staticmethod
    def create_error_preview(error_message: str, max_length: int = 200) -> str:
        """
        Create a truncated preview of an error message.

        Args:
            error_message: Full error message
            max_length: Maximum length for preview

        Returns:
            Truncated error message with ellipsis if needed
        """
        if len(error_message) <= max_length:
            return error_message

        return error_message[:max_length] + "..."
