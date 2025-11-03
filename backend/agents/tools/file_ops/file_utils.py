from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from utils.logger import get_logger

_logger = get_logger(__name__)

BINARY_EXTENSIONS = {
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif',
    '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.mpg', '.mpeg',
    '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.opus',
    '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.iso',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.app',
    '.db', '.sqlite', '.sqlite3', '.mdb',
    '.pyc', '.pyo', '.class', '.jar', '.war', '.o', '.a'
}

TEXTUAL_EXTENSIONS = {
    '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h', '.hpp',
    '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.cs', '.vb',
    '.html', '.css', '.xml', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg',
    '.md', '.rst', '.txt', '.log',
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
    '.sql', '.graphql', '.proto', '.thrift', '.csv', '.tsv'
}


def _resolve_with_workspace(path: Path, workspace_root: Optional[str]) -> Path:
    """
    Resolve a path, optionally relative to an active workspace root.

    Raises ValueError if the resolved path escapes the workspace boundary.
    """
    if workspace_root:
        workspace_root_path = Path(workspace_root).resolve()
        candidate = path if path.is_absolute() else workspace_root_path / path
    else:
        workspace_root_path = None
        candidate = path

    resolved = candidate.resolve()

    if workspace_root_path:
        try:
            resolved.relative_to(workspace_root_path)
        except ValueError:
            raise ValueError(
                f"path '{path}' resolves outside the active coder workspace '{workspace_root_path}'"
            )

    return resolved


def workspace_relative_path(path: Path, workspace_root: Optional[str]) -> str:
    """
    Return a path relative to the workspace root, falling back to absolute.
    """
    if workspace_root:
        workspace_root_path = Path(workspace_root).resolve()
        try:
            relative = path.relative_to(workspace_root_path)
            relative_str = relative.as_posix()
            return relative_str if relative_str else "."
        except ValueError:
            pass
    return path.as_posix()


def get_data_dir() -> Path:
    """Get the file_ops data directory."""
    data_dir = Path(__file__).resolve().parent.parent.parent.parent.parent / "data" / "file_ops_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def is_likely_binary(file_path: Path) -> tuple[bool, str]:
    """
    Determine if a file is likely binary.
    Returns (is_binary, reason).
    """
    ext = file_path.suffix.lower()

    if ext in BINARY_EXTENSIONS:
        return True, f"file extension '{ext}' indicates binary format"

    if ext in TEXTUAL_EXTENSIONS:
        return False, f"file extension '{ext}' indicates text format"

    try:
        with open(file_path, 'rb') as f:
            chunk = f.read(8192)
            if b'\x00' in chunk:
                return True, "file contains null bytes (binary indicator)"

            try:
                chunk.decode('utf-8')
                return False, "file content appears to be valid UTF-8 text"
            except UnicodeDecodeError:
                return True, "file content contains non-UTF-8 data"
    except Exception as e:
        _logger.warning(f"Error checking file type for {file_path}: {e}")
        return True, f"unable to read file for type detection: {str(e)}"


def validate_file_path(
    file_path: str,
    must_exist: bool = True,
    must_be_file: bool = True,
    allow_symlinks: bool = True,
    workspace_root: Optional[str] = None,
) -> tuple[bool, str, Optional[Path]]:
    """
    Validate a file path.
    Returns (is_valid, error_message, resolved_path).
    If is_valid is True, error_message will be empty and resolved_path will be set.
    """
    try:
        path = Path(file_path)
        resolved_path = _resolve_with_workspace(path, workspace_root)

        if not allow_symlinks and path.is_symlink():
            return False, f"path '{file_path}' is a symbolic link. This tool does not follow symlinks for safety.", None

        if must_exist and not resolved_path.exists():
            if path.is_symlink():
                return False, f"path '{file_path}' is a broken symbolic link (target does not exist)", None
            return False, f"path '{file_path}' does not exist", None

        if not allow_symlinks and resolved_path.exists() and resolved_path.is_symlink():
            return False, f"path '{file_path}' is a symbolic link. This tool does not follow symlinks for safety.", None

        if must_exist and must_be_file and not resolved_path.is_file():
            if resolved_path.is_dir():
                return False, f"path '{file_path}' is a directory, not a file. Use list_dir to inspect directories.", None
            else:
                return False, f"path '{file_path}' is not a regular file", None

        return True, "", resolved_path
    except ValueError as e:
        return False, str(e), None
    except Exception as e:
        return False, f"invalid file path '{file_path}': {str(e)}", None


def validate_directory_path(
    dir_path: str,
    must_exist: bool = True,
    workspace_root: Optional[str] = None,
) -> tuple[bool, str, Optional[Path]]:
    """
    Validate a directory path.
    Returns (is_valid, error_message, resolved_path).
    """
    try:
        path = _resolve_with_workspace(Path(dir_path), workspace_root)

        if must_exist and not path.exists():
            return False, f"directory '{dir_path}' does not exist", None

        if must_exist and not path.is_dir():
            if path.is_file():
                return False, f"path '{dir_path}' is a file, not a directory. Use read_file to read files.", None
            else:
                return False, f"path '{dir_path}' is not a directory", None

        return True, "", path
    except ValueError as e:
        return False, str(e), None
    except Exception as e:
        return False, f"invalid directory path '{dir_path}': {str(e)}", None


def format_file_size(size_bytes: int) -> str:
    """Format file size in human-readable format."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024.0:
            return f"{size_bytes:.2f} {unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.2f} PB"


def load_context_manifest(ctx_id: str) -> Dict[str, Any]:
    """Load context-specific file tracking manifest."""
    tracking_dir = get_data_dir() / "tracking"
    tracking_dir.mkdir(parents=True, exist_ok=True)
    manifest_file = tracking_dir / f"{ctx_id}.json"

    try:
        if manifest_file.exists():
            with open(manifest_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {"read_files": []}
    except Exception as e:
        _logger.warning(f"Error loading context manifest for {ctx_id}: {e}")
        return {"read_files": []}


def save_context_manifest(ctx_id: str, manifest: Dict[str, Any]) -> None:
    """Save context-specific file tracking manifest."""
    tracking_dir = get_data_dir() / "tracking"
    tracking_dir.mkdir(parents=True, exist_ok=True)
    manifest_file = tracking_dir / f"{ctx_id}.json"

    try:
        with open(manifest_file, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, indent=2)
    except Exception as e:
        _logger.error(f"Error saving context manifest for {ctx_id}: {e}")


WINDOWS_RESERVED_NAMES = {
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
}


def is_windows_reserved_name(filename: str) -> bool:
    """Check if filename is a Windows reserved name."""
    import platform
    if platform.system() != 'Windows':
        return False

    name = Path(filename).stem.upper()
    return name in WINDOWS_RESERVED_NAMES


def check_paths_same(path1: Path, path2: Path) -> bool:
    """Check if two paths refer to the same file (after resolution)."""
    try:
        return path1.resolve() == path2.resolve()
    except Exception:
        return False


def create_backup(file_path: Path) -> Optional[Path]:
    """Create a backup of a file before modifying it."""
    try:
        backup_dir = get_data_dir() / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)

        import time
        timestamp = int(time.time())
        backup_name = f"{file_path.name}.{timestamp}.bak"
        backup_path = backup_dir / backup_name

        import shutil
        shutil.copy2(file_path, backup_path)
        _logger.info(f"Created backup of {file_path} at {backup_path}")
        return backup_path
    except Exception as e:
        _logger.error(f"Failed to create backup of {file_path}: {e}")
        return None