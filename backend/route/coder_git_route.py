"""
Git integration routes for the code editor workspace
"""
from flask import Blueprint, request, jsonify
import subprocess
import os
from pathlib import Path
from typing import Dict, Optional
from utils.db_utils import db
from utils.logger import get_logger

logger = get_logger(__name__)
coder_git_bp = Blueprint('coder_git', __name__)


def get_workspace_path(chat_id: str) -> Optional[Path]:
    """Get the workspace path for a specific chat from database."""
    try:
        def query(conn, cursor):
            cursor.execute(
                "SELECT workspace_path FROM coder_workspaces WHERE chat_id = ?",
                (chat_id,)
            )
            result = cursor.fetchone()
            if result and result[0]:
                return Path(result[0])
            return None

        return db._execute_with_connection("get workspace path", query)
    except Exception as err:
        logger.error("[CODER_GIT] Failed to get workspace path: %s", err)
        return None


def get_git_status(workspace_path: str) -> Optional[Dict[str, str]]:
    """
    Get git status for files in the workspace
    Returns a dict mapping file paths to their git status:
    - 'M' for modified
    - 'A' for added
    - 'D' for deleted
    - 'R' for renamed
    - 'U' for untracked
    - '?' for untracked (git porcelain format)
    """
    if not os.path.exists(os.path.join(workspace_path, '.git')):
        return None  

    try:
        result = subprocess.run(
            ['git', 'status', '--porcelain'],
            cwd=workspace_path,
            capture_output=True,
            text=True,
            timeout=5
        )

        if result.returncode != 0:
            return None

        status_map = {}
        lines = result.stdout.strip().split('\n')

        for line in lines:
            if not line.strip():
                continue

            status_code = line[:2]
            file_path = line[3:].strip()

            if file_path.startswith('"') and file_path.endswith('"'):
                file_path = file_path[1:-1]

            if status_code[1] != ' ':
                status = status_code[1]
            elif status_code[0] != ' ':
                status = status_code[0]
            else:
                status = '?'  

            if status == 'M':
                status_map[file_path] = 'modified'
            elif status == 'A':
                status_map[file_path] = 'added'
            elif status == 'D':
                status_map[file_path] = 'deleted'
            elif status == 'R':
                status_map[file_path] = 'renamed'
            elif status == '?':
                status_map[file_path] = 'untracked'
            else:
                status_map[file_path] = 'modified' 

        return status_map

    except subprocess.TimeoutExpired:
        logger.warning("[CODER_GIT] Timeout getting git status for %s", workspace_path)
        return None
    except Exception as e:
        logger.error("[CODER_GIT] Error getting git status: %s", e)
        return None


@coder_git_bp.route('/api/coder-git/status', methods=['GET'])
def get_status():
    """Get git status for the workspace"""
    chat_id = request.args.get('chat_id')

    if not chat_id:
        return jsonify({"success": False, "error": "chat_id is required"}), 400

    workspace_path = get_workspace_path(chat_id)

    if not workspace_path:
        return jsonify({"success": False, "error": "No workspace set for this chat"}), 404

    if not workspace_path.exists():
        return jsonify({"success": False, "error": "Workspace path does not exist"}), 404

    status_map = get_git_status(str(workspace_path))

    if status_map is None:
        return jsonify({
            "success": True,
            "is_git_repo": False,
            "status": {}
        })

    return jsonify({
        "success": True,
        "is_git_repo": True,
        "status": status_map
    })


@coder_git_bp.route('/api/coder-git/diff', methods=['GET'])
def get_diff():
    """Get git diff for a specific file"""
    chat_id = request.args.get('chat_id')
    file_path = request.args.get('path')

    if not chat_id or not file_path:
        return jsonify({"success": False, "error": "chat_id and path are required"}), 400

    workspace_path = get_workspace_path(chat_id)

    if not workspace_path:
        return jsonify({"success": False, "error": "No workspace set for this chat"}), 404

    if not (workspace_path / '.git').exists():
        return jsonify({"success": False, "error": "Not a git repository"}), 400

    try:
        result = subprocess.run(
            ['git', 'diff', 'HEAD', '--', file_path],
            cwd=str(workspace_path),
            capture_output=True,
            text=True,
            timeout=5
        )

        if result.returncode != 0:
            return jsonify({"success": False, "error": "Failed to get diff"}), 500

        return jsonify({
            "success": True,
            "diff": result.stdout
        })

    except subprocess.TimeoutExpired:
        return jsonify({"success": False, "error": "Timeout getting diff"}), 500
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
