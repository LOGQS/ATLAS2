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
from typing import Optional, Any, Dict


DB_UPDATE_THROTTLE_SECONDS = 0.25


def _update_message_with_throttle(db, current_content, assistant_message_id, worker_logger, *, force: bool = False):
    """Persist assistant message content while avoiding excessive writes."""
    if not assistant_message_id:
        return

    now = time.time()
    last_update = current_content.get('last_db_update', 0.0)
    if not force and (now - last_update) < DB_UPDATE_THROTTLE_SECONDS:
        return

    try:
        db.update_message(
            assistant_message_id,
            current_content.get('full_text', ''),
            thoughts=current_content.get('full_thoughts') or None
        )
        current_content['last_db_update'] = now
    except Exception as db_error:
        worker_logger.error(f"[CHAT-WORKER] Error updating message in DB: {db_error}")


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
        current_content = {'full_text': '', 'full_thoughts': '', 'assistant_message_id': None, 'last_db_update': 0.0}
        
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
                            if processing_active and current_content['assistant_message_id']:
                                try:
                                    worker_logger.info(f"[CHAT-WORKER] Saving partial content before stop for {chat_id}")
                                    _update_message_with_throttle(
                                        db,
                                        current_content,
                                        current_content['assistant_message_id'],
                                        worker_logger,
                                        force=True
                                    )
                                    db.update_chat_state(chat_id, "static")
                                    child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'static'})
                                    child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'complete', 'content': ''})
                                except Exception as save_error:
                                    worker_logger.error(f"[CHAT-WORKER] Error saving partial content on stop: {save_error}")
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

                                actual_chat_id = command.get('chat_id', chat_id)

                                message = command.get('message')
                                provider = command.get('provider', Config.get_default_provider())
                                model = command.get('model', Config.get_default_model())
                                include_reasoning = command.get('include_reasoning', True)
                                attached_file_ids = command.get('attached_file_ids', [])
                                user_message_id = command.get('user_message_id')
                                router_already_called = command.get('router_already_called', False)
                                router_result = command.get('router_result') 

                                if Config.get_default_router_state() and not router_already_called:
                                    from agents.roles.router import router
                                    chat_history = db.get_chat_history(actual_chat_id)

                                    attached_files = []
                                    if attached_file_ids:
                                        for file_id in attached_file_ids:
                                            file_record = db.get_file_record(file_id)
                                            if file_record:
                                                attached_files.append({
                                                    'id': file_record['id'],
                                                    'name': file_record['original_name']
                                                })

                                    router_result = router.route_request(message, chat_history, providers, actual_chat_id, attached_files)  # type: ignore
                                    model = router_result['model']
                                    provider = router_result['provider']

                                    child_conn.send({
                                        'type': 'router_decision',
                                        'chat_id': actual_chat_id,
                                        'selected_route': router_result['route'],
                                        'available_routes': router_result['available_routes'],
                                        'selected_model': model,
                                        'selected_provider': provider,
                                        'tools_needed': router_result.get('tools_needed'),
                                        'execution_type': router_result.get('execution_type'),
                                        'domain_id': router_result.get('domain_id'),
                                        'fastpath_params': router_result.get('fastpath_params')
                                    })

                                    worker_logger.info(f"[CHAT-WORKER] Router selected route: {router_result['route']} -> model: {model} -> provider: {provider}")
                                elif router_already_called and router_result:
                                    worker_logger.info(f"[CHAT-WORKER] Using router result from route handler: {router_result.get('route')} with tools_needed={router_result.get('tools_needed')}, fastpath_params={'present' if router_result.get('fastpath_params') else 'absent'}")
                                    worker_logger.info(f"[CHAT-WORKER] Router decision already broadcasted by route handler, skipping duplicate broadcast")

                                _process_message_in_worker(
                                    actual_chat_id, db, providers, message, provider, model,
                                    include_reasoning, attached_file_ids, user_message_id,
                                    child_conn, worker_logger, current_content,
                                    router_result=router_result
                                )
                                
                                processing_active = False
                                
                            except Exception as proc_error:
                                processing_active = False
                                error_msg = f'Processing failed: {str(proc_error)}'
                                worker_logger.error(f"[CHAT-WORKER] {error_msg}")
                                
                                try:
                                    db.update_chat_state(chat_id, "static")
                                    child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'static'})
                                    error_payload = {
                                        'type': 'content',
                                        'chat_id': chat_id,
                                        'content_type': 'error',
                                        'content': str(proc_error)
                                    }
                                    assistant_message_id = current_content.get('assistant_message_id')
                                    if assistant_message_id:
                                        error_payload['message_id'] = assistant_message_id
                                    child_conn.send(error_payload)
                                except Exception as cleanup_error:
                                    worker_logger.warning(f"[CHAT-WORKER] Failed to cleanup after error: {cleanup_error}")

                                assistant_message_id = current_content.get('assistant_message_id')
                                if assistant_message_id:
                                    try:
                                        deleted = db.cascade_delete_message(assistant_message_id, chat_id)
                                        worker_logger.info(f"[CHAT-WORKER] Removed {deleted} messages after error for {chat_id} starting at {assistant_message_id}")
                                    except Exception as delete_error:
                                        worker_logger.warning(f"[CHAT-WORKER] Failed to remove incomplete assistant message {assistant_message_id}: {delete_error}")
                                    current_content['assistant_message_id'] = None
                                    current_content['full_text'] = ''
                                    current_content['full_thoughts'] = ''
                                    current_content['last_db_update'] = 0.0
                                
                                child_conn.send({'success': False, 'error': error_msg, 'chat_id': chat_id})
                            
                        elif command_type == 'domain_tool_decision':
                            if processing_active:
                                child_conn.send({'success': False, 'error': 'Processing already active', 'chat_id': chat_id})
                                continue

                            task_id = command.get('task_id')
                            call_id = command.get('call_id')
                            decision = command.get('decision')
                            decision_chat_id = command.get('chat_id', chat_id)
                            assistant_override = command.get('assistant_message_id')

                            if not task_id or not call_id or not decision:
                                child_conn.send({
                                    'success': False,
                                    'chat_id': decision_chat_id,
                                    'error': 'Missing task_id, call_id, or decision for domain tool decision'
                                })
                                continue

                            try:
                                from agents.execution.single_domain_executor import single_domain_executor

                                processing_active = True
                                db.update_chat_state(decision_chat_id, "responding")
                                child_conn.send({'type': 'state_update', 'chat_id': decision_chat_id, 'state': 'responding'})

                                # Send immediate acknowledgement before processing
                                child_conn.send({'success': True, 'chat_id': decision_chat_id})

                                worker_logger.info(f"[DOMAIN-DECISION] Handling decision '{decision}' for task {task_id}, call {call_id}")
                                result = single_domain_executor.handle_tool_decision(task_id, call_id, decision)

                                if result.get('error'):
                                    error_msg = result['error']
                                    worker_logger.error(f"[DOMAIN-DECISION] Error: {error_msg}")
                                    db.update_chat_state(decision_chat_id, "static")
                                    child_conn.send({'type': 'state_update', 'chat_id': decision_chat_id, 'state': 'static'})
                                    child_conn.send({
                                        'success': False,
                                        'chat_id': decision_chat_id,
                                        'task_id': task_id,
                                        'error': error_msg
                                    })
                                else:
                                    assistant_for_update = result.get('assistant_message_id') or assistant_override or current_content.get('assistant_message_id')
                                    _handle_domain_result(
                                        result=result,
                                        chat_id=decision_chat_id,
                                        db=db,
                                        child_conn=child_conn,
                                        worker_logger=worker_logger,
                                        assistant_message_id=assistant_for_update,
                                        current_content=current_content
                                    )
                                    child_conn.send({
                                        'success': True,
                                        'chat_id': decision_chat_id,
                                        'task_id': task_id,
                                        'status': result.get('status')
                                    })

                                processing_active = False

                            except Exception as decision_error:
                                processing_active = False
                                worker_logger.error(f"[DOMAIN-DECISION] Failed to process decision: {decision_error}")
                                db.update_chat_state(decision_chat_id, "static")
                                child_conn.send({'type': 'state_update', 'chat_id': decision_chat_id, 'state': 'static'})
                                child_conn.send({
                                    'success': False,
                                    'chat_id': decision_chat_id,
                                    'task_id': task_id,
                                    'error': str(decision_error)
                                })
                            
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


