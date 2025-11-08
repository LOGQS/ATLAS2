"""Domain-level tests that drive the coder executor pipeline with deterministic flows."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Iterable, Iterator, List

import pytest

# Add backend directory to sys.path for imports (following the pattern from app.py)
backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.domains.domain_configs import (  # pylint: disable=import-error
    discover_and_register_domains,
)
from agents.execution.single_domain_executor import (  # pylint: disable=import-error
    SingleDomainExecutor,
)
from utils.db_utils import db  # pylint: disable=import-error


@pytest.fixture(scope="module", autouse=True)
def _ensure_domains_registered() -> None:
    """Register all domain specs so the executor can find the coder domain."""
    discover_and_register_domains()


def _await_tool_response(
    *,
    message: str,
    tool: str,
    params: Iterable[tuple[str, object]],
    reason: str = "",
) -> str:
    """Return an agent response that requests a tool execution."""
    param_entries = "".join(
        f'<PARAM name="{name}">{json.dumps(value)}</PARAM>' for name, value in params
    )
    return (
        "<AGENT_DECISION>"
        "<STATUS>AWAIT_TOOL</STATUS>"
        f"<MESSAGE>{message}</MESSAGE>"
        "<TOOL_CALL>"
        f"<TOOL>{tool}</TOOL>"
        f"<REASON>{reason}</REASON>"
        f"{param_entries}"
        "</TOOL_CALL>"
        "</AGENT_DECISION>"
    )


def _complete_response(message: str) -> str:
    """Return an agent response that signals task completion."""
    return (
        "<AGENT_DECISION>"
        "<STATUS>COMPLETE</STATUS>"
        f"<MESSAGE>{message}</MESSAGE>"
        "</AGENT_DECISION>"
    )


def _patch_agent_responses(
    monkeypatch: pytest.MonkeyPatch,
    responses: List[str],
) -> None:
    """Patch the executor's _call_agent to yield scripted responses."""

    response_iter: Iterator[str] = iter(responses)

    def _fake_call_agent(self, agent, prompt):  # type: ignore[override]
        try:
            return next(response_iter)
        except StopIteration:  # pragma: no cover - signals test failure
            pytest.fail("Agent invoked more times than scripted responses")

    monkeypatch.setattr(
        SingleDomainExecutor,
        "_call_agent",
        _fake_call_agent,
        raising=False,
    )


def _clear_file_history(workspace_path: str) -> None:
    """Remove prior history entries for a workspace to keep tests isolated."""
    def query(conn, cursor):
        cursor.execute(
            "DELETE FROM file_edit_history WHERE workspace_path = ?",
            (workspace_path,)
        )
        conn.commit()
    db._execute_with_connection("test clear file history", query, return_on_error=False)


def _fetch_file_history_contents(workspace_path: str, file_path: str) -> List[str]:
    """Fetch checkpoint contents (newest first) for assertions."""
    def query(conn, cursor):
        cursor.execute(
            """
            SELECT content
            FROM file_edit_history
            WHERE workspace_path = ? AND file_path = ?
            ORDER BY timestamp DESC, id DESC
            """,
            (workspace_path, file_path)
        )
        return [row[0] for row in cursor.fetchall()]
    return db._execute_with_connection("test fetch file history", query, return_on_error=[])


