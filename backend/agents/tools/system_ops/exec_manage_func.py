from __future__ import annotations

import os
import platform
import signal
import subprocess
import time
from typing import Any, Dict, List, Optional

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec
from .exec_func import _background_jobs, BackgroundJob

_logger = get_logger(__name__)


def _read_process_output(job: BackgroundJob, incremental: bool = False) -> tuple[str, str, int, int]:
    """
    Read output from a background process.
    Returns (stdout, stderr, new_stdout_lines, new_stderr_lines).
    """
    stdout_text = ""
    stderr_text = ""
    new_stdout_lines = 0
    new_stderr_lines = 0

    if not job.capture_output or not job.process.stdout or not job.process.stderr:
        return stdout_text, stderr_text, new_stdout_lines, new_stderr_lines

    try:
        if job.process.stdout:
            while True:
                line = job.process.stdout.readline()
                if not line:
                    break
                job.stdout_buffer.append(line)
                new_stdout_lines += 1

        if job.process.stderr:
            while True:
                line = job.process.stderr.readline()
                if not line:
                    break
                job.stderr_buffer.append(line)
                new_stderr_lines += 1

    except Exception as e:
        _logger.debug(f"Error reading process output: {e}")

    if incremental:
        stdout_text = "".join(job.stdout_buffer[job.last_stdout_pos:])
        stderr_text = "".join(job.stderr_buffer[job.last_stderr_pos:])
        job.last_stdout_pos = len(job.stdout_buffer)
        job.last_stderr_pos = len(job.stderr_buffer)
    else:
        stdout_text = "".join(job.stdout_buffer)
        stderr_text = "".join(job.stderr_buffer)

    return stdout_text, stderr_text, new_stdout_lines, new_stderr_lines


