"""Single Domain Executor.

This module coordinates iterative execution for a single specialized domain.
An agent produces structured tool proposals that require explicit user approval.
Upon approval the executor runs the tool, feeds results back to the agent, and
continues until the agent declares completion or the user aborts.
"""

from __future__ import annotations

import datetime
import difflib
import json
import time
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from agents.domains.domain_registry import AgentSpec, DomainSpec, domain_registry
from agents.prompts.agent_prompt_templates import (
    AGENT_RESPONSE_FORMAT,
    BASE_AGENT_PROMPT,
    get_domain_instructions,
)
from agents.tools.file_ops.file_utils import format_file_size, workspace_relative_path
from agents.tools.file_ops.diff_computer import compute_streaming_decorations, compute_diff_stats
from agents.tools.tool_registry import ToolExecutionContext, ToolResult, tool_registry
from utils.logger import get_logger
from utils.rate_limiter import get_rate_limiter
from utils.checkpoint_utils import save_file_checkpoint, cleanup_old_checkpoints
from chat.coder_stream_parser import CoderStreamParser
from utils.coder_session_logger import (
    create_coder_session_logger,
    get_coder_session_logger,
    close_coder_session_logger,
)


logger = get_logger(__name__)

TERMINAL_STATES = {"completed", "failed", "aborted"}

# Tools that execute immediately during streaming (before user approval)
AUTO_EXECUTE_TOOLS = {"file.write", "file.edit"}


@dataclass
class DomainExecutionContext:
    """Context for single domain execution."""

    chat_id: str
    domain_id: str
    agent_id: str
    task_id: str
    user_request: str
    global_context: Dict[str, Any]
    assistant_message_id: Optional[int] = None
    task_budget: Optional[Dict[str, int]] = None
    workspace_path: Optional[str] = None


@dataclass
class ActionRecord:
    """Record of an action taken during execution."""

    action_id: str
    action_type: str
    timestamp: str
    description: str
    status: str
    result: Optional[Any] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "action_id": self.action_id,
            "action_type": self.action_type,
            "timestamp": self.timestamp,
            "description": self.description,
            "status": self.status,
            "result": self.result,
            "metadata": self.metadata,
        }


@dataclass
class ToolCallProposal:
    """Pending tool call awaiting user approval."""

    call_id: str
    tool_name: str
    params: Dict[str, Any]
    param_entries: List[Tuple[str, Any]]
    reason: str
    message: str
    created_at: str
    tool_description: str
    pre_executed: bool = False  # Frontend pre-executed this tool (e.g., wrote file for preview)
    pre_execution_state: Optional[Dict[str, Any]] = None  # Snapshot captured by frontend for revert/finalization


@dataclass
class ToolExecutionRecord:
    """Executed tool call result."""

    call_id: str
    tool_name: str
    params: Dict[str, Any]
    param_entries: List[Tuple[str, Any]]
    accepted: bool
    executed_at: str
    result_summary: str
    raw_result: Any
    ops: Optional[List[Dict[str, Any]]] = None
    error: Optional[str] = None


@dataclass
class DomainTaskState:
    """Mutable state for an in-flight single domain execution."""

    context: DomainExecutionContext
    domain: DomainSpec
    agent: AgentSpec
    actions: List[ActionRecord] = field(default_factory=list)
    context_snapshots: List[Dict[str, Any]] = field(default_factory=list)
    plan: Optional[Dict[str, Any]] = None
    thinking: str = ""
    output: str = ""
    status: str = "running"
    pending_tools: List[ToolCallProposal] = field(default_factory=list)
    tool_history: List[ToolExecutionRecord] = field(default_factory=list)
    agent_message: str = ""
    last_agent_response: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)
    last_updated: str = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
    )
    event_callback: Optional[Callable[[Dict[str, Any]], None]] = None
    planning_phase_complete: bool = False


