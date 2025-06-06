import os
import json
import base64
import logging
import time
import subprocess
import sys
import uuid
from flask import Flask, request, jsonify, Response, stream_with_context, make_response
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room
import threading
from queue import Queue
from dotenv import load_dotenv
from google import genai
from google.genai import types
from logging.handlers import RotatingFileHandler
import tempfile
from datetime import datetime
from faster_whisper import WhisperModel
from pathlib import Path
from utils.prompts import creations_system_instruction, summary_system_instruction
from utils.profile_manager import (
    load_profiles,
    create_profile,
    update_profile,
    delete_profile,
    list_files as profile_list_files,
    save_file as profile_save_file,
    delete_file as profile_delete_file,
    get_knowledge,
    get_profile_file_paths,
    should_attach_files_directly,
)
import gc
import ctypes
import signal
import atexit
from groq import Groq
from openai import OpenAI
import time
import requests
from html.parser import HTMLParser

# Set environment variables to handle OpenMP issues BEFORE importing any libraries
# This prevents the "libiomp5md.dll already initialized" error from faster_whisper
os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'
os.environ['OMP_NUM_THREADS'] = '1'  # Limit threads to reduce conflicts

# Force cleanup of any existing OpenMP runtime on Windows
if sys.platform == "win32":
    try:
        # Try to unload any existing libiomp5md.dll
        kernel32 = ctypes.windll.kernel32
        # Get handle to libiomp5md.dll if it exists
        lib_handle = kernel32.GetModuleHandleW("libiomp5md.dll")
        if lib_handle:
            print("Found existing libiomp5md.dll, attempting cleanup...")
            # Force garbage collection
            gc.collect()
            # Note: We can't safely FreeLibrary here as it might be in use
            # The environment variable will handle the duplicate warning
    except Exception as e:
        print(f"OpenMP cleanup attempt failed (this is usually safe to ignore): {e}")

# Create logs directory if it doesn't exist
logs_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
if not os.path.exists(logs_dir):
    os.makedirs(logs_dir)

# Define the log file path
log_file = os.path.join(logs_dir, 'atlas.log')

# Try to clean the log file if it already exists to ensure a fresh start
if os.path.exists(log_file):
    try:
        # Try to truncate the file rather than removing it
        # This is less likely to cause permission issues
        with open(log_file, 'w', encoding='utf-8') as f:
            pass  # Just truncate the file
    except (PermissionError, OSError) as e:
        # If we can't access the file, create a new one with timestamp
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        log_file = os.path.join(logs_dir, f'atlas_{timestamp}.log')
        print(f"Cannot access existing log file, creating new one: {log_file}")
        # We don't need to create the file - the handler will do that

# Configure logger with both console and file handlers
logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)

# Format for both handlers
log_format = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

# Console handler - Configure with UTF-8 encoding to handle Unicode characters
console_handler = logging.StreamHandler(stream=sys.stdout)
console_handler.setLevel(logging.DEBUG)
console_handler.setFormatter(log_format)

# File handler (rotating with max size of 10MB, keeping 5 backup files)
log_file = os.path.join(logs_dir, 'atlas.log')
file_handler = RotatingFileHandler(log_file, maxBytes=10*1024*1024, backupCount=5, encoding='utf-8')
file_handler.setLevel(logging.DEBUG)
file_handler.setFormatter(log_format)

# Add both handlers
logger.addHandler(console_handler)
logger.addHandler(file_handler)

logger.info("Logging configured to file: %s", log_file)

# Helper function to safely log complex data structures
def safe_log_data(data, max_length=1000):
    """
    Safely convert data to string representation for logging,
    handling potential Unicode issues and truncating if too long.
    """
    try:
        if isinstance(data, dict):
            # Create a sanitized copy with sensitive data removed/truncated
            sanitized = {}
            for k, v in data.items():
                # Skip logging message content entirely (might contain Unicode)
                if k == "messages" and isinstance(v, list):
                    sanitized[k] = f"[{len(v)} messages]"
                # Handle other complex nested structures
                elif isinstance(v, (dict, list)):
                    sanitized[k] = f"[complex data: {type(v).__name__}]"
                # Handle strings that might contain Unicode
                elif isinstance(v, str) and len(v) > 50:
                    sanitized[k] = v[:50] + "..."
                else:
                    sanitized[k] = v
            result = str(sanitized)
        elif isinstance(data, list) and len(data) > 10:
            result = f"[List with {len(data)} items]"
        else:
            result = str(data)
            
        # Truncate if the final result is too long
        if len(result) > max_length:
            result = result[:max_length] + "..."
            
        return result
    except Exception as e:
        return f"[Error serializing log data: {str(e)}]"

# Initialize Whisper model at startup
whisper_model = None

def cleanup_whisper_model():
    """
    Clean up the existing Whisper model and force garbage collection
    """
    global whisper_model
    try:
        if whisper_model is not None:
            logger.info("Cleaning up existing Whisper model...")
            # Delete the model reference
            del whisper_model
            whisper_model = None
            # Force garbage collection to clean up OpenMP resources
            gc.collect()
            logger.info("Whisper model cleanup completed")
    except Exception as e:
        logger.warning(f"Error during Whisper model cleanup: {str(e)}")

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
        
        logger.info("Loading Whisper model at startup...")
        
        # Initialize with explicit CPU settings to avoid GPU/CUDA issues
        whisper_model = WhisperModel(
            model_size_or_path="base",
            device="cpu",
            compute_type="int8",
            num_workers=1,  # Reduced from 4 to 1 to minimize OpenMP conflicts
            download_root=None,  # Use default cache
            local_files_only=False
        )
        
        logger.info("Whisper model loaded successfully")
        return whisper_model
    except Exception as e:
        logger.exception(f"Error loading Whisper model: {str(e)}")
        # Clean up on failure
        cleanup_whisper_model()
        
        # If it's an OpenMP error, provide helpful information
        if "libiomp5md.dll" in str(e) or "OpenMP" in str(e):
            logger.error("OpenMP conflict detected. The application will continue but audio transcription may not work. Try restarting the application or use the /api/whisper/reinitialize endpoint.")
        
        raise e

# Initialize the model
try:
    initialize_whisper_model()
except Exception as e:
    logger.exception(f"Error loading Whisper model at startup: {str(e)}")
    # We'll continue without the model and try to initialize it when needed

# Load environment variables
load_dotenv()

# Configure Google Generative AI
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
client = None

# Initialize Gemini client if API key is available
if GEMINI_API_KEY:
    try:
        # Initialize with longer timeout
        client = genai.Client(api_key=GEMINI_API_KEY)
        logger.info("Gemini client initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize Gemini client: {str(e)}")
        client = None
else:
    logger.warning("GEMINI_API_KEY not found in environment variables")

# Configure OpenRouter API
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
openrouter_client = None

# Initialize OpenRouter client if API key is available
if OPENROUTER_API_KEY:
    try:
        openrouter_client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=OPENROUTER_API_KEY,
        )
        logger.info("OpenRouter client initialized successfully")
    except ImportError:
        logger.warning("OpenAI library not installed. OpenRouter functionality will not be available.")
        openrouter_client = None
    except Exception as e:
        logger.error(f"Failed to initialize OpenRouter client: {str(e)}")
        openrouter_client = None
else:
    logger.info("OPENROUTER_API_KEY not found in environment variables")

# Configure Groq API
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
groq_client = None

# Initialize Groq client if API key is available
if GROQ_API_KEY:
    try:
        groq_client = Groq(
            api_key=GROQ_API_KEY,
        )
        logger.info("Groq client initialized successfully")
    except ImportError:
        logger.warning("OpenAI library not installed. Groq functionality will not be available.")
        groq_client = None
    except Exception as e:
        logger.error(f"Failed to initialize Groq client: {str(e)}")
        groq_client = None
else:
    logger.info("GROQ_API_KEY not found in environment variables")

# Initialize Flask app
app = Flask(__name__)
CORS(app)

# Initialize SocketIO for real-time communication
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Background chat processing system
class BackgroundChatProcessor:
    def __init__(self):
        self.processing_queue = Queue()
        self.active_processors = {}
        self.chat_states = {}
        self.processor_threads = {}
        self.shutdown_event = threading.Event()
        
    def start_background_processing(self, chat_id, messages, model_name, **kwargs):
        """Start background processing for a chat"""
        safe_info(f"Attempting to start background processing for chat {chat_id} with {len(messages) if messages else 0} messages")
        
        if chat_id in self.active_processors:
            # Already processing, add to queue
            safe_info(f"Chat {chat_id} already processing, adding to queue")
            self.processing_queue.put({
                'chat_id': chat_id,
                'messages': messages,
                'model_name': model_name,
                'kwargs': kwargs
            })
            return
            
        try:
            # Create new background processor
            processor_thread = threading.Thread(
                target=self._process_chat_background,
                args=(chat_id, messages, model_name, kwargs),
                daemon=True
            )
            
            self.active_processors[chat_id] = {
                'thread': processor_thread,
                'status': 'starting',
                'model': model_name
            }
            
            processor_thread.start()
            safe_info(f"Background processing thread started for chat {chat_id}")
        except Exception as e:
            safe_exception(f"Error starting background processing thread for {chat_id}", e)
        
    def _process_chat_background(self, chat_id, messages, model_name, kwargs):
        """Background processing thread for a chat"""
        safe_info(f"ENTERING background processing thread for chat {chat_id}")
        try:
            safe_info(f"Starting background processing for chat {chat_id} with model {model_name}")
            safe_info(f"Messages type: {type(messages)}, count: {len(messages) if hasattr(messages, '__len__') else 'unknown'}")
            
            if chat_id not in self.active_processors:
                safe_warning(f"Chat {chat_id} not found in active_processors!")
                return
                
            self.active_processors[chat_id]['status'] = 'processing'
            
            # Update chat state
            self.chat_states[chat_id] = {
                'status': 'processing',
                'current_response': '',
                'last_update': time.time()
            }
            
            # Create chat session if not exists
            if chat_id not in active_chats:
                chat = UnifiedChatSession(chat_id, model_name)
                # Initialize with provided messages
                for msg in messages:
                    if msg['role'] in ['user', 'assistant']:
                        chat.add_message(msg['role'], msg['content'])
                active_chats[chat_id] = chat
            
            chat = active_chats[chat_id]
            
            # Check if there's an unprocessed user message (no assistant response after it)
            latest_message = messages[-1] if messages else None
            safe_info(f"Latest message: {latest_message['role'] if latest_message else 'None'}")
            
            if latest_message and latest_message['role'] == 'user':
                # Check if this user message already has an assistant response
                chat_messages = chat.unified_history
                safe_info(f"Chat has {len(chat_messages)} messages")
                
                # If chat is empty or the last message is a user message, we need to process
                needs_processing = False
                if not chat_messages:
                    needs_processing = True
                    safe_info("Chat is empty, needs processing")
                elif chat_messages[-1]['role'] == 'user':
                    needs_processing = True
                    safe_info("Last message is user message, needs processing")
                else:
                    safe_info("Last message is assistant response, no processing needed")
                
                if needs_processing:
                    # Add user message to chat if it's not already there
                    if not chat_messages or chat_messages[-1]['content'] != latest_message['content']:
                        chat.add_message('user', latest_message['content'])
                        safe_info(f"Added new user message to background chat {chat_id}")
                        
                        # Save user message immediately
                        self._save_chat_state_incremental(chat_id, chat)
                    
                    # Get response using unified approach
                    safe_info(f"Getting chat response for background chat {chat_id} with model {model_name}")
                    response = self._get_chat_response(chat, model_name, latest_message, kwargs)
                    
                    if response:
                        safe_info(f"Got response object for background chat {chat_id}, starting streaming")
                        assistant_response = ""
                        
                        # Process streaming response
                        for chunk in response:
                            if self.shutdown_event.is_set():
                                break
                                
                            chunk_text = self._extract_chunk_text(chunk, model_name)
                            if chunk_text:
                                assistant_response += chunk_text
                                
                                # Update state
                                self.chat_states[chat_id]['current_response'] = assistant_response
                                self.chat_states[chat_id]['last_update'] = time.time()
                                
                                # Emit real-time update via WebSocket
                                socketio.emit('chat_update', {
                                    'chat_id': chat_id,
                                    'type': 'chunk',
                                    'content': chunk_text,
                                    'full_response': assistant_response
                                }, room=f'chat_{chat_id}')
                                
                                # Save incrementally every 1000 characters
                                if len(assistant_response) % 1000 == 0:
                                    self._save_chat_state_incremental(chat_id, chat, assistant_response)
                        
                        # Add complete response to chat
                        if assistant_response.strip():
                            chat.add_message('assistant', assistant_response)
                            
                        # Final save
                        self._save_chat_state_incremental(chat_id, chat)
                        
                        # Emit completion
                        socketio.emit('chat_update', {
                            'chat_id': chat_id,
                            'type': 'complete',
                            'final_response': assistant_response
                        }, room=f'chat_{chat_id}')
                        
                        safe_info(f"Background processing completed for chat {chat_id}")
                    else:
                        safe_warning(f"No response generated for background chat {chat_id} - response object is None")
                    
        except Exception as e:
            safe_exception(f"Error in background processing for chat {chat_id}", e)
            
            # Emit error
            socketio.emit('chat_update', {
                'chat_id': chat_id,
                'type': 'error',
                'error': str(e)
            }, room=f'chat_{chat_id}')
        finally:
            # Clean up
            if chat_id in self.active_processors:
                del self.active_processors[chat_id]
            if chat_id in self.chat_states:
                self.chat_states[chat_id]['status'] = 'idle'
                
    def _get_chat_response(self, chat, model_name, latest_message, kwargs):
        """Get chat response using existing unified approach"""
        try:
            safe_info(f"Starting _get_chat_response for model {model_name}")
            
            # Prepare message parts
            parts = [latest_message['content']] if latest_message.get('content') else []
            safe_info(f"Prepared {len(parts)} message parts")
            
            # Get history for provider
            history_for_provider = chat.get_history_for_provider(model_name)
            safe_info(f"Got {len(history_for_provider)} messages in history for provider")
            
            # Create response
            if supports_file_attachments(model_name) and len(parts) > 1:
                safe_info(f"Using create_gemini_chat_with_files")
                return create_gemini_chat_with_files(
                    parts, model_name, creations_system_instruction
                )
            else:
                safe_info(f"Using create_unified_chat_response with history of {len(history_for_provider)} messages")
                response = create_unified_chat_response(
                    history_for_provider, model_name, creations_system_instruction,
                    None, kwargs.get('temperature'), kwargs.get('max_tokens')
                )
                safe_info(f"create_unified_chat_response returned: {type(response)}")
                return response
        except Exception as e:
            safe_exception(f"Error getting chat response", e)
            return None
            
    def _extract_chunk_text(self, chunk, model_name):
        """Extract text from response chunk"""
        try:
            if hasattr(chunk, 'choices') and chunk.choices:
                delta = chunk.choices[0].delta
                if hasattr(delta, 'content') and delta.content:
                    return delta.content
            return ""
        except Exception as e:
            safe_warning(f"Error extracting chunk text: {e}")
            return ""
            
    def _save_chat_state_incremental(self, chat_id, chat, partial_response=None):
        """Save chat state incrementally to persistent storage"""
        try:
            # Load existing chat history
            data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
            chats_file = data_dir / "chats.json"
            
            chat_history = {"chats": []}
            if chats_file.exists():
                try:
                    with open(chats_file, "r", encoding="utf-8") as f:
                        chat_history = json.load(f)
                except json.JSONDecodeError:
                    pass
            
            # Convert chat messages to save format
            formatted_messages = []
            for msg in chat.unified_history:
                formatted_msg = {
                    "role": msg["role"],
                    "content": msg["content"],
                    "timestamp": datetime.fromtimestamp(msg.get("timestamp", time.time())).isoformat(),
                    "tags": msg.get("tags", [])
                }
                if "reasoning" in msg:
                    formatted_msg["reasoning"] = msg["reasoning"]
                formatted_messages.append(formatted_msg)
                
            # Add partial response if provided
            if partial_response:
                formatted_messages.append({
                    "role": "assistant",
                    "content": partial_response,
                    "timestamp": datetime.now().isoformat(),
                    "tags": [],
                    "partial": True  # Mark as partial
                })
            
            # Find and update chat entry
            chat_updated = False
            for chat_entry in chat_history.get("chats", []):
                if chat_entry.get("id") == chat_id:
                    chat_entry["updated_at"] = datetime.now().isoformat()
                    chat_entry["messages"] = formatted_messages
                    if partial_response:
                        chat_entry["status"] = "streaming"
                    else:
                        chat_entry.pop("status", None)  # Remove streaming status
                    chat_updated = True
                    break
            
            # Create new entry if not found
            if not chat_updated:
                timestamp = datetime.now().isoformat()
                new_entry = {
                    "id": chat_id,
                    "title": "Background Chat",
                    "model": chat.current_model,
                    "created_at": timestamp,
                    "updated_at": timestamp,
                    "first_message": formatted_messages[0]["content"][:100] if formatted_messages else "",
                    "messages": formatted_messages
                }
                if partial_response:
                    new_entry["status"] = "streaming"
                chat_history.setdefault("chats", []).append(new_entry)
            
            # Save atomically
            temp_file = chats_file.with_suffix('.tmp')
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(chat_history, f, indent=2, ensure_ascii=False)
            temp_file.replace(chats_file)
            
        except Exception as e:
            safe_warning(f"Error saving chat state incrementally: {e}")
            
    def get_chat_status(self, chat_id):
        """Get current status of a chat"""
        if chat_id in self.active_processors:
            return self.active_processors[chat_id]['status']
        return 'idle'
        
    def stop_background_processing(self, chat_id):
        """Stop background processing for a chat"""
        if chat_id in self.active_processors:
            # Signal shutdown for this specific chat
            # This is a simplified approach - in a more complex system,
            # you'd have per-chat shutdown events
            return True
        return False
        
    def shutdown(self):
        """Shutdown all background processing"""
        self.shutdown_event.set()
        
# Global background processor
background_processor = BackgroundChatProcessor()

# Remove any content length limit
app.config['MAX_CONTENT_LENGTH'] = None

# Set up Flask logger to use our configured handlers
app.logger.handlers = []
for handler in logger.handlers:
    app.logger.addHandler(handler)
app.logger.setLevel(logging.DEBUG)

# Ensure data directory exists at startup
data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
temp_files_dir = data_dir / "temp_files"
try:
    data_dir.mkdir(exist_ok=True)
    temp_files_dir.mkdir(exist_ok=True)
    logger.info(f"Data directory created/verified at: {data_dir}")
    logger.info(f"Temp files directory created/verified at: {temp_files_dir}")
    
    # Clean up any existing temp files on startup
    import glob
    temp_file_pattern = str(temp_files_dir / "*")
    existing_temp_files = glob.glob(temp_file_pattern)
    if existing_temp_files:
        logger.info(f"Cleaning up {len(existing_temp_files)} existing temp files on startup")
        for temp_file in existing_temp_files:
            try:
                os.remove(temp_file)
            except Exception as cleanup_error:
                logger.warning(f"Failed to cleanup temp file {temp_file}: {cleanup_error}")
    
