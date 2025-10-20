from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Tuple

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec
from .file_utils import (
    validate_file_path,
    is_likely_binary,
    format_file_size,
    create_backup,
    workspace_relative_path,
)

_logger = get_logger(__name__)


def _tool_edit_file(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Edit an existing file using line-based or pattern-based operations.

    This tool supports two edit modes:
    1. line_range: Replace specific line ranges
    2. find_replace: Find and replace text patterns

    A backup is automatically created before editing.
    """
    file_path = params.get("file_path")
    edit_mode = params.get("edit_mode")
    create_backup_file = params.get("create_backup", True)

    if not file_path:
        raise ValueError("file_path is required")

    if not edit_mode:
        raise ValueError(
            "edit_mode is required. Choose 'line_range' for line-based editing "
            "or 'find_replace' for pattern-based editing."
        )

    if edit_mode not in ["line_range", "find_replace"]:
        raise ValueError(
            f"Invalid edit_mode '{edit_mode}'. "
            "Must be 'line_range' or 'find_replace'."
        )

    is_valid, error_msg, resolved_path = validate_file_path(
        file_path,
        must_exist=True,
        must_be_file=True,
        workspace_root=ctx.workspace_path,
    )
    if not is_valid:
        raise ValueError(f"Cannot edit file: {error_msg}")

    is_binary, reason = is_likely_binary(resolved_path)
    if is_binary:
        raise ValueError(
            f"Cannot edit '{file_path}': {reason}. "
            "This tool is for textual files only."
        )

    try:
        with open(resolved_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except UnicodeDecodeError:
        raise ValueError(
            f"Cannot edit '{file_path}': file contains invalid UTF-8 data. "
            "This tool is for UTF-8 textual files only."
        )
    except PermissionError:
        raise ValueError(
            f"Cannot edit '{file_path}': permission denied. "
            "Check that you have read/write access to this file."
        )

    original_lines = content.splitlines(keepends=True)
    original_line_count = len(original_lines)

    backup_path = None
    if create_backup_file:
        backup_path = create_backup(resolved_path)
        if not backup_path:
            _logger.warning(f"Failed to create backup for {file_path}, continuing anyway")

    if edit_mode == "line_range":
        result, updated_content = _edit_line_range(
            resolved_path, original_lines, params, original_line_count
        )
    else:  # find_replace
        result, updated_content = _edit_find_replace(
            resolved_path, content, params
        )

    result["backup_path"] = str(backup_path) if backup_path else None
    ops = [
        {
            "type": "file_edit",
            "path": workspace_relative_path(resolved_path, ctx.workspace_path),
            "absolute_path": str(resolved_path),
            "before": content,
            "after": updated_content,
            "mode": edit_mode,
        }
    ]
    return ToolResult(
        output=result,
        metadata={
            "file_path": str(resolved_path),
            "edit_mode": edit_mode,
            "backup_created": backup_path is not None
        },
        ops=ops,
    )


def _edit_line_range(
    resolved_path: Path,
    original_lines: list,
    params: Dict[str, Any],
    original_line_count: int
) -> Tuple[Dict[str, Any], str]:
    """Edit specific line ranges in a file."""
    start_line = params.get("start_line")
    end_line = params.get("end_line")
    new_content = params.get("new_content")

    if start_line is None:
        raise ValueError("start_line is required for line_range edit mode")

    if end_line is None:
        end_line = start_line

    if not isinstance(new_content, str):
        raise ValueError("new_content must be a string")

    if start_line < 1 or start_line > original_line_count:
        raise ValueError(
            f"start_line {start_line} is out of range. "
            f"File has {original_line_count} lines (valid range: 1-{original_line_count})."
        )

    if end_line < 1 or end_line > original_line_count:
        raise ValueError(
            f"end_line {end_line} is out of range. "
            f"File has {original_line_count} lines (valid range: 1-{original_line_count})."
        )

    if start_line > end_line:
        raise ValueError(
            f"start_line ({start_line}) cannot be greater than end_line ({end_line})."
        )

    start_idx = start_line - 1
    end_idx = end_line

    new_lines = new_content.splitlines(keepends=True)
    if new_lines and not new_lines[-1].endswith('\n'):
        if start_idx < len(original_lines) and original_lines[start_idx].endswith('\n'):
            new_lines[-1] += '\n'

    result_lines = original_lines[:start_idx] + new_lines + original_lines[end_idx:]
    new_file_content = ''.join(result_lines)

    try:
        with open(resolved_path, 'w', encoding='utf-8') as f:
            f.write(new_file_content)

        file_size = resolved_path.stat().st_size
        new_line_count = len(result_lines)

        _logger.info(
            f"Successfully edited '{resolved_path}' "
            f"(lines {start_line}-{end_line}, new line count: {new_line_count})"
        )

        return {
            "status": "success",
            "file_path": str(resolved_path),
            "edit_mode": "line_range",
            "lines_affected": f"{start_line}-{end_line}",
            "original_line_count": original_line_count,
            "new_line_count": new_line_count,
            "metadata": {
                "file_size": format_file_size(file_size),
                "file_size_bytes": file_size
            }
        }, new_file_content

    except PermissionError:
        raise ValueError(
            f"Cannot write to '{resolved_path}': permission denied. "
            "Check that you have write access to this file."
        )
    except Exception as e:
        raise ValueError(f"Error writing edited file '{resolved_path}': {str(e)}")


def _edit_find_replace(
    resolved_path: Path,
    original_content: str,
    params: Dict[str, Any]
) -> Tuple[Dict[str, Any], str]:
    """Find and replace text patterns in a file."""
    find_text = params.get("find_text")
    replace_text = params.get("replace_text")
    use_regex = params.get("use_regex", False)
    replace_all = params.get("replace_all", True)

    if find_text is None:
        raise ValueError("find_text is required for find_replace edit mode")

    if replace_text is None:
        raise ValueError("replace_text is required for find_replace edit mode")

    if not isinstance(find_text, str) or not isinstance(replace_text, str):
        raise ValueError("find_text and replace_text must be strings")

    if not find_text:
        raise ValueError(
            "find_text cannot be empty. "
            "Specify the text or pattern to search for."
        )

    warnings = []
    if use_regex:
        if any(dangerous in find_text for dangerous in ['.*.*', '.+.+', '(.*)*', '(.+)+']):
            warnings.append(
                f"Warning: Pattern '{find_text}' may be slow on large files (potential ReDoS). "
                "Consider using a simpler pattern if performance is an issue."
            )

    if use_regex:
        try:
            pattern = re.compile(find_text)

            if replace_all:
                new_content = pattern.sub(replace_text, original_content)
                match_count = len(pattern.findall(original_content))
            else:
                new_content = pattern.sub(replace_text, original_content, count=1)
                match_count = 1 if pattern.search(original_content) else 0
        except re.error as e:
            raise ValueError(f"Invalid regex pattern '{find_text}': {str(e)}")
    else:
        if replace_all:
            match_count = original_content.count(find_text)
            new_content = original_content.replace(find_text, replace_text)
        else:
            match_count = 1 if find_text in original_content else 0
            new_content = original_content.replace(find_text, replace_text, 1)

    if match_count == 0:
        raise ValueError(
            f"No matches found for '{find_text}' in file '{resolved_path}'. "
            "Check the find_text value and try again."
        )

    try:
        with open(resolved_path, 'w', encoding='utf-8') as f:
            f.write(new_content)

        file_size = resolved_path.stat().st_size
        new_line_count = new_content.count('\n') + 1

        _logger.info(
            f"Successfully edited '{resolved_path}' "
            f"(find_replace, {match_count} replacements)"
        )

        result = {
            "status": "success",
            "file_path": str(resolved_path),
            "edit_mode": "find_replace",
            "replacements_made": match_count,
            "metadata": {
                "file_size": format_file_size(file_size),
                "file_size_bytes": file_size,
                "line_count": new_line_count
            }
        }

        if warnings:
            result["warnings"] = warnings

        return result, new_content

    except PermissionError:
        raise ValueError(
            f"Cannot write to '{resolved_path}': permission denied. "
            "Check that you have write access to this file."
        )
    except Exception as e:
        raise ValueError(f"Error writing edited file '{resolved_path}': {str(e)}")


edit_file_spec = ToolSpec(
    name="file.edit",
    version="1.0",
    description="Edit an existing textual file using line-based or pattern-based operations",
    effects=["disk"],
    in_schema={
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Path to the file to edit"
            },
            "edit_mode": {
                "type": "string",
                "enum": ["line_range", "find_replace"],
                "description": "Edit mode: 'line_range' for line-based, 'find_replace' for pattern-based"
            },
            "create_backup": {
                "type": "boolean",
                "default": True,
                "description": "Create a backup before editing"
            },
            "start_line": {
                "type": "integer",
                "description": "Start line number (1-indexed, for line_range mode)"
            },
            "end_line": {
                "type": "integer",
                "description": "End line number (1-indexed, for line_range mode, defaults to start_line)"
            },
            "new_content": {
                "type": "string",
                "description": "New content to replace the line range (for line_range mode)"
            },
            "find_text": {
                "type": "string",
                "description": "Text or pattern to find (for find_replace mode)"
            },
            "replace_text": {
                "type": "string",
                "description": "Replacement text (for find_replace mode)"
            },
            "use_regex": {
                "type": "boolean",
                "default": False,
                "description": "Use regex for find_text (for find_replace mode)"
            },
            "replace_all": {
                "type": "boolean",
                "default": True,
                "description": "Replace all occurrences (for find_replace mode)"
            }
        },
        "required": ["file_path", "edit_mode"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "file_path": {"type": "string"},
            "edit_mode": {"type": "string"},
            "backup_path": {"type": "string"},
            "metadata": {"type": "object"}
        }
    },
    fn=_tool_edit_file,
    rate_key="file.edit"
)