def test_coder_pipeline_creates_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    target_rel_path = Path("src") / "greeting.txt"
    file_content = "Hello from the coder domain pipeline!\n"

    _patch_agent_responses(
        monkeypatch,
        responses=[
            _await_tool_response(
                message="Creating the requested greeting file.",
                tool="file.write",
                params=[
                    ("file_path", str(target_rel_path)),
                    ("content", file_content),
                    ("create_dirs", True),
                ],
                reason="Write the greeting file with provided content",
            ),
            _complete_response("File created successfully."),
        ],
    )

    executor = SingleDomainExecutor()

    state = executor.execute_domain_task(
        domain_id="coder",
        user_request="Create a greeting file in src/greeting.txt",
        chat_id="chat-create",
        workspace_path=str(workspace),
    )

    assert state["status"] == "waiting_user"
    pending_tool = state["pending_tool"]
    assert pending_tool is not None
    assert pending_tool["tool"] == "file.write"
    pending_params = {name: value for name, value in pending_tool["params"]}
    assert pending_params == {
        "file_path": str(target_rel_path),
        "content": file_content,
        "create_dirs": True,
    }

    final_state = executor.handle_tool_decision(
        task_id=state["task_id"],
        call_id=pending_tool["call_id"],
        decision="accept",
    )

    assert final_state["status"] == "completed"
    assert final_state["agent_message"] == "File created successfully."
    assert final_state["metadata"]["tool_calls"] == 1
    assert len(final_state["tool_history"]) == 1
    history_entry = final_state["tool_history"][0]
    assert history_entry["tool"] == "file.write"
    history_params = {name: value for name, value in history_entry["params"]}
    assert history_params["file_path"] == str(target_rel_path)

    created_file = workspace / target_rel_path
    assert created_file.exists()
    assert created_file.read_text(encoding="utf-8") == file_content


def test_coder_pipeline_edits_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    target_rel_path = Path("docs") / "notes.txt"
    original_content = "alpha\nbeta\ngamma\n"
    updated_line = "beta updated via pipeline\n"

    file_path = workspace / target_rel_path
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(original_content, encoding="utf-8")

    _patch_agent_responses(
        monkeypatch,
        responses=[
            _await_tool_response(
                message="Updating the second line as requested.",
                tool="file.edit",
                params=[
                    ("file_path", str(target_rel_path)),
                    ("edit_mode", "line_range"),
                    ("start_line", 2),
                    ("end_line", 2),
                    ("new_content", updated_line),
                ],
                reason="Replace the second line with the updated value",
            ),
            _complete_response("File edited successfully."),
        ],
    )

    executor = SingleDomainExecutor()

    state = executor.execute_domain_task(
        domain_id="coder",
        user_request="Update docs/notes.txt second line to 'beta updated via pipeline'",
        chat_id="chat-edit",
        workspace_path=str(workspace),
    )

    assert state["status"] == "waiting_user"
    pending_tool = state["pending_tool"]
    assert pending_tool is not None
    assert pending_tool["tool"] == "file.edit"

    final_state = executor.handle_tool_decision(
        task_id=state["task_id"],
        call_id=pending_tool["call_id"],
        decision="ACCEPT",
    )

    assert final_state["status"] == "completed"
    assert final_state["agent_message"] == "File edited successfully."
    assert final_state["metadata"]["tool_calls"] == 1
    assert len(final_state["tool_history"]) == 1
    history_entry = final_state["tool_history"][0]
    assert history_entry["tool"] == "file.edit"
    history_params = {name: value for name, value in history_entry["params"]}
    assert history_params["file_path"] == str(target_rel_path)
    assert history_params["start_line"] == 2
    assert history_params["end_line"] == 2

    updated_content = file_path.read_text(encoding="utf-8")
    assert updated_content == "alpha\nbeta updated via pipeline\ngamma\n"


