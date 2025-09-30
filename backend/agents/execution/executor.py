# status: alpha

from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional

from utils.db_utils import db
from utils.logger import get_logger

from ..services.context_store import ContextStore
from ..events.events import ContextCommittedEvent, NullPlanEventPublisher, PlanEventPublisher, TaskStateEvent, ToolCallEvent
from ..models.task_ir import PlanIR, TaskDef
from ..tools.tool_registry import ToolExecutionContext, ToolResult, tool_registry


_TEMPLATE = re.compile(r"\{\{task\.([^.}]+)\.output\}\}")


def _is_retryable_error(error: Exception) -> bool:
    """Check if an error is transient and should be retried"""
    error_str = str(error).lower()
    return any([
        "503" in error_str,
        "overloaded" in error_str,
        "temporarily" in error_str,
        "unavailable" in error_str,
        "rate limit" in error_str,
        "quota" in error_str,
        "timeout" in error_str,
        "timed out" in error_str,
    ])


class AgentExecutor:
    """Executes Task-IR plans against the tool registry."""

    def __init__(
        self,
        context_store: Optional[ContextStore] = None,
        registry=tool_registry,
        db_manager=None,
        event_publisher: Optional[PlanEventPublisher] = None,
    ) -> None:
        self._context_store = context_store or ContextStore()
        self._registry = registry
        self._db = db_manager or db
        self._logger = get_logger(__name__)
        self._default_events = event_publisher or NullPlanEventPublisher()

    def execute(self, chat_id: str, plan: PlanIR, events: Optional[PlanEventPublisher] = None) -> Dict[str, Any]:
        publisher = events or self._default_events
        task_results: Dict[str, Dict[str, Any]] = {}
        task_contexts: Dict[str, str] = {}
        latest_ctx = plan.base_ctx_id

        for task_id in plan.topological_order():
            task = plan.tasks[task_id]
            base_ctx = self._determine_base_ctx(task, task_contexts, latest_ctx)
            attempt_record = self._db.insert_task_attempt(
                plan_id=plan.plan_id,
                task_id=task.task_id,
                definition=task.to_dict(),
                base_ctx_id=base_ctx,
                state="PENDING",
            )
            attempt_no = attempt_record["attempt"] if attempt_record else 1

            publisher.task_state_changed(TaskStateEvent(plan.plan_id, task.task_id, "PENDING", {"attempt": attempt_no}))
            self._db.update_task_attempt_state(plan.plan_id, task.task_id, attempt_no, state="RUNNING")
            publisher.task_state_changed(TaskStateEvent(plan.plan_id, task.task_id, "RUNNING", {"attempt": attempt_no}))

            resolved_params = self._resolve_params(task.params, task_results)
            context = ToolExecutionContext(chat_id=chat_id, plan_id=plan.plan_id, task_id=task.task_id, ctx_id=base_ctx)
            tool_spec = self._registry.get(task.tool)

            max_retries = 3
            retry_delay = 2.0  
            result = None
            last_error = None

            for retry_attempt in range(max_retries + 1):
                start = time.perf_counter()
                try:
                    result = tool_spec.fn(resolved_params, context)
                    latency_ms = int((time.perf_counter() - start) * 1000)
                    break 
                except Exception as exc:
                    latency_ms = int((time.perf_counter() - start) * 1000)
                    last_error = exc

                    is_retryable = _is_retryable_error(exc)
                    is_last_attempt = retry_attempt >= max_retries

                    if is_retryable and not is_last_attempt:
                        delay = retry_delay * (2 ** retry_attempt)
                        self._logger.warning(
                            "Task %s attempt %d failed with retryable error: %s. Retrying in %.1fs...",
                            task.task_id, retry_attempt + 1, exc, delay
                        )
                        publisher.task_state_changed(
                            TaskStateEvent(
                                plan.plan_id,
                                task.task_id,
                                "RETRYING",
                                {
                                    "attempt": attempt_no,
                                    "retry": retry_attempt + 1,
                                    "max_retries": max_retries,
                                    "error": str(exc),
                                    "delay": delay
                                }
                            )
                        )
                        time.sleep(delay)
                        continue
                    else:
                        if is_retryable and is_last_attempt:
                            self._logger.error(
                                "Task %s failed after %d retries: %s",
                                task.task_id, max_retries + 1, exc
                            )
                        else:
                            self._logger.error("Task %s failed: %s", task.task_id, exc)

                        self._db.update_task_attempt_state(
                            plan.plan_id,
                            task.task_id,
                            attempt_no,
                            state="FAILED",
                            error=str(exc),
                        )
                        publisher.task_state_changed(
                            TaskStateEvent(
                                plan.plan_id,
                                task.task_id,
                                "FAILED",
                                {"attempt": attempt_no, "error": str(exc), "retries": retry_attempt}
                            )
                        )
                        raise

            if result is None:
                if last_error:
                    raise last_error
                else:
                    raise RuntimeError(f"Task {task.task_id} completed without result or error")

            new_ctx_id = base_ctx
            snapshot = None
            if result.ops:
                snapshot = self._context_store.commit_operations(
                    chat_id,
                    base_ctx,
                    {"ops": result.ops},
                    meta={"task_id": task.task_id, "plan_id": plan.plan_id},
                )
                if snapshot:
                    new_ctx_id = snapshot["new_ctx_id"]
                    publisher.context_committed(
                        ContextCommittedEvent(
                            plan.plan_id,
                            task.task_id,
                            base_ctx,
                            new_ctx_id,
                            result.ops,
                        )
                    )

            metadata = result.metadata or {}
            usage = metadata.get("usage") or {}
            tokens = usage.get("total_tokens") or usage.get("tokens") or 0
            cost = usage.get("total_cost") or 0.0
            provider = metadata.get("provider")

            self._db.update_task_attempt_state(
                plan.plan_id,
                task.task_id,
                attempt_no,
                state="DONE",
                new_ctx_id=new_ctx_id,
                provider=provider,
                tokens=tokens,
                cost=cost,
            )
            publisher.task_state_changed(TaskStateEvent(plan.plan_id, task.task_id, "DONE", {"attempt": attempt_no, "ctx_id": new_ctx_id}))

            input_hash = metadata.get("input_hash")
            if not input_hash:
                input_hash = self._compute_hash(resolved_params)

            self._db.record_tool_call(
                plan.plan_id,
                task.task_id,
                attempt=attempt_no,
                tool=task.tool,
                provider=provider,
                model=metadata.get("model"),
                input_hash=input_hash,
                output_hash=self._compute_hash(result.output) if isinstance(result.output, str) else None,
                ops=result.ops,
                latency_ms=latency_ms,
                tokens=tokens,
                cost=cost,
            )
            publisher.tool_called(
                ToolCallEvent(
                    plan.plan_id,
                    task.task_id,
                    attempt_no,
                    task.tool,
                    {
                        "latency_ms": latency_ms,
                        "provider": provider,
                        "model": metadata.get("model"),
                    },
                )
            )

            task_results[task.task_id] = {"output": result.output, "metadata": metadata}
            task_contexts[task.task_id] = new_ctx_id
            latest_ctx = new_ctx_id

        return {
            "final_ctx_id": latest_ctx,
            "task_results": task_results,
        }

    def _determine_base_ctx(self, task: TaskDef, task_contexts: Dict[str, str], latest_ctx: str) -> str:
        if not task.depends_on:
            return latest_ctx
        candidates = [task_contexts[dep] for dep in task.depends_on if dep in task_contexts and task_contexts[dep]]
        return candidates[-1] if candidates else latest_ctx

    def _resolve_params(self, params: Any, task_results: Dict[str, Dict[str, Any]]) -> Any:
        if isinstance(params, str):
            return _TEMPLATE.sub(lambda match: self._extract_output(task_results, match.group(1)), params)
        if isinstance(params, dict):
            return {key: self._resolve_params(value, task_results) for key, value in params.items()}
        if isinstance(params, list):
            return [self._resolve_params(item, task_results) for item in params]
        return params

    @staticmethod
    def _extract_output(task_results: Dict[str, Dict[str, Any]], task_id: str) -> str:
        return str(task_results.get(task_id, {}).get("output", ""))

    @staticmethod
    def _compute_hash(payload: Any) -> str:
        from hashlib import sha256
        try:
            data = payload if isinstance(payload, str) else str(payload)
            return sha256(data.encode("utf-8")).hexdigest()
        except Exception:
            return sha256(repr(payload).encode("utf-8")).hexdigest()
