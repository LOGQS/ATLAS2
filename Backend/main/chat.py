# status: to clean up later

import os
import json
import time
import threading
from queue import Queue
from datetime import datetime
from pathlib import Path
from utils.logger import safe_info, safe_warning, safe_exception
from utils.prompts import creations_system_instruction
from ai_functions import supports_file_attachments, create_gemini_chat_with_files, create_unified_chat_response

# Global variables that will be set by app.py
socketio = None
settings = None
active_chats = None

def initialize_chat_module(app_socketio, app_settings, app_active_chats):
    """Initialize global variables from app.py"""
    global socketio, settings, active_chats
    socketio = app_socketio
    settings = app_settings
    active_chats = app_active_chats

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