# status: complete

"""
Chat worker that runs in a separate process.
This allows for true process termination that immediately stops chat operations.
"""

import multiprocessing
import sys
import time
import json
from pathlib import Path
from typing import Optional


def start_chat_process(chat_id: str) -> tuple:
    """Start a chat worker process and return process and connection objects"""
    
    parent_conn, child_conn = multiprocessing.Pipe()
    
    process = multiprocessing.Process(
        target=chat_worker,
        args=(chat_id, child_conn),
        daemon=False
    )
    process.start()
    
    return process, parent_conn


def chat_worker(chat_id: str, child_conn) -> None:
    """
    Chat worker function that runs in a separate process.
    When the process is terminated, all operations stop immediately.
    """
    
    try:
        backend_dir = Path(__file__).parent.parent
        if str(backend_dir) not in sys.path:
            sys.path.insert(0, str(backend_dir))
        
        from utils.logger import get_logger
        from utils.db_utils import DatabaseManager
        from utils.config import get_provider_map, Config
        
        worker_logger = get_logger(__name__)
        worker_logger.info(f"[CHAT-WORKER] Starting chat worker process for {chat_id}")
        
        db = None
        providers = None
        processing_active = False
        
        try:
            db = DatabaseManager()
            
            providers = get_provider_map()
            
            worker_logger.info(f"[CHAT-WORKER] Initialized worker for {chat_id}")
            
            child_conn.send({'success': True, 'chat_id': chat_id})
            
        except Exception as e:
            error_msg = f'Chat worker initialization failed: {str(e)}'
            worker_logger.error(f"[CHAT-WORKER] {error_msg}")
            child_conn.send({'success': False, 'error': error_msg, 'chat_id': chat_id})
            return
        
        worker_logger.info(f"[CHAT-WORKER] Starting command processing loop for {chat_id}")
        
        while True:
            try:
                if child_conn.poll(0.1):
                    try:
                        command = child_conn.recv()
                        command_type = command.get('command')
                        
                        worker_logger.info(f"[CHAT-WORKER] Received command {command_type} for {chat_id}")
                        
                        if command_type == 'stop':
                            child_conn.send({'success': True, 'chat_id': chat_id})
                            break
                        
                        elif command_type == 'cancel':
                            if processing_active:
                                processing_active = False
                                
                                db.update_chat_state(chat_id, "static")
                                child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'static'})
                                
                                child_conn.send({'success': True, 'cancelled': True, 'chat_id': chat_id})
                                worker_logger.info(f"[CHAT-WORKER] Cancelled processing for {chat_id}")
                            else:
                                child_conn.send({'success': True, 'cancelled': False, 'chat_id': chat_id})
                        
                        elif command_type == 'process':
                            if processing_active:
                                child_conn.send({'success': False, 'error': 'Processing already active', 'chat_id': chat_id})
                                continue
                            
                            try:
                                processing_active = True
                                
                                message = command.get('message')
                                provider = command.get('provider', Config.get_default_provider())
                                model = command.get('model', Config.get_default_model())
                                include_reasoning = command.get('include_reasoning', True)
                                attached_file_ids = command.get('attached_file_ids', [])
                                user_message_id = command.get('user_message_id')
                                
                                _process_message_in_worker(
                                    chat_id, db, providers, message, provider, model, 
                                    include_reasoning, attached_file_ids, user_message_id, 
                                    child_conn, worker_logger
                                )
                                
                                processing_active = False
                                
                            except Exception as proc_error:
                                processing_active = False
                                error_msg = f'Processing failed: {str(proc_error)}'
                                worker_logger.error(f"[CHAT-WORKER] {error_msg}")
                                
                                try:
                                    db.update_chat_state(chat_id, "static")
                                    child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'static'})
                                    child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'error', 'content': str(proc_error)})
                                except Exception as cleanup_error:
                                    worker_logger.warning(f"[CHAT-WORKER] Failed to cleanup after error: {cleanup_error}")
                                
                                child_conn.send({'success': False, 'error': error_msg, 'chat_id': chat_id})
                            
                    except Exception as cmd_error:
                        worker_logger.error(f"[CHAT-WORKER] Command processing error for {chat_id}: {str(cmd_error)}")
                        child_conn.send({'success': False, 'error': f'Command processing failed: {str(cmd_error)}', 'chat_id': chat_id})
                
            except Exception as loop_error:
                worker_logger.error(f"[CHAT-WORKER] Main loop error for {chat_id}: {str(loop_error)}")
                time.sleep(0.1)  
    
    except Exception as worker_error:
        try:
            child_conn.send({'success': False, 'error': f'Worker crashed: {str(worker_error)}', 'chat_id': chat_id})
        except:
            pass  
    finally:
        try:
            child_conn.close()
        except:
            pass


