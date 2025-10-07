from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional, List

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec
from .file_utils import (
    validate_file_path,
    format_file_size,
    create_backup
)

_logger = get_logger(__name__)


def _validate_notebook_structure(notebook: Dict[str, Any]) -> tuple[bool, str]:
    """
    Validate that a dictionary has the basic structure of a Jupyter notebook.
    Returns (is_valid, error_message).
    """
    if not isinstance(notebook, dict):
        return False, "notebook root must be a JSON object"

    if "cells" not in notebook:
        return False, "notebook must have a 'cells' field"

    if not isinstance(notebook["cells"], list):
        return False, "'cells' field must be an array"

    if "metadata" not in notebook:
        return False, "notebook must have a 'metadata' field"

    if "nbformat" not in notebook:
        return False, "notebook must have a 'nbformat' field"

    return True, ""


def _find_cell_index(cells: List[Dict[str, Any]], cell_id: Optional[str], cell_number: Optional[int]) -> tuple[Optional[int], str]:
    """
    Find the index of a cell by ID or number.
    Returns (index, error_message). If index is None, error_message explains why.
    """
    if cell_id is not None and cell_number is not None:
        return None, "Cannot specify both cell_id and cell_number. Choose one."

    if cell_id is None and cell_number is None:
        return None, "Must specify either cell_id or cell_number"

    if cell_id is not None:
        for idx, cell in enumerate(cells):
            if cell.get("id") == cell_id:
                return idx, ""
        return None, f"Cell with id '{cell_id}' not found in notebook"

    if cell_number is not None:
        if cell_number < 0 or cell_number >= len(cells):
            return None, f"cell_number {cell_number} is out of range. Notebook has {len(cells)} cells (valid range: 0-{len(cells)-1})"
        return cell_number, ""

    return None, "Unexpected error in cell lookup"


def _validate_cell_type(cell_type: str) -> tuple[bool, str]:
    """
    Validate cell type.
    Returns (is_valid, error_message).
    """
    valid_types = ["code", "markdown", "raw"]
    if cell_type not in valid_types:
        return False, f"Invalid cell_type '{cell_type}'. Must be one of: {', '.join(valid_types)}"
    return True, ""


def _create_cell(cell_type: str, source: str) -> Dict[str, Any]:
    """
    Create a new notebook cell with the given type and source.
    """
    import uuid

    if isinstance(source, str):
        lines = source.split('\n')
        source_lines = [line + '\n' for line in lines[:-1]]
        if lines[-1]: 
            source_lines.append(lines[-1])
    else:
        source_lines = source

    cell = {
        "cell_type": cell_type,
        "id": str(uuid.uuid4()).replace('-', '')[:8],  
        "metadata": {},
        "source": source_lines
    }

    if cell_type == "code":
        cell["execution_count"] = None
        cell["outputs"] = []

    return cell


