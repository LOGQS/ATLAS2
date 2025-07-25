# status: to expand later

"""
This module contains the configurations for the application.
"""

import os
import json
import logging
from pathlib import Path

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
    },
    # UI Settings
    "defaultModel": "gemini-2.5-flash",
    "ttsButtonEnabled": False,
    "sttButtonEnabled": False,
    "copyButtonEnabled": False,
    "modelParametersEnabled": False,
    "imageAnnotationEnabled": False,
    "summarizeButtonEnabled": False,
    "ttsVoice": "default",
    "ttsSpeed": 1.0,
    "generationSettings": {
        "temperature": None,
        "maxTokens": None
    }
}

# Settings management
def load_settings():
    """Load settings from file or return defaults"""
    try:
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data")))
        settings_file = data_dir / "settings.json"
        
        if settings_file.exists():
            with open(settings_file, 'r') as f:
                loaded_settings = json.load(f)
                # Merge with defaults to ensure all keys exist
                merged_settings = DEFAULT_SETTINGS.copy()
                merged_settings.update(loaded_settings)
                return merged_settings
    except Exception as e:
        logging.warning(f"Failed to load settings: {e}")
    return DEFAULT_SETTINGS.copy()

def save_settings(settings_data):
    """Save settings to file"""
    try:
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data")))
        data_dir.mkdir(exist_ok=True)
        
        settings_file = data_dir / "settings.json"
        with open(settings_file, 'w') as f:
            json.dump(settings_data, f, indent=2)
        return True
    except Exception as e:
        logging.error(f"Failed to save settings: {e}")
        return False

def get_valid_setting_keys():
    """Get set of valid setting keys"""
    return set(DEFAULT_SETTINGS.keys())