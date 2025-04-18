import os
import json
import logging
import time
import sys
from pathlib import Path
from datetime import datetime
from flask import Flask, request, jsonify, Response, stream_with_context
from dotenv import load_dotenv
from google import genai
from google.genai import types
from logging.handlers import RotatingFileHandler

# Configure logger for tasks separately from the main app
# Create logs directory if it doesn't exist
logs_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
if not os.path.exists(logs_dir):
    os.makedirs(logs_dir)

# Define the log file path for tasks
task_log_file = os.path.join(logs_dir, 'atlas_task.log')

# Try to clean the log file if it already exists to ensure a fresh start
if os.path.exists(task_log_file):
    try:
        # Try to truncate the file rather than removing it
        with open(task_log_file, 'w', encoding='utf-8') as f:
            pass  # Just truncate the file
    except (PermissionError, OSError) as e:
        # If we can't access the file, create a new one with timestamp
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        task_log_file = os.path.join(logs_dir, f'atlas_task_{timestamp}.log')
        print(f"Cannot access existing task log file, creating new one: {task_log_file}")

# Configure task logger with both console and file handlers
task_logger = logging.getLogger("atlas_tasks")
task_logger.setLevel(logging.DEBUG)

# Format for both handlers
log_format = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

# Console handler - Configure with UTF-8 encoding to handle Unicode characters
console_handler = logging.StreamHandler(stream=sys.stdout)
console_handler.setLevel(logging.DEBUG)
console_handler.setFormatter(log_format)

# File handler (rotating with max size of 10MB, keeping 5 backup files)
file_handler = RotatingFileHandler(task_log_file, maxBytes=10*1024*1024, backupCount=5, encoding='utf-8')
file_handler.setLevel(logging.DEBUG)
file_handler.setFormatter(log_format)

# Add both handlers
task_logger.addHandler(console_handler)
task_logger.addHandler(file_handler)

task_logger.info(f"Task logging configured to file: {task_log_file}")

# Helper function to safely log complex data structures
def safe_log_task_data(data, max_length=1000):
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

# Add safe logging methods for tasks
def task_debug(message, data=None):
    """Safely log debug messages with potentially problematic data"""
    if data is not None:
        safe_data = safe_log_task_data(data)
        task_logger.debug(f"{message}: {safe_data}")
    else:
        task_logger.debug(message)

def task_info(message, data=None):
    """Safely log info messages with potentially problematic data"""
    if data is not None:
        safe_data = safe_log_task_data(data)
        task_logger.info(f"{message}: {safe_data}")
    else:
        task_logger.info(message)

def task_warning(message, data=None):
    """Safely log warning messages with potentially problematic data"""
    if data is not None:
        safe_data = safe_log_task_data(data)
        task_logger.warning(f"{message}: {safe_data}")
    else:
        task_logger.warning(message)

def task_error(message, data=None):
    """Safely log error messages with potentially problematic data"""
    if data is not None:
        safe_data = safe_log_task_data(data)
        task_logger.error(f"{message}: {safe_data}")
    else:
        task_logger.error(message)

def task_exception(message, exception=None):
    """Safely log exceptions with potentially problematic data"""
    if exception is not None:
        safe_exc = str(exception).encode('utf-8', errors='replace').decode('utf-8')
        task_logger.exception(f"{message}: {safe_exc}")
    else:
        task_logger.exception(message)

# Load environment variables
load_dotenv()

# Configure Google Generative AI - reuse the same Gemini API key
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
client = genai.Client(api_key=GEMINI_API_KEY)

# Dictionary to store active task chat sessions
active_task_chats = {}

# Define task_chats file path within the data directory
data_dir = Path(os.path.abspath(os.path.join(os.getcwd(), "data")))
task_chats_file = data_dir / "task_chats.json"

# Ensure task_chats.json exists at startup
try:
    if not task_chats_file.exists():
        with open(task_chats_file, 'w', encoding='utf-8') as f:
            json.dump({"tasks": []}, f, indent=2, ensure_ascii=False)  # Start with an empty JSON object
        task_info(f"Created empty task chats file at: {task_chats_file}")
    else:
        # Validate if the file is valid JSON
        try:
            with open(task_chats_file, 'r', encoding='utf-8') as f:
                json.load(f)
            task_info(f"Task chats file verified at: {task_chats_file}")
        except json.JSONDecodeError:
            task_warning(f"Task chats file at {task_chats_file} is not valid JSON. Creating a new file.")
            with open(task_chats_file, 'w', encoding='utf-8') as f:
                json.dump({"tasks": []}, f, indent=2, ensure_ascii=False)
except Exception as e:
    task_error(f"Failed to create or verify task chats file: {str(e)}")

