"""Comprehensive unit tests for system.exec management tools.

This module tests background job management tools including:
- system.exec_status: Monitor running processes and retrieve output
- system.exec_kill: Terminate background processes
- system.exec_list: List all background jobs
- system.exec_wait: Wait for job completion with timeout
"""

import sys
import time
import unittest
import platform
from pathlib import Path

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.tools.tool_registry import ToolExecutionContext
from agents.tools.system_ops.exec_func import _tool_exec_command, _background_jobs
from agents.tools.system_ops.exec_manage_func import (
    _tool_exec_status,
    _tool_exec_kill,
    _tool_exec_list,
    _tool_exec_wait
)


class TestSystemExecStatusTool(unittest.TestCase):
    """Test system.exec_status tool functionality."""

    def setUp(self):
        """Create test context and clean up background jobs."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_status"
        )

        _background_jobs.clear()
        self.is_windows = platform.system() == "Windows"

    def tearDown(self):
        """Clean up background jobs."""
        for job_id, job in list(_background_jobs.items()):
            try:
                job.process.terminate()
                job.process.wait(timeout=5)
            except:
                pass
        _background_jobs.clear()

    def test_status_running_job(self):
        """Should return status of a running job."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "timeout /t 5", "run_in_background": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "sleep 5", "run_in_background": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]

        status_result = _tool_exec_status(
            {"job_id": job_id},
            self.ctx
        )

        self.assertEqual(status_result.output["status"], "running")
        self.assertEqual(status_result.output["job_id"], job_id)
        self.assertTrue(status_result.output["running"])
        self.assertGreater(status_result.output["runtime_seconds"], 0)

    def test_status_completed_job(self):
        """Should return status of a completed job."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "echo done", "run_in_background": True, "capture_output": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "echo 'done'", "run_in_background": True, "capture_output": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]

        time.sleep(0.5)

        status_result = _tool_exec_status(
            {"job_id": job_id},
            self.ctx
        )

        self.assertEqual(status_result.output["status"], "completed")
        self.assertFalse(status_result.output["running"])
        self.assertEqual(status_result.output["return_code"], 0)

    def test_status_with_output(self):
        """Should retrieve stdout from completed job."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "echo Test Output", "run_in_background": True, "capture_output": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "echo 'Test Output'", "run_in_background": True, "capture_output": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]
        time.sleep(0.5)

        status_result = _tool_exec_status(
            {"job_id": job_id},
            self.ctx
        )

        self.assertIsNotNone(status_result.output["stdout"])
        self.assertIn("Test Output", status_result.output["stdout"])

    def test_status_nonexistent_job(self):
        """Should raise error for nonexistent job."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_status(
                {"job_id": "nonexistent_job_123"},
                self.ctx
            )

        self.assertIn("not found", str(cm.exception))

    def test_status_missing_job_id(self):
        """Should raise error when job_id is missing."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_status({}, self.ctx)

        self.assertIn("job_id is required", str(cm.exception))

    def test_status_cleanup_if_done(self):
        """Should clean up completed job when requested."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "echo done", "run_in_background": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "echo 'done'", "run_in_background": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]
        time.sleep(0.5)

        status_result = _tool_exec_status(
            {"job_id": job_id, "cleanup_if_done": True},
            self.ctx
        )

        self.assertTrue(status_result.output["metadata"]["cleaned_up"])
        self.assertNotIn(job_id, _background_jobs)

    def test_status_incremental_output(self):
        """Should support incremental output reading."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "echo Line1 && timeout /t 1 && echo Line2", "run_in_background": True, "capture_output": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "echo 'Line1'; sleep 0.5; echo 'Line2'", "run_in_background": True, "capture_output": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]
        time.sleep(0.3)

        status1 = _tool_exec_status(
            {"job_id": job_id, "incremental": True},
            self.ctx
        )

        time.sleep(0.8)

        status2 = _tool_exec_status(
            {"job_id": job_id, "incremental": True},
            self.ctx
        )

        has_output = (status1.output.get("stdout") or status2.output.get("stdout"))
        self.assertIsNotNone(has_output)