def _tool_exec_status(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Check status of a background job and optionally retrieve its output.

    This tool:
    - Checks if a background job is still running
    - Returns current status (running, completed, failed)
    - Retrieves stdout and stderr output
    - Supports incremental output reading (only new data)
    - Returns process return code when completed
    - Cleans up completed jobs optionally
    """
    job_id = params.get("job_id")
    incremental = params.get("incremental", True)
    cleanup_if_done = params.get("cleanup_if_done", False)

    if not job_id:
        raise ValueError("job_id is required")

    if not isinstance(job_id, str):
        raise ValueError(f"job_id must be a string, got {type(job_id).__name__}")

    if job_id not in _background_jobs:
        raise ValueError(
            f"Job '{job_id}' not found. Use system.exec_list to see all tracked jobs."
        )

    job = _background_jobs[job_id]

    return_code = job.process.poll()
    is_running = return_code is None

    stdout, stderr, new_stdout_lines, new_stderr_lines = _read_process_output(job, incremental)

    runtime_seconds = time.time() - job.start_time

    if is_running:
        status = "running"
        _logger.info(f"Job {job_id} is still running (runtime: {runtime_seconds:.1f}s)")

        return ToolResult(
            output={
                "status": status,
                "job_id": job_id,
                "pid": job.process.pid,
                "running": True,
                "runtime_seconds": round(runtime_seconds, 2),
                "stdout": stdout if job.capture_output else None,
                "stderr": stderr if job.capture_output else None,
                "metadata": {
                    "command": job.command[:200] + ("..." if len(job.command) > 200 else ""),
                    "working_dir": job.working_dir,
                    "shell": job.shell,
                    "start_time": job.start_time,
                    "new_stdout_lines": new_stdout_lines,
                    "new_stderr_lines": new_stderr_lines,
                    "incremental": incremental
                }
            },
            metadata={"job_id": job_id, "running": True}
        )
    else:
        status = "completed" if return_code == 0 else "failed"
        _logger.info(
            f"Job {job_id} {status} with return code {return_code} "
            f"(runtime: {runtime_seconds:.1f}s)"
        )

        output_data = {
            "status": status,
            "job_id": job_id,
            "pid": job.process.pid,
            "running": False,
            "return_code": return_code,
            "runtime_seconds": round(runtime_seconds, 2),
            "stdout": stdout if job.capture_output else None,
            "stderr": stderr if job.capture_output else None,
            "metadata": {
                "command": job.command[:200] + ("..." if len(job.command) > 200 else ""),
                "working_dir": job.working_dir,
                "shell": job.shell,
                "start_time": job.start_time,
                "new_stdout_lines": new_stdout_lines,
                "new_stderr_lines": new_stderr_lines,
                "incremental": incremental,
                "cleaned_up": False
            }
        }

        if cleanup_if_done:
            del _background_jobs[job_id]
            output_data["metadata"]["cleaned_up"] = True
            _logger.info(f"Cleaned up completed job {job_id}")

        return ToolResult(
            output=output_data,
            metadata={"job_id": job_id, "running": False, "return_code": return_code}
        )


def _tool_exec_kill(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Terminate a background job.

    This tool:
    - Terminates a running background process
    - Supports graceful (SIGTERM) and forceful (SIGKILL) termination
    - Waits for process to terminate with timeout
    - Cleans up job tracking data
    - Returns final output before termination
    """
    job_id = params.get("job_id")
    force = params.get("force", False)
    timeout_seconds = params.get("timeout", 5)

    if not job_id:
        raise ValueError("job_id is required")

    if not isinstance(job_id, str):
        raise ValueError(f"job_id must be a string, got {type(job_id).__name__}")

    if job_id not in _background_jobs:
        raise ValueError(
            f"Job '{job_id}' not found. It may have already been terminated or cleaned up."
        )

    if not isinstance(timeout_seconds, (int, float)) or timeout_seconds <= 0:
        raise ValueError(f"timeout must be a positive number, got {timeout_seconds}")

    if timeout_seconds > 60:
        raise ValueError(f"timeout cannot exceed 60 seconds, got {timeout_seconds}")

    job = _background_jobs[job_id]

    return_code = job.process.poll()
    if return_code is not None:
        _logger.info(f"Job {job_id} already terminated with return code {return_code}")

        stdout, stderr, _, _ = _read_process_output(job, incremental=False)

        del _background_jobs[job_id]

        return ToolResult(
            output={
                "status": "already_terminated",
                "job_id": job_id,
                "return_code": return_code,
                "message": f"Job was already terminated with return code {return_code}",
                "stdout": stdout if job.capture_output else None,
                "stderr": stderr if job.capture_output else None
            },
            metadata={"job_id": job_id, "was_running": False}
        )

    stdout, stderr, _, _ = _read_process_output(job, incremental=False)

    try:
        if platform.system() == "Windows":
            job.process.terminate()
            _logger.info(f"Sent terminate signal to job {job_id} (pid={job.process.pid})")
        else:
            if force:
                job.process.kill() 
                _logger.info(f"Sent SIGKILL to job {job_id} (pid={job.process.pid})")
            else:
                job.process.terminate()  
                _logger.info(f"Sent SIGTERM to job {job_id} (pid={job.process.pid})")

        try:
            job.process.wait(timeout=timeout_seconds)
            final_return_code = job.process.returncode
            terminated_successfully = True
        except subprocess.TimeoutExpired:
            if not force:
                _logger.warning(
                    f"Job {job_id} did not terminate gracefully within {timeout_seconds}s, forcing kill"
                )
                job.process.kill()
                job.process.wait(timeout=5)
                final_return_code = job.process.returncode
                terminated_successfully = True
            else:
                terminated_successfully = False
                final_return_code = None

    except Exception as e:
        _logger.error(f"Error terminating job {job_id}: {e}")
        raise ValueError(f"Failed to terminate job: {str(e)}")

    del _background_jobs[job_id]
    _logger.info(f"Terminated and cleaned up job {job_id}")

    return ToolResult(
        output={
            "status": "terminated",
            "job_id": job_id,
            "pid": job.process.pid,
            "return_code": final_return_code,
            "message": f"Job terminated {'forcefully' if force else 'gracefully'}",
            "terminated_successfully": terminated_successfully,
            "stdout": stdout if job.capture_output else None,
            "stderr": stderr if job.capture_output else None
        },
        metadata={"job_id": job_id, "was_running": True, "force": force}
    )


def _tool_exec_list(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    List all tracked background jobs.

    This tool:
    - Lists all currently tracked background jobs
    - Shows job status (running/completed/failed)
    - Includes basic metadata (pid, command, runtime)
    - Optionally filters by status
    - Optionally cleans up completed jobs
    """
    filter_status = params.get("filter_status")
    cleanup_completed = params.get("cleanup_completed", False)

    if filter_status and filter_status not in ["running", "completed", "failed"]:
        raise ValueError(
            f"filter_status must be 'running', 'completed', or 'failed', got '{filter_status}'"
        )

    jobs_list = []
    jobs_to_remove = []

    for job_id, job in _background_jobs.items():
        return_code = job.process.poll()
        is_running = return_code is None
        runtime = time.time() - job.start_time

        if is_running:
            status = "running"
        else:
            status = "completed" if return_code == 0 else "failed"
            if cleanup_completed:
                jobs_to_remove.append(job_id)

        if filter_status and status != filter_status:
            continue

        jobs_list.append({
            "job_id": job_id,
            "pid": job.process.pid,
            "status": status,
            "return_code": return_code if not is_running else None,
            "command": job.command[:100] + ("..." if len(job.command) > 100 else ""),
            "working_dir": job.working_dir,
            "shell": job.shell,
            "runtime_seconds": round(runtime, 2),
            "start_time": job.start_time,
            "capture_output": job.capture_output
        })

    cleaned_count = 0
    if cleanup_completed:
        for job_id in jobs_to_remove:
            del _background_jobs[job_id]
            cleaned_count += 1
        if cleaned_count > 0:
            _logger.info(f"Cleaned up {cleaned_count} completed jobs")

    _logger.info(f"Listed {len(jobs_list)} jobs (total tracked: {len(_background_jobs)})")

    return ToolResult(
        output={
            "status": "success",
            "jobs": jobs_list,
            "summary": {
                "total_jobs": len(jobs_list),
                "total_tracked": len(_background_jobs),
                "cleaned_up": cleaned_count,
                "filter_applied": filter_status is not None
            }
        },
        metadata={"job_count": len(jobs_list), "cleaned_count": cleaned_count}
    )


def _tool_exec_wait(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Wait for a background job to complete.

    This tool:
    - Blocks until specified job completes or timeout
    - Returns final output and return code
    - Optionally cleans up job after completion
    - Useful for synchronization in workflows
    """
    job_id = params.get("job_id")
    timeout_seconds = params.get("timeout", 300)
    cleanup_after_wait = params.get("cleanup_after_wait", True)
    poll_interval = params.get("poll_interval", 0.5)

    if not job_id:
        raise ValueError("job_id is required")

    if not isinstance(job_id, str):
        raise ValueError(f"job_id must be a string, got {type(job_id).__name__}")

    if job_id not in _background_jobs:
        raise ValueError(
            f"Job '{job_id}' not found. It may have already completed and been cleaned up."
        )

    if not isinstance(timeout_seconds, (int, float)) or timeout_seconds <= 0:
        raise ValueError(f"timeout must be a positive number, got {timeout_seconds}")

    if timeout_seconds > 3600:
        raise ValueError(f"timeout cannot exceed 3600 seconds (1 hour), got {timeout_seconds}")

    if not isinstance(poll_interval, (int, float)) or poll_interval <= 0:
        raise ValueError(f"poll_interval must be a positive number, got {poll_interval}")

    if poll_interval > 60:
        raise ValueError(f"poll_interval cannot exceed 60 seconds, got {poll_interval}")

    job = _background_jobs[job_id]

    _logger.info(f"Waiting for job {job_id} to complete (timeout: {timeout_seconds}s)")

    start_wait_time = time.time()

    try:
        job.process.wait(timeout=timeout_seconds)
        return_code = job.process.returncode
        timed_out = False
    except subprocess.TimeoutExpired:
        return_code = None
        timed_out = True

    wait_time = time.time() - start_wait_time
    total_runtime = time.time() - job.start_time

    stdout, stderr, _, _ = _read_process_output(job, incremental=False)

    if timed_out:
        _logger.warning(
            f"Wait for job {job_id} timed out after {timeout_seconds}s (still running)"
        )

        return ToolResult(
            output={
                "status": "timeout",
                "job_id": job_id,
                "pid": job.process.pid,
                "running": True,
                "message": f"Job did not complete within {timeout_seconds} seconds",
                "wait_time_seconds": round(wait_time, 2),
                "total_runtime_seconds": round(total_runtime, 2),
                "stdout": stdout if job.capture_output else None,
                "stderr": stderr if job.capture_output else None,
                "metadata": {
                    "command": job.command[:200] + ("..." if len(job.command) > 200 else ""),
                    "timed_out": True
                }
            },
            metadata={"job_id": job_id, "timed_out": True}
        )

    status = "completed" if return_code == 0 else "failed"
    _logger.info(
        f"Job {job_id} {status} with return code {return_code} "
        f"(waited: {wait_time:.1f}s, total runtime: {total_runtime:.1f}s)"
    )

    output_data = {
        "status": status,
        "job_id": job_id,
        "pid": job.process.pid,
        "running": False,
        "return_code": return_code,
        "wait_time_seconds": round(wait_time, 2),
        "total_runtime_seconds": round(total_runtime, 2),
        "stdout": stdout if job.capture_output else None,
        "stderr": stderr if job.capture_output else None,
        "metadata": {
            "command": job.command[:200] + ("..." if len(job.command) > 200 else ""),
            "working_dir": job.working_dir,
            "shell": job.shell,
            "timed_out": False,
            "cleaned_up": False
        }
    }

    if cleanup_after_wait:
        del _background_jobs[job_id]
        output_data["metadata"]["cleaned_up"] = True
        _logger.info(f"Cleaned up job {job_id} after wait")

    return ToolResult(
        output=output_data,
        metadata={"job_id": job_id, "return_code": return_code, "timed_out": False}
    )


exec_status_spec = ToolSpec(
    name="system.exec_status",
    version="1.0",
    description="Check status of a background job and retrieve its output. Supports incremental output reading for long-running processes.",
    effects=["disk"],
    in_schema={
        "type": "object",
        "properties": {
            "job_id": {
                "type": "string",
                "description": "Job ID returned from system.exec with run_in_background=true"
            },
            "incremental": {
                "type": "boolean",
                "default": True,
                "description": "Return only new output since last check (default: true). Set false for full output."
            },
            "cleanup_if_done": {
                "type": "boolean",
                "default": False,
                "description": "Remove job from tracking if completed (default: false)"
            }
        },
        "required": ["job_id"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["running", "completed", "failed"]
            },
            "job_id": {"type": "string"},
            "pid": {"type": "integer"},
            "running": {"type": "boolean"},
            "return_code": {"type": "integer"},
            "runtime_seconds": {"type": "number"},
            "stdout": {"type": "string"},
            "stderr": {"type": "string"},
            "metadata": {"type": "object"}
        }
    },
    fn=_tool_exec_status,
    rate_key="system.exec_status"
)

exec_kill_spec = ToolSpec(
    name="system.exec_kill",
    version="1.0",
    description="Terminate a background job. Supports graceful (SIGTERM) and forceful (SIGKILL) termination.",
    effects=["exec"],
    in_schema={
        "type": "object",
        "properties": {
            "job_id": {
                "type": "string",
                "description": "Job ID of the background process to terminate"
            },
            "force": {
                "type": "boolean",
                "default": False,
                "description": "Force kill with SIGKILL (default: false, uses SIGTERM). Ignored on Windows."
            },
            "timeout": {
                "type": "number",
                "default": 5,
                "description": "Seconds to wait for graceful termination before force kill (1-60, default: 5)"
            }
        },
        "required": ["job_id"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["terminated", "already_terminated"]
            },
            "job_id": {"type": "string"},
            "pid": {"type": "integer"},
            "return_code": {"type": "integer"},
            "message": {"type": "string"},
            "terminated_successfully": {"type": "boolean"},
            "stdout": {"type": "string"},
            "stderr": {"type": "string"}
        }
    },
    fn=_tool_exec_kill,
    rate_key="system.exec_kill"
)