except Exception as e:
    logger.error(f"Failed to create data/temp directories: {str(e)}")

# Define chats file path within the data directory
chats_file = data_dir / "chats.json"

# Ensure chats.json exists at startup
try:
    if not chats_file.exists():
        with open(chats_file, 'w', encoding='utf-8') as f:
            json.dump({"chats": []}, f, indent=2) # Start with an empty JSON object
        logger.info(f"Created empty chats file at: {chats_file}")
    else:
        # Optional: Validate if the file is valid JSON, log if not
        try:
            with open(chats_file, 'r', encoding='utf-8') as f:
                json.load(f)
            logger.info(f"Chats file verified at: {chats_file}")
        except json.JSONDecodeError:
            logger.warning(f"Chats file at {chats_file} is not valid JSON. It might be corrupted or empty.")
except Exception as e:
    logger.error(f"Failed to create or verify chats file: {str(e)}")

# Add safe_log method to app context for consistent logging
def safe_debug(message, data=None):
    """Safely log debug messages with potentially problematic data"""
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
    if exception is not None:
        safe_exc = str(exception).encode('utf-8', errors='replace').decode('utf-8')
        logger.exception(f"{message}: {safe_exc}")
    else:
        logger.exception(message)

# Add these to Flask app context
app.safe_debug = safe_debug
app.safe_info = safe_info  
app.safe_warning = safe_warning
app.safe_error = safe_error
app.safe_exception = safe_exception

# Dictionary to store chat sessions
active_chats = {}

# WebSocket event handlers
@socketio.on('connect')
def handle_connect():
    safe_info(f"Client connected: {request.sid}")
    emit('connected', {'status': 'Connected to ATLAS backend'})
    
@socketio.on('disconnect')
def handle_disconnect():
    safe_info(f"Client disconnected: {request.sid}")
    
@socketio.on('join_chat')
def handle_join_chat(data):
    chat_id = data.get('chat_id')
    if chat_id:
        join_room(f'chat_{chat_id}')
        safe_info(f"Client {request.sid} joined chat room: {chat_id}")
        
        # Send current chat status
        status = background_processor.get_chat_status(chat_id)
        emit('chat_status', {
            'chat_id': chat_id,
            'status': status
        })
        
@socketio.on('leave_chat')
def handle_leave_chat(data):
    chat_id = data.get('chat_id')
    if chat_id:
        leave_room(f'chat_{chat_id}')
        safe_info(f"Client {request.sid} left chat room: {chat_id}")
        
@socketio.on('start_background_chat')
def handle_start_background_chat(data):
    """Start background processing for a chat"""
    try:
        chat_id = data.get('chat_id')
        messages = data.get('messages', [])
        model_name = data.get('model', settings['model'])
        kwargs = {
            'temperature': data.get('temperature'),
            'max_tokens': data.get('max_tokens')
        }
        
        if not chat_id or not messages:
            emit('error', {'message': 'Invalid chat data'})
            return
            
        # Start background processing
        background_processor.start_background_processing(
            chat_id, messages, model_name, **kwargs
        )
        
        emit('background_started', {
            'chat_id': chat_id,
            'status': 'processing'
        })
        
    except Exception as e:
        safe_exception("Error starting background chat", e)
        emit('error', {'message': str(e)})



# Supported file types - expanded based on Gemini API documentation
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

# Define which file types need processing (typically documents)
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
    "model": "gemini-2.5-flash-preview-05-20",
    "safety_settings": {
        "harassment": "BLOCK_NONE",
        "hate_speech": "BLOCK_NONE",
        "sexually_explicit": "BLOCK_NONE",
        "dangerous_content": "BLOCK_NONE"
    }
}

# Global settings
settings = DEFAULT_SETTINGS.copy()

def load_whisper_model():
    """
    Get the Whisper model - either the global one or initialize if needed
    """
    global whisper_model
    if whisper_model is None:
        logger.info("Whisper model not initialized at startup, loading now...")
        try:
            return initialize_whisper_model()
        except Exception as e:
            logger.exception(f"Error loading Whisper model: {str(e)}")
            raise e
    return whisper_model

def check_gemini_client():
    """
    Check if Gemini client is available and return an error response if not
    """
    if client is None:
        return {"error": "Gemini API client not available. Please check your GEMINI_API_KEY environment variable."}, 503
    return None, None

def is_openrouter_model(model_name):
    """
    Check if the given model name is an OpenRouter model
    """
    openrouter_models = ["deepseek/deepseek-r1-0528:free", "tngtech/deepseek-r1t-chimera:free"]
    return model_name in openrouter_models

def is_groq_model(model_name):
    """
    Check if the given model name is a Groq model
    """
    groq_models = ["llama-3.3-70b-versatile"]
    return model_name in groq_models

def is_gemini_model(model_name):
    """
    Check if the given model name is a Gemini model
    """
    # More flexible detection - any model starting with "gemini-" is a Gemini model
    return model_name.startswith("gemini-")

def supports_file_attachments(model_name):
    """
    Check if the model supports file attachments
    """
    return is_gemini_model(model_name)

class UnifiedChatSession:
    """
    Unified chat session that can switch between different AI providers
    while maintaining consistent history
    """
    
    def __init__(self, chat_id, initial_model=None):
        self.id = chat_id
        self.current_model = initial_model or settings["model"]
        self.unified_history = []  # OpenAI-compatible format
        self.files = set()  # Track uploaded files
        self.created_at = time.time()
        self.last_updated = time.time()
        
    def add_message(self, role, content, reasoning=None):
        """Add a message to the unified history"""
        message = {
            "role": role,
            "content": content,
            "timestamp": time.time(),
            "model": self.current_model
        }
        if reasoning:
            message["reasoning"] = reasoning
        
        self.unified_history.append(message)
        self.last_updated = time.time()
        
    def switch_model(self, new_model):
        """Switch to a different model while preserving history"""
        if new_model != self.current_model:
            safe_info(f"Switching chat {self.id} from {self.current_model} to {new_model}")
            self.current_model = new_model
            self.last_updated = time.time()
            
    def get_history_for_provider(self, model_name=None):
        """Get chat history formatted for the specified provider"""
        target_model = model_name or self.current_model
        
        # Return OpenAI-compatible format (works for all providers)
        formatted_history = []
        for msg in self.unified_history:
            if msg["role"] in ["user", "assistant"]:
                formatted_msg = {
                    "role": msg["role"],
                    "content": msg["content"]
                }
                formatted_history.append(formatted_msg)
                
        return formatted_history
        
    def get_history_length(self):
        """Get the number of messages in history"""
        return len(self.unified_history)
        
    def clear_history(self):
        """Clear all chat history"""
        self.unified_history = []
        self.last_updated = time.time()
        
    def get_last_user_message(self):
        """Get the most recent user message"""
        for msg in reversed(self.unified_history):
            if msg["role"] == "user":
                return msg["content"]
        return None
    
    def get_history(self):
        """Get the complete unified history (for legacy compatibility)"""
        return self.unified_history

def get_openai_client_for_model(model_name):
    """
    Get the appropriate OpenAI client based on the model type
    """
    if is_groq_model(model_name):
        if not GROQ_API_KEY:
            raise Exception("Groq API key not available")
        return OpenAI(
            base_url="https://api.groq.com/openai/v1",
            api_key=GROQ_API_KEY,
        )
    elif is_openrouter_model(model_name):
        if not openrouter_client:
            raise Exception("OpenRouter client not available")
        return openrouter_client
    elif is_gemini_model(model_name):
        # Use Gemini via OpenAI compatibility for unified interface
        if not GEMINI_API_KEY:
            raise Exception("Gemini API key not available")
        return OpenAI(
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
            api_key=GEMINI_API_KEY,
        )
    else:
        raise Exception(f"No client available for model: {model_name}")

def generate_chat_summary(messages, model_name):
    """Generate a summary of the conversation using Gemini Flash"""
    # Always use Gemini Flash for summarization regardless of the chat model
    summary_model = "gemini-2.5-flash-preview-05-20"
    
    try:
        
        # Use global client variable to avoid scoping issues
        global client
        
        # Check if Gemini client is available
        if client is None:
            safe_error("Gemini client not available")
            return "Failed to generate summary: Gemini client not available"

        # Build the conversation history for the Gemini API
        conversation_parts = [summary_system_instruction + "\n\nConversation to summarize:"]

        for msg in messages:
            role = msg.get("role")
            content = msg.get("content", "")
            if role in ["user", "assistant"] and content.strip():
                conversation_parts.append(f"{role.title()}: {content}")

        # Combine all parts into a single prompt
        full_prompt = "\n\n".join(conversation_parts)
        
        # Use the native Gemini API for summarization
        response = client.models.generate_content(
            model=summary_model,
            contents=[full_prompt],
            config=types.GenerateContentConfig(
                safety_settings=[
                    {
                        "category": "HARM_CATEGORY_HARASSMENT",
                        "threshold": "BLOCK_NONE"
                    },
                    {
                        "category": "HARM_CATEGORY_HATE_SPEECH",
                        "threshold": "BLOCK_NONE"
                    },
                    {
                        "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                        "threshold": "BLOCK_NONE"
                    },
                    {
                        "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                        "threshold": "BLOCK_NONE"
                    }
                ]
            )
        )

        if response and response.candidates and len(response.candidates) > 0:
            candidate = response.candidates[0]
            if hasattr(candidate, 'content') and hasattr(candidate.content, 'parts') and len(candidate.content.parts) > 0:
                summary = candidate.content.parts[0].text.strip()
                safe_debug(f"Summary generated successfully, length: {len(summary)} chars")
                return summary
            else:
                safe_error("No content found in Gemini response")
                return "Failed to generate summary: No content in response"
        else:
            safe_error(f"Invalid response format from Gemini API. Response: {response}")
            return "Failed to generate summary: Invalid response format"
    except Exception as e:
        safe_exception(f"Error in generate_chat_summary: {str(e)}", e)
        return f"Failed to generate summary: {str(e)}"

class GeminiToOpenAIAdapter:
    """Adapter to make Gemini streaming responses compatible with OpenAI format"""
    def __init__(self, gemini_stream):
        self.gemini_stream = gemini_stream
    
    def __iter__(self):
        return self
    
    def __next__(self):
        try:
            chunk = next(self.gemini_stream)
            # Convert Gemini chunk to OpenAI-compatible format
            return self._convert_chunk(chunk)
        except StopIteration:
            raise
    
    def _convert_chunk(self, gemini_chunk):
        """Convert Gemini chunk to OpenAI-compatible chunk"""
        class MockChoice:
            def __init__(self, content):
                self.delta = MockDelta(content)
        
        class MockDelta:
            def __init__(self, content):
                self.content = content
        
        class MockChunk:
            def __init__(self, content):
                self.choices = [MockChoice(content)]
        
        # Extract text from Gemini chunk
        content = getattr(gemini_chunk, 'text', '') if hasattr(gemini_chunk, 'text') else ''
        return MockChunk(content)

def create_unified_chat_response(messages, model_name, system_instruction=None, files=None, temperature=None, max_tokens=None):
    """
    Create a chat response using unified OpenAI-compatible APIs for all providers
    """
    client_for_model = get_openai_client_for_model(model_name)
    
    # Convert messages to OpenAI format
    openai_messages = []
    
    # Add system message first if provided
    if system_instruction:
        openai_messages.append({
            "role": "system",
            "content": system_instruction
        })
    
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content", "")
        
        # Convert role if needed
        if role == "assistant":
            role = "assistant"
        elif role == "user":
            role = "user"
        else:
            continue  # Skip unsupported roles
            
        openai_messages.append({
            "role": role,
            "content": content
        })
    
    # Create request parameters
    params = {
        "model": model_name,
        "messages": openai_messages,
        "stream": True
    }
    if temperature is not None:
        params["temperature"] = float(temperature)
    if max_tokens is not None:
        params["max_tokens"] = int(max_tokens)
    
    # Add reasoning tokens for OpenRouter models that support it
    if is_openrouter_model(model_name):
        params["extra_body"] = {"include_reasoning": True}
    
    # Use the OpenAI client to create the response
    response = client_for_model.chat.completions.create(**params)
    
    # Return the response object that can be iterated over for streaming
    return response

def create_gemini_chat_with_files(parts, model_name, system_instruction=None):
    """
    Create a Gemini chat response with files using native API
    Returns OpenAI-compatible format for streaming
    """
    # Count actual files vs text parts
    file_count = sum(1 for part in parts if not isinstance(part, str))
    text_parts = sum(1 for part in parts if isinstance(part, str))
    safe_debug(f"Using native Gemini API for model {model_name} with {len(parts)} parts ({file_count} files, {text_parts} text)")
    
    # Prepare safety settings
    safety_settings = []
    if settings.get("safety_settings"):
        safety_settings = [
            {
                "category": "HARM_CATEGORY_HARASSMENT",
                "threshold": settings.get("safety_settings", {}).get("harassment", "BLOCK_NONE")
            },
            {
                "category": "HARM_CATEGORY_HATE_SPEECH",
                "threshold": settings.get("safety_settings", {}).get("hate_speech", "BLOCK_NONE")
            },
            {
                "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "threshold": settings.get("safety_settings", {}).get("sexually_explicit", "BLOCK_NONE")
            },
            {
                "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                "threshold": settings.get("safety_settings", {}).get("dangerous_content", "BLOCK_NONE")
            }
        ]

    # Configure the model with safety settings and system instruction
    config = types.GenerateContentConfig(
        safety_settings=safety_settings,
        system_instruction=system_instruction if system_instruction else None
    )
    
    # For Gemini with files, use the native API with files as parts
    response = client.models.generate_content_stream(
        model=model_name,
        contents=parts,  # parts contains the array with text and file objects
        config=config
    )
    
    # Wrap Gemini response to be OpenAI-compatible
    return GeminiToOpenAIAdapter(response)

def create_openai_compatible_chat_response(messages, model_name, system_instruction=None, temperature=None, max_tokens=None):
    """
    Create a chat response using OpenAI-compatible APIs (OpenRouter, Groq, etc.)
    """
    client = get_openai_client_for_model(model_name)
    
    # Convert messages to OpenAI format
    openai_messages = []
    
    # Add system message first if provided
    if system_instruction:
        openai_messages.append({
            "role": "system",
            "content": system_instruction
        })
    
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content", "")
        
        # Convert role if needed
        if role == "assistant":
            role = "assistant"
        elif role == "user":
            role = "user"
        else:
            continue  # Skip unsupported roles
            
        openai_messages.append({
            "role": role,
            "content": content
        })
    
    # Create request parameters
    params = {
        "model": model_name,
        "messages": openai_messages,
        "stream": True
    }
    if temperature is not None:
        params["temperature"] = float(temperature)
    if max_tokens is not None:
        params["max_tokens"] = int(max_tokens)
    
    # Add reasoning tokens for OpenRouter models that support it
    if is_openrouter_model(model_name):
        params["extra_body"] = {"include_reasoning": True}
    
    # Use the OpenAI client to create the response
    response = client.chat.completions.create(**params)
    
    # Return the response object that can be iterated over for streaming
    return response



# Get available models
@app.route("/api/models", methods=["GET"])
def get_models():
    models = []
    
    # Add Gemini models if client is available
    if client is not None:
        models.extend([
            "gemini-2.0-flash-exp",
            "gemini-2.5-flash-preview-05-20", 
            "gemini-2.5-pro-exp-03-25"
        ])
    
    # Add OpenRouter models if available
    if openrouter_client and OPENROUTER_API_KEY:
        models.extend(["deepseek/deepseek-r1-0528:free", "tngtech/deepseek-r1t-chimera:free"])
    
    # Add Groq models if available
    if GROQ_API_KEY:
        models.extend(["llama-3.3-70b-versatile"])
    
    return jsonify({
        "models": models,
        "available_clients": {
            "gemini": client is not None,
            "openrouter": openrouter_client is not None and OPENROUTER_API_KEY is not None,
            "groq": GROQ_API_KEY is not None
        }
    })

# Get current settings
@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify(settings)

# Update settings
@app.route("/api/settings", methods=["POST"])
def update_settings():
    data = request.json
    
    # Update only valid settings
    for key in data:
        if key in settings:
            settings[key] = data[key]
    
    return jsonify(settings)

