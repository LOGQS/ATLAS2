from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec, ProcessingMode
from .file_utils import validate_directory_path, format_file_size

_logger = get_logger(__name__)


def _tool_list_dir(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    List contents of a directory with filtering options.

    This tool:
    - Lists files and/or directories
    - Supports recursive listing
    - Filters by file extension
    - Shows file sizes and modification times
    - Handles permission errors gracefully
    """
    directory_path = params.get("directory_path", ".")
    recursive = params.get("recursive", False)
    include_files = params.get("include_files", True)
    include_dirs = params.get("include_dirs", True)
    filter_extensions = params.get("filter_extensions")
    max_results = params.get("max_results", 1000)

    if not include_files and not include_dirs:
        raise ValueError(
            "At least one of include_files or include_dirs must be true. "
            "Cannot list directory with both options disabled."
        )

    is_valid, error_msg, resolved_path = validate_directory_path(
        directory_path,
        must_exist=True,
        workspace_root=ctx.workspace_path,
    )
    if not is_valid:
        raise ValueError(f"Cannot list directory: {error_msg}")

    extensions_set = set()
    if filter_extensions:
        if isinstance(filter_extensions, str):
            extensions_set = {filter_extensions.lower() if filter_extensions.startswith('.') else f'.{filter_extensions.lower()}'}
        elif isinstance(filter_extensions, list):
            for ext in filter_extensions:
                ext_str = ext.lower() if ext.startswith('.') else f'.{ext.lower()}'
                extensions_set.add(ext_str)

    entries = []
    total_size = 0
    truncated = False

    try:
        if recursive:
            for root, dirs, files in os.walk(resolved_path):
                root_path = Path(root)

                if include_dirs:
                    for dir_name in sorted(dirs):
                        if len(entries) >= max_results:
                            truncated = True
                            break

                        dir_path = root_path / dir_name
                        try:
                            rel_path = dir_path.relative_to(resolved_path)
                            entries.append({
                                "name": dir_name,
                                "path": str(rel_path),
                                "type": "directory",
                                "size": "-",
                                "modified": "-"
                            })
                        except Exception as e:
                            _logger.debug(f"Error processing directory {dir_path}: {e}")

                    if truncated:
                        break

                if include_files:
                    for file_name in sorted(files):
                        if len(entries) >= max_results:
                            truncated = True
                            break

                        file_path = root_path / file_name

                        if extensions_set and file_path.suffix.lower() not in extensions_set:
                            continue

                        try:
                            stat_info = file_path.stat()
                            size_bytes = stat_info.st_size
                            total_size += size_bytes
                            modified_time = datetime.fromtimestamp(stat_info.st_mtime)

                            rel_path = file_path.relative_to(resolved_path)

                            entries.append({
                                "name": file_name,
                                "path": str(rel_path),
                                "type": "file",
                                "size": format_file_size(size_bytes),
                                "size_bytes": size_bytes,
                                "modified": modified_time.strftime("%Y-%m-%d %H:%M:%S")
                            })
                        except Exception as e:
                            _logger.debug(f"Error processing file {file_path}: {e}")

                    if truncated:
                        break

        else:
            for entry in sorted(resolved_path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                if len(entries) >= max_results:
                    truncated = True
                    break

                try:
                    if entry.is_dir():
                        if not include_dirs:
                            continue

                        entries.append({
                            "name": entry.name,
                            "path": entry.name,
                            "type": "directory",
                            "size": "-",
                            "modified": "-"
                        })

                    elif entry.is_file():
                        if not include_files:
                            continue

                        if extensions_set and entry.suffix.lower() not in extensions_set:
                            continue

                        stat_info = entry.stat()
                        size_bytes = stat_info.st_size
                        total_size += size_bytes
                        modified_time = datetime.fromtimestamp(stat_info.st_mtime)

                        entries.append({
                            "name": entry.name,
                            "path": entry.name,
                            "type": "file",
                            "size": format_file_size(size_bytes),
                            "size_bytes": size_bytes,
                            "modified": modified_time.strftime("%Y-%m-%d %H:%M:%S")
                        })

                except PermissionError:
                    _logger.debug(f"Permission denied accessing {entry}")
                except Exception as e:
                    _logger.debug(f"Error processing {entry}: {e}")

        _logger.info(
            f"Listed {len(entries)} entries from '{directory_path}' "
            f"(recursive={recursive}, truncated={truncated})"
        )

        result = {
            "status": "success",
            "directory": str(resolved_path),
            "entries": entries,
            "summary": {
                "total_entries": len(entries),
                "files": len([e for e in entries if e["type"] == "file"]),
                "directories": len([e for e in entries if e["type"] == "directory"]),
                "total_size": format_file_size(total_size),
                "truncated": truncated
            }
        }

        if truncated:
            result["warning"] = (
                f"Results truncated to {max_results} entries. "
                "Increase max_results parameter to see more entries."
            )

        return ToolResult(
            output=result,
            metadata={
                "directory": str(resolved_path),
                "entry_count": len(entries),
                "truncated": truncated
            }
        )

    except PermissionError:
        raise ValueError(
            f"Cannot list directory '{directory_path}': permission denied. "
            "Check that you have read access to this directory."
        )
    except Exception as e:
        raise ValueError(f"Error listing directory '{directory_path}': {str(e)}")


list_dir_spec = ToolSpec(
    name="file.list_dir",
    version="1.0",
    description="List contents of a directory with filtering and metadata",
    effects=["disk"],
    in_schema={
        "type": "object",
        "properties": {
            "directory_path": {
                "type": "string",
                "default": ".",
                "description": "Path to the directory to list (default: current directory)"
            },
            "recursive": {
                "type": "boolean",
                "default": False,
                "description": "List subdirectories recursively"
            },
            "include_files": {
                "type": "boolean",
                "default": True,
                "description": "Include files in the listing"
            },
            "include_dirs": {
                "type": "boolean",
                "default": True,
                "description": "Include directories in the listing"
            },
            "filter_extensions": {
                "type": ["string", "array"],
                "description": "Filter by file extension(s), e.g., '.py' or ['.js', '.ts']"
            },
            "max_results": {
                "type": "integer",
                "default": 1000,
                "description": "Maximum number of entries to return"
            }
        }
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "directory": {"type": "string"},
            "entries": {"type": "array"},
            "summary": {"type": "object"},
            "warning": {"type": "string"}
        }
    },
    fn=_tool_list_dir,
    rate_key="file.list_dir",
    timeout_seconds=10.0,  # Directory listing is fast
    processing_mode=ProcessingMode.THREAD,
)