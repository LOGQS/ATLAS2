"""Comprehensive unit tests for system.exec tool.

This module tests the command execution tool including:
- Basic command execution
- stdout/stderr capture
- Return code handling
- Timeout enforcement
- Working directory customization
- Environment variable control
- Shell selection
- Input/output handling
- Security validations
- Error cases and edge cases
"""

import sys
import tempfile
import unittest
import platform
from pathlib import Path

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.tools.tool_registry import ToolExecutionContext, ToolResult
from agents.tools.system_ops.exec_func import _tool_exec_command


class TestSystemExecTool(unittest.TestCase):
    """Test system.exec tool functionality."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_exec"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)
        self.is_windows = platform.system() == "Windows"

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_exec_simple_command(self):
        """Should execute a simple command successfully."""
        if self.is_windows:
            result = _tool_exec_command({"command": "echo Hello"}, self.ctx)
        else:
            result = _tool_exec_command({"command": "echo 'Hello'"}, self.ctx)

        self.assertIsInstance(result, ToolResult)
        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["return_code"], 0)
        self.assertIn("Hello", result.output["stdout"])

    def test_exec_command_with_stdout(self):
        """Should capture stdout correctly."""
        if self.is_windows:
            result = _tool_exec_command(
                {"command": "echo Test Output"},
                self.ctx
            )
        else:
            result = _tool_exec_command(
                {"command": "echo 'Test Output'"},
                self.ctx
            )

        self.assertEqual(result.output["status"], "success")
        self.assertIn("Test Output", result.output["stdout"])

    def test_exec_command_with_return_code(self):
        """Should capture non-zero return codes."""
        if self.is_windows:
            result = _tool_exec_command(
                {"command": "exit 42"},
                self.ctx
            )
        else:
            result = _tool_exec_command(
                {"command": "exit 42"},
                self.ctx
            )

        self.assertEqual(result.output["status"], "failed")
        self.assertEqual(result.output["return_code"], 42)
        self.assertIn("warnings", result.output)

    def test_exec_check_return_code_failure(self):
        """Should raise error when check_return_code=True and command fails."""
        with self.assertRaises(ValueError) as cm:
            if self.is_windows:
                _tool_exec_command(
                    {"command": "exit 1", "check_return_code": True},
                    self.ctx
                )
            else:
                _tool_exec_command(
                    {"command": "exit 1", "check_return_code": True},
                    self.ctx
                )

        self.assertIn("non-zero return code", str(cm.exception))

    def test_exec_check_return_code_success(self):
        """Should succeed when check_return_code=True and command succeeds."""
        if self.is_windows:
            result = _tool_exec_command(
                {"command": "echo Success", "check_return_code": True},
                self.ctx
            )
        else:
            result = _tool_exec_command(
                {"command": "echo 'Success'", "check_return_code": True},
                self.ctx
            )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["return_code"], 0)

    def test_exec_working_directory(self):
        """Should execute command in specified working directory."""
        test_file = self.temp_path / "marker.txt"
        test_file.write_text("marker", encoding='utf-8')

        if self.is_windows:
            result = _tool_exec_command(
                {
                    "command": "dir /b marker.txt",
                    "working_dir": str(self.temp_path)
                },
                self.ctx
            )
        else:
            result = _tool_exec_command(
                {
                    "command": "ls marker.txt",
                    "working_dir": str(self.temp_path)
                },
                self.ctx
            )

        self.assertEqual(result.output["status"], "success")
        self.assertIn("marker.txt", result.output["stdout"])

    def test_exec_invalid_working_directory(self):
        """Should raise error for non-existent working directory."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command(
                {
                    "command": "echo test",
                    "working_dir": "/nonexistent/directory/path"
                },
                self.ctx
            )

        self.assertIn("does not exist", str(cm.exception))

    def test_exec_environment_variables(self):
        """Should pass custom environment variables."""
        if self.is_windows:
            result = _tool_exec_command(
                {
                    "command": "echo %TEST_VAR%",
                    "env": {"TEST_VAR": "CustomValue"}
                },
                self.ctx
            )
        else:
            result = _tool_exec_command(
                {
                    "command": "echo $TEST_VAR",
                    "env": {"TEST_VAR": "CustomValue"}
                },
                self.ctx
            )

        self.assertEqual(result.output["status"], "success")
        self.assertIn("CustomValue", result.output["stdout"])

    def test_exec_invalid_env_type(self):
        """Should raise error for non-dict environment variables."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command(
                {
                    "command": "echo test",
                    "env": "not_a_dict"
                },
                self.ctx
            )

        self.assertIn("must be a dictionary", str(cm.exception))

    def test_exec_invalid_env_key_type(self):
        """Should raise error for non-string environment variable keys."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command(
                {
                    "command": "echo test",
                    "env": {123: "value"}
                },
                self.ctx
            )

        self.assertIn("key must be string", str(cm.exception))

    def test_exec_invalid_env_value_type(self):
        """Should raise error for non-string environment variable values."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command(
                {
                    "command": "echo test",
                    "env": {"KEY": 123}
                },
                self.ctx
            )

        self.assertIn("value must be string", str(cm.exception))

    def test_exec_timeout(self):
        """Should timeout long-running commands."""
        with self.assertRaises(ValueError) as cm:
            if self.is_windows:
                _tool_exec_command(
                    {"command": "ping -n 15 127.0.0.1", "timeout": 1},
                    self.ctx
                )
            else:
                _tool_exec_command(
                    {"command": "sleep 10", "timeout": 1},
                    self.ctx
                )

        self.assertIn("timed out", str(cm.exception))

    def test_exec_timeout_validation(self):
        """Should validate timeout parameter."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command(
                {"command": "echo test", "timeout": -1},
                self.ctx
            )

        self.assertIn("must be a positive number", str(cm.exception))

    def test_exec_timeout_max_limit(self):
        """Should enforce maximum timeout limit."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command(
                {"command": "echo test", "timeout": 700},
                self.ctx
            )

        self.assertIn("cannot exceed 600", str(cm.exception))

    def test_exec_capture_output_false(self):
        """Should not capture output when capture_output=False."""
        result = _tool_exec_command(
            {
                "command": "echo 'No capture'",
                "capture_output": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertIsNone(result.output["stdout"])
        self.assertIsNone(result.output["stderr"])

    def test_exec_missing_command(self):
        """Should raise error when command is missing."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command({}, self.ctx)

        self.assertIn("command is required", str(cm.exception))

    def test_exec_empty_command(self):
        """Should raise error for empty command."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command({"command": ""}, self.ctx)

        error_msg = str(cm.exception)
        self.assertTrue("required" in error_msg or "empty" in error_msg)

    def test_exec_whitespace_command(self):
        """Should raise error for whitespace-only command."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command({"command": "   "}, self.ctx)

        self.assertIn("cannot be empty", str(cm.exception))

    def test_exec_non_string_command(self):
        """Should raise error for non-string command."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command({"command": 123}, self.ctx)

        self.assertIn("must be a string", str(cm.exception))

    def test_exec_dangerous_command_rm_rf(self):
        """Should block dangerous rm -rf / command."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command({"command": "rm -rf /"}, self.ctx)

        self.assertIn("destructive pattern", str(cm.exception))

    def test_exec_dangerous_command_mkfs(self):
        """Should block dangerous mkfs command."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command({"command": "mkfs.ext4 /dev/sda1"}, self.ctx)

        self.assertIn("destructive pattern", str(cm.exception))

    def test_exec_invalid_shell(self):
        """Should raise error for invalid shell type."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command(
                {"command": "echo test", "shell": "invalid_shell"},
                self.ctx
            )

        self.assertIn("shell must be one of", str(cm.exception))

    def test_exec_bash_shell(self):
        """Should execute command with bash shell."""
        if not self.is_windows:
            result = _tool_exec_command(
                {"command": "echo $SHELL", "shell": "bash"},
                self.ctx
            )

            self.assertEqual(result.output["status"], "success")
            self.assertEqual(result.output["metadata"]["shell"], "bash")

    def test_exec_command_with_pipes(self):
        """Should handle commands with pipes."""
        if self.is_windows:
            result = _tool_exec_command(
                {"command": "echo Hello | findstr Hello"},
                self.ctx
            )
        else:
            result = _tool_exec_command(
                {"command": "echo 'Hello' | grep Hello"},
                self.ctx
            )

        self.assertEqual(result.output["status"], "success")
        self.assertIn("Hello", result.output["stdout"])

    def test_exec_command_with_logical_and(self):
        """Should handle commands with && operator."""
        if self.is_windows:
            result = _tool_exec_command(
                {"command": "echo First && echo Second"},
                self.ctx
            )
        else:
            result = _tool_exec_command(
                {"command": "echo 'First' && echo 'Second'"},
                self.ctx
            )

        self.assertEqual(result.output["status"], "success")
        self.assertIn("First", result.output["stdout"])
        self.assertIn("Second", result.output["stdout"])

    def test_exec_command_with_semicolon(self):
        """Should handle commands with ; operator."""
        if self.is_windows:
            result = _tool_exec_command(
                {"command": "echo First & echo Second"},
                self.ctx
            )
        else:
            result = _tool_exec_command(
                {"command": "echo 'First'; echo 'Second'"},
                self.ctx
            )

        self.assertEqual(result.output["status"], "success")
        stdout = result.output["stdout"]
        self.assertIn("First", stdout)
        self.assertIn("Second", stdout)

    def test_exec_multiline_stdout(self):
        """Should handle commands with multiline output."""
        if self.is_windows:
            result = _tool_exec_command(
                {"command": "(echo Line1) && (echo Line2) && (echo Line3)"},
                self.ctx
            )
        else:
            result = _tool_exec_command(
                {"command": "echo 'Line1'; echo 'Line2'; echo 'Line3'"},
                self.ctx
            )

        self.assertEqual(result.output["status"], "success")
        self.assertGreater(result.output["metadata"]["stdout_lines"], 1)

    def test_exec_command_with_input(self):
        """Should pass input data to command stdin."""
        if not self.is_windows:
            result = _tool_exec_command(
                {
                    "command": "cat",
                    "input": "Input data\n"
                },
                self.ctx
            )

            self.assertEqual(result.output["status"], "success")
            self.assertIn("Input data", result.output["stdout"])

    def test_exec_invalid_input_type(self):
        """Should raise error for non-string input."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command(
                {"command": "cat", "input": 123},
                self.ctx
            )

        self.assertIn("input must be a string", str(cm.exception))

    def test_exec_metadata_includes_details(self):
        """Should include execution details in metadata."""
        result = _tool_exec_command(
            {
                "command": "echo test",
                "working_dir": str(self.temp_path),
                "timeout": 10
            },
            self.ctx
        )

        metadata = result.output["metadata"]
        self.assertIn("command", metadata)
        self.assertIn("working_dir", metadata)
        self.assertIn("shell", metadata)
        self.assertIn("timeout", metadata)
        self.assertEqual(metadata["timeout"], 10)

    def test_exec_truncates_long_command_in_metadata(self):
        """Should truncate very long commands in metadata."""
        long_command = "echo " + "x" * 300
        result = _tool_exec_command(
            {"command": long_command},
            self.ctx
        )

        self.assertLessEqual(
            len(result.output["metadata"]["command"]),
            203  
        )
        self.assertTrue(result.output["metadata"]["command"].endswith("..."))

    def test_exec_creates_file(self):
        """Should be able to create files."""
        test_file = self.temp_path / "created.txt"

        if self.is_windows:
            result = _tool_exec_command(
                {
                    "command": f"echo Test > {test_file.name}",
                    "working_dir": str(self.temp_path)
                },
                self.ctx
            )
        else:
            result = _tool_exec_command(
                {
                    "command": f"echo 'Test' > {test_file.name}",
                    "working_dir": str(self.temp_path)
                },
                self.ctx
            )

        self.assertEqual(result.output["status"], "success")
        self.assertTrue(test_file.exists())

    def test_exec_reads_file(self):
        """Should be able to read files."""
        test_file = self.temp_path / "read_test.txt"
        test_file.write_text("File Content", encoding='utf-8')

        if self.is_windows:
            result = _tool_exec_command(
                {
                    "command": f"type {test_file.name}",
                    "working_dir": str(self.temp_path)
                },
                self.ctx
            )
        else:
            result = _tool_exec_command(
                {
                    "command": f"cat {test_file.name}",
                    "working_dir": str(self.temp_path)
                },
                self.ctx
            )

        self.assertEqual(result.output["status"], "success")
        self.assertIn("File Content", result.output["stdout"])

    def test_exec_result_metadata_has_success_flag(self):
        """Should include success flag in result metadata."""
        result = _tool_exec_command(
            {"command": "echo test"},
            self.ctx
        )

        self.assertTrue(result.metadata["success"])
        self.assertEqual(result.metadata["return_code"], 0)

    def test_exec_result_metadata_failure_flag(self):
        """Should mark success as False for failed commands."""
        result = _tool_exec_command(
            {"command": "exit 1"},
            self.ctx
        )

        self.assertFalse(result.metadata["success"])
        self.assertEqual(result.metadata["return_code"], 1)

    def test_exec_warns_on_stderr_output(self):
        """Should warn when command produces many stderr lines."""
        if not self.is_windows:
            many_lines = "; ".join([f"echo 'Error {i}' >&2" for i in range(150)])
            result = _tool_exec_command(
                {"command": many_lines},
                self.ctx
            )

            if result.output["metadata"]["stderr_lines"] > 100:
                self.assertIn("warnings", result.output)

    def test_exec_default_timeout(self):
        """Should use default timeout of 30 seconds."""
        result = _tool_exec_command(
            {"command": "echo test"},
            self.ctx
        )

        self.assertEqual(result.output["metadata"]["timeout"], 30)

    def test_exec_custom_timeout(self):
        """Should use custom timeout when specified."""
        result = _tool_exec_command(
            {"command": "echo test", "timeout": 60},
            self.ctx
        )

        self.assertEqual(result.output["metadata"]["timeout"], 60)

    def test_exec_default_working_dir(self):
        """Should use current directory as default working_dir."""
        result = _tool_exec_command(
            {"command": "echo test"},
            self.ctx
        )

        self.assertIsNotNone(result.output["metadata"]["working_dir"])

    def test_exec_quick_command_within_timeout(self):
        """Should complete quick commands well within timeout."""
        result = _tool_exec_command(
            {"command": "echo quick", "timeout": 5},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")

    def test_exec_command_not_found(self):
        """Should handle when command executable not found."""
        try:
            result = _tool_exec_command(
                {"command": "nonexistentcommand12345"},
                self.ctx
            )
            if self.is_windows:
                self.assertEqual(result.output["status"], "failed")
        except ValueError:
            pass  


    def test_exec_run_in_background(self):
        """Should run command in background and return job_id."""
        if self.is_windows:
            result = _tool_exec_command(
                {"command": "timeout /t 2", "run_in_background": True},
                self.ctx
            )
        else:
            result = _tool_exec_command(
                {"command": "sleep 2", "run_in_background": True},
                self.ctx
            )

        self.assertEqual(result.output["status"], "started")
        self.assertIn("job_id", result.output)
        self.assertIn("pid", result.output)
        self.assertTrue(result.metadata["background"])

    def test_exec_background_with_input_error(self):
        """Should raise error when using input with run_in_background."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command(
                {
                    "command": "cat",
                    "run_in_background": True,
                    "input": "test data"
                },
                self.ctx
            )

        self.assertIn("input parameter cannot be used", str(cm.exception))

    def test_exec_background_with_check_return_code_error(self):
        """Should raise error when using check_return_code with run_in_background."""
        with self.assertRaises(ValueError) as cm:
            _tool_exec_command(
                {
                    "command": "echo test",
                    "run_in_background": True,
                    "check_return_code": True
                },
                self.ctx
            )

        self.assertIn("check_return_code cannot be True", str(cm.exception))

    def test_exec_show_window_parameter(self):
        """Should accept show_window parameter without error."""
        result = _tool_exec_command(
            {"command": "echo test", "show_window": True},
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")

    def test_exec_background_capture_output(self):
        """Should start background process with output capture."""
        result = _tool_exec_command(
            {
                "command": "echo background test",
                "run_in_background": True,
                "capture_output": True
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "started")
        self.assertIn("job_id", result.output)

    def test_exec_background_no_capture_output(self):
        """Should start background process without output capture."""
        result = _tool_exec_command(
            {
                "command": "echo background test",
                "run_in_background": True,
                "capture_output": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "started")
        self.assertIn("job_id", result.output)


if __name__ == "__main__":
    unittest.main()