def _execute_fastpath_tool(fastpath_params: str, chat_id: str, ctx_id: str, worker_logger) -> Optional[str]:
    """Execute a FastPath tool and return formatted output for the model.

    Args:
        fastpath_params: XML-like format with <TOOL> and <PARAM> tags
        chat_id: The chat ID for context
        ctx_id: Unique context ID for this execution (prevents duplicate detection)
        worker_logger: Logger instance

    Returns:
        Formatted tool output string or None if execution fails
    """
    if not fastpath_params or not fastpath_params.strip():
        return None

    try:
        import re

        tool_match = re.search(r'<TOOL>\s*(.+?)\s*</TOOL>', fastpath_params, re.IGNORECASE | re.DOTALL)
        if not tool_match:
            worker_logger.warning(f"[FASTPATH] No <TOOL> tag found in: {fastpath_params}")
            return None

        tool_name = tool_match.group(1).strip()

        param_pattern = r'<PARAM\s+name=["\'](.+?)["\']\s*>(.+?)</PARAM>'
        param_matches = re.findall(param_pattern, fastpath_params, re.IGNORECASE | re.DOTALL)

        params = {}
        for param_name, param_value in param_matches:
            params[param_name.strip()] = param_value.strip()

        worker_logger.info(f"[FASTPATH] Parsed tool: {tool_name} with params: {params}")
        worker_logger.debug(f"[FASTPATH] Using unique context ID: {ctx_id}")

        from agents.tools.tool_registry import tool_registry, ToolExecutionContext
        tool_spec = tool_registry.get(tool_name)

        ctx = ToolExecutionContext(
            chat_id=chat_id,
            plan_id="fastpath",
            task_id="fastpath",
            ctx_id=ctx_id
        )

        result = tool_spec.fn(params, ctx)

        worker_logger.info(f"[FASTPATH] Tool executed successfully, output type: {type(result.output)}")

        formatted_output = _format_tool_output(tool_name, result.output, worker_logger)

        return formatted_output

    except Exception as e:
        worker_logger.error(f"[FASTPATH] Tool execution failed: {str(e)}")
        return None