class TestSystemExecKillTool(unittest.TestCase):
    """Test system.exec_kill tool functionality."""

    def setUp(self):
        """Create test context and clean up background jobs."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_kill"
        )
        _background_jobs.clear()
        self.is_windows = platform.system() == "Windows"

    def tearDown(self):
        """Clean up background jobs."""
        for job_id, job in list(_background_jobs.items()):
            try:
                job.process.terminate()
                job.process.wait(timeout=5)
            except:
                pass
        _background_jobs.clear()

    def test_kill_running_job(self):
        """Should terminate a running job."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "timeout /t 30", "run_in_background": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "sleep 30", "run_in_background": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]

        kill_result = _tool_exec_kill(
            {"job_id": job_id},
            self.ctx
        )

        self.assertEqual(kill_result.output["status"], "terminated")
        self.assertEqual(kill_result.output["job_id"], job_id)
        self.assertTrue(kill_result.output["terminated_successfully"])
        self.assertNotIn(job_id, _background_jobs)

    def test_kill_already_terminated(self):
        """Should handle job that's already terminated."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "echo done", "run_in_background": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "echo 'done'", "run_in_background": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]
        time.sleep(0.5)

        kill_result = _tool_exec_kill(
            {"job_id": job_id},
            self.ctx
        )

        self.assertEqual(kill_result.output["status"], "already_terminated")
        self.assertIsNotNone(kill_result.output["return_code"])

    def test_kill_nonexistent_job(self):
        """Should raise error for nonexistent job."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_kill(
                {"job_id": "nonexistent_job"},
                self.ctx
            )

        self.assertIn("not found", str(cm.exception))

    def test_kill_missing_job_id(self):
        """Should raise error when job_id is missing."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_kill({}, self.ctx)

        self.assertIn("job_id is required", str(cm.exception))

    def test_kill_force_parameter(self):
        """Should accept force parameter."""
        if not self.is_windows:
            start_result = _tool_exec_command(
                {"command": "sleep 10", "run_in_background": True},
                self.ctx
            )

            job_id = start_result.output["job_id"]

            kill_result = _tool_exec_kill(
                {"job_id": job_id, "force": True},
                self.ctx
            )

            self.assertEqual(kill_result.output["status"], "terminated")
            self.assertTrue(kill_result.metadata["force"])

    def test_kill_timeout_validation(self):
        """Should validate timeout parameter."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "timeout /t 10", "run_in_background": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "sleep 10", "run_in_background": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]

        with self.assertRaises(ValueError) as cm:
            _tool_exec_kill(
                {"job_id": job_id, "timeout": 100},
                self.ctx
            )

        self.assertIn("cannot exceed 60", str(cm.exception))


class TestSystemExecListTool(unittest.TestCase):
    """Test system.exec_list tool functionality."""

    def setUp(self):
        """Create test context and clean up background jobs."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_list"
        )
        _background_jobs.clear()
        self.is_windows = platform.system() == "Windows"

    def tearDown(self):
        """Clean up background jobs."""
        for job_id, job in list(_background_jobs.items()):
            try:
                job.process.terminate()
                job.process.wait(timeout=5)
            except:
                pass
        _background_jobs.clear()

    def test_list_empty(self):
        """Should return empty list when no jobs."""
        list_result = _tool_exec_list({}, self.ctx)

        self.assertEqual(list_result.output["status"], "success")
        self.assertEqual(len(list_result.output["jobs"]), 0)
        self.assertEqual(list_result.output["summary"]["total_jobs"], 0)

    def test_list_running_jobs(self):
        """Should list running jobs."""
        if self.is_windows:
            _tool_exec_command({"command": "timeout /t 10", "run_in_background": True}, self.ctx)
            _tool_exec_command({"command": "timeout /t 10", "run_in_background": True}, self.ctx)
        else:
            _tool_exec_command({"command": "sleep 10", "run_in_background": True}, self.ctx)
            _tool_exec_command({"command": "sleep 10", "run_in_background": True}, self.ctx)

        list_result = _tool_exec_list({}, self.ctx)

        self.assertEqual(len(list_result.output["jobs"]), 2)
        self.assertEqual(list_result.output["summary"]["total_jobs"], 2)

        for job in list_result.output["jobs"]:
            self.assertIn("job_id", job)
            self.assertIn("pid", job)
            self.assertIn("status", job)
            self.assertEqual(job["status"], "running")

    def test_list_completed_jobs(self):
        """Should list completed jobs."""
        if self.is_windows:
            _tool_exec_command({"command": "echo done", "run_in_background": True}, self.ctx)
            _tool_exec_command({"command": "echo done", "run_in_background": True}, self.ctx)
        else:
            _tool_exec_command({"command": "echo 'done'", "run_in_background": True}, self.ctx)
            _tool_exec_command({"command": "echo 'done'", "run_in_background": True}, self.ctx)

        time.sleep(0.5)

        list_result = _tool_exec_list({}, self.ctx)

        self.assertEqual(len(list_result.output["jobs"]), 2)
        for job in list_result.output["jobs"]:
            self.assertEqual(job["status"], "completed")
            self.assertEqual(job["return_code"], 0)

    def test_list_filter_by_status(self):
        """Should filter jobs by status."""
        if self.is_windows:
            _tool_exec_command({"command": "echo done", "run_in_background": True}, self.ctx)
            _tool_exec_command({"command": "ping -n 15 127.0.0.1", "run_in_background": True}, self.ctx)
        else:
            _tool_exec_command({"command": "echo 'done'", "run_in_background": True}, self.ctx)
            _tool_exec_command({"command": "sleep 10", "run_in_background": True}, self.ctx)

        time.sleep(0.5)

        list_result = _tool_exec_list(
            {"filter_status": "running"},
            self.ctx
        )

        self.assertGreaterEqual(len(list_result.output["jobs"]), 1)
        for job in list_result.output["jobs"]:
            self.assertEqual(job["status"], "running")

    def test_list_cleanup_completed(self):
        """Should clean up completed jobs when requested."""
        if self.is_windows:
            _tool_exec_command({"command": "echo done", "run_in_background": True}, self.ctx)
            _tool_exec_command({"command": "echo done", "run_in_background": True}, self.ctx)
        else:
            _tool_exec_command({"command": "echo 'done'", "run_in_background": True}, self.ctx)
            _tool_exec_command({"command": "echo 'done'", "run_in_background": True}, self.ctx)

        time.sleep(0.5)

        list_result = _tool_exec_list(
            {"cleanup_completed": True},
            self.ctx
        )

        self.assertGreater(list_result.output["summary"]["cleaned_up"], 0)
        self.assertEqual(len(_background_jobs), 0)

    def test_list_invalid_filter(self):
        """Should raise error for invalid filter_status."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_list(
                {"filter_status": "invalid_status"},
                self.ctx
            )

        self.assertIn("filter_status must be", str(cm.exception))


