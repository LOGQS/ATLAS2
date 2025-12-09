# status: complete

import os
import subprocess
import threading
import time
import uuid
import json
import yaml
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

from utils.logger import get_logger

logger = get_logger(__name__)

# OAuth providers supported by CLIProxy (subscription/free only, NO API keys)
OAUTH_PROVIDERS = {
    "gemini": {
        "name": "Gemini CLI",
        "description": "Google Gemini via OAuth (Free)",
        "login_endpoint": "gemini-cli-auth-url",
        "login_flag": "--login",
        "file_prefix": "gemini-",
        "supports_reasoning": True,
    },
    "claude": {
        "name": "Claude Code",
        "description": "Claude Code CLI models via Pro/Max subscription",
        "login_endpoint": "anthropic-auth-url",
        "login_flag": "--claude-login",
        "file_prefix": "claude-",
        "supports_reasoning": True,
    },
    "codex": {
        "name": "Codex (ChatGPT)",
        "description": "OpenAI GPT-5 via ChatGPT Plus/Pro subscription",
        "login_endpoint": "codex-auth-url",
        "login_flag": "--codex-login",
        "file_prefix": "codex-",
        "supports_reasoning": True,
    },
    "qwen": {
        "name": "Qwen Code",
        "description": "Alibaba Qwen via OAuth (Free)",
        "login_endpoint": "qwen-auth-url",
        "login_flag": "--qwen-login",
        "file_prefix": "qwen-",
        "supports_reasoning": False,
    },
    "iflow": {
        "name": "iFlow",
        "description": "Chinese AI models - DeepSeek, Kimi, GLM (Free)",
        "login_endpoint": "iflow-auth-url",
        "login_flag": "--iflow-login",
        "file_prefix": "iflow-",
        "supports_reasoning": True,  # DeepSeek R1 has reasoning
    },
    "antigravity": {
        "name": "Antigravity",
        "description": "Antigravity AI models (Free)",
        "login_endpoint": "antigravity-auth-url",
        "login_flag": "--antigravity-login",
        "file_prefix": "antigravity-",
        "supports_reasoning": False,
    },
}

# Model definitions per provider (dynamically updated from auth-files)
DEFAULT_MODELS = {
    "gemini": {
        "gemini-3-pro-preview": {"name": "Gemini 3 Pro Preview", "supports_reasoning": True},
        "gemini-2.5-pro": {"name": "Gemini 2.5 Pro", "supports_reasoning": True},
        "gemini-2.5-flash": {"name": "Gemini 2.5 Flash", "supports_reasoning": True},
        "gemini-2.5-flash-lite": {"name": "Gemini 2.5 Flash Lite", "supports_reasoning": False},
    },
    "claude": {
        "claude-opus-4-5-20251101": {"name": "Claude Opus 4.5", "supports_reasoning": True},
        "claude-sonnet-4-5-20250929": {"name": "Claude Sonnet 4.5", "supports_reasoning": True},
        "claude-haiku-4-5-20251001": {"name": "Claude Haiku 4.5", "supports_reasoning": True},
    },
    "codex": {
        "gpt-5.1-codex-max": {"name": "GPT-5.1 Codex Max", "supports_reasoning": True},
        "gpt-5.1-codex": {"name": "GPT-5.1 Codex", "supports_reasoning": True},
        "gpt-5.1": {"name": "GPT-5.1", "supports_reasoning": False},
        "gpt-5.1-codex-mini": {"name": "GPT-5.1 Codex Mini", "supports_reasoning": False},
    },
    "qwen": {
        "qwen3-coder-plus": {"name": "Qwen3 Coder Plus", "supports_reasoning": False},
        "qwen3-coder-flash": {"name": "Qwen3 Coder Flash", "supports_reasoning": False},
        "qwen3-max": {"name": "Qwen3 Max", "supports_reasoning": False},
        "qwen3-vl-plus": {"name": "Qwen3 VL Plus", "supports_reasoning": False},
        "qwen3-235b-a22b-instruct": {"name": "Qwen3 235B Instruct", "supports_reasoning": False},
    },
    "iflow": {
        "deepseek-v3.2": {"name": "DeepSeek V3.2", "supports_reasoning": False},
        "deepseek-v3.1": {"name": "DeepSeek V3.1", "supports_reasoning": False},
        "deepseek-r1": {"name": "DeepSeek R1", "supports_reasoning": True},
        "deepseek-v3": {"name": "DeepSeek V3", "supports_reasoning": False},
        "kimi-k2": {"name": "Kimi K2", "supports_reasoning": False},
        "glm-4.6": {"name": "GLM 4.6", "supports_reasoning": False},
        "tstars2.0": {"name": "TStars 2.0", "supports_reasoning": False},
    },
    "antigravity": {
        # Models determined dynamically from auth
    },
}


