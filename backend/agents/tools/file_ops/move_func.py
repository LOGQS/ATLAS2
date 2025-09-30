from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Dict

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec
from .file_utils import validate_file_path, format_file_size, check_paths_same

_logger = get_logger(__name__)


def _tool_move_file(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Move or rename a file.

    This tool:
    - Moves files to new locations
    - Renames files
    - Optionally creates destination directories
    - Prevents accidental overwrites (unless overwrite=true)
    """
    source_path = params.get("source_path")
    destination_path = params.get("destination_path")
    create_dirs = params.get("create_dirs", False)
    overwrite = params.get("overwrite", False)

    if not source_path:
        raise ValueError("source_path is required")

    if not destination_path:
        raise ValueError("destination_path is required")

    is_valid, error_msg, source_resolved = validate_file_path(
        source_path, must_exist=True, must_be_file=True
    )
    if not is_valid:
        raise ValueError(f"Cannot move file: {error_msg}")

    try:
        dest_resolved = Path(destination_path).resolve()

        if check_paths_same(source_resolved, dest_resolved):
            raise ValueError(
                f"Cannot move '{source_path}' to '{destination_path}': "
                "source and destination refer to the same file. "
                "No operation needed."
            )

        if dest_resolved.exists() and not overwrite:
            if dest_resolved.is_dir():
                raise ValueError(
                    f"Cannot move to '{destination_path}': path is an existing directory. "
                    "Specify a file path as destination, not a directory."
                )
            raise ValueError(
                f"Destination '{destination_path}' already exists. "
                "Set overwrite=true to replace it, or choose a different destination."
            )

        dest_parent = dest_resolved.parent
        if not dest_parent.exists():
            if not create_dirs:
                raise ValueError(
                    f"Cannot move to '{destination_path}': parent directory '{dest_parent}' does not exist. "
                    "Set create_dirs=true to create missing parent directories."
                )
            _logger.info(f"Creating parent directories for '{destination_path}'")
            dest_parent.mkdir(parents=True, exist_ok=True)

        file_size = source_resolved.stat().st_size

        shutil.move(str(source_resolved), str(dest_resolved))

        action = "moved and overwritten" if overwrite and dest_resolved.exists() else "moved"
        _logger.info(
            f"Successfully {action} '{source_path}' to '{destination_path}' "
            f"({format_file_size(file_size)})"
        )

        return ToolResult(
            output={
                "status": "success",
                "source_path": source_path,
                "destination_path": str(dest_resolved),
                "action": action,
                "metadata": {
                    "file_size": format_file_size(file_size),
                    "file_size_bytes": file_size
                }
            },
            metadata={
                "source": source_path,
                "destination": str(dest_resolved),
                "size_bytes": file_size
            }
        )

    except PermissionError:
        raise ValueError(
            f"Cannot move '{source_path}' to '{destination_path}': permission denied. "
            "Check that you have read/write access to both source and destination."
        )
    except shutil.Error as e:
        raise ValueError(f"Error moving file: {str(e)}")
    except Exception as e:
        raise ValueError(f"Error moving '{source_path}' to '{destination_path}': {str(e)}")


move_file_spec = ToolSpec(
    name="file.move",
    version="1.0",
    description="Move or rename a file",
    effects=["disk"],
    in_schema={
        "type": "object",
        "properties": {
            "source_path": {
                "type": "string",
                "description": "Path to the file to move"
            },
            "destination_path": {
                "type": "string",
                "description": "Destination path for the file"
            },
            "create_dirs": {
                "type": "boolean",
                "default": False,
                "description": "Create destination parent directories if they don't exist"
            },
            "overwrite": {
                "type": "boolean",
                "default": False,
                "description": "Overwrite destination file if it already exists"
            }
        },
        "required": ["source_path", "destination_path"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "source_path": {"type": "string"},
            "destination_path": {"type": "string"},
            "action": {"type": "string"},
            "metadata": {"type": "object"}
        }
    },
    fn=_tool_move_file,
    rate_key="file.move"
)