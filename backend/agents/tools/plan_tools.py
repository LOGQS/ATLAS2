"""Global Plan Management Tools.

These tools allow agents to create and update dynamic plans during execution.
Plans are displayed in the DomainBox UI for user visibility.
"""

from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field
from enum import Enum

from agents.tools.tool_registry import ToolSpec, ToolResult, ToolExecutionContext, tool_registry
from utils.logger import get_logger


logger = get_logger(__name__)


class StepStatus(Enum):
    """Status of a plan step."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class PlanStep:
    """A single step in an execution plan."""
    step_id: str
    description: str
    status: StepStatus = StepStatus.PENDING
    result: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "step_id": self.step_id,
            "description": self.description,
            "status": self.status.value,
            "result": self.result,
            "metadata": self.metadata,
        }


@dataclass
class ExecutionPlan:
    """A dynamic execution plan."""
    plan_id: str
    task_description: str
    steps: List[PlanStep] = field(default_factory=list)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "task_description": self.task_description,
            "steps": [step.to_dict() for step in self.steps],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    def get_step(self, step_id: str) -> Optional[PlanStep]:
        """Get a step by ID."""
        for step in self.steps:
            if step.step_id == step_id:
                return step
        return None

    def update_step_status(self, step_id: str, status: StepStatus, result: Optional[str] = None):
        """Update a step's status."""
        step = self.get_step(step_id)
        if step:
            step.status = status
            if result is not None:
                step.result = result


_active_plans: Dict[str, ExecutionPlan] = {}