exec_list_spec = ToolSpec(
    name="system.exec_list",
    version="1.0",
    description="List all tracked background jobs with their status, runtime, and metadata.",
    effects=[],
    in_schema={
        "type": "object",
        "properties": {
            "filter_status": {
                "type": "string",
                "enum": ["running", "completed", "failed"],
                "description": "Filter jobs by status (optional)"
            },
            "cleanup_completed": {
                "type": "boolean",
                "default": False,
                "description": "Remove completed/failed jobs from tracking (default: false)"
            }
        }
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "jobs": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "pid": {"type": "integer"},
                        "status": {"type": "string"},
                        "return_code": {"type": "integer"},
                        "command": {"type": "string"},
                        "working_dir": {"type": "string"},
                        "shell": {"type": "string"},
                        "runtime_seconds": {"type": "number"},
                        "start_time": {"type": "number"},
                        "capture_output": {"type": "boolean"}
                    }
                }
            },
            "summary": {
                "type": "object",
                "properties": {
                    "total_jobs": {"type": "integer"},
                    "total_tracked": {"type": "integer"},
                    "cleaned_up": {"type": "integer"},
                    "filter_applied": {"type": "boolean"}
                }
            }
        }
    },
    fn=_tool_exec_list,
    rate_key="system.exec_list"
)

