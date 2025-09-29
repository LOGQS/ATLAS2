# status: alpha

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from utils.db_utils import db
from utils.logger import get_logger

from .context_store import ContextStore
from .events import PlanEventEmitter, PlanEventPublisher
from .executor import AgentExecutor
from .planner import TaskPlanner
from .task_ir import PlanIR


class AgenticService:
    """High-level orchestration for planner and executor."""

    def __init__(self, context_store: Optional[ContextStore] = None):
        self._context_store = context_store or ContextStore()
        self._planner = TaskPlanner(self._context_store)
        self._executor = AgentExecutor(context_store=self._context_store)
        self._db = db
        self._logger = get_logger(__name__)

    def generate_plan(self, chat_id: str, user_message: str) -> PlanIR:
        plan = self._planner.plan(chat_id, user_message)
        fingerprint = plan.fingerprint()
        self._db.create_plan_record(
            plan_id=plan.plan_id,
            chat_id=chat_id,
            base_ctx_id=plan.base_ctx_id,
            ir_data=plan.to_dict(),
            fingerprint=fingerprint,
        )
        return plan

    def execute_plan(
        self,
        chat_id: str,
        plan_id: str,
        events: Optional[PlanEventPublisher] = None,
    ) -> Dict[str, Any]:
        record = self._db.get_plan_record(plan_id)
        if not record:
            raise ValueError(f"Plan {plan_id} not found")
        plan_data = dict(record.get("ir", {}))
        plan_data["plan_id"] = record["id"]
        if "base_ctx_id" not in plan_data:
            plan_data["base_ctx_id"] = record.get("base_ctx_id")
        plan = PlanIR.from_dict(plan_data)

        execution = self._executor.execute(chat_id, plan, events=events)
        final_output, final_task_id = self._extract_final_output(plan, execution)
        final_provider = None
        final_model = None
        saved_message_id = None

        if final_task_id:
            task_meta = execution.get('task_results', {}).get(final_task_id, {}).get('metadata', {}) or {}
            final_provider = task_meta.get('provider')
            final_model = task_meta.get('model')

        if final_output:
            try:
                saved_message_id = self._db.save_message(
                    chat_id,
                    'assistant',
                    final_output,
                    provider=final_provider,
                    model=final_model,
                )
            except Exception as exc:
                self._logger.error(f"Failed to persist assistant message for plan {plan_id}: {exc}")

        execution['plan_id'] = plan.plan_id
        execution['final_output'] = final_output
        execution['final_task_id'] = final_task_id
        execution['assistant_message_id'] = saved_message_id
        execution['final_provider'] = final_provider
        execution['final_model'] = final_model
        return execution

    def get_plan_record(self, plan_id: str) -> Optional[Dict[str, Any]]:
        return self._db.get_plan_record(plan_id)

    def update_plan_status(self, plan_id: str, status: str) -> Optional[Dict[str, Any]]:
        return self._db.update_plan_status(plan_id, status)

    def list_plans(self, chat_id: str, limit: int = 20) -> List[Dict[str, Any]]:
        return self._db.list_plan_records(chat_id, limit=limit)

    def list_tasks(self, plan_id: str) -> List[Dict[str, Any]]:
        return self._db.list_tasks_for_plan(plan_id)

    def list_tool_calls(self, plan_id: str) -> List[Dict[str, Any]]:
        return self._db.list_tool_calls_for_plan(plan_id)

    def list_context(self, chat_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        return self._context_store.list_snapshots(chat_id, limit=limit)

    def get_context_snapshot(self, chat_id: str, ctx_id: str) -> Optional[Dict[str, Any]]:
        return self._context_store.get_snapshot(chat_id, ctx_id)

    def _extract_final_output(self, plan: PlanIR, execution: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
        try:
            ordered = plan.topological_order()
        except ValueError:
            return None, None
        if not ordered:
            return None, None
        final_task_id = ordered[-1]
        task_data = execution.get('task_results', {}).get(final_task_id)
        if not task_data:
            return None, final_task_id
        return task_data.get('output'), final_task_id

    def build_event_emitter(self) -> PlanEventEmitter:
        return PlanEventEmitter()
