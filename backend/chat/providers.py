# status: complete

from typing import Dict, Any, Generator, List, Optional
from dotenv import load_dotenv
import os
import json
import requests
from google import genai
from google.genai import types
from utils.logger import get_logger
from utils.rate_limiter import get_rate_limiter
from utils.config import Config
from pathlib import Path
import time
from file_utils.upload_worker import start_upload_process
from utils.cancellation_manager import cancellation_manager

load_dotenv()

logger = get_logger(__name__)

class Gemini:
    """
    Gemini API from Google
    """
    
    AVAILABLE_MODELS = {
        "gemini-2.5-flash": {
            "name": "Gemini 2.5 Flash",
            "supports_reasoning": True
        },
        "gemini-2.5-pro": {
            "name": "Gemini 2.5 Pro",
            "supports_reasoning": True
        },
        "gemini-2.5-flash-lite": {
            "name": "Gemini 2.5 Flash Lite",
            "supports_reasoning": False
        }
    }
    
    FILE_SIZE_LIMIT = 2 * 1024 * 1024 * 1024  
    DIRECT_UPLOAD_EXTENSIONS = {'.pdf'}
    
    # All of the following timeout constants are in "seconds"
    FILE_PROCESSING_TIMEOUT = 180  
    FILE_ACTIVE_TIMEOUT = 120      
    UPLOAD_DEFAULT_TIMEOUT = 300   
    
    POLLING_BASE_SLEEP = 0.5      
    POLLING_MULTIPLIER = 1.6
    POLLING_MAX_SLEEP = 5.0      
    POLLING_INTERVAL = 0.1        

    PROCESS_TERMINATE_TIMEOUT = 2  
    PROCESS_JOIN_TIMEOUT = 1      
    
    def __init__(self):
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.status = "enabled" if self.api_key else "disabled"
        self.client = None
        
        if self.api_key:
            try:
                self.client = genai.Client(api_key=self.api_key)
                logger.info("Gemini client initialized successfully")
            except Exception as e:
                logger.error(f"Failed to initialize Gemini client: {str(e)}")
                self.status = "disabled"
    
    def is_available(self) -> bool:
        return self.status == "enabled" and self.client is not None
    
    def get_available_models(self) -> Dict[str, Any]:
        """Get available models for this provider"""
        return self.AVAILABLE_MODELS.copy()
    
    def supports_reasoning(self, model: str) -> bool:
        """Check if specific model supports reasoning"""
        return self.AVAILABLE_MODELS.get(model, {}).get("supports_reasoning", False)
    
    def _execute_with_rate_limit(self, operation_name: str, method, *args, **kwargs):
        """Common rate limiting wrapper for all API calls"""
        limiter = get_rate_limiter(
            Config.get_rate_limit_requests_per_minute(),
            Config.get_rate_limit_burst_size()
        )
        return limiter.execute(method, operation_name, *args, **kwargs)
    
    def _validate_historical_files(self, attached_files: List[Dict[str, Any]]) -> List[str]:
        """Validate historical files and return list of available API file names"""
        if not attached_files:
            return []
        
        available_files = []
        for file_info in attached_files:
            api_file_name = file_info.get('api_file_name')
            api_state = file_info.get('api_state')
            
            if not api_file_name or api_state != 'ready':
                continue
                
            try:
                file_data = self.client.files.get(name=api_file_name)
                if getattr(file_data, "state", "") == "ACTIVE":
                    available_files.append(api_file_name)
                else:
                    logger.info(f"Historical file {api_file_name} no longer ACTIVE, excluding from history")
            except Exception as e:
                logger.warning(f"Historical file {api_file_name} not accessible: {str(e)}")
        
        return available_files
    
    def _add_files_to_parts(self, file_attachments: List[str], user_parts: list, context: str = "request") -> list:
        """Add file attachments to user parts array"""
        if not file_attachments:
            return user_parts
            
        for api_file_name in file_attachments:
            try:
                file_info = self.client.files.get(name=api_file_name)
                user_parts.append({"file_data": {"file_uri": file_info.uri}})
                logger.info(f"Added file attachment {api_file_name} to {context}")
            except Exception as e:
                logger.error(f"Failed to add file attachment {api_file_name} to {context}: {str(e)}")
        
        return user_parts
    
    def _prepare_file_attachments(self, file_attachments: List[str], user_parts: list, is_streaming=False):
        """Common file attachment handling for both streaming and non-streaming requests"""
        if not file_attachments:
            return user_parts
            
        try:
            ok = self.wait_until_active(file_attachments, timeout_s=self.FILE_PROCESSING_TIMEOUT)
            if not ok:
                logger.info(f"Some files not ACTIVE after timeout; excluding them this turn")
                active = []
                for name in file_attachments:
                    try:
                        info = self.client.files.get(name=name)
                        if getattr(info, "state", "") == "ACTIVE":
                            active.append(name)
                    except Exception:
                        pass
                file_attachments = active
        except Exception as e:
            logger.warning(f"wait_until_active failed: {e}")

        context = "streaming request" if is_streaming else "request"
        return self._add_files_to_parts(file_attachments, user_parts, context)
    
    def _format_chat_history(self, chat_history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        """Convert database chat history to Gemini format, including historical file attachments.

        Important: Gemini merges adjacent messages that have the same role into a single turn.
        When a model response is deleted, it's possible to have back-to-back user messages in
        our DB/frontend. To preserve them as separate turns for Gemini, we inject a minimal
        model separator between consecutive user messages.
        """
        formatted_history = []
        prev_role = None

        for message in chat_history:
            role = message.get("role")
            content = message.get("content", "")
            attached_files = message.get("attachedFiles", [])

            if role == "user":
                if prev_role == "user":
                    formatted_history.append({"role": "model", "parts": [{"text": " "}]})

                user_parts = [{"text": content}]

                if attached_files:
                    available_files = self._validate_historical_files(attached_files)
                    if available_files:
                        user_parts = self._add_files_to_parts(available_files, user_parts, "historical message")
                        logger.info(f"Added {len(available_files)} historical files to message in chat history")

                formatted_history.append({"role": "user", "parts": user_parts})
                prev_role = "user"
            elif role == "assistant":
                formatted_history.append({"role": "model", "parts": [{"text": content}]})
                prev_role = "model"

        return formatted_history
    
    def count_tokens(self, contents: Any, model: str) -> int:
        """Count tokens using Gemini API specific method"""
        if not self.is_available():
            return 0
        
        try:
            result = self._execute_with_rate_limit(
                f"gemini:{model}",
                self.client.models.count_tokens,
                model=model, contents=contents
            )
            return result.total_tokens
        except Exception as e:
            logger.error(f"Token counting failed: {e}")
            return 0
    
    def wait_until_active(self, file_names, timeout_s=None, base_sleep=None):
        """Poll Files API until all are ACTIVE or timeout."""
        if not file_names:
            return True 
        
        if timeout_s is None:
            timeout_s = self.FILE_ACTIVE_TIMEOUT
        if base_sleep is None:
            base_sleep = self.POLLING_BASE_SLEEP
            
        deadline = time.time() + timeout_s
        remaining = set(file_names)
        sleep = base_sleep
        while remaining and time.time() < deadline:
            done = set()
            for name in list(remaining):
                try:
                    info = self.client.files.get(name=name)
                    if getattr(info, "state", "") == "ACTIVE":
                        done.add(name)
                except Exception:
                    pass
            remaining -= done
            if remaining:
                time.sleep(sleep)
                sleep = min(sleep * self.POLLING_MULTIPLIER, self.POLLING_MAX_SLEEP)
        return len(remaining) == 0
    
    def generate_text(self, prompt: str, model: str = "", 
                     include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                     file_attachments: List[str] = None,
                     **config_params) -> Dict[str, Any]:
        """Generate text response with chat history context"""
        if not self.is_available():
            return {"text": None, "thoughts": None, "error": "Provider not available"}
        
        config = types.GenerateContentConfig(**config_params)
        if include_thoughts:
            config.thinking_config = types.ThinkingConfig(include_thoughts=True)
        
        contents = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            contents.extend(formatted_history)

        user_parts = [{"text": prompt}]
        user_parts = self._prepare_file_attachments(file_attachments, user_parts, is_streaming=False)

        if contents and contents[-1].get("role") == "user":
            contents.append({"role": "model", "parts": [{"text": " "}]})

        contents.append({"role": "user", "parts": user_parts})
            
        response = self._execute_with_rate_limit(
            f"gemini:{model}",
            self.client.models.generate_content,
            model=model,
            contents=contents,
            config=config
        )
        
        thoughts = ""
        answer = ""
        
        if (response and response.candidates and len(response.candidates) > 0 
            and response.candidates[0].content and response.candidates[0].content.parts):
            for part in response.candidates[0].content.parts:
                if not part.text:
                    continue
                if part.thought:
                    thoughts += part.text
                else:
                    answer += part.text
        else:
            logger.warning("Received empty or invalid response from Gemini API")
        
        return {
            "text": answer,
            "thoughts": thoughts if thoughts else None,
            "model": model
        }
    
    def generate_text_stream(self, prompt: str, model: str = "", 
                           include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                           file_attachments: List[str] = None,
                           **config_params) -> Generator[Dict[str, Any], None, None]:
        """Generate streaming text response with chat history context"""
        if not self.is_available():
            yield {"type": "error", "content": "Provider not available"}
            return
            
        config = types.GenerateContentConfig(**config_params)
        if include_thoughts:
            config.thinking_config = types.ThinkingConfig(include_thoughts=True)
        
        contents = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            contents.extend(formatted_history)

        user_parts = [{"text": prompt}]
        user_parts = self._prepare_file_attachments(file_attachments, user_parts, is_streaming=True)

        if contents and contents[-1].get("role") == "user":
            contents.append({"role": "model", "parts": [{"text": " "}]})

        contents.append({"role": "user", "parts": user_parts})
        
        thoughts = ""
        answer = ""
        
        stream = self._execute_with_rate_limit(
            f"gemini:{model}",
            self.client.models.generate_content_stream,
            model=model,
            contents=contents,
            config=config
        )
        
        for chunk in stream:
            if (not chunk or not chunk.candidates or len(chunk.candidates) == 0 
                or not chunk.candidates[0].content or not chunk.candidates[0].content.parts):
                logger.warning(f"Received empty or invalid chunk from Gemini streaming API: {chunk}")
                continue
                
            for part in chunk.candidates[0].content.parts:
                if not part.text:
                    continue
                elif part.thought:
                    if not thoughts:
                        yield {"type": "thoughts_start"}
                    yield {"type": "thoughts", "content": part.text}
                    thoughts += part.text
                else:
                    if not answer:
                        yield {"type": "answer_start"}
                    yield {"type": "answer", "content": part.text}
                    answer += part.text
    
    def get_file_size_limit(self) -> int:
        """Get the maximum file size limit for this provider"""
        return self.FILE_SIZE_LIMIT
    
    def get_direct_upload_extensions(self) -> set:
        """Get file extensions that can be uploaded directly without MD conversion"""
        return self.DIRECT_UPLOAD_EXTENSIONS
    
    def upload_file(self, file_path: str, display_name: Optional[str] = None, timeout_seconds: Optional[int] = None, file_id: Optional[str] = None) -> Dict[str, Any]:
        """Upload a file to Gemini Files API using multiprocessing for true cancellation"""
        if not self.is_available():
            return {
                'success': False,
                'error': 'Provider not available',
                'state': 'error'
            }
        
        try:
            file_path_obj = Path(file_path)
            if not file_path_obj.exists():
                return {
                    'success': False,
                    'error': 'File does not exist',
                    'state': 'error'
                }
            
            logger.info(f"Starting multiprocess upload for Gemini: {file_path}")
            
            process, conn = start_upload_process(file_path, display_name, file_id)
            
            if file_id:
                cancellation_manager.register_process(file_id, process)
            
            try:
                if timeout_seconds is None:
                    timeout_seconds = self.UPLOAD_DEFAULT_TIMEOUT
                    
                start_time = time.time()
                result = None
                
                while process.is_alive() and (time.time() - start_time) < timeout_seconds:
                    if conn.poll(self.POLLING_INTERVAL):
                        try:
                            result = conn.recv()
                            logger.info(f"Upload process completed for file {file_id}: {result.get('success', False)}")
                            return result
                        except EOFError:
                            break
                    
                    if file_id and cancellation_manager.is_cancelled(file_id):
                        logger.info(f"Upload cancelled during execution for file {file_id}")
                        return {
                            'success': False,
                            'error': 'Upload cancelled',
                            'state': 'error'
                        }
                
                if process.is_alive():
                    logger.warning(f"Upload process still running after {timeout_seconds}s, terminating")
                    process.terminate()
                    process.join(timeout=self.PROCESS_TERMINATE_TIMEOUT)
                    if process.is_alive():
                        try:
                            process.kill()
                        except AttributeError:
                            pass
                    
                    return {
                        'success': False,
                        'error': f'Upload operation timed out after {timeout_seconds} seconds',
                        'state': 'error'
                    }
                
                try:
                    if conn.poll(self.POLLING_INTERVAL): 
                        result = conn.recv()
                        return result
                except (EOFError, OSError):
                    pass  
                
                return {
                    'success': False,
                    'error': 'Upload cancelled' if file_id and cancellation_manager.is_cancelled(file_id) else 'Upload process finished unexpectedly',
                    'state': 'error'
                }
                
            finally:
                if file_id:
                    cancellation_manager.unregister_task(file_id, 'process')
                try:
                    conn.close()
                except:
                    pass  
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=self.PROCESS_JOIN_TIMEOUT)
            
        except Exception as e:
            logger.error(f"Error in multiprocess upload to Gemini: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'state': 'error'
            }
    
    def get_file_metadata(self, api_file_name: str) -> Dict[str, Any]:
        """Get metadata for an uploaded file using Gemini Files API"""
        if not self.is_available():
            return {
                'success': False,
                'error': 'Provider not available',
                'state': 'error'
            }
        
        try:
            logger.debug(f"Getting file metadata from Gemini: {api_file_name}")
            
            file_info = self._execute_with_rate_limit(
                "gemini:get_file",
                self.client.files.get,
                name=api_file_name
            )
            
            gemini_state = getattr(file_info, 'state', 'UNKNOWN')
            
            if gemini_state == 'ACTIVE':
                internal_state = 'ready'
            elif gemini_state in ['PROCESSING', 'STATE_UNSPECIFIED', 'UNKNOWN']:
                internal_state = 'processing'
            elif gemini_state == 'FAILED':
                internal_state = 'error'
            else:
                internal_state = 'processing'
                logger.warning(f"Unknown Gemini state '{gemini_state}' for file {api_file_name}, defaulting to processing")
            
            logger.debug(f"File {api_file_name}: Gemini state '{gemini_state}' -> internal state '{internal_state}'")
            
            return {
                'success': True,
                'api_file_name': file_info.name,
                'state': internal_state,
                'gemini_state': gemini_state
            }
            
        except Exception as e:
            logger.error(f"Error getting file metadata from Gemini: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'state': 'error'
            }
    
    def list_files(self) -> Dict[str, Any]:
        """List all uploaded files in Gemini Files API"""
        if not self.is_available():
            return {
                'success': False,
                'error': 'Provider not available',
                'state': 'error',
                'files': []
            }
        
        try:
            logger.debug("Listing files from Gemini")
            
            files_response = self._execute_with_rate_limit(
                "gemini:list_files",
                self.client.files.list
            )
            
            files = []
            for file_info in files_response:
                files.append({
                    'api_file_name': file_info.name
                })
            
            return {
                'success': True,
                'files': files
            }
            
        except Exception as e:
            logger.error(f"Error listing files from Gemini: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'state': 'error',
                'files': []
            }
    
    def get_file_attachments_for_request(self, chat_id: str) -> List[str]:
        """Get list of API file names that are ready to be included in requests for this chat"""
        from utils.db_utils import db
        
        try:
            file_records = db.get_chat_file_attachments_for_provider(chat_id, 'gemini')
            
            api_file_names = []
            for file_record in file_records:
                api_file_names.append(file_record['api_file_name'])
                
                try:
                    info = self.client.files.get(name=file_record['api_file_name'])
                    if getattr(info, 'state', '') == 'ACTIVE' and file_record['api_state'] != 'ready':
                        db.update_file_api_info(file_record['id'], api_state='ready')
                except Exception:
                    pass
            
            logger.info(f"Found {len(api_file_names)} file attachments to try for chat {chat_id}")
            return api_file_names
            
        except Exception as e:
            logger.error(f"Error getting file attachments for chat {chat_id}: {str(e)}")
            return []
    
    def delete_file(self, api_file_name: str) -> Dict[str, Any]:
        """Delete a file from Gemini Files API"""
        if not self.is_available():
            return {
                'success': False,
                'error': 'Provider not available',
                'state': 'error'
            }
        
        try:
            logger.info(f"Deleting file from Gemini: {api_file_name}")
            
            self._execute_with_rate_limit(
                "gemini:delete_file",
                self.client.files.delete,
                name=api_file_name
            )
            
            logger.info(f"File deleted successfully from Gemini: {api_file_name}")
            
            return {
                'success': True,
                'message': f'File {api_file_name} deleted successfully',
                'state': 'success'
            }
            
        except Exception as e:
            logger.error(f"Error deleting file from Gemini: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'state': 'error'
            }

