"""Filesystem watcher for broadcasting real-time file events."""

from __future__ import annotations
# status: complete

import threading
from pathlib import Path
from typing import Callable, Optional

from watchdog.events import FileSystemEventHandler, FileCreatedEvent, FileDeletedEvent, FileModifiedEvent, FileMovedEvent
from watchdog.observers import Observer

from utils.logger import get_logger
from file_utils.markdown_processor import setup_filespace

logger = get_logger(__name__)

BroadcastFn = Callable[[dict], None]

_observer: Optional[Observer] = None
_lock = threading.Lock()
_base_path: Optional[Path] = None
_ignored_dirs = {"md_ver"}


def _normalise_path(path: Path) -> str:
    return path.as_posix()


def _relative_path(path: Path) -> Optional[str]:
    global _base_path
    if _base_path is None:
        return None
    try:
        relative = path.resolve().relative_to(_base_path)
    except ValueError:
        return None
    if not str(relative):
        return ""
    parts = relative.parts
    if parts and parts[0] in _ignored_dirs:
        return None
    return _normalise_path(relative)


class _WorkspaceEventHandler(FileSystemEventHandler):
    def __init__(self, base_path: Path, callback: BroadcastFn):
        super().__init__()
        self._base_path = base_path
        self._callback = callback

    def _publish(self, event_type: str, path: Path, is_directory: bool, src_path: Optional[Path] = None):
        relative_path = _relative_path(path)
        if relative_path is None:
            return

        payload = {
            "type": "filesystem",
            "event": event_type,
            "path": relative_path,
            "is_directory": is_directory,
        }

        if src_path is not None:
            src_relative = _relative_path(src_path)
            if src_relative is not None and src_relative != relative_path:
                payload["previous_path"] = src_relative

        logger.debug(
            "[FILE_WATCHER] Event %s path=%s directory=%s src=%s",
            event_type,
            relative_path,
            is_directory,
            payload.get("previous_path"),
        )

        try:
            self._callback(payload)
        except Exception as err:  # pragma: no cover - defensive
            logger.error("[FILE_WATCHER] Failed to broadcast event: %s", err)

    def on_created(self, event: FileCreatedEvent):  # type: ignore[override]
        path = Path(event.src_path)
        if path.name in _ignored_dirs:
            return
        self._publish("created", path, event.is_directory)

    def on_deleted(self, event: FileDeletedEvent):  # type: ignore[override]
        path = Path(event.src_path)
        if path.name in _ignored_dirs:
            return
        self._publish("deleted", path, event.is_directory)

    def on_modified(self, event: FileModifiedEvent):  # type: ignore[override]
        if event.is_directory:
            return
        path = Path(event.src_path)
        if any(part in _ignored_dirs for part in path.parts):
            return
        self._publish("modified", path, False)

    def on_moved(self, event: FileMovedEvent):  # type: ignore[override]
        dest = Path(event.dest_path)
        if any(part in _ignored_dirs for part in dest.parts):
            return
        src = Path(event.src_path)
        self._publish("moved", dest, event.is_directory, src_path=src)


def start_filesystem_monitor(callback: BroadcastFn) -> None:
    """Start the filesystem monitor if not already running."""
    global _observer, _base_path
    with _lock:
        if _observer is not None:
            return

        files_dir = Path(setup_filespace())
        _base_path = files_dir.resolve()
        handler = _WorkspaceEventHandler(_base_path, callback)
        observer = Observer()
        observer.schedule(handler, str(_base_path), recursive=True)
        observer.daemon = True
        observer.start()
        _observer = observer
        logger.info("[FILE_WATCHER] Started filesystem monitor at %s", _base_path)


def stop_filesystem_monitor() -> None:
    """Stop the filesystem monitor if running."""
    global _observer
    with _lock:
        observer = _observer
        _observer = None
    if observer:
        try:
            observer.stop()
            observer.join(timeout=5)
            logger.info("[FILE_WATCHER] Stopped filesystem monitor")
        except Exception as err:  # pragma: no cover - defensive
            logger.error("[FILE_WATCHER] Error stopping filesystem monitor: %s", err)
