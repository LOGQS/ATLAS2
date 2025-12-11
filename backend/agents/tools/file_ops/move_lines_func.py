from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from utils.logger import get_logger
from utils.checkpoint_utils import save_file_checkpoint, cleanup_old_checkpoints
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec, ProcessingMode
from .file_utils import (
    validate_file_path,
    is_likely_binary,
    create_backup,
    check_paths_same,
    workspace_relative_path,
)

_logger = get_logger(__name__)


def _tool_move_lines(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Move lines from one file to another.

    This tool:
    - Extracts specified line range from source file
    - Inserts lines at specified position in destination file
    - Optionally removes lines from source file
    - Creates backups of both files before modification
    """
    source_path = params.get("source_path")
    start_line = params.get("start_line")
    end_line = params.get("end_line")
    destination_path = params.get("destination_path")
    insert_at_line = params.get("insert_at_line")
    remove_from_source = params.get("remove_from_source", True)
    create_backup_files = params.get("create_backup", True)

    if not source_path:
        raise ValueError("source_path is required")

    if start_line is None:
        raise ValueError("start_line is required (1-indexed line number)")

    if not destination_path:
        raise ValueError("destination_path is required")

    if end_line is None:
        end_line = start_line

    is_valid, error_msg, source_resolved = validate_file_path(
        source_path,
        must_exist=True,
        must_be_file=True,
        workspace_root=ctx.workspace_path,
    )
    if not is_valid:
        raise ValueError(f"Cannot read source file: {error_msg}")

    is_binary, reason = is_likely_binary(source_resolved)
    if is_binary:
        raise ValueError(
            f"Cannot move lines from '{source_path}': {reason}. "
            "This tool is for textual files only."
        )

    dest_valid, dest_error, dest_resolved = validate_file_path(
        destination_path,
        must_exist=False,
        must_be_file=True,
        workspace_root=ctx.workspace_path,
    )
    if not dest_valid:
        raise ValueError(f"Cannot prepare destination file: {dest_error}")
    dest_exists = dest_resolved.exists()

    if check_paths_same(source_resolved, dest_resolved):
        raise ValueError(
            f"Cannot move lines from '{source_path}' to '{destination_path}': "
            "source and destination are the same file. This would corrupt the file. "
            "Use edit_file instead to modify a file in place."
        )

    if dest_exists:
        if dest_resolved.is_dir():
            raise ValueError(
                f"Cannot move lines to '{destination_path}': path is a directory, not a file."
            )
        is_binary, reason = is_likely_binary(dest_resolved)
        if is_binary:
            raise ValueError(
                f"Cannot move lines to '{destination_path}': {reason}. "
                "This tool is for textual files only."
            )

    try:
        with open(source_resolved, 'r', encoding='utf-8') as f:
            source_lines = f.readlines()
        source_content_before = ''.join(source_lines)
    except UnicodeDecodeError:
        raise ValueError(
            f"Cannot read '{source_path}': file contains invalid UTF-8 data."
        )
    except PermissionError:
        raise ValueError(
            f"Cannot read '{source_path}': permission denied."
        )

    source_line_count = len(source_lines)

    if start_line < 1 or start_line > source_line_count:
        raise ValueError(
            f"start_line {start_line} is out of range. "
            f"Source file has {source_line_count} lines (valid range: 1-{source_line_count})."
        )

    if end_line < 1 or end_line > source_line_count:
        raise ValueError(
            f"end_line {end_line} is out of range. "
            f"Source file has {source_line_count} lines (valid range: 1-{source_line_count})."
        )

    if start_line > end_line:
        raise ValueError(
            f"start_line ({start_line}) cannot be greater than end_line ({end_line})."
        )

    start_idx = start_line - 1
    end_idx = end_line
    lines_to_move = source_lines[start_idx:end_idx]
    lines_moved_count = len(lines_to_move)

    if dest_exists:
        try:
            with open(dest_resolved, 'r', encoding='utf-8') as f:
                dest_lines = f.readlines()
            dest_content_before = ''.join(dest_lines)
        except UnicodeDecodeError:
            raise ValueError(
                f"Cannot read '{destination_path}': file contains invalid UTF-8 data."
            )
        except PermissionError:
            raise ValueError(
                f"Cannot read '{destination_path}': permission denied."
            )
    else:
        dest_lines = []
        dest_content_before = ''

    dest_line_count = len(dest_lines)

    if insert_at_line is None:
        insert_idx = len(dest_lines)
        insert_position_desc = "end"
    else:
        if insert_at_line < 1 or insert_at_line > dest_line_count + 1:
            raise ValueError(
                f"insert_at_line {insert_at_line} is out of range. "
                f"Destination file has {dest_line_count} lines (valid range: 1-{dest_line_count + 1})."
            )
        insert_idx = insert_at_line - 1
        insert_position_desc = f"line {insert_at_line}"

    if create_backup_files:
        source_backup = create_backup(source_resolved)
        if dest_exists:
            dest_backup = create_backup(dest_resolved)
        else:
            dest_backup = None
    else:
        source_backup = None
        dest_backup = None

    new_dest_lines = dest_lines[:insert_idx] + lines_to_move + dest_lines[insert_idx:]
    dest_content_after = ''.join(new_dest_lines)

    try:
        dest_resolved.parent.mkdir(parents=True, exist_ok=True)
        with open(dest_resolved, 'w', encoding='utf-8') as f:
            f.writelines(new_dest_lines)
    except PermissionError:
        raise ValueError(
            f"Cannot write to '{destination_path}': permission denied."
        )
    except Exception as e:
        raise ValueError(f"Error writing to '{destination_path}': {str(e)}")

    warnings = []
    if remove_from_source:
        new_source_lines = source_lines[:start_idx] + source_lines[end_idx:]

        if not new_source_lines or (len(new_source_lines) == 1 and not new_source_lines[0].strip()):
            warnings.append(
                f"Warning: Moving these lines will leave source file '{source_path}' empty or nearly empty. "
                "Verify this is intentional."
            )

        try:
            with open(source_resolved, 'w', encoding='utf-8') as f:
                f.writelines(new_source_lines)
        except PermissionError:
            raise ValueError(
                f"Cannot write to '{source_path}': permission denied."
            )
        except Exception as e:
            raise ValueError(f"Error writing to '{source_path}': {str(e)}")

        source_action = "removed from source"
        new_source_line_count = len(new_source_lines)
    else:
        source_action = "copied (kept in source)"
        new_source_line_count = source_line_count
        new_source_lines = source_lines

    _logger.info(
        f"Successfully moved {lines_moved_count} lines from '{source_path}' "
        f"(lines {start_line}-{end_line}) to '{destination_path}' (at {insert_position_desc})"
    )

    result_output = {
        "status": "success",
        "source_path": source_path,
        "destination_path": str(dest_resolved),
        "lines_moved": lines_moved_count,
        "source_lines": f"{start_line}-{end_line}",
        "inserted_at": insert_position_desc,
        "action": source_action,
        "source_file": {
            "original_line_count": source_line_count,
            "new_line_count": new_source_line_count,
            "backup_path": str(source_backup) if source_backup else None
        },
        "destination_file": {
            "original_line_count": dest_line_count,
            "new_line_count": len(new_dest_lines),
            "backup_path": str(dest_backup) if dest_backup else None
        }
    }

    if warnings:
        result_output["warnings"] = warnings

    source_content_after = ''.join(new_source_lines)

    # Save checkpoints directly (instead of returning ops for executor to process)
    if ctx.workspace_path:
        # Checkpoint for destination file
        dest_relative_path = workspace_relative_path(dest_resolved, ctx.workspace_path)
        if dest_content_before != dest_content_after:
            save_file_checkpoint(
                workspace_path=ctx.workspace_path,
                file_path=dest_relative_path,
                content=dest_content_before,
                edit_type='checkpoint'
            )
            save_file_checkpoint(
                workspace_path=ctx.workspace_path,
                file_path=dest_relative_path,
                content=dest_content_after,
                edit_type='checkpoint'
            )
            cleanup_old_checkpoints(ctx.workspace_path, dest_relative_path)

        # Checkpoint for source file if it was modified
        if remove_from_source and source_content_before != source_content_after:
            source_relative_path = workspace_relative_path(source_resolved, ctx.workspace_path)
            save_file_checkpoint(
                workspace_path=ctx.workspace_path,
                file_path=source_relative_path,
                content=source_content_before,
                edit_type='checkpoint'
            )
            save_file_checkpoint(
                workspace_path=ctx.workspace_path,
                file_path=source_relative_path,
                content=source_content_after,
                edit_type='checkpoint'
            )
            cleanup_old_checkpoints(ctx.workspace_path, source_relative_path)

    return ToolResult(
        output=result_output,
        metadata={
            "source": source_path,
            "destination": str(dest_resolved),
            "lines_moved": lines_moved_count,
            "removed_from_source": remove_from_source,
            "has_warnings": bool(warnings)
        },
    )


move_lines_spec = ToolSpec(
    name="file.move_lines",
    version="1.0",
    description="Move lines from one file to another",
    effects=["disk"],
    in_schema={
        "type": "object",
        "properties": {
            "source_path": {
                "type": "string",
                "description": "Path to the source file"
            },
            "start_line": {
                "type": "integer",
                "description": "Start line number to move (1-indexed)"
            },
            "end_line": {
                "type": "integer",
                "description": "End line number to move (1-indexed, defaults to start_line)"
            },
            "destination_path": {
                "type": "string",
                "description": "Path to the destination file (will be created if it doesn't exist)"
            },
            "insert_at_line": {
                "type": "integer",
                "description": "Line number where to insert in destination (1-indexed, defaults to end of file)"
            },
            "remove_from_source": {
                "type": "boolean",
                "default": True,
                "description": "Remove lines from source after copying (default: true)"
            },
            "create_backup": {
                "type": "boolean",
                "default": True,
                "description": "Create backups before modifying files"
            }
        },
        "required": ["source_path", "start_line", "destination_path"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "source_path": {"type": "string"},
            "destination_path": {"type": "string"},
            "lines_moved": {"type": "integer"},
            "source_lines": {"type": "string"},
            "inserted_at": {"type": "string"},
            "action": {"type": "string"},
            "source_file": {"type": "object"},
            "destination_file": {"type": "object"}
        }
    },
    fn=_tool_move_lines,
    rate_key="file.move_lines",
    timeout_seconds=30.0,  # Line moves with checkpoint saving
    processing_mode=ProcessingMode.THREAD,
)