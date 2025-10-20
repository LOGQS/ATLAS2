"""Single Domain Executor.

This module coordinates iterative execution for a single specialized domain.
An agent produces structured tool proposals that require explicit user approval.
Upon approval the executor runs the tool, feeds results back to the agent, and
continues until the agent declares completion or the user aborts.
"""

from __future__ import annotations

import datetime
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from agents.domains.domain_registry import AgentSpec, DomainSpec, domain_registry
from agents.prompts.agent_prompt_templates import (
    AGENT_RESPONSE_FORMAT,
    BASE_AGENT_PROMPT,
    get_domain_instructions,
)
from agents.tools.tool_registry import ToolExecutionContext, ToolResult, tool_registry
from utils.logger import get_logger


logger = get_logger(__name__)

TERMINAL_STATES = {"completed", "failed", "aborted"}


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
    pending_tool: Optional[ToolCallProposal] = None
    tool_history: List[ToolExecutionRecord] = field(default_factory=list)
    agent_message: str = ""
    last_agent_response: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)
    last_updated: str = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
    )
    event_callback: Optional[Callable[[Dict[str, Any]], None]] = None


class SingleDomainExecutor:
    """Executes single domain tasks with agent-controlled tool iterations."""

    def __init__(self) -> None:
        self.logger = get_logger(__name__)
        self._active_tasks: Dict[str, DomainTaskState] = {}

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

        result = self._run_agent_iteration(state, is_initial=True)
        if state.status in TERMINAL_STATES:
            self._active_tasks.pop(task_id, None)
        return result

    def handle_tool_decision(
        self,
        task_id: str,
        call_id: str,
        decision: str,
    ) -> Dict[str, Any]:
        """Process a user decision for a pending tool call."""

        state = self._active_tasks.get(task_id)
        if not state:
            error_msg = f"Task {task_id} is no longer active"
            self.logger.error(error_msg)
            return {"error": error_msg, "task_id": task_id}

        if not state.pending_tool or state.pending_tool.call_id != call_id:
            # This is a normal timing issue - tool was already approved/executed
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

        decision_lower = decision.lower()
        if decision_lower not in {"accept", "reject"}:
            error_msg = f"Unsupported decision: {decision}"
            self.logger.error(error_msg)
            return {"error": error_msg, "task_id": task_id}

        if decision_lower == "reject":
            self._handle_rejection(state)
            self._active_tasks.pop(task_id, None)
            return self._serialize_state(state)

        # Accept path
        # Note: Tool execution errors are now caught in _execute_tool_call and returned
        # as ToolResults to the agent. This try-catch only handles unexpected system errors
        # during result processing, event emission, or iteration management.
        try:
            self._handle_acceptance(state)
        except Exception as exc:
            self.logger.exception("Unexpected error during tool acceptance handling: %s", exc)
            self._mark_failure(state, f"System error during execution: {exc}")
            self._active_tasks.pop(task_id, None)
            return self._serialize_state(state)

        if state.status in TERMINAL_STATES:
            self._active_tasks.pop(task_id, None)
        return self._serialize_state(state)

    def abort_task(self, task_id: str, reason: str) -> Optional[Dict[str, Any]]:
        """Abort an active task (used when chat is cancelled)."""

        state = self._active_tasks.pop(task_id, None)
        if not state:
            return None

        state.status = "aborted"
        state.output = reason
        self._append_action(
            state,
            action_type="domain_abort",
            description=reason,
            status="failed",
        )
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
                self._active_tasks.pop(task_id, None)
            return result
        except Exception as exc:
            self.logger.exception("Error continuing task: %s", exc)
            self._mark_failure(state, f"Error during continuation: {exc}")
            self._active_tasks.pop(task_id, None)
            return self._serialize_state(state)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _run_agent_iteration(
        self,
        state: DomainTaskState,
        is_initial: bool = False,
    ) -> Dict[str, Any]:
        """Run a single agent iteration and update task state."""

        state.metadata["iterations"] = state.metadata.get("iterations", 0) + 1
        state.status = "running"

        prompt = self._build_agent_prompt(state)

        self.logger.info("=" * 80)
        self.logger.info(
            "[DOMAIN-AGENT-PROMPT] %s/%s iteration %s",
            state.context.domain_id,
            state.context.agent_id,
            state.metadata["iterations"],
        )
        self.logger.info("=" * 80)
        self.logger.info(prompt)

        response_text = self._call_agent(state.agent, prompt)

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
        state.last_agent_response = response_text
        state.agent_message = parsed.get("message", "").strip() or parsed.get("raw", "").strip()
        state.pending_tool = None
        state.last_updated = datetime.datetime.now(datetime.timezone.utc).isoformat()

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

        pending_tool = parsed.get("tool_call")
        status = parsed.get("status", "COMPLETE").upper()

        if status == "AWAIT_TOOL" and pending_tool:
            self._register_pending_tool(state, pending_tool)
        elif status == "COMPLETE":
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
                "pending_tool": self._serialize_tool_proposal(state.pending_tool),
                "status": state.status,
            },
        )

        serialized_state = self._serialize_state(state)
        self._emit_event(state, "state", serialized_state)
        return serialized_state

    def _register_pending_tool(self, state: DomainTaskState, parsed_tool: Dict[str, Any]) -> None:
        tool_name = parsed_tool["tool"]
        reason = parsed_tool.get("reason", "")
        param_entries = parsed_tool.get("param_entries", [])

        if tool_name not in state.domain.tool_allowlist:
            msg = f"Tool '{tool_name}' is not allowed for domain {state.domain.domain_id}"
            self._mark_failure(state, msg)
            return

        try:
            tool_spec = tool_registry.get(tool_name)
            tool_description = tool_spec.description
        except KeyError:
            msg = f"Tool '{tool_name}' not found in registry"
            self._mark_failure(state, msg)
            return

        params = {name: value for name, value in param_entries}
        call_id = f"call_{uuid.uuid4().hex[:10]}"
        proposal = ToolCallProposal(
            call_id=call_id,
            tool_name=tool_name,
            params=params,
            param_entries=param_entries,
            reason=reason,
            message=state.agent_message,
            created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            tool_description=tool_description,
        )
        state.pending_tool = proposal
        state.status = "waiting_user"
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

    def _handle_rejection(self, state: DomainTaskState) -> None:
        proposal = state.pending_tool
        if not proposal:
            return

        action = self._find_action_by_call_id(state, proposal.call_id)
        if action:
            action.status = "failed"
            action.result = "User rejected tool call"

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
        state.pending_tool = None
        state.status = "aborted"
        state.output = "Tool call rejected by user. Execution aborted."
        self._append_action(
            state,
            action_type="domain_abort",
            description="Execution aborted after user rejected tool call",
            status="failed",
        )
        serialized_state = self._serialize_state(state)
        self._emit_event(state, "state", serialized_state)

    def _handle_acceptance(self, state: DomainTaskState) -> None:
        proposal = state.pending_tool
        if not proposal:
            return

        action = self._find_action_by_call_id(state, proposal.call_id)
        if action:
            action.status = "in_progress"

        self.logger.info(
            "Executing tool %s for task %s",
            proposal.tool_name,
            state.context.task_id,
        )

        tool_result = self._execute_tool_call(state, proposal)
        result_payload = {
            "output": self._ensure_serializable(tool_result.output),
            "metadata": self._ensure_serializable(tool_result.metadata),
            "ops": self._ensure_serializable(tool_result.ops),
        }

        summary = self._summarize_tool_output(result_payload["output"])
        executed_record = ToolExecutionRecord(
            call_id=proposal.call_id,
            tool_name=proposal.tool_name,
            params=proposal.params,
            param_entries=proposal.param_entries,
            accepted=True,
            executed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            result_summary=summary,
            raw_result=result_payload,
        )
        state.tool_history.append(executed_record)
        state.metadata["tool_calls"] = state.metadata.get("tool_calls", 0) + 1

        if action:
            action.status = "completed"
            action.result = result_payload

        state.pending_tool = None

        self._emit_event(
            state,
            "tool_execution",
            {
                "call_id": executed_record.call_id,
                "tool": executed_record.tool_name,
                "params": executed_record.param_entries,
                "result": executed_record.raw_result,
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

        # Continue with next iteration - agent needs tool output for next decision
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
                ctx_id=f"ctx_{uuid.uuid4().hex[:10]}",
                workspace_path=state.context.workspace_path,
            )
            params = proposal.params
            return tool_spec.fn(params, ctx)
        except Exception as exc:
            # Return error as a ToolResult so the agent can see it and retry
            error_msg = f"Tool execution failed: {str(exc)}"
            self.logger.warning(f"{error_msg} (returning to agent for correction)")
            return ToolResult(
                output={"error": error_msg, "suggestion": "Review the error and try again with corrected parameters"},
                metadata={"status": "error", "error_type": type(exc).__name__}
            )

    def _call_agent(self, agent: AgentSpec, prompt: str) -> str:
        from chat.chat import Chat  # Lazy import to avoid heavy module load at import time

        temp_chat = Chat(chat_id=f"domain_temp_{uuid.uuid4().hex[:8]}")
        response = temp_chat.generate_text(
            message=prompt,
            provider="gemini",
            model=agent.model_preference or "gemini-2.5-flash",
            include_reasoning=False,
            use_router=False,
        )

        if response.get("error"):
            raise RuntimeError(response["error"])

        text = response.get("text")
        if isinstance(text, str) and text.strip():
            return text

        choices = response.get("choices")
        if isinstance(choices, list) and choices:
            alt_text = choices[0].get("text")
            if isinstance(alt_text, str):
                return alt_text

        return ""

    def _build_agent_prompt(self, state: DomainTaskState) -> str:
        domain = state.domain
        agent = state.agent
        exec_context = state.context

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
        procedures_section = self._format_procedures(domain)
        tool_history_section = self._format_tool_history(state.tool_history)
        task_notes_section = self._format_task_notes(state)

        return BASE_AGENT_PROMPT.format(
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
            response_format=AGENT_RESPONSE_FORMAT,
        )

    # ------------------------------------------------------------------
    # Formatting helpers
    # ------------------------------------------------------------------
    def _format_tool_allowlist(self, tool_names: List[str]) -> str:
        if not tool_names:
            return "No tools available."

        lines: List[str] = []
        for name in tool_names:
            try:
                spec = tool_registry.get(name)
                required = spec.in_schema.get("required", []) if spec.in_schema else []
                required_str = f" (required params: {', '.join(required)})" if required else ""
                lines.append(f"- {spec.name}: {spec.description}{required_str}")
            except KeyError:
                lines.append(f"- {name}: [unregistered tool]")
        return "\n".join(lines)

    def _format_chat_history(self, chat_history: Optional[List[Dict]]) -> str:
        if not chat_history:
            return ""
        recent = chat_history[-3:]
        lines = ["## RECENT CHAT HISTORY:"]
        for msg in recent:
            role = msg.get("role", "unknown")
            content = str(msg.get("content", ""))[:200]
            if len(str(msg.get("content", ""))) > 200:
                content += "..."
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
        if not history:
            return ""
        lines = ["## TOOL HISTORY:"]
        for record in history[-5:]:
            params_preview = ", ".join(f"{k}={v}" for k, v in record.param_entries)
            status = "ACCEPTED" if record.accepted else "REJECTED"
            lines.append(
                f"- [{status}] {record.tool_name}({params_preview}) -> {record.result_summary}"
            )
        return "\n".join(lines)

    def _format_task_notes(self, state: DomainTaskState) -> str:
        notes: List[str] = []
        if state.pending_tool:
            params_preview = ", ".join(
                f"{name}={value}" for name, value in state.pending_tool.param_entries
            )
            notes.append(
                "## PENDING APPROVAL:\n"
                f"- Tool: {state.pending_tool.tool_name}\n"
                f"- Reason: {state.pending_tool.reason}\n"
                f"- Params: {params_preview}"
            )
        return "\n".join(notes)

    # ------------------------------------------------------------------
    # Utility helpers
    # ------------------------------------------------------------------
    def _parse_agent_response(self, response_text: str) -> Dict[str, Any]:
        import re

        parsed: Dict[str, Any] = {
            "message": response_text.strip(),
            "raw": response_text,
            "status": "COMPLETE",
            "tool_call": None,
        }
        try:
            decision_match = re.search(
                r"<AGENT_DECISION>(.*?)</AGENT_DECISION>",
                response_text,
                re.DOTALL | re.IGNORECASE,
            )
            body = decision_match.group(1) if decision_match else response_text

            message_match = re.search(
                r"<MESSAGE>(.*?)</MESSAGE>", body, re.DOTALL | re.IGNORECASE
            )
            if message_match:
                parsed["message"] = message_match.group(1).strip()

            status_match = re.search(
                r"<STATUS>(.*?)</STATUS>", body, re.DOTALL | re.IGNORECASE
            )
            if status_match:
                parsed["status"] = status_match.group(1).strip().upper()

            tool_section_match = re.search(
                r"<TOOL_CALL>(.*?)</TOOL_CALL>", body, re.DOTALL | re.IGNORECASE
            )
            tool_section = tool_section_match.group(1) if tool_section_match else ""

            tool_name_match = re.search(
                r"<TOOL>(.*?)</TOOL>", tool_section, re.DOTALL | re.IGNORECASE
            )
            reason_match = re.search(
                r"<REASON>(.*?)</REASON>", tool_section, re.DOTALL | re.IGNORECASE
            )
            param_matches = re.findall(
                r"<PARAM\s+name=\"([^\"]+)\">(.*?)</PARAM>",
                tool_section,
                re.DOTALL | re.IGNORECASE,
            )

            if tool_name_match:
                param_entries: List[Tuple[str, Any]] = []
                for param_name, raw_value in param_matches:
                    cleaned = raw_value.strip()
                    param_entries.append((param_name, self._normalise_param_value(cleaned)))

                parsed["tool_call"] = {
                    "tool": tool_name_match.group(1).strip(),
                    "reason": reason_match.group(1).strip() if reason_match else "",
                    "param_entries": param_entries,
                }
        except Exception as exc:
            self.logger.warning("Failed to parse agent response: %s", exc)

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

    def _serialize_state(self, state: DomainTaskState) -> Dict[str, Any]:
        elapsed = time.time() - state.metadata.get("start_time", time.time())
        return {
            "task_id": state.context.task_id,
            "domain_id": state.context.domain_id,
            "agent_id": state.context.agent_id,
            "status": state.status,
            "agent_message": state.agent_message,
            "output": state.output,
            "pending_tool": self._serialize_tool_proposal(state.pending_tool),
            "actions": [action.to_dict() for action in state.actions],
            "context_snapshots": state.context_snapshots,
            "plan": state.plan,
            "tool_history": [
                {
                    "call_id": record.call_id,
                    "tool": record.tool_name,
                    "params": record.param_entries,
                    "accepted": record.accepted,
                    "executed_at": record.executed_at,
                    "result_summary": record.result_summary,
                    "raw_result": record.raw_result,
                    "error": record.error,
                }
                for record in state.tool_history
            ],
            "metadata": {
                "iterations": state.metadata.get("iterations", 0),
                "tool_calls": state.metadata.get("tool_calls", 0),
                "elapsed_seconds": elapsed,
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

    def _normalise_param_value(self, value: str) -> Any:
        stripped = value.strip()
        if not stripped:
            return ""
        try:
            return json.loads(stripped)
        except (json.JSONDecodeError, TypeError):
            return stripped

    def _summarize_tool_output(self, output: Any) -> str:
        if output is None:
            return "Tool returned no output."
        if isinstance(output, (dict, list)):
            try:
                serialized = json.dumps(output)
            except TypeError:
                serialized = str(output)
        else:
            serialized = str(output)
        if len(serialized) > 400:
            return serialized[:400] + "..."
        return serialized

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
        state.pending_tool = None

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
