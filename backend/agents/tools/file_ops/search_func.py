from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec
from .file_utils import validate_directory_path

_logger = get_logger(__name__)


def _tool_search_files(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Search for files using glob patterns.

    This tool:
    - Searches for files matching glob patterns (e.g., *.py, **/*.js)
    - Filters by file type (files vs directories)
    - Limits results to prevent overwhelming output
    - Returns relative paths from search root
    """
    pattern = params.get("pattern")
    search_root = params.get("search_root", ".")
    include_dirs = params.get("include_dirs", False)
    max_results = params.get("max_results", 100)

    if not pattern:
        raise ValueError(
            "pattern is required. Examples: '*.py', '**/*.js', 'test_*.py', 'src/**/*.ts'"
        )

    is_valid, error_msg, root_resolved = validate_directory_path(search_root, must_exist=True)
    if not is_valid:
        raise ValueError(f"Cannot search: {error_msg}")

    try:
        if '..' in pattern.split('/'):
            raise ValueError(
                f"Pattern '{pattern}' contains directory traversal (..). "
                "This is not allowed for security reasons. "
                "Use relative patterns like '*.py' or '**/*.js'."
            )

        matches = []
        truncated = False

        try:
            glob_iter = root_resolved.glob(pattern)
        except ValueError as e:
            raise ValueError(
                f"Invalid glob pattern '{pattern}': {str(e)}. "
                "Use patterns like '*.py', '**/*.js', or 'test_*.py'."
            )

        for match_path in glob_iter:
            if len(matches) >= max_results:
                truncated = True
                break

            if match_path.is_dir():
                if not include_dirs:
                    continue
                entry_type = "directory"
            elif match_path.is_file():
                entry_type = "file"
            else:
                continue

            try:
                rel_path = match_path.relative_to(root_resolved)
                abs_path = match_path.resolve()

                entry = {
                    "path": str(rel_path),
                    "absolute_path": str(abs_path),
                    "type": entry_type,
                    "name": match_path.name
                }

                matches.append(entry)

            except Exception as e:
                _logger.debug(f"Error processing match {match_path}: {e}")

        _logger.info(
            f"Search pattern '{pattern}' in '{search_root}' found {len(matches)} matches "
            f"(truncated={truncated})"
        )

        result = {
            "status": "success",
            "pattern": pattern,
            "search_root": str(root_resolved),
            "matches": matches,
            "summary": {
                "total_matches": len(matches),
                "files": len([m for m in matches if m["type"] == "file"]),
                "directories": len([m for m in matches if m["type"] == "directory"]),
                "truncated": truncated
            }
        }

        if truncated:
            result["warning"] = (
                f"Results truncated to {max_results} matches. "
                "Increase max_results parameter or use a more specific pattern."
            )

        if len(matches) == 0:
            result["message"] = (
                f"No files matching pattern '{pattern}' found in '{search_root}'. "
                "Try a different pattern or search_root."
            )

        return ToolResult(
            output=result,
            metadata={
                "pattern": pattern,
                "match_count": len(matches),
                "truncated": truncated
            }
        )

    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"Error searching for pattern '{pattern}': {str(e)}")


search_files_spec = ToolSpec(
    name="file.search",
    version="1.0",
    description="Search for files using glob patterns",
    effects=["disk"],
    in_schema={
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Glob pattern to search (e.g., '*.py', '**/*.js', 'test_*.py')"
            },
            "search_root": {
                "type": "string",
                "default": ".",
                "description": "Root directory to search from (default: current directory)"
            },
            "include_dirs": {
                "type": "boolean",
                "default": False,
                "description": "Include directories in results (default: files only)"
            },
            "max_results": {
                "type": "integer",
                "default": 100,
                "description": "Maximum number of results to return"
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
            "matches": {"type": "array"},
            "summary": {"type": "object"},
            "warning": {"type": "string"},
            "message": {"type": "string"}
        }
    },
    fn=_tool_search_files,
    rate_key="file.search"
)