# status: complete

from typing import Dict, Any, Generator, List, Optional
from dotenv import load_dotenv
import os
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
        }
    }
    
    FILE_SIZE_LIMIT = 2 * 1024 * 1024 * 1024  
    DIRECT_UPLOAD_EXTENSIONS = {'.pdf'}  
    
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
    
    def _format_chat_history(self, chat_history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        """Convert database chat history to Gemini format"""
        formatted_history = []
        
        for message in chat_history:
            role = message.get("role")
            content = message.get("content", "")
            
            if role == "user":
                formatted_history.append({"role": "user", "parts": [{"text": content}]})
            elif role == "assistant":
                formatted_history.append({"role": "model", "parts": [{"text": content}]})
                
        return formatted_history
    
    def count_tokens(self, contents: Any, model: str) -> int:
        """Count tokens using Gemini API specific method"""
        if not self.is_available():
            return 0
        
        try:
            limiter = get_rate_limiter(
                Config.get_rate_limit_requests_per_minute(),
                Config.get_rate_limit_burst_size()
            )
            result = limiter.execute(
                self.client.models.count_tokens,
                f"gemini:{model}",
                model=model, contents=contents
            )
            return result.total_tokens
        except Exception as e:
            logger.error(f"Token counting failed: {e}")
            return 0
    
    def wait_until_active(self, file_names, timeout_s=120, base_sleep=0.5):
        """Poll Files API until all are ACTIVE or timeout."""
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
                sleep = min(sleep * 1.6, 5.0)
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
        
        if file_attachments:
            try:
                ok = self.wait_until_active(file_attachments, timeout_s=180)
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

            for api_file_name in file_attachments:
                try:
                    file_info = self.client.files.get(name=api_file_name)
                    user_parts.append({"file_data": {"file_uri": file_info.uri}})
                    logger.info(f"Added file attachment {api_file_name} to request")
                except Exception as e:
                    logger.error(f"Failed to add file attachment {api_file_name}: {str(e)}")
        
        contents.append({"role": "user", "parts": user_parts})
            
        limiter = get_rate_limiter(
            Config.get_rate_limit_requests_per_minute(),
            Config.get_rate_limit_burst_size()
        )
        response = limiter.execute(
            self.client.models.generate_content,
            f"gemini:{model}",
            model=model,
            contents=contents,
            config=config
        )
        
        thoughts = ""
        answer = ""
        
        for part in response.candidates[0].content.parts:
            if not part.text:
                continue
            if part.thought:
                thoughts += part.text
            else:
                answer += part.text
        
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
        
        if file_attachments:
            try:
                ok = self.wait_until_active(file_attachments, timeout_s=180)
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

            for api_file_name in file_attachments:
                try:
                    file_info = self.client.files.get(name=api_file_name)
                    user_parts.append({"file_data": {"file_uri": file_info.uri}})
                    logger.info(f"Added file attachment {api_file_name} to streaming request")
                except Exception as e:
                    logger.error(f"Failed to add file attachment {api_file_name} to streaming request: {str(e)}")
        
        contents.append({"role": "user", "parts": user_parts})
        
        thoughts = ""
        answer = ""
        
        limiter = get_rate_limiter(
            Config.get_rate_limit_requests_per_minute(),
            Config.get_rate_limit_burst_size()
        )
        stream = limiter.execute(
            self.client.models.generate_content_stream,
            f"gemini:{model}",
            model=model,
            contents=contents,
            config=config
        )
        
        for chunk in stream:
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
    
    def upload_file(self, file_path: str, display_name: Optional[str] = None, timeout_seconds: int = 300, file_id: Optional[str] = None) -> Dict[str, Any]:
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
                start_time = time.time()
                result = None
                
                while process.is_alive() and (time.time() - start_time) < timeout_seconds:
                    if conn.poll(0.1):
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
                    process.join(timeout=2)
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
                    if conn.poll(0.1): 
                        result = conn.recv()
                        return result
                except (EOFError, OSError):
                    pass  
                
                if file_id and cancellation_manager.is_cancelled(file_id):
                    return {
                        'success': False,
                        'error': 'Upload cancelled',
                        'state': 'error'
                    }
                else:
                    return {
                        'success': False,
                        'error': 'Upload process finished unexpectedly',
                        'state': 'error'
                    }
                
            finally:
                if file_id:
                    cancellation_manager.unregister_process(file_id)
                conn.close()
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=1)
            
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
            
            limiter = get_rate_limiter(
                Config.get_rate_limit_requests_per_minute(),
                Config.get_rate_limit_burst_size()
            )
            
            file_info = limiter.execute(
                self.client.files.get,
                "gemini:get_file",
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
                'files': []
            }
        
        try:
            logger.debug("Listing files from Gemini")
            
            limiter = get_rate_limiter(
                Config.get_rate_limit_requests_per_minute(),
                Config.get_rate_limit_burst_size()
            )
            
            files_response = limiter.execute(
                self.client.files.list,
                "gemini:list_files"
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
                'files': []
            }
    
    def get_file_attachments_for_request(self, chat_id: str) -> List[str]:
        """Get list of API file names that are ready to be included in requests for this chat"""
        from utils.db_utils import db
        
        try:
            files = db.get_all_files(chat_id=chat_id)
            api_file_names = []
            
            for file in files:
                if (file.get('provider') == 'gemini' and file.get('api_file_name')
                    and file.get('api_state') in ['uploaded','processing','ready']):
                    api_file_names.append(file['api_file_name'])

                    try:
                        info = self.client.files.get(name=file['api_file_name'])
                        if getattr(info, 'state', '') == 'ACTIVE' and file.get('api_state') != 'ready':
                            db.update_file_api_info(file['id'], api_state='ready')
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
                'error': 'Provider not available'
            }
        
        try:
            logger.info(f"Deleting file from Gemini: {api_file_name}")
            
            limiter = get_rate_limiter(
                Config.get_rate_limit_requests_per_minute(),
                Config.get_rate_limit_burst_size()
            )
            
            limiter.execute(
                self.client.files.delete,
                "gemini:delete_file",
                name=api_file_name
            )
            
            logger.info(f"File deleted successfully from Gemini: {api_file_name}")
            
            return {
                'success': True,
                'message': f'File {api_file_name} deleted successfully'
            }
            
        except Exception as e:
            logger.error(f"Error deleting file from Gemini: {str(e)}")
            return {
                'success': False,
                'error': str(e)
            }

class HuggingFace:
    """
    HuggingFace API
    """
    
    def __init__(self):
        self.status = "disabled"
    
    def is_available(self) -> bool:
        return False
    
    def get_available_models(self) -> dict:
        return {}

class OpenRouter:
    """
    OpenRouter API
    """
    
    def __init__(self):
        self.status = "disabled"
    
    def is_available(self) -> bool:
        return False
    
    def get_available_models(self) -> dict:
        return {}