def register_task_endpoints(app):
    """Register all task-related endpoints with the main Flask app"""
    
    @app.route("/api/tasks/chat", methods=["POST"])
    def task_chat():
        """Handle task chat interactions with Gemini API"""
        try:
            data = request.json
            
            if not data:
                return jsonify({"error": "No data provided"}), 400
                
            # Extract request parameters
            messages = data.get("messages", [])
            task_id = data.get("task_id")
            model_name = data.get("model", "gemini-2.5-flash-preview-04-17")
            new_task = task_id is None
            history_messages = data.get("history", [])
            
            # Generate task title from first message or use default
            task_title = data.get("title", "New Task")
            if not task_title and messages and len(messages) > 0 and messages[0].get("content"):
                # Use the first part of the user's first message as the title
                task_title = messages[0].get("content", "")[:50]
                if len(task_title) == 50:
                    task_title += "..."
            
            # Generate timestamp for new/updated tasks
            timestamp = datetime.now().isoformat()
            
            # Load existing task history
            try:
                with open(task_chats_file, "r", encoding="utf-8") as f:
                    task_history = json.load(f)
            except (json.JSONDecodeError, FileNotFoundError):
                # If file doesn't exist or is corrupt, create new structure
                task_history = {"tasks": []}
            
            # Handle task history management
            if new_task:
                # Generate a new unique task ID
                task_id = f"task_{int(time.time() * 1000)}"
                
                # Create a new task in the history
                new_task_meta = {
                    "id": task_id,
                    "title": task_title,
                    "model": model_name,
                    "created_at": timestamp,
                    "updated_at": timestamp,
                    "status": "in_progress",
                    "first_message": messages[0]["content"][:100] if messages and "content" in messages[0] else ""
                }
                task_history.setdefault("tasks", []).append(new_task_meta)
                task_debug(f"Added new task to history: {task_id}", new_task_meta)
            else:
                # Update existing task timestamp
                for task_entry in task_history.get("tasks", []):
                    if task_entry["id"] == task_id:
                        task_entry["updated_at"] = timestamp
                        # Make sure we have the latest title
                        task_title = task_entry.get("title", task_title)
                        break
            
            # Save updated task history
            with open(task_chats_file, "w", encoding="utf-8") as f:
                json.dump(task_history, f, indent=2, ensure_ascii=False)
            
            # Create a new task chat or get the existing one
            if new_task or task_id not in active_task_chats:
                task_logger.debug(f"Creating new task chat with model: {model_name}")
                
                # Initialize chat with history if available (for existing tasks loaded from file)
                if history_messages:
                    # Convert history messages to the format expected by the API
                    api_history = []
                    for msg in history_messages:
                        role = "model" if msg["role"] == "assistant" else msg["role"]
                        api_history.append(
                            types.Content(
                                role=role,
                                parts=[types.Part(text=msg["content"])]
                            )
                        )
                    
                    task_debug(f"Initializing task chat with {len(api_history)} history messages")
                    task_chat = client.chats.create(
                        model=model_name,
                        history=api_history
                    )
                else:
                    # For truly new tasks with no history
                    task_chat = client.chats.create(model=model_name)
                
                # Store the chat in our dictionary
                active_task_chats[task_id] = task_chat
                task_logger.debug(f"New task chat session created with ID: {task_id}")
            else:
                # Retrieve the existing task chat session
                task_logger.debug(f"Retrieving existing task chat session: {task_id}")
                task_chat = active_task_chats[task_id]
            
            # Get the latest user message
            latest_message = messages[-1] if messages and messages[-1]["role"] == "user" else None
            
            if not latest_message:
                return jsonify({"error": "No user message provided"}), 400
            
            # Extract the content from the latest message
            user_content = latest_message.get("content", "")
            
            if not user_content:
                return jsonify({"error": "Empty message content"}), 400
            
            # Prepare to stream the response
            def generate():
                # Add a try-except block around the entire streaming process
                try:
                    system_instruction = """You are an AI assistant specialized in helping users complete tasks. 
                    Break down complex tasks into steps, track progress, and provide guidance at each stage. 
                    Be proactive in suggesting next actions and identifying potential issues. 
                    Keep responses concise and action-oriented.

                    CRITICAL FORMAT REQUIREMENT: You MUST structure your response EXACTLY as shown below, with no deviations.
                    Your ENTIRE response must be a task plan contained within the delimiters.

                    $$Plan$$
                    # TASK TITLE: [Clear descriptive title]

                    ## Objective
                    [Brief description of the task objective]

                    ## Steps
                    1. [First step]
                    2. [Second step] 
                    3. [Third step]
                    $PlanEnd$

                    FORMAT RULES (FOLLOW PRECISELY):
                    1. Start with the exact delimiter: $$Plan$$
                    2. First line must be: # TASK TITLE: followed by a descriptive title
                    3. Include the exact heading: ## Objective
                    4. Include the exact heading: ## Steps
                    5. Number all steps sequentially
                    6. End with the exact delimiter: $PlanEnd$
                    7. DO NOT include ANY text outside the $$Plan$$ and $PlanEnd$ delimiters
                    8. DO NOT include ANY emoji or status indicators (✅, 🔄, ❌) in your plan
                    9. DO NOT include ANY additional explanations or comments

                    FINAL CHECK: Review your response before submitting to ensure it contains ONLY the formatted plan between the required delimiters. Your entire response must match the format example exactly.
                    """
                    
                    # Send the task ID as the first chunk so the frontend can track it
                    yield f"data: {json.dumps({'task_id': task_id})}\n\n"
                    
                    # Log start of streaming
                    if new_task:
                        task_info(f"Starting streaming for task: {task_id}")
                    
                    # Use streaming response for better user experience
                    task_debug(f"Sending message to Gemini API: {user_content[:50]}...")
                    stream = task_chat.send_message_stream(
                        user_content,
                        config=types.GenerateContentConfig(
                            system_instruction=system_instruction
                        )
                    )
                    
                    # Add a delay before sending the first chunk
                    # This gives the frontend time to fully set up and be ready to receive content
                    task_debug("Adding initial delay before sending first chunk...")
                    time.sleep(1)
                    
                    # Stream each chunk of the response
                    first_chunk = True
                    chunk_count = 0
                    total_chars_sent = 0
                    last_activity_time = time.time()
                    heartbeat_interval = 2.0  # Send heartbeat every 2 seconds if no activity

                    for chunk in stream:
                        # Check if we need to send a heartbeat - this helps maintain the connection
                        current_time = time.time()
                        if current_time - last_activity_time > heartbeat_interval:
                            # Send heartbeat to keep connection alive
                            task_debug("Sending heartbeat to maintain connection")
                            yield f"data: {json.dumps({'heartbeat': True, 'timestamp': current_time})}\n\n"
                            last_activity_time = current_time
                            
                        if hasattr(chunk, 'text') and chunk.text:
                            chunk_count += 1
                            chunk_text = chunk.text.strip()
                            chars_in_chunk = len(chunk_text)
                            total_chars_sent += chars_in_chunk
                            last_activity_time = time.time()  # Update activity timestamp
                            
                            # Log chunk details for debugging
                            task_debug(f"Chunk #{chunk_count}: {chunk_text[:20]}... ({chars_in_chunk} chars)")
                            
                            if first_chunk:
                                # Extra delay for the first actual content chunk
                                time.sleep(0.5)  # Reduced from 1 to decrease delay
                                first_chunk = False
                                task_debug("Sending first content chunk")
                                
                            # Ensure each chunk ends properly for SSE
                            # Only send non-empty chunks to avoid confusing the client
                            if chunk_text:
                                yield f"data: {chunk_text}\n\n"
                                # Add a small delay between chunks for more reliable delivery
                                # This helps the frontend process each chunk correctly
                                time.sleep(0.01)  # Subtle delay to help frontend processing
                    
                    task_debug(f"Finished streaming {chunk_count} chunks, total {total_chars_sent} characters")
                    
                    # Stream the final chunk with a completion indicator
                    # Add a small delay before signaling completion
                    time.sleep(0.5)
                    yield f"data: {json.dumps({'done': True})}\n\n"
                    
                    # Save the complete task messages to the task history file
                    try:
                        # Get the final chat history
                        history = task_chat.get_history()
                        
                        # Format the messages for storage - convert 'model' role to 'assistant'
                        formatted_messages = []
                        previous_role = None
                        for msg in history:
                            # Map the Gemini API 'model' role to 'assistant' for frontend consistency
                            role = "assistant" if msg.role == "model" else msg.role
                            
                            # Extract text content from message parts
                            content = ""
                            if hasattr(msg, 'parts'):
                                for part in msg.parts:
                                    if hasattr(part, 'text') and part.text:
                                        content += part.text
                            
                            # Combine consecutive assistant messages
                            if role == "assistant" and previous_role == "assistant" and formatted_messages:
                                # Append this content to the previous assistant message
                                formatted_messages[-1]["content"] += content
                            else:
                                # Add as a new message
                                formatted_messages.append({
                                    "role": role,
                                    "content": content
                                })
                            
                            previous_role = role
                        
                        # Load task chat data
                        try:
                            with open(task_chats_file, "r", encoding="utf-8") as f:
                                task_data = json.load(f)
                        except (json.JSONDecodeError, FileNotFoundError):
                            # If file doesn't exist or is corrupt, create new structure
                            task_data = {"tasks": [], "messages": {}}
                        
                        # Save messages for this task
                        task_data.setdefault("messages", {})[task_id] = formatted_messages
                        
                        # Update task entry metadata
                        for task_entry in task_data.get("tasks", []):
                            if task_entry["id"] == task_id:
                                task_entry["message_count"] = len(formatted_messages)
                                task_entry["updated_at"] = datetime.now().isoformat()
                                break
                        
                        # Save updated task data
                        with open(task_chats_file, "w", encoding="utf-8") as f:
                            json.dump(task_data, f, indent=2, ensure_ascii=False)
                            
                        task_debug(f"Saved {len(formatted_messages)} messages for task: {task_id}")
                    except Exception as save_error:
                        task_error(f"Error saving task messages: {str(save_error)}", save_error)
                        
                except Exception as e:
                    task_exception(f"Error in task chat stream: {str(e)}", e)
                    yield f"data: {json.dumps({'error': str(e)})}\n\n"
            
            # Return the streaming response
            return Response(
                stream_with_context(generate()),
                content_type='text/event-stream'
            )
            
        except Exception as e:
            task_exception(f"Error in task chat: {str(e)}", e)
            return jsonify({"error": str(e)}), 500
    
    @app.route("/api/tasks", methods=["GET"])
    def get_tasks():
        """Get all tasks"""
        try:
            # Load task history
            try:
                with open(task_chats_file, "r", encoding="utf-8") as f:
                    task_data = json.load(f)
            except (json.JSONDecodeError, FileNotFoundError):
                task_data = {"tasks": []}
                
            # Return the list of tasks
            task_info(f"Retrieved {len(task_data.get('tasks', []))} tasks")
            return jsonify({
                "success": True,
                "tasks": task_data.get("tasks", [])
            })
        except Exception as e:
            task_exception(f"Error getting tasks: {str(e)}", e)
            return jsonify({"error": str(e)}), 500
    
    @app.route("/api/tasks/<task_id>", methods=["GET"])
    def get_task(task_id):
        """Get a specific task and its messages"""
        try:
            # Load task history
            try:
                with open(task_chats_file, "r", encoding="utf-8") as f:
                    task_data = json.load(f)
            except (json.JSONDecodeError, FileNotFoundError):
                task_data = {"tasks": [], "messages": {}}
                
            # Find task metadata
            task_metadata = None
            for task in task_data.get("tasks", []):
                if task["id"] == task_id:
                    task_metadata = task
                    break
                    
            if not task_metadata:
                task_warning(f"Task not found: {task_id}")
                return jsonify({"error": "Task not found"}), 404
                
            # Get task messages
            messages = task_data.get("messages", {}).get(task_id, [])
            task_info(f"Retrieved task {task_id} with {len(messages)} messages")
                
            # Return the task details
            return jsonify({
                "success": True,
                "task": task_metadata,
                "messages": messages
            })
        except Exception as e:
            task_exception(f"Error getting task: {str(e)}", e)
            return jsonify({"error": str(e)}), 500
    
    @app.route("/api/tasks/<task_id>", methods=["DELETE"])
    def delete_task(task_id):
        """Delete a specific task"""
        try:
            # Load task history
            try:
                with open(task_chats_file, "r", encoding="utf-8") as f:
                    task_data = json.load(f)
            except (json.JSONDecodeError, FileNotFoundError):
                return jsonify({"error": "Task history not found"}), 404
                
            # Remove task from tasks list
            original_count = len(task_data.get("tasks", []))
            task_data["tasks"] = [task for task in task_data.get("tasks", []) if task["id"] != task_id]
            new_count = len(task_data.get("tasks", []))
            
            # If task was found and removed
            if new_count < original_count:
                # Remove task messages
                if task_id in task_data.get("messages", {}):
                    del task_data["messages"][task_id]
                
                # Save updated task history
                with open(task_chats_file, "w", encoding="utf-8") as f:
                    json.dump(task_data, f, indent=2, ensure_ascii=False)
                
                # Also remove from active sessions if it exists there
                if task_id in active_task_chats:
                    del active_task_chats[task_id]
                    task_debug(f"Removed task {task_id} from active sessions")
                
                task_info(f"Deleted task: {task_id}")
                return jsonify({
                    "success": True, 
                    "message": f"Task {task_id} deleted from history",
                    "removed_from_active": task_id in active_task_chats
                })
            else:
                task_warning(f"Failed to delete task - not found: {task_id}")
                return jsonify({"error": "Task not found in history"}), 404
        except Exception as e:
            task_exception(f"Error deleting task: {str(e)}", e)
            return jsonify({"error": str(e)}), 500

# This function needs to be called from app.py to register these endpoints