def _tool_notebook_edit(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Edit a Jupyter notebook (.ipynb file) by modifying, inserting, or deleting cells.

    This tool supports three edit modes:
    1. replace: Replace the content of an existing cell
    2. insert: Insert a new cell at a specified position
    3. delete: Delete an existing cell

    Cells can be identified by cell_id or cell_number (0-indexed).
    A backup is automatically created before editing.
    """
    file_path = params.get("file_path")
    edit_mode = params.get("edit_mode")
    cell_id = params.get("cell_id")
    cell_number = params.get("cell_number")
    new_source = params.get("new_source")
    cell_type = params.get("cell_type", "code")
    create_backup_file = params.get("create_backup", True)
    insert_after = params.get("insert_after", True)

    if not file_path:
        raise ValueError("file_path is required")

    if not edit_mode:
        raise ValueError(
            "edit_mode is required. Choose 'replace' to modify a cell, "
            "'insert' to add a new cell, or 'delete' to remove a cell."
        )

    if edit_mode not in ["replace", "insert", "delete"]:
        raise ValueError(
            f"Invalid edit_mode '{edit_mode}'. "
            "Must be 'replace', 'insert', or 'delete'."
        )

    is_valid, error_msg, resolved_path = validate_file_path(file_path, must_exist=True, must_be_file=True)
    if not is_valid:
        raise ValueError(f"Cannot edit notebook: {error_msg}")

    if resolved_path.suffix.lower() != '.ipynb':
        raise ValueError(
            f"File '{file_path}' is not a Jupyter notebook. "
            "This tool only works with .ipynb files."
        )

    is_valid_type, type_error = _validate_cell_type(cell_type)
    if not is_valid_type:
        raise ValueError(type_error)

    try:
        with open(resolved_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"File '{file_path}' is not a valid JSON file: {str(e)}. "
            "The notebook file may be corrupted."
        )
    except UnicodeDecodeError:
        raise ValueError(
            f"Cannot read '{file_path}': file contains invalid UTF-8 data."
        )
    except PermissionError:
        raise ValueError(
            f"Cannot read '{file_path}': permission denied."
        )

    is_valid_notebook, notebook_error = _validate_notebook_structure(notebook)
    if not is_valid_notebook:
        raise ValueError(
            f"File '{file_path}' is not a valid Jupyter notebook: {notebook_error}"
        )

    cells = notebook["cells"]
    original_cell_count = len(cells)

    backup_path = None
    if create_backup_file:
        backup_path = create_backup(resolved_path)
        if not backup_path:
            _logger.warning(f"Failed to create backup for {file_path}, continuing anyway")

    if edit_mode == "replace":
        result = _edit_replace_cell(cells, cell_id, cell_number, new_source, cell_type)
    elif edit_mode == "insert":
        result = _edit_insert_cell(cells, cell_id, cell_number, new_source, cell_type, insert_after)
    elif edit_mode == "delete":
        result = _edit_delete_cell(cells, cell_id, cell_number)
    else:
        raise ValueError(f"Unexpected edit_mode: {edit_mode}")

    notebook["cells"] = cells

    try:
        with open(resolved_path, 'w', encoding='utf-8') as f:
            json.dump(notebook, f, indent=1, ensure_ascii=False)

        file_size = resolved_path.stat().st_size
        new_cell_count = len(cells)

        _logger.info(
            f"Successfully edited notebook '{resolved_path}' "
            f"({edit_mode} mode, new cell count: {new_cell_count})"
        )

        result.update({
            "status": "success",
            "file_path": str(resolved_path),
            "edit_mode": edit_mode,
            "original_cell_count": original_cell_count,
            "new_cell_count": new_cell_count,
            "backup_path": str(backup_path) if backup_path else None,
            "metadata": {
                "file_size": format_file_size(file_size),
                "file_size_bytes": file_size
            }
        })

        return ToolResult(
            output=result,
            metadata={
                "file_path": str(resolved_path),
                "edit_mode": edit_mode,
                "backup_created": backup_path is not None
            }
        )

    except PermissionError:
        raise ValueError(
            f"Cannot write to '{resolved_path}': permission denied. "
            "Check that you have write access to this file."
        )
    except Exception as e:
        raise ValueError(f"Error writing edited notebook '{resolved_path}': {str(e)}")


def _edit_replace_cell(
    cells: List[Dict[str, Any]],
    cell_id: Optional[str],
    cell_number: Optional[int],
    new_source: str,
    cell_type: str
) -> Dict[str, Any]:
    """Replace the content of an existing cell."""
    if new_source is None:
        raise ValueError("new_source is required for replace mode")

    if not isinstance(new_source, str):
        raise ValueError("new_source must be a string")

    cell_idx, error = _find_cell_index(cells, cell_id, cell_number)
    if cell_idx is None:
        raise ValueError(error)

    old_cell = cells[cell_idx]
    old_type = old_cell.get("cell_type", "unknown")
    old_source = old_cell.get("source", [])

    # Normalize source to list of lines
    if isinstance(new_source, str):
        lines = new_source.split('\n')
        source_lines = [line + '\n' for line in lines[:-1]]
        if lines[-1]:
            source_lines.append(lines[-1])
    else:
        source_lines = new_source

    # Update cell source and type
    cells[cell_idx]["source"] = source_lines

    # If changing cell type, update structure
    if old_type != cell_type:
        cells[cell_idx]["cell_type"] = cell_type
        if cell_type == "code":
            cells[cell_idx]["execution_count"] = None
            cells[cell_idx]["outputs"] = []
        else:
            # Remove code-specific fields if changing away from code
            cells[cell_idx].pop("execution_count", None)
            cells[cell_idx].pop("outputs", None)

    return {
        "operation": "replace",
        "cell_index": cell_idx,
        "cell_id": cells[cell_idx].get("id"),
        "old_cell_type": old_type,
        "new_cell_type": cell_type,
        "source_lines": len(source_lines)
    }


def _edit_insert_cell(
    cells: List[Dict[str, Any]],
    cell_id: Optional[str],
    cell_number: Optional[int],
    new_source: str,
    cell_type: str,
    insert_after: bool
) -> Dict[str, Any]:
    """Insert a new cell at a specified position."""
    if new_source is None:
        raise ValueError("new_source is required for insert mode")

    if not isinstance(new_source, str):
        raise ValueError("new_source must be a string")

    # For insert mode, we allow neither cell_id nor cell_number to be specified
    # In that case, insert at the end
    if cell_id is None and cell_number is None:
        insert_idx = len(cells)
    else:
        ref_idx, error = _find_cell_index(cells, cell_id, cell_number)
        if ref_idx is None:
            raise ValueError(error)

        # Insert after or before the reference cell
        if insert_after:
            insert_idx = ref_idx + 1
        else:
            insert_idx = ref_idx

    new_cell = _create_cell(cell_type, new_source)
    cells.insert(insert_idx, new_cell)

    return {
        "operation": "insert",
        "cell_index": insert_idx,
        "cell_id": new_cell.get("id"),
        "cell_type": cell_type,
        "insert_position": "after reference" if insert_after and (cell_id or cell_number is not None) else "before reference" if not insert_after else "at end"
    }


def _edit_delete_cell(
    cells: List[Dict[str, Any]],
    cell_id: Optional[str],
    cell_number: Optional[int]
) -> Dict[str, Any]:
    """Delete an existing cell."""
    cell_idx, error = _find_cell_index(cells, cell_id, cell_number)
    if cell_idx is None:
        raise ValueError(error)

    if len(cells) == 1:
        raise ValueError(
            "Cannot delete the last remaining cell. "
            "Notebooks must have at least one cell."
        )

    deleted_cell = cells.pop(cell_idx)

    return {
        "operation": "delete",
        "cell_index": cell_idx,
        "cell_id": deleted_cell.get("id"),
        "cell_type": deleted_cell.get("cell_type")
    }


notebook_edit_spec = ToolSpec(
    name="file.notebook_edit",
    version="1.0",
    description="Edit Jupyter notebook (.ipynb) files by replacing, inserting, or deleting cells",
    effects=["disk"],
    in_schema={
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Path to the Jupyter notebook file (.ipynb)"
            },
            "edit_mode": {
                "type": "string",
                "enum": ["replace", "insert", "delete"],
                "description": "Edit operation: 'replace' to modify a cell, 'insert' to add a new cell, 'delete' to remove a cell"
            },
            "cell_id": {
                "type": "string",
                "description": "ID of the cell to edit (use this OR cell_number, not both)"
            },
            "cell_number": {
                "type": "integer",
                "description": "Index of the cell to edit, 0-indexed (use this OR cell_id, not both)"
            },
            "new_source": {
                "type": "string",
                "description": "New source content for the cell (required for replace and insert modes)"
            },
            "cell_type": {
                "type": "string",
                "enum": ["code", "markdown", "raw"],
                "default": "code",
                "description": "Type of the cell (default: 'code')"
            },
            "create_backup": {
                "type": "boolean",
                "default": True,
                "description": "Create a backup before editing (default: true)"
            },
            "insert_after": {
                "type": "boolean",
                "default": True,
                "description": "For insert mode: insert after (true) or before (false) the reference cell (default: true)"
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
            "operation": {"type": "string"},
            "cell_index": {"type": "integer"},
            "cell_id": {"type": "string"},
            "backup_path": {"type": "string"},
            "original_cell_count": {"type": "integer"},
            "new_cell_count": {"type": "integer"},
            "metadata": {"type": "object"}
        }
    },
    fn=_tool_notebook_edit,
    rate_key="file.notebook_edit"
)