def _process_message_in_worker(chat_id: str, db, providers, message: str, provider: str, model: str,
                              include_reasoning: bool, attached_file_ids: list, user_message_id: Optional[int],
                              child_conn, worker_logger):
    """Process a message within the worker process"""
    
    worker_logger.info(f"[CHAT-WORKER] Processing message with {provider}:{model} for {chat_id}")
    
    if provider not in providers or not providers[provider].is_available():
        available = {name: prov.is_available() for name, prov in providers.items()}
        raise ValueError(f"Provider '{provider}' not available. Available: {available}")
    
    use_reasoning = include_reasoning
    if use_reasoning and hasattr(providers[provider], 'supports_reasoning'):
        use_reasoning = providers[provider].supports_reasoning(model)
    
    chat_history = db.get_chat_history(chat_id)
    if chat_history and chat_history[-1]["role"] == "user":
        chat_history = chat_history[:-1]
    
    file_attachments = []
    if attached_file_ids:
        file_attachments = _resolve_api_file_names(attached_file_ids, provider, db, worker_logger)
    
    assistant_message_id = db.save_message(
        chat_id,
        "assistant", 
        "",
        thoughts=None,
        provider=provider,
        model=model
    )
    try:
        if assistant_message_id and chat_id.startswith('version_'):
            all_chats = db.get_all_chats()
            me = next((c for c in all_chats if c.get('id') == chat_id), None)
            parent_id = me.get('belongsto') if me else None
            if parent_id:
                hist = db.get_chat_history(chat_id)
                last_user_pos = None
                for idx in range(len(hist)-1, -1, -1):
                    if hist[idx].get('role') == 'user':
                        last_user_pos = idx + 1
                        break
                if last_user_pos:
                    parent_hist = db.get_chat_history(parent_id)
                    parent_assistant_id = None
                    for j in range(last_user_pos, len(parent_hist)):
                        if parent_hist[j].get('role') == 'assistant':
                            parent_assistant_id = parent_hist[j].get('id')
                            break
                    if parent_assistant_id:
                        db.record_lineage(assistant_message_id, 'assistant', parent_assistant_id)
                    else:
                        db.record_lineage(assistant_message_id, 'assistant', None)
    except Exception as e:
        worker_logger.warning(f"[LINEAGE] Failed to record assistant lineage for {assistant_message_id}: {e}")
    
    if user_message_id and assistant_message_id:
        message_ids_data = {
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id
        }
        worker_logger.debug(f"[CHAT-WORKER] Sending message IDs for {chat_id}: user={user_message_id}, assistant={assistant_message_id}")
        child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'message_ids', 'content': json.dumps(message_ids_data)})
    
    full_text = ""
    full_thoughts = ""
    
    try:
        if use_reasoning:
            db.update_chat_state(chat_id, "thinking")
            child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'thinking'})
            current_state = "thinking"
        else:
            db.update_chat_state(chat_id, "responding")
            child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'responding'})
            current_state = "responding"
        
        for chunk in providers[provider].generate_text_stream(
            message, model=model, include_thoughts=use_reasoning, 
            chat_history=chat_history, file_attachments=file_attachments
        ):
            if child_conn.poll(0):
                try:
                    cmd_data = child_conn.recv()
                    if cmd_data.get('command') == 'cancel':
                        worker_logger.info(f"[CHAT-WORKER] Processing cancelled for {chat_id}")
                        return
                except:
                    pass  
            
            if chunk.get("type") == "thoughts":
                full_thoughts += chunk.get("content", "")
                try:
                    child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'thoughts', 'content': chunk.get("content", "")})
                except Exception as pub_error:
                    worker_logger.warning(f"[CHAT-WORKER] Failed to send thoughts chunk: {pub_error}")
                
            elif chunk.get("type") == "answer":
                full_text += chunk.get("content", "")
                try:
                    child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'answer', 'content': chunk.get("content", "")})
                except Exception as pub_error:
                    worker_logger.warning(f"[CHAT-WORKER] Failed to send answer chunk: {pub_error}")
                
                if current_state == "thinking":
                    try:
                        db.update_chat_state(chat_id, "responding")
                        child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'responding'})
                        current_state = "responding"
                    except Exception as state_error:
                        worker_logger.warning(f"[CHAT-WORKER] Failed to update state to responding: {state_error}")
            
            if assistant_message_id and (full_text or full_thoughts):
                try:
                    db.update_message(
                        assistant_message_id,
                        full_text,
                        thoughts=full_thoughts if full_thoughts else None
                    )
                except Exception as db_error:
                    worker_logger.error(f"[CHAT-WORKER] Error updating message in DB: {db_error}")
        
        db.update_chat_state(chat_id, "static")
        
        child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'static'})
        child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'complete', 'content': ''})
        
        worker_logger.info(f"[CHAT-WORKER] Processing completed successfully for {chat_id}")
        
    except Exception as stream_error:
        worker_logger.error(f"[CHAT-WORKER] Streaming error: {str(stream_error)}")
        raise


def _resolve_api_file_names(file_ids, provider, db, worker_logger):
    """Resolve file IDs to API file names for ready files only"""
    names = []
    for fid in file_ids:
        rec = db.get_file_record(fid)
        if rec:
            file_provider = rec.get('provider')
            api_file_name = rec.get('api_file_name')
            api_state = rec.get('api_state')
            
            effective_provider = file_provider or 'gemini'
            
            if effective_provider == provider and api_file_name and api_state == 'ready':
                names.append(api_file_name)
                worker_logger.info(f"[FILE-RESOLVE] File {fid} ({rec.get('original_name')}) resolved to API name: {api_file_name}")
            else:
                worker_logger.warning(f"[FILE-RESOLVE] File {fid} ({rec.get('original_name')}) not ready")
        else:
            worker_logger.warning(f"[FILE-RESOLVE] File {fid} not found in database")
    
    worker_logger.info(f"[FILE-RESOLVE] Resolved {len(names)}/{len(file_ids)} files")
    return names