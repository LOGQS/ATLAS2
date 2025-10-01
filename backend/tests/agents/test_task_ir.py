"""Unit tests for task intermediate representation (IR)."""

import sys
import unittest
from pathlib import Path

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.models.task_ir import TaskDef, PlanIR


class TestTaskDefSerialization(unittest.TestCase):
    """Test TaskDef serialization and deserialization."""

    def test_to_dict_includes_all_fields(self):
        """to_dict should include all task definition fields."""
        task = TaskDef(
            task_id="task_1",
            tool="file.read",
            params={"file_path": "/test.txt"},
            depends_on=["task_0"],
            reads=["input.txt"],
            writes=["output.txt"],
            retries=3,
            timeout_ms=5000,
            policy={"on_failure": "continue"}
        )

        result = task.to_dict()

        self.assertEqual(result["id"], "task_1")
        self.assertEqual(result["tool"], "file.read")
        self.assertEqual(result["params"], {"file_path": "/test.txt"})
        self.assertEqual(result["depends_on"], ["task_0"])
        self.assertEqual(result["reads"], ["input.txt"])
        self.assertEqual(result["writes"], ["output.txt"])
        self.assertEqual(result["retries"], 3)
        self.assertEqual(result["timeout_ms"], 5000)
        self.assertEqual(result["policy"], {"on_failure": "continue"})

    def test_from_dict_reconstructs_task(self):
        """from_dict should reconstruct TaskDef from dictionary."""
        data = {
            "id": "task_2",
            "tool": "file.write",
            "params": {"content": "test"},
            "depends_on": ["task_1"],
            "reads": [],
            "writes": ["result.txt"],
            "retries": 2,
            "timeout_ms": 3000,
            "policy": {}
        }

        task = TaskDef.from_dict(data)

        self.assertEqual(task.task_id, "task_2")
        self.assertEqual(task.tool, "file.write")
        self.assertEqual(task.params, {"content": "test"})
        self.assertEqual(task.depends_on, ["task_1"])
        self.assertEqual(task.reads, [])
        self.assertEqual(task.writes, ["result.txt"])
        self.assertEqual(task.retries, 2)
        self.assertEqual(task.timeout_ms, 3000)
        self.assertEqual(task.policy, {})

    def test_from_dict_handles_missing_optional_fields(self):
        """from_dict should handle missing optional fields with defaults."""
        data = {
            "id": "task_minimal",
            "tool": "some.tool"
        }

        task = TaskDef.from_dict(data)

        self.assertEqual(task.task_id, "task_minimal")
        self.assertEqual(task.tool, "some.tool")
        self.assertEqual(task.params, {})
        self.assertEqual(task.depends_on, [])
        self.assertEqual(task.reads, [])
        self.assertEqual(task.writes, [])
        self.assertEqual(task.retries, 0)
        self.assertIsNone(task.timeout_ms)
        self.assertEqual(task.policy, {})

    def test_from_dict_handles_none_retries(self):
        """from_dict should convert None retries to 0."""
        data = {
            "id": "task_3",
            "tool": "test.tool",
            "retries": None
        }

        task = TaskDef.from_dict(data)

        self.assertEqual(task.retries, 0)

    def test_roundtrip_serialization(self):
        """Serializing and deserializing should preserve data."""
        original = TaskDef(
            task_id="task_roundtrip",
            tool="test.tool",
            params={"key": "value"},
            depends_on=["dep1", "dep2"],
            reads=["read1"],
            writes=["write1", "write2"],
            retries=5,
            timeout_ms=10000,
            policy={"strict": True}
        )

        data = original.to_dict()
        reconstructed = TaskDef.from_dict(data)

        self.assertEqual(reconstructed.task_id, original.task_id)
        self.assertEqual(reconstructed.tool, original.tool)
        self.assertEqual(reconstructed.params, original.params)
        self.assertEqual(reconstructed.depends_on, original.depends_on)
        self.assertEqual(reconstructed.reads, original.reads)
        self.assertEqual(reconstructed.writes, original.writes)
        self.assertEqual(reconstructed.retries, original.retries)
        self.assertEqual(reconstructed.timeout_ms, original.timeout_ms)
        self.assertEqual(reconstructed.policy, original.policy)


