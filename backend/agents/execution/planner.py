# status: alpha

from __future__ import annotations

import json
import uuid
from typing import Optional

from chat.chat import Chat
from utils.config import Config
from utils.logger import get_logger
from agents.prompts.planner_prompt import build_planner_prompt

from ..services.context_store import ContextStore
from ..models.task_ir import PlanIR, TaskDef
from ..tools.tool_registry import tool_registry


class TaskPlanner:
    """Generates execution plans for multi-step requests."""

    def __init__(self, context_store: Optional[ContextStore] = None):
        self._context_store = context_store or ContextStore()
        self._logger = get_logger(__name__)

    def plan(self, chat_id: str, user_message: str) -> PlanIR:
        """Build a plan by calling LLM with planner prompt."""
        latest_ctx = self._context_store.get_latest_ctx_id(chat_id)
        if not latest_ctx:
            latest_ctx = self._context_store.ensure_root(chat_id)

        plan_id = f"plan_{uuid.uuid4().hex}"

        planner_prompt = build_planner_prompt(user_message, tool_registry)

        # Track planner token usage
        from agents.context.context_manager import context_manager
        provider = Config.get_default_provider()
        model = Config.get_default_model()
        token_estimate = context_manager.estimate_request_tokens(
            role="planner",
            provider=provider,
            model=model,
            system_prompt=None,
            chat_history=[],
            current_message=planner_prompt,
            file_attachments=[]
        )
        estimated_tokens = token_estimate['estimated_tokens']['total']
        self._logger.debug(f"Planner estimated tokens: {estimated_tokens}")

        temp_chat = Chat(chat_id=f"router_temp_{uuid.uuid4().hex}")
        response = temp_chat.generate_text(
            message=planner_prompt,
            provider=provider,
            model=model,
            include_reasoning=False,
            use_router=False
        )

        # Extract actual token usage and save to database
        actual_tokens_data = context_manager.extract_actual_tokens_from_response(response, provider)
        actual_tokens_count = actual_tokens_data['total_tokens'] if actual_tokens_data else 0

        if actual_tokens_data:
            self._logger.info(f"Planner actual tokens: {actual_tokens_count}")

        # Save planner token usage to database
        from utils.db_utils import db
        # Save both estimated and actual tokens (actual may be 0 if not available)
        db.save_token_usage(
            chat_id=chat_id,
            role='planner',
            provider=provider,
            model=model,
            estimated_tokens=estimated_tokens,
            actual_tokens=actual_tokens_count,
            plan_id=plan_id
        )
        self._logger.debug(f"[TokenUsage] Saved planner token usage for chat {chat_id}, plan {plan_id}: estimated={estimated_tokens}, actual={actual_tokens_count}")

        if response.get("error"):
            error_msg = response['error']
            self._logger.error(f"Planner LLM call failed: {error_msg}")
            raise RuntimeError(f"Planner LLM call failed: {error_msg}")

        plan_text = response.get("text", "").strip()

        # Strip markdown code blocks if present
        if plan_text.startswith("```json"):
            plan_text = plan_text[7:]  # Remove ```json
        if plan_text.startswith("```"):
            plan_text = plan_text[3:]   # Remove ```
        if plan_text.endswith("```"):
            plan_text = plan_text[:-3]  # Remove closing ```

        plan_text = plan_text.strip()

        try:
            # Parse the JSON response
            plan_data = json.loads(plan_text)

            # Convert to TaskDef objects
            tasks = {}
            for task_id, task_data in plan_data.get("tasks", {}).items():
                tasks[task_id] = TaskDef.from_dict(task_data)

            # Create PlanIR
            plan = PlanIR(
                plan_id=plan_id,
                base_ctx_id=latest_ctx,
                tasks=tasks,
                metadata=plan_data.get("metadata", {
                    "user_message": user_message,
                    "planner": "TaskPlanner",
                }),
            )

            plan.validate()
            return plan

        except (json.JSONDecodeError, ValueError, KeyError) as e:
            self._logger.error(f"Failed to parse planner response: {e}")
            self._logger.error(f"Raw response: {plan_text}")
            raise RuntimeError(f"Failed to parse planner response: {str(e)}")

    def _create_fallback_plan(self, plan_id: str, base_ctx_id: str, user_message: str) -> PlanIR:
        """Create a simple fallback plan when LLM planning fails."""
        simple_task = TaskDef(
            task_id="respond",
            tool="llm.generate",
            params={
                "prompt": f"Please provide a helpful response to this user request:\n\n{user_message}",
                "provider": None,
                "model": None,
                "include_thoughts": False,
                "commit_to_context": True,
            },
        )

        plan = PlanIR(
            plan_id=plan_id,
            base_ctx_id=base_ctx_id,
            tasks={"respond": simple_task},
            metadata={
                "user_message": user_message,
                "planner": "TaskPlanner",
                "fallback": True,
            },
        )

        plan.validate()
        return plan
