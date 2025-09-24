# status: complete

"""Routes for managing workspace files via the knowledge sidebar."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List
import shutil

from flask import Flask, jsonify, request

from file_utils.markdown_processor import setup_filespace
from utils.logger import get_logger

logger = get_logger(__name__)


class FileBrowserRoute:
    """Route handler exposing filesystem controls for the data/files workspace."""

    _IGNORED_NAMES = {"md_ver"}

    def __init__(self, app: Flask):
        self.app = app
        self.base_path = Path(setup_filespace()).resolve()
        self._register_routes()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _resolve_path(self, relative: str) -> Path:
        relative = (relative or "").strip()
        candidate = (self.base_path / Path(relative)).resolve()
        if candidate == self.base_path:
            return candidate
        if self.base_path not in candidate.parents:
            raise ValueError("Path is outside of workspace")
        if candidate.relative_to(self.base_path).parts and candidate.relative_to(self.base_path).parts[0] in self._IGNORED_NAMES:
            raise ValueError("Path is not accessible")
        return candidate

    def _serialise_node(self, path: Path) -> Dict[str, Any]:
        is_directory = path.is_dir()
        try:
            stats = path.stat()
        except FileNotFoundError:
            raise

        relative = "" if path == self.base_path else path.relative_to(self.base_path).as_posix()
        name = path.name if relative else "files"

        node: Dict[str, Any] = {
            "name": name,
            "path": relative,
            "type": "directory" if is_directory else "file",
            "modified": datetime.utcfromtimestamp(stats.st_mtime).isoformat() + "Z",
        }

        if is_directory:
            children: List[Dict[str, Any]] = []
            for child in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
                if child.name in self._IGNORED_NAMES:
                    continue
                children.append(self._serialise_node(child))
            node["children"] = children
            node["item_count"] = len(children)
        else:
            node["size"] = stats.st_size

        return node

    def _validate_name(self, name: str) -> str:
        cleaned = (name or "").strip()
        if not cleaned:
            raise ValueError("Name cannot be empty")
        if any(sep in cleaned for sep in ("/", "\\")):
            raise ValueError("Name cannot contain path separators")
        if cleaned in self._IGNORED_NAMES:
            raise ValueError("This name is reserved")
        return cleaned

    # ------------------------------------------------------------------
    # Routes
    # ------------------------------------------------------------------

    def _register_routes(self) -> None:
        self.app.route("/api/file-browser/tree", methods=["GET"])(self.get_tree)
        self.app.route("/api/file-browser/nodes", methods=["POST"])(self.create_node)
        self.app.route("/api/file-browser/nodes", methods=["PUT"])(self.rename_node)
        self.app.route("/api/file-browser/nodes", methods=["DELETE"])(self.delete_node)

    def get_tree(self):
        """Return the full workspace tree."""
        try:
            tree = self._serialise_node(self.base_path)
            return jsonify({"success": True, "root": tree})
        except Exception as err:
            logger.error("[FILE_BROWSER] Failed to build tree: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def create_node(self):
        """Create a new file or folder within the workspace."""
        try:
            data = request.get_json(force=True)
            parent_path = data.get("parent_path", "")
            node_type = data.get("type")
            name = self._validate_name(data.get("name"))
            content = data.get("content", "") if node_type == "file" else None

            if node_type not in {"file", "directory"}:
                return jsonify({"success": False, "error": "type must be 'file' or 'directory'"}), 400

            parent = self._resolve_path(parent_path)
            if not parent.is_dir():
                return jsonify({"success": False, "error": "Parent path is not a directory"}), 400

            target = parent / name
            if target.exists():
                return jsonify({"success": False, "error": "A file or folder with that name already exists"}), 409

            if node_type == "directory":
                target.mkdir(parents=False, exist_ok=False)
            else:
                target.write_text(content or "", encoding="utf-8")

            logger.info("[FILE_BROWSER] Created %s at %s", node_type, target)

            return jsonify({"success": True, "node": self._serialise_node(target)})
        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400
        except Exception as err:
            logger.error("[FILE_BROWSER] Failed to create node: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def rename_node(self):
        """Rename an existing file or folder."""
        try:
            data = request.get_json(force=True)
            path = data.get("path")
            new_name = self._validate_name(data.get("new_name"))

            if not path:
                return jsonify({"success": False, "error": "path is required"}), 400

            current = self._resolve_path(path)
            if current == self.base_path:
                return jsonify({"success": False, "error": "Cannot rename workspace root"}), 400

            destination = current.parent / new_name
            if destination.exists():
                return jsonify({"success": False, "error": "Destination already exists"}), 409

            current.rename(destination)
            logger.info("[FILE_BROWSER] Renamed %s -> %s", current, destination)

            return jsonify({"success": True, "node": self._serialise_node(destination)})
        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400
        except FileNotFoundError:
            return jsonify({"success": False, "error": "File or folder not found"}), 404
        except Exception as err:
            logger.error("[FILE_BROWSER] Failed to rename node: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def delete_node(self):
        """Delete a file or folder."""
        try:
            data = request.get_json(force=True) if request.data else {}
            path = data.get("path") or request.args.get("path")
            if not path:
                return jsonify({"success": False, "error": "path is required"}), 400

            target = self._resolve_path(path)
            if target == self.base_path:
                return jsonify({"success": False, "error": "Cannot delete workspace root"}), 400

            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()

            logger.info("[FILE_BROWSER] Deleted %s", target)
            return jsonify({"success": True})
        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400
        except FileNotFoundError:
            return jsonify({"success": False, "error": "File or folder not found"}), 404
        except Exception as err:
            logger.error("[FILE_BROWSER] Failed to delete node: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500


def register_file_browser_routes(app: Flask) -> None:
    """Register the file browser routes with the Flask application."""
    FileBrowserRoute(app)
