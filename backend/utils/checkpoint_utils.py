"""Checkpoint utilities for saving file history snapshots."""

from __future__ import annotations

import hashlib
from typing import Dict, Optional

from utils.db_utils import db
from utils.logger import get_logger

logger = get_logger(__name__)

# Maximum checkpoint size: 5MB
MAX_CHECKPOINT_SIZE = 5 * 1024 * 1024


def compute_content_hash(content: str) -> str:
    """Compute SHA-256 hash of content for deduplication."""
    return hashlib.sha256(content.encode('utf-8')).hexdigest()


def save_file_checkpoint(
    workspace_path: str,
    file_path: str,
    content: str,
    edit_type: str = 'checkpoint'
) -> Optional[Dict[str, object]]:
    """
    Save a checkpoint of file content to history.

    Args:
        workspace_path: The absolute path to the workspace
        file_path: The relative path to the file within the workspace
        content: The file content to checkpoint
        edit_type: The type of edit (default: 'checkpoint')

    Returns:
        Optional[Dict[str, object]]: Details about the checkpoint that was saved or reused.
            The dictionary includes:
              - 'id': int checkpoint identifier
              - 'created': bool indicating whether a new checkpoint row was inserted
              - 'content_hash': str SHA-256 hash of the content
            Returns None if the checkpoint could not be recorded (e.g. content too large or DB error).
    """
    try:
        content_size = len(content.encode('utf-8'))
        if content_size > MAX_CHECKPOINT_SIZE:
            logger.warning(
                f"[CHECKPOINT] Checkpoint too large ({content_size} bytes) for {file_path}, skipping"
            )
            return None

        content_hash = compute_content_hash(content)

        def query(conn, cursor):
            cursor.execute(
                """
                SELECT id, content_hash
                FROM file_edit_history
                WHERE workspace_path = ? AND file_path = ?
                ORDER BY timestamp DESC, id DESC
                LIMIT 1
                """,
                (workspace_path, file_path)
            )
            row = cursor.fetchone()
            if row and row[1] == content_hash:
                logger.debug(
                    "[CHECKPOINT] Skipping duplicate checkpoint for %s (hash=%s)",
                    file_path,
                    content_hash[:8],
                )
                return {
                    "id": row[0],
                    "created": False,
                    "content_hash": content_hash,
                }

            cursor.execute(
                """
                INSERT INTO file_edit_history (workspace_path, file_path, content, edit_type, content_hash)
                VALUES (?, ?, ?, ?, ?)
                """,
                (workspace_path, file_path, content, edit_type, content_hash)
            )
            conn.commit()
            logger.info(f"[CHECKPOINT] Saved checkpoint for {file_path}")
            return {
                "id": cursor.lastrowid,
                "created": True,
                "content_hash": content_hash,
            }

        return db._execute_with_connection("save file checkpoint", query, return_on_error=None)
    except Exception as e:
        logger.error(f"[CHECKPOINT] Failed to save checkpoint for {file_path}: {e}")
        return None


def cleanup_old_checkpoints(workspace_path: str, file_path: str, keep_count: int = 100) -> bool:
    """
    Clean up old checkpoints, keeping only the most recent ones.

    Args:
        workspace_path: The absolute path to the workspace
        file_path: The relative path to the file within the workspace
        keep_count: Number of recent checkpoints to keep (default: 100)

    Returns:
        bool: True if cleanup was successful, False otherwise
    """
    try:
        def query(conn, cursor):
            # Get count of checkpoints for this file
            cursor.execute(
                """
                SELECT COUNT(*) FROM file_edit_history
                WHERE workspace_path = ? AND file_path = ?
                """,
                (workspace_path, file_path)
            )
            count = cursor.fetchone()[0]

            if count <= keep_count:
                return True  # Nothing to clean up

            # Delete old checkpoints, keeping only the most recent keep_count
            cursor.execute(
                """
                DELETE FROM file_edit_history
                WHERE id IN (
                    SELECT id FROM file_edit_history
                    WHERE workspace_path = ? AND file_path = ?
                    ORDER BY timestamp DESC, id DESC
                    LIMIT -1 OFFSET ?
                )
                """,
                (workspace_path, file_path, keep_count)
            )
            conn.commit()
            deleted = cursor.rowcount
            if deleted > 0:
                logger.info(f"[CHECKPOINT] Cleaned up {deleted} old checkpoints for {file_path}")
            return True

        return db._execute_with_connection("cleanup old checkpoints", query, return_on_error=False)
    except Exception as e:
        logger.error(f"[CHECKPOINT] Failed to cleanup checkpoints for {file_path}: {e}")
        return False