def _get_coder_workspace_path(db, chat_id: str, worker_logger) -> Optional[str]:
    """Fetch the configured coder workspace path for a chat."""

    def query(conn, cursor):
        cursor.execute(
            "SELECT workspace_path FROM coder_workspaces WHERE chat_id = ?",
            (chat_id,),
        )
        row = cursor.fetchone()
        return row[0] if row else None

    workspace_path = db._execute_with_connection(
        "fetch coder workspace",
        query,
        return_on_error=None,
    )

    if not workspace_path:
        worker_logger.info(f"[CODER_WORKSPACE] No workspace mapping found for chat {chat_id}")
        return None

    resolved_path = Path(workspace_path).expanduser()
    if not resolved_path.exists():
        worker_logger.warning(
            "[CODER_WORKSPACE] Workspace path %s does not exist on disk for chat %s",
            resolved_path,
            chat_id,
        )
        return None

    return str(resolved_path.resolve())


def _execute_domain_task(chat_id: str, db, domain_id: str, message: str, chat_history: list,
                         attached_file_ids: list, assistant_message_id: int, child_conn,
                         worker_logger, current_content):
    """Execute a domain task with the single domain executor."""

    try:
        from agents.execution.single_domain_executor import single_domain_executor

        worker_logger.info("=" * 80)
        worker_logger.info(f"[DOMAIN-EXEC-START] Starting domain execution")
        worker_logger.info(f"[DOMAIN-EXEC-START] Domain ID: {domain_id}")
        worker_logger.info(f"[DOMAIN-EXEC-START] Chat ID: {chat_id}")
        worker_logger.info(f"[DOMAIN-EXEC-START] User request: {message[:200]}...")
        worker_logger.info(f"[DOMAIN-EXEC-START] Attached files: {len(attached_file_ids)} files")
        worker_logger.info("=" * 80)

        db.update_chat_state(chat_id, "responding")
        child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'responding'})

        attached_files = []
        if attached_file_ids:
            for file_id in attached_file_ids:
                file_record = db.get_file_record(file_id)
                if file_record:
                    attached_files.append({
                        'id': file_record['id'],
                        'name': file_record['original_name']
                    })

        workspace_path: Optional[str] = None
        if domain_id == 'coder':
            workspace_path = _get_coder_workspace_path(db, chat_id, worker_logger)
            if not workspace_path:
                worker_logger.info(f"[CODER_WORKSPACE] Prompting user to select workspace for chat {chat_id}")
                prompt_message = (
                    "I need a workspace before I can start coding. "
                    "Please select a workspace in the Coder view to continue."
                )

                if assistant_message_id:
                    db.update_message(assistant_message_id, prompt_message)

                current_content['full_text'] = prompt_message
                current_content['full_thoughts'] = ''
                current_content['assistant_message_id'] = assistant_message_id
                current_content['last_db_update'] = time.time()

                child_conn.send({
                    'type': 'content',
                    'chat_id': chat_id,
                    'content_type': 'coder_workspace_prompt',
                    'content': json.dumps({
                        'chat_id': chat_id,
                        'message': message,
                        'domain_id': domain_id
                    })
                })

                child_conn.send({
                    'type': 'content',
                    'chat_id': chat_id,
                    'content_type': 'answer',
                    'content': prompt_message
                })

                # Keep worker alive and wait for workspace selection
                worker_logger.info(f"[CODER_WORKSPACE] Waiting for workspace selection for chat {chat_id}")
                db.update_chat_state(chat_id, "thinking")
                child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'thinking'})

                # Wait for workspace_selected command
                workspace_selected = False
                while not workspace_selected:
                    if child_conn.poll(timeout=0.5):
                        cmd = child_conn.recv()
                        if isinstance(cmd, dict):
                            if cmd.get('command') == 'workspace_selected':
                                worker_logger.info(f"[CODER_WORKSPACE] Received workspace_selected command for chat {chat_id}")
                                workspace_path = _get_coder_workspace_path(db, chat_id, worker_logger)
                                if workspace_path:
                                    workspace_selected = True
                                    child_conn.send({'success': True, 'workspace_path': workspace_path})
                                else:
                                    child_conn.send({'success': False, 'error': 'Workspace not found after selection'})
                            elif cmd.get('command') == 'cancel':
                                worker_logger.info(f"[CODER_WORKSPACE] Received cancel during workspace wait for chat {chat_id}")
                                db.update_chat_state(chat_id, "static")
                                child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'static'})
                                child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'complete', 'content': ''})
                                return

                if not workspace_path:
                    worker_logger.error(f"[CODER_WORKSPACE] Failed to get workspace after selection for chat {chat_id}")
                    db.update_chat_state(chat_id, "static")
                    child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'static'})
                    child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'complete', 'content': ''})
                    return

        def _domain_event_callback(event: Dict[str, Any]) -> None:
            try:
                event_type = event.get("event")
                payload = event.get("payload")
                task_id = event.get("task_id")

                if event_type == "state" and payload:
                    child_conn.send({
                        'type': 'content',
                        'chat_id': chat_id,
                        'content_type': 'domain_execution_update',
                        'content': json.dumps(payload),
                        'task_id': task_id,
                    })
                elif event_type == "tool_execution" and payload:
                    operation_payload = {
                        'task_id': task_id,
                        'domain_id': event.get("domain_id"),
                        'operation': payload,
                        'workspace_path': workspace_path,
                    }
                    child_conn.send({
                        'type': 'content',
                        'chat_id': chat_id,
                        'content_type': 'coder_operation',
                        'content': json.dumps(operation_payload),
                    })
            except Exception as callback_error: 
                worker_logger.error(
                    "[DOMAIN-EXEC] Failed to dispatch domain event for chat %s: %s",
                    chat_id,
                    callback_error,
                )

        worker_logger.info(f"[DOMAIN-EXEC] Calling single_domain_executor.execute_domain_task...")
        result = single_domain_executor.execute_domain_task(
            domain_id=domain_id,
            user_request=message,
            chat_id=chat_id,
            chat_history=chat_history,
            attached_files=attached_files,
            task_budget=None,
            assistant_message_id=assistant_message_id,
            workspace_path=workspace_path,
            event_callback=_domain_event_callback,
        )

        worker_logger.info("=" * 80)
        worker_logger.info(f"[DOMAIN-EXEC-RESULT] Status: {result.get('status')}")
        worker_logger.info(f"[DOMAIN-EXEC-RESULT] Task ID: {result.get('task_id')}")
        worker_logger.info(f"[DOMAIN-EXEC-RESULT] Agent ID: {result.get('agent_id')}")
        worker_logger.info(f"[DOMAIN-EXEC-RESULT] Actions: {len(result.get('actions') or [])}")
        worker_logger.info(f"[DOMAIN-EXEC-RESULT] Output length: {len(result.get('output') or '')} chars")
        if result.get('error'):
            worker_logger.error(f"[DOMAIN-EXEC-RESULT] Error: {result.get('error')}")
        worker_logger.info("=" * 80)

        _handle_domain_result(
            result=result,
            chat_id=chat_id,
            db=db,
            child_conn=child_conn,
            worker_logger=worker_logger,
            assistant_message_id=assistant_message_id,
            current_content=current_content
        )

    except Exception as e:
        worker_logger.error("=" * 80)
        worker_logger.error(f"[DOMAIN-EXEC-ERROR] Domain execution failed: {str(e)}")
        import traceback
        worker_logger.error(f"[DOMAIN-EXEC-ERROR] Traceback: {traceback.format_exc()}")
        worker_logger.error("=" * 80)

        error_text = f"Domain execution error: {str(e)}"
        if assistant_message_id:
            db.update_message(assistant_message_id, error_text)

        child_conn.send({
            'type': 'content',
            'chat_id': chat_id,
            'content_type': 'error',
            'content': error_text
        })

        db.update_chat_state(chat_id, "static")
        child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'static'})
        child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'complete', 'content': ''})