def _write_plan_impl(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """Implementation of write_plan tool."""
    task_description = params.get("task_description")
    steps_data = params.get("steps", [])

    if not task_description:
        raise ValueError("write_plan requires task_description")

    plan_id = ctx.task_id

    steps = []
    for idx, step_data in enumerate(steps_data):
        if isinstance(step_data, str):
            step = PlanStep(
                step_id=f"step_{idx+1}",
                description=step_data,
                status=StepStatus.PENDING,
            )
        elif isinstance(step_data, dict):
            step = PlanStep(
                step_id=step_data.get("step_id", f"step_{idx+1}"),
                description=step_data.get("description", ""),
                status=StepStatus(step_data.get("status", "pending")),
                result=step_data.get("result"),
                metadata=step_data.get("metadata", {}),
            )
        else:
            continue
        steps.append(step)

    import datetime
    current_time = datetime.datetime.now(datetime.timezone.utc).isoformat()

    plan = ExecutionPlan(
        plan_id=plan_id,
        task_description=task_description,
        steps=steps,
        created_at=current_time,
        updated_at=current_time,
    )

    _active_plans[plan_id] = plan

    logger.info(f"Created plan {plan_id} with {len(steps)} steps")

    ops = [{
        "type": "plan.created",
        "plan_id": plan_id,
        "plan": plan.to_dict(),
        "task_id": ctx.task_id,
    }]

    return ToolResult(
        output={"plan_id": plan_id, "steps_count": len(steps)},
        ops=ops,
        metadata={"plan": plan.to_dict()}
    )


def _update_plan_impl(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """Implementation of update_plan tool."""
    plan_id = params.get("plan_id", ctx.task_id)
    updates = params.get("updates", {})

    plan = _active_plans.get(plan_id)
    if not plan:
        raise ValueError(f"Plan {plan_id} not found. Create a plan first with write_plan.")
    
    if "task_description" in updates:
        plan.task_description = updates["task_description"]

    if "add_steps" in updates:
        new_steps_data = updates["add_steps"]
        for idx, step_data in enumerate(new_steps_data):
            if isinstance(step_data, str):
                step = PlanStep(
                    step_id=f"step_{len(plan.steps)+idx+1}",
                    description=step_data,
                    status=StepStatus.PENDING,
                )
            elif isinstance(step_data, dict):
                step = PlanStep(
                    step_id=step_data.get("step_id", f"step_{len(plan.steps)+idx+1}"),
                    description=step_data.get("description", ""),
                    status=StepStatus(step_data.get("status", "pending")),
                    result=step_data.get("result"),
                    metadata=step_data.get("metadata", {}),
                )
            else:
                continue
            plan.steps.append(step)

    if "update_steps" in updates:
        step_updates = updates["update_steps"]
        for step_update in step_updates:
            step_id = step_update.get("step_id")
            if not step_id:
                continue

            step = plan.get_step(step_id)
            if not step:
                logger.warning(f"Step {step_id} not found in plan {plan_id}")
                continue

            if "status" in step_update:
                step.status = StepStatus(step_update["status"])
            if "description" in step_update:
                step.description = step_update["description"]
            if "result" in step_update:
                step.result = step_update["result"]
            if "metadata" in step_update:
                step.metadata.update(step_update["metadata"])

    if "remove_steps" in updates:
        step_ids_to_remove = updates["remove_steps"]
        plan.steps = [s for s in plan.steps if s.step_id not in step_ids_to_remove]

    import datetime
    plan.updated_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

    logger.info(f"Updated plan {plan_id}")

    ops = [{
        "type": "plan.updated",
        "plan_id": plan_id,
        "plan": plan.to_dict(),
        "task_id": ctx.task_id,
    }]

    return ToolResult(
        output={"plan_id": plan_id, "updated": True},
        ops=ops,
        metadata={"plan": plan.to_dict()}
    )


write_plan_spec = ToolSpec(
    name="plan.write",
    version="1.0",
    description="Create a new execution plan with steps. The plan will be displayed to the user in real-time.",
    effects=["context"],
    in_schema={
        "type": "object",
        "properties": {
            "task_description": {
                "type": "string",
                "description": "Overall description of what this plan aims to accomplish"
            },
            "steps": {
                "type": "array",
                "description": "List of steps in the plan. Each can be a string description or an object with details.",
                "items": {
                    "oneOf": [
                        {"type": "string"},
                        {
                            "type": "object",
                            "properties": {
                                "step_id": {"type": "string"},
                                "description": {"type": "string"},
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed", "failed", "skipped"]
                                },
                                "result": {"type": "string"},
                                "metadata": {"type": "object"}
                            }
                        }
                    ]
                }
            }
        },
        "required": ["task_description", "steps"]
    },
    out_schema={"type": "object"},
    fn=_write_plan_impl,
    rate_key="plan.write",
)

update_plan_spec = ToolSpec(
    name="plan.update",
    version="1.0",
    description="Update an existing execution plan. Can add/remove/modify steps or update step statuses.",
    effects=["context"],
    in_schema={
        "type": "object",
        "properties": {
            "plan_id": {
                "type": "string",
                "description": "ID of the plan to update. Defaults to current task's plan."
            },
            "updates": {
                "type": "object",
                "description": "Updates to apply to the plan",
                "properties": {
                    "task_description": {
                        "type": "string",
                        "description": "New task description"
                    },
                    "add_steps": {
                        "type": "array",
                        "description": "Steps to add to the plan",
                        "items": {
                            "oneOf": [
                                {"type": "string"},
                                {"type": "object"}
                            ]
                        }
                    },
                    "update_steps": {
                        "type": "array",
                        "description": "Steps to update",
                        "items": {
                            "type": "object",
                            "properties": {
                                "step_id": {"type": "string"},
                                "status": {"type": "string"},
                                "description": {"type": "string"},
                                "result": {"type": "string"},
                                "metadata": {"type": "object"}
                            },
                            "required": ["step_id"]
                        }
                    },
                    "remove_steps": {
                        "type": "array",
                        "description": "Step IDs to remove from the plan",
                        "items": {"type": "string"}
                    }
                }
            }
        },
        "required": ["updates"]
    },
    out_schema={"type": "object"},
    fn=_update_plan_impl,
    rate_key="plan.update",
)


def register_plan_tools():
    """Register plan management tools."""
    tool_registry.register(write_plan_spec)
    tool_registry.register(update_plan_spec)
    logger.info("Plan management tools registered successfully")