class SingleDomainExecutor:
    """Executes single domain tasks with agent-controlled tool iterations."""

    def __init__(self) -> None:
        self.logger = get_logger(__name__)
        self._active_tasks: Dict[str, DomainTaskState] = {}
        self._auto_exec_results: Dict[str, Dict[str, Any]] = {}  # Store auto-execution results: {tool_call_id: result}
        self._auto_exec_initial_states: Dict[str, Dict[str, Any]] = {}
        self._last_sent_file_content: Dict[str, str] = {}  # Track last sent content per file: {file_path: content}
        self._recently_completed_tasks: Dict[str, float] = {}  # Track recently completed tasks: {task_id: completion_time}

    def _mark_task_completed(self, task_id: str) -> None:
        """Mark a task as recently completed and remove from active tasks."""
        self._recently_completed_tasks[task_id] = time.time()
        self._active_tasks.pop(task_id, None)

        # Clean up old completed tasks (older than 30 seconds)
        cutoff = time.time() - 30
        self._recently_completed_tasks = {
            tid: t for tid, t in self._recently_completed_tasks.items() if t > cutoff
        }

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def execute_domain_task(
        self,
        domain_id: str,
        user_request: str,
        chat_id: str,
        chat_history: Optional[List[Dict]] = None,
        attached_files: Optional[List[Dict]] = None,
        task_budget: Optional[Dict[str, int]] = None,
        assistant_message_id: Optional[int] = None,
        workspace_path: Optional[str] = None,
        event_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        rate_limit_prechecked: bool = False,
    ) -> Dict[str, Any]:
        """Start executing a task within a specific domain."""

        self.logger.info("Executing domain task for %s", domain_id)

        try:
            domain = domain_registry.get(domain_id)
        except KeyError:
            error_msg = f"Domain {domain_id} is not registered"
            self.logger.error(error_msg)
            return {"error": error_msg, "domain_id": domain_id}

        if not domain.agents:
            error_msg = f"Domain {domain_id} has no agents configured"
            self.logger.error(error_msg)
            return {"error": error_msg, "domain_id": domain_id}

        agent = domain.agents[0]
        task_id = f"task_{uuid.uuid4().hex[:12]}"

        exec_context = DomainExecutionContext(
            chat_id=chat_id,
            domain_id=domain_id,
            agent_id=agent.agent_id,
            task_id=task_id,
            user_request=user_request,
            global_context=self._build_global_context(
                domain, user_request, chat_history, attached_files, workspace_path
            ),
            assistant_message_id=assistant_message_id,
            task_budget=task_budget,
            workspace_path=workspace_path,
        )

        state = DomainTaskState(
            context=exec_context,
            domain=domain,
            agent=agent,
            metadata={
                "start_time": time.time(),
                "iterations": 0,
                "tool_calls": 0,
                "rate_limit_prechecked": rate_limit_prechecked,
            },
            event_callback=event_callback,
        )

        self._append_action(
            state,
            action_type="domain_start",
            description=f"Executing in {domain.name} domain with agent {agent.name}",
            status="completed",
            metadata={
                "domain_id": domain.domain_id,
                "agent_id": agent.agent_id,
                "task_id": task_id,
            },
        )
        self._append_snapshot(
            state,
            summary="Initial context prepared",
            full_context={
                "user_request": exec_context.user_request,
                "global_context": exec_context.global_context,
            },
        )

        self._active_tasks[task_id] = state

        if domain_id == "coder":
            coder_logger = create_coder_session_logger(
                task_id=task_id,
                chat_id=chat_id,
                user_request=user_request,
                workspace_path=workspace_path
            )
            coder_logger.log_session_start(domain_id=domain_id, agent_id=agent.agent_id)

        result = self._run_agent_iteration(state, is_initial=True)
        if state.status in TERMINAL_STATES:
            self._mark_task_completed(task_id)
            # Log session end for coder tasks
            if domain_id == "coder":
                self._log_coder_session_end(state)
        return result

    def handle_tool_decision(
        self,
        task_id: str,
        call_id: str,
        decision: str,
        batch_mode: bool = True,
        pre_executed_calls: Dict[str, bool] = None,
        pre_execution_state: Dict[str, Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Process a user decision for pending tool call(s).

        Args:
            task_id: The task identifier
            call_id: The call_id being decided on (or special marker "batch_all")
            decision: "accept" or "reject"
            batch_mode: If True and multiple tools pending, accept/reject all at once
            pre_executed_calls: Map of call_id -> bool indicating which tools were pre-executed by frontend
            pre_execution_state: Map of call_id -> {tool_type, file_path, original_content} for revert
        """
        if pre_executed_calls is None:
            pre_executed_calls = {}
        if pre_execution_state is None:
            pre_execution_state = {}

        state = self._active_tasks.get(task_id)
        if not state:
            # Check if this task recently completed (within last 10 seconds)
            # This handles race conditions where frontend sends duplicate tool approvals
            completion_time = self._recently_completed_tasks.get(task_id)
            if completion_time and (time.time() - completion_time < 10):
                self.logger.info(
                    "[STALE-APPROVAL] Ignoring tool decision for recently completed task %s - "
                    "likely a duplicate request from frontend race condition",
                    task_id
                )
                return {
                    "task_id": task_id,
                    "status": "completed",
                    "message": "Task already completed, ignoring duplicate approval",
                    "stale_request": True,
                }

            error_msg = f"Task {task_id} is no longer active"
            self.logger.error(error_msg)
            return {"error": error_msg, "task_id": task_id}

        # Check if there are pending tools
        if not state.pending_tools:
            # This is a normal timing issue - tools were already approved/executed
            self.logger.info(
                "[STALE-APPROVAL] Decision for call %s arrived after task %s moved on - ignoring gracefully",
                call_id,
                task_id,
            )
            serialized_state = self._serialize_state(state)
            serialized_state.update(
                {
                    "success": True,
                    "warning": "Tool decision arrived after execution completed",
                }
            )
            return serialized_state

        # Find the tool by call_id (or use batch marker)
        if call_id == "batch_all" or (batch_mode and len(state.pending_tools) > 1):
            # Batch mode: accept/reject all pending tools
            target_tools = state.pending_tools[:]
            is_batch = True
        else:
            # Individual mode: find specific tool
            target_tools = [t for t in state.pending_tools if t.call_id == call_id]
            is_batch = False

        # Mark tools as pre-executed if frontend indicates so
        self.logger.info(f"[PRE-EXEC] Received pre_executed_calls map: {pre_executed_calls}")
        for tool in target_tools:
            # Only update pre_executed flag if explicitly provided in request
            if tool.call_id in pre_executed_calls:
                pre_exec_flag = bool(pre_executed_calls.get(tool.call_id))
                tool.pre_executed = pre_exec_flag
                self.logger.debug(f"[PRE-EXEC] Updated pre_executed flag for {tool.call_id}: {pre_exec_flag}")

            # Only overwrite pre_execution_state if request provides meaningful data
            request_state = pre_execution_state.get(tool.call_id)
            if request_state:
                self.logger.debug(f"[PRE-EXEC] Overwriting pre_execution_state for {tool.call_id} with request data")
                tool.pre_execution_state = request_state
            # else: Preserve the state attached during registration (don't overwrite with None)

            # Fallback for file operations if state is truly missing
            if tool.tool_name in {"file.write", "file.edit"}:
                if not tool.pre_executed:
                    self.logger.info(
                        "[PRE-EXEC][FALLBACK] Forcing pre-executed flag for %s (%s)",
                        tool.tool_name,
                        tool.call_id,
                    )
                    tool.pre_executed = True
                if not tool.pre_execution_state:
                    self.logger.warning(
                        "[PRE-EXEC][FALLBACK] Creating minimal pre_execution_state for %s - state was not preserved from registration",
                        tool.call_id,
                    )
                    tool.pre_execution_state = {
                        "tool_type": tool.tool_name,
                        "file_path": tool.params.get("file_path"),
                        "original_content": None,
                        "tool_params": tool.params,
                        "created_dirs": [],
                    }

            # Log the final state
            state_flag = "with state" if tool.pre_execution_state else "without state"
            self.logger.info(
                "[PRE-EXEC] Tool %s (%s) flagged=%s %s",
                tool.call_id,
                tool.tool_name,
                tool.pre_executed,
                state_flag,
            )

        if not target_tools:
            self.logger.info(
                "[STALE-APPROVAL] Decision for call %s not found in pending tools - ignoring gracefully",
                call_id,
            )
            serialized_state = self._serialize_state(state)
            serialized_state.update(
                {
                    "success": True,
                    "warning": "Tool decision arrived after tool was removed from pending list",
                }
            )
            return serialized_state

        decision_lower = decision.lower()
        if decision_lower not in {"accept", "reject"}:
            error_msg = f"Unsupported decision: {decision}"
            self.logger.error(error_msg)
            return {"error": error_msg, "task_id": task_id}

        if decision_lower == "reject":
            self._handle_rejection(state, target_tools, is_batch)
            self._mark_task_completed(task_id)
            # Log session end for coder tasks
            if state.context.domain_id == "coder":
                self._log_coder_session_end(state)
            return self._serialize_state(state)

        # Accept path
        # Note: Tool execution errors are now caught in _execute_tool_call and returned
        # as ToolResults to the agent. This try-catch only handles unexpected system errors
        # during result processing, event emission, or iteration management.
        try:
            self._handle_acceptance(state, target_tools, is_batch)
        except Exception as exc:
            self.logger.exception("Unexpected error during tool acceptance handling: %s", exc)

            # Log to coder session
            if state.context.domain_id == "coder":
                coder_logger = get_coder_session_logger(state.context.task_id)
                if coder_logger:
                    coder_logger.log_error(f"System error during tool execution: {exc}")

            self._mark_failure(state, f"System error during execution: {exc}")
            self._mark_task_completed(task_id)
            # Log session end for coder tasks
            if state.context.domain_id == "coder":
                self._log_coder_session_end(state)
            return self._serialize_state(state)

        if state.status in TERMINAL_STATES:
            self._mark_task_completed(task_id)
            # Log session end for coder tasks
            if state.context.domain_id == "coder":
                self._log_coder_session_end(state)
        return self._serialize_state(state)

    def abort_task(self, task_id: str, reason: str) -> Optional[Dict[str, Any]]:
        """Abort an active task (used when chat is cancelled)."""

        state = self._active_tasks.get(task_id)
        if not state:
            return None

        # Remove from active and track completion
        self._mark_task_completed(task_id)

        state.status = "aborted"
        state.output = reason
        self._append_action(
            state,
            action_type="domain_abort",
            description=reason,
            status="failed",
        )

        # Log session end for coder tasks
        if state.context.domain_id == "coder":
            self._log_coder_session_end(state)

        return self._serialize_state(state)

    def continue_task(self, task_id: str) -> Dict[str, Any]:
        """Continue execution after a tool execution, running the next agent iteration."""

        state = self._active_tasks.get(task_id)
        if not state:
            error_msg = f"Task {task_id} is no longer active"
            self.logger.error(error_msg)
            return {"error": error_msg, "task_id": task_id}

        if state.status != "await_continuation":
            error_msg = f"Task {task_id} is not awaiting continuation (current status: {state.status})"
            self.logger.warning(error_msg)
            return {"error": error_msg, "task_id": task_id, "status": state.status}

        try:
            self.logger.info(f"[CONTINUE] Resuming task {task_id} with next agent iteration")
            result = self._run_agent_iteration(state)
            if state.status in TERMINAL_STATES:
                self._mark_task_completed(task_id)
                # Log session end for coder tasks
                if state.context.domain_id == "coder":
                    self._log_coder_session_end(state)
            return result
        except Exception as exc:
            self.logger.exception("Error continuing task: %s", exc)

            # Log to coder session
            if state.context.domain_id == "coder":
                coder_logger = get_coder_session_logger(state.context.task_id)
                if coder_logger:
                    coder_logger.log_error(f"Error during task continuation: {exc}")

            self._mark_failure(state, f"Error during continuation: {exc}")
            self._mark_task_completed(task_id)
            # Log session end for coder tasks
            if state.context.domain_id == "coder":
                self._log_coder_session_end(state)
            return self._serialize_state(state)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _calculate_line_diff(before_text: str, after_text: str) -> Tuple[int, int]:
        """
        Calculate the number of lines added and removed between two text blobs.
        """
        before_lines = before_text.splitlines()
        after_lines = after_text.splitlines()
        matcher = difflib.SequenceMatcher(None, before_lines, after_lines)
        lines_added = 0
        lines_removed = 0
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag in ('replace', 'insert'):
                lines_added += j2 - j1
            if tag in ('replace', 'delete'):
                lines_removed += i2 - i1
        return lines_added, lines_removed

    def _run_agent_iteration(
        self,
        state: DomainTaskState,
        is_initial: bool = False,
    ) -> Dict[str, Any]:
        """Run a single agent iteration and update task state."""

        state.metadata["iterations"] = state.metadata.get("iterations", 0) + 1
        current_iteration = state.metadata["iterations"]
        state.status = "running"

        # Clean up format/parse errors that have been visible for 1 call already
        # System errors should only persist for 1 call - remove errors from 2+ iterations ago
        state.tool_history = [
            record for record in state.tool_history
            if not (record.error in ("format_error", "parse_error") and
                    self._is_old_format_error(record.call_id, current_iteration))
        ]

        # Log iteration start for coder tasks
        if state.context.domain_id == "coder":
            coder_logger = get_coder_session_logger(state.context.task_id)
            if coder_logger:
                coder_logger.log_iteration_start(state.metadata["iterations"])

        prompt = self._build_agent_prompt(state)

        # Store prompt for context dumping when tool is proposed
        state.metadata["last_agent_prompt"] = prompt

        self.logger.info("=" * 80)
        self.logger.info(
            "[DOMAIN-AGENT-PROMPT] %s/%s iteration %s",
            state.context.domain_id,
            state.context.agent_id,
            state.metadata["iterations"],
        )
        self.logger.info("=" * 80)
        self.logger.info(prompt)

        response_text = self._call_agent(state, prompt)

        self.logger.info("=" * 80)
        self.logger.info(
            "[DOMAIN-AGENT-RESPONSE] %s/%s iteration %s",
            state.context.domain_id,
            state.context.agent_id,
            state.metadata["iterations"],
        )
        self.logger.info("=" * 80)
        self.logger.info(response_text)

        parsed = self._parse_agent_response(response_text)

        # Debug logging for parsing results
        self.logger.info(f"[PARSE-DEBUG] Extracted status: '{parsed.get('status', 'NONE')}'")
        self.logger.info(f"[PARSE-DEBUG] Tool calls found: {len(parsed.get('tool_calls', []))}")

        # Extract code spec if present (planning phase for coder domain)
        if state.context.domain_id == "coder" and not state.plan:
            code_spec = self._extract_code_spec(response_text)
            if code_spec:
                state.metadata["code_spec"] = code_spec
                self.logger.info(f"[CODE-SPEC] Extracted {len(code_spec)} chars of specification")

        state.last_agent_response = response_text
        state.agent_message = parsed.get("message", "").strip() or parsed.get("raw", "").strip()
        state.pending_tools = []  # Clear any previous pending tools
        state.last_updated = datetime.datetime.now(datetime.timezone.utc).isoformat()

        # Log agent message for coder tasks
        if state.context.domain_id == "coder":
            coder_logger = get_coder_session_logger(state.context.task_id)
            if coder_logger:
                coder_logger.log_agent_message(state.agent_message)

        self._append_action(
            state,
            action_type="agent_response",
            description=state.agent_message[:400],
            status="completed",
            metadata={
                "iteration": state.metadata["iterations"],
                "status": parsed.get("status"),
            },
        )

        pending_tool_calls = parsed.get("tool_calls", [])
        status = parsed.get("status", "PARSE_ERROR").upper()

        # Handle format/parsing errors
        if status == "PARSE_ERROR":
            self.logger.error("[FORMAT-ERROR] Regex extraction failed - response format invalid")

            # Log to coder session
            if state.context.domain_id == "coder":
                coder_logger = get_coder_session_logger(state.context.task_id)
                if coder_logger:
                    coder_logger.log_error("Agent response format error - regex extraction failed. Response must include <MESSAGE>, <TOOL_CALL>, and <AGENT_STATUS> tags.")

            # Add error feedback to tool history for next iteration
            # Encode the iteration number in call_id so we can track when to clean it up
            # Error will persist for exactly 1 call (visible in iteration N+1, removed in N+2)
            format_error_record = ToolExecutionRecord(
                call_id=f"format_error_iter{state.metadata['iterations']}_{uuid.uuid4().hex[:6]}",
                tool_name="system.format_validation",
                params={},
                param_entries=[],
                accepted=False,
                executed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                result_summary="Response format error - regex extraction failed. Ensure response includes <MESSAGE>, <TOOL_CALL>, and <AGENT_STATUS> tags.",
                raw_result={},
                error="format_error",
            )
            state.tool_history.append(format_error_record)

            # Retry with error context
            self.logger.info("[FORMAT-ERROR] Running corrective iteration")
            state.status = "running"
            result = self._run_agent_iteration(state)
            return result

        if status == "AWAIT_TOOL":
            if not pending_tool_calls:
                # Agent said AWAIT_TOOL but no tools were extracted - this is a parse error!
                # This typically happens due to typos in closing tags (e.g., </TOAL_CALL> instead of </TOOL_CALL>)
                error_msg = (
                    "Agent set AGENT_STATUS=AWAIT_TOOL but no tool calls were found in response. "
                    "This indicates a parsing failure or malformed response. "
                    "Common cause: typo in closing tag (e.g., </TOAL_CALL> instead of </TOOL_CALL>). "
                    "Ensure TOOL_CALL sections have proper TOOL/REASON/PARAM tags."
                )
                self.logger.error(f"[PARSE-ERROR] {error_msg}")

                # Log to coder session
                if state.context.domain_id == "coder":
                    coder_logger = get_coder_session_logger(state.context.task_id)
                    if coder_logger:
                        coder_logger.log_error(error_msg)

                # Add error feedback to tool history for next iteration (same pattern as format error)
                parse_error_record = ToolExecutionRecord(
                    call_id=f"parse_error_iter{state.metadata['iterations']}_{uuid.uuid4().hex[:6]}",
                    tool_name="system.parse_validation",
                    params={},
                    param_entries=[],
                    accepted=False,
                    executed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    result_summary=error_msg,
                    raw_result={},
                    error="parse_error",
                )
                state.tool_history.append(parse_error_record)

                # Retry with error context (same pattern as format error)
                self.logger.info("[PARSE-ERROR] Running corrective iteration to fix malformed tool call tags")
                state.status = "running"
                result = self._run_agent_iteration(state)
                return result

            self._register_pending_tools(state, pending_tool_calls)
        elif status == "COMPLETE":
            # IMPORTANT: If agent sent COMPLETE with tool calls in the same response,
            # we must register the tools first, wait for user decisions, execute them,
            # and ONLY THEN complete. Otherwise tools get lost.
            if pending_tool_calls:
                self.logger.info(
                    "[COMPLETE-WITH-TOOLS] Agent sent COMPLETE with %d tool call(s) - "
                    "registering tools and deferring completion until after execution",
                    len(pending_tool_calls)
                )
                self._register_pending_tools(state, pending_tool_calls)
                # Mark that we should complete after all tools are decided and executed
                state.metadata["deferred_completion"] = True
                state.metadata["deferred_completion_message"] = state.agent_message
                return self._finalize_iteration_state(state)

            # No pending tools in this response, proceed with immediate completion validation
            completion_valid, rejection_reason = self._validate_completion(state)

            if not completion_valid:
                self.logger.warning(
                    "[COMPLETION-REJECTED] Agent attempted premature completion: %s",
                    rejection_reason
                )
                # Provide feedback to agent via tool history
                feedback_message = (
                    f"COMPLETION REJECTED: {rejection_reason}\n\n"
                    f"You must continue working through your plan. "
                    f"Review the EXECUTION PLAN section above and propose the next tool call "
                    f"to advance your work (use AGENT_STATUS=AWAIT_TOOL)."
                )

                # Remove previous completion rejections to avoid context bloat
                state.tool_history = [
                    record for record in state.tool_history
                    if record.error != "completion_rejected"
                ]

                # Add rejection to tool history so agent sees it in next iteration
                rejection_record = ToolExecutionRecord(
                    call_id=f"reject_{uuid.uuid4().hex[:10]}",
                    tool_name="system.completion_validation",
                    params={},
                    param_entries=[],
                    accepted=False,
                    executed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    result_summary=feedback_message,
                    raw_result={"error": rejection_reason, "feedback": feedback_message},
                    error="completion_rejected",
                )
                state.tool_history.append(rejection_record)

                # Log to coder session
                if state.context.domain_id == "coder":
                    coder_logger = get_coder_session_logger(state.context.task_id)
                    if coder_logger:
                        coder_logger.log_warning(f"Completion rejected: {rejection_reason}")

                # Log the rejection
                self._append_action(
                    state,
                    action_type="completion_rejected",
                    description=rejection_reason,
                    status="completed",
                    metadata={
                        "iteration": state.metadata["iterations"],
                        "rejection_reason": rejection_reason,
                    },
                )

                # Force agent to continue with corrected context
                self.logger.info("[COMPLETION-REJECTED] Running corrective iteration")
                state.status = "running"
                result = self._run_agent_iteration(state)
                return result

            # Completion validated - proceed normally
            state.status = "completed"
            state.output = state.agent_message
            self._append_action(
                state,
                action_type="domain_complete",
                description="Agent reported task complete",
                status="completed",
                metadata={"iteration": state.metadata["iterations"]},
            )
        else:
            # Unexpected status fallback
            state.status = "completed"
            state.output = state.agent_message
            self.logger.warning(
                "Agent returned unexpected status '%s'; treating as completion.",
                status,
            )
            self._append_action(
                state,
                action_type="domain_complete",
                description=f"Completed with fallback from status '{status}'",
                status="completed",
                metadata={"iteration": state.metadata["iterations"]},
            )

        self._append_snapshot(
            state,
            summary=f"Iteration {state.metadata['iterations']} -> {state.status.upper()}",
            full_context={
                "agent_message": state.agent_message,
                "pending_tools": [self._serialize_tool_proposal(t) for t in state.pending_tools],
                "status": state.status,
            },
        )

        return self._finalize_iteration_state(state)

    def _finalize_iteration_state(self, state: DomainTaskState) -> Dict[str, Any]:
        """Finalize iteration by snapshotting, logging, emitting state, and returning it."""
        self._append_snapshot(
            state,
            summary=f"Iteration {state.metadata['iterations']} -> {state.status.upper()}",
            full_context={
                "agent_message": state.agent_message,
                "pending_tools": [self._serialize_tool_proposal(t) for t in state.pending_tools],
                "status": state.status,
            },
        )

        # Log iteration end for coder tasks
        if state.context.domain_id == "coder":
            coder_logger = get_coder_session_logger(state.context.task_id)
            if coder_logger:
                coder_logger.log_iteration_end(state.metadata["iterations"], state.status)

        serialized_state = self._serialize_state(state)
        self._emit_event(state, "state", serialized_state)
        return serialized_state

    def _build_preexecuted_tool_result(self, state: DomainTaskState, proposal: ToolCallProposal) -> ToolResult:
        """Synthesize a ToolResult for a tool that was already executed on the frontend."""
        state_info = proposal.pre_execution_state or {}
        workspace_root = state.context.workspace_path
        if not workspace_root:
            raise RuntimeError("Workspace path unavailable for pre-executed tool finalization")

        file_path = state_info.get("file_path") or proposal.params.get("file_path")
        if not file_path:
            raise RuntimeError(f"Missing file_path for pre-executed tool {proposal.call_id}")

        full_path = (Path(workspace_root) / file_path).resolve()
        if not full_path.exists():
            raise FileNotFoundError(f"Pre-executed file not found: {file_path}")

        try:
            after_content = full_path.read_text(encoding="utf-8")
        except UnicodeDecodeError as err:
            raise ValueError(f"Cannot read pre-executed file {file_path}: {err}") from err

        before_content = state_info.get("original_content")
        relative_path = workspace_relative_path(full_path, workspace_root)
        size_bytes = full_path.stat().st_size
        size_label = format_file_size(size_bytes)

        if proposal.tool_name == "file.write":
            line_count = after_content.count("\n") + 1 if after_content else 1
            ops = [
                {
                    "type": "file_write",
                    "path": relative_path,
                    "absolute_path": str(full_path),
                    "before": before_content,
                    "after": after_content,
                    "overwrite": before_content is not None,
                    "pre_executed": True,
                }
            ]
            output = {
                "status": "success",
                "file_path": str(full_path),
                "action": "overwritten" if before_content is not None else "created",
                "metadata": {
                    "file_size": size_label,
                    "file_size_bytes": size_bytes,
                    "line_count": line_count,
                },
                "pre_executed": True,
            }
            metadata = {"file_path": str(full_path), "size_bytes": size_bytes, "pre_executed": True}
        else:
            tool_params = state_info.get("tool_params") or proposal.params
            edit_mode = tool_params.get("edit_mode")
            lines_affected: Optional[str] = None

            if edit_mode == "line_range":
                start_line = tool_params.get("start_line")
                end_line = tool_params.get("end_line") or start_line
                if start_line is not None:
                    lines_affected = f"{start_line}-{end_line}"
            elif edit_mode == "find_replace":
                find_text = tool_params.get("find_text")
                replace_all = tool_params.get("replace_all", True)
                if find_text:
                    maybe_count = before_content.count(find_text) if before_content else None
                    if maybe_count:
                        suffix = "all" if replace_all else "first"
                        lines_affected = f"{maybe_count} occurrence(s) ({suffix})"
                if not lines_affected:
                    lines_affected = "pattern replace"

            ops = [
                {
                    "type": "file_edit",
                    "path": relative_path,
                    "absolute_path": str(full_path),
                    "before": before_content,
                    "after": after_content,
                    "mode": edit_mode,
                    "pre_executed": True,
                }
            ]
            output = {
                "status": "success",
                "file_path": str(full_path),
                "edit_mode": edit_mode,
                "lines_affected": lines_affected,
                "metadata": {
                    "file_size": size_label,
                    "file_size_bytes": size_bytes,
                },
                "pre_executed": True,
            }
            metadata = {
                "file_path": str(full_path),
                "edit_mode": edit_mode,
                "pre_executed": True,
            }

        return ToolResult(output=output, metadata=metadata, ops=ops)
        return serialized_state

    def _register_pending_tools(self, state: DomainTaskState, parsed_tools: List[Dict[str, Any]]) -> None:
        """Register multiple pending tool calls."""
        iteration = state.metadata.get("iterations", 0)

        for tool_index, parsed_tool in enumerate(parsed_tools):
            tool_name = parsed_tool["tool"]
            reason = parsed_tool.get("reason", "")
            param_entries = parsed_tool.get("param_entries", [])

            if tool_name not in state.domain.tool_allowlist:
                msg = f"Tool '{tool_name}' is not allowed for domain {state.domain.domain_id}"

                # Log to coder session
                if state.context.domain_id == "coder":
                    coder_logger = get_coder_session_logger(state.context.task_id)
                    if coder_logger:
                        coder_logger.log_error(msg)

                self._mark_failure(state, msg)
                return

            try:
                tool_spec = tool_registry.get(tool_name)
                tool_description = tool_spec.description
            except KeyError:
                msg = f"Tool '{tool_name}' not found in registry"

                # Log to coder session
                if state.context.domain_id == "coder":
                    coder_logger = get_coder_session_logger(state.context.task_id)
                    if coder_logger:
                        coder_logger.log_error(msg)

                self._mark_failure(state, msg)
                return

            params = {name: value for name, value in param_entries}

            # For auto-executable tools, use consistent ID to match auto-execution results
            # For other tools, use random ID
            if tool_name in AUTO_EXECUTE_TOOLS:
                call_id = f"auto_exec_iter{iteration}_tool{tool_index}"
            else:
                call_id = f"call_{uuid.uuid4().hex[:10]}"

            # Check if this tool was auto-executed during streaming
            auto_exec_result = self._auto_exec_results.get(call_id)
            pre_executed = auto_exec_result is not None
            pre_execution_state = None

            if pre_executed:
                self.logger.info(f"[PROPOSAL] Tool {call_id} was auto-executed, attaching pre-execution state")

                # Defensive check: warn if auto-exec result is missing file_path
                file_path = auto_exec_result.get('file_path')
                if not file_path:
                    self.logger.error(f"[PROPOSAL] Auto-exec result for {call_id} missing file_path! Result keys: {list(auto_exec_result.keys())}")

                # Store pre-execution state for potential revert
                pre_execution_state = {
                    'tool_type': tool_name,
                    'file_path': file_path,
                    'original_content': auto_exec_result.get('before_content'),
                    'tool_params': params,
                    'created_dirs': auto_exec_result.get('created_dirs', []),
                }

                self.logger.debug(
                    f"[PROPOSAL] Attached state for {call_id}: file_path={file_path}, "
                    f"has_before_content={bool(auto_exec_result.get('before_content'))}, "
                    f"params_count={len(params)}"
                )

            proposal = ToolCallProposal(
                call_id=call_id,
                tool_name=tool_name,
                params=params,
                param_entries=param_entries,
                reason=reason,
                message=state.agent_message,
                created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                tool_description=tool_description,
                pre_executed=pre_executed,
                pre_execution_state=pre_execution_state,
            )
            state.pending_tools.append(proposal)

            # Clean up auto-exec result after attaching to proposal
            if pre_executed:
                del self._auto_exec_results[call_id]
                self._auto_exec_initial_states.pop(call_id, None)
                self.logger.info(f"[PROPOSAL] Cleaned up auto-exec result for {call_id}")

            # Log tool proposal for coder tasks
            if state.context.domain_id == "coder":
                coder_logger = get_coder_session_logger(state.context.task_id)
                if coder_logger:
                    coder_logger.log_tool_proposal(tool_name, param_entries, reason)

                    # Dump full agent context for first tool call only (avoid duplication)
                    if len(state.pending_tools) == 1:
                        agent_prompt = state.metadata.get("last_agent_prompt", "")
                        if agent_prompt:
                            coder_logger.dump_agent_context(agent_prompt, tool_name, param_entries)

            self._append_action(
                state,
                action_type="tool_proposal",
                description=reason or f"Proposed call to {tool_name}",
                status="pending",
                metadata={
                    "call_id": call_id,
                    "tool": tool_name,
                    "params": param_entries,
                },
            )

        # Set status to waiting_user after all tools are registered
        if state.pending_tools:
            state.status = "waiting_user"

    def _handle_rejection(self, state: DomainTaskState, proposals: List[ToolCallProposal], is_batch: bool) -> None:
        """Handle rejection of tool call(s)."""
        if not proposals:
            return

        rejection_desc = f"{'Batch' if is_batch else 'Individual'} rejection of {len(proposals)} tool(s)"
        self.logger.info(f"[TOOL-REJECTION] {rejection_desc}")

        # Revert auto-executed file operations
        for proposal in proposals:
            if proposal.tool_name in AUTO_EXECUTE_TOOLS:
                if proposal.pre_execution_state:
                    self.logger.info(
                        "[REVERT] Starting revert for auto-executed %s on %s",
                        proposal.tool_name,
                        proposal.pre_execution_state.get("file_path"),
                    )
                    revert_result = self._revert_pre_executed_file_op(state, proposal)
                    if revert_result:
                        # Emit revert event to frontend
                        self._emit_file_revert_event(state, revert_result)
                else:
                    self.logger.warning(
                        "[REVERT] Tool %s marked auto-execute but missing state snapshot",
                        proposal.call_id,
                    )

            action = self._find_action_by_call_id(state, proposal.call_id)
            if action:
                action.status = "failed"
                action.result = "User rejected tool call"

            # Log tool rejection for coder tasks
            if state.context.domain_id == "coder":
                coder_logger = get_coder_session_logger(state.context.task_id)
                if coder_logger:
                    rejection_summary = f"User rejected tool call (Proposed reason: {proposal.reason or 'none provided'})"
                    coder_logger.log_tool_execution(proposal.tool_name, False, rejection_summary)

            state.tool_history.append(
                ToolExecutionRecord(
                    call_id=proposal.call_id,
                    tool_name=proposal.tool_name,
                    params=proposal.params,
                    param_entries=proposal.param_entries,
                    accepted=False,
                    executed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    result_summary="User rejected tool call",
                    raw_result=None,
                    error="rejected",
                )
            )

        state.pending_tools = []
        state.status = "aborted"
        state.output = f"{rejection_desc}. Execution aborted."
        self._append_action(
            state,
            action_type="domain_abort",
            description=f"Execution aborted after user rejected {len(proposals)} tool call(s)",
            status="failed",
        )
        serialized_state = self._serialize_state(state)
        self._emit_event(state, "state", serialized_state)

    def _revert_pre_executed_file_op(self, state: DomainTaskState, proposal: ToolCallProposal) -> Optional[Dict[str, Any]]:
        """
        Surgically revert ONLY the tool's changes, preserving any user edits.

        Returns:
            Dict with revert metadata or None if revert failed:
            {
                'file_path': str,
                'reverted_to': 'original' | 'deleted',
                'content': str  # Reverted content (or empty if deleted)
            }
        """
        state_info = proposal.pre_execution_state or {}

        tool_type = state_info.get('tool_type') or proposal.tool_name
        file_path = state_info.get('file_path') or proposal.params.get('file_path')
        original_content = state_info.get('original_content')  # null = file didn't exist
        created_dirs_rel = state_info.get('created_dirs') or []

        if not file_path:
            self.logger.error(f"[REVERT] No file_path data available for {proposal.call_id}")
            return None

        if not state.context.workspace_path:
            self.logger.error(f"[REVERT] No workspace path available for {proposal.call_id}")
            return None

        workspace_path = Path(state.context.workspace_path)
        full_path = workspace_path / file_path
        created_dir_paths = [
            workspace_path / Path(rel_path)
            for rel_path in created_dirs_rel
            if isinstance(rel_path, str) and rel_path and rel_path != "."
        ]

        self.logger.info(f"[REVERT] Reverting pre-executed {tool_type} on {file_path}")

        try:
            # Read current file content
            current_content = None
            if full_path.exists():
                try:
                    with open(full_path, 'r', encoding='utf-8') as f:
                        current_content = f.read()
                except Exception as read_err:
                    self.logger.warning(f"[REVERT] Could not read current file {file_path}: {read_err}")
                    return

            # CASE 1: file.write - Entire file replacement
            if tool_type == 'file.write':
                if original_content is None:
                    # File didn't exist before, delete it
                    if full_path.exists():
                        self.logger.info(f"[REVERT] Deleting pre-created file: {file_path}")
                        full_path.unlink()
                        if created_dir_paths:
                            self._cleanup_created_dirs(created_dir_paths)
                        return {
                            'file_path': str(file_path),
                            'reverted_to': 'deleted',
                            'content': ''
                        }
                else:
                    # File existed, restore original
                    self.logger.info(f"[REVERT] Restoring original content (file.write cannot preserve user edits): {file_path}")
                    with open(full_path, 'w', encoding='utf-8') as f:
                        f.write(original_content)
                    return {
                        'file_path': str(file_path),
                        'reverted_to': 'original',
                        'content': original_content
                    }

            # CASE 2: file.edit - Can do surgical revert!
            elif tool_type == 'file.edit':
                # Use tool_params from state snapshot if provided, fallback to proposal.params
                tool_params = state_info.get('tool_params') or proposal.params
                edit_mode = tool_params.get('edit_mode')

                # file.edit with find_replace: Do INVERSE operation
                if edit_mode == 'find_replace':
                    find_text = tool_params.get('find_text')
                    replace_text = tool_params.get('replace_text')
                    replace_all = tool_params.get('replace_all', True)

                    if not find_text or replace_text is None:
                        self.logger.error(f"[REVERT] Missing find_text/replace_text for find_replace revert")
                        return

                    if not current_content:
                        self.logger.warning(f"[REVERT] File is empty, nothing to revert")
                        return

                    # INVERSE: Find where we replaced TO and change it back to original
                    occurrences = current_content.count(replace_text)
                    if occurrences == 0:
                        self.logger.warning(f"[REVERT] Could not find tool's replace_text '{replace_text[:50]}...' in current file")
                        # User might have edited it away, restore original as fallback
                        if original_content is not None:
                            with open(full_path, 'w', encoding='utf-8') as f:
                                f.write(original_content)
                        return

                    # Perform inverse replacement
                    if replace_all:
                        reverted_content = current_content.replace(replace_text, find_text)
                    else:
                        # Only replace first occurrence (inverse of replace first)
                        reverted_content = current_content.replace(replace_text, find_text, 1)

                    self.logger.info(f"[REVERT] Performed inverse find_replace: found {occurrences} occurrence(s), reverted to original text")
                    with open(full_path, 'w', encoding='utf-8') as f:
                        f.write(reverted_content)
                    return {
                        'file_path': str(file_path),
                        'reverted_to': 'original',
                        'content': reverted_content
                    }

                # file.edit with line_range: Restore original lines
                elif edit_mode == 'line_range':
                    start_line = tool_params.get('start_line')
                    end_line = tool_params.get('end_line')

                    if not current_content or original_content is None:
                        self.logger.warning(f"[REVERT] Cannot revert line_range without original content")
                        return

                    # Split into lines
                    current_lines = current_content.splitlines(keepends=True)
                    original_lines = original_content.splitlines(keepends=True)

                    # Validate line numbers
                    if start_line < 1 or end_line < start_line:
                        self.logger.error(f"[REVERT] Invalid line range: {start_line}-{end_line}")
                        return

                    # Extract original lines that should be restored
                    original_section = original_lines[start_line-1:end_line]

                    # Reconstruct file: before + original_section + after
                    before = current_lines[:start_line-1]
                    # Find where the edit ends in current file (might differ if user edited)
                    # For safety, use end_line from params
                    after = current_lines[end_line:]

                    reverted_lines = before + original_section + after
                    reverted_content = ''.join(reverted_lines)

                    self.logger.info(f"[REVERT] Restored original lines {start_line}-{end_line}")
                    with open(full_path, 'w', encoding='utf-8') as f:
                        f.write(reverted_content)
                    return {
                        'file_path': str(file_path),
                        'reverted_to': 'original',
                        'content': reverted_content
                    }

                else:
                    self.logger.error(f"[REVERT] Unknown edit_mode: {edit_mode}")
                    return None

        except Exception as err:
            self.logger.error(f"[REVERT] Failed to revert {file_path}: {err}", exc_info=True)
            return None

    def _handle_acceptance(self, state: DomainTaskState, proposals: List[ToolCallProposal], is_batch: bool) -> None:
        """Handle acceptance and execution of tool call(s).

        Executes all approved tools sequentially, then runs next agent iteration.
        """
        if not proposals:
            return

        execution_desc = f"{'Batch' if is_batch else 'Individual'} execution of {len(proposals)} tool(s)"
        self.logger.info(f"[TOOL-EXECUTION] {execution_desc}")

        # Execute all proposals sequentially
        for idx, proposal in enumerate(proposals):
            action = self._find_action_by_call_id(state, proposal.call_id)
            if action:
                action.status = "in_progress"

            # Emit state update immediately so frontend sees tool execution starting
            serialized_state = self._serialize_state(state)
            self._emit_event(state, "state", serialized_state)

            # For auto-execute tools, skip re-execution (already done during streaming)
            if proposal.tool_name in AUTO_EXECUTE_TOOLS:
                self.logger.info(
                    "[AUTO-EXEC] Tool %s (%s) was auto-executed during streaming, skipping re-execution",
                    proposal.tool_name,
                    proposal.call_id,
                )
                try:
                    tool_result = self._build_preexecuted_tool_result(state, proposal)
                except Exception as err:
                    self.logger.warning(
                        "[AUTO-EXEC] Failed to build synthetic result for %s (%s): %s",
                        proposal.tool_name,
                        proposal.call_id,
                        err,
                    )
                    # Return error result instead of falling back to re-execution
                    tool_result = ToolResult(
                        output={"error": f"Auto-execution result unavailable: {err}"},
                        metadata={"status": "error"}
                    )
            else:
                self.logger.info(
                    "Executing tool %d/%d: %s for task %s",
                    idx + 1,
                    len(proposals),
                    proposal.tool_name,
                    state.context.task_id,
                )
                tool_result = self._execute_tool_call(state, proposal)
            trimmed_ops = self._strip_large_fields_from_ops(tool_result.ops)
            ops_payload = self._ensure_serializable(trimmed_ops)
            result_payload = {
                "output": self._ensure_serializable(tool_result.output),
                "metadata": self._ensure_serializable(tool_result.metadata),
                "ops": ops_payload,
            }

            # Check if this tool call created a plan (for coder domain planning phase)
            if proposal.tool_name == "plan.write" and state.context.domain_id == "coder":
                self.logger.info("[PLANNING] Plan created for coder domain")
                state.planning_phase_complete = True
                # Extract plan from metadata
                if tool_result.metadata and "plan" in tool_result.metadata:
                    state.plan = tool_result.metadata["plan"]

            # Update plan if plan.update was called
            if proposal.tool_name == "plan.update" and state.context.domain_id == "coder":
                # Extract updated plan from metadata
                if tool_result.metadata and "plan" in tool_result.metadata:
                    state.plan = tool_result.metadata["plan"]

            # Create checkpoints for file operations
            self._create_checkpoints_from_ops(state, tool_result.ops, proposal.tool_name)

            summary = self._summarize_tool_output(result_payload["output"])

            # Check if there was an error in the tool result
            error = None
            if isinstance(result_payload["output"], dict) and "error" in result_payload["output"]:
                error = result_payload["output"]["error"]

            executed_record = ToolExecutionRecord(
                call_id=proposal.call_id,
                tool_name=proposal.tool_name,
                params=proposal.params,
                param_entries=proposal.param_entries,
                accepted=True,
                executed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                result_summary=summary,
                raw_result=result_payload,
                ops=ops_payload,
                error=error,
            )

            # Ensure we never store duplicate call_ids in tool_history.
            existing_record_index = next(
                (idx for idx, record in enumerate(state.tool_history) if record.call_id == proposal.call_id),
                None,
            )
            if existing_record_index is not None:
                self.logger.warning(
                    "[TOOL-HISTORY] Duplicate call_id %s detected; overwriting previous execution record",
                    proposal.call_id,
                )
                state.tool_history[existing_record_index] = executed_record
            else:
                state.tool_history.append(executed_record)
            state.metadata["tool_calls"] = state.metadata.get("tool_calls", 0) + 1

            # Log tool execution for coder tasks
            if state.context.domain_id == "coder":
                coder_logger = get_coder_session_logger(state.context.task_id)
                if coder_logger:
                    coder_logger.log_tool_execution(proposal.tool_name, True, summary, error)

            if action:
                action.status = "completed"
                action.result = result_payload

            # Emit state update immediately so frontend sees tool execution completed
            serialized_state = self._serialize_state(state)
            self._emit_event(state, "state", serialized_state)

            self._emit_event(
                state,
                "tool_execution",
                {
                    "call_id": executed_record.call_id,
                    "tool": executed_record.tool_name,
                    "params": executed_record.param_entries,
                    "result": executed_record.raw_result,
                    "ops": executed_record.ops,
                },
            )

            self._append_snapshot(
                state,
                summary=f"Executed tool {proposal.tool_name}",
                full_context={
                    "tool": proposal.tool_name,
                    "params": proposal.param_entries,
                    "result_summary": summary,
                },
            )

        # Remove only the tools that were executed from pending tools
        executed_call_ids = {p.call_id for p in proposals}
        state.pending_tools = [t for t in state.pending_tools if t.call_id not in executed_call_ids]

        # Only continue to next iteration if ALL pending tools have been decided
        # If there are still tools awaiting decisions, keep status as waiting_user
        if state.pending_tools:
            self.logger.info(
                f"[TOOL-DECISION] {len(state.pending_tools)} tool(s) still awaiting decisions - staying in waiting_user state"
            )
            state.status = "waiting_user"
            # Emit state update so frontend shows remaining pending tools
            serialized_state = self._serialize_state(state)
            self._emit_event(state, "state", serialized_state)
        else:
            self.logger.info("[TOOL-DECISION] All pending tools decided and executed")

            # Check if we deferred completion (agent sent COMPLETE with tools)
            if state.metadata.get("deferred_completion"):
                self.logger.info("[DEFERRED-COMPLETION] All tools executed, now completing as agent requested")
                state.metadata.pop("deferred_completion", None)
                deferred_message = state.metadata.pop("deferred_completion_message", None)

                # Complete the task
                state.status = "completed"
                state.output = deferred_message or state.agent_message
                self._append_action(
                    state,
                    action_type="task_completed",
                    description="Domain task completed successfully",
                    status="completed",
                    metadata={"iterations": state.metadata["iterations"]},
                )

                # Log completion for coder tasks
                if state.context.domain_id == "coder":
                    self._log_coder_session_end(state)

                # Emit final state
                serialized_state = self._serialize_state(state)
                self._emit_event(state, "state", serialized_state)
            else:
                # No deferred completion, continue with next iteration
                self.logger.info("[TOOL-DECISION] Continuing to next iteration")
                self._run_agent_iteration(state)

    def _execute_tool_call(
        self,
        state: DomainTaskState,
        proposal: ToolCallProposal,
    ) -> ToolResult:
        """Execute a tool call and return the result.

        If the tool execution fails, returns a ToolResult with error information
        so the agent can see what went wrong and make corrected calls.
        """
        try:
            tool_spec = tool_registry.get(proposal.tool_name)
            ctx = ToolExecutionContext(
                chat_id=state.context.chat_id,
                plan_id=state.context.task_id,
                task_id=state.context.task_id,
                ctx_id=state.context.task_id,  # Use task_id for persistent context across iterations
                workspace_path=state.context.workspace_path,
            )
            params = proposal.params.copy()  # Copy to avoid modifying original
            return tool_spec.fn(params, ctx)
        except Exception as exc:
            # Return error as a ToolResult so the agent can see it and retry
            error_msg = f"Tool execution failed: {str(exc)}"
            self.logger.warning(f"{error_msg} (returning to agent for correction)")
            return ToolResult(
                output={"error": error_msg, "suggestion": "Review the error and try again with corrected parameters"},
                metadata={"status": "error", "error_type": type(exc).__name__}
            )

    def _create_checkpoints_from_ops(
        self,
        state: DomainTaskState,
        ops: Optional[List[Dict[str, Any]]],
        tool_name: str,
    ) -> None:
        """
        Create file checkpoints for file operations.

        Checkpoints are created for:
        - file.write: Saves 'before' content if file was overwritten
        - file.edit: Saves 'before' content before edits
        - notebook.edit: Saves 'before' content before notebook edits
        """
        if not ops or not isinstance(ops, list):
            return

        if not state.context.workspace_path:
            self.logger.warning("[CHECKPOINT] No workspace path available, skipping checkpoint creation")
            return

        # Only create checkpoints for specific file operation tools
        checkpoint_tools = {'file.write', 'file.edit', 'notebook.edit'}
        if tool_name not in checkpoint_tools:
            return

        workspace_path = state.context.workspace_path

        for op in ops:
            if not isinstance(op, dict):
                continue

            op_type = op.get('type', '')
            file_path = op.get('path', '')

            if not file_path:
                continue

            # Only checkpoint operations that modify files
            if op_type not in ('file_write', 'file_edit', 'notebook_edit'):
                continue

            before_content = op.get('before')
            after_content = op.get('after')

            before_is_str = isinstance(before_content, str)
            after_is_str = isinstance(after_content, str)

            if before_is_str and after_is_str and before_content == after_content:
                self.logger.debug(
                    "[CHECKPOINT] Skipping checkpoint for %s (no content change detected)",
                    file_path,
                )
                continue

            before_checkpoint: Optional[Dict[str, object]] = None
            after_checkpoint: Optional[Dict[str, object]] = None
            saved_any = False

            if before_is_str or after_is_str:
                lines_added, lines_removed = self._calculate_line_diff(
                    before_content if before_is_str else "",
                    after_content if after_is_str else "",
                )
                op['lines_added'] = lines_added
                op['lines_removed'] = lines_removed
                op['linesAdded'] = lines_added
                op['linesRemoved'] = lines_removed
            else:
                op['lines_added'] = 0
                op['lines_removed'] = 0
                op['linesAdded'] = 0
                op['linesRemoved'] = 0

            try:
                if after_is_str:
                    before_checkpoint = save_file_checkpoint(
                        workspace_path=workspace_path,
                        file_path=file_path,
                        content=before_content if before_is_str else "",
                        edit_type='checkpoint',
                    )
                    if before_checkpoint:
                        if before_checkpoint.get('created'):
                            saved_any = True
                            if before_is_str:
                                self.logger.debug(
                                    "[CHECKPOINT] Captured pre-change snapshot for %s (id=%s)",
                                    file_path,
                                    before_checkpoint.get('id'),
                                )
                            else:
                                self.logger.debug(
                                    "[CHECKPOINT] Captured empty pre-change snapshot for new file %s (id=%s)",
                                    file_path,
                                    before_checkpoint.get('id'),
                                )
                        else:
                            self.logger.debug(
                                "[CHECKPOINT] Reused existing pre-change snapshot for %s (id=%s)",
                                file_path,
                                before_checkpoint.get('id'),
                            )

                if after_is_str:
                    after_checkpoint = save_file_checkpoint(
                        workspace_path=workspace_path,
                        file_path=file_path,
                        content=after_content,
                        edit_type='checkpoint',
                    )
                    if after_checkpoint:
                        if after_checkpoint.get('created'):
                            saved_any = True
                            self.logger.debug(
                                "[CHECKPOINT] Captured post-change snapshot for %s (id=%s)",
                                file_path,
                                after_checkpoint.get('id'),
                            )
                        else:
                            self.logger.debug(
                                "[CHECKPOINT] Reused existing post-change snapshot for %s (id=%s)",
                                file_path,
                                after_checkpoint.get('id'),
                            )

                if saved_any:
                    cleanup_old_checkpoints(workspace_path, file_path, keep_count=100)
            except Exception as e:
                self.logger.error(f"[CHECKPOINT] Error creating checkpoint for {file_path}: {e}")
                continue

            if before_checkpoint:
                op['before_checkpoint_id'] = before_checkpoint.get('id')
                op['before_checkpoint_created'] = bool(before_checkpoint.get('created'))
            if after_checkpoint:
                op['after_checkpoint_id'] = after_checkpoint.get('id')
                op['after_checkpoint_created'] = bool(after_checkpoint.get('created'))

            if before_checkpoint or after_checkpoint:
                op['checkpoint_created'] = {
                    "before": bool(before_checkpoint and before_checkpoint.get('created')),
                    "after": bool(after_checkpoint and after_checkpoint.get('created')),
                }
                op['checkpoint_ids'] = {
                    "before": before_checkpoint.get('id') if before_checkpoint else None,
                    "after": after_checkpoint.get('id') if after_checkpoint else None,
                }

    @staticmethod
    def _strip_large_fields_from_ops(ops: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
        """
        Remove large textual fields from ops payloads before persisting them.
        These fields are only needed for checkpointing (handled separately), so
        trimming them keeps the in-memory task history lean.
        """
        if not ops or not isinstance(ops, list):
            return []

        large_keys = {"before", "after", "diff", "patch", "content", "raw", "original_content"}
        trimmed_ops: List[Dict[str, Any]] = []
        for op in ops:
            if not isinstance(op, dict):
                continue
            trimmed_ops.append({k: v for k, v in op.items() if k not in large_keys})
        return trimmed_ops

    def _call_agent(self, state: DomainTaskState, prompt: str) -> str:
        from chat.chat import Chat  # Lazy import to avoid heavy module load at import time
        from utils.config import infer_provider_from_model
        from utils.retry_handler import RetryHandler

        agent = state.agent

        # Dynamic model selection for two-model spec-driven development (coder domain only)
        if state.context.domain_id == "coder":
            # Check if we're in planning phase (no plan exists yet)
            is_planning_phase = state.plan is None

            if is_planning_phase:
                # Use planner model (Gemini 2.5 Pro) for initial planning + spec generation
                model = getattr(agent, 'planner_model', None) or agent.model_preference or "gemini-2.5-pro"
                self.logger.info(f"[CODER-PLANNING] Using planner model: {model}")
            else:
                # Use writer model for code execution
                model = getattr(agent, 'writer_model', None) or agent.model_preference or "minimax/minimax-m2:free"
                self.logger.info(f"[CODER-EXECUTION] Using writer model: {model}")
        else:
            # Non-coder domains use existing logic
            model = agent.model_preference or "gemini-2.5-flash-preview-09-2025"

        provider = infer_provider_from_model(model)

        temp_chat = Chat(chat_id=f"domain_temp_{uuid.uuid4().hex[:8]}")
        retry_handler = RetryHandler(max_retries=5)

        attempt = 0

        include_reasoning = state.context.domain_id == "coder"

        while True:
            limiter = get_rate_limiter()
            if state.metadata.get("rate_limit_prechecked"):
                state.metadata["rate_limit_prechecked"] = False
                self.logger.debug(
                    "[RATE-LIMIT][DOMAIN] Using existing reservation for %s:%s (attempt=%s)",
                    provider,
                    model,
                    attempt + 1,
                )
            else:
                try:
                    limiter.check_and_reserve(provider, model, estimated_tokens=0)
                    self.logger.info(
                        "[RATE-LIMIT][DOMAIN] Reserved capacity for %s:%s (attempt=%s)",
                        provider,
                        model,
                        attempt + 1,
                    )
                except Exception as rate_error:
                    self.logger.error(
                        "[RATE-LIMIT][DOMAIN] Failed to reserve capacity for %s:%s: %s",
                        provider,
                        model,
                        rate_error,
                    )

            full_text = ""
            error_message = None
            parser: Optional[CoderStreamParser] = None

            try:
                if include_reasoning and state.event_callback:
                    # Create auto-execution callback that wraps the _auto_execute_streaming_tool method
                    def auto_exec_callback(tool_name: str, params: Dict[str, Any], tool_call_id: str) -> None:
                        result = self._auto_execute_streaming_tool(state, tool_name, params, tool_call_id)
                        if result:
                            # Store result for later matching with proposal
                            self._auto_exec_results[tool_call_id] = result
                            # Emit file operation event to frontend
                            self._emit_file_operation_event(state, result)

                    parser = CoderStreamParser(
                        iteration=state.metadata.get("iterations", 0),
                        emitter=lambda payload: self._emit_coder_stream_event(state, payload),
                        auto_exec_callback=auto_exec_callback,
                    )

                for chunk in temp_chat.generate_text_stream(
                    message=prompt,
                    provider=provider,
                    model=model,
                    include_reasoning=include_reasoning,
                    use_router=False,
                ):
                    chunk_type = chunk.get("type")
                    if chunk_type == "error":
                        error_message = chunk.get("content", "Unknown error")
                        break
                    elif chunk_type == "thoughts":
                        content = chunk.get("content", "")
                        if parser:
                            parser.handle_thoughts(content)
                    elif chunk_type == "answer":
                        content = chunk.get("content", "")
                        full_text += content
                        if parser:
                            parser.feed_answer(content)
                    # Ignore other chunk types like "usage" for streaming UI

                if parser:
                    parser.finalize()

                # Success - return result
                if full_text.strip():
                    return full_text

                # Handle error from chunk
                if error_message:
                    # Check if retryable
                    event_context = {
                        "task_id": state.context.task_id,
                        "domain_id": state.context.domain_id,
                    }
                    should_retry, delay = retry_handler.should_retry(
                        error_message,
                        attempt,
                        logger_instance=self.logger,
                        event_callback=state.event_callback,
                        event_context=event_context,
                        model=model
                    )

                    if should_retry:
                        attempt += 1
                        retry_handler.sleep_with_logging(delay, self.logger)
                        continue  # Retry
                    else:
                        # Not retryable or max retries exceeded
                        raise RuntimeError(error_message)

            except Exception as e:
                if parser:
                    parser.finalize()
                error_str = str(e)

                # Check if retryable
                event_context = {
                    "task_id": state.context.task_id,
                    "domain_id": state.context.domain_id,
                }
                should_retry, delay = retry_handler.should_retry(
                    error_str,
                    attempt,
                    logger_instance=self.logger,
                    event_callback=state.event_callback,
                    event_context=event_context,
                    model=model
                )

                if should_retry:
                    attempt += 1
                    retry_handler.sleep_with_logging(delay, self.logger)
                    continue  # Retry
                else:
                    # Not retryable or max retries exceeded
                    raise RuntimeError(f"Error during streaming text generation: {e}")

            # No error and no success - shouldn't happen but handle it
            return ""

    def _build_agent_prompt(self, state: DomainTaskState) -> str:
        domain = state.domain
        agent = state.agent
        exec_context = state.context

        # For coder domain, use phase-specific instructions based on plan existence
        if domain.domain_id == "coder":
            from agents.prompts.domain_instructions.coder import (
                get_planning_phase_instructions,
                get_execution_phase_instructions,
            )
            if state.plan:
                domain_instructions = get_execution_phase_instructions()

                # Inject code spec if available
                code_spec = state.metadata.get("code_spec")
                if code_spec:
                    code_spec_section = f"""
## CODE SPECIFICATION

The planner generated this comprehensive specification to guide your implementation:

```json
{code_spec}
```

**How to Use This Spec:**
- Use it as guidance for what features to build
- It lists comprehensive requirements to combat laziness
- You can adapt and improve as you discover better approaches
- Don't feel rigidly bound - leverage your coding expertise
- Follow the general direction while optimizing implementation

"""
                else:
                    code_spec_section = ""

                # Replace placeholder in execution instructions
                domain_instructions = domain_instructions.replace(
                    "{code_spec_section}",
                    code_spec_section
                )
            else:
                domain_instructions = get_planning_phase_instructions()
        else:
            domain_instructions = get_domain_instructions(domain.domain_id)

        tool_descriptions = self._format_tool_allowlist(domain.tool_allowlist)

        budget_info = (
            f"Max tool calls: {agent.default_budget.max_tool_calls}, "
            f"Max iterations: {agent.default_budget.max_iterations}, "
            f"Max time: {agent.default_budget.max_time_seconds}s"
        )

        chat_history_section = self._format_chat_history(
            exec_context.global_context.get("chat_history")
        )
        attached_files_section = self._format_attached_files(
            exec_context.global_context.get("attached_files")
        )
        # Procedures disabled - to implement later
        procedures_section = ""
        tool_history_section = self._format_tool_history(state.tool_history)
        task_notes_section = self._format_task_notes(state)
        plan_status_section = self._format_plan_status(state)

        prompt = BASE_AGENT_PROMPT.format(
            domain_specific_instructions=domain_instructions,
            tool_descriptions=tool_descriptions,
            domain_id=domain.domain_id,
            agent_id=agent.agent_id,
            execution_mode=agent.execution_mode.value,
            budget_info=budget_info,
            iteration=state.metadata.get("iterations", 0) + 1,
            user_request=exec_context.user_request,
            chat_history_section=chat_history_section,
            attached_files_section=attached_files_section,
            procedures_section=procedures_section,
            tool_history_section=tool_history_section,
            task_notes_section=task_notes_section,
            plan_status_section=plan_status_section,
            response_format=AGENT_RESPONSE_FORMAT,
        )

        prompt = re.sub(r'\n{3,}', '\n\n', prompt)

        return prompt

    # ------------------------------------------------------------------
    # Formatting helpers
    # ------------------------------------------------------------------
    def _format_tool_allowlist(self, tool_names: List[str]) -> str:
        """
        Format tool allowlist with comprehensive parameter information.
        Shows complete schema including types, defaults, descriptions, and enums.
        """
        if not tool_names:
            return "No tools available."

        lines: List[str] = []
        for name in tool_names:
            try:
                spec = tool_registry.get(name)
                lines.append(f"\n{spec.name}:")
                lines.append(f"  Description: {spec.description}")

                # Format parameters if schema exists
                if spec.in_schema and "properties" in spec.in_schema:
                    required_params = spec.in_schema.get("required", [])
                    properties = spec.in_schema.get("properties", {})

                    if not properties:
                        lines.append("  Parameters: None")
                    else:
                        # Separate required and optional params
                        req_props = {k: v for k, v in properties.items() if k in required_params}
                        opt_props = {k: v for k, v in properties.items() if k not in required_params}

                        # Format required parameters
                        if req_props:
                            lines.append("  Required Parameters:")
                            for param_name, param_spec in req_props.items():
                                param_line = self._format_parameter(param_name, param_spec, required=True)
                                lines.append(f"    {param_line}")

                        # Format optional parameters
                        if opt_props:
                            lines.append("  Optional Parameters:")
                            for param_name, param_spec in opt_props.items():
                                param_line = self._format_parameter(param_name, param_spec, required=False)
                                lines.append(f"    {param_line}")
                else:
                    lines.append("  Parameters: No schema defined")

            except KeyError:
                lines.append(f"- {name}: [unregistered tool]")

        return "\n".join(lines)

    def _format_parameter(self, name: str, spec: Dict[str, Any], required: bool) -> str:
        """
        Format a single parameter with type, default, description, and enum values.

        Examples:
        - file_path (string, required): Path to file
        - timeout (integer, default: 30): Maximum execution time in seconds
        - edit_mode (string, required, enum: find_replace|insert|delete): Edit operation type
        """
        parts = [name]

        # Extract type information
        param_type = spec.get("type")
        if isinstance(param_type, list):
            # Handle type arrays like ["string", "array"]
            param_type = "|".join(str(t) for t in param_type)
        elif not param_type:
            param_type = "any"

        type_str = str(param_type)

        # Check for enums
        enum_values = spec.get("enum")
        if enum_values:
            enum_str = "|".join(str(v) for v in enum_values)
            type_str = f"{type_str}, enum: {enum_str}"

        # Check for default value
        default = spec.get("default")
        if default is not None:
            if isinstance(default, str):
                default_str = f'"{default}"'
            else:
                default_str = str(default)
            type_str = f"{type_str}, default: {default_str}"
        elif not required:
            type_str = f"{type_str}, optional"

        parts.append(f"({type_str})")

        # Add description
        description = spec.get("description", "")
        if description:
            parts.append(f": {description}")

        return " ".join(parts)


    def _format_chat_history(self, chat_history: Optional[List[Dict]]) -> str:
        if not chat_history:
            return ""
        # Show all chat history (no limit on messages or content length)
        lines = ["## CHAT HISTORY:"]
        for msg in chat_history:
            role = msg.get("role", "unknown")
            content = str(msg.get("content", ""))
            lines.append(f"{role.upper()}: {content}")
        return "\n".join(lines)

    def _format_attached_files(self, attached_files: Optional[List[Dict]]) -> str:
        if not attached_files:
            return ""
        lines = ["## ATTACHED FILES:"]
        for file_info in attached_files:
            name = file_info.get("name") or file_info.get("id") or "unnamed"
            lines.append(f"- {name}")
        return "\n".join(lines)

    def _format_procedures(self, domain: DomainSpec) -> str:
        if not domain.procedures:
            return ""
        lines = ["## AVAILABLE PROCEDURES:"]
        for proc in domain.procedures[:5]:
            lines.append(f"- {proc.name}: {proc.description}")
        return "\n".join(lines)

    def _format_tool_history(self, history: List[ToolExecutionRecord]) -> str:
        """
        Format tool history with smart duplicate detection for file operations.
        Shows file content only when it's new or changed (based on content hash).
        """
        if not history:
            return ""
        lines = ["## TOOL HISTORY:"]

        # Track content hashes we've already shown in this history section
        shown_hashes = set()

        # Show ALL tool calls with smart formatting (no limit)
        for record in history:
            # Show all parameters (no limit)
            params_preview = ", ".join(f"{k}={v!r}" for k, v in record.param_entries)
            status = "ACCEPTED" if record.accepted else "REJECTED"

            # For file.read, use smart duplicate detection based on content hash
            if record.tool_name == "file.read" and record.accepted:
                lines.append(f"\n[{status}] {record.tool_name}({params_preview})")

                # Check for error first
                if record.error:
                    lines.append(f"  ✗ ERROR: {record.error}")
                    continue

                # Success path - show file content with deduplication
                output = record.raw_result.get("output", {}) if record.raw_result else {}
                if isinstance(output, dict):
                    file_path = output.get("file_path", "unknown")
                    line_count = output.get("metadata", {}).get("line_count", 0)
                    file_size = output.get("metadata", {}).get("file_size", "unknown")
                    content_hash = output.get("content_hash", "")
                    content_with_lines = output.get("content_with_line_numbers")

                    lines.append(f"  File: {file_path} ({line_count} lines, {file_size})")

                    # Only show content if hash is new (not shown before in this history)
                    if content_hash and content_hash in shown_hashes:
                        # Same content already shown - just reference it
                        lines.append(f"  → File content unchanged from previous read (hash: {content_hash})")
                        lines.append(f"  → File content is already available in the context above")
                    elif content_hash:
                        # New or changed content - show it
                        shown_hashes.add(content_hash)
                        if content_with_lines:
                            lines.append(f"  Content:\n{content_with_lines}")
                        else:
                            content = output.get("content", "")
                            if content:
                                lines.append(f"  Content:\n{content}")
                            else:
                                lines.append(f"  Result: {record.result_summary}")
                    else:
                        # No hash available (old format) - show content as before
                        if content_with_lines:
                            lines.append(f"  Content:\n{content_with_lines}")
                        else:
                            content = output.get("content", "")
                            if content:
                                lines.append(f"  Content:\n{content}")
                            else:
                                lines.append(f"  Result: {record.result_summary}")
                else:
                    lines.append(f"- [{status}] {record.tool_name}({params_preview}) -> {record.result_summary}")

            # For file.edit, show what was changed or error if failed
            elif record.tool_name == "file.edit" and record.accepted:
                lines.append(f"- [{status}] {record.tool_name}({params_preview})")

                # Check for error first - this is critical for agent to see failures!
                if record.error:
                    lines.append(f"    ✗ ERROR: {record.error}")
                    lines.append(f"    → Review the error and retry with corrected parameters")
                elif record.raw_result:
                    output = record.raw_result.get("output", {})
                    if isinstance(output, dict):
                        file_path = output.get("file_path", "unknown")
                        edit_mode = output.get("edit_mode", "unknown")
                        lines_affected = output.get("lines_affected") or output.get("replacements_made", "N/A")
                        lines.append(f"    ✓ Edited {file_path} ({edit_mode} mode, affected: {lines_affected})")
                    else:
                        lines.append(f"    → {record.result_summary}")
                else:
                    lines.append(f"    → {record.result_summary}")

            # For other tools, show compact summary (with error if present)
            else:
                if record.error:
                    # Tool failed - show error prominently so agent can see and fix it
                    lines.append(f"- [{status}] {record.tool_name}({params_preview})")
                    lines.append(f"    ✗ ERROR: {record.error}")
                else:
                    lines.append(f"- [{status}] {record.tool_name}({params_preview}) -> {record.result_summary}")

        return "\n".join(lines)

    def _format_task_notes(self, state: DomainTaskState) -> str:
        notes: List[str] = []
        if state.pending_tools:
            notes.append(f"## PENDING APPROVAL ({len(state.pending_tools)} tool(s)):")
            for idx, tool in enumerate(state.pending_tools, 1):
                params_preview = ", ".join(
                    f"{name}={value}" for name, value in tool.param_entries
                )
                notes.append(
                    f"\n{idx}. Tool: {tool.tool_name}\n"
                    f"   Reason: {tool.reason}\n"
                    f"   Params: {params_preview}"
                )
        return "\n".join(notes)

    def _format_plan_status(self, state: DomainTaskState) -> str:
        """Show plan in XML-like structured format (router style) for robust extraction."""
        if state.context.domain_id != "coder":
            return ""

        # No plan yet - show creation instruction
        if not state.plan:
            iteration = state.metadata.get("iterations", 0)
            if iteration == 0:
                return "\n## PLANNING REQUIRED\nNo execution plan exists. Use plan.write tool to create structured plan."
            return ""

        plan = state.plan
        steps = plan.get("steps", [])
        if not steps:
            return ""

        # Format plan as XML-like structure
        lines = ["## EXECUTION PLAN"]
        lines.append(f"<PLAN_TASK>{plan.get('task_description', 'No description')}</PLAN_TASK>")

        completed = sum(1 for s in steps if s.get("status") == "completed")
        lines.append(f"<PLAN_PROGRESS>{completed}/{len(steps)}</PLAN_PROGRESS>\n")

        # Show only non-completed steps for efficiency
        for step in steps:
            status = step.get("status", "pending")
            if status == "completed":
                continue

            step_id = step.get("step_id", "?")
            desc = step.get("description", "")

            lines.append(f"<STEP id=\"{step_id}\" status=\"{status}\">")
            lines.append(f"  {desc}")
            lines.append("</STEP>")

        if completed == len(steps):
            lines.append("\n<PLAN_STATUS>all_complete</PLAN_STATUS>")

        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Utility helpers
    # ------------------------------------------------------------------
    def _is_old_format_error(self, call_id: str, current_iteration: int) -> bool:
        """Check if a format_error or parse_error record is old enough to be cleaned up.

        System error records should persist for exactly 1 call:
        - Added in iteration N
        - Visible in iteration N+1
        - Removed in iteration N+2

        Args:
            call_id: The call_id containing encoded iteration number (format: format_error_iterN_xxx or parse_error_iterN_xxx)
            current_iteration: The current iteration number

        Returns:
            True if the error is from 2+ iterations ago and should be removed
        """
        import re

        # Extract iteration number from call_id (handles both format_error and parse_error)
        match = re.search(r'(format_error|parse_error)_iter(\d+)', call_id)
        if match:
            error_iteration = int(match.group(2))
            # Remove errors from 2+ iterations ago (current - error >= 2)
            return current_iteration - error_iteration >= 2

        # If we can't parse the iteration, don't delete (safety fallback)
        return False

    def _parse_agent_response(self, response_text: str) -> Dict[str, Any]:
        """
        Parse agent response extracting MESSAGE, TOOL_CALL sections, and AGENT_STATUS.

        Tags are extracted independently without requiring nested structure.
        """
        import re

        parsed: Dict[str, Any] = {
            "message": "",
            "raw": response_text,
            "status": "PARSE_ERROR",
            "tool_call": None,
            "format_valid": False,
        }

        try:
            # Extract AGENT_STATUS
            status_match = re.search(
                r"<AGENT_STATUS>(.*?)</AGENT_STATUS>",
                response_text,
                re.DOTALL | re.IGNORECASE
            )

            # Extract TOOL_CALL sections
            tool_section_matches = re.findall(
                r"<TOOL_CALL>(.*?)</TOOL_CALL>",
                response_text,
                re.DOTALL | re.IGNORECASE
            )

            # Extract MESSAGE
            message_match = re.search(
                r"<MESSAGE>(.*?)</MESSAGE>",
                response_text,
                re.DOTALL | re.IGNORECASE
            )

            if message_match:
                parsed["message"] = message_match.group(1).strip()
            else:
                # Extract text before first XML-like tag as message
                first_tag_match = re.search(r"<\w+", response_text)
                if first_tag_match:
                    plain_text = response_text[:first_tag_match.start()].strip()
                    if plain_text:
                        parsed["message"] = plain_text
                else:
                    parsed["message"] = response_text.strip()

            # Parse TOOL_CALL sections
            tool_calls = []
            for tool_section in tool_section_matches:
                tool_name_match = re.search(
                    r"<TOOL>(.*?)</TOOL>",
                    tool_section,
                    re.DOTALL | re.IGNORECASE
                )
                reason_match = re.search(
                    r"<REASON>(.*?)</REASON>",
                    tool_section,
                    re.DOTALL | re.IGNORECASE
                )
                param_matches = re.findall(
                    r"<PARAM\s+name=\"([^\"]+)\">(.*?)</PARAM>",
                    tool_section,
                    re.DOTALL | re.IGNORECASE
                )

                if tool_name_match:
                    tool_name = tool_name_match.group(1).strip()
                    param_entries: List[Tuple[str, Any]] = []
                    for param_name, raw_value in param_matches:
                        # Don't strip - preserve literal whitespace as per format spec
                        param_entries.append((param_name, self._normalise_param_value(raw_value, tool_name, param_name)))

                    tool_calls.append({
                        "tool": tool_name,
                        "reason": reason_match.group(1).strip() if reason_match else "",
                        "param_entries": param_entries,
                    })

            # Determine status
            if status_match:
                # Explicit status found
                parsed["status"] = status_match.group(1).strip().upper()
                parsed["format_valid"] = True
            elif tool_calls:
                # Tool calls found but no status - infer AWAIT_TOOL
                self.logger.info("[PARSE] Found tool calls without status - inferring AWAIT_TOOL")
                parsed["status"] = "AWAIT_TOOL"
                parsed["format_valid"] = True
            else:
                # No status and no tool calls - cannot parse
                self.logger.warning("[PARSE-ERROR] No status or tool calls found in response")
                return parsed

            parsed["tool_calls"] = tool_calls
            parsed["tool_call"] = tool_calls[0] if tool_calls else None

            self.logger.debug(
                "[PARSE] Extracted: status=%s, tool_calls=%d, message_length=%d",
                parsed["status"],
                len(tool_calls),
                len(parsed["message"])
            )

        except Exception as exc:
            self.logger.warning(f"[PARSE-ERROR] Parse exception: {exc}")

        return parsed

    def _append_action(
        self,
        state: DomainTaskState,
        action_type: str,
        description: str,
        status: str,
        metadata: Optional[Dict[str, Any]] = None,
        result: Any = None,
    ) -> ActionRecord:
        action = ActionRecord(
            action_id=f"action_{uuid.uuid4().hex[:10]}",
            action_type=action_type,
            timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            description=description,
            status=status,
            metadata=metadata or {},
            result=result,
        )
        state.actions.append(action)
        return action

    def _append_snapshot(
        self,
        state: DomainTaskState,
        summary: str,
        full_context: Optional[Dict[str, Any]] = None,
    ) -> None:
        snapshot = {
            "snapshot_id": f"ctx_{uuid.uuid4().hex[:10]}",
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "context_size": len(state.last_agent_response),
            "summary": summary,
            "full_context": full_context or {},
        }
        state.context_snapshots.append(snapshot)
        if len(state.context_snapshots) > 20:
            state.context_snapshots = state.context_snapshots[-20:]

    def _emit_coder_stream_event(
        self,
        state: "DomainTaskState",
        payload: Dict[str, Any],
    ) -> None:
        if not state.event_callback:
            return

        # Log what we're emitting
        segment = payload.get("segment", "unknown")
        action = payload.get("action", "unknown")
        extra_info = ""
        if segment == "tool_call" and action == "field":
            extra_info = f" field={payload.get('field')}"
        elif segment == "tool_call" and action == "param":
            param_name = payload.get('name', '')
            param_value = payload.get('value', '')
            extra_info = f" param={param_name}:{len(str(param_value))}b"

        try:
            state.event_callback(
                {
                    "event": "coder_stream",
                    "task_id": state.context.task_id,
                    "domain_id": state.context.domain_id,
                    "payload": payload,
                    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                }
            )
        except Exception as exc:
            self.logger.error(
                "Failed to emit coder_stream event for task %s: %s",
                state.context.task_id,
                exc,
            )

    def _emit_file_operation_event(
        self,
        state: "DomainTaskState",
        result: Dict[str, Any],
    ) -> None:
        """
        Emit a file operation event to the frontend with diff decorations.
        Uses delta encoding when possible to reduce network traffic.

        Args:
            state: Current domain execution state
            result: Auto-execution result containing decorations, metadata, delta_info, etc.
        """
        if not state.event_callback:
            return

        try:
            payload = {
                "tool_call_id": result.get("tool_call_id"),
                "operation": "streaming_write" if result.get("operation_type") == "new" else "streaming_edit",
                "file_path": result.get("file_path"),
                "file_existed": result.get("file_existed"),
                "decorations": result.get("decorations", []),
                "metadata": result.get("metadata", {}),
            }

            # Add content based on delta_info
            delta_info = result.get("delta_info")
            if delta_info:
                if delta_info["type"] == "append":
                    # Send delta alongside full content for backward compatibility
                    payload["update_type"] = "delta"
                    payload["delta"] = delta_info["delta"]
                    payload["offset"] = delta_info["offset"]
                    payload["content"] = result.get("after_content")
                else:
                    # Send full content
                    payload["update_type"] = "full"
                    payload["content"] = delta_info["content"]
            else:
                # No delta info (first update) - send full content
                payload["update_type"] = "full"
                payload["content"] = result.get("after_content")

            state.event_callback(
                {
                    "event": "coder_file_operation",
                    "task_id": state.context.task_id,
                    "domain_id": state.context.domain_id,
                    "payload": payload,
                    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                }
            )
        except Exception as exc:
            self.logger.error(
                "Failed to emit file operation event for task %s: %s",
                state.context.task_id,
                exc,
            )

    def _emit_file_revert_event(
        self,
        state: "DomainTaskState",
        result: Dict[str, Any],
    ) -> None:
        """
        Emit a file revert event to the frontend.

        Args:
            state: Current domain execution state
            result: Revert result containing file_path, reverted_to, content
        """
        if not state.event_callback:
            return

        try:
            self.logger.info(
                f"[FILE-REVERT-EMIT] Emitting file revert event for {result.get('file_path')}"
            )

            state.event_callback(
                {
                    "event": "coder_file_revert",
                    "task_id": state.context.task_id,
                    "domain_id": state.context.domain_id,
                    "payload": {
                        "file_path": result.get("file_path"),
                        "reverted_to": result.get("reverted_to"),
                        "content": result.get("content"),
                    },
                    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                }
            )
        except Exception as exc:
            self.logger.error(
                "Failed to emit file revert event for task %s: %s",
                state.context.task_id,
                exc,
            )

    def _emit_event(
        self,
        state: DomainTaskState,
        event: str,
        payload: Dict[str, Any],
    ) -> None:
        if not state.event_callback:
            return

        try:
            state.event_callback(
                {
                    "event": event,
                    "task_id": state.context.task_id,
                    "domain_id": state.context.domain_id,
                    "payload": payload,
                    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                }
            )
        except Exception as exc:  
            self.logger.error(
                "Failed to emit %s event for task %s: %s",
                event,
                state.context.task_id,
                exc,
            )

    def _create_missing_parent_dirs(self, workspace_path: Path, target_dir: Path) -> List[Path]:
        """
        Create any missing parent directories for a target file path.

        Returns a list of directories that were actually created (shallow → deep order).
        """
        created: List[Path] = []

        # Nothing to do if the parent already exists or target is the workspace root
        if target_dir.exists() or target_dir == workspace_path:
            return created

        dirs_to_create: List[Path] = []
        current = target_dir

        # Walk up until we reach an existing directory or the workspace root
        while current != workspace_path and not current.exists():
            dirs_to_create.append(current)
            current = current.parent

        for directory in reversed(dirs_to_create):
            directory.mkdir(exist_ok=True)
            created.append(directory)
            self.logger.debug(
                "[AUTO-EXEC] Created parent directory for streaming write: %s",
                workspace_relative_path(directory, str(workspace_path)),
            )

        return created

    def _cleanup_created_dirs(self, directories: List[Path]) -> None:
        """
        Remove any empty directories that were created temporarily during auto execution.
        """
        for directory in reversed(directories):
            try:
                if directory.exists():
                    if any(directory.iterdir()):
                        # Directory now contains other files (perhaps user added something) – leave it alone.
                        continue
                    directory.rmdir()
                    self.logger.debug(
                        "[AUTO-EXEC] Removed empty directory created during streaming write: %s",
                        directory.as_posix(),
                    )
            except Exception as cleanup_err:
                self.logger.warning(
                    "[AUTO-EXEC] Failed to clean up directory %s: %s",
                    directory,
                    cleanup_err,
                )

    def _auto_execute_streaming_tool(
        self,
        state: DomainTaskState,
        tool_name: str,
        params: Dict[str, Any],
        tool_call_id: str,
    ) -> Optional[Dict[str, Any]]:
        """
        Auto-execute file operations during streaming (before user approval).

        Args:
            state: Current domain execution state
            tool_name: Name of the tool (file.write or file.edit)
            params: Tool parameters
            tool_call_id: Unique tool call identifier

        Returns:
            Dict with execution metadata or None if execution failed:
            {
                'before_content': str | None,  # None if file didn't exist
                'after_content': str,
                'file_existed': bool,
                'decorations': [...],  # Monaco decoration specs
                'operation_type': 'new' | 'edit',
                'file_path': str,
                'metadata': {...}
            }
        """
        if tool_name not in AUTO_EXECUTE_TOOLS:
            self.logger.warning(f"[AUTO-EXEC] Tool {tool_name} is not auto-executable")
            return None

        if not state.context.workspace_path:
            self.logger.error(f"[AUTO-EXEC] No workspace path available for {tool_call_id}")
            return None

        created_dir_paths: List[Path] = []

        try:
            workspace_path = Path(state.context.workspace_path).resolve()
            workspace_path.mkdir(parents=True, exist_ok=True)
            file_path = params.get("file_path")
            if not file_path:
                self.logger.error(f"[AUTO-EXEC] No file_path in params for {tool_call_id}")
                return None

            raw_path = Path(file_path)
            if raw_path.is_absolute():
                candidate_path = raw_path.resolve()
            else:
                candidate_path = (workspace_path / raw_path).resolve()

            try:
                relative_path = candidate_path.relative_to(workspace_path)
            except ValueError:
                self.logger.error(f"[AUTO-EXEC] Refusing to write outside workspace: {raw_path}")
                return None

            full_path = candidate_path
            file_path = relative_path.as_posix()
            params["file_path"] = file_path

            # Capture before-state
            before_content = None
            file_existed = full_path.exists()

            if file_existed:
                try:
                    before_content = full_path.read_text(encoding="utf-8")
                except UnicodeDecodeError:
                    self.logger.error(f"[AUTO-EXEC] Cannot auto-execute on binary file: {file_path}")
                    return None

            # Execute the tool
            if tool_name == "file.write":
                content = params.get("content", "")

                # Always ensure parent directories exist because the frontend no longer pre-creates them.
                parent_dir = full_path.parent
                if parent_dir.exists() and not parent_dir.is_dir():
                    parent_rel = workspace_relative_path(parent_dir, str(workspace_path))
                    self.logger.error(
                        "[AUTO-EXEC] Cannot auto-execute file.write because parent path is a file: %s",
                        parent_rel,
                    )
                    return None

                created_dir_paths = self._create_missing_parent_dirs(workspace_path, parent_dir)
                parent_dir.mkdir(parents=True, exist_ok=True)

                # Write file
                try:
                    full_path.write_text(content, encoding="utf-8")
                except Exception:
                    # Clean up any directories we created before bubbling up the error
                    self._cleanup_created_dirs(created_dir_paths)
                    raise

                after_content = content

            elif tool_name == "file.edit":
                edit_mode = params.get("edit_mode")

                if not file_existed:
                    self.logger.error(f"[AUTO-EXEC] Cannot edit non-existent file: {file_path}")
                    return None

                if edit_mode == "find_replace":
                    find_text = params.get("find_text", "")
                    replace_text = params.get("replace_text", "")
                    use_regex = params.get("use_regex", False)
                    replace_all = params.get("replace_all", True)

                    if not before_content:
                        self.logger.error(f"[AUTO-EXEC] No content to edit in {file_path}")
                        return None

                    if use_regex:
                        import re
                        try:
                            if replace_all:
                                after_content = re.sub(find_text, replace_text, before_content)
                            else:
                                after_content = re.sub(find_text, replace_text, before_content, count=1)
                        except re.error as e:
                            self.logger.error(f"[AUTO-EXEC] Regex error: {e}")
                            return None
                    else:
                        if replace_all:
                            after_content = before_content.replace(find_text, replace_text)
                        else:
                            after_content = before_content.replace(find_text, replace_text, 1)

                    full_path.write_text(after_content, encoding="utf-8")
                    self.logger.info(f"[AUTO-EXEC] Applied find_replace to {file_path}")

                elif edit_mode == "line_range":
                    start_line = params.get("start_line")
                    end_line = params.get("end_line", start_line)
                    new_content = params.get("new_content", "")

                    if not before_content:
                        self.logger.error(f"[AUTO-EXEC] No content to edit in {file_path}")
                        return None

                    lines = before_content.splitlines(keepends=True)
                    # Replace lines (1-indexed)
                    before_section = lines[:start_line - 1]
                    after_section = lines[end_line:]
                    new_lines = new_content.splitlines(keepends=True) if new_content else []

                    after_content = ''.join(before_section + new_lines + after_section)
                    full_path.write_text(after_content, encoding="utf-8")
                    self.logger.info(f"[AUTO-EXEC] Replaced lines {start_line}-{end_line} in {file_path}")

                else:
                    self.logger.error(f"[AUTO-EXEC] Unknown edit_mode: {edit_mode}")
                    return None
            else:
                self.logger.error(f"[AUTO-EXEC] Unsupported tool: {tool_name}")
                return None

            initial_state = self._auto_exec_initial_states.get(tool_call_id)
            relative_created_dirs: List[str] = []
            if not initial_state:
                relative_created_dirs = [
                    workspace_relative_path(path, state.context.workspace_path)
                    for path in created_dir_paths
                ]
                initial_state = {
                    "before_content": before_content,
                    "file_existed": file_existed,
                    "created_dirs": relative_created_dirs,
                }
                self._auto_exec_initial_states[tool_call_id] = initial_state
            else:
                if created_dir_paths:
                    new_dirs = [
                        workspace_relative_path(path, state.context.workspace_path)
                        for path in created_dir_paths
                    ]
                    existing_dirs = initial_state.setdefault("created_dirs", [])
                    for rel_dir in new_dirs:
                        if rel_dir not in existing_dirs:
                            existing_dirs.append(rel_dir)
                relative_created_dirs = initial_state.get("created_dirs", [])

            base_before_content = initial_state.get("before_content")
            base_file_existed = initial_state.get("file_existed", file_existed)

            lines_added, lines_removed = compute_diff_stats(base_before_content, after_content)

            operation_type = "new" if not base_file_existed else "edit"

            # Build result metadata
            file_size = full_path.stat().st_size
            file_size_label = format_file_size(file_size)

            # Compute delta for streaming optimization
            workspace_prefix = state.context.workspace_path or ""
            file_key = f"{workspace_prefix}:{file_path}"
            last_sent_content = self._last_sent_file_content.get(file_key, "")
            delta_info = None

            if len(after_content) > len(last_sent_content):
                # Check if append-only (common case)
                if after_content.startswith(last_sent_content):
                    delta = after_content[len(last_sent_content):]
                    delta_info = {
                        "type": "append",
                        "delta": delta,
                        "offset": len(last_sent_content),
                    }
                else:
                    # Not append-only - send full content with flag
                    delta_info = {
                        "type": "full",
                        "content": after_content,
                    }
            elif after_content != last_sent_content:
                # Content changed but not growing (edit case) - send full
                delta_info = {
                    "type": "full",
                    "content": after_content,
                }

            # Update tracking
            self._last_sent_file_content[file_key] = after_content

            # Compute decorations - use incremental computation for append-only deltas
            if delta_info and delta_info["type"] == "append":
                # Incremental decoration computation (avoids O(n²) difflib for large files)
                content_before = after_content[:delta_info["offset"]]

                if not after_content:
                    decorations = []
                else:
                    total_lines = len(after_content.splitlines())

                    if content_before and content_before.endswith('\n'):
                        # Starting on a new line
                        lines_before = len(content_before.splitlines())
                        start_line = lines_before + 1
                    elif content_before:
                        # Continuing current line
                        lines_before = len(content_before.splitlines())
                        start_line = lines_before
                    else:
                        # No content before, starting on line 1
                        start_line = 1

                    end_line = total_lines

                    decorations = [
                        {
                            "startLine": line_num,
                            "endLine": line_num,
                            "startColumn": 1,
                            "endColumn": 1,
                            "type": "add",
                            "className": "streaming-diff__line-add",
                        }
                        for line_num in range(start_line, end_line + 1)
                    ]
            else:
                # Fall back to full diff computation for non-append cases
                decorations = compute_streaming_decorations(
                    tool_name=tool_name,
                    params=params,
                    before_content=base_before_content,
                    after_content=after_content,
                )

            result = {
                "before_content": base_before_content,
                "after_content": after_content,
                "file_existed": base_file_existed,
                "decorations": decorations,
                "operation_type": operation_type,
                "file_path": str(file_path),
                "tool_call_id": tool_call_id,
                "delta_info": delta_info,  # Add delta information
                "metadata": {
                    "file_size": file_size_label,
                    "file_size_bytes": file_size,
                    "lines_added": lines_added,
                    "lines_removed": lines_removed,
                },
            }

            result["created_dirs"] = list(initial_state.get("created_dirs", []))

            return result

        except Exception as exc:
            if created_dir_paths:
                self._cleanup_created_dirs(created_dir_paths)
            self._auto_exec_initial_states.pop(tool_call_id, None)
            self.logger.error(f"[AUTO-EXEC] Failed to execute {tool_name} on {file_path}: {exc}", exc_info=True)
            return None

    def _serialize_state(self, state: DomainTaskState) -> Dict[str, Any]:
        elapsed = time.time() - state.metadata.get("start_time", time.time())

        # Determine current model for frontend display
        current_model = None
        if state.context.domain_id == "coder":
            agent = state.agent
            is_planning_phase = state.plan is None
            if is_planning_phase:
                current_model = getattr(agent, 'planner_model', None) or agent.model_preference or "gemini-2.5-pro"
            else:
                current_model = getattr(agent, 'writer_model', None) or agent.model_preference or "cerebras/qwen-3-235b-a22b-thinking-2507"
        else:
            current_model = state.agent.model_preference

        # Deduplicate tool history records by call_id while preserving latest data.
        deduped_history: List[ToolExecutionRecord] = []
        seen_call_ids: Set[str] = set()
        for record in reversed(state.tool_history):
            if not record.call_id:
                continue
            if record.call_id in seen_call_ids:
                continue
            seen_call_ids.add(record.call_id)
            deduped_history.append(record)
        deduped_history.reverse()

        return {
            "task_id": state.context.task_id,
            "domain_id": state.context.domain_id,
            "agent_id": state.context.agent_id,
            "status": state.status,
            "agent_message": state.agent_message,
            "output": state.output,
            "pending_tools": [self._serialize_tool_proposal(t) for t in state.pending_tools],
            "actions": [action.to_dict() for action in state.actions],
            "context_snapshots": state.context_snapshots,
            "plan": state.plan,
            "tool_history": [
                self._build_tool_history_entry(record)
                for record in deduped_history
            ],
            "metadata": {
                "iterations": state.metadata.get("iterations", 0),
                "tool_calls": state.metadata.get("tool_calls", 0),
                "elapsed_seconds": elapsed,
                "current_model": current_model,
            },
            "assistant_message_id": state.context.assistant_message_id,
        }

    def _serialize_tool_proposal(
        self, proposal: Optional[ToolCallProposal]
    ) -> Optional[Dict[str, Any]]:
        if not proposal:
            return None
        return {
            "call_id": proposal.call_id,
            "tool": proposal.tool_name,
            "params": proposal.param_entries,
            "reason": proposal.reason,
            "message": proposal.message,
            "created_at": proposal.created_at,
            "tool_description": proposal.tool_description,
        }

    def _build_tool_history_entry(self, record: ToolExecutionRecord) -> Dict[str, Any]:
        preview_result = self._make_tool_result_preview(record.raw_result)
        return {
            "call_id": record.call_id,
            "tool": record.tool_name,
            "params": record.param_entries,
            "accepted": record.accepted,
            "executed_at": record.executed_at,
            "result_summary": record.result_summary,
            "raw_result": preview_result,
            "ops": record.ops,
            "error": record.error,
        }

    def _make_tool_result_preview(self, raw_result: Any) -> Any:
        if not isinstance(raw_result, dict):
            return raw_result

        preview: Dict[str, Any] = {}

        output = raw_result.get("output")
        if isinstance(output, dict):
            preview_output = {
                key: output.get(key)
                for key in (
                    "status",
                    "file_path",
                    "action",
                    "edit_mode",
                    "lines_affected",
                    "metadata",
                )
                if key in output
            }
            if preview_output:
                preview["output"] = preview_output

        metadata = raw_result.get("metadata")
        if metadata:
            preview["metadata"] = metadata

        error = raw_result.get("error")
        if error:
            preview["error"] = error

        return preview

    def _ensure_serializable(self, value: Any) -> Any:
        if value is None:
            return None
        try:
            json.dumps(value)
            return value
        except (TypeError, ValueError):
            if isinstance(value, dict):
                return {self._ensure_serializable(k): self._ensure_serializable(v) for k, v in value.items()}
            if isinstance(value, (list, tuple, set)):
                return [self._ensure_serializable(v) for v in value]
            if isinstance(value, bytes):
                return value.decode("utf-8", errors="replace")
            return str(value)

    def _normalise_param_value(self, value: str, tool_name: str, param_name: str) -> Any:
        """Parse parameter value based on tool schema.

        Uses tool's schema to determine if parameter should be:
        - Kept as literal string (for "type": "string" parameters like file.write content)
        - Parsed as nested tags (for "type": "object" or "array" parameters like plan.update updates)

        This respects the design principle: tags are regex delimiters, content is literal.
        Parsing only happens when the tool's schema explicitly expects structured data.
        """
        # Look up tool schema to determine expected parameter type
        tool_spec = tool_registry.get(tool_name)
        expected_type = "string"  # Default to string (literal extraction)

        if tool_spec and tool_spec.in_schema:
            properties = tool_spec.in_schema.get("properties", {})
            param_schema = properties.get(param_name, {})
            expected_type = param_schema.get("type", "string")

        # If parameter expects string type, return literally (preserve whitespace)
        if expected_type == "string":
            return value

        # For non-string types, strip whitespace before parsing
        stripped = value.strip()
        if not stripped:
            return ""

        # If parameter expects integer, parse as int
        if expected_type == "integer":
            try:
                return int(stripped)
            except (ValueError, TypeError):
                raise ValueError(f"Parameter '{param_name}' expects an integer, but got: '{stripped}'")

        # If parameter expects number (float), parse as float
        if expected_type == "number":
            try:
                return float(stripped)
            except (ValueError, TypeError):
                raise ValueError(f"Parameter '{param_name}' expects a number, but got: '{stripped}'")

        # If parameter expects boolean, parse as bool
        if expected_type == "boolean":
            lower = stripped.lower()
            if lower in ("true", "1", "yes"):
                return True
            elif lower in ("false", "0", "no"):
                return False
            else:
                raise ValueError(f"Parameter '{param_name}' expects a boolean (true/false), but got: '{stripped}'")

        # If parameter expects object/array, try to parse nested tag format
        if expected_type in ("object", "array"):
            # Try nested tag format first (preferred for structured data)
            if stripped.startswith('<') and stripped.endswith('>'):
                try:
                    parsed = self._parse_nested_tags(stripped)
                    return parsed
                except Exception:
                    pass  # Fall through to other formats

            # Try JSON format (backward compatibility)
            try:
                return json.loads(stripped)
            except (json.JSONDecodeError, TypeError):
                pass

            # Try Python literal_eval (backward compatibility for Python dict syntax)
            try:
                import ast
                return ast.literal_eval(stripped)
            except (ValueError, SyntaxError):
                pass

        # Fallback: return as plain string
        return stripped

    def _extract_code_spec(self, response_text: str) -> Optional[str]:
        """Extract code spec from <CODE_SPEC>...</CODE_SPEC> tags.

        Used during planning phase to extract the detailed specification
        that will guide the writer model during execution phase.
        """
        import re
        match = re.search(
            r"<CODE_SPEC>(.*?)</CODE_SPEC>",
            response_text,
            re.DOTALL | re.IGNORECASE
        )
        if match:
            return match.group(1).strip()
        return None

    def _parse_nested_tags(self, content: str) -> Any:
        """Parse nested tag format into Python objects.

        Conventions:
          - <item> tags = array elements (anonymous)
          - Other named tags = object properties (with keys)

        Examples:
          <item>value</item> → "value" (single item, unwrapped)
          <item>val1</item><item>val2</item> → ["val1", "val2"] (multiple items = array)
          <key1>val1</key1><key2>val2</key2> → {"key1": "val1", "key2": "val2"} (object)
          <update_steps><item>x</item></update_steps> → {"update_steps": ["x"]}
        """
        import re

        content = content.strip()

        # Find all top-level tags
        tag_pattern = r'<([^/>]+)>(.*?)</\1>'
        matches = list(re.finditer(tag_pattern, content, re.DOTALL))

        if not matches:
            # No tags found, return as string
            return content

        # Check if all tags are <item> tags (array elements)
        tag_names = [m.group(1) for m in matches]
        if all(name == 'item' for name in tag_names):
            # All <item> tags → array
            parsed_items = [self._parse_nested_tags(m.group(2).strip()) for m in matches]
            # If only one item, unwrap it (unless it's explicitly an array context)
            if len(parsed_items) == 1 and not content.strip().startswith('<item>'):
                return parsed_items[0]
            return parsed_items

        # Named tags → object
        result = {}
        for match in matches:
            tag_name = match.group(1)
            tag_content = match.group(2).strip()
            result[tag_name] = self._parse_nested_tags(tag_content)

        return result

    def _summarize_tool_output(self, output: Any) -> str:
        """
        Create smart summaries for tool outputs.
        For file operations, show metadata instead of truncated content.
        """
        if output is None:
            return "Tool returned no output."

        # Smart summarization for file operations
        if isinstance(output, dict):
            status = output.get("status")

            # file.read summary
            if "content" in output and "file_path" in output:
                file_path = output.get("file_path", "unknown")
                metadata = output.get("metadata", {})
                line_count = metadata.get("line_count", 0)
                file_size = metadata.get("file_size", "unknown")
                return f"Successfully read {file_path} ({line_count} lines, {file_size})"

            # file.edit summary
            if "edit_mode" in output:
                file_path = output.get("file_path", "unknown")
                edit_mode = output.get("edit_mode", "unknown")
                lines_affected = output.get("lines_affected") or output.get("replacements_made", "N/A")
                return f"Successfully edited {file_path} ({edit_mode} mode, affected: {lines_affected})"

            # file.write summary
            if "file_path" in output and status == "success" and "content" not in output:
                file_path = output.get("file_path", "unknown")
                return f"Successfully wrote to {file_path}"

            # Generic dict/list fallback
            try:
                serialized = json.dumps(output)
            except TypeError:
                serialized = str(output)

            # Return full serialized output (no truncation)
            return serialized

        # Non-dict output - return full output (no truncation)
        serialized = str(output)
        return serialized

    def _validate_completion(self, state: DomainTaskState) -> Tuple[bool, str]:
        """Validate that completion is justified.

        Returns:
            Tuple[bool, str]: (is_valid, rejection_reason)
                - (True, "") if completion is valid
                - (False, "reason") if completion should be rejected

        Note: This is only called when COMPLETE status arrives WITHOUT tool calls.
        If COMPLETE arrives WITH tool calls, we defer completion until tools are executed.
        """
        # Only validate coder domain
        if state.context.domain_id != "coder":
            return (True, "")

        # Check if any actual work was done (prevent "zero work" completions)
        tool_calls_made = state.metadata.get("tool_calls", 0)

        if tool_calls_made == 0:
            # No tools executed - this is premature completion
            rejection_reason = (
                "No tools have been executed yet. You must use tools to do actual work.\n"
                "Review your plan and propose the next tool call to begin implementation."
            )
            return (False, rejection_reason)

        # Some work was done - trust agent's judgment about completion
        # The plan is guidance; agent can adapt as needed
        self.logger.info(
            "[COMPLETION-VALIDATED] %d tool calls executed, allowing completion",
            tool_calls_made
        )
        return (True, "")

    def _mark_failure(self, state: DomainTaskState, message: str) -> None:
        self.logger.error("Domain execution failure: %s", message)
        state.status = "failed"
        state.output = message
        self._append_action(
            state,
            action_type="domain_failure",
            description=message,
            status="failed",
        )
        state.pending_tools = []

    def _find_action_by_call_id(
        self, state: DomainTaskState, call_id: str
    ) -> Optional[ActionRecord]:
        for action in reversed(state.actions):
            if action.metadata.get("call_id") == call_id:
                return action
        return None

    def _build_global_context(
        self,
        domain: DomainSpec,
        user_request: str,
        chat_history: Optional[List[Dict]],
        attached_files: Optional[List[Dict]],
        workspace_path: Optional[str],
    ) -> Dict[str, Any]:
        context: Dict[str, Any] = {}

        if "user_request" in domain.global_context_allowlist:
            context["user_request"] = user_request

        if "chat_history" in domain.global_context_allowlist and chat_history:
            context["chat_history"] = chat_history

        if "attached_files" in domain.global_context_allowlist and attached_files:
            context["attached_files"] = attached_files

        if (
            "workspace_path" in domain.global_context_allowlist
            and workspace_path
        ):
            context["workspace_path"] = workspace_path

        return context

    def _log_coder_session_end(self, state: DomainTaskState) -> None:
        """Log the end of a coder session with summary statistics."""
        coder_logger = get_coder_session_logger(state.context.task_id)
        if coder_logger:
            coder_logger.log_session_end(
                final_status=state.status,
                total_iterations=state.metadata.get("iterations", 0),
                total_tool_calls=state.metadata.get("tool_calls", 0),
                output_message=state.output or state.agent_message
            )
            # Close the logger after session ends
            close_coder_session_logger(state.context.task_id)

    # ------------------------------------------------------------------
    # Domain metadata helpers
    # ------------------------------------------------------------------
    def get_available_tools_for_domain(self, domain_id: str) -> List[str]:
        """Get list of available tools for a domain."""
        try:
            domain = domain_registry.get(domain_id)
            available_tools = []
            for tool_name in domain.tool_allowlist:
                try:
                    tool_registry.get(tool_name)
                    available_tools.append(tool_name)
                except KeyError:
                    self.logger.warning(
                        "Tool %s in domain %s allowlist not found in registry",
                        tool_name,
                        domain_id,
                    )
            return available_tools
        except KeyError:
            return []

    def get_domain_procedures(
        self, domain_id: str, tags: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """Get procedures for a domain, optionally filtered by tags."""
        try:
            domain = domain_registry.get(domain_id)
            if tags:
                procedures = domain.search_procedures(tags)
            else:
                procedures = domain.procedures
            return [proc.to_dict() for proc in procedures]
        except KeyError:
            return []


single_domain_executor = SingleDomainExecutor()
