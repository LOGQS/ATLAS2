from __future__ import annotations

import fnmatch
import time
from pathlib import Path
from typing import Any, Dict, List

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec
from .file_utils import validate_directory_path, format_file_size

_logger = get_logger(__name__)


def _tool_search_files(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Search for files using glob patterns with advanced filtering.

    This tool:
    - Searches for files matching glob patterns (e.g., *.py, **/*.js)
    - Supports multiple include patterns and exclude patterns
    - Filters by file type (files vs directories)
    - Controls hidden file inclusion
    - Supports case-insensitive matching
    - Limits recursion depth
    - Returns file metadata (size, modified time)
    - Sorts results by various criteria
    - Limits results to prevent overwhelming output
    """
    pattern = params.get("pattern")
    patterns = params.get("patterns", [])
    exclude_patterns = params.get("exclude_patterns", [])
    search_root = params.get("search_root", ".")
    include_dirs = params.get("include_dirs", False)
    include_hidden = params.get("include_hidden", False)
    case_sensitive = params.get("case_sensitive", True)
    max_depth = params.get("max_depth")
    max_results = params.get("max_results", 100)
    sort_by = params.get("sort_by", "name")
    include_metadata = params.get("include_metadata", False)

    search_patterns = []
    if pattern:
        search_patterns.append(pattern)
    if patterns:
        if not isinstance(patterns, list):
            raise ValueError("patterns must be a list of glob patterns")
        search_patterns.extend(patterns)

    if not search_patterns:
        raise ValueError(
            "pattern or patterns is required. Examples: '*.py', '**/*.js', 'test_*.py', 'src/**/*.ts'"
        )

    if exclude_patterns and not isinstance(exclude_patterns, list):
        raise ValueError("exclude_patterns must be a list of glob patterns")

    valid_sort_options = ["name", "size", "modified", "type"]
    if sort_by not in valid_sort_options:
        raise ValueError(
            f"sort_by must be one of {valid_sort_options}, got '{sort_by}'"
        )

    if max_depth is not None:
        if not isinstance(max_depth, int) or max_depth < 0:
            raise ValueError(f"max_depth must be a non-negative integer, got {max_depth}")
        if max_depth > 20:
            raise ValueError(
                f"max_depth cannot exceed 20 (got {max_depth}). "
                "Use smaller values to prevent excessive recursion."
            )

    is_valid, error_msg, root_resolved = validate_directory_path(
        search_root,
        must_exist=True,
        workspace_root=ctx.workspace_path,
    )
    if not is_valid:
        raise ValueError(f"Cannot search: {error_msg}")

    all_patterns = search_patterns + exclude_patterns
    for pat in all_patterns:
        if '..' in pat.split('/'):
            raise ValueError(
                f"Pattern '{pat}' contains directory traversal (..). "
                "This is not allowed for security reasons. "
                "Use relative patterns like '*.py' or '**/*.js'."
            )

    try:
        matches = []
        truncated = False
        skipped_hidden = 0

        all_match_paths = set()
        for pat in search_patterns:
            try:
                for match_path in root_resolved.glob(pat):
                    all_match_paths.add(match_path)
            except ValueError as e:
                raise ValueError(
                    f"Invalid glob pattern '{pat}': {str(e)}. "
                    "Use patterns like '*.py', '**/*.js', or 'test_*.py'."
                )

        for match_path in all_match_paths:
            if len(matches) >= max_results:
                truncated = True
                break

            is_hidden = match_path.name.startswith('.')
            if is_hidden and not include_hidden:
                skipped_hidden += 1
                continue

            if max_depth is not None:
                try:
                    rel_path = match_path.relative_to(root_resolved)
                    depth = len(rel_path.parts) - 1
                    if depth > max_depth:
                        continue
                except ValueError:
                    continue

            if exclude_patterns:
                excluded = False
                try:
                    rel_path = match_path.relative_to(root_resolved)
                    rel_path_str = str(rel_path)
                    if not case_sensitive:
                        rel_path_str = rel_path_str.lower()

                    for exclude_pat in exclude_patterns:
                        exclude_check = exclude_pat.lower() if not case_sensitive else exclude_pat
                        if fnmatch.fnmatch(rel_path_str, exclude_check):
                            excluded = True
                            break
                except ValueError:
                    pass

                if excluded:
                    continue

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

                if include_metadata:
                    try:
                        stat = match_path.stat()
                        entry["metadata"] = {
                            "size_bytes": stat.st_size if entry_type == "file" else 0,
                            "size": format_file_size(stat.st_size) if entry_type == "file" else "N/A",
                            "modified_time": stat.st_mtime,
                            "modified_time_str": time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(stat.st_mtime)),
                            "is_hidden": is_hidden
                        }
                    except Exception as e:
                        _logger.debug(f"Error getting metadata for {match_path}: {e}")

                matches.append(entry)

            except Exception as e:
                _logger.debug(f"Error processing match {match_path}: {e}")

        if sort_by == "name":
            matches.sort(key=lambda m: m["name"].lower() if not case_sensitive else m["name"])
        elif sort_by == "size" and include_metadata:
            matches.sort(key=lambda m: m.get("metadata", {}).get("size_bytes", 0), reverse=True)
        elif sort_by == "modified" and include_metadata:
            matches.sort(key=lambda m: m.get("metadata", {}).get("modified_time", 0), reverse=True)
        elif sort_by == "type":
            matches.sort(key=lambda m: (m["type"], m["name"].lower() if not case_sensitive else m["name"]))

        patterns_str = ", ".join(search_patterns) if len(search_patterns) <= 3 else f"{len(search_patterns)} patterns"
        _logger.info(
            f"Search patterns [{patterns_str}] in '{search_root}' found {len(matches)} matches "
            f"(truncated={truncated}, skipped_hidden={skipped_hidden})"
        )

        result = {
            "status": "success",
            "patterns": search_patterns,
            "exclude_patterns": exclude_patterns,
            "search_root": str(root_resolved),
            "matches": matches,
            "summary": {
                "total_matches": len(matches),
                "files": len([m for m in matches if m["type"] == "file"]),
                "directories": len([m for m in matches if m["type"] == "directory"]),
                "truncated": truncated,
                "skipped_hidden": skipped_hidden
            }
        }

        warnings = []
        if truncated:
            warnings.append(
                f"Results truncated to {max_results} matches. "
                "Increase max_results parameter or use a more specific pattern."
            )

        if skipped_hidden > 0:
            warnings.append(
                f"Skipped {skipped_hidden} hidden files/directories. "
                "Set include_hidden=true to include them."
            )

        if warnings:
            result["warnings"] = warnings

        if len(matches) == 0:
            result["message"] = (
                f"No files matching patterns {search_patterns} found in '{search_root}'. "
                "Try a different pattern or search_root."
            )

        return ToolResult(
            output=result,
            metadata={
                "patterns": search_patterns,
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
    description="Search for files using advanced glob patterns with filtering, exclusions, metadata, and sorting",
    effects=["disk"],
    in_schema={
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Primary glob pattern to search (e.g., '*.py', '**/*.js', 'test_*.py'). Can be combined with patterns parameter."
            },
            "patterns": {
                "type": "array",
                "description": "Additional glob patterns to search (matches files matching ANY pattern)",
                "items": {"type": "string"}
            },
            "exclude_patterns": {
                "type": "array",
                "description": "Glob patterns to exclude from results (e.g., ['node_modules/**', '*.pyc', '__pycache__/**'])",
                "items": {"type": "string"}
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
            "include_hidden": {
                "type": "boolean",
                "default": False,
                "description": "Include hidden files/directories (names starting with .) (default: false)"
            },
            "case_sensitive": {
                "type": "boolean",
                "default": True,
                "description": "Case-sensitive pattern matching (default: true)"
            },
            "max_depth": {
                "type": "integer",
                "description": "Maximum recursion depth (0=current dir only, 1=one level deep, etc., max: 20)"
            },
            "max_results": {
                "type": "integer",
                "default": 100,
                "description": "Maximum number of results to return (default: 100)"
            },
            "sort_by": {
                "type": "string",
                "enum": ["name", "size", "modified", "type"],
                "default": "name",
                "description": "Sort results by: 'name', 'size', 'modified' (time), or 'type' (default: name)"
            },
            "include_metadata": {
                "type": "boolean",
                "default": False,
                "description": "Include file metadata (size, modified time) in results (default: false)"
            }
        },
        "required": ["pattern"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "patterns": {"type": "array"},
            "exclude_patterns": {"type": "array"},
            "search_root": {"type": "string"},
            "matches": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "absolute_path": {"type": "string"},
                        "type": {"type": "string"},
                        "name": {"type": "string"},
                        "metadata": {"type": "object"}
                    }
                }
            },
            "summary": {
                "type": "object",
                "properties": {
                    "total_matches": {"type": "integer"},
                    "files": {"type": "integer"},
                    "directories": {"type": "integer"},
                    "truncated": {"type": "boolean"},
                    "skipped_hidden": {"type": "integer"}
                }
            },
            "warnings": {"type": "array"},
            "message": {"type": "string"}
        }
    },
    fn=_tool_search_files,
    rate_key="file.search"
)