def _handle_domain_result(*, result: Dict[str, Any], chat_id: str, db, child_conn,
                          worker_logger, assistant_message_id: Optional[int],
                          current_content: Dict[str, Any]):
    """Persist and broadcast domain execution state."""
    status = (result.get('status') or '').lower()
    domain_execution_json = json.dumps(result)

    worker_logger.info(f"[DOMAIN-EXEC-STATE] Emitting domain_execution event (status={status})")
    child_conn.send({
        'type': 'content',
        'chat_id': chat_id,
        'content_type': 'domain_execution',
        'content': domain_execution_json
    })

    message_text = ''
    if result.get('error'):
        message_text = f"Domain execution error: {result['error']}"
    elif status == 'waiting_user':
        message_text = result.get('agent_message') or ''
    elif status in ('completed', 'failed', 'aborted'):
        message_text = result.get('output') or result.get('agent_message') or ''
    else:
        message_text = result.get('agent_message') or ''

    if assistant_message_id and message_text is not None:
        db.update_message(
            assistant_message_id,
            message_text,
            thoughts=None,
            domain_execution=domain_execution_json if not result.get('error') else None
        )
        worker_logger.info(f"[DOMAIN-EXEC-DB] Updated message {assistant_message_id} with {len(message_text)} chars")

    if message_text:
        child_conn.send({
            'type': 'content',
            'chat_id': chat_id,
            'content_type': 'answer',
            'content': message_text
        })

    if status == 'waiting_user':
        db.update_chat_state(chat_id, "static")
        child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'static'})
        return

    if status in ('completed', 'failed', 'aborted'):
        db.update_chat_state(chat_id, "static")
        child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'static'})
        child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'complete', 'content': ''})
        current_content['full_text'] = ''
        current_content['full_thoughts'] = ''
        current_content['assistant_message_id'] = None
        current_content['last_db_update'] = 0.0


