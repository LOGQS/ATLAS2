"""
Provider exception classes for async streaming.

Used by aegeantic's retry_stream() to identify retryable errors.
"""


class ProviderStreamError(Exception):
    """
    Error during async streaming that may be retryable.

    Raised by provider's generate_text_stream_async() methods.
    Caught by aegeantic's retry_stream() for automatic retry.
    """
    pass