class DisabledProvider:
    """Base class for disabled/placeholder providers"""
    
    def __init__(self, name: str = "DisabledProvider"):
        self.name = name
        self.status = "disabled"
    
    def is_available(self) -> bool:
        return False
    
    def get_available_models(self) -> dict:
        return {}

class HuggingFace(DisabledProvider):
    """HuggingFace API (currently disabled)"""
    
    def __init__(self):
        super().__init__("HuggingFace")

class Groq:
    """
    Groq API
    """

    AVAILABLE_MODELS = {
        "groq/compound": {
            "name": "Groq Compound",
            "supports_reasoning": False 
        },
        "meta-llama/llama-4-maverick-17b-128e-instruct": {
            "name": "Llama 4 Maverick 17B",
            "supports_reasoning": False
        },
        "meta-llama/llama-4-scout-17b-16e-instruct": {
            "name": "Llama 4 Scout 17B",
            "supports_reasoning": False
        },
        "moonshotai/kimi-k2-instruct-0905": {
            "name": "Kimi K2 Instruct",
            "supports_reasoning": False
        },
        "openai/gpt-oss-120b": {
            "name": "GPT-OSS 120B",
            "supports_reasoning": True 
        }
    }

    BASE_URL = "https://api.groq.com/openai/v1/chat/completions"

    def __init__(self):
        self.api_key = os.getenv("GROQ_API_KEY")
        self.status = "enabled" if self.api_key else "disabled"
        self.client = None

        if self.api_key:
            try:
                from groq import Groq as GroqClient
                self.client = GroqClient(api_key=self.api_key)
                logger.info("Groq text generation client initialized successfully")
            except ImportError:
                logger.error("groq package not installed. Please run: pip install groq")
                self.status = "disabled"
            except Exception as e:
                logger.error(f"Failed to initialize Groq client: {str(e)}")
                self.status = "disabled"

    def is_available(self) -> bool:
        return self.status == "enabled" and self.client is not None

    def get_available_models(self) -> Dict[str, Any]:
        """Get available models for this provider"""
        return self.AVAILABLE_MODELS.copy()

    def supports_reasoning(self, model: str) -> bool:
        """Check if specific model supports reasoning"""
        return self.AVAILABLE_MODELS.get(model, {}).get("supports_reasoning", False)

    def _execute_with_rate_limit(self, operation_name: str, method, *args, **kwargs):
        """Common rate limiting wrapper for all API calls"""
        limiter = get_rate_limiter(
            Config.get_rate_limit_requests_per_minute(),
            Config.get_rate_limit_burst_size()
        )
        return limiter.execute(method, operation_name, *args, **kwargs)

    def _format_chat_history(self, chat_history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        """Convert database chat history to Groq/OpenAI format"""
        formatted_history = []

        for message in chat_history:
            role = message.get("role")
            content = message.get("content", "")

            if role == "user":
                formatted_history.append({"role": "user", "content": content})
            elif role == "assistant":
                formatted_history.append({"role": "assistant", "content": content})

        return formatted_history

    def generate_text(self, prompt: str, model: str = "",
                     include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                     file_attachments: List[str] = None,
                     **config_params) -> Dict[str, Any]:
        """Generate text response with chat history context"""
        if not self.is_available():
            return {"text": None, "thoughts": None, "error": "Provider not available"}

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        request_params = {
            "model": model,
            "messages": messages
        }

        if config_params:
            for key, value in config_params.items():
                if key in ["temperature", "max_completion_tokens", "max_tokens", "top_p", "stop", "stream"]:
                    if key == "max_tokens":
                        request_params["max_completion_tokens"] = value
                    else:
                        request_params[key] = value

        if include_thoughts and self.supports_reasoning(model):
            request_params["include_reasoning"] = True

        try:
            response = self._execute_with_rate_limit(
                f"groq:{model}",
                self.client.chat.completions.create,
                **request_params
            )

            thoughts = None
            content = ""

            if response and response.choices and len(response.choices) > 0:
                message = response.choices[0].message
                content = message.content or ""

                if hasattr(message, 'reasoning') and message.reasoning:
                    thoughts = message.reasoning
                elif model == "groq/compound" and hasattr(message, 'executed_tools'):
                    thoughts = str(message.executed_tools) if message.executed_tools else None

            return {
                "text": content,
                "thoughts": thoughts,
                "model": model
            }

        except Exception as e:
            logger.error(f"Groq API request failed: {str(e)}")
            return {
                "text": None,
                "thoughts": None,
                "error": str(e)
            }

    def generate_text_stream(self, prompt: str, model: str = "",
                           include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                           file_attachments: List[str] = None,
                           **config_params) -> Generator[Dict[str, Any], None, None]:
        """Generate streaming text response with chat history context"""
        if not self.is_available():
            yield {"type": "error", "content": "Provider not available"}
            return

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        request_params = {
            "model": model,
            "messages": messages,
            "stream": True
        }

        if config_params:
            for key, value in config_params.items():
                if key in ["temperature", "max_completion_tokens", "max_tokens", "top_p", "stop"]:
                    if key == "max_tokens":
                        request_params["max_completion_tokens"] = value
                    else:
                        request_params[key] = value

        if include_thoughts and self.supports_reasoning(model):
            request_params["include_reasoning"] = True

        try:
            stream = self._execute_with_rate_limit(
                f"groq:{model}",
                self.client.chat.completions.create,
                **request_params
            )

            answer_started = False
            thoughts_started = False

            for chunk in stream:
                if chunk.choices and len(chunk.choices) > 0:
                    delta = chunk.choices[0].delta

                    if hasattr(delta, 'reasoning') and delta.reasoning:
                        if not thoughts_started:
                            yield {"type": "thoughts_start"}
                            thoughts_started = True
                        yield {"type": "thoughts", "content": delta.reasoning}

                    if delta.content:
                        if not answer_started:
                            yield {"type": "answer_start"}
                            answer_started = True
                        yield {"type": "answer", "content": delta.content}

            yield {"type": "complete"}

        except Exception as e:
            logger.error(f"Groq streaming API request failed: {str(e)}")
            yield {"type": "error", "content": str(e)}

class OpenRouter:
    """
    OpenRouter API
    """

    AVAILABLE_MODELS = {
        "x-ai/grok-4-fast:free": {
            "name": "Grok 4 Fast (Free)",
            "supports_reasoning": True
        },
        "deepseek/deepseek-chat-v3.1:free": {
            "name": "DeepSeek Chat v3.1 (Free)",
            "supports_reasoning": True
        },
        "z-ai/glm-4.5-air:free": {
            "name": "GLM 4.5 Air (Free)",
            "supports_reasoning": False
        },
        "qwen/qwen3-coder:free": {
            "name": "Qwen3 Coder (Free)",
            "supports_reasoning": True
        },
        "moonshotai/kimi-k2:free": {
            "name": "Kimi K2 (Free)",
            "supports_reasoning": False
        }
    }

    BASE_URL = "https://openrouter.ai/api/v1/chat/completions"

    def __init__(self):
        self.api_key = os.getenv("OPENROUTER_API_KEY")
        self.status = "enabled" if self.api_key else "disabled"

        if self.api_key:
            logger.info("OpenRouter client initialized successfully")
        else:
            logger.warning("OpenRouter API key not found, provider disabled")

    def is_available(self) -> bool:
        return self.status == "enabled" and self.api_key is not None

    def get_available_models(self) -> Dict[str, Any]:
        """Get available models for this provider"""
        return self.AVAILABLE_MODELS.copy()

    def supports_reasoning(self, model: str) -> bool:
        """Check if specific model supports reasoning"""
        return self.AVAILABLE_MODELS.get(model, {}).get("supports_reasoning", False)

    def _execute_with_rate_limit(self, operation_name: str, method, *args, **kwargs):
        """Common rate limiting wrapper for all API calls"""
        limiter = get_rate_limiter(
            Config.get_rate_limit_requests_per_minute(),
            Config.get_rate_limit_burst_size()
        )
        return limiter.execute(method, operation_name, *args, **kwargs)

    def _format_chat_history(self, chat_history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        """Convert database chat history to OpenRouter/OpenAI format"""
        formatted_history = []

        for message in chat_history:
            role = message.get("role")
            content = message.get("content", "")

            if role == "user":
                formatted_history.append({"role": "user", "content": content})
            elif role == "assistant":
                formatted_history.append({"role": "assistant", "content": content})

        return formatted_history

    def generate_text(self, prompt: str, model: str = "",
                     include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                     file_attachments: List[str] = None,
                     **config_params) -> Dict[str, Any]:
        """Generate text response with chat history context"""
        if not self.is_available():
            return {"text": None, "thoughts": None, "error": "Provider not available"}

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:5000",
            "X-Title": "ATLAS2"
        }

        data = {
            "model": model,
            "messages": messages
        }

        if config_params:
            for key, value in config_params.items():
                if key in ["temperature", "max_tokens", "top_p", "frequency_penalty", "presence_penalty"]:
                    data[key] = value

        if include_thoughts and self.supports_reasoning(model):
            data["reasoning"] = {
                "effort": "medium",
                "exclude": False,
                "enabled": True
            }

        try:
            response = self._execute_with_rate_limit(
                f"openrouter:{model}",
                requests.post,
                self.BASE_URL,
                headers=headers,
                json=data,
                timeout=30
            )

            response.raise_for_status()
            result = response.json()

            if "choices" in result and len(result["choices"]) > 0:
                message = result["choices"][0]["message"]
                content = message.get("content", "")
                reasoning = message.get("reasoning", "")

                return {
                    "text": content,
                    "thoughts": reasoning if reasoning else None,
                    "model": model
                }
            else:
                logger.warning(f"Unexpected response format from OpenRouter: {result}")
                return {
                    "text": None,
                    "thoughts": None,
                    "error": "Invalid response format"
                }

        except requests.exceptions.RequestException as e:
            logger.error(f"OpenRouter API request failed: {str(e)}")
            return {
                "text": None,
                "thoughts": None,
                "error": str(e)
            }
        except Exception as e:
            logger.error(f"Unexpected error in OpenRouter generate_text: {str(e)}")
            return {
                "text": None,
                "thoughts": None,
                "error": str(e)
            }

    def generate_text_stream(self, prompt: str, model: str = "",
                           include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                           file_attachments: List[str] = None,
                           **config_params) -> Generator[Dict[str, Any], None, None]:
        """Generate streaming text response with chat history context"""
        if not self.is_available():
            yield {"type": "error", "content": "Provider not available"}
            return

        messages = []
        if chat_history:
            formatted_history = self._format_chat_history(chat_history)
            messages.extend(formatted_history)

        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:5000",
            "X-Title": "ATLAS2"
        }

        data = {
            "model": model,
            "messages": messages,
            "stream": True
        }

        if config_params:
            for key, value in config_params.items():
                if key in ["temperature", "max_tokens", "top_p", "frequency_penalty", "presence_penalty"]:
                    data[key] = value

        if include_thoughts and self.supports_reasoning(model):
            data["reasoning"] = {
                "effort": "medium",
                "exclude": False,
                "enabled": True
            }

        try:
            response = self._execute_with_rate_limit(
                f"openrouter:{model}",
                requests.post,
                self.BASE_URL,
                headers=headers,
                json=data,
                stream=True,
                timeout=30
            )

            response.raise_for_status()

            answer_started = False
            thoughts_started = False

            for line in response.iter_lines():
                if line:
                    line_str = line.decode('utf-8')
                    if line_str.startswith('data: '):
                        line_str = line_str[6:]
                        if line_str == '[DONE]':
                            break

                        try:
                            chunk = json.loads(line_str)
                            if "choices" in chunk and len(chunk["choices"]) > 0:
                                delta = chunk["choices"][0].get("delta", {})
                                content = delta.get("content", "")
                                reasoning = delta.get("reasoning", "")

                                if reasoning:
                                    if not thoughts_started:
                                        yield {"type": "thoughts_start"}
                                        thoughts_started = True
                                    yield {"type": "thoughts", "content": reasoning}

                                if content:
                                    if not answer_started:
                                        yield {"type": "answer_start"}
                                        answer_started = True
                                    yield {"type": "answer", "content": content}
                        except json.JSONDecodeError:
                            logger.warning(f"Failed to parse chunk: {line_str}")
                            continue

            yield {"type": "complete"}

        except requests.exceptions.RequestException as e:
            logger.error(f"OpenRouter streaming API request failed: {str(e)}")
            yield {"type": "error", "content": str(e)}
        except Exception as e:
            logger.error(f"Unexpected error in OpenRouter generate_text_stream: {str(e)}")
            yield {"type": "error", "content": str(e)}
