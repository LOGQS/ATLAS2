from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec
from .file_utils import format_file_size, is_windows_reserved_name

_logger = get_logger(__name__)

MAX_CONTENT_SIZE = 50 * 1024 * 1024


def _tool_write_file(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Write content to a new file.

    This tool:
    - Creates a new file with specified content
    - Optionally creates parent directories
    - Prevents accidental overwrites (unless overwrite=true)
    - Validates content is textual
    """
    file_path = params.get("file_path")
    content = params.get("content")
    create_dirs = params.get("create_dirs", False)
    overwrite = params.get("overwrite", False)

    if not file_path:
        raise ValueError("file_path is required")

    if content is None:
        raise ValueError("content is required (use empty string for empty file)")

    if not isinstance(content, str):
        raise ValueError(
            f"content must be a string, got {type(content).__name__}. "
            "This tool is for textual files only."
        )

    content_size = len(content.encode('utf-8'))
    if content_size > MAX_CONTENT_SIZE:
        raise ValueError(
            f"Content is too large ({format_file_size(content_size)}). "
            f"Maximum allowed size is {format_file_size(MAX_CONTENT_SIZE)}. "
            "Consider breaking the content into multiple files or using a different approach."
        )

    try:
        path = Path(file_path).resolve()

        if is_windows_reserved_name(path.name):
            raise ValueError(
                f"Cannot write to '{file_path}': '{path.name}' is a reserved filename on Windows. "
                "Choose a different filename."
            )

        if path.exists() and not overwrite:
            if path.is_dir():
                raise ValueError(
                    f"Cannot write to '{file_path}': path is a directory. "
                    "Specify a file path, not a directory."
                )
            raise ValueError(
                f"File '{file_path}' already exists. "
                "Set overwrite=true to replace it, or choose a different path."
            )

        parent_dir = path.parent
        if not parent_dir.exists():
            if not create_dirs:
                raise ValueError(
                    f"Cannot write to '{file_path}': parent directory '{parent_dir}' does not exist. "
                    "Set create_dirs=true to create missing parent directories."
                )
            _logger.info(f"Creating parent directories for '{file_path}'")
            parent_dir.mkdir(parents=True, exist_ok=True)

        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)

        file_size = path.stat().st_size
        line_count = content.count('\n') + 1

        _logger.info(
            f"Successfully wrote file '{file_path}' ({format_file_size(file_size)}, {line_count} lines)"
        )

        return ToolResult(
            output={
                "status": "success",
                "file_path": str(path),
                "action": "overwritten" if overwrite and path.exists() else "created",
                "metadata": {
                    "file_size": format_file_size(file_size),
                    "file_size_bytes": file_size,
                    "line_count": line_count
                }
            },
            metadata={"file_path": str(path), "size_bytes": file_size}
        )

    except PermissionError:
        raise ValueError(
            f"Cannot write to '{file_path}': permission denied. "
            "Check that you have write access to this location."
        )
    except Exception as e:
        raise ValueError(f"Error writing file '{file_path}': {str(e)}")


write_file_spec = ToolSpec(
    name="file.write",
    version="1.0",
    description="Write content to a new textual file",
    effects=["disk"],
    in_schema={
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Path where the file should be written"
            },
            "content": {
                "type": "string",
                "description": "Content to write to the file"
            },
            "create_dirs": {
                "type": "boolean",
                "default": False,
                "description": "Create parent directories if they don't exist"
            },
            "overwrite": {
                "type": "boolean",
                "default": False,
                "description": "Overwrite file if it already exists"
            }
        },
        "required": ["file_path", "content"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "file_path": {"type": "string"},
            "action": {"type": "string"},
            "metadata": {"type": "object"}
        }
    },
    fn=_tool_write_file,
    rate_key="file.write"
)