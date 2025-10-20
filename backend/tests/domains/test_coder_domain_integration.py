"""Real integration tests for the coder domain with actual LLM calls.

These tests execute the full coder domain pipeline with Gemini 2.5 Flash,
testing deterministic file operations and validating real agent behavior.

Requirements:
- GEMINI_API_KEY must be set in environment
- Tests are marked as 'integration' and 'slow'
- Each test uses isolated temporary workspace
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict

import pytest
from dotenv import load_dotenv

# Add backend directory to sys.path for imports (following the pattern from app.py)
backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

# Load environment variables from .env file
project_root = backend_dir.parent
dotenv_path = project_root / ".env"
load_dotenv(dotenv_path)

from agents.domains.domain_configs import discover_and_register_domains
from agents.execution.single_domain_executor import SingleDomainExecutor


@pytest.fixture(scope="module", autouse=True)
def _ensure_domains_registered() -> None:
    """Register all domain specs so the executor can find the coder domain."""
    discover_and_register_domains()


@pytest.fixture(scope="module")
def _check_api_key() -> None:
    """Check if Gemini API key is available."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        pytest.skip(
            "GEMINI_API_KEY not set - skipping integration tests. "
            f"Checked .env at: {project_root / '.env'}"
        )
    print(f"\n✓ GEMINI_API_KEY loaded (length: {len(api_key)} chars)")


@pytest.fixture(autouse=True)
def _test_logger_and_rate_limit(request, monkeypatch):
    """Log test execution and add rate limit between model calls."""
    if not request.node.get_closest_marker('integration'):
        yield
        return

    # Print test name at start
    test_name = request.node.name.replace("test_coder_", "")
    print(f"\n{'='*80}\n▶ Testing: {test_name}\n{'='*80}")

    # Track model call timing
    last_call_time = {'time': 0}

    # Wrap _call_agent to add rate limiting and logging
    original_call_agent = SingleDomainExecutor._call_agent

    def _rate_limited_call_agent(self, agent, prompt):
        # Rate limit: 10 RPM = 1 call per 6 seconds minimum
        delay = 6
        elapsed = time.time() - last_call_time['time']
        if last_call_time['time'] > 0 and elapsed < delay:
            wait_time = delay - elapsed
            print(f"\n⏳ Rate limit: waiting {wait_time:.1f}s...")
            time.sleep(wait_time)

        # Call the original method
        response = original_call_agent(self, agent, prompt)

        # Log what model returned (full response)
        print(f"\n🤖 Model response:\n{response}")

        last_call_time['time'] = time.time()
        return response

    monkeypatch.setattr(SingleDomainExecutor, '_call_agent', _rate_limited_call_agent)

    yield


def _validate_task_completed(state: Dict[str, Any]) -> None:
    """Validate that a task completed successfully."""
    assert state["status"] == "completed", f"Expected completed status, got {state['status']}"
    assert state.get("agent_message"), "Agent should provide a completion message"
    assert state.get("metadata"), "State should include metadata"
    assert isinstance(state["metadata"].get("tool_calls"), int), "Should track tool call count"


def _auto_accept_all_tools(
    executor: SingleDomainExecutor,
    initial_state: Dict[str, Any],
    max_iterations: int = 20,
) -> Dict[str, Any]:
    """Auto-accept all tool calls until completion or max iterations."""
    state = initial_state
    iteration = 0

    # Check if initial state already failed (e.g., quota exceeded)
    if state["status"] == "failed":
        error_msg = state.get("error_message", "Unknown error")
        if "quota" in error_msg.lower() or "rate" in error_msg.lower():
            pytest.skip(f"Quota exceeded: {error_msg}")
        raise RuntimeError(f"Task failed immediately: {error_msg}")

    while state["status"] == "waiting_user" and iteration < max_iterations:
        iteration += 1
        pending_tool = state.get("pending_tool")

        if not pending_tool:
            raise RuntimeError(f"State is waiting_user but no pending_tool (iteration {iteration})")

        # Print clean iteration info
        print(f"\n[{iteration}] {pending_tool['tool']}")

        # Show key parameters only
        params = dict(pending_tool.get('params', []))
        if 'file_path' in params:
            print(f"    → {params['file_path']}")
        if 'content' in params and len(str(params['content'])) < 60:
            print(f"    → Content: {params['content']}")

        # Accept the tool call
        state = executor.handle_tool_decision(
            task_id=state["task_id"],
            call_id=pending_tool["call_id"],
            decision="accept",
        )

        # Check if state failed during execution (e.g., quota exceeded)
        if state["status"] == "failed":
            error_msg = state.get("error_message", "Unknown error")
            if "quota" in error_msg.lower() or "rate" in error_msg.lower():
                pytest.skip(f"Quota exceeded during execution: {error_msg}")
            raise RuntimeError(f"Task failed: {error_msg}")

    if iteration >= max_iterations:
        raise RuntimeError(f"Exceeded max iterations ({max_iterations})")

    # Print completion summary
    if state["status"] == "completed":
        print(f"\n✓ Completed in {iteration} iteration(s), {state['metadata'].get('tool_calls', 0)} tool call(s)")

    return state


