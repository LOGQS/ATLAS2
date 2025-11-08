from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec
from .file_utils import validate_directory_path, is_likely_binary

_logger = get_logger(__name__)


def _tool_grep_files(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Search for patterns within file contents (grep-like functionality).

    This tool:
    - Searches file contents for text patterns (supports regex)
    - Filters by file patterns (glob) and file types
    - Shows context lines before/after matches
    - Returns line numbers and match contexts
    - Skips binary files automatically
    - Limits results to prevent overwhelming output
    """
    pattern = params.get("pattern")
    search_root = params.get("search_root", ".")
    file_pattern = params.get("file_pattern", "**/*")
    case_sensitive = params.get("case_sensitive", True)
    use_regex = params.get("use_regex", False)
    context_before = params.get("context_before", 0)
    context_after = params.get("context_after", 0)
    max_matches_per_file = params.get("max_matches_per_file", 50)
    max_files = params.get("max_files", 100)
    include_line_numbers = params.get("include_line_numbers", True)
    whole_word = params.get("whole_word", False)

    if not pattern:
        raise ValueError(
            "pattern is required. Provide a text pattern to search for. "
            "Examples: 'def calculate', 'import.*numpy', 'class\\s+\\w+'"
        )

    is_valid, error_msg, root_resolved = validate_directory_path(
        search_root,
        must_exist=True,
        workspace_root=ctx.workspace_path,
    )
    if not is_valid:
        raise ValueError(f"Cannot search: {error_msg}")

    if context_before < 0 or context_after < 0:
        raise ValueError(
            f"context_before ({context_before}) and context_after ({context_after}) must be non-negative"
        )

    if context_before > 20 or context_after > 20:
        raise ValueError(
            "context_before and context_after cannot exceed 20 lines. "
            "Use smaller values to avoid excessive output."
        )

    if max_matches_per_file < 1 or max_matches_per_file > 1000:
        raise ValueError(
            f"max_matches_per_file must be between 1 and 1000 (got {max_matches_per_file})"
        )

    if max_files < 1 or max_files > 1000:
        raise ValueError(
            f"max_files must be between 1 and 1000 (got {max_files})"
        )

    if '..' in file_pattern.split('/'):
        raise ValueError(
            f"file_pattern '{file_pattern}' contains directory traversal (..). "
            "This is not allowed for security reasons. "
            "Use patterns like '*.py' or '**/*.js'."
        )

    try:
        if use_regex:
            regex_flags = 0 if case_sensitive else re.IGNORECASE
            compiled_pattern = re.compile(pattern, regex_flags)
        else:
            escaped_pattern = re.escape(pattern)
            if whole_word:
                escaped_pattern = r'\b' + escaped_pattern + r'\b'
            regex_flags = 0 if case_sensitive else re.IGNORECASE
            compiled_pattern = re.compile(escaped_pattern, regex_flags)
    except re.error as e:
        raise ValueError(f"Invalid regex pattern '{pattern}': {str(e)}")

    try:
        file_list = list(root_resolved.glob(file_pattern))
    except ValueError as e:
        raise ValueError(
            f"Invalid file_pattern '{file_pattern}': {str(e)}. "
            "Use patterns like '*.py', '**/*.js', or 'test_*.py'."
        )

    file_list = [f for f in file_list if f.is_file()]

    if not file_list:
        return ToolResult(
            output={
                "status": "success",
                "pattern": pattern,
                "search_root": str(root_resolved),
                "file_pattern": file_pattern,
                "matches": [],
                "summary": {
                    "total_files_searched": 0,
                    "files_with_matches": 0,
                    "total_matches": 0,
                    "truncated": False
                },
                "message": f"No files matching pattern '{file_pattern}' found in '{search_root}'"
            },
            metadata={"match_count": 0}
        )

    all_matches = []
    files_searched = 0
    files_with_matches = 0
    total_matches = 0
    truncated_files = False
    warnings = []

    for file_path in file_list:
        if files_with_matches >= max_files:
            truncated_files = True
            break

        is_binary, _ = is_likely_binary(file_path)
        if is_binary:
            continue

        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
        except (UnicodeDecodeError, PermissionError) as e:
            _logger.debug(f"Skipping {file_path}: {e}")
            continue
        except Exception as e:
            _logger.warning(f"Error reading {file_path}: {e}")
            continue

        files_searched += 1

        file_matches = []
        for line_num, line in enumerate(lines, start=1):
            if compiled_pattern.search(line):
                context_start = max(0, line_num - 1 - context_before)
                context_end = min(len(lines), line_num + context_after)

                context_lines = []
                for i in range(context_start, context_end):
                    context_lines.append({
                        "line_number": i + 1,
                        "content": lines[i].rstrip('\n'),
                        "is_match": (i + 1 == line_num)
                    })

                match_entry = {
                    "line_number": line_num,
                    "line_content": line.rstrip('\n'),
                    "context": context_lines if (context_before > 0 or context_after > 0) else None
                }

                file_matches.append(match_entry)
                total_matches += 1

                if len(file_matches) >= max_matches_per_file:
                    warnings.append(
                        f"File '{file_path.relative_to(root_resolved)}' truncated to {max_matches_per_file} matches. "
                        "Increase max_matches_per_file to see more."
                    )
                    break

        if file_matches:
            files_with_matches += 1
            try:
                rel_path = file_path.relative_to(root_resolved)
            except ValueError:
                rel_path = file_path

            all_matches.append({
                "file_path": str(rel_path),
                "absolute_path": str(file_path.resolve()),
                "match_count": len(file_matches),
                "matches": file_matches
            })

    _logger.info(
        f"Grep search for '{pattern}' in '{search_root}' (pattern: '{file_pattern}'): "
        f"{files_searched} files searched, {files_with_matches} files with matches, {total_matches} total matches"
    )

    result = {
        "status": "success",
        "pattern": pattern,
        "search_root": str(root_resolved),
        "file_pattern": file_pattern,
        "matches": all_matches,
        "summary": {
            "total_files_searched": files_searched,
            "files_with_matches": files_with_matches,
            "total_matches": total_matches,
            "truncated": truncated_files
        }
    }

    if warnings:
        result["warnings"] = warnings

    if truncated_files:
        result["warning"] = (
            f"Results truncated to {max_files} files with matches. "
            "Increase max_files parameter or use a more specific pattern."
        )

    if total_matches == 0:
        result["message"] = (
            f"No matches found for pattern '{pattern}' in files matching '{file_pattern}' "
            f"within '{search_root}'. Try a different pattern or search parameters."
        )

    return ToolResult(
        output=result,
        metadata={
            "pattern": pattern,
            "files_searched": files_searched,
            "match_count": total_matches,
            "truncated": truncated_files
        }
    )


grep_files_spec = ToolSpec(
    name="file.grep",
    version="1.0",
    description="Search for text patterns within file contents (grep-like functionality). Supports regex, context lines, and filtering by file patterns.",
    effects=["disk"],
    in_schema={
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Text pattern to search for in file contents. Can be literal text or regex if use_regex=true."
            },
            "search_root": {
                "type": "string",
                "default": ".",
                "description": "Root directory to search from (default: current directory)"
            },
            "file_pattern": {
                "type": "string",
                "default": "**/*",
                "description": "Glob pattern to filter files to search (e.g., '*.py', '**/*.js', 'src/**/*.ts'). Default: all files."
            },
            "case_sensitive": {
                "type": "boolean",
                "default": True,
                "description": "Whether the search is case-sensitive (default: true)"
            },
            "use_regex": {
                "type": "boolean",
                "default": False,
                "description": "Treat pattern as a regular expression (default: false, literal text search)"
            },
            "whole_word": {
                "type": "boolean",
                "default": False,
                "description": "Match whole words only (default: false). Only applies when use_regex=false."
            },
            "context_before": {
                "type": "integer",
                "default": 0,
                "description": "Number of lines to show before each match (0-20, default: 0)"
            },
            "context_after": {
                "type": "integer",
                "default": 0,
                "description": "Number of lines to show after each match (0-20, default: 0)"
            },
            "max_matches_per_file": {
                "type": "integer",
                "default": 50,
                "description": "Maximum matches to return per file (1-1000, default: 50)"
            },
            "max_files": {
                "type": "integer",
                "default": 100,
                "description": "Maximum number of files with matches to return (1-1000, default: 100)"
            },
            "include_line_numbers": {
                "type": "boolean",
                "default": True,
                "description": "Include line numbers in results (default: true)"
            }
        },
        "required": ["pattern"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "pattern": {"type": "string"},
            "search_root": {"type": "string"},
            "file_pattern": {"type": "string"},
            "matches": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "file_path": {"type": "string"},
                        "absolute_path": {"type": "string"},
                        "match_count": {"type": "integer"},
                        "matches": {"type": "array"}
                    }
                }
            },
            "summary": {
                "type": "object",
                "properties": {
                    "total_files_searched": {"type": "integer"},
                    "files_with_matches": {"type": "integer"},
                    "total_matches": {"type": "integer"},
                    "truncated": {"type": "boolean"}
                }
            },
            "warnings": {"type": "array"},
            "warning": {"type": "string"},
            "message": {"type": "string"}
        }
    },
    fn=_tool_grep_files,
    rate_key="file.grep"
)
