# status: alpha

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set


@dataclass
class TaskDef:
    """Represents a single task inside a plan."""

    task_id: str
    tool: str
    params: Dict[str, Any] = field(default_factory=dict)
    depends_on: List[str] = field(default_factory=list)
    reads: List[str] = field(default_factory=list)
    writes: List[str] = field(default_factory=list)
    retries: int = 0
    timeout_ms: Optional[int] = None
    policy: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.task_id,
            "tool": self.tool,
            "params": self.params,
            "depends_on": self.depends_on,
            "reads": self.reads,
            "writes": self.writes,
            "retries": self.retries,
            "timeout_ms": self.timeout_ms,
            "policy": self.policy,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TaskDef":
        return cls(
            task_id=data["id"],
            tool=data["tool"],
            params=data.get("params", {}),
            depends_on=list(data.get("depends_on", [])),
            reads=list(data.get("reads", [])),
            writes=list(data.get("writes", [])),
            retries=int(data.get("retries", 0) or 0),
            timeout_ms=data.get("timeout_ms"),
            policy=dict(data.get("policy", {})),
        )


@dataclass
class PlanIR:
    """Intermediate representation of a plan description."""

    plan_id: str
    base_ctx_id: str
    tasks: Dict[str, TaskDef]
    metadata: Dict[str, Any] = field(default_factory=dict)
    version: str = "1.0"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "base_ctx_id": self.base_ctx_id,
            "version": self.version,
            "metadata": self.metadata,
            "tasks": {task_id: task.to_dict() for task_id, task in self.tasks.items()},
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PlanIR":
        tasks = {task_id: TaskDef.from_dict(task_data) for task_id, task_data in data.get("tasks", {}).items()}
        return cls(
            plan_id=data["plan_id"],
            base_ctx_id=data["base_ctx_id"],
            version=data.get("version", "1.0"),
            metadata=dict(data.get("metadata", {})),
            tasks=tasks,
        )

    def validate(self) -> None:
        """Validate structure and detect dependency issues."""
        for task_id, task in self.tasks.items():
            if not task.tool:
                raise ValueError(f"Task {task_id} missing tool reference")
            for dep in task.depends_on:
                if dep not in self.tasks:
                    raise ValueError(f"Task {task_id} depends on unknown task {dep}")
            if task.retries < 0:
                raise ValueError(f"Task {task_id} retries cannot be negative")

        visiting: Set[str] = set()
        visited: Set[str] = set()

        def dfs(node: str) -> None:
            if node in visited:
                return
            if node in visiting:
                raise ValueError("Cycle detected in plan definition")
            visiting.add(node)
            for dep in self.tasks[node].depends_on:
                dfs(dep)
            visiting.remove(node)
            visited.add(node)

        for node in self.tasks:
            dfs(node)

    def topological_order(self) -> List[str]:
        """Return task identifiers in topological order."""
        self.validate()
        in_degree = {task_id: 0 for task_id in self.tasks}
        for task in self.tasks.values():
            for dep in task.depends_on:
                in_degree[task.task_id] = in_degree[task.task_id] + 1

        ready = [task_id for task_id, degree in in_degree.items() if degree == 0]
        ordered: List[str] = []
        queue_index = 0
        while queue_index < len(ready):
            current = ready[queue_index]
            queue_index += 1
            ordered.append(current)
            for candidate in self.tasks.values():
                if current in candidate.depends_on:
                    in_degree[candidate.task_id] -= 1
                    if in_degree[candidate.task_id] == 0:
                        ready.append(candidate.task_id)
        if len(ordered) != len(self.tasks):
            raise ValueError("Unable to compute topological order for plan")
        return ordered

    def fingerprint(self) -> str:
        """Stable fingerprint for the plan."""
        canonical = json.dumps(self.to_dict(), sort_keys=True)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
