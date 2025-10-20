from __future__ import annotations

import os
import platform
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec
from ..file_ops.file_utils import validate_directory_path

_logger = get_logger(__name__)


@dataclass
class BackgroundJob:
    """Tracks a background process."""
    job_id: str
    process: subprocess.Popen
    command: str
    working_dir: str
    shell: str
    start_time: float
    capture_output: bool
    stdout_buffer: list = field(default_factory=list)
    stderr_buffer: list = field(default_factory=list)
    last_stdout_pos: int = 0
    last_stderr_pos: int = 0


_background_jobs: Dict[str, BackgroundJob] = {}


def _get_default_shell() -> str:
    """Get the default shell based on the operating system."""
    system = platform.system()
    if system == "Windows":
        return "cmd"
    else:
        return "bash"


def _validate_command(command: str) -> tuple[bool, str]:
    """
    Validate command for basic security checks.
    Returns (is_valid, error_message).
    """
    if not command or not command.strip():
        return False, "command cannot be empty"

    dangerous_patterns = [
        "rm -rf /",
        "rm -rf /*",
        "mkfs.",
        "dd if=/dev/zero",
        "> /dev/sda",
        ":(){ :|:& };:", 
    ]

    command_lower = command.lower().strip()
    for pattern in dangerous_patterns:
        if pattern in command_lower:
            return False, f"command contains potentially destructive pattern: '{pattern}'"

    return True, ""