def _format_tool_output(tool_name: str, output: Any, worker_logger) -> str:
    """Format tool output for clean presentation to the model.

    Args:
        tool_name: Name of the tool that was executed
        output: Raw output from the tool
        worker_logger: Logger instance

    Returns:
        Formatted string for model consumption
    """
    try:
        if tool_name == 'file.read' and isinstance(output, dict):
            if output.get('status') == 'success' and 'content' in output:
                file_path = output.get('file_path', 'unknown')
                content = output.get('content', '')
                warnings_list = output.get('warnings', [])

                formatted = f"File: {file_path}\n\n{content}"

                if warnings_list:
                    formatted += f"\n\n[Warnings: {'; '.join(warnings_list)}]"

                return formatted
            elif output.get('status') == 'duplicate':
                return output.get('message', str(output))

        if isinstance(output, dict):
            import json
            return json.dumps(output, indent=2)

        if isinstance(output, str):
            return output

        return str(output)

    except Exception as e:
        worker_logger.warning(f"[FASTPATH] Error formatting output: {e}, using raw output")
        return str(output)


def _process_message_in_worker(chat_id: str, db, providers, message: str, provider: str, model: str,
                              include_reasoning: bool, attached_file_ids: list, user_message_id: Optional[int],
                              child_conn, worker_logger, current_content, router_result=None):
    """Process a message within the worker process"""

    worker_logger.info(f"[CHAT-WORKER] Processing message with {provider}:{model} for {chat_id}")
    worker_logger.debug(f"[CHAT-WORKER] Available providers: {list(providers.keys())}")
    worker_logger.debug(f"[CHAT-WORKER] Provider '{provider}' in providers: {provider in providers}")

    if provider in providers:
        worker_logger.debug(f"[CHAT-WORKER] Provider '{provider}' is_available: {providers[provider].is_available()}")

    if provider not in providers or not providers[provider].is_available():
        available = {name: prov.is_available() for name, prov in providers.items()}
        raise ValueError(f"Provider '{provider}' not available. Available: {available}")

    use_reasoning = include_reasoning
    if use_reasoning and hasattr(providers[provider], 'supports_reasoning'):
        use_reasoning = providers[provider].supports_reasoning(model)

    chat_history = db.get_chat_history(chat_id)
    if chat_history and chat_history[-1]["role"] == "user":
        chat_history = chat_history[:-1]

    system_prompt = db.get_chat_system_prompt(chat_id)

    if router_result and router_result.get('fastpath_params'):
        import uuid
        unique_fastpath_id = f"fastpath_{uuid.uuid4().hex[:8]}"

        fastpath_output = _execute_fastpath_tool(
            router_result['fastpath_params'],
            chat_id,
            unique_fastpath_id,
            worker_logger
        )

        if fastpath_output:
            message = f"[SYSTEM CALLED THE RELEVANT TOOL. ANSWER USER QUERY WITH THE FOLLOWING TOOL OUTPUT:]\n\n{fastpath_output}\n\n---\n\n[USER QUERY:]\n{message}"
            worker_logger.info(f"[FASTPATH] Prepended tool output to current user message")

    file_attachments = []
    if attached_file_ids:
        file_attachments = _resolve_api_file_names(attached_file_ids, provider, db, worker_logger)

    worker_logger.info("=" * 80)
    worker_logger.info("[MODEL INPUT] Complete prompt sent to model:")
    worker_logger.info("=" * 80)

    if system_prompt:
        system_preview = system_prompt[:500] if len(system_prompt) > 500 else system_prompt
        if len(system_prompt) > 500:
            system_preview += f"... (truncated, total: {len(system_prompt)} chars)"
        worker_logger.info(f"[SYSTEM PROMPT]: {system_preview}")
    else:
        worker_logger.info("[SYSTEM PROMPT]: None")

    if chat_history:
        worker_logger.info(f"\n[CHAT HISTORY]: {len(chat_history)} messages")
        for idx, msg in enumerate(chat_history):
            role = msg.get('role', 'unknown')
            content = msg.get('content', '')[:200]
            if len(msg.get('content', '')) > 200:
                content += "..."
            worker_logger.info(f"  [{idx}] {role}: {content}")
    else:
        worker_logger.info("\n[CHAT HISTORY]: Empty")

    message_preview = message[:1500] if len(message) > 1500 else message
    if len(message) > 1500:
        message_preview += f"\n... (truncated, total: {len(message)} chars)"

    if '[SYSTEM CALLED THE RELEVANT TOOL' in message:
        worker_logger.info(f"\n[CURRENT MESSAGE] ⚡ (includes FastPath tool output):\n{message_preview}")
    else:
        worker_logger.info(f"\n[CURRENT MESSAGE]:\n{message_preview}")

    if file_attachments:
        worker_logger.info(f"\n[ATTACHMENTS]: {file_attachments}")

    worker_logger.info("=" * 80)

    router_enabled = router_result is not None
    router_decision = None
    if router_result:
        router_decision = json.dumps({
            'route': router_result['route'],
            'available_routes': router_result['available_routes'],
            'selected_model': router_result['model'],
            'selected_provider': router_result['provider'],
            'tools_needed': router_result.get('tools_needed'),
            'execution_type': router_result.get('execution_type'),
            'domain_id': router_result.get('domain_id'),
            'fastpath_params': router_result.get('fastpath_params')
        })

    assistant_message_id = db.save_message(
        chat_id,
        "assistant",
        "",
        thoughts=None,
        provider=provider,
        model=model,
        router_enabled=router_enabled,
        router_decision=router_decision
    )

    current_content['assistant_message_id'] = assistant_message_id
    current_content['full_text'] = ''
    current_content['full_thoughts'] = ''
    current_content['last_db_update'] = 0.0
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
    
    full_text = current_content['full_text']
    full_thoughts = current_content['full_thoughts']

    domain_id = router_result and router_result.get('domain_id')
    route = router_result and router_result.get('route')

    if domain_id and route != 'direct':
        worker_logger.info(f"[DOMAIN-EXECUTION] Detected domain execution: {domain_id}")
        _execute_domain_task(
            chat_id, db, domain_id, message, chat_history,
            attached_file_ids, assistant_message_id, child_conn, worker_logger,
            current_content
        )
        return

    try:
        if use_reasoning:
            db.update_chat_state(chat_id, "thinking")
            child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'thinking'})
            current_state = "thinking"
        else:
            db.update_chat_state(chat_id, "responding")
            child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'responding'})
            current_state = "responding"
        
        streaming_usage_metadata = None  # Track usage from streaming

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
                    elif cmd_data.get('command') == 'stop':
                        worker_logger.info(f"[CHAT-WORKER] Stop requested during streaming for {chat_id}")
                        if assistant_message_id and (full_text or full_thoughts):
                            current_content['full_text'] = full_text
                            current_content['full_thoughts'] = full_thoughts
                            _update_message_with_throttle(
                                db,
                                current_content,
                                assistant_message_id,
                                worker_logger,
                                force=True
                            )
                        db.update_chat_state(chat_id, "static")
                        child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'static'})
                        child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'complete', 'content': ''})
                        child_conn.send({'success': True, 'chat_id': chat_id, 'stopped_during_stream': True})
                        return
                except:
                    pass

            content_changed = False

            if chunk.get("type") == "usage":
                # Capture usage metadata from streaming providers
                usage_data = chunk.get("usage") or chunk.get("usage_metadata")
                if usage_data:
                    streaming_usage_metadata = usage_data
                    worker_logger.info(f"[CHAT-WORKER] Captured usage from stream: {streaming_usage_metadata}")

            elif chunk.get("type") == "thoughts":
                full_thoughts += chunk.get("content", "")
                current_content['full_thoughts'] = full_thoughts
                try:
                    child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'thoughts', 'content': chunk.get("content", "")})
                except Exception as pub_error:
                    worker_logger.warning(f"[CHAT-WORKER] Failed to send thoughts chunk: {pub_error}")
                content_changed = True

            elif chunk.get("type") == "answer":
                full_text += chunk.get("content", "")
                current_content['full_text'] = full_text
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
                content_changed = True

            if content_changed and assistant_message_id and (full_text or full_thoughts):
                _update_message_with_throttle(
                    db,
                    current_content,
                    assistant_message_id,
                    worker_logger
                )

        db.update_chat_state(chat_id, "static")

        child_conn.send({'type': 'state_update', 'chat_id': chat_id, 'state': 'static'})
        child_conn.send({'type': 'content', 'chat_id': chat_id, 'content_type': 'complete', 'content': ''})

        if assistant_message_id and (full_text or full_thoughts):
            _update_message_with_throttle(
                db,
                current_content,
                assistant_message_id,
                worker_logger,
                force=True
            )

        current_content['full_text'] = ''
        current_content['full_thoughts'] = ''
        current_content['assistant_message_id'] = None
        current_content['last_db_update'] = 0.0
        
        from agents.context.context_manager import context_manager
        token_estimate = context_manager.estimate_request_tokens(
            role="assistant",
            provider=provider,
            model=model,
            system_prompt=system_prompt,
            chat_history=chat_history,
            current_message=message,
            file_attachments=file_attachments
        )
        estimated_tokens = token_estimate['estimated_tokens']['total']

        # Extract actual tokens from streaming usage if available
        actual_tokens_count = 0
        if streaming_usage_metadata:
            # Handle different formats (Gemini vs OpenAI-compatible)
            if 'total_token_count' in streaming_usage_metadata:
                # Gemini format
                actual_tokens_count = streaming_usage_metadata['total_token_count']
            elif 'total_tokens' in streaming_usage_metadata:
                # OpenAI-compatible format (Groq, OpenRouter)
                actual_tokens_count = streaming_usage_metadata['total_tokens']
            worker_logger.info(f"[TokenUsage] Using actual tokens from stream: {actual_tokens_count}")

        # Save token usage with both estimated and actual
        if actual_tokens_count > 0:
            db.save_token_usage(
                chat_id=chat_id,
                role='assistant',
                provider=provider,
                model=model,
                estimated_tokens=estimated_tokens,
                actual_tokens=actual_tokens_count,
                message_id=assistant_message_id
            )
            worker_logger.info(f"[TokenUsage] Saved assistant token usage for chat {chat_id}: estimated={estimated_tokens}, actual={actual_tokens_count} tokens")
        else:
            db.save_token_usage(
                chat_id=chat_id,
                role='assistant',
                provider=provider,
                model=model,
                estimated_tokens=estimated_tokens,
                actual_tokens=0,
                message_id=assistant_message_id
            )
            worker_logger.info(f"[TokenUsage] Saved assistant token usage for chat {chat_id}: estimated={estimated_tokens} tokens (no actual available)")

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