# Switch model for an existing chat
@app.route("/api/chat/<chat_id>/switch-model", methods=["POST"])
def switch_chat_model(chat_id):
    """Switch the model for an existing chat session"""
    try:
        data = request.json
        new_model = data.get("model")
        
        if not new_model:
            return jsonify({"error": "Model is required"}), 400
            
        # Validate that we have the necessary client for the new model
        if is_openrouter_model(new_model):
            if not openrouter_client or not OPENROUTER_API_KEY:
                return jsonify({"error": f"OpenRouter model '{new_model}' requested but OpenRouter client not available. Please check your OPENROUTER_API_KEY."}), 503
        elif is_groq_model(new_model):
            if not GROQ_API_KEY:
                return jsonify({"error": f"Groq model '{new_model}' requested but Groq API key not available. Please check your GROQ_API_KEY."}), 503
        elif is_gemini_model(new_model):
            if not GEMINI_API_KEY:
                return jsonify({"error": f"Gemini model '{new_model}' requested but Gemini API key not available. Please check your GEMINI_API_KEY."}), 503
        else:
            return jsonify({"error": f"Unknown model: {new_model}"}), 400
        
        # Check if chat exists
        if chat_id not in active_chats:
            return jsonify({"error": "Chat not found"}), 404
            
        chat = active_chats[chat_id]
        previous_model = getattr(chat, 'current_model', 'unknown')
        
        # Convert old chat to UnifiedChatSession if needed
        if not isinstance(chat, UnifiedChatSession):
            # Convert legacy chat to unified format
            unified_chat = UnifiedChatSession(chat_id, new_model)
            
            # Try to extract history from the old chat
            try:
                if hasattr(chat, 'external_history'):
                    # OpenRouter/Groq chat
                    for msg in chat.external_history:
                        unified_chat.add_message(
                            msg.get("role"),
                            msg.get("content", ""),
                            msg.get("reasoning")
                        )
                elif hasattr(chat, 'get_history'):
                    # Gemini chat - get history and convert
                    history = chat.get_history()
                    if history:
                        for msg in history:
                            role = "assistant" if msg.role == "model" else msg.role
                            content = ""
                            if hasattr(msg, 'parts'):
                                for part in msg.parts:
                                    if hasattr(part, 'text') and part.text:
                                        content += part.text
                            
                            if role in ["user", "assistant"] and content:
                                unified_chat.add_message(role, content)
                                
                # Preserve file associations
                if hasattr(chat, 'files'):
                    unified_chat.files = chat.files
                    
            except Exception as e:
                safe_warning(f"Error converting chat history during model switch: {str(e)}")
                # Continue with empty history rather than failing
                
            # Replace the old chat with the unified one
            active_chats[chat_id] = unified_chat
            chat = unified_chat
        else:
            # Already a UnifiedChatSession, just switch the model
            previous_model = chat.current_model
            chat.switch_model(new_model)
        
        # Update chat history in file
        try:
            data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
            chats_file = data_dir / "chats.json"
            
            if chats_file.exists():
                with open(chats_file, "r", encoding="utf-8") as f:
                    chat_history = json.load(f)
                
                # Update the chat entry
                for chat_entry in chat_history.get("chats", []):
                    if chat_entry.get("id") == chat_id:
                        chat_entry["model"] = new_model
                        chat_entry["updated_at"] = datetime.now().isoformat()
                        break
                
                # Save updated chat history
                with open(chats_file, "w", encoding="utf-8") as f:
                    json.dump(chat_history, f, indent=2, ensure_ascii=False)
        except Exception as e:
            safe_warning(f"Failed to update chat model in history file: {str(e)}")
        
        return jsonify({
            "success": True,
            "message": f"Switched chat {chat_id} to model {new_model}",
            "chat_id": chat_id,
            "new_model": new_model,
            "previous_model": previous_model,
            "supports_files": supports_file_attachments(new_model),
            "history_length": chat.get_history_length() if hasattr(chat, 'get_history_length') else 0
        })
        
    except Exception as e:
        safe_exception(f"Error switching chat model: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# List uploaded files
@app.route("/api/files", methods=["GET"])
def list_files():
    try:
        # Check if Gemini client is available
        error_response, status_code = check_gemini_client()
        if error_response:
            return jsonify(error_response), status_code
            
        files = []
        for file in client.files.list():
            files.append({
                "name": file.name,
                "uri": file.uri if hasattr(file, "uri") else None,
                "state": file.state.name if hasattr(file, "state") else "UNKNOWN"
            })
        return jsonify({"files": files})
    except Exception as e:
        logger.exception(f"Error listing files: {str(e)}")
        return jsonify({"error": str(e)}), 500

# List uploaded documents specifically
@app.route("/api/documents", methods=["GET"])
def list_documents():
    """List all uploaded documents specifically for document processing."""
    try:
        # Check if Gemini client is available
        error_response, status_code = check_gemini_client()
        if error_response:
            return jsonify(error_response), status_code
            
        documents = []
        for file in client.files.list():
            # Skip non-active files
            if hasattr(file, 'state') and file.state.name != 'ACTIVE':
                continue
                
            # Determine if this is a document based on URI pattern
            file_uri = getattr(file, 'uri', '')
            file_type = None
            mime_type = None
            
            # Try to determine the file type from the URI
            if hasattr(file, 'mime_type'):
                mime_type = file.mime_type
                
                # Check if it's a document by mime type
                for type_name, mime_list in SUPPORTED_MIME_TYPES.items():
                    if mime_type in mime_list:
                        file_type = type_name
                        break
            
            # Only include document types
            if file_type == 'document':
                documents.append({
                    "name": file.name,
                    "uri": file_uri,
                    "mime_type": mime_type,
                    "state": file.state.name if hasattr(file, 'state') else 'UNKNOWN',
                    "file_type": file_type
                })
                
        return jsonify({"documents": documents})
    except Exception as e:
        logger.exception(f"Error listing documents: {str(e)}")
        return jsonify({"error": str(e)}), 500

# Delete uploaded file
@app.route("/api/files/<file_id>", methods=["DELETE"])
def delete_file(file_id):
    try:
        client.files.delete(name=file_id)
        return jsonify({"success": True, "message": f"File {file_id} deleted successfully"})
    except Exception as e:
        logger.exception(f"Error deleting file {file_id}: {str(e)}")
        return jsonify({"error": str(e)}), 500

# Check file state
@app.route("/api/files/<file_id>/state", methods=["GET"])
def get_file_state(file_id):
    try:
        file = client.files.get(name=file_id)
        file_state = getattr(file.state, 'name', 'UNKNOWN') if hasattr(file, 'state') else 'UNKNOWN'
        return jsonify({
            "file_id": file_id,
            "state": file_state,
            "ready": file_state == "ACTIVE"
        })
    except Exception as e:
        safe_exception(f"Error getting file state for {file_id}", e)
        return jsonify({"error": str(e)}), 500

# File upload endpoint with enhanced file handling
@app.route("/api/upload", methods=["POST"])
def upload_file():
    safe_debug("Upload request received")
    
    # Check if Gemini client is available
    error_response, status_code = check_gemini_client()
    if error_response:
        return jsonify(error_response), status_code
    
    if 'file' not in request.files:
        safe_error("No file part in the request")
        return jsonify({"error": "No file part"}), 400
        
    file = request.files['file']
    
    if file.filename == '':
        safe_error("No file selected")
        return jsonify({"error": "No file selected"}), 400
        
    mime_type = file.content_type
    logger.debug(f"File mime type: {mime_type}")
    
    is_supported = False
    file_type = None
    
    # Check if the file type is supported
    for type_name, mime_list in SUPPORTED_MIME_TYPES.items():
        if mime_type in mime_list:
            is_supported = True
            file_type = type_name
            break
            
    if not is_supported:
        logger.error(f"Unsupported file type: {mime_type}")
        return jsonify({
            "error": "Unsupported file type", 
            "message": "Only supported file types are allowed."
        }), 400
    
    try:
        # Create a temporary file
        temp_dir = tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, file.filename)
        
        # Get file content and save to temporary file
        file_content = file.read()
        file_size = len(file_content)
        logger.debug(f"File size: {file_size} bytes")
        
        # For large files, log a warning but still try to process
        if file_size > 500 * 1024 * 1024:  # 500MB
            logger.warning(f"Very large file being processed: {file_size} bytes. This may take some time.")
        
        # Indicate if the file is large (over 20MB) for logging purposes
        is_large_file = file_size > 20 * 1024 * 1024
        if is_large_file:
            logger.debug(f"Large file (>20MB) detected")
        
        # Write to temporary file
        with open(temp_path, 'wb') as f:
            f.write(file_content)
        
        # For PDF files, save a local copy for direct serving (before Gemini processing)
        local_file_path = None
        if mime_type == "application/pdf":
            try:
                # We need to upload to Gemini first to get the file ID, then save locally
                pass  # Will be handled after Gemini upload
            except Exception as e:
                logger.warning(f"Failed to save PDF locally: {str(e)}")
                # Continue without local copy
        
        # Use the client.files.upload method with the temporary file path
        logger.debug(f"Uploading file to Gemini API: {file.filename}")
        logger.debug(f"Using mime_type: {mime_type}")
        
        try:
            # Upload with mime_type in config (using file path directly as shown in examples)
            uploaded_file = client.files.upload(
                file=temp_path,
                config=dict(mime_type=mime_type)
            )
            logger.debug(f"Upload successful, file ID: {uploaded_file.name}")
            
            # Clean up temporary file
            try:
                os.remove(temp_path)
                logger.debug(f"Removed temporary file: {temp_path}")
            except Exception as cleanup_error:
                logger.warning(f"Failed to remove temporary file {temp_path}: {str(cleanup_error)}")
            
            # Determine if this file type requires processing
            needs_processing = PROCESSING_FILE_TYPES.get(file_type, False)
            processing_complete = True  # Default to True
            
            # If file needs processing (like videos), check its state
            if needs_processing:
                logger.debug(f"File type {file_type} may need processing, checking state")
                # Set maximum wait time for processing (30 seconds)
                max_wait_time = 30
                start_time = time.time()
                processing = True
                
                # Wait until the file is ACTIVE or until we hit the time limit
                while processing and (time.time() - start_time) < max_wait_time:
                    # Get current file state
                    file_obj = client.files.get(name=uploaded_file.name)
                    file_state = getattr(file_obj.state, 'name', 'UNKNOWN')
                    
                    logger.debug(f"File processing state: {file_state}")
                    
                    if file_state == 'ACTIVE':
                        logger.debug(f"File processing complete, ready for use")
                        processing = False
                    elif file_state == 'FAILED':
                        logger.error(f"File processing failed")
                        return jsonify({
                            "error": "File processing failed",
                            "message": f"The {file_type} file could not be processed by the API."
                        }), 500
                    else:
                        # Still processing, wait before checking again
                        logger.debug(f"File still processing, waiting...")
                        time.sleep(2)
                
                # Check if we're still processing after the timeout
                if processing:
                    logger.warning(f"File processing timeout, returning file ID anyway")
                    processing_complete = False
            
            # For PDF files, save a local copy for direct serving (immediately available for viewing)
            local_file_path = None
            if mime_type == "application/pdf":
                try:
                    # Create a safe filename using the file ID (without files/ prefix)
                    clean_file_id = uploaded_file.name.replace("files/", "")
                    safe_filename = f"{clean_file_id}.pdf"
                    local_file_path = temp_files_dir / safe_filename
                    
                    # Save the file content directly
                    with open(local_file_path, 'wb') as f:
                        f.write(file_content)
                    logger.info(f"Saved PDF copy to local storage: {local_file_path} ({len(file_content)} bytes)")
                except Exception as e:
                    logger.warning(f"Failed to save PDF locally: {str(e)}")
                    # Continue without local copy - will fall back to download endpoint

            # Return the file details
            response_data = {
                "success": True,
                "file_id": uploaded_file.name,
                "file_type": file_type,
                "mime_type": mime_type,
                "filename": file.filename,
                "original_name": file.filename,
                "size": file_size,
                "is_large_file": is_large_file
            }
            
            # Add local file path for PDFs
            if local_file_path and local_file_path.exists():
                response_data["local_file_available"] = True
            
            # Add processing status if relevant
            if needs_processing:
                response_data["processing_complete"] = processing_complete
                response_data["needs_processing"] = True
            
            logger.debug(f"Returning response: {response_data}")
            return jsonify(response_data)
            
        except Exception as e:
            error_type = type(e).__name__
            error_msg = str(e)
            logger.error(f"Upload error ({error_type}): {error_msg}")
            
            if "timeout" in error_msg.lower() or "timed out" in error_msg.lower():
                return jsonify({
                    "error": "Upload timeout", 
                    "message": "The file upload timed out. This could be due to file size or network conditions.",
                    "details": error_msg
                }), 408  # 408 Request Timeout
            else:
                raise  # Re-raise for the outer exception handler
        
    except Exception as e:
        logger.exception(f"Error uploading file to Gemini API: {str(e)}")
        
        # Provide a more user-friendly error message
        error_message = str(e)
        if "exceeds the maximum file size" in error_message:
            return jsonify({"error": "File too large for processing by Gemini API"}), 413
        elif "unsupported file type" in error_message.lower():
            return jsonify({"error": "This file type is not supported by Gemini API"}), 415
        elif "unknown mime type" in error_message.lower() or "mime_type" in error_message.lower():
            return jsonify({
                "error": "MIME type detection failed", 
                "message": "The system could not process this file format correctly.",
                "details": error_message
            }), 400
        else:
            return jsonify({
                "error": "Error uploading file to Gemini API", 
                "details": error_message
            }), 500

# Serve temp files (mainly for PDF viewing)
@app.route("/api/download/<file_id>", methods=["GET"])
def serve_temp_file(file_id):
    """Serve a temporary file (PDF) directly from local storage"""
    try:
        safe_info(f"Download request for file_id: {file_id}")
        
        # Clean file_id (remove files/ prefix if present)
        clean_file_id = file_id.replace("files/", "")
        safe_info(f"Clean file_id: {clean_file_id}")
        
        # Look for the file in temp storage
        temp_file_path = temp_files_dir / f"{clean_file_id}.pdf"
        safe_info(f"Looking for file at: {temp_file_path}")
        safe_info(f"File exists: {temp_file_path.exists()}")
        
        if temp_file_path.exists():
            safe_info(f"Serving PDF from local storage: {temp_file_path}")
            
            # Read the file content
            with open(temp_file_path, 'rb') as f:
                content = f.read()
            
            safe_info(f"Read {len(content)} bytes from local file")
            
            # Create response with proper headers for PDF
            response = make_response(content)
            response.headers.set('Content-Type', 'application/pdf')
            response.headers.set('Content-Disposition', f'inline; filename="{clean_file_id}.pdf"')
            response.headers.set('Cache-Control', 'no-cache')
            
            return response
        else:
            # File not found in local storage
            safe_error(f"File not found in local storage: {temp_file_path}")
            return jsonify({"error": "File not found"}), 404
            
    except Exception as e:
        safe_exception(f"Error serving file {file_id}: {str(e)}", e)
        return jsonify({"error": f"Failed to serve file: {str(e)}"}), 500

