from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec
from .file_utils import (
    validate_file_path,
    is_likely_binary,
    format_file_size,
    load_context_manifest,
    save_context_manifest,
    workspace_relative_path,
)

_logger = get_logger(__name__)


def _tool_read_file(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Read a textual file and return its contents.

    This tool:
    - Validates the file exists and is readable
    - Checks if the file is textual (not binary)
    - Tracks read files in context to detect duplicates
    - Returns file content with metadata
    """
    file_path = params.get("file_path")
    max_size_mb = params.get("max_size_mb", 10)
    force_reread = params.get("force_reread", False)

    if not file_path:
        raise ValueError("file_path is required")

    is_valid, error_msg, resolved_path = validate_file_path(
        file_path,
        must_exist=True,
        must_be_file=True,
        workspace_root=ctx.workspace_path,
    )
    if not is_valid:
        raise ValueError(f"Cannot read file: {error_msg}")

    is_binary, reason = is_likely_binary(resolved_path)
    if is_binary:
        raise ValueError(
            f"Cannot read '{file_path}': {reason}. "
            "This tool is for textual files only. Use attach_file for binary files "
            "like images, PDFs, or other non-textual formats."
        )

    file_size = resolved_path.stat().st_size
    max_size_bytes = max_size_mb * 1024 * 1024

    if file_size > max_size_bytes:
        raise ValueError(
            f"File '{file_path}' is too large ({format_file_size(file_size)}). "
            f"Maximum allowed size is {max_size_mb} MB. "
            f"Consider increasing max_size_mb parameter or using attach_file for large files."
        )

    manifest = load_context_manifest(ctx.ctx_id)
    read_files = manifest.get("read_files", [])
    file_path_str = str(resolved_path)

    if file_path_str in read_files and not force_reread:
        _logger.info(f"File '{file_path}' already read in context {ctx.ctx_id}")
        return ToolResult(
            output={
                "status": "duplicate",
                "message": f"File '{file_path}' has already been read in this context. "
                          "The file content is already available in the conversation history. "
                          "Set force_reread=true if you need to read it again.",
                "file_path": file_path,
                "file_size": format_file_size(file_size)
            },
            metadata={"duplicate": True, "file_path": file_path_str}
        )

    try:
        with open(resolved_path, 'r', encoding='utf-8') as f:
            content = f.read()

        line_count = content.count('\n') + 1

        lines = content.splitlines()
        long_lines = [(i + 1, len(line)) for i, line in enumerate(lines) if len(line) > 200000]
        warnings = []

        if long_lines:
            max_line_num, max_line_len = max(long_lines, key=lambda x: x[1])
            estimated_tokens = max_line_len // 4
            warnings.append(
                f"File contains very long lines (longest: line {max_line_num} with {max_line_len} characters, ~{estimated_tokens:,} tokens). "
                f"This may cause issues with LLM context windows. Consider breaking long lines or using attach_file."
            )

        if file_path_str not in read_files:
            read_files.append(file_path_str)
            manifest["read_files"] = read_files
            save_context_manifest(ctx.ctx_id, manifest)

        _logger.info(f"Successfully read file '{file_path}' ({format_file_size(file_size)}, {line_count} lines)")

        result_output = {
            "status": "success",
            "file_path": file_path,
            "resolved_path": str(resolved_path),
            "workspace_path": workspace_relative_path(resolved_path, ctx.workspace_path),
            "content": content,
            "metadata": {
                "file_size": format_file_size(file_size),
                "file_size_bytes": file_size,
                "line_count": line_count,
                "encoding": "utf-8"
            }
        }

        if warnings:
            result_output["warnings"] = warnings

        return ToolResult(
            output=result_output,
            metadata={"file_path": file_path_str, "line_count": line_count, "has_warnings": bool(warnings)}
        )

    except UnicodeDecodeError as e:
        raise ValueError(
            f"Cannot read '{file_path}': file contains invalid UTF-8 data. "
            "This file may be binary or use a different encoding. "
            "Use attach_file for non-UTF-8 files."
        )
    except PermissionError:
        raise ValueError(
            f"Cannot read '{file_path}': permission denied. "
            "Check that you have read access to this file."
        )
    except Exception as e:
        raise ValueError(f"Error reading file '{file_path}': {str(e)}")


read_file_spec = ToolSpec(
    name="file.read",
    version="1.0",
    description="Read a textual file and return its contents with duplicate detection",
    effects=["disk"],
    in_schema={
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Path to the file to read"
            },
            "max_size_mb": {
                "type": "integer",
                "default": 10,
                "description": "Maximum file size in MB (default: 10)"
            },
            "force_reread": {
                "type": "boolean",
                "default": False,
                "description": "Force re-reading even if already read in this context"
            }
        },
        "required": ["file_path"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "file_path": {"type": "string"},
            "content": {"type": "string"},
            "message": {"type": "string"},
            "metadata": {"type": "object"}
        }
    },
    fn=_tool_read_file,
    rate_key="file.read"
)