# status: complete

"""Coder Session Logger - Task-specific logging for coder domain execution.

This module provides detailed, session-specific logging for coder tasks to help with debugging
and understanding the flow of individual coder executions.
"""

import logging
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
import json


class CoderSessionLogger:
    """
    Manages session-specific logging for coder domain tasks.
    Each coder task gets its own log file in logs/coder_sessions/.
    """

    def __init__(self, task_id: str, chat_id: str, user_request: str, workspace_path: Optional[str] = None):
        """
        Initialize a new coder session logger.

        Args:
            task_id: Unique task identifier
            chat_id: Chat session identifier
            user_request: User's request that initiated this task
            workspace_path: Path to the workspace (if any)
        """
        self.task_id = task_id
        self.chat_id = chat_id
        self.user_request = user_request
        self.workspace_path = workspace_path
        self.start_time = datetime.now()

        # Setup session-specific log file
        self.log_dir = Path("..") / "logs" / "coder_sessions"
        self.log_dir.mkdir(parents=True, exist_ok=True)

        timestamp = self.start_time.strftime("%Y%m%d_%H%M%S")
        log_filename = f"coder_session_{task_id}_{timestamp}.log"
        self.log_file = self.log_dir / log_filename

        # Create context dump folder for this session
        # Folder name matches log file: coder_session_{task_id}_{timestamp}/
        self.context_dump_dir = self.log_dir / f"coder_session_{task_id}_{timestamp}"
        self.context_dump_dir.mkdir(parents=True, exist_ok=True)

        # Track tool call numbers for context dumps
        self.tool_call_counter = 0

        # Create a session-specific logger
        self.logger = logging.getLogger(f"coder_session.{task_id}")
        self.logger.setLevel(logging.DEBUG)
        self.logger.propagate = False  # Don't propagate to root logger

        # Create file handler for this session
        file_handler = logging.FileHandler(self.log_file, encoding='utf-8')
        file_handler.setLevel(logging.DEBUG)

        # Custom format for coder session logs
        formatter = logging.Formatter(
            '%(asctime)s | %(levelname)-8s | %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        file_handler.setFormatter(formatter)

        # Clear any existing handlers and add our file handler
        self.logger.handlers.clear()
        self.logger.addHandler(file_handler)

    def log_session_start(self, domain_id: str, agent_id: str) -> None:
        """Log the start of a coder session."""
        self.logger.info("=" * 80)
        self.logger.info("CODER SESSION START")
        self.logger.info("=" * 80)
        self.logger.info(f"Task ID: {self.task_id}")
        self.logger.info(f"Chat ID: {self.chat_id}")
        self.logger.info(f"Domain: {domain_id}")
        self.logger.info(f"Agent: {agent_id}")
        self.logger.info(f"Workspace: {self.workspace_path or 'None'}")
        self.logger.info(f"User Request: {self.user_request}")
        self.logger.info("=" * 80)

    def log_iteration_start(self, iteration_num: int) -> None:
        """Log the start of an agent iteration."""
        self.logger.info("")
        self.logger.info("-" * 80)
        self.logger.info(f"ITERATION {iteration_num} START")
        self.logger.info("-" * 80)

    def log_agent_thinking(self, thinking: str) -> None:
        """Log agent's thinking/reasoning (abbreviated if too long)."""
        if thinking:
            if len(thinking) > 500:
                abbreviated = thinking[:500] + "... [truncated]"
                self.logger.debug(f"Agent Thinking: {abbreviated}")
            else:
                self.logger.debug(f"Agent Thinking: {thinking}")

    def log_agent_message(self, message: str) -> None:
        """Log agent's message to user."""
        if message:
            self.logger.info(f"Agent Message: {message}")

    def log_tool_proposal(self, tool_name: str, params: List[Tuple[str, Any]], reason: str) -> None:
        """Log when agent proposes a tool call."""
        self.logger.info("")
        self.logger.info(f"→ TOOL PROPOSAL: {tool_name}")
        self.logger.info(f"  Reason: {reason}")
        if params:
            self.logger.info("  Parameters:")
            for param_name, param_value in params:
                # Truncate long parameter values
                value_str = str(param_value)
                if len(value_str) > 200:
                    value_str = value_str[:200] + "... [truncated]"
                self.logger.info(f"    {param_name}: {value_str}")

    def log_tool_execution(
        self,
        tool_name: str,
        accepted: bool,
        result_summary: str,
        error: Optional[str] = None
    ) -> None:
        """Log tool execution result."""
        if accepted:
            if error:
                self.logger.warning(f"✗ TOOL EXECUTION FAILED: {tool_name}")
                self.logger.warning(f"  Error: {error}")
            else:
                self.logger.info(f"✓ TOOL EXECUTED: {tool_name}")
                self.logger.info(f"  Result: {result_summary}")
        else:
            self.logger.warning(f"✗ TOOL REJECTED: {tool_name}")

    def log_iteration_end(self, iteration_num: int, status: str) -> None:
        """Log the end of an iteration."""
        self.logger.info(f"ITERATION {iteration_num} END - Status: {status.upper()}")
        self.logger.info("-" * 80)

    def log_session_end(
        self,
        final_status: str,
        total_iterations: int,
        total_tool_calls: int,
        output_message: str
    ) -> None:
        """Log the end of a coder session with summary statistics."""
        end_time = datetime.now()
        elapsed = end_time - self.start_time
        elapsed_seconds = elapsed.total_seconds()

        self.logger.info("")
        self.logger.info("=" * 80)
        self.logger.info("CODER SESSION END")
        self.logger.info("=" * 80)
        self.logger.info(f"Final Status: {final_status.upper()}")
        self.logger.info(f"Total Iterations: {total_iterations}")
        self.logger.info(f"Total Tool Calls: {total_tool_calls}")
        self.logger.info(f"Elapsed Time: {elapsed_seconds:.2f}s")
        if output_message:
            self.logger.info(f"Final Output: {output_message}")
        self.logger.info("=" * 80)

        # Close the file handler
        for handler in self.logger.handlers[:]:
            handler.close()
            self.logger.removeHandler(handler)

    def log_error(self, error_msg: str) -> None:
        """Log an error during execution."""
        self.logger.error(f"ERROR: {error_msg}")

    def log_debug(self, message: str) -> None:
        """Log debug information."""
        self.logger.debug(message)

    def log_warning(self, message: str) -> None:
        """Log a warning."""
        self.logger.warning(message)

    def dump_agent_context(
        self,
        agent_prompt: str,
        tool_name: str,
        params: List[Tuple[str, Any]]
    ) -> None:
        """
        Dump the full agent context (prompt) to a file before each tool call.

        Creates numbered files like:
        - 01_tool_file.write_index.html.txt
        - 02_tool_file.read_style.css.txt
        - etc.

        Args:
            agent_prompt: The complete prompt sent to the agent
            tool_name: Name of the tool being called
            params: Tool parameters
        """
        self.tool_call_counter += 1

        # Build a descriptive filename
        # Extract key parameter for filename (usually file_path, command, or query)
        key_param = ""
        for param_name, param_value in params:
            if param_name in ["file_path", "path", "command", "query", "index_name"]:
                # Sanitize path for filename (remove invalid chars, limit length)
                key_param = str(param_value).replace("\\", "_").replace("/", "_").replace(":", "_")
                # Limit length and remove spaces
                key_param = key_param.replace(" ", "_")[:50]
                break

        # Format: 01_tool_file.write_index.html.txt
        if key_param:
            filename = f"{self.tool_call_counter:02d}_tool_{tool_name}_{key_param}.txt"
        else:
            filename = f"{self.tool_call_counter:02d}_tool_{tool_name}.txt"

        context_file = self.context_dump_dir / filename

        try:
            with open(context_file, 'w', encoding='utf-8') as f:
                f.write("=" * 80 + "\n")
                f.write(f"AGENT CONTEXT DUMP - Tool Call #{self.tool_call_counter}\n")
                f.write("=" * 80 + "\n")
                f.write(f"Tool: {tool_name}\n")
                f.write(f"Parameters:\n")
                for param_name, param_value in params:
                    f.write(f"  {param_name}: {param_value!r}\n")
                f.write("=" * 80 + "\n\n")
                f.write("FULL AGENT PROMPT:\n")
                f.write("=" * 80 + "\n")
                f.write(agent_prompt)
                f.write("\n" + "=" * 80 + "\n")

            self.logger.debug(f"Context dumped to: {filename}")
        except Exception as e:
            self.logger.error(f"Failed to dump context: {e}")


# Session registry to track active coder sessions
_active_sessions: Dict[str, CoderSessionLogger] = {}


def create_coder_session_logger(
    task_id: str,
    chat_id: str,
    user_request: str,
    workspace_path: Optional[str] = None
) -> CoderSessionLogger:
    """
    Create and register a new coder session logger.

    Args:
        task_id: Unique task identifier
        chat_id: Chat session identifier
        user_request: User's request that initiated this task
        workspace_path: Path to the workspace (if any)

    Returns:
        CoderSessionLogger instance for this session
    """
    logger = CoderSessionLogger(task_id, chat_id, user_request, workspace_path)
    _active_sessions[task_id] = logger
    return logger


def get_coder_session_logger(task_id: str) -> Optional[CoderSessionLogger]:
    """
    Get an existing coder session logger by task_id.

    Args:
        task_id: Task identifier

    Returns:
        CoderSessionLogger instance if found, None otherwise
    """
    return _active_sessions.get(task_id)


def close_coder_session_logger(task_id: str) -> None:
    """
    Close and remove a coder session logger.

    Args:
        task_id: Task identifier
    """
    logger = _active_sessions.pop(task_id, None)
    if logger:
        # Cleanup handlers
        for handler in logger.logger.handlers[:]:
            handler.close()
            logger.logger.removeHandler(handler)