@pytest.mark.integration
@pytest.mark.slow
def test_coder_creates_simple_file(tmp_path: Path, _check_api_key: None) -> None:
    """Test that coder domain can create a simple text file with specific content."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    executor = SingleDomainExecutor()

    # Request to create a simple file
    initial_state = executor.execute_domain_task(
        domain_id="coder",
        user_request="Create a file at 'hello.txt' containing exactly this text: 'Hello from ATLAS2 coder domain!'",
        chat_id="test-create-simple",
        workspace_path=str(workspace),
    )

    # Auto-accept all tools until completion
    final_state = _auto_accept_all_tools(executor, initial_state)

    # Validate completion
    _validate_task_completed(final_state)

    # Verify the file was created with correct content
    created_file = workspace / "hello.txt"
    assert created_file.exists(), "File hello.txt should exist"

    content = created_file.read_text(encoding="utf-8")
    assert "Hello from ATLAS2 coder domain!" in content, f"Expected content not found. Got: {content}"


@pytest.mark.integration
@pytest.mark.slow
def test_coder_creates_file_with_directory(tmp_path: Path, _check_api_key: None) -> None:
    """Test that coder domain can create directories and files in nested structure."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    executor = SingleDomainExecutor()

    initial_state = executor.execute_domain_task(
        domain_id="coder",
        user_request="Create a file at 'src/utils/config.txt' with the content 'Configuration file for tests'",
        chat_id="test-create-nested",
        workspace_path=str(workspace),
    )

    final_state = _auto_accept_all_tools(executor, initial_state)
    _validate_task_completed(final_state)

    # Verify the nested structure was created
    created_file = workspace / "src" / "utils" / "config.txt"
    assert created_file.exists(), "File src/utils/config.txt should exist"
    assert created_file.parent.exists(), "Directory src/utils should exist"

    content = created_file.read_text(encoding="utf-8")
    assert "Configuration file for tests" in content


@pytest.mark.integration
@pytest.mark.slow
def test_coder_edits_existing_file(tmp_path: Path, _check_api_key: None) -> None:
    """Test that coder domain can edit an existing file with line-based modifications."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    # Create an existing file with known content
    test_file = workspace / "data.txt"
    original_content = "Line 1: Original\nLine 2: Original\nLine 3: Original\n"
    test_file.write_text(original_content, encoding="utf-8")

    executor = SingleDomainExecutor()

    initial_state = executor.execute_domain_task(
        domain_id="coder",
        user_request="Edit the file 'data.txt' and change line 2 to 'Line 2: Modified by agent'",
        chat_id="test-edit-file",
        workspace_path=str(workspace),
    )

    final_state = _auto_accept_all_tools(executor, initial_state)
    _validate_task_completed(final_state)

    # Verify the file was edited correctly
    updated_content = test_file.read_text(encoding="utf-8")
    lines = updated_content.split("\n")

    assert "Line 1: Original" in lines[0], "Line 1 should remain unchanged"
    assert "Modified by agent" in lines[1], f"Line 2 should be modified. Got: {lines[1]}"
    assert "Line 3: Original" in lines[2], "Line 3 should remain unchanged"


@pytest.mark.integration
@pytest.mark.slow
def test_coder_multiple_file_operations(tmp_path: Path, _check_api_key: None) -> None:
    """Test that coder domain can perform multiple file operations in sequence."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    executor = SingleDomainExecutor()

    initial_state = executor.execute_domain_task(
        domain_id="coder",
        user_request=(
            "Perform these tasks in order: "
            "1. Create a file 'task1.txt' with content 'First task completed' "
            "2. Create a file 'task2.txt' with content 'Second task completed' "
            "3. Create a summary file 'summary.txt' listing both completed tasks"
        ),
        chat_id="test-multi-ops",
        workspace_path=str(workspace),
    )

    final_state = _auto_accept_all_tools(executor, initial_state, max_iterations=30)
    _validate_task_completed(final_state)

    # Verify all files were created
    task1_file = workspace / "task1.txt"
    task2_file = workspace / "task2.txt"
    summary_file = workspace / "summary.txt"

    assert task1_file.exists(), "task1.txt should exist"
    assert task2_file.exists(), "task2.txt should exist"
    assert summary_file.exists(), "summary.txt should exist"

    # Verify content
    assert "First task completed" in task1_file.read_text(encoding="utf-8")
    assert "Second task completed" in task2_file.read_text(encoding="utf-8")

    # Summary should mention both tasks
    summary_content = summary_file.read_text(encoding="utf-8")
    assert "task1" in summary_content.lower() or "first" in summary_content.lower()
    assert "task2" in summary_content.lower() or "second" in summary_content.lower()

    # Verify multiple tool calls were made
    assert final_state["metadata"]["tool_calls"] >= 3, "Should have made at least 3 tool calls"