class TestPlanIRSerialization(unittest.TestCase):
    """Test PlanIR serialization and deserialization."""

    def setUp(self):
        """Set up test tasks for plan creation."""
        self.task1 = TaskDef(task_id="task_1", tool="tool.a", params={})
        self.task2 = TaskDef(task_id="task_2", tool="tool.b", depends_on=["task_1"])

    def test_to_dict_includes_all_fields(self):
        """to_dict should include all plan fields."""
        plan = PlanIR(
            plan_id="plan_1",
            base_ctx_id="ctx_1",
            tasks={"task_1": self.task1, "task_2": self.task2},
            metadata={"created_by": "test"},
            version="1.0"
        )

        result = plan.to_dict()

        self.assertEqual(result["plan_id"], "plan_1")
        self.assertEqual(result["base_ctx_id"], "ctx_1")
        self.assertEqual(result["version"], "1.0")
        self.assertEqual(result["metadata"], {"created_by": "test"})
        self.assertIn("task_1", result["tasks"])
        self.assertIn("task_2", result["tasks"])

    def test_from_dict_reconstructs_plan(self):
        """from_dict should reconstruct PlanIR from dictionary."""
        data = {
            "plan_id": "plan_2",
            "base_ctx_id": "ctx_2",
            "version": "2.0",
            "metadata": {"note": "test plan"},
            "tasks": {
                "task_1": {
                    "id": "task_1",
                    "tool": "tool.x",
                    "params": {"p": "v"}
                }
            }
        }

        plan = PlanIR.from_dict(data)

        self.assertEqual(plan.plan_id, "plan_2")
        self.assertEqual(plan.base_ctx_id, "ctx_2")
        self.assertEqual(plan.version, "2.0")
        self.assertEqual(plan.metadata, {"note": "test plan"})
        self.assertIn("task_1", plan.tasks)
        self.assertEqual(plan.tasks["task_1"].tool, "tool.x")

    def test_from_dict_handles_missing_optional_fields(self):
        """from_dict should handle missing optional fields with defaults."""
        data = {
            "plan_id": "plan_minimal",
            "base_ctx_id": "ctx_minimal"
        }

        plan = PlanIR.from_dict(data)

        self.assertEqual(plan.plan_id, "plan_minimal")
        self.assertEqual(plan.base_ctx_id, "ctx_minimal")
        self.assertEqual(plan.version, "1.0")
        self.assertEqual(plan.metadata, {})
        self.assertEqual(plan.tasks, {})

    def test_roundtrip_serialization(self):
        """Serializing and deserializing should preserve data."""
        original = PlanIR(
            plan_id="plan_roundtrip",
            base_ctx_id="ctx_roundtrip",
            tasks={"task_1": self.task1, "task_2": self.task2},
            metadata={"test": "value"},
            version="1.5"
        )

        data = original.to_dict()
        reconstructed = PlanIR.from_dict(data)

        self.assertEqual(reconstructed.plan_id, original.plan_id)
        self.assertEqual(reconstructed.base_ctx_id, original.base_ctx_id)
        self.assertEqual(reconstructed.version, original.version)
        self.assertEqual(reconstructed.metadata, original.metadata)
        self.assertEqual(set(reconstructed.tasks.keys()), set(original.tasks.keys()))