class TestSystemExecWaitTool(unittest.TestCase):
    """Test system.exec_wait tool functionality."""

    def setUp(self):
        """Create test context and clean up background jobs."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_wait"
        )
        _background_jobs.clear()
        self.is_windows = platform.system() == "Windows"

    def tearDown(self):
        """Clean up background jobs."""
        for job_id, job in list(_background_jobs.items()):
            try:
                job.process.terminate()
                job.process.wait(timeout=5)
            except:
                pass
        _background_jobs.clear()

    def test_wait_for_completion(self):
        """Should wait for job to complete."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "timeout /t 1", "run_in_background": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "sleep 1", "run_in_background": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]

        wait_result = _tool_exec_wait(
            {"job_id": job_id, "timeout": 5},
            self.ctx
        )

        self.assertIn(wait_result.output["status"], ["completed", "failed"])
        self.assertFalse(wait_result.output["running"])
        self.assertIsNotNone(wait_result.output["return_code"])
        self.assertGreater(wait_result.output["wait_time_seconds"], 0)

    def test_wait_timeout(self):
        """Should timeout if job takes too long."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "ping -n 15 127.0.0.1", "run_in_background": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "sleep 10", "run_in_background": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]

        wait_result = _tool_exec_wait(
            {"job_id": job_id, "timeout": 1},
            self.ctx
        )

        self.assertEqual(wait_result.output["status"], "timeout")
        self.assertTrue(wait_result.output["running"])
        self.assertTrue(wait_result.output["metadata"]["timed_out"])

    def test_wait_already_completed(self):
        """Should return immediately if job already completed."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "echo done", "run_in_background": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "echo 'done'", "run_in_background": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]
        time.sleep(0.5)

        wait_result = _tool_exec_wait(
            {"job_id": job_id, "timeout": 10},
            self.ctx
        )

        self.assertEqual(wait_result.output["status"], "completed")
        self.assertLess(wait_result.output["wait_time_seconds"], 1)

    def test_wait_cleanup_after_wait(self):
        """Should clean up job after waiting."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "echo done", "run_in_background": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "echo 'done'", "run_in_background": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]

        wait_result = _tool_exec_wait(
            {"job_id": job_id, "timeout": 5, "cleanup_after_wait": True},
            self.ctx
        )

        self.assertTrue(wait_result.output["metadata"]["cleaned_up"])
        self.assertNotIn(job_id, _background_jobs)

    def test_wait_no_cleanup(self):
        """Should not clean up job if cleanup_after_wait=False."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "echo done", "run_in_background": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "echo 'done'", "run_in_background": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]

        wait_result = _tool_exec_wait(
            {"job_id": job_id, "timeout": 5, "cleanup_after_wait": False},
            self.ctx
        )

        self.assertFalse(wait_result.output["metadata"]["cleaned_up"])
        self.assertIn(job_id, _background_jobs)

    def test_wait_nonexistent_job(self):
        """Should raise error for nonexistent job."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_wait(
                {"job_id": "nonexistent_job", "timeout": 5},
                self.ctx
            )

        self.assertIn("not found", str(cm.exception))

    def test_wait_missing_job_id(self):
        """Should raise error when job_id is missing."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_wait({"timeout": 5}, self.ctx)

        self.assertIn("job_id is required", str(cm.exception))

    def test_wait_invalid_timeout(self):
        """Should validate timeout parameter."""
        if self.is_windows:
            start_result = _tool_exec_command(
                {"command": "echo done", "run_in_background": True},
                self.ctx
            )
        else:
            start_result = _tool_exec_command(
                {"command": "echo 'done'", "run_in_background": True},
                self.ctx
            )

        job_id = start_result.output["job_id"]

        with self.assertRaises(ValueError) as cm:
            _tool_exec_wait(
                {"job_id": job_id, "timeout": 5000},
                self.ctx
            )

        self.assertIn("cannot exceed 3600", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