# Document cache endpoint - Creates a cache for document processing
@app.route("/api/cache", methods=["POST"])
def create_document_cache():
    """Create a document cache from a list of file IDs for optimized document processing"""
    try:
        data = request.json
        file_ids = data.get("file_ids", [])
        
        if not file_ids:
            return jsonify({"error": "file_ids parameter is required"}), 400
            
        # Check if Gemini client is available
        error_response, status_code = check_gemini_client()
        if error_response:
            return jsonify(error_response), status_code
        
        # Validate that all files exist and are ready
        valid_files = []
        for file_id in file_ids:
            try:
                file_obj = client.files.get(name=file_id)
                if hasattr(file_obj, 'state') and file_obj.state.name == 'ACTIVE':
                    valid_files.append(file_id)
                else:
                    safe_warning(f"File {file_id} is not in ACTIVE state, skipping from cache")
            except Exception as e:
                safe_warning(f"Error validating file {file_id}: {str(e)}")
        
        if not valid_files:
            return jsonify({"error": "No valid files found for caching"}), 400
        
        # Generate a cache ID (simple approach - use timestamp + hash of file IDs)
        import hashlib
        cache_content = "_".join(sorted(valid_files))
        cache_hash = hashlib.md5(cache_content.encode()).hexdigest()[:8]
        cache_id = f"cache_{int(time.time())}_{cache_hash}"
        
        safe_info(f"Created document cache {cache_id} for {len(valid_files)} files")
        
        return jsonify({
            "cache_id": cache_id,
            "file_count": len(valid_files),
            "files": valid_files
        })
        
    except Exception as e:
        safe_exception(f"Error creating document cache: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Check file processing state
@app.route("/api/files/<file_id>/state", methods=["GET"])
def check_file_state(file_id):
    """Check the processing state of a file, especially for documents that need processing"""
    try:
        file = client.files.get(name=file_id)
        
        if not hasattr(file, 'name'):
            return jsonify({"error": "File not found"}), 404
            
        # Get relevant file info
        response_data = {
            "id": file_id,
            "name": file.name,
            "state": getattr(file, 'state', {}).name if hasattr(file, 'state') else "UNKNOWN",
            "processing_state": "PROCESSED"  # Default state
        }
        
        # Check if it's a document by mime type
        if hasattr(file, 'mime_type'):
            response_data["mime_type"] = file.mime_type
            
            # Check if this is a document that might need processing
            for doc_type, mime_list in PROCESSING_FILE_TYPES.items():
                if file.mime_type in mime_list:
                    # For documents that need processing, check the state
                    if hasattr(file, 'state'):
                        if file.state.name == "PROCESSING":
                            response_data["processing_state"] = "PROCESSING"
                        elif file.state.name == "ACTIVE":
                            response_data["processing_state"] = "PROCESSED"
                        else:
                            response_data["processing_state"] = "ERROR"
                    break
        
        # Get additional metadata if available
        if hasattr(file, 'metadata'):
            response_data["metadata"] = file.metadata
            
        return jsonify(response_data)
    except Exception as e:
        logger.exception(f"Error checking file state for {file_id}: {str(e)}")
        return jsonify({"error": f"Failed to check file state: {str(e)}"}), 500

# Add a new endpoint to get active chat sessions (for debugging)
@app.route("/api/debug/chats", methods=["GET"])
def debug_chats():
    try:
        # Get all active chat IDs
        chat_info = []
        for chat_id, chat in active_chats.items():
            try:
                # Try to get history length
                history = chat.get_history()
                history_length = len(history) if history else 0
                
                # Log a sample of the history for debugging
                logger.debug(f"Chat {chat_id} history length: {history_length}")
                if history_length > 0:
                    last_msg = history[-1]
                    # Handle unified format
                    if isinstance(last_msg, dict):
                        # Unified format: {"role": "user", "content": "text", ...}
                        content_preview = last_msg.get("content", "")[:50] if last_msg.get("content") else 'No content'
                        logger.debug(f"Last message for chat {chat_id}: role={last_msg.get('role', 'unknown')}, content={content_preview}...")
                    else:
                        # Legacy format
                        logger.debug(f"Last message for chat {chat_id}: role={last_msg.role}, content={last_msg.parts[0].text[:50]}...")
                
                chat_info.append({
                    "chat_id": chat_id,
                    "history_length": history_length
                })
            except Exception as e:
                logger.error(f"Error getting history for chat {chat_id}: {str(e)}")
                chat_info.append({
                    "chat_id": chat_id,
                    "error": str(e)
                })
                
        return jsonify({
            "active_chats": chat_info,
            "count": len(active_chats)
        })
    except Exception as e:
        logger.exception(f"Error in debug_chats: {str(e)}")
        return jsonify({"error": str(e)}), 500


# Simple endpoint to fetch OpenGraph metadata for URL preview cards
@app.route("/api/url-preview", methods=["GET"])
def url_preview():
    url = request.args.get("url")
    if not url:
        return jsonify({"error": "Missing url"}), 400
    try:
        headers = {"User-Agent": "Mozilla/5.0"}
        resp = requests.get(url, headers=headers, timeout=5)
        if resp.status_code != 200:
            return jsonify({"error": "Failed to retrieve URL"}), 400

        html = resp.text

        class MetaParser(HTMLParser):
            def __init__(self):
                super().__init__()
                self.meta = {}
                self.in_title = False
                self.title = None

            def handle_starttag(self, tag, attrs):
                if tag == "meta":
                    attr_dict = dict(attrs)
                    prop = attr_dict.get("property") or attr_dict.get("name")
                    if prop and "content" in attr_dict:
                        self.meta[prop] = attr_dict["content"]
                elif tag == "title":
                    self.in_title = True

            def handle_endtag(self, tag):
                if tag == "title":
                    self.in_title = False

            def handle_data(self, data):
                if self.in_title:
                    if self.title is None:
                        self.title = data.strip()
                    else:
                        self.title += data.strip()

        parser = MetaParser()
        parser.feed(html)

        def get_meta(names):
            for name in names:
                if name in parser.meta:
                    return parser.meta[name]
            return None

        title = get_meta(["og:title"]) or parser.title
        description = get_meta(["og:description", "description"])
        image = get_meta(["og:image"])

        return jsonify({
            "title": title,
            "description": description,
            "image": image,
            "url": url
        })
    except Exception as e:
        logger.exception(f"Error fetching preview for {url}: {str(e)}")
        return jsonify({"error": "Failed to fetch preview"}), 500


@app.route("/api/chat", methods=["POST"])
def chat():
    """Enhanced chat endpoint with background processing support"""
    try:
        data = request.json
        safe_debug("Chat request received with data", data)
            
        messages = data.get("messages", [])
        model_name = data.get("model", settings["model"])
        cache_id = data.get("cache_id")  # Document cache ID for optimized processing
        temperature = data.get("temperature")
        max_tokens = data.get("max_tokens")
        
        safe_info(f"🚀 [CHAT-START] Processing chat request - model: {model_name}, messages: {len(messages)}, cache_id: {cache_id}")
        
        if cache_id:
            safe_info(f"Using document cache: {cache_id}")
        
        # Validate that we have the necessary client for the requested model
        if is_openrouter_model(model_name):
            if not openrouter_client or not OPENROUTER_API_KEY:
                return jsonify({"error": f"OpenRouter model '{model_name}' requested but OpenRouter client not available. Please check your OPENROUTER_API_KEY."}), 503
        elif is_groq_model(model_name):
            if not GROQ_API_KEY:
                return jsonify({"error": f"Groq model '{model_name}' requested but Groq API key not available. Please check your GROQ_API_KEY."}), 503
        else:
            # Default to Gemini models
            error_response, status_code = check_gemini_client()
            if error_response:
                return jsonify(error_response), status_code
        
        # Get or create chat session ID
        chat_id = data.get("chat_id")  # Frontend might send a chat ID to continue a conversation
        background_mode = data.get("background", False)  # Whether to process in background
        new_chat = chat_id is None or chat_id not in active_chats
        
        safe_info(f"💭 [CHAT-ID] Chat ID: {chat_id}, new_chat: {new_chat}, background_mode: {background_mode}, active_chats: {len(active_chats)}")
        
        # If background mode is requested, delegate to background processor
        if background_mode and chat_id:
            try:
                background_processor.start_background_processing(
                    chat_id, messages, model_name,
                    temperature=temperature, max_tokens=max_tokens
                )
                return jsonify({
                    "success": True,
                    "chat_id": chat_id,
                    "message": "Background processing started",
                    "background": True
                })
            except Exception as e:
                safe_exception(f"Error starting background processing", e)
                # Fall back to foreground processing
                pass
        
        # Log more detailed information about active chats
        logger.debug(f"Chat ID: {chat_id}, New chat: {new_chat}, Active chats: {len(active_chats)}")
        
        # Check if chat_id exists in history but not in active_chats
        history_messages = []
        if not new_chat and chat_id in active_chats:
            try:
                # Log existing chat history
                existing_chat = active_chats[chat_id]
                history = existing_chat.get_history()
                history_length = len(history) if history else 0
                logger.debug(f"Existing chat {chat_id} history length: {history_length}")
                
                # Log a small sample of the history to verify it's working
                if history and history_length > 0:
                    sample_msg = history[-1]
                    # Safely log the message content (unified format)
                    try:
                        if isinstance(sample_msg, dict):
                            # Unified format: {"role": "user", "content": "text", ...}
                            sample_text = sample_msg.get("content", "")[:50] if sample_msg.get("content") else 'No content'
                            safe_debug(f"Last message in history: role={sample_msg.get('role', 'unknown')}", sample_text)
                        else:
                            # Legacy format: assume it has .parts and .role
                            sample_text = sample_msg.parts[0].text[:50] if hasattr(sample_msg, 'parts') and sample_msg.parts else 'No parts'
                            safe_debug(f"Last message in history: role={sample_msg.role}", sample_text)
                    except Exception as e:
                        # Handle potential encoding errors when accessing message parts
                        logger.debug(f"Last message in history: [Error accessing text: {str(e)}]")
            except Exception as e:
                logger.error(f"Error logging chat history: {str(e)}")
        elif chat_id is not None:
            # Chat ID exists but not in active_chats - load from history file
            safe_debug(f"Chat {chat_id} not in active sessions, checking history file")
            try:
                # Load chat history from file
                data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
                chats_file = data_dir / "chats.json"
                
                if chats_file.exists():
                    with open(chats_file, "r", encoding="utf-8") as f:
                        chat_history = json.load(f)
                    
                    # Find this chat in history
                    chat_from_file = None
                    for chat_entry in chat_history.get("chats", []):
                        if chat_entry.get("id") == chat_id:
                            chat_from_file = chat_entry
                            break
                    
                    if chat_from_file and "messages" in chat_from_file:
                        # Extract messages to initialize chat with history
                        history_messages = chat_from_file["messages"]
                        safe_debug(f"Found chat {chat_id} in history with {len(history_messages)} messages")
                        # Set new_chat to True to force initialization with history
                        new_chat = True
            except Exception as e:
                safe_error(f"Error checking chat history file: {str(e)}", e)
            
        # Prepare safety settings
        safety_settings = []
        if settings.get("safety_settings"):
            safety_settings = [
                {
                    "category": "HARM_CATEGORY_HARASSMENT",
                    "threshold": settings.get("safety_settings", {}).get("harassment", "BLOCK_NONE")
                },
                {
                    "category": "HARM_CATEGORY_HATE_SPEECH",
                    "threshold": settings.get("safety_settings", {}).get("hate_speech", "BLOCK_NONE")
                },
                {
                    "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    "threshold": settings.get("safety_settings", {}).get("sexually_explicit", "BLOCK_NONE")
                },
                {
                    "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                    "threshold": settings.get("safety_settings", {}).get("dangerous_content", "BLOCK_NONE")
                }
            ]
        
        # Configure the model with safety settings
        config = types.GenerateContentConfig(
            safety_settings=safety_settings
        )
        
        # Update config to include the system instruction
        config = types.GenerateContentConfig(
            safety_settings=safety_settings,
            system_instruction=creations_system_instruction
        )
        
        # Create a new chat or get the existing one
        if new_chat:
            logger.debug(f"Creating new chat with model: {model_name}")
            safe_info(f"🆕 [NEW-CHAT] Creating new UnifiedChatSession - ID: {chat_id}, model: {model_name}")
            
            # Use unified chat session for all providers
            chat = UnifiedChatSession(chat_id, model_name)
            safe_info(f"✅ [NEW-CHAT] UnifiedChatSession created successfully")
            
            # Initialize history if available
            if history_messages:
                safe_debug(f"Initializing unified chat with {len(history_messages)} history messages")
                for msg in history_messages:
                    if msg["role"] in ["user", "assistant"] and msg.get("content"):
                        chat.add_message(msg["role"], msg["content"])
            
            # Generate a unique ID if not provided
            if not chat_id:
                chat_id = f"unified_{int(time.time())}_{uuid.uuid4().hex[:8]}"
                chat.id = chat_id
                safe_info(f"🔑 [CHAT-ID] Generated new chat ID: {chat_id}")
            
            # Store the chat in our dictionary
            active_chats[chat_id] = chat
            logger.debug(f"New chat session created with ID: {chat_id}")
            safe_info(f"🗃️ [ACTIVE-CHATS] Added to active_chats - total: {len(active_chats)}")
            
            # Save chat metadata to chat history file
            try:
                # First, load existing chat history
                data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
                chats_file = data_dir / "chats.json"
                
                chat_history = {"chats": []}
                if chats_file.exists():
                    try:
                        with open(chats_file, "r", encoding="utf-8") as f:
                            chat_history = json.load(f)
                    except json.JSONDecodeError:
                        safe_warning(f"Invalid JSON in chats file, starting with empty history")
                        chat_history = {"chats": []}
                
                # Create timestamp for this chat
                timestamp = datetime.now().isoformat()
                
                # Extract first few words of user message as title
                chat_title = "New Chat"
                if messages and messages[-1]["role"] == "user" and "content" in messages[-1] and messages[-1]["content"]:
                    # Extract first few words for the title (max 5 words, 30 chars)
                    content = messages[-1]["content"].strip()
                    words = content.split()
                    title_words = words[:5]
                    chat_title = " ".join(title_words)
                    if len(chat_title) > 30:
                        chat_title = chat_title[:27] + "..."
                
                # Add new chat to history or update existing one
                existing_chat_index = None
                for i, chat_entry in enumerate(chat_history.get("chats", [])):
                    if chat_entry.get("id") == chat_id:
                        existing_chat_index = i
                        break
                
                if existing_chat_index is not None:
                    # Update existing chat entry
                    chat_history["chats"][existing_chat_index]["updated_at"] = timestamp
                    chat_history["chats"][existing_chat_index]["model"] = model_name
                    safe_debug(f"Updated existing chat in history: {chat_id}")
                else:
                    # Create new chat entry
                    new_chat_meta = {
                        "id": chat_id,
                        "title": chat_title,
                        "model": model_name,
                        "created_at": timestamp,
                        "updated_at": timestamp,
                        "first_message": messages[-1]["content"][:100] if messages and "content" in messages[-1] else ""
                    }
                    chat_history.setdefault("chats", []).append(new_chat_meta)
                    safe_debug(f"Added new chat to history: {chat_id}", new_chat_meta)
                    
                # Save updated chat history
                with open(chats_file, "w", encoding="utf-8") as f:
                    json.dump(chat_history, f, indent=2, ensure_ascii=False)
            except Exception as e:
                # Don't fail the chat if history saving fails
                safe_error(f"Failed to save chat to history: {str(e)}", e)
        else:
            # Retrieve the existing chat session
            logger.debug(f"Retrieving existing chat session: {chat_id}")
            chat = active_chats[chat_id]
            # Ensure the files set exists
            if not hasattr(chat, 'files'):
                chat.files = set()
                
            # Update the last updated timestamp in chat history
            try:
                # Load chat history
                data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
                chats_file = data_dir / "chats.json"
                
                if chats_file.exists():
                    with open(chats_file, "r", encoding="utf-8") as f:
                        chat_history = json.load(f)
                    
                    # Find and update this chat's entry
                    for chat_entry in chat_history.get("chats", []):
                        if chat_entry["id"] == chat_id:
                            chat_entry["updated_at"] = datetime.now().isoformat()
                            break
                    
                    # Save updated chat history
                    with open(chats_file, "w", encoding="utf-8") as f:
                        json.dump(chat_history, f, indent=2, ensure_ascii=False)
                        
                    safe_debug(f"Updated timestamp for chat: {chat_id}")
            except Exception as e:
                # Don't fail the chat if history update fails
                safe_error(f"Failed to update chat history timestamp: {str(e)}", e)
        


        # Get the latest user message
        latest_message = messages[-1] if messages and messages[-1]["role"] == "user" else None
        safe_info(f"📨 [LATEST-MSG] Messages array length: {len(messages)}, latest_message: {latest_message['role'] if latest_message else None}")
        if messages:
            safe_info(f"📨 [LATEST-MSG] Last message details: role={messages[-1].get('role')}, content_length={len(messages[-1].get('content', ''))}")
        
        # If we have a latest user message
        if latest_message:
            safe_info(f"✅ [LATEST-MSG] Latest user message found - proceeding with message processing")
            # Process message parts including any attachments
            parts = []
            
            # Add text content if present
            if latest_message["content"]:
                parts.append(latest_message["content"])
                # Use safe truncation and logging for message content
                safe_content = latest_message["content"][:50].replace('\n', ' ') if latest_message["content"] else ""
                safe_debug(f"Adding message content: {safe_content}...", safe_content)

                
            # Check if the message has attachments
            if "attachments" in latest_message and latest_message["attachments"]:
                # Add each attachment as a part
                for attachment in latest_message["attachments"]:
                    # Use the file_id from Gemini upload API
                    if "file_id" in attachment:
                        try:
                            # Get file using client.files.get method
                            file_id = attachment.get("file_id", "unknown")
                            safe_debug(f"Getting file with ID: {file_id}", file_id)
                            file_obj = client.files.get(name=file_id)
                            
                            # Check the file's state (applicable to all file types)
                            if hasattr(file_obj, 'state'):
                                file_state = getattr(file_obj.state, 'name', 'UNKNOWN')
                                safe_debug(f"File state: {file_state}", file_state)
                                
                                if file_state == 'PROCESSING':
                                    # File still processing, wait for it (max 15 seconds)
                                    safe_debug(f"File still processing, waiting...", file_state)
                                    max_wait = 15
                                    start_time = time.time()
                                    
                                    while file_state == 'PROCESSING' and (time.time() - start_time) < max_wait:
                                        time.sleep(1)
                                        file_obj = client.files.get(name=file_id)
                                        file_state = getattr(file_obj.state, 'name', 'UNKNOWN')
                                    
                                    if file_state != 'ACTIVE':
                                        safe_debug(f"File processing incomplete after waiting: {file_state}", file_state)
                                        # Add a placeholder instead of the file
                                        original_name = attachment.get('original_name', 'unknown')
                                        parts.append(f"[File still processing: {original_name}]")
                                        continue
                                elif file_state == 'FAILED':
                                    safe_debug(f"File processing failed: {file_id}", file_id)
                                    original_name = attachment.get('original_name', 'unknown')
                                    parts.append(f"[Error: File processing failed for {original_name}]")
                                    continue
                                elif file_state != 'ACTIVE':
                                    safe_debug(f"File not in ACTIVE state: {file_state}", file_state)
                                    original_name = attachment.get('original_name', 'unknown')
                                    parts.append(f"[File not ready: {original_name} (state: {file_state})]")
                                    continue
                            
                            # File is ready to use
                            safe_debug(f"File ready for use: {file_id}", file_id)
                            parts.append(file_obj)
                            
                            # Track this file ID with the chat session for cleanup later
                            if hasattr(chat, 'files'):
                                chat.files.add(file_id)
                                safe_debug(f"Added file {file_id} to tracked files for chat {chat_id}", file_id)
                            
                        except Exception as e:
                            safe_debug(f"Error retrieving file {file_id}: {str(e)}", e)
                            # Add a text placeholder instead
                            file_type = attachment.get('file_type', 'unknown')
                            original_name = attachment.get('original_name', 'unknown')
                            parts.append(f"[Error loading {file_type} file: {original_name}]")
            
            # Add profile knowledge base files as direct attachments if vectorization is disabled
            profile_id = data.get("profile")
            if profile_id and should_attach_files_directly(profile_id):
                try:
                    file_paths = get_profile_file_paths(profile_id)
                    safe_debug(f"Adding {len(file_paths)} profile files as direct attachments for profile {profile_id}")
                    
                    for file_path in file_paths:
                        try:
                            # Determine MIME type based on file extension
                            file_ext = Path(file_path).suffix.lower()
                            mime_type_map = {
                                '.pdf': 'application/pdf',
                                '.txt': 'text/plain',
                                '.md': 'text/markdown',
                                '.doc': 'application/msword',
                                '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                            }
                            mime_type = mime_type_map.get(file_ext, 'text/plain')
                            
                            # Upload file to Gemini API for processing
                            file_obj = client.files.upload(
                                file=file_path,
                                config=dict(mime_type=mime_type)
                            )
                            parts.append(file_obj)
                            safe_debug(f"Added profile file to parts: {file_path}")
                            
                            # Track this file for cleanup
                            if hasattr(chat, 'files'):
                                chat.files.add(file_obj.name)
                        except Exception as e:
                            safe_debug(f"Error uploading profile file {file_path}: {str(e)}")
                            # Add text fallback
                            filename = Path(file_path).name
                            parts.append(f"[Profile file: {filename}]")
                except Exception as e:
                    safe_debug(f"Error processing profile files: {str(e)}")
            
            # Send message with all parts and stream the response
            safe_debug(f"Sending message to chat ID {chat_id} with {len(parts)} parts", parts)
            
            # Check if files are supported for this model
            if not supports_file_attachments(model_name) and len(parts) > 1:
                # Convert file attachments to text descriptions for non-Gemini models
                text_content = ""
                for part in parts:
                    if isinstance(part, str):
                        text_content += part
                    else:
                        # For file objects, add a description
                        text_content += "[File attachment: processing not supported with this model]"
                parts = [text_content]
                
            try:
                # Add the user message to our unified history (without knowledge attachments)
                user_message_content = latest_message["content"] if latest_message and "content" in latest_message else ""
                safe_info(f"💬 [USER-MSG] User message content: '{user_message_content[:100]}...' (length: {len(user_message_content) if user_message_content else 0})")
                if user_message_content:
                    safe_info(f"✅ [USER-MSG] User message content exists - proceeding with chat flow")
                    chat.add_message("user", user_message_content)
                    
                    # Immediately save the user message to file to ensure persistence even if user switches chats
                    try:
                        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
                        chats_file = data_dir / "chats.json"
                        
                        chat_history = {"chats": []}
                        if chats_file.exists():
                            try:
                                with open(chats_file, "r", encoding="utf-8") as f:
                                    chat_history = json.load(f)
                            except json.JSONDecodeError:
                                safe_warning(f"Invalid JSON in chats file, starting with empty history")
                                chat_history = {"chats": []}
                        
                        # Convert current unified history to save format
                        formatted_messages = []
                        for msg in chat.unified_history:
                            formatted_msg = {
                                "role": msg["role"],
                                "content": msg["content"],
                                "timestamp": datetime.fromtimestamp(msg.get("timestamp", time.time())).isoformat(),
                                "tags": msg.get("tags", [])
                            }
                            if "reasoning" in msg:
                                formatted_msg["reasoning"] = msg["reasoning"]
                            formatted_messages.append(formatted_msg)
                        
                        # Find and update chat entry
                        chat_updated = False
                        for chat_entry in chat_history.get("chats", []):
                            if chat_entry.get("id") == chat_id:
                                chat_entry["updated_at"] = datetime.now().isoformat()
                                chat_entry["messages"] = formatted_messages
                                chat_updated = True
                                break
                        
                        # Create new entry if not found (shouldn't normally happen)
                        if not chat_updated:
                            timestamp = datetime.now().isoformat()
                            new_entry = {
                                "id": chat_id,
                                "title": "Chat",
                                "model": model_name,
                                "created_at": timestamp,
                                "updated_at": timestamp,
                                "first_message": user_message_content[:100] if user_message_content else "",
                                "messages": formatted_messages
                            }
                            chat_history.setdefault("chats", []).append(new_entry)
                        
                        # Atomic save
                        temp_file = chats_file.with_suffix('.tmp')
                        with open(temp_file, "w", encoding="utf-8") as f:
                            json.dump(chat_history, f, indent=2, ensure_ascii=False)
                        temp_file.replace(chats_file)
                        
                        safe_debug(f"User message immediately saved to chats.json for chat {chat_id}")
                        
                    except Exception as save_error:
                        safe_warning(f"Error immediately saving user message: {save_error}")
                        # Don't fail the request if save fails
                
                # Get history for the current provider
                history_for_provider = chat.get_history_for_provider(model_name)

                # Append profile knowledge as a system message if vectorization is enabled
                profile_id = data.get("profile")
                if profile_id:
                    if should_attach_files_directly(profile_id):
                        safe_debug(f"Profile {profile_id}: Knowledge base enabled, vectorization disabled - files attached directly")
                    else:
                        safe_debug(f"Profile {profile_id}: Using vectorized knowledge retrieval")
                        # Only use knowledge as system message when vectorization is enabled
                        knowledge = get_knowledge(profile_id, user_message_content)
                        if knowledge:
                            history_for_provider.append({"role": "system", "content": knowledge})
                            safe_debug(f"Added vectorized knowledge to system message ({len(knowledge)} chars)")
                
                # Create response using unified approach
                safe_debug(f"Using unified interface for model: {model_name}")
                
                # Check if we need to use Gemini native API for file attachments
                if supports_file_attachments(model_name) and len(parts) > 1:
                    # Use Gemini native API for files (parts include text + files)
                    safe_debug(f"Using Gemini native API with {len(parts)} parts for file support")
                    response = create_gemini_chat_with_files(
                        parts, 
                        model_name, 
                        creations_system_instruction
                    )
                else:
                    # Use unified OpenAI-compatible approach for text-only
                    safe_debug(f"Using unified OpenAI-compatible API for text-only chat")
                    response = create_unified_chat_response(
                        history_for_provider,
                        model_name,
                        creations_system_instruction,
                    None,
                    temperature,
                    max_tokens
                    )
                
                # Use raw stream directly (fastest approach)
                delayed_response = response
                safe_info(f"🎯 [RESPONSE] Successfully created response stream - type: {type(response)}")
                
            except Exception as e:
                safe_error(f"❌ [RESPONSE] Error during unified chat request: {str(e)}", e)
                return jsonify({"error": str(e)}), 500
            
            def generate():
                # Add a try-except block around the entire streaming process
                assistant_response = ""  # Track the complete assistant response
                accumulated_reasoning = ""  # Track the complete reasoning for OpenRouter models
                
                safe_info(f"🔄 [GENERATE] Starting generate function - new_chat: {new_chat}, chat_id: {chat_id}")
                
                try:
                    # FIRST: Send chat metadata immediately for new chats
                    if new_chat:
                        safe_info(f"📤 [METADATA] Preparing to send chat creation metadata for new chat")
                        # Extract chat title for metadata
                        chat_title = "New Chat"
                        if messages and messages[-1]["role"] == "user" and "content" in messages[-1] and messages[-1]["content"]:
                            content = messages[-1]["content"].strip()
                            words = content.split()
                            title_words = words[:5]
                            chat_title = " ".join(title_words)
                            if len(chat_title) > 30:
                                chat_title = chat_title[:27] + "..."
                        
                        # Send chat creation metadata as first event
                        metadata_event = {
                            'type': 'chat_created',
                            'chat_id': chat_id,
                            'model': model_name,
                            'title': chat_title,
                            'created_at': datetime.now().isoformat(),
                            'is_new_chat': True
                        }
                        safe_info(f"✉️ [METADATA] Created metadata event: {metadata_event}")
                        try:
                            json_data = json.dumps(metadata_event)
                            yield f"data: {json_data}\n\n"
                            safe_info(f"📤 [CHAT-INIT] ✅ Successfully sent chat metadata as first event: {chat_id}")
                        except (UnicodeEncodeError, json.JSONDecodeError) as e:
                            safe_warning(f"❌ [CHAT-INIT] Error encoding chat metadata: {str(e)}")
                    else:
                        # Send chat resume metadata for existing chats
                        resume_event = {
                            'type': 'chat_resumed',
                            'chat_id': chat_id,
                            'model': model_name,
                            'is_new_chat': False
                        }
                        try:
                            json_data = json.dumps(resume_event)
                            yield f"data: {json_data}\n\n"
                            safe_debug(f"[CHAT-RESUME] Sent chat resume metadata: {chat_id}")
                        except (UnicodeEncodeError, json.JSONDecodeError) as e:
                            safe_warning(f"Error encoding chat resume metadata: {str(e)}")
                    
                    # THEN: Continue with content streaming
                    safe_info(f"🌊 [STREAMING] Starting to process response chunks from delayed_response")
                    chunk_count = 0
                    for chunk in delayed_response:
                        chunk_count += 1
                        if chunk_count == 1:
                            safe_info(f"🌊 [STREAMING] Processing first chunk #{chunk_count}")
                        elif chunk_count % 10 == 0:
                            safe_info(f"🌊 [STREAMING] Processing chunk #{chunk_count}...")
                        try:
                            chunk_text = ""
                            
                            # Handle unified OpenAI-compatible response structure
                            if hasattr(chunk, 'choices') and chunk.choices:
                                delta = chunk.choices[0].delta
                                
                                # Handle reasoning tokens (OpenRouter only)
                                if hasattr(delta, 'reasoning') and delta.reasoning and is_openrouter_model(model_name):
                                    reasoning_data = {'reasoning': delta.reasoning, 'chat_id': chat_id}
                                    # Accumulate reasoning for saving to history
                                    accumulated_reasoning += delta.reasoning
                                    safe_debug(f"[REASONING] Backend sending reasoning chunk: {delta.reasoning[:100]}...")
                                    try:
                                        json_data = json.dumps(reasoning_data)
                                        yield f"data: {json_data}\n\n"
                                    except (UnicodeEncodeError, json.JSONDecodeError) as e:
                                        safe_warning(f"Error encoding reasoning chunk: {str(e)}")
                                
                                # Handle content tokens
                                if hasattr(delta, 'content') and delta.content:
                                    chunk_text = delta.content
                                    assistant_response += chunk_text
                            
                            if chunk_text:
                                # Safely encode the chunk to prevent JSON errors
                                chunk_data = {'chunk': chunk_text, 'chat_id': chat_id}
                                try:
                                    json_data = json.dumps(chunk_data)
                                    yield f"data: {json_data}\n\n"
                                    
                                    # Save incremental update every 500 characters to reduce I/O
                                    if len(assistant_response) % 500 == 0 and len(assistant_response) > 0:
                                        try:
                                            # Quick incremental save
                                            data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
                                            chats_file = data_dir / "chats.json"
                                            
                                            if chats_file.exists():
                                                with open(chats_file, "r", encoding="utf-8") as f:
                                                    chat_history = json.load(f)
                                                
                                                # Update the specific chat
                                                for chat_entry in chat_history.get("chats", []):
                                                    if chat_entry.get("id") == chat_id:
                                                        chat_entry["updated_at"] = datetime.now().isoformat()
                                                        chat_entry["status"] = "streaming"
                                                        # Add partial message marker
                                                        chat_messages = chat_entry.get("messages", [])
                                                        if chat_messages and chat_messages[-1].get("role") == "assistant":
                                                            chat_messages[-1]["content"] = assistant_response
                                                            chat_messages[-1]["partial"] = True
                                                        break
                                                
                                                # Atomic save
                                                temp_file = chats_file.with_suffix('.tmp')
                                                with open(temp_file, "w", encoding="utf-8") as f:
                                                    json.dump(chat_history, f, indent=2, ensure_ascii=False)
                                                temp_file.replace(chats_file)
                                        except Exception as save_error:
                                            # Don't fail streaming for save errors
                                            safe_warning(f"Incremental save error: {save_error}")
                                    
                                except UnicodeEncodeError as ue:
                                    # Handle Unicode encoding errors by replacing problematic characters
                                    safe_text = chunk_text.encode('utf-8', errors='replace').decode('utf-8')
                                    safe_warning(f"Unicode encoding error in response chunk: {str(ue)}", safe_text)
                                    yield f"data: {json.dumps({'chunk': safe_text, 'chat_id': chat_id})}\n\n"
                                except json.JSONDecodeError as je:
                                    safe_error(f"JSON decode error in response chunk: {str(je)}", je)
                                    yield f"data: {json.dumps({'error': 'Error encoding response chunk', 'chat_id': chat_id})}\n\n"
                        except json.JSONDecodeError as je:
                            safe_error(f"JSON decode error in response chunk: {str(je)}", je)
                            # Send a safe error message
                            yield f"data: {json.dumps({'error': 'Error parsing response chunk', 'chat_id': chat_id})}\n\n"
                        except Exception as e:
                            safe_error(f"Error processing response chunk: {str(e)}", e)
                            # Send a safe error message 
                            yield f"data: {json.dumps({'error': 'Error processing response chunk', 'chat_id': chat_id})}\n\n"
                    
                    # Log the complete history after the response is done
                    try:
                        # Add the assistant response to unified history
                        if assistant_response.strip():
                            reasoning_to_save = accumulated_reasoning if accumulated_reasoning.strip() and is_openrouter_model(model_name) else None
                            if reasoning_to_save:
                                safe_debug(f"[REASONING] Saving reasoning to history: {len(accumulated_reasoning)} chars")
                            
                            chat.add_message("assistant", assistant_response, reasoning_to_save)
                        
                        # Get formatted messages for saving to file
                        formatted_messages = chat.unified_history.copy()

                        # Convert to the format expected by the frontend while preserving metadata
                        simplified_messages = []
                        for msg in formatted_messages:
                            simplified_msg = {
                                "role": msg["role"],
                                "content": msg["content"],
                                "timestamp": datetime.fromtimestamp(msg.get("timestamp", time.time())).isoformat(),
                                "tags": msg.get("tags", [])
                            }
                            if "reasoning" in msg:
                                simplified_msg["reasoning"] = msg["reasoning"]
                            simplified_messages.append(simplified_msg)
                        
                        safe_debug(f"Unified chat {chat_id} history after response - length: {len(simplified_messages)}")
                                
                        # Save the complete chat messages to the chat history file
                        try:
                            
                            # Load existing chat history
                            data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
                            chats_file = data_dir / "chats.json"
                            
                            chat_history = {"chats": []}
                            if chats_file.exists():
                                try:
                                    with open(chats_file, "r", encoding="utf-8") as f:
                                        chat_history = json.load(f)
                                except json.JSONDecodeError:
                                    safe_warning(f"Invalid JSON in chats file, starting with empty history")
                                    chat_history = {"chats": []}
                            
                            # Find and update this chat's entry with messages
                            chat_updated = False
                            for chat_entry in chat_history.get("chats", []):
                                if chat_entry.get("id") == chat_id:
                                    chat_entry["updated_at"] = datetime.now().isoformat()
                                    chat_entry["messages"] = simplified_messages
                                    chat_updated = True
                                    break
                            
                            # If chat entry not found, create a new one
                            if not chat_updated:
                                # Should not normally happen as chat should be created earlier
                                timestamp = datetime.now().isoformat()
                                new_chat_entry = {
                                    "id": chat_id,
                                    "title": "Chat",
                                    "model": model_name,
                                    "created_at": timestamp,
                                    "updated_at": timestamp,
                                    "first_message": simplified_messages[0]["content"][:100] if simplified_messages else "",
                                    "messages": simplified_messages
                                }
                                chat_history.setdefault("chats", []).append(new_chat_entry)
                            
                            # Save updated chat history and clear streaming status
                            with open(chats_file, "w", encoding="utf-8") as f:
                                json.dump(chat_history, f, indent=2, ensure_ascii=False)
                            
                            # Clear streaming status
                            for chat_entry in chat_history.get("chats", []):
                                if chat_entry.get("id") == chat_id:
                                    chat_entry.pop("status", None)  # Remove streaming status
                                    # Remove partial flags from messages
                                    for msg in chat_entry.get("messages", []):
                                        msg.pop("partial", None)
                                    break
                            
                            # Final save without streaming status
                            with open(chats_file, "w", encoding="utf-8") as f:
                                json.dump(chat_history, f, indent=2, ensure_ascii=False)
                            
                            safe_debug(f"Saved {len(simplified_messages)} messages for chat {chat_id} and cleared streaming status")
                        except Exception as e:
                            safe_error(f"Failed to save chat messages: {str(e)}", e)
                                
                    except Exception as e:
                        safe_error(f"Error getting history after response: {str(e)}", e)
                    
                    yield f"data: {json.dumps({'done': True, 'chat_id': chat_id})}\n\n"
                
                # Catch any errors that might occur during the entire streaming process
                except json.JSONDecodeError as je:
                    safe_error(f"JSON decode error in streaming response: {str(je)}", je)
                    yield f"data: {json.dumps({'error': 'JSON decode error in streaming response', 'chat_id': chat_id, 'done': True})}\n\n"
                except Exception as e:
                    safe_error(f"Error in streaming response: {str(e)}", e)
                    yield f"data: {json.dumps({'error': str(e), 'chat_id': chat_id, 'done': True})}\n\n"
            
            safe_info(f"🌊 [RETURN] Returning streaming Response with generate() function")
            return Response(stream_with_context(generate()), content_type='text/event-stream')
        else:
            safe_warning(f"❌ [USER-MSG] No user message content found - returning error")
            return jsonify({"error": "No user message provided"}), 400
    
    except Exception as e:
        safe_exception(f"Error in chat endpoint: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Add a new endpoint to clear a chat session if needed
@app.route("/api/chat/<chat_id>", methods=["DELETE"])
def clear_chat(chat_id):
    try:
        if chat_id in active_chats:
            chat = active_chats[chat_id]
            
            # Delete files associated with this chat session
            if hasattr(chat, 'files') and chat.files:
                safe_debug(f"Deleting {len(chat.files)} files associated with chat {chat_id}", chat.files)
                for file_id in list(chat.files):  # Create a copy of the set to avoid modification during iteration
                    try:
                        # Clean file_id for local file lookup
                        clean_file_id = file_id.replace("files/", "")
                        local_file_path = temp_files_dir / f"{clean_file_id}.pdf"
                        
                        # Delete local temp file if it exists
                        if local_file_path.exists():
                            os.remove(local_file_path)
                            safe_debug(f"Deleted local temp file: {local_file_path}")
                        
                        # Delete from Gemini API
                        safe_debug(f"Deleting file {file_id} from File API", file_id)
                        client.files.delete(name=file_id)
                        chat.files.remove(file_id)
                        safe_debug(f"Successfully deleted file {file_id}", file_id)
                    except Exception as file_error:
                        safe_debug(f"Error deleting file {file_id}: {str(file_error)}", file_error)
            
            # Also remove the chat from chat history file
            try:
                # Load chat history
                data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
                chats_file = data_dir / "chats.json"
                
                if chats_file.exists():
                    with open(chats_file, "r", encoding="utf-8") as f:
                        chat_history = json.load(f)
                    
                    # Filter out the deleted chat
                    previous_count = len(chat_history.get("chats", []))
                    chat_history["chats"] = [c for c in chat_history.get("chats", []) if c.get("id") != chat_id]
                    
                    # Save updated chat history
                    with open(chats_file, "w", encoding="utf-8") as f:
                        json.dump(chat_history, f, indent=2, ensure_ascii=False)
                    
                    safe_debug(f"Removed chat {chat_id} from chat history. Previous: {previous_count}, Current: {len(chat_history.get('chats', []))}")
            except Exception as e:
                # Don't fail if chat history removal fails
                safe_error(f"Failed to remove chat from history file: {str(e)}", e)
            
            # Delete the chat session
            del active_chats[chat_id]
            
            return jsonify({"success": True, "message": f"Chat session {chat_id} deleted"})
        else:
            # Try to delete from chat history file even if not in active_chats
            try:
                data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
                chats_file = data_dir / "chats.json"
                
                if chats_file.exists():
                    with open(chats_file, "r", encoding="utf-8") as f:
                        chat_history = json.load(f)
                    
                    # Check if chat exists in history
                    original_count = len(chat_history.get("chats", []))
                    chat_history["chats"] = [c for c in chat_history.get("chats", []) if c.get("id") != chat_id]
                    new_count = len(chat_history.get("chats", []))
                    
                    # If we found and removed the chat from history
                    if new_count < original_count:
                        with open(chats_file, "w", encoding="utf-8") as f:
                            json.dump(chat_history, f, indent=2, ensure_ascii=False)
                        
                        safe_debug(f"Removed chat {chat_id} from chat history only (not in active sessions)")
                        return jsonify({"success": True, "message": f"Chat {chat_id} deleted from history"})
            except Exception as e:
                safe_error(f"Error trying to delete chat from history: {str(e)}", e)
            
            # If we get here, the chat wasn't found anywhere
            return jsonify({"error": "Chat session not found"}), 404
    except Exception as e:
        safe_debug(f"Error clearing chat session: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Add a dedicated endpoint for deleting a chat from history
@app.route("/api/chats/<chat_id>/delete", methods=["DELETE"])
def delete_chat_from_history(chat_id):
    """Delete a specific chat from the chat history"""
    try:
        safe_debug(f"Deleting chat {chat_id} from history")
        
        # Ensure data directory exists using absolute paths
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        chats_file = data_dir / "chats.json"
        
        if not chats_file.exists():
            return jsonify({"error": "Chat history file not found"}), 404
            
        # Load existing chat history
        with open(chats_file, "r", encoding="utf-8") as f:
            chat_history = json.load(f)
        
        # Check if chat exists in history
        original_count = len(chat_history.get("chats", []))
        chat_history["chats"] = [c for c in chat_history.get("chats", []) if c.get("id") != chat_id]
        new_count = len(chat_history.get("chats", []))
        
        # If chat was found and removed
        if new_count < original_count:
            # Save updated chat history
            with open(chats_file, "w", encoding="utf-8") as f:
                json.dump(chat_history, f, indent=2, ensure_ascii=False)
            
            # Also remove from active sessions if it exists there
            if chat_id in active_chats:
                # Delete any associated files
                chat = active_chats[chat_id]
                if hasattr(chat, 'files') and chat.files:
                    for file_id in list(chat.files):
                        try:
                            client.files.delete(name=file_id)
                        except Exception as file_error:
                            safe_debug(f"Error deleting file {file_id}: {str(file_error)}", file_error)
                
                # Remove from active chats
                del active_chats[chat_id]
                safe_debug(f"Removed chat {chat_id} from active sessions")
            
            return jsonify({
                "success": True, 
                "message": f"Chat {chat_id} deleted from history",
                "removed_from_active": chat_id in active_chats
            })
        else:
            return jsonify({"error": "Chat not found in history"}), 404
    except Exception as e:
        safe_exception(f"Error deleting chat from history: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

@app.route("/api/chat/<chat_id>", methods=["GET"])
def get_chat(chat_id):
    """Retrieve chat messages for a specific chat ID"""
    try:
        safe_debug(f"Retrieving chat history for ID: {chat_id}")
        
        # First check if we have messages in the chat history file
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        chats_file = data_dir / "chats.json"
        chat_from_file = None
        
        try:
            if chats_file.exists():
                with open(chats_file, "r", encoding="utf-8") as f:
                    chat_history = json.load(f)
                
                # Find this chat in the history
                for chat_entry in chat_history.get("chats", []):
                    if chat_entry.get("id") == chat_id:
                        chat_from_file = chat_entry
                        break
                
                if chat_from_file and "messages" in chat_from_file:
                    safe_debug(f"Found chat {chat_id} in history file with {len(chat_from_file['messages'])} messages")
        except Exception as e:
            safe_error(f"Error checking chat history file: {str(e)}", e)
        
        # Check if the chat exists in active sessions
        if chat_id in active_chats:
            chat = active_chats[chat_id]
            
            try:
                # Check if this is a unified chat session
                if isinstance(chat, UnifiedChatSession):
                    # For unified chats, convert the history to frontend format
                    messages = []
                    for msg in chat.unified_history:
                        formatted_msg = {
                            "role": msg["role"],
                            "content": msg["content"],
                            "timestamp": datetime.fromtimestamp(msg.get("timestamp", time.time())).isoformat(),
                            "tags": msg.get("tags", [])
                        }
                        if "reasoning" in msg:
                            formatted_msg["reasoning"] = msg["reasoning"]
                        messages.append(formatted_msg)
                    
                    safe_debug(f"Retrieved {len(messages)} messages from unified chat {chat_id}")
                elif hasattr(chat, 'external_history'):
                    # Legacy external chat format
                    messages = []
                    for msg in chat.external_history:
                        formatted_msg = {
                            "role": msg.get("role"),
                            "content": msg.get("content", ""),
                            "timestamp": datetime.now().isoformat(),
                            "tags": msg.get("tags", [])
                        }
                        if "reasoning" in msg:
                            formatted_msg["reasoning"] = msg["reasoning"]
                        messages.append(formatted_msg)
                    model_type = "OpenRouter" if is_openrouter_model(getattr(chat, 'model', '')) else "Groq" if is_groq_model(getattr(chat, 'model', '')) else "External"
                    safe_debug(f"Retrieved {len(messages)} messages from legacy {model_type} chat {chat_id}")
                else:
                    # Legacy Gemini chat format
                    history = chat.get_history() if hasattr(chat, 'get_history') else []
                    
                    # Format the messages for the frontend
                    messages = []
                    previous_role = None
                    if history:
                        for msg in history:
                            # Convert 'model' role to 'assistant' for frontend consistency
                            role = "assistant" if msg.role == "model" else msg.role
                            
                            # Only include user and assistant messages
                            if role in ["user", "assistant"]:
                                # Extract text content from message parts
                                content = ""
                                if hasattr(msg, 'parts'):
                                    for part in msg.parts:
                                        if hasattr(part, 'text') and part.text:
                                            content += part.text
                                
                                # Combine consecutive assistant messages
                                if role == "assistant" and previous_role == "assistant" and messages:
                                    # Append this content to the previous assistant message
                                    messages[-1]["content"] += content
                                else:
                                    # Add as a new message
                                    messages.append({
                                        "role": role,
                                        "content": content,
                                        "timestamp": datetime.now().isoformat(),
                                        "tags": []
                                    })
                                
                                previous_role = role
                    
                    safe_debug(f"Retrieved {len(messages)} messages from legacy Gemini chat {chat_id}")
                
                # Get metadata from file if available
                chat_metadata = {}
                if chat_from_file:
                    # Exclude 'messages' field from metadata
                    chat_metadata = {k: v for k, v in chat_from_file.items() if k != 'messages'}
                
                # Return both messages and metadata
                return jsonify({
                    "chat_id": chat_id,
                    "messages": messages,
                    "metadata": chat_metadata
                })
                
            except Exception as e:
                safe_error(f"Error getting chat history from active session: {str(e)}", e)
                
                # If there was an error but we have messages in the file, use those as fallback
                if chat_from_file and "messages" in chat_from_file:
                    safe_warning(f"Using chat messages from file as fallback for chat {chat_id}")
                    return jsonify({
                        "chat_id": chat_id,
                        "messages": chat_from_file["messages"],
                        "metadata": {k: v for k, v in chat_from_file.items() if k != 'messages'}
                    })
                
                return jsonify({
                    "error": f"Failed to retrieve chat history: {str(e)}",
                    "chat_id": chat_id,
                    "messages": []
                }), 500
        else:
            # If the chat doesn't exist in active sessions, try to return from the file
            if chat_from_file:
                if "messages" in chat_from_file:
                    safe_info(f"Chat {chat_id} not in active sessions, retrieving from file")
                    return jsonify({
                        "chat_id": chat_id,
                        "messages": chat_from_file["messages"],
                        "metadata": {k: v for k, v in chat_from_file.items() if k != 'messages'}
                    })
                else:
                    return jsonify({
                        "error": "Chat found but no messages available",
                        "chat_id": chat_id,
                        "messages": [],
                        "metadata": chat_from_file
                    }), 404
            else:
                return jsonify({"error": "Chat not found", "chat_id": chat_id}), 404
    except Exception as e:
        safe_exception(f"Error in get_chat: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Summarize a chat conversation
@app.route("/api/chat/<chat_id>/summary", methods=["GET"])
def summarize_chat(chat_id):
    """Return an LLM generated summary of a chat"""
    try:
        model_name = request.args.get("model", settings.get("model"))

        # Try to retrieve messages from active chats first
        messages = []
        if chat_id in active_chats:
            chat = active_chats[chat_id]
            if hasattr(chat, "unified_history"):
                messages = chat.unified_history
            elif hasattr(chat, "external_history"):
                messages = chat.external_history

        if not messages:
            # Load from history file
            data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
            chats_file = data_dir / "chats.json"
            if chats_file.exists():
                with open(chats_file, "r", encoding="utf-8") as f:
                    chat_history = json.load(f)
                for chat_entry in chat_history.get("chats", []):
                    if chat_entry.get("id") == chat_id:
                        messages = chat_entry.get("messages", [])
                        break

        if not messages:
            return jsonify({"error": "Chat not found"}), 404

        # Filter out system messages if they contain only metadata or are empty
        filtered_messages = []
        for msg in messages:
            if msg.get("role") in ["user", "assistant"] and msg.get("content", "").strip():
                filtered_messages.append(msg)
        
        if not filtered_messages:
            return jsonify({"chat_id": chat_id, "summary": "No conversation content to summarize"})

        summary = generate_chat_summary(filtered_messages, model_name)

        return jsonify({"chat_id": chat_id, "summary": summary})
    except Exception as e:
        safe_exception(f"Error summarizing chat {chat_id}: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Condense chat history by replacing all messages with a single summary
@app.route("/api/chat/<chat_id>/condense", methods=["POST"])
def condense_chat(chat_id):
    """Replace chat history with a condensed summary message"""
    try:
        data = request.json or {}
        summary = data.get("summary")
        model_name = data.get("model", settings.get("model"))

        if not summary:
            return jsonify({"error": "Summary is required"}), 400

        condensed_message = {
            "role": "system",
            "content": summary
        }

        # Update active chat if it exists
        if chat_id in active_chats:
            chat = active_chats[chat_id]
            chat.unified_history = [condensed_message]
            chat.last_updated = time.time()

        # Update history file
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        chats_file = data_dir / "chats.json"
        chat_history = {"chats": []}
        if chats_file.exists():
            try:
                with open(chats_file, "r", encoding="utf-8") as f:
                    chat_history = json.load(f)
            except json.JSONDecodeError:
                safe_warning(f"Invalid JSON in chats file when condensing {chat_id}")

        found = False
        for chat_entry in chat_history.get("chats", []):
            if chat_entry.get("id") == chat_id:
                chat_entry["messages"] = [condensed_message]
                chat_entry["updated_at"] = datetime.now().isoformat()
                chat_entry["first_message"] = summary[:100]
                chat_entry["model"] = model_name
                found = True
                break

        if not found:
            timestamp = datetime.now().isoformat()
            new_chat_entry = {
                "id": chat_id,
                "title": "Chat",
                "model": model_name,
                "created_at": timestamp,
                "updated_at": timestamp,
                "first_message": summary[:100],
                "messages": [condensed_message]
            }
            chat_history.setdefault("chats", []).append(new_chat_entry)

        with open(chats_file, "w", encoding="utf-8") as f:
            json.dump(chat_history, f, indent=2, ensure_ascii=False)

        return jsonify({"success": True, "chat_id": chat_id})
    except Exception as e:
        safe_exception(f"Error condensing chat {chat_id}: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Generate image endpoint
@app.route("/api/generate-image", methods=["POST"])
def generate_image():
    try:
        data = request.json
        prompt = data.get("prompt", "")
        
        if not prompt:
            return jsonify({"error": "Prompt is required"}), 400
        
        # Use safety settings from global settings
        safety_settings = []
        if settings.get("safety_settings"):
            safety_settings = [
                {
                    "category": "HARM_CATEGORY_HARASSMENT",
                    "threshold": settings.get("safety_settings", {}).get("harassment", "BLOCK_NONE")
                },
                {
                    "category": "HARM_CATEGORY_HATE_SPEECH",
                    "threshold": settings.get("safety_settings", {}).get("hate_speech", "BLOCK_NONE")
                },
                {
                    "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    "threshold": settings.get("safety_settings", {}).get("sexually_explicit", "BLOCK_NONE")
                },
                {
                    "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                    "threshold": settings.get("safety_settings", {}).get("dangerous_content", "BLOCK_NONE")
                }
            ]
            
        # Create configuration with proper comma placement
        config = types.GenerateContentConfig(
            response_modalities=['Text', 'Image'],
            safety_settings=safety_settings,
            system_instruction=creations_system_instruction
        )
            
        # Use gemini-2.0-flash-exp-image-generation model for image generation with proper config
        safe_debug(f"Generating image with prompt: {prompt[:50]}...", prompt)
        response = client.models.generate_content(
            model="gemini-2.0-flash-exp-image-generation",
            contents=prompt,
            config=config
        )
        
        result = {
            "text": "",
            "images": []
        }
        
        # Process the parts to extract text and images
        for part in response.candidates[0].content.parts:
            if hasattr(part, 'text') and part.text is not None:
                result["text"] += part.text
            elif hasattr(part, 'inline_data') and part.inline_data is not None:
                # Convert image data to base64 for sending to the frontend
                image_data = part.inline_data.data
                base64_image = base64.b64encode(image_data).decode('utf-8')
                result["images"].append({
                    "data": base64_image,
                    "mime_type": part.inline_data.mime_type
                })
        
        safe_debug("Image generation successful", result)
        return jsonify(result)
        
    except Exception as e:
        safe_debug(f"Error generating image: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Health check endpoint
@app.route("/api/health", methods=["GET"])
def health_check():
    return jsonify({"status": "healthy", "whisper_loaded": whisper_model is not None})

# Logs endpoint (access with caution in production)
@app.route("/api/logs", methods=["GET"])
def get_logs():
    try:
        # Optional: basic auth/security check could be added here
        
        # Get parameter for how many lines to read (default: 100, max: 1000)
        lines = min(int(request.args.get("lines", 100)), 1000)
        
        # Read the log file (most recent entries first)
        log_entries = []
        if os.path.exists(log_file):
            with open(log_file, "r", encoding="utf-8") as f:
                log_entries = f.readlines()
                log_entries = log_entries[-lines:]  # Get the last N lines
        
        return jsonify({
            "logs": log_entries,
            "log_file_path": log_file
        })
    except Exception as e:
        safe_debug(f"Error reading logs: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Define the React component debug log file
REACT_DEBUG_LOG_FILE = os.path.join(logs_dir, 'atlas_react.log')

@app.route("/api/debug/log", methods=["POST"])
def debug_log():
    """
    Endpoint for logging debug information from the frontend
    """
    try:
        data = request.json
        log_type = data.get('type', 'general')
        log_data = data.get('data', {})
        
        # Create a formatted log entry with timestamp
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        
        if log_type == 'react_component_processing':
            # Format the log entry for component processing
            log_entry = f"""
================================================================================
REACT COMPONENT PROCESSING - {timestamp} - ID: {log_data.get('creationId', 'unknown')}
================================================================================

Component Candidates: {', '.join(log_data.get('componentNames', []))}
Default Export: {log_data.get('defaultExport', 'None')}

ORIGINAL CODE:
{log_data.get('original', '')}

PROCESSED CODE:
{log_data.get('processed', '')}
"""
        elif log_type == 'react_component_error':
            # Format the log entry for component errors
            log_entry = f"""
================================================================================
REACT COMPONENT ERROR - {timestamp} - ID: {log_data.get('creationId', 'unknown')}
================================================================================

Error: {log_data.get('error', 'Unknown error')}
Component: {log_data.get('componentName', 'Unknown')}

Stack Trace:
{log_data.get('stack', 'No stack trace available')}
"""
        else:
            # General log format
            log_entry = f"""
================================================================================
DEBUG LOG - {timestamp} - Type: {log_type}
================================================================================

{json.dumps(log_data, indent=2)}
"""
        
        # Write the log entry to the React debug log file
        with open(REACT_DEBUG_LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(log_entry + "\n")
        
        return jsonify({"success": True, "message": "Log entry recorded"})
    
    except Exception as e:
        safe_debug(f"Error in debug logging: {str(e)}", e)
        return jsonify({"success": False, "error": str(e)}), 500

# Add speech-to-text transcription endpoint
@app.route("/api/transcribe", methods=["POST"])
def transcribe_audio():
    """
    Endpoint for transcribing speech to text using Whisper
    """
    try:
        safe_debug("Transcription request received")
        
        if 'audio' not in request.files:
            safe_error("No audio part in the request")
            return jsonify({"error": "No audio file provided"}), 400
            
        audio_file = request.files['audio']
        
        if audio_file.filename == '':
            safe_error("No audio file selected")
            return jsonify({"error": "No audio file selected"}), 400
        
        # Log additional info about the incoming file
        file_size = 0
        try:
            audio_file.seek(0, os.SEEK_END)
            file_size = audio_file.tell()
            audio_file.seek(0)  # Reset the file pointer
            safe_debug(f"Audio file size: {file_size} bytes")
        except Exception as e:
            safe_warning(f"Could not determine file size", e)
        
        # Read audio file content directly
        audio_data = audio_file.read()
        audio_file.close() # Close the file handle from Flask
        safe_debug(f"Received audio data: {len(audio_data)} bytes")
        content_type = audio_file.content_type if hasattr(audio_file, 'content_type') else 'unknown'
        safe_debug(f"Audio file MIME type: {content_type}")
        safe_debug(f"Audio file name: {audio_file.filename}")

        # Check if we actually received valid audio data
        if len(audio_data) < 1000:
            safe_error(f"Audio data too small ({len(audio_data)} bytes), likely invalid")
            return jsonify({"error": "Audio data too small or corrupt"}), 400

        # Create temporary files for audio processing
        input_temp_path = None
        wav_temp_path = None
        
        try:
            # Determine file extension from filename or content type
            file_ext = '.webm'  # default
            
            # Clean up the filename if it has parameters like ;codecs=opus
            clean_filename = audio_file.filename
            if ';' in clean_filename:
                clean_filename = clean_filename.split(';')[0]
                
            # Try to get extension from filename
            if '.' in clean_filename:
                file_ext = '.' + clean_filename.rsplit('.', 1)[1].lower()
            
            # If that fails, try to get it from content type
            elif hasattr(audio_file, 'content_type'):
                # Clean up content type to remove parameters
                content_type = audio_file.content_type
                if ';' in content_type:
                    content_type = content_type.split(';')[0]
                    
                mime_to_ext = {
                    'audio/webm': '.webm',
                    'audio/mp3': '.mp3',
                    'audio/mpeg': '.mp3',
                    'audio/wav': '.wav',
                    'audio/x-wav': '.wav',
                    'audio/vnd.wave': '.wav',
                    'audio/opus': '.opus'
                }
                if content_type in mime_to_ext:
                    file_ext = mime_to_ext[content_type]
            
            safe_debug(f"Using file extension: {file_ext}")
            
            # Save the input audio to a temporary file
            with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext) as input_temp:
                input_temp_path = input_temp.name
                input_temp.write(audio_data)
            safe_debug(f"Audio data saved to temporary file: {input_temp_path}")
            
            # Create a temporary WAV file for the converted audio
            wav_temp = tempfile.NamedTemporaryFile(delete=False, suffix='.wav')
            wav_temp_path = wav_temp.name
            wav_temp.close()
            
            # Use FFmpeg to convert the audio to WAV format (faster than librosa)
            safe_debug(f"Converting audio to WAV using FFmpeg: {input_temp_path} -> {wav_temp_path}")
            start_time = time.time()
            
            ffmpeg_cmd = [
                'ffmpeg', 
                '-i', input_temp_path, 
                '-ar', '16000',  # Set sample rate to 16kHz
                '-ac', '1',      # Convert to mono
                '-y',            # Overwrite output file if it exists
                wav_temp_path
            ]
            
            process = subprocess.Popen(
                ffmpeg_cmd, 
                stdout=subprocess.PIPE, 
                stderr=subprocess.PIPE
            )
            stdout, stderr = process.communicate()
            
            if process.returncode != 0:
                stderr_message = stderr.decode() if stderr else "Unknown FFmpeg error"
                safe_error(f"FFmpeg conversion failed", stderr_message)
                
                # Create a more user-friendly error message
                if "header parsing failed" in stderr_message or "Invalid data" in stderr_message:
                    return jsonify({
                        "error": "Audio format error",
                        "details": "The audio data appears to be corrupted or in an unsupported format."
                    }), 400
                elif "misdetection possible" in stderr_message:
                    return jsonify({
                        "error": "Audio format detection failed",
                        "details": "The system could not properly detect the audio format."
                    }), 400
                else:
                    raise Exception(f"Audio conversion failed: {stderr_message}")
                
            conversion_time = time.time() - start_time
            safe_debug(f"FFmpeg conversion completed in {conversion_time:.2f} seconds")
            
            # Get the Whisper model
            model = load_whisper_model()
            if model is None:
                raise Exception("Whisper model could not be loaded.")

            # Perform transcription using the converted WAV file
            safe_debug("Transcribing audio with Whisper model...")
            start_time = time.time()
            
            segments, info = model.transcribe(
                wav_temp_path,
                language="en",
                beam_size=5,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500)
            )
            
            # Combine all text segments
            text = " ".join([segment.text for segment in segments]).strip()
            transcription_time = time.time() - start_time
            safe_info(f"Transcription completed in {transcription_time:.2f} seconds. Result: '{text}'")

            return jsonify({
                "success": True,
                "text": text,
                "language": info.language,
                "language_probability": info.language_probability
            })

        except Exception as e:
            safe_exception(f"Error during transcription process", e)
            return jsonify({
                "error": "Transcription failed",
                "details": str(e)
            }), 500
        finally:
            # Cleanup temporary files if they were created
            for temp_path in [input_temp_path, wav_temp_path]:
                if temp_path and os.path.exists(temp_path):
                    try:
                        os.unlink(temp_path)
                        safe_debug(f"Removed temporary file: {temp_path}")
                    except Exception as cleanup_error:
                        safe_warning(f"Failed to remove temporary file {temp_path}", cleanup_error)

    except Exception as e:
        # Catch errors happening before the inner try-finally (e.g., reading request files)
        safe_exception(f"Error processing transcription request", e)
        return jsonify({
            "error": "Error processing audio file request",
            "details": str(e)
        }), 500

# Profile management endpoints
@app.route("/api/profiles", methods=["GET"])
def get_profiles():
    try:
        return jsonify({"profiles": load_profiles()})
    except Exception as e:
        safe_exception("Error loading profiles", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/profiles", methods=["POST"])
def create_new_profile():
    try:
        data = request.json or {}
        name = data.get("name", "Profile")
        profile = create_profile(name)
        return jsonify(profile)
    except Exception as e:
        safe_exception("Error creating profile", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/profiles/<profile_id>", methods=["PUT"])
def update_existing_profile(profile_id):
    try:
        data = request.json or {}
        name = data.get("name")
        vectorize = data.get("vectorize")
        update_profile(profile_id, name, vectorize)
        return jsonify({"success": True})
    except Exception as e:
        safe_exception("Error updating profile", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/profiles/<profile_id>", methods=["DELETE"])
def delete_existing_profile(profile_id):
    try:
        delete_profile(profile_id)
        return jsonify({"success": True})
    except Exception as e:
        safe_exception("Error deleting profile", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/profiles/<profile_id>/files", methods=["GET"])
def list_profile_files(profile_id):
    try:
        files = profile_list_files(profile_id)
        return jsonify({"files": files})
    except Exception as e:
        safe_exception("Error listing profile files", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/profiles/<profile_id>/files", methods=["POST"])
def upload_profile_file(profile_id):
    try:
        if 'file' not in request.files:
            return jsonify({"error": "No file provided"}), 400
        file = request.files['file']
        filename = profile_save_file(profile_id, file)
        return jsonify({"file": filename})
    except Exception as e:
        safe_exception("Error uploading profile file", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/profiles/<profile_id>/files/<filename>", methods=["DELETE"])
def delete_profile_file_endpoint(profile_id, filename):
    try:
        profile_delete_file(profile_id, filename)
        return jsonify({"success": True})
    except Exception as e:
        safe_exception("Error deleting profile file", e)
        return jsonify({"error": str(e)}), 500

# Gallery data endpoints
@app.route("/api/gallery/save", methods=["POST"])
def save_gallery():
    """Save gallery data to a JSON file in the data directory"""
    try:
        # Get the data from the request
        data = request.json
        
        if not data:
            return jsonify({"error": "No data provided"}), 400
            
        # Ensure data directory exists using absolute paths
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        data_dir.mkdir(exist_ok=True)
        
        # Save to JSON file
        gallery_file = data_dir / "gallery.json"
        
        # Log the absolute path for debugging
        safe_debug(f"Saving gallery to: {gallery_file.absolute()}")
        
        # Pretty print JSON for readability with robust file handling
        with open(gallery_file, "w", encoding="utf-8") as f:
            f.truncate(0)  # Ensure file is completely empty first
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.flush()  # Force write to disk
            os.fsync(f.fileno())  # Force filesystem sync
            
        safe_debug(f"Gallery saved successfully with {len(data.get('creations', []))} creations")
        
        return jsonify({
            "success": True,
            "message": "Gallery saved successfully",
            "count": len(data.get("creations", [])),
            "path": str(gallery_file.absolute())
        })
    except Exception as e:
        safe_exception(f"Error saving gallery: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

@app.route("/api/gallery/load", methods=["GET"])
def load_gallery():
    """Load gallery data from the JSON file in the data directory"""
    try:
        # Ensure data directory exists using absolute paths
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        
        # Create data directory if it doesn't exist
        try:
            data_dir.mkdir(exist_ok=True)
            safe_debug(f"Data directory ensured for gallery at: {data_dir.absolute()}")
        except Exception as e:
            safe_error(f"Failed to create data directory: {str(e)}")
            # Continue - we'll handle the potential file not found below
        
        gallery_file = data_dir / "gallery.json"
        
        safe_debug(f"Attempting to load gallery from: {gallery_file.absolute()}")
        
        if not gallery_file.exists():
            safe_warning(f"Gallery file not found at {gallery_file.absolute()}, returning empty gallery")
            # Instead of returning a 404 error, return an empty gallery structure
            # This is more resilient for first-time usage
            return jsonify({
                "creations": [],
                "history": []
            })
            
        # Load data from JSON file
        with open(gallery_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        safe_debug(f"Gallery loaded successfully with {len(data.get('creations', []))} creations from {gallery_file.absolute()}")
        
        return jsonify(data)
    except FileNotFoundError:
        safe_warning(f"Gallery file not found at {gallery_file.absolute() if 'gallery_file' in locals() else 'unknown path'}")
        # Return empty gallery structure instead of an error
        return jsonify({
            "creations": [],
            "history": []
        })
    except json.JSONDecodeError as e:
        safe_error(f"Error parsing gallery JSON: {str(e)}", e)
        # If the JSON is invalid, return an empty gallery structure
        return jsonify({
            "creations": [],
            "history": [],
            "error": "Invalid gallery JSON format - using empty gallery"
        })
    except Exception as e:
        safe_exception(f"Error loading gallery: {str(e)}", e)
        # For any other error, return empty gallery with error info
        return jsonify({
            "creations": [],
            "history": [],
            "error": f"Error loading gallery: {str(e)}"
        })

@app.route("/api/gallery/clear", methods=["POST"])
def clear_gallery():
    """Clear all creations from the gallery"""
    try:
        # Ensure data directory exists using absolute paths
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        data_dir.mkdir(exist_ok=True)
        
        # Gallery file path
        gallery_file = data_dir / "gallery.json"
        
        safe_debug(f"Clearing gallery at: {gallery_file.absolute()}")
        
        # Save empty gallery structure
        empty_gallery = {
            "creations": [],
            "history": []
        }
        
        # Ensure file is completely overwritten by explicitly truncating
        with open(gallery_file, "w", encoding="utf-8") as f:
            f.truncate(0)  # Ensure file is completely empty
            json.dump(empty_gallery, f, indent=2, ensure_ascii=False)
            f.flush()  # Force write to disk
            os.fsync(f.fileno())  # Force filesystem sync
        
        safe_debug("Gallery cleared successfully")
        
        return jsonify({
            "message": "Gallery cleared successfully",
            "path": str(gallery_file.absolute())
        })
        
    except Exception as e:
        safe_exception(f"Error clearing gallery: {str(e)}", e)
        return jsonify({"error": f"Failed to clear gallery: {str(e)}"}), 500

@app.route("/api/chats/save", methods=["POST"])
def save_chats():
    """Save chat history data to the chats.json file in the data directory"""
    try:
        data = request.json
        safe_debug(f"Received chat history data to save", data)
        
        if not data:
            return jsonify({"error": "No data provided"}), 400
            
        # Ensure data directory exists using absolute paths
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        data_dir.mkdir(exist_ok=True)
        
        # Save to JSON file
        chats_file = data_dir / "chats.json"
        
        # Log the absolute path for debugging
        safe_debug(f"Saving chats to: {chats_file.absolute()}")
        
        # Check if we need to merge with existing chats file
        if chats_file.exists():
            try:
                with open(chats_file, "r", encoding="utf-8") as f:
                    existing_data = json.load(f)
                
                # If we're updating specific chats, merge them with existing data
                if 'updateChats' in data:
                    # Extract chats to update
                    chats_to_update = data['updateChats']
                    safe_debug(f"Updating {len(chats_to_update)} specific chats")
                    
                    # Create a map of existing chats by ID
                    existing_chats_map = {chat['id']: chat for chat in existing_data.get('chats', [])}
                    
                    # Update or add each chat
                    for updated_chat in chats_to_update:
                        existing_chats_map[updated_chat['id']] = updated_chat
                    
                    # Convert back to list
                    existing_data['chats'] = list(existing_chats_map.values())
                    
                    # Use the merged data
                    data_to_save = existing_data
                else:
                    # Replace all data
                    data_to_save = data
            except json.JSONDecodeError:
                # If the file is corrupted, just use the new data
                safe_warning(f"Existing chats file corrupt, replacing with new data")
                data_to_save = data
        else:
            # No existing file, just use the new data
            data_to_save = data
        
        # Pretty print JSON for readability
        with open(chats_file, "w", encoding="utf-8") as f:
            json.dump(data_to_save, f, indent=2, ensure_ascii=False)
            
        # Log success with basic stats
        chat_count = len(data_to_save.get('chats', []))
        safe_debug(f"Chat history saved successfully with {chat_count} chats")
        
        return jsonify({
            "success": True,
            "message": "Chat history saved successfully",
            "count": chat_count,
            "path": str(chats_file.absolute())
        })
    except Exception as e:
        safe_exception(f"Error saving chat history: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

@app.route("/api/chats/load", methods=["GET"])
def load_chats():
    """Load chat history data from the chats.json file in the data directory"""
    try:
        # Ensure data directory exists using absolute paths
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        
        # Create data directory if it doesn't exist
        try:
            data_dir.mkdir(exist_ok=True)
            safe_debug(f"Data directory ensured for chats at: {data_dir.absolute()}")
        except Exception as e:
            safe_error(f"Failed to create data directory: {str(e)}")
            # Continue - we'll handle the potential file not found below
        
        chats_file = data_dir / "chats.json"
        
        safe_debug(f"Attempting to load chat history from: {chats_file.absolute()}")
        
        if not chats_file.exists():
            safe_warning(f"Chats file not found at {chats_file.absolute()}, returning empty chat history")
            # Return an empty chats structure for first-time usage
            return jsonify({
                "chats": [],
                "meta": {
                    "source": "new_file",
                    "timestamp": datetime.now().isoformat()
                }
            })
            
        # Load data from JSON file
        with open(chats_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        # Validate and fix the structure if needed
        if not isinstance(data, dict):
            safe_warning(f"Invalid chats data structure, expected dict got {type(data).__name__}")
            data = {"chats": []}
        
        if "chats" not in data:
            safe_warning(f"Chats data missing 'chats' key, initializing it")
            data["chats"] = []
        
        # Verify each chat entry has required fields
        valid_chats = []
        for chat in data.get("chats", []):
            if not isinstance(chat, dict):
                safe_warning(f"Skipping invalid chat entry: {type(chat).__name__}")
                continue
                
            # Ensure required fields are present
            required_fields = ["id", "title", "model", "created_at", "updated_at"]
            missing_fields = [field for field in required_fields if field not in chat]
            
            if missing_fields:
                safe_warning(f"Chat missing required fields: {missing_fields}")
                continue
                
            # Check if this chat is in active_chats and add that info
            chat["active"] = chat.get("id") in active_chats
                
            # Ensure messages are properly structured if present
            if "messages" in chat:
                valid_messages = []
                previous_role = None
                for msg in chat["messages"]:
                    if not isinstance(msg, dict):
                        continue
                        
                    if "role" not in msg or "content" not in msg:
                        continue
                        
                    # Convert 'model' role to 'assistant' if needed
                    if msg["role"] == "model":
                        msg["role"] = "assistant"
                        
                    if msg["role"] not in ["user", "assistant"]:
                        continue
                        
                    # Combine consecutive assistant messages
                    if msg["role"] == "assistant" and previous_role == "assistant" and valid_messages:
                        # Append content to the previous assistant message
                        valid_messages[-1]["content"] += msg["content"]
                    else:
                        # Add as a new message
                        valid_messages.append(msg)
                    
                    previous_role = msg["role"]
                    
                chat["messages"] = valid_messages
                
            valid_chats.append(chat)
            
        data["chats"] = valid_chats
        
        # Add metadata
        data["meta"] = {
            "source": "file",
            "timestamp": datetime.now().isoformat(),
            "active_chats_count": len(active_chats),
            "file_path": str(chats_file.absolute())
        }
            
        chat_count = len(data.get('chats', []))
        message_count = sum(len(chat.get("messages", [])) for chat in data.get("chats", []))
        safe_debug(f"Chat history loaded successfully with {chat_count} chats containing {message_count} messages")
        
        return jsonify(data)
    except FileNotFoundError:
        safe_warning(f"Chats file not found at {chats_file.absolute() if 'chats_file' in locals() else 'unknown path'}")
        # Return empty chat structure instead of an error
        return jsonify({
            "chats": [],
            "meta": {
                "source": "error_not_found",
                "timestamp": datetime.now().isoformat()
            }
        })
    except json.JSONDecodeError as e:
        safe_error(f"Error parsing chats JSON: {str(e)}", e)
        # If the JSON is invalid, return an empty chats structure
        return jsonify({
            "chats": [],
            "meta": {
                "source": "error_invalid_json",
                "timestamp": datetime.now().isoformat(),
                "error": str(e)
            }
        })
    except Exception as e:
        safe_exception(f"Error loading chat history: {str(e)}", e)
        # For any other error, return empty chats with error info
        return jsonify({
            "chats": [],
            "meta": {
                "source": "error_exception",
                "timestamp": datetime.now().isoformat(),
                "error": str(e)
            }
        })

# Add new endpoint to update chat details
@app.route("/api/chats/<chat_id>/update", methods=["PUT"])
def update_chat_details(chat_id):
    """Update chat details such as title"""
    try:
        data = request.json
        safe_debug(f"Updating chat {chat_id} with data", data)
        
        if not data:
            return jsonify({"error": "No update data provided"}), 400
            
        # Check what fields we're updating
        updateable_fields = ["title"]
        fields_to_update = {}
        
        for field in updateable_fields:
            if field in data:
                fields_to_update[field] = data[field]
                
        if not fields_to_update:
            return jsonify({"error": "No valid fields to update"}), 400
            
        # Ensure data directory exists
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        chats_file = data_dir / "chats.json"
        
        if not chats_file.exists():
            return jsonify({"error": "Chat history file not found"}), 404
            
        # Load existing chat history
        with open(chats_file, "r", encoding="utf-8") as f:
            chat_history = json.load(f)
        
        # Find and update the specific chat
        chat_updated = False
        for chat in chat_history.get("chats", []):
            if chat.get("id") == chat_id:
                # Update fields
                for field, value in fields_to_update.items():
                    chat[field] = value
                    
                # Update timestamp
                chat["updated_at"] = datetime.now().isoformat()
                chat_updated = True
                break
                
        if not chat_updated:
            return jsonify({"error": "Chat not found in history"}), 404
            
        # Save updated chat history
        with open(chats_file, "w", encoding="utf-8") as f:
            json.dump(chat_history, f, indent=2, ensure_ascii=False)
            
        safe_debug(f"Updated chat {chat_id} with fields: {list(fields_to_update.keys())}")
        
        return jsonify({
            "success": True,
            "message": f"Chat {chat_id} updated successfully",
            "updated_fields": list(fields_to_update.keys())
        })
    except Exception as e:
        safe_exception(f"Error updating chat details: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Update tags for a specific message
@app.route("/api/chats/<chat_id>/messages/<int:msg_index>/tags", methods=["PUT"])
def update_message_tags(chat_id, msg_index):
    """Update tags on a specific message"""
    try:
        data = request.json or {}
        tags = data.get("tags", [])

        if not isinstance(tags, list):
            return jsonify({"error": "Tags must be an array"}), 400

        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        chats_file = data_dir / "chats.json"

        if not chats_file.exists():
            return jsonify({"error": "Chat history file not found"}), 404

        with open(chats_file, "r", encoding="utf-8") as f:
            chat_history = json.load(f)

        found = False
        for chat in chat_history.get("chats", []):
            if chat.get("id") == chat_id:
                messages = chat.get("messages", [])
                if 0 <= msg_index < len(messages):
                    messages[msg_index]["tags"] = tags
                    chat["updated_at"] = datetime.now().isoformat()
                    found = True
                break

        if not found:
            return jsonify({"error": "Message not found"}), 404

        with open(chats_file, "w", encoding="utf-8") as f:
            json.dump(chat_history, f, indent=2, ensure_ascii=False)

        return jsonify({"success": True, "tags": tags})
    except Exception as e:
        safe_exception(f"Error updating message tags: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Add endpoint to create a new chat entry in history without starting a conversation
@app.route("/api/chats/create", methods=["POST"])
def create_chat_entry():
    """Create a new chat entry in the history without starting a conversation"""
    try:
        data = request.json or {}
        
        # Generate a unique ID for the new chat
        chat_id = data.get("id", f"chat-{int(time.time())}-{str(hash(datetime.now().isoformat()))[:8]}")
        
        # Set default metadata
        timestamp = datetime.now().isoformat()
        chat_title = data.get("title", "New Chat")
        model_name = data.get("model", settings["model"])
        
        # Create the chat entry
        new_chat = {
            "id": chat_id,
            "title": chat_title,
            "model": model_name,
            "created_at": timestamp,
            "updated_at": timestamp,
            "first_message": data.get("first_message", ""),
            "messages": []  # Start with empty messages
        }
        
        # Ensure data directory exists
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        data_dir.mkdir(exist_ok=True)
        chats_file = data_dir / "chats.json"
        
        # Load existing chat history or create new one
        chat_history = {"chats": []}
        if chats_file.exists():
            try:
                with open(chats_file, "r", encoding="utf-8") as f:
                    chat_history = json.load(f)
            except json.JSONDecodeError:
                safe_warning(f"Invalid JSON in chats file, starting with empty history")
                chat_history = {"chats": []}
        
        # Add the new chat to history
        chat_history.setdefault("chats", []).append(new_chat)
        
        # Save updated chat history
        with open(chats_file, "w", encoding="utf-8") as f:
            json.dump(chat_history, f, indent=2, ensure_ascii=False)
        
        safe_debug(f"Created new chat entry with ID: {chat_id}")
        
        return jsonify({
            "success": True,
            "message": "New chat created",
            "chat_id": chat_id,
            "chat": new_chat
        })
    except Exception as e:
        safe_exception(f"Error creating new chat entry: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Add endpoint for exporting chat history as backup
@app.route("/api/chats/export", methods=["GET"])
def export_chat_history():
    """Export the entire chat history as a downloadable JSON file"""
    try:
        # Ensure data directory exists
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        chats_file = data_dir / "chats.json"
        
        if not chats_file.exists():
            return jsonify({"error": "Chat history file not found"}), 404
            
        # Load existing chat history
        with open(chats_file, "r", encoding="utf-8") as f:
            chat_history = json.load(f)
        
        # Add export metadata
        export_data = {
            "data": chat_history,
            "meta": {
                "exported_at": datetime.now().isoformat(),
                "version": "1.0",
                "format": "atlas_chat_backup",
                "chat_count": len(chat_history.get("chats", []))
            }
        }
        
        # Create response with the JSON data
        response = make_response(json.dumps(export_data, indent=2, ensure_ascii=False))
        response.headers.set("Content-Type", "application/json")
        
        # Generate a timestamp for the filename
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"atlas_chat_backup_{timestamp}.json"
        
        # Set the file as an attachment with the generated filename
        response.headers.set("Content-Disposition", f"attachment; filename={filename}")
        
        safe_debug(f"Exporting chat history with {len(chat_history.get('chats', []))} chats")
        return response
    except Exception as e:
        safe_exception(f"Error exporting chat history: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Add endpoint for importing chat history from backup
@app.route("/api/chats/import", methods=["POST"])
def import_chat_history():
    """Import chat history from a backup JSON file"""
    try:
        # Check if the post request has the file part
        if 'backup_file' not in request.files:
            return jsonify({"error": "No backup file provided"}), 400
            
        backup_file = request.files['backup_file']
        if backup_file.filename == '':
            return jsonify({"error": "No file selected"}), 400
            
        # Check for merge option - whether to replace or merge with existing chats
        merge_mode = request.form.get('merge_mode', 'merge')  # 'merge' or 'replace'
        safe_debug(f"Importing chat history with merge mode: {merge_mode}")
        
        # Read and parse the backup file
        try:
            backup_data = json.loads(backup_file.read().decode('utf-8'))
        except json.JSONDecodeError:
            return jsonify({"error": "Invalid backup file format (not valid JSON)"}), 400
            
        # Validate the backup data structure
        if not isinstance(backup_data, dict):
            return jsonify({"error": "Invalid backup format (not a JSON object)"}), 400
            
        # Handle both legacy format (direct chats object) and new format with metadata
        chats_to_import = None
        if "data" in backup_data and isinstance(backup_data["data"], dict) and "chats" in backup_data["data"]:
            # New format with metadata
            chats_to_import = backup_data["data"]["chats"]
        elif "chats" in backup_data:
            # Direct format without metadata wrapper
            chats_to_import = backup_data["chats"]
        else:
            return jsonify({"error": "Invalid backup format (missing 'chats' field)"}), 400
            
        if not isinstance(chats_to_import, list):
            return jsonify({"error": "Invalid backup format ('chats' is not an array)"}), 400
            
        # Ensure data directory exists
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        data_dir.mkdir(exist_ok=True)
        chats_file = data_dir / "chats.json"
        
        # If we're using "merge" mode, load existing chats
        existing_chats = []
        if merge_mode == 'merge' and chats_file.exists():
            try:
                with open(chats_file, "r", encoding="utf-8") as f:
                    existing_data = json.load(f)
                existing_chats = existing_data.get("chats", [])
            except json.JSONDecodeError:
                safe_warning(f"Invalid JSON in existing chats file, treating as empty")
                existing_chats = []
                
        # Create a map of existing chats by ID
        existing_chat_map = {chat.get("id"): chat for chat in existing_chats if "id" in chat}
        
        # Process imported chats
        imported_count = 0
        updated_count = 0
        skipped_count = 0
        final_chats = []
        
        # Timestamp for import note
        import_timestamp = datetime.now().isoformat()
        
        for chat in chats_to_import:
            # Validate chat has the minimum required fields
            if not isinstance(chat, dict) or "id" not in chat:
                skipped_count += 1
                continue
                
            # Check if this chat ID already exists
            if chat["id"] in existing_chat_map:
                if merge_mode == 'merge':
                    # Add import note
                    chat["import_note"] = f"Updated during import on {import_timestamp}"
                    final_chats.append(chat)
                    updated_count += 1
                else:
                    # In replace mode, only add chats from the import
                    chat["import_note"] = f"Imported on {import_timestamp}"
                    final_chats.append(chat)
                    imported_count += 1
            else:
                # This is a new chat
                chat["import_note"] = f"Imported on {import_timestamp}"
                final_chats.append(chat)
                imported_count += 1
        
        # In merge mode, add existing chats that weren't replaced
        if merge_mode == 'merge':
            imported_ids = {chat.get("id") for chat in final_chats}
            for chat_id, chat in existing_chat_map.items():
                if chat_id not in imported_ids:
                    final_chats.append(chat)
        
        # Save the new chat history
        with open(chats_file, "w", encoding="utf-8") as f:
            json.dump({"chats": final_chats}, f, indent=2, ensure_ascii=False)
            
        safe_info(f"Chat history import complete. Imported: {imported_count}, Updated: {updated_count}, Skipped: {skipped_count}")
        
        return jsonify({
            "success": True,
            "message": "Chat history import complete",
            "stats": {
                "imported_count": imported_count,
                "updated_count": updated_count,
                "skipped_count": skipped_count,
                "total_chats": len(final_chats)
            }
        })
    except Exception as e:
        safe_exception(f"Error importing chat history: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Add endpoint for getting chat stats
@app.route("/api/chats/stats", methods=["GET"])
def get_chat_stats():
    """Get statistics about chat history"""
    try:
        # Ensure data directory exists
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        chats_file = data_dir / "chats.json"
        
        if not chats_file.exists():
            return jsonify({
                "total_chats": 0,
                "active_chats": 0,
                "total_messages": 0,
                "has_chat_history": False
            })
            
        # Load existing chat history
        with open(chats_file, "r", encoding="utf-8") as f:
            chat_history = json.load(f)
        
        # Get list of chats
        chats = chat_history.get("chats", [])
        
        # Count active chats (those in the active_chats dictionary)
        active_chat_count = 0
        for chat in chats:
            if chat.get("id") in active_chats:
                active_chat_count += 1
        
        # Count total messages
        total_messages = 0
        user_messages = 0
        assistant_messages = 0
        oldest_chat = None
        newest_chat = None
        chat_with_most_messages = None
        most_messages_count = 0
        
        for chat in chats:
            messages = chat.get("messages", [])
            message_count = len(messages)
            
            # Update total message count
            total_messages += message_count
            
            # Count by role
            for msg in messages:
                if msg.get("role") == "user":
                    user_messages += 1
                elif msg.get("role") == "assistant":
                    assistant_messages += 1
            
            # Track chat with most messages
            if message_count > most_messages_count:
                most_messages_count = message_count
                chat_with_most_messages = chat.get("id")
            
            # Track oldest chat
            if "created_at" in chat:
                created_at = chat["created_at"]
                if oldest_chat is None or created_at < oldest_chat["date"]:
                    oldest_chat = {
                        "id": chat.get("id"),
                        "date": created_at,
                        "title": chat.get("title", "Unknown")
                    }
            
            # Track newest chat
            if "updated_at" in chat:
                updated_at = chat["updated_at"]
                if newest_chat is None or updated_at > newest_chat["date"]:
                    newest_chat = {
                        "id": chat.get("id"),
                        "date": updated_at,
                        "title": chat.get("title", "Unknown")
                    }
        
        # Calculate average messages per chat
        avg_messages_per_chat = total_messages / len(chats) if chats else 0
        
        # Get stats on file size
        file_size = os.path.getsize(chats_file) if chats_file.exists() else 0
        file_size_kb = file_size / 1024
        
        # Compile stats
        stats = {
            "total_chats": len(chats),
            "active_chats": active_chat_count,
            "total_messages": total_messages,
            "user_messages": user_messages,
            "assistant_messages": assistant_messages,
            "messages_ratio": {
                "user": user_messages / total_messages if total_messages > 0 else 0,
                "assistant": assistant_messages / total_messages if total_messages > 0 else 0
            },
            "avg_messages_per_chat": avg_messages_per_chat,
            "oldest_chat": oldest_chat,
            "newest_chat": newest_chat,
            "chat_with_most_messages": {
                "id": chat_with_most_messages,
                "count": most_messages_count
            } if chat_with_most_messages else None,
            "file_size": {
                "bytes": file_size,
                "kb": file_size_kb,
                "mb": file_size_kb / 1024
            },
            "has_chat_history": len(chats) > 0,
            "timestamp": datetime.now().isoformat()
        }
        
        return jsonify(stats)
    except Exception as e:
        safe_exception(f"Error getting chat stats: {str(e)}", e)
        return jsonify({
            "error": str(e),
            "total_chats": 0,
            "has_chat_history": False
        }), 500

# Advanced search endpoint
@app.route("/api/chats/search", methods=["GET"])
def search_chats():
    """Search chat messages with optional date range and tags"""
    try:
        query = request.args.get("q", "").lower()
        start_date = request.args.get("start")
        end_date = request.args.get("end")
        tags_param = request.args.get("tags")
        tag_list = [t.strip().lower() for t in tags_param.split(",") if t.strip()] if tags_param else []

        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        chats_file = data_dir / "chats.json"

        if not chats_file.exists():
            return jsonify({"results": [], "total": 0})

        with open(chats_file, "r", encoding="utf-8") as f:
            chat_history = json.load(f)

        results = []
        for chat in chat_history.get("chats", []):
            messages = chat.get("messages", [])
            for idx, msg in enumerate(messages):
                content = msg.get("content", "")

                if query and query not in content.lower():
                    continue

                timestamp = msg.get("timestamp")
                if start_date and timestamp and timestamp < start_date:
                    continue
                if end_date and timestamp and timestamp > end_date:
                    continue

                msg_tags = [t.lower() for t in msg.get("tags", [])]
                if tag_list and not set(tag_list).issubset(msg_tags):
                    continue

                results.append({
                    "chat_id": chat.get("id"),
                    "chat_title": chat.get("title"),
                    "message_index": idx,
                    "role": msg.get("role"),
                    "content": content,
                    "timestamp": timestamp,
                    "tags": msg.get("tags", [])
                })

        return jsonify({"results": results, "total": len(results)})
    except Exception as e:
        safe_exception(f"Error searching chats: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Add endpoint for bulk deleting chats
@app.route("/api/chats/bulk-delete", methods=["POST"])
def bulk_delete_chats():
    """Delete multiple chats at once"""
    try:
        data = request.json
        chat_ids = data.get("chat_ids", [])
        
        if not chat_ids:
            return jsonify({"error": "No chat IDs provided"}), 400
            
        # Ensure data directory exists
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        chats_file = data_dir / "chats.json"
        
        if not chats_file.exists():
            return jsonify({"error": "Chat history file not found"}), 404
            
        # Load existing chat history
        with open(chats_file, "r", encoding="utf-8") as f:
            chat_history = json.load(f)
        
        # Get list of chats
        chats = chat_history.get("chats", [])
        original_count = len(chats)
        
        # Filter out chats to delete
        chat_history["chats"] = [chat for chat in chats if chat.get("id") not in chat_ids]
        new_count = len(chat_history["chats"])
        
        # Calculate how many were actually deleted
        deleted_count = original_count - new_count
        
        # Save updated chat history
        with open(chats_file, "w", encoding="utf-8") as f:
            json.dump(chat_history, f, indent=2, ensure_ascii=False)
        
        # Also remove from active_chats if present
        active_deleted = 0
        for chat_id in chat_ids:
            if chat_id in active_chats:
                chat = active_chats[chat_id]
                
                # Delete associated files
                if hasattr(chat, 'files') and chat.files:
                    for file_id in list(chat.files):
                        try:
                            client.files.delete(name=file_id)
                        except Exception as file_error:
                            safe_debug(f"Error deleting file {file_id}: {str(file_error)}", file_error)
                
                # Remove from active chats
                del active_chats[chat_id]
                active_deleted += 1
        
        safe_info(f"Bulk deleted {deleted_count} chats from history and {active_deleted} from active sessions")
        
        return jsonify({
            "success": True,
            "message": f"Deleted {deleted_count} chats",
            "stats": {
                "requested": len(chat_ids),
                "deleted_from_history": deleted_count,
                "deleted_from_active": active_deleted,
                "remaining_chats": new_count
            }
        })
    except Exception as e:
        safe_exception(f"Error bulk deleting chats: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Add endpoint for clearing all chat history
@app.route("/api/chats/clear-all", methods=["POST"])
def clear_all_chats():
    """Clear all chat history"""
    try:
        # Check for confirmation
        data = request.json or {}
        confirmation = data.get("confirmation", "").lower()
        
        if confirmation != "confirm_delete_all":
            return jsonify({"error": "Confirmation required to delete all chats"}), 400
        
        # Ensure data directory exists
        data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
        chats_file = data_dir / "chats.json"
        
        # Count how many chats were in history
        chats_count = 0
        if chats_file.exists():
            try:
                with open(chats_file, "r", encoding="utf-8") as f:
                    chat_history = json.load(f)
                chats_count = len(chat_history.get("chats", []))
            except Exception:
                pass
        
        # Create empty chat history
        with open(chats_file, "w", encoding="utf-8") as f:
            json.dump({"chats": []}, f, indent=2, ensure_ascii=False)
        
        # Clean up files from active chats
        active_count = len(active_chats)
        deleted_files = 0
        
        for chat_id, chat in list(active_chats.items()):
            # Delete associated files
            if hasattr(chat, 'files') and chat.files:
                for file_id in list(chat.files):
                    try:
                        client.files.delete(name=file_id)
                        deleted_files += 1
                    except Exception as file_error:
                        safe_debug(f"Error deleting file {file_id}: {str(file_error)}", file_error)
        
        # Clear active chats
        active_chats.clear()
        
        safe_info(f"Cleared all chat history. Removed {chats_count} chats from history and {active_count} active sessions")
        
        return jsonify({
            "success": True,
            "message": "All chat history cleared",
            "stats": {
                "removed_from_history": chats_count,
                "removed_from_active": active_count,
                "deleted_files": deleted_files
            }
        })
    except Exception as e:
        safe_exception(f"Error clearing all chat history: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Add route for deleting a chat to match the route used by the frontend
@app.route("/api/chat/<chat_id>/delete", methods=["DELETE"])
def delete_chat(chat_id):
    """Delete a chat - route to match frontend expectation"""
    try:
        # Call our dedicated chat deletion function
        return delete_chat_from_history(chat_id)
    except Exception as e:
        safe_exception(f"Error in delete_chat: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Add a new endpoint to reset/clear a chat's messages (not delete the chat entry)
@app.route("/api/chat/<chat_id>/reset", methods=["POST"])
def reset_chat_messages(chat_id):
    """Clear a chat's messages without deleting the chat entry from history"""
    try:
        chat_was_active = False
        
        # Remove from active chats if it exists (clearing the message history)
        if chat_id in active_chats:
            chat = active_chats[chat_id]
            chat_was_active = True
            
            # Delete files associated with this chat session
            if hasattr(chat, 'files') and chat.files:
                safe_debug(f"Deleting {len(chat.files)} files associated with chat {chat_id}", chat.files)
                for file_id in list(chat.files):  # Create a copy of the set to avoid modification during iteration
                    try:
                        # Clean file_id for local file lookup
                        clean_file_id = file_id.replace("files/", "")
                        local_file_path = temp_files_dir / f"{clean_file_id}.pdf"
                        
                        # Delete local temp file if it exists
                        if local_file_path.exists():
                            os.remove(local_file_path)
                            safe_debug(f"Deleted local temp file: {local_file_path}")
                        
                        # Delete from Gemini API
                        safe_debug(f"Deleting file {file_id} from File API", file_id)
                        client.files.delete(name=file_id)
                        chat.files.remove(file_id)
                        safe_debug(f"Successfully deleted file {file_id}", file_id)
                    except Exception as file_error:
                        safe_debug(f"Error deleting file {file_id}: {str(file_error)}", file_error)
            
            # Delete the chat session from active_chats
            del active_chats[chat_id]
        
        # Update the chat entry in the history file (keeping the entry but clearing messages)
        chat_found_in_history = False
        try:
            # Load chat history
            data_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "data")))
            chats_file = data_dir / "chats.json"
            
            if chats_file.exists():
                with open(chats_file, "r", encoding="utf-8") as f:
                    chat_history = json.load(f)
                
                # Find the chat entry and clear its messages
                for chat_entry in chat_history.get("chats", []):
                    if chat_entry.get("id") == chat_id:
                        chat_found_in_history = True
                        # Clear messages but keep the chat entry
                        chat_entry["messages"] = []
                        # Update timestamp
                        chat_entry["updated_at"] = datetime.now().isoformat()
                        # Set cleared flag
                        chat_entry["cleared"] = True
                        break
                
                # Only save if we found and modified the chat
                if chat_found_in_history:
                    with open(chats_file, "w", encoding="utf-8") as f:
                        json.dump(chat_history, f, indent=2, ensure_ascii=False)
                    
                    safe_debug(f"Reset messages for chat {chat_id} in history file")
        except Exception as e:
            # Don't fail if chat history update fails
            safe_error(f"Failed to reset chat messages in history file: {str(e)}", e)
        
        if chat_was_active or chat_found_in_history:
            return jsonify({
                "success": True, 
                "message": f"Chat {chat_id} messages cleared successfully",
                "chat_id": chat_id
            })
        else:
            return jsonify({"error": "Chat not found in active sessions or history"}), 404
            
    except Exception as e:
        safe_exception(f"Error resetting chat messages: {str(e)}", e)
        return jsonify({"error": str(e)}), 500

# Import and register task endpoints
try:
    from app_tasks import register_task_endpoints
    register_task_endpoints(app)
    logger.info("Task endpoints registered successfully")
except Exception as e:
    logger.error(f"Failed to register task endpoints: {str(e)}")

def cleanup_on_exit():
    """Cleanup function to be called on application exit"""
    try:
        logger.info("Application shutting down, cleaning up Whisper model...")
        cleanup_whisper_model()
        logger.info("Cleanup completed")
    except Exception as e:
        print(f"Error during cleanup: {e}")

def signal_handler(sig, frame):
    """Handle termination signals"""
    print(f"\nReceived signal {sig}, performing cleanup...")
    cleanup_on_exit()
    sys.exit(0)

# Register cleanup functions
atexit.register(cleanup_on_exit)
signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# Add endpoint to manually reinitialize Whisper model
@app.route("/api/whisper/reinitialize", methods=["POST"])
def reinitialize_whisper():
    """Manually reinitialize the Whisper model (useful for recovering from OpenMP issues)"""
    try:
        logger.info("Manual Whisper model reinitialization requested")
        
        # Force cleanup and garbage collection
        cleanup_whisper_model()

        time.sleep(1)
        
        # Force another garbage collection
        gc.collect()
        
        # Reinitialize the model
        initialize_whisper_model()
        
        return jsonify({
            "success": True,
            "message": "Whisper model reinitialized successfully",
            "model_loaded": whisper_model is not None
        })
    except Exception as e:
        logger.exception(f"Error reinitializing Whisper model: {str(e)}")
        return jsonify({
            "error": "Failed to reinitialize Whisper model",
            "details": str(e),
            "model_loaded": whisper_model is not None
        }), 500



if __name__ == "__main__":
    try:
        safe_debug("Starting Flask application with SocketIO")
        socketio.run(app, debug=True, host="0.0.0.0", port=5000, allow_unsafe_werkzeug=True)
    except Exception as e:
        print(f"Error starting Flask application: {str(e)}")
        # Log to a separate file in case logging itself is the issue
        try:
            with open(os.path.join(logs_dir, 'startup_error.log'), 'a', encoding='utf-8') as f:
                f.write(f"{datetime.now().isoformat()}: Error starting Flask application: {str(e)}\n")
        except:
            # If even that fails, just print to console
            print("Additionally, could not write to error log file")
        # Perform cleanup before exit
        cleanup_on_exit()
        # Exit with error code
        sys.exit(1) 