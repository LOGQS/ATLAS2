# status: complete

from typing import Any, Callable, Dict, Generator, List, Optional
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
        "gemini-2.5-flash-preview-09-2025": {
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
    
    @staticmethod
    def _usage_from_response(response: Any) -> Optional[int]:
        usage_metadata = getattr(response, "usage_metadata", None)
        if usage_metadata is None:
            return None
        total_tokens = getattr(usage_metadata, "total_token_count", None)
        if total_tokens is None:
            return None
        return int(total_tokens)

    def _execute_with_rate_limit(
        self,
        operation_name: str,
        method,
        *args,
        estimated_tokens: Optional[int] = None,
        usage_getter: Optional[Callable[[Any], Optional[int]]] = None,
        **kwargs,
    ):
        """Common rate limiting wrapper for all API calls"""
        model_name = kwargs.get("model")
        rate_config = Config.get_rate_limit_config(provider="gemini", model=model_name)
        limiter = get_rate_limiter()
        return limiter.execute(
            method,
            operation_name,
            *args,
            limit_config=rate_config,
            usage_getter=usage_getter or self._usage_from_response,
            estimated_tokens=estimated_tokens,
            **kwargs,
        )
    
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
        """
        Count tokens using Gemini API specific method.

        NOTE: countTokens is a lightweight metadata API that doesn't consume quota
        like generation calls, so we don't rate limit it.
        """
        if not self.is_available():
            return 0

        try:
            # Call directly without rate limiting - countTokens doesn't consume quota
            result = self.client.models.count_tokens(model=model, contents=contents)
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

        estimated_tokens = config_params.pop("rate_limit_estimated_tokens", None)
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
            
        try:
            response = self._execute_with_rate_limit(
                f"gemini:{model}",
                self.client.models.generate_content,
                model=model,
                contents=contents,
                config=config,
                estimated_tokens=estimated_tokens
            )
        except Exception as e:
            error_message = self._extract_error_message(e)
            logger.error(f"Gemini generate_text request failed: {error_message}")
            return {
                "text": None,
                "thoughts": None,
                "model": model,
                "error": error_message
            }
        
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
        
        if not answer.strip() and not thoughts.strip():
            error_message = "Gemini returned an empty response. Please retry your request."
            logger.error("Gemini generate_text completed with no content")
            return {
                "text": None,
                "thoughts": None,
                "model": model,
                "error": error_message
            }

        # Extract usage metadata if available
        usage_metadata = None
        if hasattr(response, 'usage_metadata') and response.usage_metadata:
            usage_metadata = {
                'prompt_token_count': response.usage_metadata.prompt_token_count,
                'candidates_token_count': response.usage_metadata.candidates_token_count,
                'total_token_count': response.usage_metadata.total_token_count
            }

        return {
            "text": answer,
            "thoughts": thoughts if thoughts else None,
            "model": model,
            "usage_metadata": usage_metadata
        }
    
    def generate_text_stream(self, prompt: str, model: str = "",
                           include_thoughts: bool = False, chat_history: List[Dict[str, Any]] = None,
                           file_attachments: List[str] = None,
                           **config_params) -> Generator[Dict[str, Any], None, None]:
        """Generate streaming text response with chat history context"""
        if not self.is_available():
            yield {"type": "error", "content": "Provider not available"}
            return

        estimated_tokens = config_params.pop("rate_limit_estimated_tokens", None)
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

        try:
            stream = self._execute_with_rate_limit(
                f"gemini:{model}",
                self.client.models.generate_content_stream,
                model=model,
                contents=contents,
                config=config,
                estimated_tokens=estimated_tokens,
                usage_getter=None,
            )
        except Exception as e:
            error_message = self._extract_error_message(e)
            logger.error(f"Failed to start Gemini streaming request: {error_message}")
            raise RuntimeError(error_message) from e

        if not stream:
            error_message = "Gemini did not return any streaming data. Please try again."
            logger.error(error_message)
            raise RuntimeError(error_message)

        has_content = False
        saw_invalid_chunk = False
        last_chunk = None

        try:
            for chunk in stream:
                last_chunk = chunk
                if (not chunk or not chunk.candidates or len(chunk.candidates) == 0
                    or not chunk.candidates[0].content or not chunk.candidates[0].content.parts):
                    saw_invalid_chunk = True
                    logger.warning(f"Received empty or invalid chunk from Gemini streaming API: {chunk}")
                    continue

                for part in chunk.candidates[0].content.parts:
                    if not part.text:
                        continue
                    has_content = True
                    if part.thought:
                        if not thoughts:
                            yield {"type": "thoughts_start"}
                        yield {"type": "thoughts", "content": part.text}
                        thoughts += part.text
                    else:
                        if not answer:
                            yield {"type": "answer_start"}
                        yield {"type": "answer", "content": part.text}
                        answer += part.text
        except Exception as e:
            error_message = self._extract_error_message(e)
            logger.error(f"Gemini streaming request failed: {error_message}")
            raise RuntimeError(error_message) from e

        # Extract usage metadata from last chunk if available
        if last_chunk and hasattr(last_chunk, 'usage_metadata') and last_chunk.usage_metadata:
            usage_metadata = {
                'prompt_token_count': last_chunk.usage_metadata.prompt_token_count,
                'candidates_token_count': last_chunk.usage_metadata.candidates_token_count,
                'total_token_count': last_chunk.usage_metadata.total_token_count
            }
            yield {"type": "usage", "usage_metadata": usage_metadata}

        if not has_content:
            if saw_invalid_chunk:
                logger.error("Gemini streaming returned only empty or invalid chunks")
            else:
                logger.error("Gemini streaming completed without delivering any content")
            raise RuntimeError("Gemini returned an empty response. Please retry your request.")
    
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

    def _extract_error_message(self, error: Exception, default: str = "Gemini request failed. Please try again.") -> str:
        """Extract a user-friendly error message from Gemini exceptions"""
        for arg in getattr(error, "args", []):
            if isinstance(arg, dict):
                err_info = arg.get("error")
                if isinstance(err_info, dict):
                    message = err_info.get("message")
                    if message:
                        return message
            elif isinstance(arg, str) and arg:
                if "The model is overloaded" in arg:
                    return "Gemini is temporarily overloaded. Please try again shortly."
                if "UNAVAILABLE" in arg.upper() or " 503" in arg:
                    return "Gemini is temporarily unavailable. Please try again shortly."

        response = getattr(error, "response", None)
        if response is not None:
            try:
                data = response.json()
                if isinstance(data, dict):
                    err_info = data.get("error")
                    if isinstance(err_info, dict):
                        message = err_info.get("message")
                        if message:
                            return message
            except Exception:
                pass

        message = str(error).strip()
        if message:
            if "The model is overloaded" in message:
                return "Gemini is temporarily overloaded. Please try again shortly."
            if "UNAVAILABLE" in message.upper() or " 503" in message:
                return "Gemini is temporarily unavailable. Please try again shortly."
            return message

        return default