def test_coder_pipeline_multiple_steps(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    target_rel_path = Path("project") / "log.txt"
    initial_content = "initial line\n"
    updated_content = "updated first line\n"

    _patch_agent_responses(
        monkeypatch,
        responses=[
            _await_tool_response(
                message="Creating the log file before editing.",
                tool="file.write",
                params=[
                    ("file_path", str(target_rel_path)),
                    ("content", initial_content),
                    ("create_dirs", True),
                ],
                reason="Ensure the log file exists with initial content",
            ),
            _await_tool_response(
                message="Now updating the first line in the log file.",
                tool="file.edit",
                params=[
                    ("file_path", str(target_rel_path)),
                    ("edit_mode", "line_range"),
                    ("start_line", 1),
                    ("end_line", 1),
                    ("new_content", updated_content),
                ],
                reason="Replace the first line as requested",
            ),
            _complete_response("Log file created and updated."),
        ],
    )

    executor = SingleDomainExecutor()

    state = executor.execute_domain_task(
        domain_id="coder",
        user_request="Create project/log.txt with initial line then update the first line.",
        chat_id="chat-multi",
        workspace_path=str(workspace),
    )

    assert state["status"] == "waiting_user"
    first_tool = state["pending_tool"]
    assert first_tool is not None
    assert first_tool["tool"] == "file.write"

    mid_state = executor.handle_tool_decision(
        task_id=state["task_id"],
        call_id=first_tool["call_id"],
        decision="accept",
    )

    assert mid_state["status"] == "waiting_user"
    second_tool = mid_state["pending_tool"]
    assert second_tool is not None
    assert second_tool["tool"] == "file.edit"

    final_state = executor.handle_tool_decision(
        task_id=mid_state["task_id"],
        call_id=second_tool["call_id"],
        decision="accept",
    )

    assert final_state["status"] == "completed"
    assert final_state["agent_message"] == "Log file created and updated."
    assert final_state["metadata"]["tool_calls"] == 2
    assert len(final_state["tool_history"]) == 2

    history_tools = [entry["tool"] for entry in final_state["tool_history"]]
    assert history_tools == ["file.write", "file.edit"]

    resulting_file = workspace / target_rel_path
    assert resulting_file.exists()
    assert resulting_file.read_text(encoding="utf-8") == updated_content


def test_file_tool_call_creates_checkpoints(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    workspace_path = str(workspace)

    target_rel_path = Path("src") / "demo.txt"
    file_param = target_rel_path.as_posix()
    initial_content = "alpha line\n"
    updated_content = "beta line\n"

    _clear_file_history(workspace_path)

    _patch_agent_responses(
        monkeypatch,
        responses=[
            _await_tool_response(
                message="Creating the demo file.",
                tool="file.write",
                params=[
                    ("file_path", file_param),
                    ("content", initial_content),
                    ("create_dirs", True),
                ],
                reason="Initialize the file with starting content",
            ),
            _await_tool_response(
                message="Updating the first line.",
                tool="file.edit",
                params=[
                    ("file_path", file_param),
                    ("edit_mode", "line_range"),
                    ("start_line", 1),
                    ("end_line", 1),
                    ("new_content", updated_content),
                ],
                reason="Replace the first line with updated text",
            ),
            _complete_response("File updated successfully."),
        ],
    )

    executor = SingleDomainExecutor()

    state = executor.execute_domain_task(
        domain_id="coder",
        user_request="Create a file then update its first line.",
        chat_id="chat-checkpoints",
        workspace_path=workspace_path,
    )

    assert state["status"] == "waiting_user"
    first_tool = state["pending_tool"]
    assert first_tool is not None
    assert first_tool["tool"] == "file.write"

    mid_state = executor.handle_tool_decision(
        task_id=state["task_id"],
        call_id=first_tool["call_id"],
        decision="accept",
    )

    history_after_write = _fetch_file_history_contents(workspace_path, file_param)
    assert history_after_write == [initial_content]

    assert mid_state["status"] == "waiting_user"
    second_tool = mid_state["pending_tool"]
    assert second_tool is not None
    assert second_tool["tool"] == "file.edit"

    final_state = executor.handle_tool_decision(
        task_id=mid_state["task_id"],
        call_id=second_tool["call_id"],
        decision="accept",
    )

    assert final_state["status"] == "completed"
    history_after_edit = _fetch_file_history_contents(workspace_path, file_param)
    assert history_after_edit[:2] == [updated_content, initial_content]
    assert len(history_after_edit) == 2

    _clear_file_history(workspace_path)
