# status: complete

import asyncio
import threading
import atexit
import concurrent.futures
import json
import time
from typing import Dict, Any, Optional, List, Coroutine
from pathlib import Path
from utils.logger import get_logger
from utils.config import get_provider_map
from utils.db_utils import db
from agents.context.context_manager import context_manager
from utils.rate_limiter import get_rate_limiter

logger = get_logger(__name__)

# Global tracking for async chat tasks
_async_chat_tasks_lock = threading.Lock()
_async_chat_tasks: Dict[str, concurrent.futures.Future] = {}

# Global tracking for async chats waiting for workspace selection
_async_workspace_pending_lock = threading.Lock()
_async_workspace_pending: Dict[str, Dict[str, Any]] = {}

# Global tracking for stop vs cancel (stop should save partial content, cancel should discard)
_async_stop_flags_lock = threading.Lock()
_async_stop_flags: Dict[str, bool] = {}  # True = stop (save), False/missing = cancel (discard)

# Track domain sessions that were launched via the async engine and may need
# follow-up tool decisions without falling back to worker-based execution.
_async_domain_sessions_lock = threading.Lock()
_async_domain_sessions: Dict[str, Dict[str, Any]] = {}

# Track recently cleared domain sessions to handle stale tool decisions gracefully
_recently_cleared_sessions_lock = threading.Lock()
_recently_cleared_sessions: Dict[str, float] = {}  # {chat_id: clear_time}


class _AsyncLoopManager:
    """Persistent asyncio event loop running in a background thread for async chats."""

    def __init__(self):
        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(
            target=self._run_loop,
            name="atlas-async-chat-loop",
            daemon=True,
        )
        self._loop_thread.start()

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_forever()
        finally:
            pending = asyncio.all_tasks(self._loop)
            if pending:
                self._loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            self._loop.close()

    def submit(self, coro: Coroutine[Any, Any, Any]) -> concurrent.futures.Future:
        """Schedule coroutine on the persistent loop and return concurrent future."""
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    def call_soon(self, callback, *args):
        """Schedule a callback to run on the managed loop thread."""
        self._loop.call_soon_threadsafe(callback, *args)

    def shutdown(self):
        """Stop the loop and wait for the thread to exit."""
        if not self._loop.is_running():
            return

        def _stop_loop():
            if self._loop.is_running():
                self._loop.stop()

        self.call_soon(_stop_loop)
        self._loop_thread.join(timeout=5)


_async_loop_manager = _AsyncLoopManager()
atexit.register(_async_loop_manager.shutdown)
def is_async_chat_processing(chat_id: str) -> bool:
    """Check if a chat is currently being processed via async engine"""
    with _async_chat_tasks_lock:
        task = _async_chat_tasks.get(chat_id)
        return task is not None and not task.done()


def is_async_chat_waiting_for_workspace(chat_id: str) -> bool:
    """Check if an async chat is waiting for workspace selection"""
    with _async_workspace_pending_lock:
        return chat_id in _async_workspace_pending


def has_async_domain_session(chat_id: str) -> bool:
    """Return True if the chat has an active async-managed domain session."""
    with _async_domain_sessions_lock:
        return chat_id in _async_domain_sessions


def _get_async_domain_session(chat_id: str) -> Optional[Dict[str, Any]]:
    with _async_domain_sessions_lock:
        session = _async_domain_sessions.get(chat_id)
        return dict(session) if session else None


def _set_async_domain_session(chat_id: str, session: Dict[str, Any]) -> None:
    with _async_domain_sessions_lock:
        existing = _async_domain_sessions.get(chat_id, {})
        merged = {**existing, **session}
        _async_domain_sessions[chat_id] = merged
        logger.debug(f"[ASYNC-DOMAIN] Session updated for {chat_id}: keys={list(merged.keys())}")


def _clear_async_domain_session(chat_id: str) -> None:
    with _async_domain_sessions_lock:
        if _async_domain_sessions.pop(chat_id, None) is not None:
            logger.debug(f"[ASYNC-DOMAIN] Session cleared for {chat_id}")

            # Track recently cleared session to handle stale tool decisions
            with _recently_cleared_sessions_lock:
                _recently_cleared_sessions[chat_id] = time.time()

                # Clean up old entries (>30 seconds)
                cutoff = time.time() - 30
                to_remove = [cid for cid, t in _recently_cleared_sessions.items() if t < cutoff]
                for cid in to_remove:
                    del _recently_cleared_sessions[cid]


def stop_async_chat(chat_id: str) -> bool:
    """
    Stop an async chat task and save partial content.
    Similar to cancel but preserves partial work.
    """
    # Mark this as a stop (not cancel) so the handler knows to save partial content
    with _async_stop_flags_lock:
        _async_stop_flags[chat_id] = True

    with _async_chat_tasks_lock:
        future = _async_chat_tasks.get(chat_id)

    if future and not future.done():
        if future.cancel():
            logger.info(f"[ASYNC-STOP] Requested stop for async chat {chat_id} (partial content will be saved)")
            return True
        logger.debug(f"[ASYNC-STOP] Stop request for {chat_id} ignored (already completed)")
    else:
        logger.info(f"[ASYNC-STOP] No active async task found for chat {chat_id}")
        # Clean up flag since there's no task to cancel
        with _async_stop_flags_lock:
            _async_stop_flags.pop(chat_id, None)

    return False


def cancel_async_chat(chat_id: str) -> bool:
    """Cancel an async chat task and discard partial content"""
    # Mark this as a cancel (not stop) so the handler knows to discard partial content
    with _async_stop_flags_lock:
        _async_stop_flags[chat_id] = False

    # Check if chat is waiting for workspace selection
    with _async_workspace_pending_lock:
        pending_state = _async_workspace_pending.pop(chat_id, None)

    if pending_state:
        logger.info(f"[ASYNC-CANCEL] Cancelled chat {chat_id} waiting for workspace selection")
        # Clean up state
        from route.chat_route import publish_state, publish_content
        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        publish_content(chat_id, 'complete', '')
        # Clean up flag
        with _async_stop_flags_lock:
            _async_stop_flags.pop(chat_id, None)
        _clear_async_domain_session(chat_id)
        return True

    # Otherwise check for active streaming task
    with _async_chat_tasks_lock:
        future = _async_chat_tasks.get(chat_id)

    if future and not future.done():
        if future.cancel():
            logger.info(f"[ASYNC-CANCEL] Requested cancellation for async chat {chat_id} (partial content will be discarded)")
            _clear_async_domain_session(chat_id)
            return True
        logger.debug(f"[ASYNC-CANCEL] Cancellation request for {chat_id} ignored (already completed)")
    else:
        logger.info(f"[ASYNC-CANCEL] No active async task found for chat {chat_id}")
        # Clean up flag since there's no task to cancel
        with _async_stop_flags_lock:
            _async_stop_flags.pop(chat_id, None)
        _clear_async_domain_session(chat_id)

    return False