@pytest.mark.integration
@pytest.mark.slow
def test_coder_creates_python_file(tmp_path: Path, _check_api_key: None) -> None:
    """Test that coder domain can create a simple Python file with valid syntax."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    executor = SingleDomainExecutor()

    initial_state = executor.execute_domain_task(
        domain_id="coder",
        user_request=(
            "Create a Python file 'calculator.py' with a function called 'add' that takes two numbers and returns their sum. "
            "Include a docstring and a simple example usage in a comment."
        ),
        chat_id="test-python-file",
        workspace_path=str(workspace),
    )

    final_state = _auto_accept_all_tools(executor, initial_state)
    _validate_task_completed(final_state)

    # Verify the Python file was created
    py_file = workspace / "calculator.py"
    assert py_file.exists(), "calculator.py should exist"

    content = py_file.read_text(encoding="utf-8")

    # Verify basic Python structure
    assert "def add" in content, "Should define an 'add' function"
    assert "return" in content, "Function should have a return statement"
    assert '"""' in content or "'''" in content, "Should include docstring"

    # Verify syntax is valid by attempting to compile
    try:
        compile(content, "calculator.py", "exec")
    except SyntaxError as e:
        pytest.fail(f"Generated Python file has syntax errors: {e}")


@pytest.mark.integration
@pytest.mark.slow
def test_coder_reads_and_modifies_file(tmp_path: Path, _check_api_key: None) -> None:
    """Test that coder domain can read a file and make intelligent modifications based on its content."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    # Create a file with JSON data
    data_file = workspace / "config.json"
    original_data = {
        "app_name": "TestApp",
        "version": "1.0.0",
        "debug": True,
    }
    data_file.write_text(json.dumps(original_data, indent=2), encoding="utf-8")

    executor = SingleDomainExecutor()

    initial_state = executor.execute_domain_task(
        domain_id="coder",
        user_request=(
            "Read the file 'config.json' and update the version to '1.1.0' and set debug to false. "
            "Keep the JSON properly formatted."
        ),
        chat_id="test-read-modify",
        workspace_path=str(workspace),
    )

    final_state = _auto_accept_all_tools(executor, initial_state)
    _validate_task_completed(final_state)

    # Verify the file was modified correctly
    updated_content = data_file.read_text(encoding="utf-8")

    # Parse as JSON to verify structure
    try:
        updated_data = json.loads(updated_content)
    except json.JSONDecodeError as e:
        pytest.fail(f"Modified file is not valid JSON: {e}\nContent: {updated_content}")

    # Verify the specific changes
    assert updated_data.get("version") == "1.1.0", f"Version should be updated to 1.1.0, got {updated_data.get('version')}"
    assert updated_data.get("debug") is False, f"Debug should be False, got {updated_data.get('debug')}"
    assert updated_data.get("app_name") == "TestApp", "app_name should remain unchanged"

    # Verify the agent read the file first (should see file.read in tool history)
    tool_history = final_state.get("tool_history", [])
    tools_used = [entry["tool"] for entry in tool_history]
    assert "file.read" in tools_used, "Agent should have read the file first"
    assert "file.edit" in tools_used or "file.write" in tools_used, "Agent should have modified the file"


@pytest.mark.integration
@pytest.mark.slow
def test_coder_workspace_isolation(tmp_path: Path, _check_api_key: None) -> None:
    """Test that coder domain properly isolates operations to the specified workspace."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    # Create a file outside the workspace
    outside_file = tmp_path / "outside.txt"
    outside_file.write_text("This file is outside workspace", encoding="utf-8")

    executor = SingleDomainExecutor()

    initial_state = executor.execute_domain_task(
        domain_id="coder",
        user_request="Create a file 'inside.txt' with content 'This file is inside workspace'",
        chat_id="test-isolation",
        workspace_path=str(workspace),
    )

    final_state = _auto_accept_all_tools(executor, initial_state)
    _validate_task_completed(final_state)

    # Verify file was created inside workspace
    inside_file = workspace / "inside.txt"
    assert inside_file.exists(), "File should be created inside workspace"

    # Verify outside file was not modified
    assert outside_file.read_text(encoding="utf-8") == "This file is outside workspace"

    # Verify all tool calls used workspace-relative paths
    tool_history = final_state.get("tool_history", [])
    for entry in tool_history:
        if entry["tool"] in ["file.write", "file.read", "file.edit"]:
            params = dict(entry["params"])
            file_path = params.get("file_path", "")
            # File path should be relative or within workspace
            assert not file_path.startswith(str(tmp_path)) or file_path.startswith(str(workspace)), \
                f"Tool call should use workspace-relative paths: {file_path}"
