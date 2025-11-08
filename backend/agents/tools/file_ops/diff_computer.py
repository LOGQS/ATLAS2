"""Diff computation for streaming file operations.

This module computes Monaco editor decoration specifications for real-time
diff visualization during streaming file operations (file.write, file.edit).
"""

from __future__ import annotations

import difflib
import re
from typing import Any, Dict, List, Optional, Tuple

from utils.logger import get_logger

logger = get_logger(__name__)


def compute_streaming_decorations(
    tool_name: str,
    params: Dict[str, Any],
    before_content: Optional[str],
    after_content: str,
) -> List[Dict[str, Any]]:
    """
    Compute Monaco decoration data for frontend visualization.

    Args:
        tool_name: 'file.write' or 'file.edit'
        params: Tool parameters (edit_mode, find_text, etc.)
        before_content: Original file content (None if file didn't exist)
        after_content: New file content after operation

    Returns:
        List of decoration specs: [
            {
                'startLine': int,  # 1-indexed
                'endLine': int,
                'startColumn': int,  # 1-indexed
                'endColumn': int,
                'type': 'add' | 'remove' | 'modify',
                'className': 'streaming-diff__line-add' | 'streaming-diff__line-remove' | 'streaming-diff__line-modify',
                'inlineClassName': str (optional, for inline decorations)
            }
        ]
    """
    if tool_name == "file.write":
        return _compute_file_write_decorations(before_content, after_content)
    elif tool_name == "file.edit":
        edit_mode = params.get("edit_mode")
        if edit_mode == "find_replace":
            return _compute_find_replace_decorations(
                before_content or "",
                after_content,
                params,
            )
        elif edit_mode == "line_range":
            return _compute_line_range_decorations(
                before_content or "",
                after_content,
                params,
            )
        else:
            logger.warning(f"[DIFF] Unknown edit_mode: {edit_mode}")
            return []
    else:
        logger.warning(f"[DIFF] Unsupported tool for diff: {tool_name}")
        return []


def _compute_file_write_decorations(
    before_content: Optional[str],
    after_content: str,
) -> List[Dict[str, Any]]:
    """
    Compute decorations for file.write operations.

    - If file didn't exist: All lines are 'add' (green)
    - If file existed: Line-by-line diff showing add/remove/modify
    """
    decorations = []

    if before_content is None:
        # File didn't exist - mark all lines as additions
        after_lines = after_content.splitlines()
        for line_num in range(1, len(after_lines) + 1):
            decorations.append({
                "startLine": line_num,
                "endLine": line_num,
                "startColumn": 1,
                "endColumn": 1,  # Whole line
                "type": "add",
                "className": "streaming-diff__line-add",
            })
        return decorations

    # File existed - compute line-by-line diff
    before_lines = before_content.splitlines()
    after_lines = after_content.splitlines()

    matcher = difflib.SequenceMatcher(None, before_lines, after_lines)

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "replace":
            # Lines were modified
            # Show removed lines in before and added lines in after
            # Since we're showing the AFTER state, we mark these as modifications
            for line_num in range(j1 + 1, j2 + 1):
                decorations.append({
                    "startLine": line_num,
                    "endLine": line_num,
                    "startColumn": 1,
                    "endColumn": 1,
                    "type": "modify",
                    "className": "streaming-diff__line-modify",
                })
        elif tag == "delete":
            # Lines were removed (not shown in after_content, but we can mark where they were)
            # Skip for now - we only show the after state
            pass
        elif tag == "insert":
            # Lines were added
            for line_num in range(j1 + 1, j2 + 1):
                decorations.append({
                    "startLine": line_num,
                    "endLine": line_num,
                    "startColumn": 1,
                    "endColumn": 1,
                    "type": "add",
                    "className": "streaming-diff__line-add",
                })

    return decorations


def _compute_find_replace_decorations(
    before_content: str,
    after_content: str,
    params: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """
    Compute decorations for file.edit with find_replace mode.

    Highlights the lines where replacements occurred.
    """
    decorations = []

    find_text = params.get("find_text", "")
    replace_text = params.get("replace_text", "")
    use_regex = params.get("use_regex", False)
    replace_all = params.get("replace_all", True)

    if not find_text:
        logger.warning("[DIFF] find_replace missing find_text")
        return []

    # Find all occurrences in the after_content
    after_lines = after_content.splitlines()

    if use_regex:
        try:
            pattern = re.compile(find_text)
        except re.error as e:
            logger.error(f"[DIFF] Invalid regex pattern: {e}")
            return []

        # Find lines containing the replacement
        for line_num, line in enumerate(after_lines, start=1):
            if replace_text in line:  # Check if replacement text is in this line
                decorations.append({
                    "startLine": line_num,
                    "endLine": line_num,
                    "startColumn": 1,
                    "endColumn": 1,
                    "type": "modify",
                    "className": "streaming-diff__line-modify",
                })
                if not replace_all:
                    break
    else:
        # Literal text search
        for line_num, line in enumerate(after_lines, start=1):
            if replace_text in line:
                decorations.append({
                    "startLine": line_num,
                    "endLine": line_num,
                    "startColumn": 1,
                    "endColumn": 1,
                    "type": "modify",
                    "className": "streaming-diff__line-modify",
                })
                if not replace_all:
                    break

    return decorations


def _compute_line_range_decorations(
    before_content: str,
    after_content: str,
    params: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """
    Compute decorations for file.edit with line_range mode.

    Highlights the replaced line range.
    """
    decorations = []

    start_line = params.get("start_line")
    end_line = params.get("end_line")

    if start_line is None:
        logger.warning("[DIFF] line_range missing start_line")
        return []

    if end_line is None:
        end_line = start_line

    # Mark the replaced line range
    for line_num in range(start_line, end_line + 1):
        decorations.append({
            "startLine": line_num,
            "endLine": line_num,
            "startColumn": 1,
            "endColumn": 1,
            "type": "modify",
            "className": "streaming-diff__line-modify",
        })

    return decorations


def compute_diff_stats(
    before_content: Optional[str],
    after_content: str,
) -> Tuple[int, int]:
    """
    Calculate lines added and removed between two content blobs.

    Args:
        before_content: Original content (None if file didn't exist)
        after_content: New content

    Returns:
        (lines_added, lines_removed) tuple
    """
    if before_content is None:
        # New file - all lines are additions
        lines_added = len(after_content.splitlines())
        return (lines_added, 0)

    before_lines = before_content.splitlines()
    after_lines = after_content.splitlines()

    matcher = difflib.SequenceMatcher(None, before_lines, after_lines)

    lines_added = 0
    lines_removed = 0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag in ("replace", "insert"):
            lines_added += j2 - j1
        if tag in ("replace", "delete"):
            lines_removed += i2 - i1

    return (lines_added, lines_removed)