def cleanup_async_chat(chat_id: str):
    """Clean up async chat task and associated resources"""
    with _async_chat_tasks_lock:
        future = _async_chat_tasks.pop(chat_id, None)

    # Preserve any pending workspace resume state so coder flows can continue
    # once the user finishes selecting a workspace.

    with _async_stop_flags_lock:
        _async_stop_flags.pop(chat_id, None)

    if future is None:
        logger.debug(f"[ASYNC-CLEANUP] No async resources found for chat {chat_id}")
        return

    if not future.done():
        future.cancel()
        logger.debug(f"[ASYNC-CLEANUP] Cancelled in-flight async future for chat {chat_id}")

    logger.info(f"[ASYNC-CLEANUP] Cleaned up async resources for chat {chat_id}")


def resume_async_after_workspace_selection(chat_id: str) -> bool:
    """
    Resume async execution after workspace has been selected.
    Returns True if resumed successfully, False if no pending execution found.
    """
    with _async_workspace_pending_lock:
        pending_state = _async_workspace_pending.pop(chat_id, None)

    if not pending_state:
        logger.warning(f"[ASYNC-WORKSPACE-RESUME] No pending execution found for chat {chat_id}")
        return False

    # Get the workspace path
    workspace_path = _get_coder_workspace_path(chat_id)
    if not workspace_path:
        logger.error(f"[ASYNC-WORKSPACE-RESUME] Failed to get workspace path after selection for chat {chat_id}")
        from route.chat_route import publish_state, publish_content
        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        publish_content(chat_id, 'error', 'Failed to retrieve workspace path after selection')
        publish_content(chat_id, 'complete', '')
        return False

    logger.info(f"[ASYNC-WORKSPACE-RESUME] Resuming async execution for chat {chat_id} with workspace: {workspace_path}")

    # Create coroutine for domain execution
    coro = _execute_async_domain_task(
        chat_id=pending_state['chat_id'],
        domain_id=pending_state['domain_id'],
        message=pending_state['message'],
        chat_history=pending_state['chat_history'],
        attached_file_ids=pending_state['attached_file_ids'],
        assistant_message_id=pending_state['assistant_message_id'],
        workspace_path=workspace_path,
        provider=pending_state['provider'],
        model=pending_state['model']
    )

    # Submit to async loop
    with _async_chat_tasks_lock:
        # Check if already processing
        existing_task = _async_chat_tasks.get(chat_id)
        if existing_task and not existing_task.done():
            logger.warning(f"[ASYNC-WORKSPACE-RESUME] Chat {chat_id} is already processing")
            return False

        future = _async_loop_manager.submit(coro)
        _async_chat_tasks[chat_id] = future

    def _future_finalizer(completed_future: concurrent.futures.Future):
        try:
            completed_future.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.debug(f"[ASYNC-WORKSPACE-RESUME] Async task for chat {chat_id} completed with error", exc_info=True)
        finally:
            cleanup_async_chat(chat_id)

    future.add_done_callback(_future_finalizer)

    logger.info(f"[ASYNC-WORKSPACE-RESUME] Successfully resumed async execution for chat {chat_id}")
    return True