class TestPlanIRValidation(unittest.TestCase):
    """Test PlanIR validation logic."""

    def test_validate_accepts_valid_plan(self):
        """Valid plan should pass validation without errors."""
        task1 = TaskDef(task_id="task_1", tool="tool.a")
        task2 = TaskDef(task_id="task_2", tool="tool.b", depends_on=["task_1"])

        plan = PlanIR(
            plan_id="plan_valid",
            base_ctx_id="ctx_1",
            tasks={"task_1": task1, "task_2": task2}
        )

        plan.validate()

    def test_validate_rejects_task_without_tool(self):
        """Task without tool should fail validation."""
        task = TaskDef(task_id="task_no_tool", tool="")

        plan = PlanIR(
            plan_id="plan_invalid",
            base_ctx_id="ctx_1",
            tasks={"task_no_tool": task}
        )

        with self.assertRaises(ValueError) as cm:
            plan.validate()

        self.assertIn("task_no_tool", str(cm.exception))
        self.assertIn("missing tool", str(cm.exception))

    def test_validate_rejects_unknown_dependency(self):
        """Task depending on unknown task should fail validation."""
        task = TaskDef(task_id="task_1", tool="tool.a", depends_on=["unknown_task"])

        plan = PlanIR(
            plan_id="plan_invalid",
            base_ctx_id="ctx_1",
            tasks={"task_1": task}
        )

        with self.assertRaises(ValueError) as cm:
            plan.validate()

        self.assertIn("task_1", str(cm.exception))
        self.assertIn("unknown_task", str(cm.exception))

    def test_validate_rejects_negative_retries(self):
        """Task with negative retries should fail validation."""
        task = TaskDef(task_id="task_1", tool="tool.a", retries=-1)

        plan = PlanIR(
            plan_id="plan_invalid",
            base_ctx_id="ctx_1",
            tasks={"task_1": task}
        )

        with self.assertRaises(ValueError) as cm:
            plan.validate()

        self.assertIn("task_1", str(cm.exception))
        self.assertIn("retries", str(cm.exception))
        self.assertIn("negative", str(cm.exception))

    def test_validate_detects_circular_dependency(self):
        """Circular dependencies should fail validation."""
        task1 = TaskDef(task_id="task_1", tool="tool.a", depends_on=["task_2"])
        task2 = TaskDef(task_id="task_2", tool="tool.b", depends_on=["task_1"])

        plan = PlanIR(
            plan_id="plan_circular",
            base_ctx_id="ctx_1",
            tasks={"task_1": task1, "task_2": task2}
        )

        with self.assertRaises(ValueError) as cm:
            plan.validate()

        self.assertIn("Cycle", str(cm.exception))

    def test_validate_detects_self_dependency(self):
        """Task depending on itself should fail validation."""
        task = TaskDef(task_id="task_1", tool="tool.a", depends_on=["task_1"])

        plan = PlanIR(
            plan_id="plan_self_dep",
            base_ctx_id="ctx_1",
            tasks={"task_1": task}
        )

        with self.assertRaises(ValueError) as cm:
            plan.validate()

        self.assertIn("Cycle", str(cm.exception))

    def test_validate_detects_complex_cycle(self):
        """Complex circular dependency chain should fail validation."""
        task1 = TaskDef(task_id="task_1", tool="tool.a", depends_on=[])
        task2 = TaskDef(task_id="task_2", tool="tool.b", depends_on=["task_1"])
        task3 = TaskDef(task_id="task_3", tool="tool.c", depends_on=["task_2"])
        task4 = TaskDef(task_id="task_4", tool="tool.d", depends_on=["task_3", "task_1"])
        task2.depends_on.append("task_4")

        plan = PlanIR(
            plan_id="plan_complex_cycle",
            base_ctx_id="ctx_1",
            tasks={"task_1": task1, "task_2": task2, "task_3": task3, "task_4": task4}
        )

        with self.assertRaises(ValueError) as cm:
            plan.validate()

        self.assertIn("Cycle", str(cm.exception))


class TestPlanIRTopologicalOrdering(unittest.TestCase):
    """Test topological ordering of tasks."""

    def test_topological_order_simple_chain(self):
        """Simple dependency chain should be ordered correctly."""
        task1 = TaskDef(task_id="task_1", tool="tool.a")
        task2 = TaskDef(task_id="task_2", tool="tool.b", depends_on=["task_1"])
        task3 = TaskDef(task_id="task_3", tool="tool.c", depends_on=["task_2"])

        plan = PlanIR(
            plan_id="plan_chain",
            base_ctx_id="ctx_1",
            tasks={"task_1": task1, "task_2": task2, "task_3": task3}
        )

        order = plan.topological_order()

        self.assertEqual(order, ["task_1", "task_2", "task_3"])

    def test_topological_order_parallel_tasks(self):
        """Independent tasks should be ordered with dependencies respected."""
        task1 = TaskDef(task_id="task_1", tool="tool.a")
        task2 = TaskDef(task_id="task_2", tool="tool.b")
        task3 = TaskDef(task_id="task_3", tool="tool.c", depends_on=["task_1", "task_2"])

        plan = PlanIR(
            plan_id="plan_parallel",
            base_ctx_id="ctx_1",
            tasks={"task_1": task1, "task_2": task2, "task_3": task3}
        )

        order = plan.topological_order()

        self.assertEqual(len(order), 3)
        self.assertEqual(order[2], "task_3")
        self.assertIn("task_1", order[:2])
        self.assertIn("task_2", order[:2])

    def test_topological_order_complex_dag(self):
        """Complex DAG should respect all dependencies."""
        task1 = TaskDef(task_id="task_1", tool="tool.a")
        task2 = TaskDef(task_id="task_2", tool="tool.b", depends_on=["task_1"])
        task3 = TaskDef(task_id="task_3", tool="tool.c", depends_on=["task_1"])
        task4 = TaskDef(task_id="task_4", tool="tool.d", depends_on=["task_2", "task_3"])

        plan = PlanIR(
            plan_id="plan_dag",
            base_ctx_id="ctx_1",
            tasks={"task_1": task1, "task_2": task2, "task_3": task3, "task_4": task4}
        )

        order = plan.topological_order()

        self.assertEqual(len(order), 4)
        self.assertEqual(order[0], "task_1") 
        self.assertEqual(order[3], "task_4") 
        self.assertIn("task_2", order[1:3])
        self.assertIn("task_3", order[1:3])

    def test_topological_order_single_task(self):
        """Single task should return single-element list."""
        task = TaskDef(task_id="task_only", tool="tool.a")

        plan = PlanIR(
            plan_id="plan_single",
            base_ctx_id="ctx_1",
            tasks={"task_only": task}
        )

        order = plan.topological_order()

        self.assertEqual(order, ["task_only"])

    def test_topological_order_empty_plan(self):
        """Empty plan should return empty list."""
        plan = PlanIR(
            plan_id="plan_empty",
            base_ctx_id="ctx_1",
            tasks={}
        )

        order = plan.topological_order()

        self.assertEqual(order, [])

    def test_topological_order_validates_before_ordering(self):
        """topological_order should call validate first."""
        task = TaskDef(task_id="task_invalid", tool="")

        plan = PlanIR(
            plan_id="plan_invalid",
            base_ctx_id="ctx_1",
            tasks={"task_invalid": task}
        )

        with self.assertRaises(ValueError):
            plan.topological_order()


