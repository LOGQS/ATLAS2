"""Single Domain Executor.

This module handles execution of single domain tasks with agents.
Agents iterate autonomously, manage their own context, and execute tools based on domain configuration.
"""

from typing import Any, Dict, List, Optional
import uuid
import time
from dataclasses import dataclass

from agents.domains.domain_registry import domain_registry, AgentSpec, DomainSpec
from agents.tools.tool_registry import tool_registry
from utils.logger import get_logger


logger = get_logger(__name__)


@dataclass
class DomainExecutionContext:
    """Context for single domain execution."""
    chat_id: str
    domain_id: str
    agent_id: str
    task_id: str
    user_request: str
    global_context: Dict[str, Any]
    task_budget: Optional[Dict[str, int]] = None  


@dataclass
class ActionRecord:
    """Record of an action taken during execution."""
    action_id: str
    action_type: str  
    timestamp: str
    description: str
    status: str  
    result: Optional[Any] = None
    metadata: Dict[str, Any] = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}

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


class SingleDomainExecutor:
    """Executes single domain tasks with agent iteration."""

    def __init__(self):
        self.logger = get_logger(__name__)
        self._active_contexts: Dict[str, List[Any]] = {}  

    def execute_domain_task(
        self,
        domain_id: str,
        user_request: str,
        chat_id: str,
        chat_history: Optional[List[Dict]] = None,
        attached_files: Optional[List[Dict]] = None,
        task_budget: Optional[Dict[str, int]] = None,
    ) -> Dict[str, Any]:
        """Execute a task in a specific domain.

        Args:
            domain_id: The domain to execute in
            user_request: The user's request
            chat_id: Chat ID for tracking
            chat_history: Optional chat history
            attached_files: Optional attached files
            task_budget: Optional soft budget constraints from user

        Returns:
            Execution result with actions, context, and output
        """
        self.logger.info(f"Executing domain task: {domain_id}")

        try:
            domain = domain_registry.get(domain_id)
        except KeyError:
            error_msg = f"Domain {domain_id} not found in registry"
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
                domain, user_request, chat_history, attached_files
            ),
            task_budget=task_budget,
        )

        result = self._execute_with_agent(domain, agent, exec_context)

        return result

    def _build_global_context(
        self,
        domain: DomainSpec,
        user_request: str,
        chat_history: Optional[List[Dict]],
        attached_files: Optional[List[Dict]],
    ) -> Dict[str, Any]:
        """Build global context based on domain's allowlist."""
        context = {}

        if "user_request" in domain.global_context_allowlist:
            context["user_request"] = user_request

        if "chat_history" in domain.global_context_allowlist and chat_history:
            context["chat_history"] = chat_history

        if "attached_files" in domain.global_context_allowlist and attached_files:
            context["attached_files"] = attached_files

        return context

    def _execute_with_agent(
        self,
        domain: DomainSpec,
        agent: AgentSpec,
        exec_context: DomainExecutionContext,
    ) -> Dict[str, Any]:
        """Execute task with a specific agent."""
        import datetime

        self.logger.info(
            f"Executing with agent {agent.agent_id} in domain {domain.domain_id}"
        )

        actions: List[ActionRecord] = []
        context_snapshots: List[Dict[str, Any]] = []
        start_time = time.time()

        start_action = ActionRecord(
            action_id=f"action_{uuid.uuid4().hex[:8]}",
            action_type="domain_start",
            timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            description=f"Starting execution in {domain.name} domain",
            status="completed",
            metadata={
                "domain_id": domain.domain_id,
                "agent_id": agent.agent_id,
                "task_id": exec_context.task_id,
            },
        )
        actions.append(start_action)

        agent_prompt = self._build_agent_prompt(domain, agent, exec_context)

        self.logger.info("=" * 80)
        self.logger.info(f"[DOMAIN-AGENT-PROMPT] Full prompt for {domain.domain_id}/{agent.agent_id}:")
        self.logger.info("=" * 80)
        self.logger.info(agent_prompt)
        self.logger.info("=" * 80)

        initial_context = {
            "snapshot_id": f"ctx_{uuid.uuid4().hex[:8]}",
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "context_size": len(agent_prompt),
            "summary": f"Initial context for {domain.name} domain",
            "full_context": {
                "user_request": exec_context.user_request,
                "domain_id": domain.domain_id,
                "agent_id": agent.agent_id,
            }
        }
        context_snapshots.append(initial_context)

        try:
            response_action = ActionRecord(
                action_id=f"action_{uuid.uuid4().hex[:8]}",
                action_type="llm_generate",
                timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                description=f"Generating response with {agent.model_preference or 'default model'}",
                status="in_progress",
            )
            actions.append(response_action)

            from chat.chat import Chat
            temp_chat = Chat(chat_id=f"domain_temp_{uuid.uuid4().hex[:8]}")

            full_text = ""
            full_thoughts = ""

            for chunk in temp_chat.generate_text_stream(
                message=agent_prompt,
                provider="gemini",
                model=agent.model_preference or "gemini-2.5-flash",
                include_reasoning=False,
                use_router=False,
            ):
                if chunk.get("type") == "thoughts":
                    full_thoughts += chunk.get("content", "")
                elif chunk.get("type") == "answer":
                    full_text += chunk.get("content", "")

            output_text = full_text

            self.logger.info("=" * 80)
            self.logger.info(f"[DOMAIN-AGENT-RESPONSE] Full response from {domain.domain_id}/{agent.agent_id}:")
            self.logger.info("=" * 80)
            self.logger.info(output_text)
            self.logger.info("=" * 80)

            parsed = self._parse_agent_response(output_text)

            for parsed_action in parsed.get("actions", []):
                action_record = ActionRecord(
                    action_id=f"action_{uuid.uuid4().hex[:8]}",
                    action_type=parsed_action["type"],
                    timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    description=parsed_action.get("reason", f"{parsed_action['type']} action"),
                    status="simulated",  
                    metadata={
                        "tool": parsed_action.get("tool"),
                        "params": parsed_action.get("params"),
                        "content": parsed_action.get("content"),
                    }
                )
                actions.append(action_record)

            response_action.status = "completed"
            response_action.result = parsed.get("output", output_text)[:500] 

            complete_action = ActionRecord(
                action_id=f"action_{uuid.uuid4().hex[:8]}",
                action_type="domain_complete",
                timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                description="Domain execution completed",
                status="completed",
                metadata={
                    "output_length": len(parsed.get("output", output_text)),
                    "actions_count": len(actions),
                    "thinking_present": bool(parsed.get("thinking")),
                    "plan_steps": len(parsed.get("plan", [])),
                },
            )
            actions.append(complete_action)

            plan_data = None
            if parsed.get("plan"):
                plan_data = {
                    "plan_id": f"plan_{exec_context.task_id}",
                    "task_description": exec_context.user_request,
                    "steps": parsed["plan"],
                    "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                }

            response = {
                "task_id": exec_context.task_id,
                "domain_id": domain.domain_id,
                "agent_id": agent.agent_id,
                "status": "completed",
                "execution_time": time.time() - start_time,
                "actions": [action.to_dict() for action in actions],
                "context_snapshots": context_snapshots,
                "plan": plan_data,
                "thinking": parsed.get("thinking", ""), 
                "output": parsed.get("output", output_text),
                "metadata": {
                    "tool_calls": 0,  
                    "iterations": 1,
                    "budget_used": {
                        "tool_calls": 0,
                        "iterations": 1,
                        "time_seconds": time.time() - start_time,
                    },
                    "budget_limits": {
                        "max_tool_calls": agent.default_budget.max_tool_calls,
                        "max_iterations": agent.default_budget.max_iterations,
                        "max_time_seconds": agent.default_budget.max_time_seconds,
                    },
                },
            }

            return response

        except Exception as e:
            self.logger.error(f"Agent execution failed: {str(e)}")

            if actions:
                actions[-1].status = "failed"
                actions[-1].result = str(e)

            return {
                "task_id": exec_context.task_id,
                "domain_id": domain.domain_id,
                "agent_id": agent.agent_id,
                "status": "failed",
                "execution_time": time.time() - start_time,
                "actions": [action.to_dict() for action in actions],
                "context_snapshots": context_snapshots,
                "plan": None,
                "error": str(e),
                "output": f"Execution failed: {str(e)}",
            }

    def _build_agent_prompt(
        self,
        domain: DomainSpec,
        agent: AgentSpec,
        exec_context: DomainExecutionContext,
    ) -> str:
        """Build structured prompt for the agent using templates."""
        from agents.prompts.agent_prompt_templates import (
            BASE_AGENT_PROMPT,
            AGENT_RESPONSE_FORMAT,
            get_domain_instructions,
        )

        domain_instructions = get_domain_instructions(domain.domain_id)

        available_tools = self.get_available_tools_for_domain(domain.domain_id)
        if available_tools:
            tool_desc_lines = [f"Available tools ({len(available_tools)}):"]
            for tool_name in available_tools[:10]:  # Limit to first 10 for brevity
                tool_desc_lines.append(f"  - {tool_name}")
            if len(available_tools) > 10:
                tool_desc_lines.append(f"  ... and {len(available_tools) - 10} more")
            tool_descriptions = "\n".join(tool_desc_lines)
        else:
            tool_descriptions = "No tools currently available (implementation in progress)"

        budget_info = (
            f"Max tool calls: {agent.default_budget.max_tool_calls}, "
            f"Max iterations: {agent.default_budget.max_iterations}, "
            f"Max time: {agent.default_budget.max_time_seconds}s"
        )

        chat_history = exec_context.global_context.get("chat_history", [])
        if chat_history:
            history_lines = ["## CHAT HISTORY:"]
            for msg in chat_history[-3:]: 
                role = msg.get("role", "unknown")
                content = msg.get("content", "")[:150]
                history_lines.append(f"{role}: {content}...")
            chat_history_section = "\n".join(history_lines)
        else:
            chat_history_section = ""

        attached_files = exec_context.global_context.get("attached_files", [])
        if attached_files:
            files_section = f"## ATTACHED FILES:\n{len(attached_files)} file(s) attached"
        else:
            files_section = ""

        if domain.procedures:
            proc_lines = ["## AVAILABLE PROCEDURES:"]
            for proc in domain.procedures[:3]:  
                proc_lines.append(f"- {proc.name}: {proc.description}")
            procedures_section = "\n".join(proc_lines)
        else:
            procedures_section = ""

        prompt = BASE_AGENT_PROMPT.format(
            domain_specific_instructions=domain_instructions,
            tool_descriptions=tool_descriptions,
            domain_id=domain.domain_id,
            agent_id=agent.agent_id,
            execution_mode=agent.execution_mode.value,
            budget_info=budget_info,
            user_request=exec_context.user_request,
            chat_history_section=chat_history_section,
            attached_files_section=files_section,
            procedures_section=procedures_section,
            response_format=AGENT_RESPONSE_FORMAT,
        )

        return prompt

    def _parse_agent_response(self, response_text: str) -> Dict[str, Any]:
        """Parse structured agent response.

        Extracts THINKING, PLAN, ACTIONS, OUTPUT, and STATUS from the response.
        Falls back to raw text if parsing fails.
        """
        import re

        parsed = {
            "thinking": "",
            "plan": [],
            "actions": [],
            "output": response_text,  
            "status": "COMPLETE",  
        }

        try:
            thinking_match = re.search(
                r'<THINKING>(.*?)</THINKING>',
                response_text,
                re.DOTALL
            )
            if thinking_match:
                parsed["thinking"] = thinking_match.group(1).strip()

            plan_match = re.search(
                r'<PLAN>(.*?)</PLAN>',
                response_text,
                re.DOTALL
            )
            if plan_match:
                plan_section = plan_match.group(1)
                step_pattern = r'<STEP\s+id="(\d+)"\s+status="(\w+)">(.*?)</STEP>'
                for step_match in re.finditer(step_pattern, plan_section):
                    parsed["plan"].append({
                        "step_id": step_match.group(1),
                        "status": step_match.group(2),
                        "description": step_match.group(3).strip(),
                    })

            actions_match = re.search(
                r'<ACTIONS>(.*?)</ACTIONS>',
                response_text,
                re.DOTALL
            )
            if actions_match:
                actions_section = actions_match.group(1)
                action_pattern = r'<ACTION\s+type="([^"]+)"(?:\s+tool="([^"]+)")?>(.*?)</ACTION>'
                for action_match in re.finditer(action_pattern, actions_section, re.DOTALL):
                    action_type = action_match.group(1)
                    tool_name = action_match.group(2) or None
                    action_content = action_match.group(3)

                    action = {
                        "type": action_type,
                        "tool": tool_name,
                        "params": {},
                        "reason": "",
                        "content": "",
                    }

                    param_pattern = r'<PARAM\s+name="([^"]+)">(.*?)</PARAM>'
                    for param_match in re.finditer(param_pattern, action_content):
                        action["params"][param_match.group(1)] = param_match.group(2).strip()

                    reason_match = re.search(r'<REASON>(.*?)</REASON>', action_content, re.DOTALL)
                    if reason_match:
                        action["reason"] = reason_match.group(1).strip()

                    content_match = re.search(r'<CONTENT>(.*?)</CONTENT>', action_content, re.DOTALL)
                    if content_match:
                        action["content"] = content_match.group(1).strip()

                    parsed["actions"].append(action)

            output_match = re.search(
                r'<OUTPUT>(.*?)</OUTPUT>',
                response_text,
                re.DOTALL
            )
            if output_match:
                parsed["output"] = output_match.group(1).strip()

            status_match = re.search(
                r'<STATUS>(.*?)</STATUS>',
                response_text,
                re.DOTALL
            )
            if status_match:
                parsed["status"] = status_match.group(1).strip().upper()

        except Exception as e:
            self.logger.warning(f"Failed to parse agent response: {e}")

        return parsed

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
                        f"Tool {tool_name} in domain {domain_id} allowlist not found in registry"
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
