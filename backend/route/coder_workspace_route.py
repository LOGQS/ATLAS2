# status: complete

"""Routes for managing coder workspace"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
import shutil
import json
import os
import hashlib
import time
import difflib

from flask import Flask, jsonify, request

from utils.logger import get_logger
from utils.db_utils import db

logger = get_logger(__name__)


class CoderWorkspaceRoute:
    """Route handler for coder workspace management."""

    # Comprehensive list of directories/files to ignore in file tree
    _IGNORED_NAMES = {
        # Version Control
        ".git", ".svn", ".hg", ".bzr", ".fossil",
        # Python
        "__pycache__", "venv", "env", ".venv", ".env.local", ".pytest_cache", ".mypy_cache",
        ".tox", ".eggs", "*.egg-info", ".coverage", "htmlcov", ".hypothesis", "pip-wheel-metadata",
        ".ruff_cache", ".pytype", "*.pyc", "*.pyo", "*.pyd", ".Python", "pip-log.txt",
        # Node/JavaScript/TypeScript
        "node_modules", ".npm", ".yarn", ".pnpm", "coverage", "dist", "build", "out",
        ".next", ".nuxt", ".cache", ".parcel-cache", ".turbo", ".vite", ".webpack",
        ".rollup.cache", ".fusebox", ".dynamodb", ".tern-port", ".nyc_output", ".rpt2_cache",
        # Ruby
        ".bundle", "vendor/bundle", "vendor/ruby", ".yardoc", "Gemfile.lock",
        # PHP
        "vendor", "composer.lock",
        # Elixir/Erlang
        "_build", "deps", ".fetch", "erl_crash.dump",
        # Rust (already had target, adding more)
        "Cargo.lock",
        # Go
        "go.work.sum",
        # Java/Kotlin/Scala
        ".gradle", ".m2", ".sbt", ".bloop", ".metals", "project/target", "project/project",
        # C/C++
        "*.o", "*.a", "*.so", "*.dylib", "*.dll", "*.exe", "CMakeFiles", "CMakeCache.txt", ".cmake",
        # iOS/macOS
        "Pods", "DerivedData", ".xcworkspace", ".xcodeproj", "*.xcworkspace", "*.pbxuser",
        "*.mode1v3", "*.mode2v3", "*.perspectivev3", ".swiftpm",
        # Android
        "*.apk", "*.dex", "*.ap_", ".externalNativeBuild", "captures",
        # Database
        "*.db-shm", "*.db-wal", "*.sqlite-journal",
        # IDE/Editors
        ".vscode", ".idea", ".vs", ".eclipse", ".sublime-workspace", ".sublime-project",
        ".fleet", ".cursor", ".devcontainer",
        # Editor temp/swap files
        "*.swp", "*.swo", "*.swn", "*~", ".~lock.*", "*.tmp",
        # System files
        ".DS_Store", "Thumbs.db", "desktop.ini", "$RECYCLE.BIN", ".Spotlight-V100", ".Trashes",
        # Build artifacts (general)
        "target", "bin", "obj", "Debug", "Release", "classes", "*.class",
        # Build systems
        ".stack-work", ".buck-out", "bazel-bin", "bazel-out", "bazel-testlogs", "bazel-*",
        # Package managers & build tools
        "bower_components", "jspm_packages",
        # Documentation build output
        "_site", "site", ".docusaurus", ".docz", ".vuepress/dist", "docs/_build",
        # Logs & temp
        "logs", "*.log", "tmp", "temp", ".tmp", "*.pid", "*.seed", "*.pid.lock",
        # Test/Coverage
        ".nyc_output", "junit", "test-results", "coverage-report",
        # Framework/Tool specific
        ".sass-cache", ".angular", ".serverless", ".terraform", ".pulumi",
        ".netlify", ".vercel", ".amplify", ".expo", ".expo-shared",
        # Misc
        "*.bak", "*.backup", "*.old",
    }

    # Configuration and important dotfiles to KEEP (whitelist)
    _IMPORTANT_DOTFILES = {
        # Environment & Config
        ".env", ".env.example", ".env.template", ".env.development", ".env.production",
        ".env.test", ".env.local", ".env.staging",
        # Git
        ".gitignore", ".gitattributes", ".gitmodules", ".gitkeep", ".gitmessage",
        # Editor Config
        ".editorconfig",
        # Linting & Formatting - JavaScript/TypeScript
        ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml",
        ".eslintrc.cjs", ".eslintrc.mjs", ".eslintignore",
        ".prettierrc", ".prettierrc.js", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml",
        ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.toml", ".prettierignore",
        ".stylelintrc", ".stylelintrc.js", ".stylelintrc.json", ".stylelintrc.yml", ".stylelintignore",
        # Linting & Formatting - Python
        ".flake8", ".pylintrc", ".bandit", ".isort.cfg", ".black", ".yapfrc", ".ruff.toml",
        ".mypy.ini", ".pydocstyle", ".pep8",
        # Linting & Formatting - Ruby
        ".rubocop.yml", ".rubocop_todo.yml", ".ruby-style.yml", ".reek.yml",
        # Linting & Formatting - Go
        ".golangci.yml", ".golangci.yaml", ".gofmt",
        # Linting & Formatting - Rust
        ".rustfmt.toml", ".clippy.toml",
        # Linting & Formatting - C/C++
        ".clang-format", ".clang-tidy",
        # Linting & Formatting - PHP
        ".php_cs", ".php_cs.dist", ".phpcs.xml", ".phpstan.neon",
        # Linting & Formatting - Elixir
        ".credo.exs", ".formatter.exs",
        # Testing - JavaScript/TypeScript
        ".nycrc", ".nycrc.json", ".jestrc", ".jestrc.js", ".jestrc.json",
        ".mocharc", ".mocharc.js", ".mocharc.json", ".mocharc.yml",
        ".ava.config.js", ".ava.config.cjs", ".ava.config.mjs",
        ".jasmine.json", ".karma.conf.js",
        # Testing - Python
        ".coveragerc", "pytest.ini", "tox.ini",
        # Build & Bundling
        ".babelrc", ".babelrc.js", ".babelrc.json", ".babelrc.cjs", ".babelrc.mjs",
        ".swcrc", ".browserslistrc", ".postcssrc", ".postcssrc.js", ".postcssrc.json",
        ".webpackrc", ".webpackrc.js", ".rolluprc", ".rolluprc.js",
        # Package Managers
        ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmrc", ".nvmrc", ".node-version",
        ".gemrc", ".bundle/config",
        # Version Management
        ".python-version", ".ruby-version", ".java-version", ".node-version",
        ".tool-versions", ".rbenv-version", ".jdkversion",
        # Docker
        ".dockerignore", ".dockerfile",
        # CI/CD
        ".travis.yml", ".gitlab-ci.yml", ".circleci", ".github",
        ".jenkins", ".jenkinsfile", ".drone.yml", ".appveyor.yml",
        # Deployment
        ".vercelignore", ".netlify.toml", ".netlifyrc",
        # Pre-commit & Git Hooks
        ".pre-commit-config.yaml", ".pre-commit-hooks.yaml",
        ".huskyrc", ".huskyrc.js", ".huskyrc.json", ".lintstagedrc", ".lintstagedrc.js",
        # Code Quality & Security
        ".codeclimate.yml", ".sonarcloud.properties", ".snyk",
        ".dependabot", ".renovaterc", ".renovaterc.json",
        # Release Management
        ".releaserc", ".releaserc.js", ".releaserc.json", ".releaserc.yml",
        ".semantic-release", ".changelogrc",
        # Commit Standards
        ".commitlintrc", ".commitlintrc.js", ".commitlintrc.json", ".commitlintrc.yml",
        ".commitizen", ".czrc", ".cz.json",
        # Documentation
        ".markdownlint", ".markdownlint.json", ".markdownlintrc",
        ".remarkrc", ".remarkrc.js", ".remarkrc.json",
        # Various Config Formats
        ".yamllint", ".shellcheckrc", ".htmlhintrc", ".csslintrc", ".sass-lint.yml",
        ".stylelintcache", ".eslintcache", ".prettiercache",
        # TypeScript
        ".tsconfig", ".tsbuildinfo",
        # Misc Project Config
        ".watchmanconfig", ".flowconfig", ".buckconfig", ".bazelrc", ".yaspellerrc",
    }
    _MAX_FILE_SIZE = 10 * 1024 * 1024 
    _MAX_CHECKPOINT_SIZE = 5 * 1024 * 1024  

    def __init__(self, app: Flask):
        self.app = app
        self._coder_data_dir = self._ensure_coder_data_dir()
        self._register_routes()

    def _ensure_coder_data_dir(self) -> Path:
        """Ensure data/coder directory exists for temp workspaces and settings."""
        backend_dir = Path(__file__).parent.parent
        project_root = backend_dir.parent
        coder_dir = project_root / "data" / "coder"
        coder_dir.mkdir(parents=True, exist_ok=True)

        (coder_dir / "temp_workspaces").mkdir(exist_ok=True)
        (coder_dir / "settings").mkdir(exist_ok=True)

        logger.info(f"[CODER_WORKSPACE] Ensured coder data directory: {coder_dir}")
        return coder_dir


    def _get_workspace_path(self, chat_id: str) -> Optional[Path]:
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
            logger.error("[CODER_WORKSPACE] Failed to get workspace path: %s", err)
            return None

    def _set_workspace_path(self, chat_id: str, path: str) -> bool:
        """Set the workspace path for a specific chat."""
        try:
            def query(conn, cursor):
                cursor.execute(
                    """
                    INSERT INTO coder_workspaces (chat_id, workspace_path, last_updated)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(chat_id) DO UPDATE SET
                        workspace_path = excluded.workspace_path,
                        last_updated = CURRENT_TIMESTAMP
                    """,
                    (chat_id, path)
                )
                conn.commit()
                return True

            return db._execute_with_connection("set workspace path", query, return_on_error=False)
        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to set workspace path: %s", err)
            return False

    def _resolve_path(self, workspace_root: Path, relative: str) -> Path:
        """Resolve a relative path within the workspace."""
        relative = (relative or "").strip()
        if not relative:
            return workspace_root

        candidate = (workspace_root / Path(relative)).resolve()

        if workspace_root not in candidate.parents and candidate != workspace_root:
            raise ValueError("Path is outside of workspace")

        return candidate

    def _should_ignore(self, path: Union[Path, str]) -> bool:
        """Check if a file/folder should be ignored."""
        name = path if isinstance(path, str) else path.name

        if name in self._IGNORED_NAMES:
            return True

        if name in self._IMPORTANT_DOTFILES:
            return False

        if name.startswith('.'):
            return True

        return False

    def _serialise_node(
        self,
        path: Path,
        workspace_root: Path,
        depth: int = 0,
        max_depth: int = 10,
        dir_entry: Optional[os.DirEntry] = None,
        stop_at_max_depth: bool = True
    ) -> Optional[Dict[str, Any]]:
        """Serialize a file/folder node.

        Args:
            path: Path to serialize
            workspace_root: Root of workspace
            depth: Current depth
            max_depth: Maximum depth to traverse
            dir_entry: Optional DirEntry for efficiency
            stop_at_max_depth: If True, stops at max_depth. If False, marks folders for "Load Deeper"
        """
        if depth > max_depth:
            return None

        if dir_entry is not None:
            entry_name = dir_entry.name
        else:
            entry_name = path.name

        if self._should_ignore(entry_name):
            return None

        try:
            if dir_entry is not None:
                is_directory = dir_entry.is_dir(follow_symlinks=False)
                stats = dir_entry.stat(follow_symlinks=False)
            else:
                is_directory = path.is_dir()
                stats = path.stat()
        except (FileNotFoundError, PermissionError) as e:
            logger.warning("[CODER_WORKSPACE] Cannot access %s: %s", path, e)
            return None

        relative = path.relative_to(workspace_root).as_posix() if path != workspace_root else ""
        display_name = entry_name if relative else workspace_root.name

        node: Dict[str, Any] = {
            "name": display_name,
            "path": relative,
            "type": "directory" if is_directory else "file",
            "modified": datetime.fromtimestamp(stats.st_mtime, tz=timezone.utc).isoformat(),
        }

        if is_directory:
            at_max_depth = depth == max_depth

            if at_max_depth and stop_at_max_depth:
                has_children = False
                try:
                    with os.scandir(path) as iterator:
                        for entry in iterator:
                            if not self._should_ignore(entry.name):
                                has_children = True
                                break
                except (PermissionError, FileNotFoundError):
                    has_children = False

                if has_children:
                    node["canLoadDeeper"] = True
                    node["children"] = []
                    node["item_count"] = 0
                else:
                    node["children"] = []
                    node["item_count"] = 0
            else:
                children: List[Dict[str, Any]] = []
                try:
                    with os.scandir(path) as iterator:
                        entries = list(iterator)
                except (PermissionError, FileNotFoundError) as err:
                    logger.warning("[CODER_WORKSPACE] Permission denied reading directory %s: %s", path, err)
                    entries = []

                entries.sort(
                    key=lambda entry: (
                        not entry.is_dir(follow_symlinks=False),
                        entry.name.lower()
                    )
                )

                for entry in entries:
                    child_path = path / entry.name
                    serialized = self._serialise_node(child_path, workspace_root, depth + 1, max_depth, entry, stop_at_max_depth)
                    if serialized:
                        children.append(serialized)

                node["children"] = children
                node["item_count"] = len(children)
        else:
            node["size"] = stats.st_size

        return node

    def _get_language_from_extension(self, filename: str) -> str:
        """Determine Monaco editor language from file extension."""
        ext_map = {
            '.py': 'python',
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.json': 'json',
            '.html': 'html',
            '.css': 'css',
            '.scss': 'scss',
            '.md': 'markdown',
            '.sql': 'sql',
            '.sh': 'shell',
            '.yaml': 'yaml',
            '.yml': 'yaml',
            '.xml': 'xml',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
            '.go': 'go',
            '.rs': 'rust',
            '.rb': 'ruby',
            '.php': 'php',
        }
        ext = Path(filename).suffix.lower()
        return ext_map.get(ext, 'plaintext')

    def _detect_project_type(self, workspace_path: Path) -> str:
        """Detect project type based on files in the workspace."""
        try:
            files = set(f.name for f in workspace_path.iterdir() if f.is_file())

            if 'package.json' in files:
                package_json = workspace_path / 'package.json'
                try:
                    with open(package_json, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        deps = {**data.get('dependencies', {}), **data.get('devDependencies', {})}
                        if 'react' in deps or 'next' in deps:
                            return 'React/TypeScript'
                        elif 'vue' in deps:
                            return 'Vue.js'
                        elif 'express' in deps:
                            return 'Node.js/Express'
                        return 'Node.js'
                except Exception as e:
                    logger.warning(f"[CODER_WORKSPACE] Failed to parse package.json: {e}")
                    return 'Node.js'

            if 'requirements.txt' in files or 'setup.py' in files or 'pyproject.toml' in files:
                return 'Python'

            if 'Cargo.toml' in files:
                return 'Rust'

            if 'go.mod' in files:
                return 'Go'

            if 'pom.xml' in files or 'build.gradle' in files:
                return 'Java'

            if 'Gemfile' in files:
                return 'Ruby'

            if 'composer.json' in files:
                return 'PHP'

            if any(f.endswith('.sln') for f in files) or any(f.endswith('.csproj') for f in files):
                return 'C#/.NET'

            return 'Mixed'
        except Exception as e:
            logger.warning(f"[CODER_WORKSPACE] Failed to detect project type: {e}")
            return 'Unknown'

    def _count_files(self, workspace_path: Path, max_depth: int = 3) -> int:
        """Count files in workspace (limited depth to avoid performance issues)."""
        count = 0
        try:
            for root, dirs, files in os.walk(workspace_path):
                dirs[:] = [d for d in dirs if d not in self._IGNORED_NAMES and not d.startswith('.')]

                try:
                    depth = len(Path(root).relative_to(workspace_path).parts)
                    if depth >= max_depth:
                        dirs.clear()
                        continue
                except ValueError:
                    logger.warning(f"[CODER_WORKSPACE] Skipping path outside workspace: {root}")
                    dirs.clear()
                    continue

                count += len([f for f in files if not f.startswith('.')])
        except Exception as e:
            logger.warning(f"[CODER_WORKSPACE] Failed to count files: {e}")

        return count

    def _add_to_history(self, workspace_path: Path) -> None:
        """Add or update workspace in history."""
        try:
            def query(conn, cursor):
                workspace_name = workspace_path.name
                project_type = self._detect_project_type(workspace_path)
                file_count = self._count_files(workspace_path)

                cursor.execute(
                    """
                    INSERT INTO workspace_history (workspace_path, workspace_name, project_type, file_count, last_opened, access_count)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 1)
                    ON CONFLICT(workspace_path) DO UPDATE SET
                        last_opened = CURRENT_TIMESTAMP,
                        access_count = access_count + 1,
                        project_type = excluded.project_type,
                        file_count = excluded.file_count
                    """,
                    (str(workspace_path), workspace_name, project_type, file_count)
                )
                conn.commit()
                return True

            db._execute_with_connection("add workspace to history", query)
            logger.info(f"[CODER_WORKSPACE] Added to history: {workspace_path}")
        except Exception as e:
            logger.error(f"[CODER_WORKSPACE] Failed to add to history: {e}")

    def _get_workspace_history(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Get recent workspace history."""
        try:
            def query(conn, cursor):
                cursor.execute(
                    """
                    SELECT workspace_path, workspace_name, project_type, file_count,
                           last_opened, access_count, metadata
                    FROM workspace_history
                    ORDER BY last_opened DESC
                    LIMIT ?
                    """,
                    (limit,)
                )
                rows = cursor.fetchall()
                return [
                    {
                        'path': row[0],
                        'name': row[1],
                        'type': row[2],
                        'fileCount': row[3],
                        'lastOpened': row[4],
                        'accessCount': row[5],
                        'metadata': json.loads(row[6]) if row[6] else {}
                    }
                    for row in rows
                ]

            return db._execute_with_connection("get workspace history", query, return_on_error=[])
        except Exception as e:
            logger.error(f"[CODER_WORKSPACE] Failed to get history: {e}")
            return []

    def _remove_from_history(self, workspace_path: str) -> bool:
        """Remove workspace from history."""
        try:
            def query(conn, cursor):
                cursor.execute(
                    "DELETE FROM workspace_history WHERE workspace_path = ?",
                    (workspace_path,)
                )
                conn.commit()
                return cursor.rowcount > 0

            success = db._execute_with_connection("remove from history", query, return_on_error=False)
            if success:
                logger.info(f"[CODER_WORKSPACE] Removed from history: {workspace_path}")
            return success
        except Exception as e:
            logger.error(f"[CODER_WORKSPACE] Failed to remove from history: {e}")
            return False

    def _create_temp_workspace(self, chat_id: str) -> Path:
        """Create a temporary workspace for quick start."""
        timestamp = int(time.time())
        temp_ws_dir = self._coder_data_dir / "temp_workspaces" / f"temp_{chat_id}_{timestamp}"
        temp_ws_dir.mkdir(parents=True, exist_ok=True)

        (temp_ws_dir / "src").mkdir(exist_ok=True)
        (temp_ws_dir / "README.md").write_text(f"# Temporary Workspace\n\nCreated: {datetime.now().isoformat()}\n", encoding="utf-8")

        logger.info(f"[CODER_WORKSPACE] Created temp workspace: {temp_ws_dir}")
        return temp_ws_dir

    def _get_workspace_settings_filename(self, workspace_path: str) -> str:
        """Generate unique settings filename for workspace using hash of full path."""
        path_hash = hashlib.sha256(workspace_path.encode('utf-8')).hexdigest()[:16]
        workspace_name = Path(workspace_path).name
        return f"{workspace_name}_{path_hash}_settings.json"

    def _save_workspace_settings(self, workspace_path: str, settings: Dict[str, Any]) -> bool:
        """Save workspace-specific settings."""
        try:
            settings_filename = self._get_workspace_settings_filename(workspace_path)
            settings_file = self._coder_data_dir / "settings" / settings_filename
            with open(settings_file, 'w', encoding='utf-8') as f:
                json.dump(settings, f, indent=2)
            logger.info(f"[CODER_WORKSPACE] Saved settings for {workspace_path}")
            return True
        except Exception as e:
            logger.error(f"[CODER_WORKSPACE] Failed to save settings: {e}")
            return False

    def _load_workspace_settings(self, workspace_path: str) -> Dict[str, Any]:
        """Load workspace-specific settings."""
        try:
            settings_filename = self._get_workspace_settings_filename(workspace_path)
            settings_file = self._coder_data_dir / "settings" / settings_filename
            if settings_file.exists():
                with open(settings_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
        except Exception as e:
            logger.error(f"[CODER_WORKSPACE] Failed to load settings: {e}")

        return {
            "environment": "Auto-detect",
            "agentMode": "Full Autonomy",
            "initGit": False,
            "autoInstallDeps": False
        }

    def _compute_content_hash(self, content: str) -> str:
        """Compute SHA-256 hash of content for deduplication."""
        return hashlib.sha256(content.encode('utf-8')).hexdigest()

    def _save_file_snapshot(self, workspace_path: str, file_path: str, content: str, edit_type: str = 'checkpoint') -> bool:
        """Save a checkpoint of file content to history."""
        try:
            content_size = len(content.encode('utf-8'))
            if content_size > self._MAX_CHECKPOINT_SIZE:
                logger.warning(f"[CODER_WORKSPACE] Checkpoint too large ({content_size} bytes) for {file_path}, skipping")
                return False

            content_hash = self._compute_content_hash(content)

            def query(conn, cursor):
                cursor.execute(
                    """
                    INSERT INTO file_edit_history (workspace_path, file_path, content, edit_type, content_hash)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (workspace_path, file_path, content, edit_type, content_hash)
                )
                conn.commit()
                logger.info(f"[CODER_WORKSPACE] Saved checkpoint for {file_path}")
                return True

            return db._execute_with_connection("save file snapshot", query, return_on_error=False)
        except Exception as e:
            logger.error(f"[CODER_WORKSPACE] Failed to save file snapshot: {e}")
            return False

    def _compute_diff_stats(self, content1: str, content2: str) -> Dict[str, int]:
        """Compute diff statistics between two content strings using proper diff algorithm."""
        lines_1 = content1.splitlines(keepends=False)
        lines_2 = content2.splitlines(keepends=False)

        matcher = difflib.SequenceMatcher(None, lines_1, lines_2)

        lines_added = 0
        lines_removed = 0

        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == 'delete':
                lines_removed += (i2 - i1)
            elif tag == 'insert':
                lines_added += (j2 - j1)
            elif tag == 'replace':
                lines_removed += (i2 - i1)
                lines_added += (j2 - j1)

        return {
            'linesAdded': lines_added,
            'linesRemoved': lines_removed
        }

    def _get_file_history(self, workspace_path: str, file_path: str, limit: Optional[int] = 50, include_diff_stats: bool = False) -> List[Dict[str, Any]]:
        """Get edit history for a specific file."""
        try:
            def query(conn, cursor):
                if limit is None:
                    cursor.execute(
                        """
                        SELECT id, content, timestamp, edit_type, content_hash
                        FROM file_edit_history
                        WHERE workspace_path = ? AND file_path = ?
                        ORDER BY timestamp DESC
                        """,
                        (workspace_path, file_path)
                    )
                else:
                    cursor.execute(
                        """
                        SELECT id, content, timestamp, edit_type, content_hash
                        FROM file_edit_history
                        WHERE workspace_path = ? AND file_path = ?
                        ORDER BY timestamp DESC
                        LIMIT ?
                        """,
                        (workspace_path, file_path, limit)
                    )
                rows = cursor.fetchall()
                history = [
                    {
                        'id': row[0],
                        'content': row[1],
                        'timestamp': row[2],
                        'edit_type': row[3],
                        'content_hash': row[4]
                    }
                    for row in rows
                ]

                if include_diff_stats and len(history) > 1:
                    for i in range(len(history) - 1):
                        current = history[i]
                        previous = history[i + 1]
                        stats = self._compute_diff_stats(previous['content'], current['content'])
                        current['linesAdded'] = stats['linesAdded']
                        current['linesRemoved'] = stats['linesRemoved']

                    history[-1]['linesAdded'] = 0
                    history[-1]['linesRemoved'] = 0

                return history

            return db._execute_with_connection("get file history", query, return_on_error=[])
        except Exception as e:
            logger.error(f"[CODER_WORKSPACE] Failed to get file history: {e}")
            return []

    def _get_latest_checkpoint(self, workspace_path: str, file_path: str) -> Optional[str]:
        """Get the latest checkpoint version of a file."""
        try:
            def query(conn, cursor):
                cursor.execute(
                    """
                    SELECT content
                    FROM file_edit_history
                    WHERE workspace_path = ? AND file_path = ?
                    ORDER BY timestamp DESC
                    LIMIT 1
                    """,
                    (workspace_path, file_path)
                )
                row = cursor.fetchone()
                return row[0] if row else None

            return db._execute_with_connection("get latest checkpoint", query, return_on_error=None)
        except Exception as e:
            logger.error(f"[CODER_WORKSPACE] Failed to get latest checkpoint: {e}")
            return None

    def _cleanup_old_checkpoints(self, workspace_path: str, file_path: str, keep_count: int = 100):
        """Clean up old checkpoints, keeping only recent ones."""
        try:
            def query(conn, cursor):
                cursor.execute(
                    """
                    DELETE FROM file_edit_history
                    WHERE id IN (
                        SELECT id FROM file_edit_history
                        WHERE workspace_path = ? AND file_path = ?
                        ORDER BY timestamp DESC
                        LIMIT -1 OFFSET ?
                    )
                    """,
                    (workspace_path, file_path, keep_count)
                )
                deleted = cursor.rowcount
                conn.commit()
                if deleted > 0:
                    logger.info(f"[CODER_WORKSPACE] Cleaned up {deleted} old checkpoints for {file_path}")
                return True

            return db._execute_with_connection("cleanup old checkpoints", query, return_on_error=False)
        except Exception as e:
            logger.error(f"[CODER_WORKSPACE] Failed to cleanup checkpoints: {e}")
            return False

    def _update_file_path_in_history(self, workspace_path: str, old_file_path: str, new_file_path: str) -> bool:
        """Update file path in history when file is renamed or moved."""
        try:
            def query(conn, cursor):
                cursor.execute(
                    """
                    UPDATE file_edit_history
                    SET file_path = ?
                    WHERE workspace_path = ? AND file_path = ?
                    """,
                    (new_file_path, workspace_path, old_file_path)
                )
                updated = cursor.rowcount
                conn.commit()
                if updated > 0:
                    logger.info(f"[CODER_WORKSPACE] Updated {updated} history records: {old_file_path} -> {new_file_path}")
                return True

            return db._execute_with_connection("update file path in history", query, return_on_error=False)
        except Exception as e:
            logger.error(f"[CODER_WORKSPACE] Failed to update file path in history: {e}")
            return False


    def _register_routes(self) -> None:
        self.app.route("/api/coder-workspace/set", methods=["POST"], endpoint="coder_set_workspace")(self.set_workspace)
        self.app.route("/api/coder-workspace/get", methods=["GET"], endpoint="coder_get_workspace")(self.get_workspace)
        self.app.route("/api/coder-workspace/tree", methods=["GET"], endpoint="coder_get_tree")(self.get_tree)
        self.app.route("/api/coder-workspace/tree/load-deeper", methods=["GET"], endpoint="coder_load_deeper")(self.load_deeper)
        self.app.route("/api/coder-workspace/file", methods=["GET"], endpoint="coder_read_file")(self.read_file)
        self.app.route("/api/coder-workspace/file", methods=["PUT"], endpoint="coder_write_file")(self.write_file)
        self.app.route("/api/coder-workspace/file/snapshot", methods=["POST"], endpoint="coder_save_snapshot")(self.save_snapshot)
        self.app.route("/api/coder-workspace/file/history", methods=["GET"], endpoint="coder_file_history")(self.get_file_history_route)
        self.app.route("/api/coder-workspace/file/revert", methods=["POST"], endpoint="coder_revert_file")(self.revert_file)
        self.app.route("/api/coder-workspace/validate", methods=["POST"], endpoint="coder_validate_path")(self.validate_path)
        self.app.route("/api/coder-workspace/create-file", methods=["POST"], endpoint="coder_create_file")(self.create_file)
        self.app.route("/api/coder-workspace/create-folder", methods=["POST"], endpoint="coder_create_folder")(self.create_folder)
        self.app.route("/api/coder-workspace/create-new-workspace", methods=["POST"], endpoint="coder_create_new_workspace")(self.create_new_workspace)
        self.app.route("/api/coder-workspace/delete", methods=["DELETE"], endpoint="coder_delete")(self.delete_node)
        self.app.route("/api/coder-workspace/rename", methods=["POST"], endpoint="coder_rename")(self.rename_node)
        self.app.route("/api/coder-workspace/history", methods=["GET"], endpoint="coder_get_history")(self.get_history)
        self.app.route("/api/coder-workspace/history", methods=["DELETE"], endpoint="coder_delete_history")(self.delete_history_item)
        self.app.route("/api/coder-workspace/quick-start", methods=["POST"], endpoint="coder_quick_start")(self.quick_start)
        self.app.route("/api/coder-workspace/settings", methods=["GET"], endpoint="coder_get_settings")(self.get_settings)
        self.app.route("/api/coder-workspace/settings", methods=["POST"], endpoint="coder_save_settings")(self.save_settings)
        self.app.route("/api/coder-workspace/workspace/changes", methods=["GET"], endpoint="coder_workspace_changes")(self.get_workspace_changes)
        self.app.route("/api/coder-workspace/file/diff-stats", methods=["GET"], endpoint="coder_file_diff_stats")(self.get_file_diff_stats)

    def set_workspace(self):
        """Set the workspace path for a chat."""
        try:
            data = request.get_json(force=True)
            chat_id = data.get("chat_id")
            workspace_path = data.get("workspace_path", "").strip()

            if not chat_id:
                return jsonify({"success": False, "error": "chat_id is required"}), 400

            if not workspace_path:
                return jsonify({"success": False, "error": "workspace_path is required"}), 400

            path = Path(workspace_path).resolve()

            if not path.exists():
                return jsonify({"success": False, "error": "Path does not exist"}), 400

            if not path.is_dir():
                return jsonify({"success": False, "error": "Path is not a directory"}), 400

            if self._set_workspace_path(chat_id, str(path)):
                self._add_to_history(path)

                logger.info("[CODER_WORKSPACE] Set workspace for chat %s: %s", chat_id, path)
                return jsonify({
                    "success": True,
                    "workspace_path": str(path),
                    "workspace_name": path.name
                })
            else:
                return jsonify({"success": False, "error": "Failed to save workspace path"}), 500

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to set workspace: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def get_workspace(self):
        """Get the current workspace path for a chat."""
        try:
            chat_id = request.args.get("chat_id")
            if not chat_id:
                return jsonify({"success": False, "error": "chat_id is required"}), 400

            path = self._get_workspace_path(chat_id)
            if path and path.exists():
                return jsonify({
                    "success": True,
                    "workspace_path": str(path),
                    "workspace_name": path.name
                })
            else:
                return jsonify({"success": True, "workspace_path": None})

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to get workspace: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def validate_path(self):
        """Validate if a path exists and is accessible."""
        try:
            data = request.get_json(force=True)
            path_str = data.get("path", "").strip()

            if not path_str:
                return jsonify({"success": False, "error": "path is required"}), 400

            path = Path(path_str).resolve()

            if not path.exists():
                return jsonify({"success": True, "valid": False, "reason": "Path does not exist"})

            if not path.is_dir():
                return jsonify({"success": True, "valid": False, "reason": "Path is not a directory"})

            return jsonify({
                "success": True,
                "valid": True,
                "path": str(path),
                "name": path.name
            })

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to validate path: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def get_tree(self):
        """Get the file tree for the current workspace."""
        try:
            chat_id = request.args.get("chat_id")
            if not chat_id:
                return jsonify({"success": False, "error": "chat_id is required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set or workspace not found"}), 404

            tree = self._serialise_node(workspace_path, workspace_path)
            return jsonify({"success": True, "root": tree})

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to build tree: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def load_deeper(self):
        """Load one additional depth level for a specific folder (session-only).

        This endpoint is called when the user clicks "Load Deeper" on a folder at max depth.
        It returns the children of that folder with 1 additional depth level.
        """
        try:
            chat_id = request.args.get("chat_id")
            folder_path = request.args.get("path", "")
            current_depth = request.args.get("current_depth", type=int, default=10)

            if not chat_id:
                return jsonify({"success": False, "error": "chat_id is required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set or workspace not found"}), 404

            target = self._resolve_path(workspace_path, folder_path)

            if not target.exists():
                return jsonify({"success": False, "error": "Folder not found"}), 404

            if not target.is_dir():
                return jsonify({"success": False, "error": "Path is not a directory"}), 400

            children: List[Dict[str, Any]] = []
            try:
                with os.scandir(target) as iterator:
                    entries = list(iterator)
            except (PermissionError, FileNotFoundError) as err:
                logger.warning("[CODER_WORKSPACE] Permission denied reading directory %s: %s", target, err)
                entries = []

            entries.sort(
                key=lambda entry: (
                    not entry.is_dir(follow_symlinks=False),
                    entry.name.lower()
                )
            )

            new_max_depth = current_depth + 1
            for entry in entries:
                child_path = target / entry.name
                serialized = self._serialise_node(
                    child_path,
                    workspace_path,
                    depth=current_depth + 1,
                    max_depth=new_max_depth,
                    dir_entry=entry,
                    stop_at_max_depth=True
                )
                if serialized:
                    children.append(serialized)

            return jsonify({
                "success": True,
                "children": children,
                "path": folder_path
            })

        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400
        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to load deeper: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def read_file(self):
        """Read a file from the workspace."""
        try:
            chat_id = request.args.get("chat_id")
            file_path = request.args.get("path", "")

            if not chat_id:
                return jsonify({"success": False, "error": "chat_id is required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set"}), 404

            target = self._resolve_path(workspace_path, file_path)

            if not target.exists():
                return jsonify({"success": False, "error": "File not found"}), 404

            if target.is_dir():
                return jsonify({"success": False, "error": "Path is a directory"}), 400

            if target.stat().st_size > self._MAX_FILE_SIZE:
                return jsonify({"success": False, "error": "File too large (max 10MB)"}), 400

            try:
                content = target.read_text(encoding='utf-8')
            except UnicodeDecodeError:
                try:
                    content = target.read_text(encoding='latin-1')
                except Exception:
                    return jsonify({"success": False, "error": "Cannot read binary file"}), 400

            language = self._get_language_from_extension(target.name)

            return jsonify({
                "success": True,
                "content": content,
                "path": file_path,
                "name": target.name,
                "language": language,
                "size": target.stat().st_size
            })

        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400
        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to read file: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def write_file(self):
        """Write content to a file in the workspace."""
        try:
            data = request.get_json(force=True)
            chat_id = data.get("chat_id")
            file_path = data.get("path", "")
            content = data.get("content", "")
            save_snapshot = data.get("save_snapshot", True)  

            if not chat_id:
                return jsonify({"success": False, "error": "chat_id is required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set"}), 404

            target = self._resolve_path(workspace_path, file_path)

            if target.is_dir():
                return jsonify({"success": False, "error": "Path is a directory"}), 400

            target.parent.mkdir(parents=True, exist_ok=True)

            if save_snapshot and target.exists():
                try:
                    current_content = target.read_text(encoding='utf-8')
                    self._save_file_snapshot(str(workspace_path), file_path, current_content, edit_type='checkpoint')
                except UnicodeDecodeError:
                    logger.warning("[CODER_WORKSPACE] Could not read current content for checkpoint: %s", target)
                except Exception as e:
                    logger.warning("[CODER_WORKSPACE] Failed to create pre-save checkpoint: %s", e)

            target.write_text(content, encoding='utf-8')
            logger.info("[CODER_WORKSPACE] Wrote file: %s", target)

            if save_snapshot:
                self._cleanup_old_checkpoints(str(workspace_path), file_path)

            return jsonify({
                "success": True,
                "path": file_path,
                "size": target.stat().st_size
            })

        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400
        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to write file: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def create_file(self):
        """Create a new file in the workspace."""
        try:
            data = request.get_json(force=True)
            chat_id = data.get("chat_id")
            parent_path = data.get("parent_path", "")
            name = data.get("name", "").strip()

            if not chat_id or not name:
                return jsonify({"success": False, "error": "chat_id and name are required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set"}), 404

            parent = self._resolve_path(workspace_path, parent_path)
            if not parent.is_dir():
                return jsonify({"success": False, "error": "Parent path is not a directory"}), 400

            new_file = parent / name
            if new_file.exists():
                return jsonify({"success": False, "error": "File already exists"}), 400

            new_file.write_text("", encoding='utf-8')
            logger.info("[CODER_WORKSPACE] Created file: %s", new_file)

            return jsonify({
                "success": True,
                "path": str(new_file.relative_to(workspace_path))
            })

        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400
        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to create file: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def create_folder(self):
        """Create a new folder in the workspace."""
        try:
            data = request.get_json(force=True)
            chat_id = data.get("chat_id")
            parent_path = data.get("parent_path", "")
            name = data.get("name", "").strip()

            if not chat_id or not name:
                return jsonify({"success": False, "error": "chat_id and name are required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set"}), 404

            parent = self._resolve_path(workspace_path, parent_path)
            if not parent.is_dir():
                return jsonify({"success": False, "error": "Parent path is not a directory"}), 400

            new_folder = parent / name
            if new_folder.exists():
                return jsonify({"success": False, "error": "Folder already exists"}), 400

            new_folder.mkdir(parents=False, exist_ok=False)
            logger.info("[CODER_WORKSPACE] Created folder: %s", new_folder)

            return jsonify({
                "success": True,
                "path": str(new_folder.relative_to(workspace_path))
            })

        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400
        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to create folder: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def create_new_workspace(self):
        """Create a new workspace folder at a specified location."""
        try:
            data = request.get_json(force=True)
            parent_path = data.get("parent_path", "").strip()
            workspace_name = data.get("workspace_name", "").strip()

            if not parent_path or not workspace_name:
                return jsonify({"success": False, "error": "parent_path and workspace_name are required"}), 400

            if '/' in workspace_name or '\\' in workspace_name:
                return jsonify({"success": False, "error": "Workspace name cannot contain path separators"}), 400

            parent = Path(parent_path).resolve()
            if not parent.exists():
                return jsonify({"success": False, "error": "Parent directory does not exist"}), 400

            if not parent.is_dir():
                return jsonify({"success": False, "error": "Parent path is not a directory"}), 400

            new_workspace = parent / workspace_name
            if new_workspace.exists():
                return jsonify({"success": False, "error": "A folder with that name already exists"}), 400

            new_workspace.mkdir(parents=False, exist_ok=False)

            logger.info("[CODER_WORKSPACE] Created new workspace: %s", new_workspace)

            return jsonify({
                "success": True,
                "workspace_path": str(new_workspace),
                "workspace_name": workspace_name
            })

        except PermissionError:
            return jsonify({"success": False, "error": "Permission denied. Cannot create folder in this location."}), 403
        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to create new workspace: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def delete_node(self):
        """Delete a file or folder from the workspace."""
        try:
            data = request.get_json(force=True)
            chat_id = data.get("chat_id")
            path_str = data.get("path", "")
            is_directory = data.get("is_directory", False)

            if not chat_id or not path_str:
                return jsonify({"success": False, "error": "chat_id and path are required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set"}), 404

            target = self._resolve_path(workspace_path, path_str)
            if not target.exists():
                return jsonify({"success": False, "error": "Path does not exist"}), 404

            if is_directory:
                if not target.is_dir():
                    return jsonify({"success": False, "error": "Path is not a directory"}), 400
                shutil.rmtree(target)
                logger.info("[CODER_WORKSPACE] Deleted folder: %s", target)
            else:
                if target.is_dir():
                    return jsonify({"success": False, "error": "Path is a directory"}), 400
                target.unlink()
                logger.info("[CODER_WORKSPACE] Deleted file: %s", target)

            return jsonify({"success": True})

        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400
        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to delete: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def rename_node(self):
        """Rename a file or folder in the workspace."""
        try:
            data = request.get_json(force=True)
            chat_id = data.get("chat_id")
            old_path_str = data.get("old_path", "")
            new_name = data.get("new_name", "").strip()

            if not chat_id or not old_path_str or not new_name:
                return jsonify({"success": False, "error": "chat_id, old_path, and new_name are required"}), 400

            if '/' in new_name or '\\' in new_name:
                return jsonify({"success": False, "error": "New name cannot contain path separators"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set"}), 404

            old_target = self._resolve_path(workspace_path, old_path_str)
            if not old_target.exists():
                return jsonify({"success": False, "error": "Path does not exist"}), 404

            new_target = old_target.parent / new_name
            if new_target.exists():
                return jsonify({"success": False, "error": "A file or folder with that name already exists"}), 400

            new_path_str = str(new_target.relative_to(workspace_path).as_posix())

            old_target.rename(new_target)
            logger.info("[CODER_WORKSPACE] Renamed: %s -> %s", old_target, new_target)

            if old_target.is_file() or not new_target.is_dir():
                self._update_file_path_in_history(str(workspace_path), old_path_str, new_path_str)
            else:
                old_path_prefix = old_path_str if old_path_str.endswith('/') else old_path_str + '/'
                new_path_prefix = new_path_str if new_path_str.endswith('/') else new_path_str + '/'

                try:
                    def query(conn, cursor):
                        cursor.execute(
                            """
                            UPDATE file_edit_history
                            SET file_path = ? || SUBSTR(file_path, ?)
                            WHERE workspace_path = ? AND file_path LIKE ?
                            """,
                            (new_path_prefix, len(old_path_prefix) + 1, str(workspace_path), old_path_prefix + '%')
                        )
                        updated = cursor.rowcount
                        conn.commit()
                        if updated > 0:
                            logger.info(f"[CODER_WORKSPACE] Updated {updated} history records for renamed directory")
                        return True

                    db._execute_with_connection("update directory history", query, return_on_error=False)
                except Exception as e:
                    logger.warning(f"[CODER_WORKSPACE] Failed to update directory history: {e}")

            return jsonify({
                "success": True,
                "new_path": new_path_str
            })

        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400
        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to rename: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def get_history(self):
        """Get global workspace history."""
        try:
            limit = request.args.get("limit", 10, type=int)
            history = self._get_workspace_history(limit)

            valid_history = []
            for item in history:
                path = Path(item['path'])
                if path.exists() and path.is_dir():
                    valid_history.append(item)

            return jsonify({
                "success": True,
                "history": valid_history
            })

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to get history: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def delete_history_item(self):
        """Remove workspace from global history."""
        try:
            data = request.get_json(force=True)
            workspace_path = data.get("workspace_path", "").strip()

            if not workspace_path:
                return jsonify({"success": False, "error": "workspace_path is required"}), 400

            success = self._remove_from_history(workspace_path)

            if success:
                return jsonify({"success": True})
            else:
                return jsonify({"success": False, "error": "Failed to remove from history"}), 500

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to delete history item: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def quick_start(self):
        """Create a temporary workspace for quick start."""
        try:
            data = request.get_json(force=True)
            chat_id = data.get("chat_id", "").strip()

            if not chat_id:
                return jsonify({"success": False, "error": "chat_id is required"}), 400

            temp_ws_path = self._create_temp_workspace(chat_id)

            if self._set_workspace_path(chat_id, str(temp_ws_path)):
                self._add_to_history(temp_ws_path)

                logger.info("[CODER_WORKSPACE] Created quick start workspace for chat %s: %s", chat_id, temp_ws_path)
                return jsonify({
                    "success": True,
                    "workspace_path": str(temp_ws_path),
                    "workspace_name": temp_ws_path.name,
                    "is_temp": True
                })
            else:
                return jsonify({"success": False, "error": "Failed to set workspace"}), 500

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to create quick start workspace: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def get_settings(self):
        """Get workspace settings."""
        try:
            workspace_path = request.args.get("workspace_path", "").strip()

            if not workspace_path:
                return jsonify({"success": False, "error": "workspace_path is required"}), 400

            settings = self._load_workspace_settings(workspace_path)

            return jsonify({
                "success": True,
                "settings": settings
            })

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to get settings: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def save_settings(self):
        """Save workspace settings."""
        try:
            data = request.get_json(force=True)
            workspace_path = data.get("workspace_path", "").strip()
            settings = data.get("settings", {})

            if not workspace_path:
                return jsonify({"success": False, "error": "workspace_path is required"}), 400

            success = self._save_workspace_settings(workspace_path, settings)

            if success:
                return jsonify({"success": True})
            else:
                return jsonify({"success": False, "error": "Failed to save settings"}), 500

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to save settings: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def save_snapshot(self):
        """Save a checkpoint of file content (called when file is explicitly saved)."""
        try:
            data = request.get_json(force=True)
            chat_id = data.get("chat_id")
            file_path = data.get("path", "")
            content = data.get("content", "")

            if not chat_id or not file_path:
                return jsonify({"success": False, "error": "chat_id and path are required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set"}), 404

            content_size = len(content.encode('utf-8'))
            if content_size > self._MAX_CHECKPOINT_SIZE:
                return jsonify({"success": False, "error": f"File too large ({content_size} bytes) for checkpoint (max {self._MAX_CHECKPOINT_SIZE} bytes)"}), 400

            success = self._save_file_snapshot(str(workspace_path), file_path, content, edit_type='checkpoint')

            return jsonify({"success": success})

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to save checkpoint: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def get_file_history_route(self):
        """Get edit history for a file."""
        try:
            chat_id = request.args.get("chat_id")
            file_path = request.args.get("path", "")
            limit = request.args.get("limit", 50, type=int)
            include_diff_stats = request.args.get("include_diff_stats", "false").lower() == "true"

            if not chat_id or not file_path:
                return jsonify({"success": False, "error": "chat_id and path are required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set"}), 404

            history = self._get_file_history(str(workspace_path), file_path, limit, include_diff_stats)

            return jsonify({
                "success": True,
                "history": history
            })

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to get file history: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def revert_file(self):
        """Revert file to a previous version by writing it to disk."""
        try:
            data = request.get_json(force=True)
            chat_id = data.get("chat_id")
            file_path = data.get("path", "")
            snapshot_id = data.get("snapshot_id")
            revert_to_saved = data.get("revert_to_saved", False)
            save_snapshot = data.get("save_snapshot", True)

            if not chat_id or not file_path:
                return jsonify({"success": False, "error": "chat_id and path are required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set"}), 404

            content = None
            if revert_to_saved:
                content = self._get_latest_checkpoint(str(workspace_path), file_path)
                if content is None:
                    return jsonify({"success": False, "error": "No checkpoint found"}), 404
            elif snapshot_id:
                history = self._get_file_history(str(workspace_path), file_path, limit=None)
                snapshot = next((h for h in history if h['id'] == snapshot_id), None)
                if not snapshot:
                    return jsonify({"success": False, "error": "Snapshot not found"}), 404
                content = snapshot['content']
            else:
                return jsonify({"success": False, "error": "Either snapshot_id or revert_to_saved must be provided"}), 400

            target = self._resolve_path(workspace_path, file_path)

            if save_snapshot and target.exists():
                try:
                    current_content = target.read_text(encoding='utf-8')
                    self._save_file_snapshot(str(workspace_path), file_path, current_content, edit_type='checkpoint')
                except UnicodeDecodeError:
                    logger.warning("[CODER_WORKSPACE] Could not read current content for checkpoint: %s", target)
                except Exception as e:
                    logger.warning("[CODER_WORKSPACE] Failed to create pre-revert checkpoint: %s", e)

            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding='utf-8')
            logger.info("[CODER_WORKSPACE] Reverted file: %s", target)

            return jsonify({
                "success": True,
                "content": content,
                "path": file_path,
                "size": target.stat().st_size
            })

        except ValueError as err:
            return jsonify({"success": False, "error": str(err)}), 400
        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to revert file: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def get_workspace_changes(self):
        """Get all files with checkpoint history in the workspace."""
        try:
            chat_id = request.args.get("chat_id")
            if not chat_id:
                return jsonify({"success": False, "error": "chat_id is required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set"}), 404

            def query(conn, cursor):
                cursor.execute(
                    """
                    SELECT file_path,
                           COUNT(*) as checkpoint_count,
                           MAX(timestamp) as last_checkpoint
                    FROM file_edit_history
                    WHERE workspace_path = ?
                    GROUP BY file_path
                    ORDER BY last_checkpoint DESC
                    """,
                    (str(workspace_path),)
                )
                rows = cursor.fetchall()
                return [
                    {
                        'filePath': row[0],
                        'checkpointCount': row[1],
                        'lastCheckpoint': row[2]
                    }
                    for row in rows
                ]

            files = db._execute_with_connection("get workspace changes", query, return_on_error=[])

            total_added = 0
            total_removed = 0

            for file_info in files:
                file_path = file_info['filePath']
                history = self._get_file_history(str(workspace_path), file_path, limit=None)

                if len(history) >= 2:
                    oldest = history[-1] 
                    newest = history[0]   

                    stats = self._compute_diff_stats(oldest['content'], newest['content'])
                    total_added += stats['linesAdded']
                    total_removed += stats['linesRemoved']

            return jsonify({
                "success": True,
                "files": files,
                "totalStats": {
                    "linesAdded": total_added,
                    "linesRemoved": total_removed
                }
            })

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to get workspace changes: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500

    def get_file_diff_stats(self):
        """Get diff statistics between two checkpoints of a file."""
        try:
            chat_id = request.args.get("chat_id")
            file_path = request.args.get("path", "")
            checkpoint_id_1 = request.args.get("checkpoint_id_1", type=int)
            checkpoint_id_2 = request.args.get("checkpoint_id_2", type=int)

            if not chat_id or not file_path:
                return jsonify({"success": False, "error": "chat_id and path are required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set"}), 404

            history = self._get_file_history(str(workspace_path), file_path, limit=None)

            if not checkpoint_id_1 and not checkpoint_id_2:
                if len(history) < 2:
                    return jsonify({
                        "success": True,
                        "linesAdded": 0,
                        "linesRemoved": 0,
                        "linesUnchanged": 0
                    })
                checkpoint_1 = history[1]  
                checkpoint_2 = history[0]  
            else:
                checkpoint_1 = next((h for h in history if h['id'] == checkpoint_id_1), None)
                checkpoint_2 = next((h for h in history if h['id'] == checkpoint_id_2), None)

                if not checkpoint_1 or not checkpoint_2:
                    return jsonify({"success": False, "error": "Checkpoint not found"}), 404

            content_1 = checkpoint_1['content']
            content_2 = checkpoint_2['content']

            stats = self._compute_diff_stats(content_1, content_2)
            lines_added = stats['linesAdded']
            lines_removed = stats['linesRemoved']

            lines_1 = content_1.splitlines(keepends=False)
            lines_2 = content_2.splitlines(keepends=False)
            matcher = difflib.SequenceMatcher(None, lines_1, lines_2)
            lines_unchanged = sum(i2 - i1 for tag, i1, i2, j1, j2 in matcher.get_opcodes() if tag == 'equal')

            return jsonify({
                "success": True,
                "linesAdded": lines_added,
                "linesRemoved": lines_removed,
                "linesUnchanged": lines_unchanged,
                "checkpoint1": {
                    "id": checkpoint_1['id'],
                    "timestamp": checkpoint_1['timestamp']
                },
                "checkpoint2": {
                    "id": checkpoint_2['id'],
                    "timestamp": checkpoint_2['timestamp']
                }
            })

        except Exception as err:
            logger.error("[CODER_WORKSPACE] Failed to get file diff stats: %s", err)
            return jsonify({"success": False, "error": str(err)}), 500


def register_coder_workspace_routes(app: Flask) -> None:
    """Register the coder workspace routes with the Flask application."""
    CoderWorkspaceRoute(app)