def _tool_exec_command(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Execute a shell command and return its output.

    This tool:
    - Executes commands in a subprocess
    - Supports custom working directory
    - Allows environment variable customization
    - Enforces timeout limits
    - Captures stdout and stderr separately
    - Validates command safety
    - Returns exit code and output
    """
    command = params.get("command")
    workspace_root = ctx.workspace_path
    working_dir = params.get("working_dir", ".")
    env_vars = params.get("env", {})
    timeout_seconds = params.get("timeout", 30)
    shell_type = params.get("shell", _get_default_shell())
    capture_output = params.get("capture_output", True)
    check_return_code = params.get("check_return_code", False)
    input_data = params.get("input")
    run_in_background = params.get("run_in_background", False)
    show_window = params.get("show_window", False)

    if command is None or command == "":
        raise ValueError("command is required and cannot be empty")

    if not isinstance(command, str):
        raise ValueError(f"command must be a string, got {type(command).__name__}")

    is_valid_cmd, error_msg = _validate_command(command)
    if not is_valid_cmd:
        raise ValueError(f"Invalid command: {error_msg}")

    if not isinstance(timeout_seconds, (int, float)) or timeout_seconds <= 0:
        raise ValueError(
            f"timeout must be a positive number (seconds), got {timeout_seconds}"
        )

    if timeout_seconds > 600:
        raise ValueError(
            f"timeout cannot exceed 600 seconds (10 minutes), got {timeout_seconds}"
        )

    is_valid_dir, error_msg, working_dir_resolved = validate_directory_path(
        working_dir,
        must_exist=True,
        workspace_root=workspace_root,
    )
    if not is_valid_dir:
        raise ValueError(f"Invalid working_dir: {error_msg}")

    valid_shells = ["bash", "sh", "zsh", "fish", "cmd", "powershell", "pwsh"]
    if shell_type not in valid_shells:
        raise ValueError(
            f"shell must be one of {valid_shells}, got '{shell_type}'"
        )

    if env_vars and not isinstance(env_vars, dict):
        raise ValueError(
            f"env must be a dictionary of environment variables, got {type(env_vars).__name__}"
        )

    if input_data is not None and not isinstance(input_data, str):
        raise ValueError(
            f"input must be a string, got {type(input_data).__name__}"
        )

    exec_env = os.environ.copy()
    if env_vars:
        for key, value in env_vars.items():
            if not isinstance(key, str):
                raise ValueError(f"Environment variable key must be string, got {type(key).__name__}")
            if not isinstance(value, str):
                raise ValueError(f"Environment variable value must be string, got {type(value).__name__}")
            exec_env[key] = value

    system = platform.system()

    if system == "Windows":
        if shell_type == "powershell" or shell_type == "pwsh":
            exec_command = [shell_type, "-NoProfile", "-Command", command]
        elif shell_type == "cmd":
            exec_command = ["cmd", "/c", command]
        else:
            _logger.warning(f"Shell '{shell_type}' may not be available on Windows, using cmd")
            exec_command = ["cmd", "/c", command]
    else:
        if shell_type in ["bash", "sh", "zsh", "fish"]:
            exec_command = [shell_type, "-c", command]
        elif shell_type in ["powershell", "pwsh"]:
            exec_command = [shell_type, "-NoProfile", "-Command", command]
        elif shell_type == "cmd":
            _logger.warning("Shell 'cmd' is Windows-specific, using bash")
            exec_command = ["bash", "-c", command]
        else:
            exec_command = [shell_type, "-c", command]

    creation_flags = 0
    if system == "Windows":
        if show_window:
            creation_flags = subprocess.CREATE_NEW_CONSOLE
        else:
            creation_flags = subprocess.CREATE_NO_WINDOW

    _logger.info(
        f"Executing command ({'background' if run_in_background else 'foreground'}, "
        f"window {'visible' if show_window else 'hidden'}) in {working_dir}: "
        f"{command[:100]}{'...' if len(command) > 100 else ''}"
    )

    if run_in_background:
        if input_data:
            raise ValueError(
                "input parameter cannot be used with run_in_background=True. "
                "Background processes cannot receive stdin input."
            )

        if check_return_code:
            raise ValueError(
                "check_return_code cannot be True with run_in_background=True. "
                "Return code checking requires waiting for process completion."
            )

        try:
            popen_kwargs = {
                "cwd": str(working_dir_resolved),
                "env": exec_env,
            }

            if system == "Windows":
                popen_kwargs["creationflags"] = creation_flags

            if capture_output:
                popen_kwargs["stdout"] = subprocess.PIPE
                popen_kwargs["stderr"] = subprocess.PIPE
                popen_kwargs["text"] = True

            process = subprocess.Popen(exec_command, **popen_kwargs)

            job_id = f"job_{uuid.uuid4().hex[:12]}"

            job = BackgroundJob(
                job_id=job_id,
                process=process,
                command=command,
                working_dir=str(working_dir_resolved),
                shell=shell_type,
                start_time=time.time(),
                capture_output=capture_output
            )
            _background_jobs[job_id] = job

            _logger.info(f"Started background process with job_id={job_id}, pid={process.pid}")

            return ToolResult(
                output={
                    "status": "started",
                    "job_id": job_id,
                    "pid": process.pid,
                    "message": "Command started in background. Use system.exec_status to check status.",
                    "metadata": {
                        "command": command[:200] + ("..." if len(command) > 200 else ""),
                        "working_dir": str(working_dir_resolved),
                        "shell": shell_type,
                        "window_visible": show_window,
                    }
                },
                metadata={"job_id": job_id, "pid": process.pid, "background": True}
            )

        except FileNotFoundError as e:
            raise ValueError(
                f"Shell executable '{shell_type}' not found. "
                f"Ensure {shell_type} is installed and available in PATH."
            )
        except Exception as e:
            raise ValueError(f"Error starting background command: {str(e)}")

    try:
        run_kwargs = {
            "cwd": str(working_dir_resolved),
            "env": exec_env,
            "timeout": timeout_seconds,
            "text": True,
        }

        if system == "Windows":
            run_kwargs["creationflags"] = creation_flags

        if capture_output:
            run_kwargs["capture_output"] = True

        if input_data:
            run_kwargs["input"] = input_data

        result = subprocess.run(exec_command, **run_kwargs)

        if not capture_output:
            result.stdout = ""
            result.stderr = ""

    except subprocess.TimeoutExpired as e:
        raise ValueError(
            f"Command execution timed out after {timeout_seconds} seconds. "
            f"Consider increasing the timeout parameter or optimizing the command."
        )
    except FileNotFoundError as e:
        raise ValueError(
            f"Shell executable '{shell_type}' not found. "
            f"Ensure {shell_type} is installed and available in PATH."
        )
    except PermissionError as e:
        raise ValueError(
            f"Permission denied while executing command. "
            f"Check that you have execute permissions in '{working_dir}'."
        )
    except Exception as e:
        raise ValueError(f"Error executing command: {str(e)}")

    if check_return_code and result.returncode != 0:
        raise ValueError(
            f"Command exited with non-zero return code {result.returncode}. "
            f"stderr: {result.stderr[:500] if result.stderr else '(empty)'}"
        )

    success = result.returncode == 0
    status = "success" if success else "failed"

    output_lines = result.stdout.count('\n') if result.stdout else 0
    error_lines = result.stderr.count('\n') if result.stderr else 0

    _logger.info(
        f"Command execution {status} with return code {result.returncode} "
        f"(stdout: {output_lines} lines, stderr: {error_lines} lines)"
    )

    output_data = {
        "status": status,
        "return_code": result.returncode,
        "stdout": result.stdout if capture_output else None,
        "stderr": result.stderr if capture_output else None,
        "metadata": {
            "command": command[:200] + ("..." if len(command) > 200 else ""),
            "working_dir": str(working_dir_resolved),
            "shell": shell_type,
            "timeout": timeout_seconds,
            "stdout_lines": output_lines,
            "stderr_lines": error_lines,
        }
    }

    warnings = []
    if result.returncode != 0:
        warnings.append(
            f"Command exited with non-zero return code {result.returncode}. "
            "Check stderr for error details."
        )

    if error_lines > 100:
        warnings.append(
            f"Command produced {error_lines} lines of stderr output. "
            "This may indicate warnings or errors."
        )

    if warnings:
        output_data["warnings"] = warnings

    return ToolResult(
        output=output_data,
        metadata={
            "return_code": result.returncode,
            "success": success,
            "command_hash": hash(command),
        }
    )


exec_command_spec = ToolSpec(
    name="system.exec",
    version="1.0",
    description="Execute shell commands with timeout, environment control, and output capture. Supports multiple shells and working directory customization.",
    effects=["exec", "disk"],
    in_schema={
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell command to execute. Can include pipes, redirects, and multiple commands with && or ;."
            },
            "working_dir": {
                "type": "string",
                "default": ".",
                "description": "Working directory for command execution (default: current directory)"
            },
            "env": {
                "type": "object",
                "description": "Additional environment variables to set (merged with existing environment). Keys and values must be strings.",
                "additionalProperties": {"type": "string"}
            },
            "timeout": {
                "type": "number",
                "default": 30,
                "description": "Maximum execution time in seconds (1-600, default: 30)"
            },
            "shell": {
                "type": "string",
                "enum": ["bash", "sh", "zsh", "fish", "cmd", "powershell", "pwsh"],
                "description": "Shell to use for command execution (default: auto-detected based on OS)"
            },
            "capture_output": {
                "type": "boolean",
                "default": True,
                "description": "Capture stdout and stderr (default: true). Set to false for commands that don't produce relevant output."
            },
            "check_return_code": {
                "type": "boolean",
                "default": False,
                "description": "Raise error if command returns non-zero exit code (default: false). Useful for failing fast on errors."
            },
            "input": {
                "type": "string",
                "description": "Data to pass to command's stdin (cannot be used with run_in_background=true)"
            },
            "run_in_background": {
                "type": "boolean",
                "default": False,
                "description": "Run command in background and return immediately (default: false). Returns job_id for status checking. Cannot be used with check_return_code=true or input parameter."
            },
            "show_window": {
                "type": "boolean",
                "default": False,
                "description": "Show console window when executing command (default: false, hidden). On Windows, creates a visible console window. On Unix systems, this parameter has no effect."
            }
        },
        "required": ["command"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["success", "failed", "started"]
            },
            "return_code": {"type": "integer"},
            "stdout": {"type": "string"},
            "stderr": {"type": "string"},
            "job_id": {"type": "string"},
            "pid": {"type": "integer"},
            "message": {"type": "string"},
            "metadata": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "working_dir": {"type": "string"},
                    "shell": {"type": "string"},
                    "timeout": {"type": "number"},
                    "stdout_lines": {"type": "integer"},
                    "stderr_lines": {"type": "integer"},
                    "window_visible": {"type": "boolean"}
                }
            },
            "warnings": {
                "type": "array",
                "items": {"type": "string"}
            }
        }
    },
    fn=_tool_exec_command,
    rate_key="system.exec"
)