exec_wait_spec = ToolSpec(
    name="system.exec_wait",
    version="1.0",
    description="Wait for a background job to complete. Blocks until job finishes or timeout is reached. Useful for workflow synchronization.",
    effects=["exec"],
    in_schema={
        "type": "object",
        "properties": {
            "job_id": {
                "type": "string",
                "description": "Job ID to wait for"
            },
            "timeout": {
                "type": "number",
                "default": 300,
                "description": "Maximum time to wait in seconds (1-3600, default: 300)"
            },
            "cleanup_after_wait": {
                "type": "boolean",
                "default": True,
                "description": "Remove job from tracking after completion (default: true)"
            },
            "poll_interval": {
                "type": "number",
                "default": 0.5,
                "description": "Seconds between status checks (0.1-60, default: 0.5). Only used internally."
            }
        },
        "required": ["job_id"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["completed", "failed", "timeout"]
            },
            "job_id": {"type": "string"},
            "pid": {"type": "integer"},
            "running": {"type": "boolean"},
            "return_code": {"type": "integer"},
            "wait_time_seconds": {"type": "number"},
            "total_runtime_seconds": {"type": "number"},
            "stdout": {"type": "string"},
            "stderr": {"type": "string"},
            "message": {"type": "string"},
            "metadata": {"type": "object"}
        }
    },
    fn=_tool_exec_wait,
    rate_key="system.exec_wait"
)