def _format_tool_output(tool_name: str, output: Any) -> str:
    """Format tool output for clean presentation to the model.

    Args:
        tool_name: Name of the tool that was executed
        output: Raw output from the tool

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
        logger.warning(f"[FASTPATH][ASYNC] Error formatting output: {e}, using raw output")
        return str(output)


def _execute_fastpath_tool(fastpath_params: str, chat_id: str, ctx_id: str) -> Optional[str]:
    """Execute a FastPath tool and return formatted output for the model.

    Args:
        fastpath_params: XML-like format with <TOOL> and <PARAM> tags
        chat_id: The chat ID for context
        ctx_id: Unique context ID for this execution (prevents duplicate detection)

    Returns:
        Formatted tool output string or None if execution fails
    """
    if not fastpath_params or not fastpath_params.strip():
        return None

    try:
        import re

        tool_match = re.search(r'<TOOL>\s*(.+?)\s*</TOOL>', fastpath_params, re.IGNORECASE | re.DOTALL)
        if not tool_match:
            logger.warning(f"[FASTPATH][ASYNC] No <TOOL> tag found in: {fastpath_params}")
            return None

        tool_name = tool_match.group(1).strip()

        param_pattern = r'<PARAM\s+name=["\'](.+?)["\']\s*>(.+?)</PARAM>'
        param_matches = re.findall(param_pattern, fastpath_params, re.IGNORECASE | re.DOTALL)

        params = {}
        for param_name, param_value in param_matches:
            params[param_name.strip()] = param_value.strip()

        logger.info(f"[FASTPATH][ASYNC] Parsed tool: {tool_name} with params: {params}")
        logger.debug(f"[FASTPATH][ASYNC] Using unique context ID: {ctx_id}")

        from agents.tools.tool_registry import tool_registry, ToolExecutionContext
        tool_spec = tool_registry.get(tool_name)

        ctx = ToolExecutionContext(
            chat_id=chat_id,
            plan_id="fastpath",
            task_id="fastpath",
            ctx_id=ctx_id
        )

        result = tool_spec.fn(params, ctx)

        logger.info(f"[FASTPATH][ASYNC] Tool executed successfully, output type: {type(result.output)}")

        formatted_output = _format_tool_output(tool_name, result.output)

        return formatted_output

    except Exception as e:
        logger.error(f"[FASTPATH][ASYNC] Tool execution failed: {str(e)}")
        # Return error message so LLM can inform user about the failure
        return f"[TOOL EXECUTION ERROR] The {tool_name} tool failed with error: {str(e)}"


def _get_coder_workspace_path(chat_id: str) -> Optional[str]:
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
        logger.info(f"[CODER_WORKSPACE][ASYNC] No workspace mapping found for chat {chat_id}")
        return None

    resolved_path = Path(workspace_path).expanduser()
    if not resolved_path.exists():
        logger.warning(
            f"[CODER_WORKSPACE][ASYNC] Workspace path {resolved_path} does not exist on disk for chat {chat_id}"
        )
        return None

    return str(resolved_path.resolve())


def _handle_async_domain_result(
    *,
    chat_id: str,
    result: Dict[str, Any],
    assistant_message_id: Optional[int],
    provider: str,
    model: str,
    workspace_path: Optional[str],
) -> str:
    """
    Persist and broadcast domain execution results produced via the async engine.

    Returns the lowercase status string from the domain result.
    """
    from route.chat_route import publish_state, publish_content

    status = (result.get('status') or '').lower()
    domain_execution_json = json.dumps(result)

    logger.info(f"[ASYNC-DOMAIN-EXEC-STATE] Emitting domain_execution event (status={status})")
    publish_content(chat_id, 'domain_execution', domain_execution_json)

    if result.get('error'):
        message_text = f"Domain execution error: {result['error']}"
    elif status == 'waiting_user':
        message_text = result.get('agent_message') or ''
    elif status in ('completed', 'failed', 'aborted'):
        message_text = result.get('output') or result.get('agent_message') or ''
    else:
        message_text = result.get('agent_message') or ''

    if message_text:
        logger.info(f"[ASYNC-DOMAIN-EXEC] Broadcasting answer text ({len(message_text)} chars)")
        publish_content(chat_id, 'answer', message_text)

    if assistant_message_id is not None and message_text is not None:
        db.update_message(
            assistant_message_id,
            message_text,
            thoughts=None,
            domain_execution=domain_execution_json if not result.get('error') else None,
        )
        logger.info(f"[ASYNC-DOMAIN-EXEC-DB] Updated message {assistant_message_id} with {len(message_text)} chars")

    session_payload = {
        'assistant_message_id': assistant_message_id,
        'provider': provider,
        'model': model,
        'workspace_path': workspace_path,
        'domain_id': result.get('domain_id'),
        'task_id': result.get('task_id'),
    }

    if status == 'waiting_user':
        logger.info("[ASYNC-DOMAIN-EXEC] Domain task waiting for user input, keeping session active")
        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        _set_async_domain_session(chat_id, session_payload)
    elif status in ('completed', 'failed', 'aborted'):
        logger.info(f"[ASYNC-DOMAIN-EXEC] Domain task finished with status={status}, sending complete event")
        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        publish_content(chat_id, 'complete', '')
        _clear_async_domain_session(chat_id)
    else:
        logger.warning(f"[ASYNC-DOMAIN-EXEC] Unexpected domain status '{status}', sending complete event")
        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        publish_content(chat_id, 'complete', '')
        _clear_async_domain_session(chat_id)

    return status


async def _execute_async_domain_task(
    chat_id: str,
    domain_id: str,
    message: str,
    chat_history: list,
    attached_file_ids: List[str],
    assistant_message_id: Optional[int],
    workspace_path: str,
    provider: str,
    model: str
):
    """Execute a domain task asynchronously."""
    from route.chat_route import publish_state, publish_content
    from agents.execution.single_domain_executor import single_domain_executor

    try:
        logger.info("=" * 80)
        logger.info(f"[ASYNC-DOMAIN-EXEC] Starting async domain execution")
        logger.info(f"[ASYNC-DOMAIN-EXEC] Domain ID: {domain_id}")
        logger.info(f"[ASYNC-DOMAIN-EXEC] Chat ID: {chat_id}")
        logger.info(f"[ASYNC-DOMAIN-EXEC] User request: {message[:200]}...")
        logger.info(f"[ASYNC-DOMAIN-EXEC] Attached files: {len(attached_file_ids)} files")
        logger.info(f"[ASYNC-DOMAIN-EXEC] Workspace path: {workspace_path}")
        logger.info("=" * 80)

        db.update_chat_state(chat_id, "responding")
        publish_state(chat_id, "responding")

        attached_files = []
        if attached_file_ids:
            for file_id in attached_file_ids:
                file_record = db.get_file_record(file_id)
                if file_record:
                    attached_files.append({
                        'id': file_record['id'],
                        'name': file_record['original_name']
                    })

        def _derive_file_change_events(operation_detail: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
            events: List[Dict[str, Any]] = []
            if not isinstance(operation_detail, dict):
                return events

            metadata = operation_detail.get("metadata")
            if isinstance(metadata, dict):
                workspace_events = metadata.get("workspace_events")
                if isinstance(workspace_events, list):
                    for raw in workspace_events:
                        if isinstance(raw, dict):
                            events.append(dict(raw))

            ops_list = operation_detail.get("ops")
            if isinstance(ops_list, list):
                for op in ops_list:
                    if not isinstance(op, dict):
                        continue
                    op_type = op.get("type")
                    if op_type == "file_write":
                        file_path = op.get("path") or op.get("destination_path")
                        if not file_path:
                            continue
                        content = op.get("after") if isinstance(op.get("after"), str) else None
                        events.append({
                            "operation": "write",
                            "file_path": file_path,
                            "content": content,
                        })
                    elif op_type == "file_edit":
                        file_path = op.get("path")
                        if not file_path:
                            continue
                        content = op.get("after") if isinstance(op.get("after"), str) else None
                        events.append({
                            "operation": "edit",
                            "file_path": file_path,
                            "content": content,
                        })
                    elif op_type == "file_move":
                        dest_path = op.get("destination_path") or op.get("path")
                        if not dest_path:
                            continue
                        events.append({
                            "operation": "move",
                            "file_path": dest_path,
                            "previous_path": op.get("source_path"),
                        })

            deduped: List[Dict[str, Any]] = []
            seen = set()
            for event in events:
                key = (event.get("operation"), event.get("file_path"), event.get("previous_path"))
                if key in seen:
                    continue
                seen.add(key)
                deduped.append(event)
            return deduped

        def _domain_event_callback(event: Dict[str, Any]) -> None:
            try:
                event_type = event.get("event")
                payload = event.get("payload")
                task_id = event.get("task_id")

                if event_type == "state" and payload:
                    publish_content(
                        chat_id,
                        'domain_execution_update',
                        json.dumps(payload),
                        task_id=task_id
                    )
                elif event_type == "model_retry" and payload:
                    publish_content(
                        chat_id,
                        'model_retry',
                        json.dumps(payload),
                        task_id=task_id
                    )
                elif event_type == "tool_execution" and payload:
                    operation_payload = {
                        'task_id': task_id,
                        'domain_id': event.get("domain_id"),
                        'operation': payload,
                        'workspace_path': workspace_path,
                    }
                    publish_content(
                        chat_id,
                        'coder_operation',
                        json.dumps(operation_payload)
                    )

                    try:
                        file_events = _derive_file_change_events(payload)
                        if file_events:
                            for raw_event in file_events:
                                file_path = raw_event.get("file_path")
                                if not file_path:
                                    continue
                                event_detail = {
                                    "chat_id": chat_id,
                                    "workspace_path": workspace_path,
                                    "file_path": file_path,
                                    "operation": raw_event.get("operation", "edit"),
                                    "content": raw_event.get("content"),
                                    "previous_path": raw_event.get("previous_path"),
                                }
                                publish_content(
                                    chat_id,
                                    'coder_file_change',
                                    json.dumps(event_detail)
                                )
                    except Exception as file_event_error:
                        logger.warning(
                            f"[ASYNC-DOMAIN-EXEC] Failed to derive file change events for chat {chat_id}: {file_event_error}"
                        )
                elif event_type == "coder_stream" and payload:
                    publish_content(
                        chat_id,
                        'coder_stream',
                        json.dumps(payload),
                        task_id=task_id
                    )
                elif event_type == "coder_file_operation" and payload:
                    publish_content(
                        chat_id,
                        'coder_file_operation',
                        '',
                        task_id=task_id,
                        domain_id=event.get("domain_id"),
                        payload=payload
                    )
                elif event_type == "coder_file_revert" and payload:
                    logger.info(
                        f"[ASYNC-DOMAIN-EXEC] Publishing coder_file_revert for {chat_id}: "
                        f"file={payload.get('file_path')}"
                    )
                    publish_content(
                        chat_id,
                        'coder_file_revert',
                        '',
                        task_id=task_id,
                        domain_id=event.get("domain_id"),
                        payload=payload
                    )
            except Exception as callback_error:
                logger.error(
                    f"[ASYNC-DOMAIN-EXEC] Failed to dispatch domain event for chat {chat_id}: {callback_error}"
                )

        logger.info(f"[ASYNC-DOMAIN-EXEC] Calling single_domain_executor.execute_domain_task...")
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
            rate_limit_prechecked=True,
        )

        if not isinstance(result, dict):
            logger.error(
                "[ASYNC-DOMAIN-EXEC] single_domain_executor returned unexpected result %r for chat %s",
                result,
                chat_id,
            )
            raise RuntimeError("Domain executor failed to produce a result")

        logger.info("=" * 80)
        logger.info(f"[ASYNC-DOMAIN-EXEC-RESULT] Status: {result.get('status')}")
        logger.info(f"[ASYNC-DOMAIN-EXEC-RESULT] Task ID: {result.get('task_id')}")
        logger.info(f"[ASYNC-DOMAIN-EXEC-RESULT] Agent ID: {result.get('agent_id')}")
        logger.info(f"[ASYNC-DOMAIN-EXEC-RESULT] Actions: {len(result.get('actions') or [])}")
        logger.info(f"[ASYNC-DOMAIN-EXEC-RESULT] Output length: {len(result.get('output') or '')} chars")
        if result.get('error'):
            logger.error(f"[ASYNC-DOMAIN-EXEC-RESULT] Error: {result.get('error')}")
        logger.info("=" * 80)

        status = _handle_async_domain_result(
            chat_id=chat_id,
            result=result,
            assistant_message_id=assistant_message_id,
            provider=provider,
            model=model,
            workspace_path=workspace_path,
        )

        if status == 'waiting_user':
            return

        logger.info(f"[ASYNC-DOMAIN-EXEC] Completed async domain execution for chat {chat_id}")

    except Exception as e:
        logger.error(f"[ASYNC-DOMAIN-EXEC] Unexpected error in async domain execution for chat {chat_id}: {e}", exc_info=True)
        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        publish_content(chat_id, 'error', f"Async domain execution error: {str(e)}")


def handle_async_domain_tool_decision(
    chat_id: str,
    task_id: str,
    call_id: str,
    decision: str,
    *,
    assistant_message_id: Optional[int] = None,
    batch_mode: bool = True,
    pre_executed_calls: Dict[str, bool] = None,
    pre_execution_state: Dict[str, Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """
    Handle a domain tool decision entirely within the async engine.

    Returns a response dict mirroring the worker response on success, or None if
    no async session is registered (caller should fall back to worker path).
    """
    if pre_executed_calls is None:
        pre_executed_calls = {}
    if pre_execution_state is None:
        pre_execution_state = {}
    session = _get_async_domain_session(chat_id)
    if not session:
        # Check if session was recently cleared (within last 10 seconds)
        # This handles race conditions where frontend sends duplicate tool approvals
        with _recently_cleared_sessions_lock:
            clear_time = _recently_cleared_sessions.get(chat_id)
            if clear_time and (time.time() - clear_time < 10):
                logger.info(
                    "[ASYNC-DOMAIN-STALE] Ignoring tool decision for recently cleared session %s - "
                    "likely a duplicate request from frontend race condition",
                    chat_id
                )
                return {
                    "success": True,
                    "chat_id": chat_id,
                    "task_id": task_id,
                    "status": "completed",
                    "message": "Task already completed, ignoring duplicate approval",
                    "stale_request": True,
                }

        logger.debug(f"[ASYNC-DOMAIN] No async session found for chat {chat_id}, deferring to worker")
        return None

    provider = session.get('provider')
    model = session.get('model')
    workspace_path = session.get('workspace_path')
    if not provider or not model:
        logger.warning(f"[ASYNC-DOMAIN] Session for {chat_id} missing provider/model, deferring to worker")
        return None

    from route.chat_route import publish_state, publish_content
    from agents.execution.single_domain_executor import single_domain_executor

    logger.info(f"[ASYNC-DOMAIN] Handling tool decision via async engine for chat {chat_id}, task {task_id}")

    try:
        db.update_chat_state(chat_id, "responding")
        publish_state(chat_id, "responding")
    except Exception as state_error:
        logger.warning(f"[ASYNC-DOMAIN] Failed to set responding state for {chat_id}: {state_error}")

    try:
        result = single_domain_executor.handle_tool_decision(
            task_id=task_id,
            call_id=call_id,
            decision=decision,
            batch_mode=batch_mode,
            pre_executed_calls=pre_executed_calls,
            pre_execution_state=pre_execution_state,
        )
    except Exception as exec_error:
        logger.error(f"[ASYNC-DOMAIN] Exception handling tool decision for {chat_id}: {exec_error}", exc_info=True)
        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        publish_content(chat_id, 'error', f"Async tool decision error: {str(exec_error)}")
        _clear_async_domain_session(chat_id)
        return {
            'success': False,
            'chat_id': chat_id,
            'task_id': task_id,
            'call_id': call_id,
            'decision': decision,
            'error': f'Failed to handle tool decision: {str(exec_error)}',
        }

    assistant_for_update = (
        result.get('assistant_message_id')
        or assistant_message_id
        or session.get('assistant_message_id')
    )

    status = _handle_async_domain_result(
        chat_id=chat_id,
        result=result,
        assistant_message_id=assistant_for_update,
        provider=provider,
        model=model,
        workspace_path=workspace_path,
    )

    response: Dict[str, Any] = {
        'success': result.get('error') is None,
        'chat_id': chat_id,
        'task_id': task_id,
        'call_id': call_id,
        'decision': decision,
        'status': result.get('status'),
    }

    if result.get('error'):
        response['error'] = result['error']

    # If the result completed the task, session was cleared in handler.
    # Otherwise ensure we retain latest assistant ID for future decisions.
    if status == 'waiting_user':
        _set_async_domain_session(chat_id, {'assistant_message_id': assistant_for_update})

    return response


async def _execute_async_streaming(
    chat_id: str,
    message: str,
    provider: str,
    model: str,
    include_reasoning: bool,
    attached_file_ids: List[str],
    user_message_id: int,
    is_retry: bool,
    router_result: Optional[Dict] = None,
    estimated_tokens: int = 0
):
    """
    Execute async streaming chat generation on the shared background event loop.
    """
    from route.chat_route import publish_state, publish_content

    try:
        logger.info(f"[ASYNC-EXEC] Starting async execution for chat {chat_id} with {provider}:{model}")
        logger.info(f"[UX_PERF][BACKEND] stream_init chat={chat_id} provider={provider} model={model} include_reasoning={include_reasoning}")

        # Get provider instance
        providers = get_provider_map()
        if provider not in providers:
            error_msg = f"Provider '{provider}' not found"
            logger.error(f"[ASYNC-EXEC] {error_msg}")
            publish_content(chat_id, 'error', error_msg)
            return

        provider_instance = providers[provider]
        if not provider_instance.is_available():
            error_msg = f"Provider '{provider}' not available"
            logger.error(f"[ASYNC-EXEC] {error_msg}")
            publish_content(chat_id, 'error', error_msg)
            return

        # Check if provider has async streaming method
        if not hasattr(provider_instance, 'generate_text_stream_async'):
            error_msg = f"Provider '{provider}' does not support async streaming"
            logger.error(f"[ASYNC-EXEC] {error_msg}")
            publish_content(chat_id, 'error', error_msg)
            return

        # Get chat history and prepare request
        chat_history = db.get_chat_history(chat_id)
        system_prompt = db.get_chat_system_prompt(chat_id)

        # Filter out the current user message from history
        if chat_history and chat_history[-1]["role"] == "user":
            chat_history = chat_history[:-1]

        # Resolve file attachments
        file_attachments = []
        if attached_file_ids:
            from chat.chat import Chat
            chat_obj = Chat(chat_id=chat_id)
            file_attachments = chat_obj._resolve_api_file_names(attached_file_ids, provider)

        logger.info(f"[ASYNC-EXEC] Calling async stream for {chat_id} with {len(chat_history)} history messages")

        # Check if this is a domain task requiring special handling
        domain_id = router_result.get('domain_id') if router_result else None
        route = router_result.get('route') if router_result else None

        if domain_id and route != 'direct':
            logger.info(f"[ASYNC-DOMAIN] Domain execution required: {domain_id}")

            # Check if this domain requires a workspace (currently only 'coder' does)
            workspace_path = None
            if domain_id == 'coder':
                workspace_path = _get_coder_workspace_path(chat_id)

            # If coder domain and no workspace, prompt for selection
            if domain_id == 'coder' and not workspace_path:
                    logger.info(f"[CODER_WORKSPACE][ASYNC] Prompting user to select workspace for chat {chat_id}")

                    # Set thinking state
                    db.update_chat_state(chat_id, "thinking")
                    publish_state(chat_id, "thinking")

                    # Create assistant message with prompt
                    prompt_message = (
                        "I need a workspace before I can start coding. "
                        "Please select a workspace in the Coder view to continue."
                    )

                    assistant_message_id = db.save_message(
                        chat_id,
                        "assistant",
                        prompt_message,
                        thoughts=None,
                        provider=provider,
                        model=model,
                        router_enabled=router_result is not None,
                        router_decision=json.dumps(router_result) if router_result else None
                    )

                    # Emit workspace prompt event to trigger frontend modal
                    publish_content(
                        chat_id,
                        'coder_workspace_prompt',
                        json.dumps({
                            'chat_id': chat_id,
                            'message': message,
                            'domain_id': domain_id
                        })
                    )

                    # Emit the prompt message
                    publish_content(chat_id, 'answer', prompt_message)

                    # Save pending execution state for resume after workspace selection
                    with _async_workspace_pending_lock:
                        _async_workspace_pending[chat_id] = {
                            'chat_id': chat_id,
                            'message': message,
                            'provider': provider,
                            'model': model,
                            'include_reasoning': include_reasoning,
                            'attached_file_ids': attached_file_ids,
                            'user_message_id': user_message_id,
                            'is_retry': is_retry,
                            'router_result': router_result,
                            'domain_id': domain_id,
                            'chat_history': chat_history,
                            'assistant_message_id': assistant_message_id,
                        }

                    logger.info(f"[CODER_WORKSPACE][ASYNC] Saved pending execution state for chat {chat_id}, waiting for workspace selection")

                    # Return early - execution will resume when workspace is selected
                    return

            # Execute domain task (with workspace if required)
            if domain_id == 'coder' and workspace_path:
                logger.info(f"[ASYNC-DOMAIN] Executing coder domain with workspace: {workspace_path}")
            elif domain_id == 'coder':
                # Should not reach here - workspace should be set or we returned early
                logger.error(f"[ASYNC-DOMAIN] Coder domain without workspace - this should not happen")
                return
            else:
                logger.info(f"[ASYNC-DOMAIN] Executing domain: {domain_id} (no workspace required)")

                # Send web window prompt for web domain with profile status
                if domain_id == 'web':
                    logger.info(f"[WEB_WINDOW][ASYNC] Checking browser profile status for chat {chat_id}")

                    # Check if managed browser profile exists
                    try:
                        from agents.tools.web_ops import get_profile_status
                        profile_status = get_profile_status()
                        logger.info(f"[WEB_WINDOW][ASYNC] Profile status: {profile_status['status']}")
                    except Exception as e:
                        logger.warning(f"[WEB_WINDOW][ASYNC] Error checking profile status: {e}")
                        profile_status = {
                            'exists': False,
                            'status': 'unknown',
                            'path': '',
                            'profile_name': 'google_serp'
                        }

                    logger.info(f"[WEB_WINDOW][ASYNC] Prompting frontend to switch to web view for chat {chat_id}")
                    from route.chat_route import publish_content
                    publish_content(
                        chat_id,
                        'web_window_prompt',
                        json.dumps({
                            'chat_id': chat_id,
                            'domain_id': domain_id,
                            'profile_status': profile_status,
                            'user_request': message
                        })
                    )

            # Create assistant message placeholder
            assistant_message_id = db.save_message(
                chat_id,
                "assistant",
                "",
                thoughts=None,
                provider=provider,
                model=model,
                router_enabled=router_result is not None,
                router_decision=json.dumps(router_result) if router_result else None
            )

            # Execute domain task
            await _execute_async_domain_task(
                chat_id=chat_id,
                domain_id=domain_id,
                message=message,
                chat_history=chat_history,
                attached_file_ids=attached_file_ids,
                assistant_message_id=assistant_message_id,
                workspace_path=workspace_path,  # Will be None for non-coder domains
                provider=provider,
                model=model
            )
            return

        # Set initial state
        if include_reasoning:
            db.update_chat_state(chat_id, "thinking")
            publish_state(chat_id, "thinking")
            current_state = "thinking"
        else:
            db.update_chat_state(chat_id, "responding")
            publish_state(chat_id, "responding")
            current_state = "responding"

        # Optimistically notify clients that the answer stream is about to begin
        answer_started = False
        first_chunk_logged = False
        if not include_reasoning:
            publish_content(chat_id, 'answer_start', '')
            answer_started = True
            logger.info(f"[UX_PERF][BACKEND] optimistic_answer_start chat={chat_id}")

        # Pre-create assistant message so streaming updates have a target and router metadata persists after reloads.
        assistant_message_id: Optional[str] = None
        router_enabled = router_result is not None
        router_decision_json: Optional[str] = None
        if router_result:
            router_decision_json = json.dumps({
                'route': router_result.get('route'),
                'available_routes': router_result.get('available_routes', []),
                'selected_model': router_result.get('model'),
                'selected_provider': router_result.get('provider'),
                'tools_needed': router_result.get('tools_needed'),
                'execution_type': router_result.get('execution_type'),
                'domain_id': router_result.get('domain_id'),
                'fastpath_params': router_result.get('fastpath_params'),
                'error': router_result.get('error')
            })

        assistant_message_id = db.save_message(
            chat_id,
            "assistant",
            "",
            thoughts=None,
            provider=provider,
            model=model,
            router_enabled=router_enabled,
            router_decision=router_decision_json
        )
        if assistant_message_id:
            logger.info(f"[ASYNC-EXEC] Created assistant placeholder {assistant_message_id} (router_enabled={router_enabled}) for chat {chat_id}")

            # Record version chat lineage
            try:
                if chat_id.startswith('version_'):
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
                logger.warning(f"[LINEAGE][ASYNC] Failed to record assistant lineage for {assistant_message_id}: {e}")

            # Broadcast message IDs to frontend
            if user_message_id and assistant_message_id:
                message_ids_data = {
                    "user_message_id": user_message_id,
                    "assistant_message_id": assistant_message_id
                }
                logger.debug(f"[ASYNC-EXEC] Sending message IDs for {chat_id}: user={user_message_id}, assistant={assistant_message_id}")
                publish_content(chat_id, 'message_ids', json.dumps(message_ids_data))
        else:
            logger.warning(f"[ASYNC-EXEC] Failed to pre-create assistant message for {chat_id}; router metadata may be lost on refresh")

        # Execute FastPath tool if router returned fastpath_params
        if router_result and router_result.get('fastpath_params'):
            import uuid
            unique_fastpath_id = f"fastpath_{uuid.uuid4().hex[:8]}"

            fastpath_output = _execute_fastpath_tool(
                router_result['fastpath_params'],
                chat_id,
                unique_fastpath_id
            )

            if fastpath_output:
                message = f"[SYSTEM CALLED THE RELEVANT TOOL. ANSWER USER QUERY WITH THE FOLLOWING TOOL OUTPUT:]\n\n{fastpath_output}\n\n---\n\n[USER QUERY:]\n{message}"
                logger.info(f"[FASTPATH][ASYNC] Prepended tool output to current user message")

        # Log detailed model input for debugging
        logger.info("=" * 80)
        logger.info("[MODEL INPUT] Complete prompt sent to model:")
        logger.info("=" * 80)

        if system_prompt:
            system_preview = system_prompt[:500] if len(system_prompt) > 500 else system_prompt
            if len(system_prompt) > 500:
                system_preview += f"... (truncated, total: {len(system_prompt)} chars)"
            logger.info(f"[SYSTEM PROMPT]: {system_preview}")
        else:
            logger.info("[SYSTEM PROMPT]: None")

        if chat_history:
            logger.info(f"\n[CHAT HISTORY]: {len(chat_history)} messages")
            for idx, msg in enumerate(chat_history):
                role = msg.get('role', 'unknown')
                content = msg.get('content', '')[:200]
                if len(msg.get('content', '')) > 200:
                    content += "..."
                logger.info(f"  [{idx}] {role}: {content}")
        else:
            logger.info("\n[CHAT HISTORY]: Empty")

        message_preview = message[:1500] if len(message) > 1500 else message
        if len(message) > 1500:
            message_preview += f"\n... (truncated, total: {len(message)} chars)"

        if '[SYSTEM CALLED THE RELEVANT TOOL' in message:
            logger.info(f"\n[CURRENT MESSAGE] ⚡ (includes FastPath tool output):\n{message_preview}")
        else:
            logger.info(f"\n[CURRENT MESSAGE]:\n{message_preview}")

        if file_attachments:
            logger.info(f"\n[ATTACHMENTS]: {file_attachments}")

        logger.info("=" * 80)

        # Stream the response with aegeantic retry logic
        from agentic import retry_stream, RetryConfig, RetryEvent
        from utils.provider_errors import ProviderStreamError
        # time is already imported at module level

        retry_config = RetryConfig(
            max_attempts=5,
            backoff="exponential",
            base_delay=2.0,
            max_delay=60.0,
            jitter=True,
            retry_on=(ProviderStreamError,)
        )

        full_text = ""
        full_thoughts = ""
        captured_usage_data = None
        last_update_time = 0.0
        DB_UPDATE_THROTTLE_SECONDS = 0.25
        attempt = 0

        async def create_stream():
            """Create fresh stream for each retry attempt."""
            async for chunk in provider_instance.generate_text_stream_async(
                message,
                model=model,
                include_thoughts=include_reasoning,
                chat_history=chat_history,
                file_attachments=file_attachments
            ):
                yield chunk

        try:
            async for item in retry_stream(create_stream, retry_config, operation_name=model, operation_type="llm"):
                # Handle retry events from aegeantic
                if isinstance(item, RetryEvent):
                    attempt = item.attempt
                    logger.warning(
                        f"[ASYNC-EXEC] Retry {item.attempt}/{item.max_attempts} for chat {chat_id}: "
                        f"{item.error[:100]}... (waiting {item.next_delay_seconds:.1f}s)"
                    )

                    # Emit retry event to frontend
                    publish_content(
                        chat_id,
                        'model_retry',
                        '',
                        retry_data={
                            'attempt': item.attempt,
                            'max_attempts': item.max_attempts,
                            'delay_seconds': item.next_delay_seconds,
                            'model': model,
                            'reason': 'Provider error',
                            'error_preview': item.error[:200] if len(item.error) > 200 else item.error
                        }
                    )

                    # Reset state for retry
                    full_text = ""
                    full_thoughts = ""
                    captured_usage_data = None
                    last_update_time = 0.0
                    answer_started = False
                    first_chunk_logged = False

                    # Reset chat state for retry
                    if include_reasoning:
                        db.update_chat_state(chat_id, "thinking")
                        publish_state(chat_id, "thinking")
                        current_state = "thinking"
                    else:
                        db.update_chat_state(chat_id, "responding")
                        publish_state(chat_id, "responding")
                        current_state = "responding"
                    continue

                # Process normal chunks
                chunk = item
                chunk_type = chunk.get("type")

                if not first_chunk_logged:
                    logger.info(f"[UX_PERF][BACKEND] first_chunk_received chat={chat_id} chunk_type={chunk_type} attempt={attempt + 1}")
                    first_chunk_logged = True

                if chunk_type == "thoughts_start":
                    publish_content(chat_id, 'thoughts_start', '')
                elif chunk_type == "thoughts":
                    content = chunk.get("content", "")
                    full_thoughts += content
                    publish_content(chat_id, 'thoughts', content)
                elif chunk_type == "answer_start":
                    if current_state == "thinking":
                        db.update_chat_state(chat_id, "responding")
                        publish_state(chat_id, "responding")
                        current_state = "responding"
                    if not answer_started:
                        publish_content(chat_id, 'answer_start', '')
                        answer_started = True
                elif chunk_type == "answer":
                    content = chunk.get("content", "")
                    full_text += content
                    if not answer_started:
                        if current_state == "thinking":
                            db.update_chat_state(chat_id, "responding")
                            publish_state(chat_id, "responding")
                            current_state = "responding"
                        publish_content(chat_id, 'answer_start', '')
                        answer_started = True
                    publish_content(chat_id, 'answer', content)
                elif chunk_type == "usage" or chunk_type == "usage_metadata":
                    usage_data = chunk.get("usage") or chunk.get("usage_metadata")
                    if usage_data:
                        captured_usage_data = usage_data
                        publish_content(chat_id, chunk_type, '', usage=usage_data)

                # Throttled DB update during streaming (every 0.25s)
                now = time.time()
                if assistant_message_id and (full_text or full_thoughts) and (now - last_update_time) >= DB_UPDATE_THROTTLE_SECONDS:
                    try:
                        db.update_message(
                            assistant_message_id,
                            full_text,
                            thoughts=full_thoughts if full_thoughts else None
                        )
                        last_update_time = now
                    except Exception as db_error:
                        logger.error(f"[ASYNC-EXEC] Error updating message in DB during stream: {db_error}")

        except ProviderStreamError as e:
            # Max retries exceeded - aegeantic re-raises after exhausting attempts
            logger.error(f"[ASYNC-EXEC] Giving up after {attempt + 1} attempts for chat {chat_id}: {e}")
            publish_content(chat_id, 'error', str(e))
            return

        # Check if we got content
        if not full_text and not full_thoughts:
            logger.warning(f"[ASYNC-EXEC] Streaming completed with no content for chat {chat_id}")

        # Update the assistant message in DB
        if user_message_id:
            # Find or create assistant message
            target_message_id = assistant_message_id
            if not target_message_id:
                history = db.get_chat_history(chat_id)
                for msg in reversed(history):
                    if msg.get("role") == "assistant":
                        target_message_id = msg.get("id")
                        break

            if target_message_id:
                db.update_message(
                    target_message_id,
                    full_text,
                    thoughts=full_thoughts if full_thoughts else None
                )
            else:
                db.save_message(
                    chat_id,
                    "assistant",
                    full_text,
                    thoughts=full_thoughts if full_thoughts else None,
                    provider=provider,
                    model=model,
                    router_enabled=router_enabled,
                    router_decision=router_decision_json
                )

        # Finalize rate limiting with actual token usage
        if captured_usage_data:
            try:
                # Build response-like dict for context_manager to extract tokens properly
                response_dict = {
                    'usage': captured_usage_data,
                    'usage_metadata': captured_usage_data
                }

                # Use context_manager to extract tokens (handles all provider formats)
                actual_tokens_data = context_manager.extract_actual_tokens_from_response(response_dict, provider)

                if actual_tokens_data and actual_tokens_data.get('total_tokens', 0) > 0:
                    actual_tokens_count = actual_tokens_data['total_tokens']
                    limiter = get_rate_limiter()
                    limiter.finalize_tokens(provider, model, actual_tokens_count)
                    logger.info(f"[RATE-LIMIT][ASYNC] Finalized with {actual_tokens_count} actual tokens for {provider}:{model}")

                    # Save token usage with both estimated and actual
                    db.save_token_usage(
                        chat_id=chat_id,
                        role='assistant',
                        provider=provider,
                        model=model,
                        estimated_tokens=estimated_tokens,
                        actual_tokens=actual_tokens_count,
                        message_id=assistant_message_id
                    )
                    logger.info(f"[TokenUsage][ASYNC] Saved assistant token usage for chat {chat_id}: estimated={estimated_tokens}, actual={actual_tokens_count} tokens")
                else:
                    logger.warning(f"[RATE-LIMIT][ASYNC] Could not extract token count from usage data: {captured_usage_data}")
            except Exception as finalize_error:
                logger.error(f"[RATE-LIMIT][ASYNC] Failed to finalize tokens for {chat_id}: {finalize_error}")

        # Save token usage even if we didn't get actual tokens (save estimated only)
        if not captured_usage_data or not actual_tokens_data or actual_tokens_data.get('total_tokens', 0) == 0:
            if estimated_tokens > 0:
                db.save_token_usage(
                    chat_id=chat_id,
                    role='assistant',
                    provider=provider,
                    model=model,
                    estimated_tokens=estimated_tokens,
                    actual_tokens=0,
                    message_id=assistant_message_id
                )
                logger.info(f"[TokenUsage][ASYNC] Saved assistant token usage for chat {chat_id}: estimated={estimated_tokens} tokens (no actual available)")

        # Set final state
        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        publish_content(chat_id, 'complete', '')

        logger.info(f"[ASYNC-EXEC] Completed async execution for chat {chat_id}")
        logger.info(f"[UX_PERF][BACKEND] stream_complete chat={chat_id}")

    except asyncio.CancelledError:
        # Check if this was a stop (save content) or cancel (discard content)
        with _async_stop_flags_lock:
            is_stop = _async_stop_flags.get(chat_id, False)
            _async_stop_flags.pop(chat_id, None)  # Clean up flag

        if is_stop:
            logger.info(f"[ASYNC-STOP] Async task stopped for chat {chat_id} (saving partial content)")
            # Save partial content if any was accumulated
            if assistant_message_id and (full_text or full_thoughts):
                try:
                    db.update_message(
                        assistant_message_id,
                        full_text,
                        thoughts=full_thoughts if full_thoughts else None
                    )
                    logger.info(f"[ASYNC-STOP] Saved partial content for {chat_id}: {len(full_text)} chars text, {len(full_thoughts)} chars thoughts")
                except Exception as save_error:
                    logger.error(f"[ASYNC-STOP] Failed to save partial content for {chat_id}: {save_error}")
        else:
            logger.info(f"[ASYNC-CANCEL] Async task cancelled for chat {chat_id} (discarding partial content)")
            # Don't save partial content - this was a cancel
            if assistant_message_id and (full_text or full_thoughts):
                logger.info(f"[ASYNC-CANCEL] Discarded partial content for {chat_id}: {len(full_text)} chars text, {len(full_thoughts)} chars thoughts")

        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        publish_content(chat_id, 'complete', '')
        raise
    except Exception as e:
        logger.error(f"[ASYNC-EXEC] Unexpected error in async execution for chat {chat_id}: {e}", exc_info=True)

        # Delete incomplete assistant message on error
        if assistant_message_id:
            try:
                deleted = db.cascade_delete_message(assistant_message_id, chat_id)
                logger.info(f"[ASYNC-EXEC] Removed {deleted} messages after error for {chat_id} starting at {assistant_message_id}")
            except Exception as delete_error:
                logger.warning(f"[ASYNC-EXEC] Failed to remove incomplete assistant message {assistant_message_id}: {delete_error}")

        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        publish_content(chat_id, 'error', f"Async execution error: {str(e)}")


def start_async_chat_processing(
    chat_id: str,
    message: str,
    provider: str,
    model: str,
    include_reasoning: bool,
    attached_file_ids: List[str],
    user_message_id: int,
    is_retry: bool = False,
    router_result: Optional[Dict] = None
) -> bool:
    """
    Start async chat processing on the shared asyncio loop thread.
    Returns True if started successfully, False if already running or limit exceeded.
    """
    from utils.config import Config

    # Check rate limits BEFORE acquiring lock (rate limiting may sleep/wait)
    try:
        chat_history = db.get_chat_history(chat_id)
        system_prompt = db.get_chat_system_prompt(chat_id)

        token_estimate = context_manager.estimate_request_tokens(
            role="assistant",
            provider=provider,
            model=model,
            system_prompt=system_prompt,
            chat_history=chat_history[:-1] if chat_history and chat_history[-1]["role"] == "user" else chat_history,
            current_message=message,
            file_attachments=[]
        )
        estimated_tokens = token_estimate['estimated_tokens']['total']

        limiter = get_rate_limiter()
        limiter.check_and_reserve(provider, model, estimated_tokens)

        logger.info(f"[RATE-LIMIT][ASYNC] Reserved capacity for {provider}:{model} (estimated {estimated_tokens} tokens)")
    except Exception as rate_limit_error:
        logger.error(f"[RATE-LIMIT][ASYNC] Failed to check rate limits for {chat_id}: {rate_limit_error}")
        # Continue anyway - rate limiting failures shouldn't block requests entirely

    with _async_chat_tasks_lock:
        # Check if already processing
        existing_task = _async_chat_tasks.get(chat_id)
        if existing_task and not existing_task.done():
            logger.warning(f"[ASYNC-START] Chat {chat_id} is already processing")
            return False

        # Check concurrent limit
        active_count = sum(1 for task in _async_chat_tasks.values() if not task.done())
        max_concurrent = Config.get_max_async_concurrent_chats()
        if active_count >= max_concurrent:
            logger.warning(f"[ASYNC-START] Concurrent async chat limit reached ({active_count}/{max_concurrent}), rejecting {chat_id}")

            # Publish error message to client
            from route.chat_route import publish_content, publish_state
            db.update_chat_state(chat_id, "static")
            publish_state(chat_id, "static")
            publish_content(
                chat_id,
                'error',
                f'Server is currently at maximum capacity ({max_concurrent} concurrent chats). Please try again in a moment.'
            )
            return False

        # Create the coroutine
        coro = _execute_async_streaming(
            chat_id=chat_id,
            message=message,
            provider=provider,
            model=model,
            include_reasoning=include_reasoning,
            attached_file_ids=attached_file_ids,
            user_message_id=user_message_id,
            is_retry=is_retry,
            router_result=router_result,
            estimated_tokens=estimated_tokens
        )

        future = _async_loop_manager.submit(coro)
        _async_chat_tasks[chat_id] = future

    def _future_finalizer(completed_future: concurrent.futures.Future):
        try:
            completed_future.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.debug(f"[ASYNC-START] Async task for chat {chat_id} completed with error", exc_info=True)
        finally:
            cleanup_async_chat(chat_id)

    future.add_done_callback(_future_finalizer)

    with _async_chat_tasks_lock:
        active_after = sum(1 for task in _async_chat_tasks.values() if not task.done())

    logger.info(f"[ASYNC-START] Started async processing for chat {chat_id} on persistent loop (concurrent: {active_after}/{max_concurrent})")
    return True