class CLIProxyManager:
    """
    Manages the cli-proxy-api.exe process lifecycle.

    Responsibilities:
    - Start/stop the proxy process
    - Health checks
    - OAuth login flow management
    - Config generation with auto-generated API key
    """

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self._initialized = True
        self.process: Optional[subprocess.Popen] = None
        self.process_lock = threading.Lock()

        # Paths
        self.base_path = Path(__file__).parent.parent.parent.parent / "services" / "cli_proxy"
        self.exe_path = self.base_path / "cli-proxy-api.exe"
        self.config_path = self.base_path / "config.yaml"

        # Auth directory (default location used by cli-proxy-api)
        self.auth_dir = Path.home() / ".cli-proxy-api"

        # API configuration
        self.host = "127.0.0.1"
        self.port = 8317
        self.base_url = f"http://{self.host}:{self.port}"

        # Auto-generated API key for internal use
        self._api_key: Optional[str] = None
        self._management_key: Optional[str] = None

        # Cached auth status
        self._auth_cache: Dict[str, Any] = {}
        self._auth_cache_time: float = 0
        self._auth_cache_ttl: float = 30.0  # seconds

        # Track pending login processes for polling
        self._pending_logins: Dict[str, Dict[str, Any]] = {}

        logger.info(f"CLIProxyManager initialized. Exe path: {self.exe_path}")

    def _load_or_generate_api_key(self) -> str:
        """Load existing API key from config or generate a new one."""
        if self._api_key:
            return self._api_key

        # Try to load from existing config
        if self.config_path.exists():
            try:
                with open(self.config_path, 'r') as f:
                    config = yaml.safe_load(f) or {}
                api_keys = config.get('api-keys', [])
                if api_keys and isinstance(api_keys, list) and len(api_keys) > 0:
                    self._api_key = api_keys[0]
                    logger.debug("Loaded existing API key from config")
                    return self._api_key
            except Exception as e:
                logger.warning(f"Failed to load API key from config: {e}")

        # Generate new key
        self._api_key = f"sk-atlas-{uuid.uuid4().hex}"
        logger.info("Generated new API key for CLIProxy")
        return self._api_key

    def _ensure_config(self) -> bool:
        """Ensure config.yaml exists with proper settings."""
        api_key = self._load_or_generate_api_key()

        config = {
            "host": self.host,
            "port": self.port,
            "remote-management": {
                "allow-remote": False,
                "secret-key": "",
                "disable-control-panel": False,
            },
            "auth-dir": str(self.auth_dir),
            "api-keys": [api_key],
            "debug": False,
            "logging-to-file": False,
            "usage-statistics-enabled": False,
            "proxy-url": "",
            "request-retry": 3,
            "max-retry-interval": 30,
            "quota-exceeded": {
                "switch-project": True,
                "switch-preview-model": True,
            },
            "ws-auth": False,
            "ampcode": {
                "upstream-url": "https://ampcode.com",
                "restrict-management-to-localhost": True,
            },
        }

        try:
            self.base_path.mkdir(parents=True, exist_ok=True)
            with open(self.config_path, 'w') as f:
                yaml.dump(config, f, default_flow_style=False)
            logger.info(f"Config written to {self.config_path}")
            return True
        except Exception as e:
            logger.error(f"Failed to write config: {e}")
            return False

    def has_existing_auth(self) -> bool:
        """Check if any auth files exist (to determine if proxy should auto-start)."""
        if not self.auth_dir.exists():
            return False

        for provider_info in OAUTH_PROVIDERS.values():
            prefix = provider_info["file_prefix"]
            for file in self.auth_dir.glob(f"{prefix}*.json"):
                if file.is_file():
                    logger.debug(f"Found existing auth file: {file.name}")
                    return True
        return False

    def is_running(self) -> bool:
        """Check if the proxy process is running."""
        with self.process_lock:
            if self.process is not None and self.process.poll() is None:
                return True
        return False

    def _is_process_alive(self) -> bool:
        """Check if process is alive (no lock, for internal use only)."""
        return self.process is not None and self.process.poll() is None

    def health_check(self) -> bool:
        """Perform HTTP health check on the proxy."""
        if not self.is_running():
            return False

        return self._do_health_check()

    def _do_health_check(self) -> bool:
        """Perform HTTP health check (no process check, for internal use)."""
        try:
            # Use /v1/models endpoint for health check (more reliable than management API)
            response = requests.get(
                f"{self.base_url}/v1/models",
                headers={"Authorization": f"Bearer {self._api_key}"},
                timeout=2.0
            )
            return response.status_code == 200
        except requests.RequestException as e:
            logger.debug(f"Health check failed: {e}")
            return False

    def start(self) -> bool:
        """Start the cli-proxy-api.exe process."""
        # First check without lock if we can skip
        if self._is_process_alive() and self._do_health_check():
            return True

        with self.process_lock:
            # Double-check inside lock
            if self.process is not None and self.process.poll() is None:
                logger.info("CLIProxy already running")
                return True

            if not self.exe_path.exists():
                logger.error(f"CLIProxy executable not found: {self.exe_path}")
                return False

            if not self._ensure_config():
                return False

            try:
                # Start process hidden (no console window on Windows)
                startupinfo = None
                if os.name == 'nt':
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    startupinfo.wShowWindow = subprocess.SW_HIDE

                self.process = subprocess.Popen(
                    [str(self.exe_path), "--config", str(self.config_path)],
                    cwd=str(self.base_path),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    startupinfo=startupinfo,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                )

                logger.info(f"Started CLIProxy process (PID: {self.process.pid})")

            except Exception as e:
                logger.error(f"Failed to start CLIProxy: {e}")
                return False

        # Health check loop OUTSIDE the lock
        for attempt in range(10):
            time.sleep(0.2 * (1.5 ** attempt))
            if self._do_health_check():
                logger.info("CLIProxy is healthy")
                return True
            # Check if process died
            with self.process_lock:
                if self.process is None or self.process.poll() is not None:
                    logger.error("CLIProxy process exited unexpectedly")
                    return False

        logger.error("CLIProxy failed health check after startup")
        return False

    def stop(self) -> bool:
        """Stop the cli-proxy-api.exe process."""
        with self.process_lock:
            if self.process is None:
                return True

            try:
                self.process.terminate()
                self.process.wait(timeout=5.0)
                logger.info("CLIProxy stopped gracefully")
            except subprocess.TimeoutExpired:
                self.process.kill()
                logger.warning("CLIProxy killed after timeout")
            except Exception as e:
                logger.error(f"Error stopping CLIProxy: {e}")
                return False
            finally:
                self.process = None

            return True

    def ensure_running(self) -> bool:
        """Ensure the proxy is running, starting it if necessary."""
        if self.health_check():
            return True
        return self.start()

    def get_auth_status(self, force_refresh: bool = False) -> Dict[str, Any]:
        """
        Get authentication status for all providers.
        Reads directly from auth directory (filesystem) instead of management API.
        Returns cached data unless expired or force_refresh is True.
        """
        now = time.time()
        if not force_refresh and self._auth_cache and (now - self._auth_cache_time) < self._auth_cache_ttl:
            return self._auth_cache

        result = {"providers": {}}

        try:
            # Read auth files directly from filesystem
            auth_files = []
            if self.auth_dir.exists():
                for file_path in self.auth_dir.glob("*.json"):
                    if file_path.is_file():
                        auth_files.append(file_path.name)

            # Parse auth files to determine provider status
            for provider_id, provider_info in OAUTH_PROVIDERS.items():
                prefix = provider_info["file_prefix"]
                accounts = []

                for filename in auth_files:
                    if filename.startswith(prefix) and filename.endswith(".json"):
                        # Extract email/identifier from filename
                        identifier = filename[len(prefix):-5]  # Remove prefix and .json
                        accounts.append({
                            "identifier": identifier,
                            "filename": filename,
                            "status": "active",
                            "disabled": False,
                        })

                result["providers"][provider_id] = {
                    "name": provider_info["name"],
                    "description": provider_info["description"],
                    "authenticated": len(accounts) > 0,
                    "account_count": len(accounts),
                    "accounts": accounts,
                }

            self._auth_cache = result
            self._auth_cache_time = now

        except Exception as e:
            logger.error(f"Failed to get auth status: {e}")
            result["error"] = str(e)

        return result

    def start_oauth_login(self, provider_id: str) -> Dict[str, Any]:
        """
        Start OAuth login flow for a provider.
        Launches CLI with the appropriate login flag which opens browser automatically.
        """
        if provider_id not in OAUTH_PROVIDERS:
            return {"success": False, "error": f"Unknown provider: {provider_id}"}

        if not self.exe_path.exists():
            return {"success": False, "error": "CLI proxy executable not found"}

        provider_info = OAUTH_PROVIDERS[provider_id]
        login_flag = provider_info["login_flag"]

        # Get initial auth files with modification times for this provider
        initial_files = self._get_auth_files_with_mtime(provider_info["file_prefix"])
        initial_count = len(initial_files)

        try:
            # Launch CLI with login flag - it will open browser automatically
            # Use CREATE_NEW_CONSOLE so user can see login progress
            startupinfo = None
            creationflags = 0
            if os.name == 'nt':
                creationflags = subprocess.CREATE_NEW_CONSOLE

            login_process = subprocess.Popen(
                [str(self.exe_path), login_flag],
                cwd=str(self.base_path),
                creationflags=creationflags,
            )

            logger.info(f"Started OAuth login process for {provider_id} (PID: {login_process.pid})")

            # Generate a state token for tracking
            state_token = f"{provider_id}_{initial_count}_{uuid.uuid4().hex[:8]}"

            # Store login state for polling
            self._pending_logins[state_token] = {
                "provider_id": provider_id,
                "provider_info": provider_info,
                "initial_count": initial_count,
                "initial_files": initial_files,
                "process": login_process,
                "started_at": time.time(),
            }

            return {
                "success": True,
                "state": state_token,
                "provider": provider_id,
                "provider_name": provider_info["name"],
                "message": "Login window opened. Please complete authentication in the browser.",
            }

        except Exception as e:
            logger.error(f"Failed to start OAuth for {provider_id}: {e}")
            return {"success": False, "error": str(e)}

    def _count_auth_files(self, prefix: str) -> int:
        """Count auth files with given prefix."""
        if not self.auth_dir.exists():
            return 0
        count = 0
        for file_path in self.auth_dir.glob(f"{prefix}*.json"):
            if file_path.is_file():
                count += 1
        return count

    def _get_auth_files_with_mtime(self, prefix: str) -> Dict[str, float]:
        """Get auth files with their modification times."""
        result = {}
        if not self.auth_dir.exists():
            return result
        for file_path in self.auth_dir.glob(f"{prefix}*.json"):
            if file_path.is_file():
                result[file_path.name] = file_path.stat().st_mtime
        return result

    def poll_oauth_status(self, state: str) -> Dict[str, Any]:
        """
        Poll the OAuth completion status by checking for new/updated auth files.
        Returns: {"status": "wait"|"ok"|"error", ...}
        """
        if state not in self._pending_logins:
            return {"status": "error", "error": "Unknown login state"}

        login_info = self._pending_logins[state]
        provider_info = login_info["provider_info"]
        initial_count = login_info["initial_count"]
        initial_files = login_info.get("initial_files", set())
        process = login_info["process"]
        started_at = login_info["started_at"]

        prefix = provider_info["file_prefix"]

        # Check for new or updated auth files
        current_files = self._get_auth_files_with_mtime(prefix)
        current_count = len(current_files)

        # Success if: new file appeared OR existing file was modified
        new_file_added = current_count > initial_count
        file_modified = any(
            fname not in initial_files or mtime > initial_files.get(fname, 0)
            for fname, mtime in current_files.items()
        )

        if new_file_added or file_modified:
            # Auth file created or updated - login successful
            del self._pending_logins[state]
            self._auth_cache_time = 0  # Invalidate cache
            return {"status": "ok", "message": "Login successful"}

        # Check if process is still running
        if process.poll() is not None:
            # Process exited
            del self._pending_logins[state]
            self._auth_cache_time = 0

            if process.returncode == 0:
                # Process exited successfully - trust the CLI
                return {"status": "ok", "message": "Login successful"}
            else:
                return {"status": "error", "error": "Login process exited with error"}

        # Check timeout (5 minutes)
        if time.time() - started_at > 300:
            process.terminate()
            del self._pending_logins[state]
            return {"status": "error", "error": "Login timed out"}

        return {"status": "wait", "message": "Waiting for authentication..."}

    def logout_account(self, filename: str) -> Dict[str, Any]:
        """Remove an authenticated account by deleting its auth file directly from filesystem."""
        try:
            # Security: Validate filename to prevent path traversal
            if not filename or ".." in filename or "/" in filename or "\\" in filename:
                return {"success": False, "error": "Invalid filename"}

            if not filename.endswith(".json"):
                return {"success": False, "error": "Invalid auth file"}

            auth_file_path = self.auth_dir / filename

            if not auth_file_path.exists():
                return {"success": False, "error": "Auth file not found"}

            # Verify file is actually inside auth_dir (extra safety)
            try:
                auth_file_path.resolve().relative_to(self.auth_dir.resolve())
            except ValueError:
                return {"success": False, "error": "Invalid file path"}

            # Delete the auth file
            auth_file_path.unlink()
            logger.info(f"Deleted auth file: {filename}")

            # Invalidate cache
            self._auth_cache_time = 0

            return {"success": True}

        except PermissionError:
            return {"success": False, "error": "Permission denied"}
        except Exception as e:
            logger.error(f"Failed to delete auth file {filename}: {e}")
            return {"success": False, "error": str(e)}

    def get_available_models(self) -> Dict[str, Dict[str, Any]]:
        """
        Get all available models based on authenticated providers.
        Only returns models for providers that have at least one authenticated account.
        """
        auth_status = self.get_auth_status()
        available_models = {}

        for provider_id, provider_status in auth_status.get("providers", {}).items():
            if provider_status.get("authenticated"):
                provider_models = DEFAULT_MODELS.get(provider_id, {})
                for model_id, model_info in provider_models.items():
                    available_models[model_id] = {
                        **model_info,
                        "oauth_provider": provider_id,
                        "oauth_provider_name": provider_status.get("name"),
                    }

        return available_models

    def get_api_key(self) -> str:
        """Get the API key for making requests to the proxy."""
        return self._load_or_generate_api_key()


# Singleton accessor
_manager_instance: Optional[CLIProxyManager] = None
_manager_lock = threading.Lock()


def get_cliproxy_manager() -> CLIProxyManager:
    """Get the singleton CLIProxyManager instance."""
    global _manager_instance
    if _manager_instance is None:
        with _manager_lock:
            if _manager_instance is None:
                _manager_instance = CLIProxyManager()
    return _manager_instance
