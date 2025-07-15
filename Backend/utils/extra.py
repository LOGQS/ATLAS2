# status: to expand later

"""
This module contains extra helper functions that are used throughout the application for convenience.
"""

import os
import gc
from faster_whisper import WhisperModel

whisper_model = None

def safe_log_data(data, max_length=1000):
    """
    Safely convert data to string representation for logging,
    handling potential Unicode issues and truncating if too long.
    """
    try:
        if isinstance(data, dict):
            sanitized = {}
            for k, v in data.items():
                if k == "messages" and isinstance(v, list):
                    sanitized[k] = f"[{len(v)} messages]"
                elif isinstance(v, (dict, list)):
                    sanitized[k] = f"[complex data: {type(v).__name__}]"
                elif isinstance(v, str) and len(v) > 50:
                    sanitized[k] = v[:50] + "..."
                else:
                    sanitized[k] = v
            result = str(sanitized)
        elif isinstance(data, list) and len(data) > 10:
            result = f"[List with {len(data)} items]"
        else:
            result = str(data)
            
        if len(result) > max_length:
            result = result[:max_length] + "..."
            
        return result
    except Exception as e:
        return f"[Error serializing log data: {str(e)}]"
    

def cleanup_whisper_model():
    """
    Clean up the existing Whisper model and force garbage collection
    """
    global whisper_model
    try:
        if whisper_model is not None:
            print("Cleaning up existing Whisper model...")
            del whisper_model
            whisper_model = None
            print("Whisper model cleanup completed")
    except Exception as e:
        print(f"Error during Whisper model cleanup: {str(e)}")

def initialize_whisper_model():
    """
    Initialize the Whisper model with proper cleanup and OpenMP handling
    """
    global whisper_model
    try:
        # Clean up any existing model first
        cleanup_whisper_model()
        
        # Set additional OpenMP environment variables for this process
        os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'
        os.environ['OMP_NUM_THREADS'] = '1'
        
        # Force garbage collection before loading
        gc.collect()
        
        print("Loading Whisper model at startup...")
        
        # Initialize with explicit CPU settings to avoid GPU/CUDA issues
        whisper_model = WhisperModel(
            model_size_or_path="base",
            device="cpu",
            compute_type="int8",
            num_workers=1,  # Reduced from 4 to 1 to minimize OpenMP conflicts
            download_root=None,  # Use default cache
            local_files_only=False
        )
        
        print("Whisper model loaded successfully")
        return whisper_model
    except Exception as e:
        print(f"Error loading Whisper model: {str(e)}")
        # Clean up on failure
        cleanup_whisper_model()
        
        # If it's an OpenMP error, provide helpful information
        if "libiomp5md.dll" in str(e) or "OpenMP" in str(e):
            print("OpenMP conflict detected. The application will continue but audio transcription may not work. Try restarting the application or use the /api/whisper/reinitialize endpoint.")
        
        raise e