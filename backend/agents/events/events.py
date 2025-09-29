# status: alpha

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List

from utils.logger import get_logger


@dataclass
class TaskStateEvent:
    plan_id: str
    task_id: str
    state: str
    payload: Dict[str, Any]


@dataclass
class ToolCallEvent:
    plan_id: str
    task_id: str
    attempt: int
    tool: str
    payload: Dict[str, Any]


@dataclass
class ContextCommittedEvent:
    plan_id: str
    task_id: str
    base_ctx_id: str
    new_ctx_id: str
    ops: Any


class PlanEventPublisher:
    """Interface for publishing plan execution events."""

    def task_state_changed(self, event: TaskStateEvent) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def tool_called(self, event: ToolCallEvent) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def context_committed(self, event: ContextCommittedEvent) -> None:  # pragma: no cover - interface
        raise NotImplementedError


class PlanEventEmitter(PlanEventPublisher):
    """Multiplex events to subscribed listeners."""

    def __init__(self) -> None:
        self._listeners: List[Callable[[str, Dict[str, Any]], None]] = []
        self._logger = get_logger(__name__)

    def subscribe(self, listener: Callable[[str, Dict[str, Any]], None]) -> None:
        self._listeners.append(listener)

    def _broadcast(self, event_type: str, payload: Dict[str, Any]) -> None:
        for listener in list(self._listeners):
            try:
                listener(event_type, payload)
            except Exception as exc:
                self._logger.error("Plan event listener error: %s", exc)

    def task_state_changed(self, event: TaskStateEvent) -> None:
        self._broadcast("task_state_changed", event.__dict__)

    def tool_called(self, event: ToolCallEvent) -> None:
        self._broadcast("tool_called", event.__dict__)

    def context_committed(self, event: ContextCommittedEvent) -> None:
        payload = event.__dict__.copy()
        self._broadcast("context_committed", payload)


class NullPlanEventPublisher(PlanEventPublisher):
    """Drop-in publisher that ignores all events."""

    def task_state_changed(self, event: TaskStateEvent) -> None:
        pass

    def tool_called(self, event: ToolCallEvent) -> None:
        pass

    def context_committed(self, event: ContextCommittedEvent) -> None:
        pass
