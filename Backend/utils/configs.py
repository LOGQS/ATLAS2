# status: to expand later

"""
This module contains the configurations for the application.
"""

# Supported file types based on Gemini API documentation
SUPPORTED_MIME_TYPES = {
    "image": [
        "image/jpeg", 
        "image/png", 
        "image/gif", 
        "image/webp", 
        "image/tiff",
        "image/heic",
        "image/heif"
    ],
    "video": [
        "video/mp4", 
        "video/mpeg", 
        "video/quicktime", 
        "video/x-msvideo",
        "video/mov",
        "video/avi",
        "video/x-flv",
        "video/mpg",
        "video/webm",
        "video/wmv",
        "video/3gpp"
    ],
    "audio": [
        "audio/mpeg",
        "audio/mp3",
        "audio/wav",
        "audio/ogg",
        "audio/webm",
        "audio/aac",
        "audio/flac",
        "audio/x-m4a"
    ],
    "document": [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.oasis.opendocument.text",
        "application/msword",
        "text/plain",
        "application/javascript",
        "text/javascript",
        "application/json",
        "text/html",
        "text/css",
        "application/xml",
        "text/xml",
        "text/markdown",
        "text/csv",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/x-python",
        "application/x-python",
        "text/python",
        "application/rtf",
        "text/rtf"
    ]
}

# Define which file types need processing
PROCESSING_FILE_TYPES = {
    "document": [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.oasis.opendocument.text",
        "application/msword",
        "application/rtf"
    ]
}

# Default settings
DEFAULT_SETTINGS = {
    "model": "gemini-2.5-flash",
    "safety_settings": {
        "harassment": "BLOCK_NONE",
        "hate_speech": "BLOCK_NONE",
        "sexually_explicit": "BLOCK_NONE",
        "dangerous_content": "BLOCK_NONE"
    }
}