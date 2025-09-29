# status: alpha

from __future__ import annotations

from typing import Any, Dict, List, Optional

from utils.db_utils import db
from utils.logger import get_logger


class ContextStore:
    """Lightweight wrapper around database context snapshots."""

    def __init__(self, db_manager=None):
        self._db = db_manager or db
        self._logger = get_logger(__name__)

    def ensure_root(self, chat_id: str) -> str:
        """Ensure the chat has an initial context snapshot and return its id."""
        return self._db.ensure_context_root(chat_id)

    def get_latest_ctx_id(self, chat_id: str) -> Optional[str]:
        return self._db.get_latest_context_id(chat_id)

    def get_snapshot(self, chat_id: str, ctx_id: str) -> Optional[Dict[str, Any]]:
        return self._db.get_context_snapshot(chat_id, ctx_id)

    def get_snapshot_by_id(self, ctx_id: str) -> Optional[Dict[str, Any]]:
        return self._db.get_context_snapshot_by_id(ctx_id)

    def list_snapshots(self, chat_id: str, limit: int = 50, before_id: Optional[int] = None) -> List[Dict[str, Any]]:
        return self._db.list_context_snapshots(chat_id, limit=limit, before_id=before_id)

    def commit_operations(
        self,
        chat_id: str,
        base_ctx_id: str,
        ops: Any,
        meta: Optional[Dict[str, Any]] = None,
        new_ctx_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Append operations to the oplog and return the new snapshot."""
        if ops is None:
            ops_payload: Dict[str, Any] = {"ops": []}
        elif isinstance(ops, dict) and "ops" in ops:
            ops_payload = {"ops": ops.get("ops", []), "meta": ops.get("meta", {})}
        else:
            ops_list = ops if isinstance(ops, list) else [ops]
            ops_payload = {"ops": ops_list}

        if meta:
            ops_payload.setdefault("meta", {}).update(meta)

        snapshot = self._db.create_context_snapshot(chat_id, base_ctx_id, ops_payload, new_ctx_id=new_ctx_id)
        if snapshot is None:
            self._logger.error("Failed to persist context snapshot for chat %s", chat_id)
        return snapshot