class TestPlanIRFingerprint(unittest.TestCase):
    """Test plan fingerprinting for change detection."""

    def test_fingerprint_is_deterministic(self):
        """Same plan should produce same fingerprint."""
        task1 = TaskDef(task_id="task_1", tool="tool.a", params={"x": 1})
        plan = PlanIR(
            plan_id="plan_1",
            base_ctx_id="ctx_1",
            tasks={"task_1": task1}
        )

        fp1 = plan.fingerprint()
        fp2 = plan.fingerprint()

        self.assertEqual(fp1, fp2)

    def test_fingerprint_changes_with_task_params(self):
        """Different task params should produce different fingerprint."""
        task1 = TaskDef(task_id="task_1", tool="tool.a", params={"x": 1})
        task2 = TaskDef(task_id="task_1", tool="tool.a", params={"x": 2})

        plan1 = PlanIR(plan_id="plan_1", base_ctx_id="ctx_1", tasks={"task_1": task1})
        plan2 = PlanIR(plan_id="plan_1", base_ctx_id="ctx_1", tasks={"task_1": task2})

        self.assertNotEqual(plan1.fingerprint(), plan2.fingerprint())

    def test_fingerprint_changes_with_dependencies(self):
        """Different dependencies should produce different fingerprint."""
        task1 = TaskDef(task_id="task_1", tool="tool.a")
        task2 = TaskDef(task_id="task_1", tool="tool.a", depends_on=["task_0"])

        plan1 = PlanIR(plan_id="plan_1", base_ctx_id="ctx_1", tasks={"task_1": task1})
        plan2 = PlanIR(plan_id="plan_1", base_ctx_id="ctx_1", tasks={"task_1": task2})

        self.assertNotEqual(plan1.fingerprint(), plan2.fingerprint())

    def test_fingerprint_is_stable_across_dict_key_order(self):
        """Fingerprint should be stable regardless of dict key order."""
        task1 = TaskDef(task_id="task_1", tool="tool.a", params={"b": 2, "a": 1})
        task2 = TaskDef(task_id="task_1", tool="tool.a", params={"a": 1, "b": 2})

        plan1 = PlanIR(plan_id="plan_1", base_ctx_id="ctx_1", tasks={"task_1": task1})
        plan2 = PlanIR(plan_id="plan_1", base_ctx_id="ctx_1", tasks={"task_1": task2})

        self.assertEqual(plan1.fingerprint(), plan2.fingerprint())

    def test_fingerprint_returns_hex_string(self):
        """Fingerprint should return hex-encoded hash."""
        task = TaskDef(task_id="task_1", tool="tool.a")
        plan = PlanIR(plan_id="plan_1", base_ctx_id="ctx_1", tasks={"task_1": task})

        fp = plan.fingerprint()

        self.assertIsInstance(fp, str)
        self.assertEqual(len(fp), 64)  
        int(fp, 16)  


if __name__ == "__main__":
    unittest.main()
