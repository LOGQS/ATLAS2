"""Routes for terminal command execution in workspace."""

from __future__ import annotations

import json
import os
import sys
import subprocess
import threading
import uuid
import time
import queue
from pathlib import Path
from typing import Dict, Any, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime

from flask import Flask, jsonify, request, Response, stream_with_context

from utils.logger import get_logger
from utils.db_utils import db

logger = get_logger(__name__)


@dataclass
class TerminalSession:
    """Represents an active persistent terminal session with shell process."""
    session_id: str
    workspace_path: str
    process: Optional[subprocess.Popen]
    # PTY support
    is_pty: bool = False
    master_fd: Optional[int] = None
    slave_fd: Optional[int] = None
    winpty_proc: Optional[Any] = None
    local_echo: bool = False
    platform: str = field(default_factory=lambda: sys.platform)
    shell: str = ""
    line_ending: str = os.linesep
    output_queue: queue.Queue = field(default_factory=queue.Queue)
    output_thread: Optional[threading.Thread] = None
    created_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.time)
    is_alive: bool = True
    subscribers: Dict[str, queue.Queue] = field(default_factory=dict)
    subscribers_lock: threading.Lock = field(default_factory=threading.Lock)


class TerminalRoute:
    """Route handler for persistent terminal sessions."""

    def __init__(self, app: Flask):
        self.app = app
        self._sessions: Dict[str, TerminalSession] = {}
        self._session_lock = threading.Lock()
        self._register_routes()

    @staticmethod
    def _session_running(session: 'TerminalSession') -> bool:
        if getattr(session, 'is_pty', False):
            return session.is_alive
        try:
            return session.process is not None and session.process.poll() is None
        except Exception:
            return False

    @staticmethod
    def _format_sse_event(payload: Dict[str, Any]) -> str:
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    def _register_stream_subscriber(self, session: TerminalSession) -> tuple[str, queue.Queue]:
        subscriber_id = str(uuid.uuid4())
        subscriber_queue: queue.Queue = queue.Queue()
        with session.subscribers_lock:
            session.subscribers[subscriber_id] = subscriber_queue
        logger.info(f"[TERMINAL] Registered stream subscriber {subscriber_id} for session {session.session_id}")
        return subscriber_id, subscriber_queue

    def _remove_stream_subscriber(self, session: TerminalSession, subscriber_id: str) -> None:
        with session.subscribers_lock:
            session.subscribers.pop(subscriber_id, None)
        logger.info(f"[TERMINAL] Removed stream subscriber {subscriber_id} for session {session.session_id}")

    def _broadcast_to_subscribers(self, session: TerminalSession, payload: Optional[Dict[str, Any]]) -> None:
        with session.subscribers_lock:
            for subscriber_queue in session.subscribers.values():
                try:
                    subscriber_queue.put_nowait(payload.copy() if payload is not None else None)
                except Exception as exc:
                    logger.warning(f"[TERMINAL] Failed to publish output to subscriber for session {session.session_id}: {exc}")

    def _enable_windows_vt_mode(self, process: subprocess.Popen) -> bool:
        """Enable Virtual Terminal processing for Windows console."""
        if os.name != 'nt':
            return False

        try:
            import ctypes
            from ctypes import wintypes

            # Constants for console mode
            ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
            STD_OUTPUT_HANDLE = -11

            kernel32 = ctypes.windll.kernel32

            # Get console handle
            h_out = kernel32.GetStdHandle(STD_OUTPUT_HANDLE)
            if h_out == -1:
                logger.warning("[TERMINAL] Could not get console handle for VT mode")
                return False

            # Get current mode
            mode = wintypes.DWORD()
            if not kernel32.GetConsoleMode(h_out, ctypes.byref(mode)):
                logger.warning("[TERMINAL] Could not get console mode for VT mode")
                return False

            # Enable VT processing
            new_mode = mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING
            if not kernel32.SetConsoleMode(h_out, new_mode):
                logger.warning("[TERMINAL] Could not enable VT processing")
                return False

            logger.info("[TERMINAL] Enabled Windows Virtual Terminal processing")
            return True
        except Exception as e:
            logger.warning(f"[TERMINAL] Failed to enable VT mode: {e}")
            return False

    def _create_shell_process(self, workspace_path: Path) -> tuple[TerminalSession, Dict[str, Any]]:
        """Create a persistent shell session; prefer a PTY if available."""
        # Detect and prepare venv activation if present
        venv_path = self._detect_venv(workspace_path)
        startup_commands = []
        metadata: Dict[str, Any] = {
            "platform": sys.platform,
            "shell": "",
            "line_ending": os.linesep,
        }

        if venv_path:
            activation_cmd = self._get_venv_activation_command(venv_path)
            startup_commands.append(activation_cmd)
            logger.info(f"[TERMINAL] Will auto-activate venv: {venv_path}")

        # Load .env file
        env = os.environ.copy()
        env_vars = self._load_env_file(workspace_path)
        env.update(env_vars)

        if os.name == 'nt':  # Windows
            env['TERM'] = 'xterm-256color'
            # Try pywinpty (ConPTY) for proper interactive behavior
            try:
                from pywinpty import PtyProcess  # type: ignore
                winpty_proc = PtyProcess.spawn('cmd.exe', cwd=str(workspace_path), env=env)
                try:
                    winpty_proc.write('chcp 65001 > NUL\r\n')
                except Exception:
                    pass
                for cmd in startup_commands:
                    try:
                        winpty_proc.write(cmd + '\r\n')
                    except Exception:
                        pass
                metadata.update({
                    "shell": "cmd.exe",
                    "line_ending": "\r\n",
                })
                session = TerminalSession(
                    session_id='',
                    workspace_path=str(workspace_path),
                    process=None,
                    is_pty=True,
                    winpty_proc=winpty_proc,
                    local_echo=True,
                    platform=sys.platform,
                    shell='cmd.exe',
                    line_ending='\r\n',
                )
                logger.info("[TERMINAL] Using pywinpty PTY backend on Windows")
                return session, metadata
            except Exception as e:
                logger.warning(f"[TERMINAL] pywinpty unavailable/failure, falling back to pipes: {e}")
                # Fallback to pipes as before
                process = subprocess.Popen(
                    ['cmd.exe'],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    cwd=str(workspace_path),
                    env=env,
                    text=True,
                    bufsize=0,
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
                )
                self._enable_windows_vt_mode(process)
                try:
                    process.stdin.write("chcp 65001 > NUL\n")
                    process.stdin.flush()
                except Exception:
                    pass
                for cmd in startup_commands:
                    process.stdin.write(f"{cmd}\n")
                    process.stdin.flush()
                metadata.update({
                    "shell": "cmd.exe",
                    "line_ending": "\r\n",
                })
                session = TerminalSession(
                    session_id='',
                    workspace_path=str(workspace_path),
                    process=process,
                    is_pty=False,
                )
                logger.info(f"[TERMINAL] Created persistent shell process in {workspace_path}")
                logger.info(f"[TERMINAL] Shell metadata: platform={metadata.get('platform')} shell={metadata.get('shell')} line_ending={repr(metadata.get('line_ending'))}")
                return session, metadata
        else:  # Unix/Linux/Mac
            # Set TERM for proper terminal emulation
            env['TERM'] = 'xterm-256color'

            shell_path = os.environ.get('SHELL') or '/bin/bash'
            shell_executable = shell_path if shell_path and Path(shell_path).exists() else '/bin/bash'
            try:
                import pty, fcntl, termios, struct
                master_fd, slave_fd = pty.openpty()
                # Set a sane default size (will be updated by frontend resize)
                rows, cols = 24, 80
                winsz = struct.pack('HHHH', rows, cols, 0, 0)
                fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsz)
                process = subprocess.Popen(
                    [shell_executable],
                    stdin=slave_fd,
                    stdout=slave_fd,
                    stderr=slave_fd,
                    cwd=str(workspace_path),
                    env=env,
                    bufsize=0,
                    preexec_fn=os.setsid
                )
                try:
                    os.close(slave_fd)
                except Exception:
                    pass
                for cmd in startup_commands:
                    os.write(master_fd, (cmd + "\n").encode('utf-8', errors='ignore'))
                metadata.update({
                    "shell": shell_executable,
                    "line_ending": "\n",
                })
                session = TerminalSession(
                    session_id='',
                    workspace_path=str(workspace_path),
                    process=process,
                    is_pty=True,
                    master_fd=master_fd,
                )
                logger.info("[TERMINAL] Using PTY backend on Unix")
                logger.info(f"[TERMINAL] Created persistent shell process in {workspace_path}")
                logger.info(f"[TERMINAL] Shell metadata: platform={metadata.get('platform')} shell={metadata.get('shell')} line_ending={repr(metadata.get('line_ending'))}")
                return session, metadata
            except Exception as e:
                logger.warning(f"[TERMINAL] PTY creation failed on Unix; falling back to pipes: {e}")
                process = subprocess.Popen(
                    [shell_executable],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    cwd=str(workspace_path),
                    env=env,
                    text=True,
                    bufsize=0,
                    preexec_fn=os.setsid
                )
                for cmd in startup_commands:
                    process.stdin.write(f"{cmd}\n")
                    process.stdin.flush()
                metadata.update({
                    "shell": shell_executable,
                    "line_ending": "\n",
                })
                session = TerminalSession(
                    session_id='',
                    workspace_path=str(workspace_path),
                    process=process,
                    is_pty=False,
                )
                logger.info(f"[TERMINAL] Created persistent shell process in {workspace_path}")
                logger.info(f"[TERMINAL] Shell metadata: platform={metadata.get('platform')} shell={metadata.get('shell')} line_ending={repr(metadata.get('line_ending'))}")
                return session, metadata

    def _output_reader_thread(self, session: TerminalSession):
        """Background thread to read output from shell process.

        Important: Reading large fixed-size blocks from a pipe (e.g., 4096)
        can block until the buffer is full, which breaks interactivity.
        We read small increments and flush frequently so prompts and
        interactive program output appear immediately.
        """
        try:
            logger.info(f"[TERMINAL] Output reader started for session {session.session_id}")
            buffer: list[str] = []
            last_flush = time.time()
            flush_interval = 0.05  # seconds
            max_buffer = 1024

            def read_from_session(max_bytes: int = 1024) -> str:
                if session.is_pty:
                    if os.name == 'nt' and session.winpty_proc is not None:
                        try:
                            data = session.winpty_proc.read(max_bytes)
                            if isinstance(data, (bytes, bytearray)):
                                return data.decode('utf-8', errors='ignore')
                            return str(data)
                        except Exception:
                            return ''
                    elif session.master_fd is not None:
                        try:
                            b = os.read(session.master_fd, max_bytes)
                            return b.decode('utf-8', errors='ignore')
                        except Exception:
                            return ''
                # Pipe fallback
                try:
                    return session.process.stdout.read(1)  # type: ignore
                except Exception:
                    return ''

            while self._session_running(session):
                ch = read_from_session(512)
                if ch:
                    buffer.append(ch)
                    now = time.time()
                    if ('\n' in ch) or ('\r' in ch) or (len(''.join(buffer)) >= max_buffer) or ((now - last_flush) >= flush_interval):
                        chunk = ''.join(buffer)
                        buffer.clear()
                        session.output_queue.put(chunk)
                        self._broadcast_to_subscribers(session, {"type": "output", "data": chunk})
                        session.last_activity = now
                        last_flush = now
                    continue
                if not self._session_running(session):
                    break
                time.sleep(0.01)

            # Flush any trailing buffer
            if buffer:
                chunk = ''.join(buffer)
                session.output_queue.put(chunk)
                self._broadcast_to_subscribers(session, {"type": "output", "data": chunk})
        except Exception as e:
            logger.error(f"[TERMINAL] Output reader error: {e}")
        finally:
            logger.info(f"[TERMINAL] Output reader stopping for session {session.session_id}")
            session.is_alive = False
            session.output_queue.put(None)  # Signal end
            self._broadcast_to_subscribers(session, {"type": "terminated"})
            self._broadcast_to_subscribers(session, None)

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
            logger.error("[TERMINAL] Failed to get workspace path: %s", err)
            return None

    def _create_new_session(self, workspace_path: str) -> TerminalSession:
        """Create a new persistent terminal session with shell process."""
        session_id = str(uuid.uuid4())

        # Create persistent shell process
        session, metadata = self._create_shell_process(Path(workspace_path))
        # Fill required fields
        session.session_id = session_id
        session.workspace_path = workspace_path
        session.local_echo = False if getattr(session, 'is_pty', False) else (os.name == 'nt')
        session.platform = str(metadata.get("platform", sys.platform))
        session.shell = str(metadata.get("shell", ""))
        session.line_ending = str(metadata.get("line_ending", os.linesep))

        # Start output reader thread
        output_thread = threading.Thread(
            target=self._output_reader_thread,
            args=(session,),
            daemon=True
        )
        output_thread.start()
        session.output_thread = output_thread

        # Store session
        with self._session_lock:
            self._sessions[session_id] = session

        logger.info(f"[TERMINAL] Created persistent session {session_id} for {workspace_path}")
        return session

    def _get_session(self, session_id: str) -> Optional[TerminalSession]:
        """Get existing session by ID."""
        with self._session_lock:
            return self._sessions.get(session_id)

    def _kill_session(self, session_id: str) -> bool:
        """Kill a terminal session and its shell process."""
        with self._session_lock:
            session = self._sessions.get(session_id)
            if not session:
                return False

            session.is_alive = False

            # Kill the process
            try:
                if session.is_pty:
                    if os.name == 'nt' and session.winpty_proc is not None:
                        try:
                            session.winpty_proc.terminate(True)
                        except Exception:
                            try:
                                session.winpty_proc.close(True)
                            except Exception:
                                pass
                    else:
                        # Unix PTY
                        import signal
                        try:
                            os.killpg(os.getpgid(session.process.pid), signal.SIGTERM)
                        except Exception:
                            pass
                        try:
                            if session.master_fd is not None:
                                os.close(session.master_fd)
                        except Exception:
                            pass
                else:
                    if session.process.poll() is None:  # Still running
                        if os.name == 'nt':  # Windows
                            import signal
                            os.kill(session.process.pid, signal.CTRL_BREAK_EVENT)
                        else:  # Unix
                            import signal
                            os.killpg(os.getpgid(session.process.pid), signal.SIGTERM)
                        session.process.wait(timeout=2)
                logger.info(f"[TERMINAL] Killed session {session_id}")
            except Exception as e:
                logger.warning(f"[TERMINAL] Error killing session {session_id}: {e}")
                try:
                    session.process.kill()  # Force kill
                except:
                    pass

            self._broadcast_to_subscribers(session, {"type": "terminated"})
            self._broadcast_to_subscribers(session, None)

            # Remove from sessions
            del self._sessions[session_id]
            return True

    def _cleanup_old_sessions(self, max_age_seconds: int = 3600):
        """Remove sessions inactive for more than max_age_seconds."""
        with self._session_lock:
            current_time = time.time()
            to_remove = [
                sid for sid, session in self._sessions.items()
                if current_time - session.last_activity > max_age_seconds
            ]

        for sid in to_remove:
            self._kill_session(sid)

    def _detect_venv(self, workspace_path: Path) -> Optional[Path]:
        """Detect Python virtual environment in workspace."""
        # Common venv directory names
        venv_names = ['venv', '.venv', 'env', 'virtualenv', '.virtualenv']

        for venv_name in venv_names:
            venv_path = workspace_path / venv_name
            if venv_path.exists() and venv_path.is_dir():
                # Check if it's a valid venv by looking for activate script
                if os.name == 'nt':  # Windows
                    activate_script = venv_path / 'Scripts' / 'activate.bat'
                else:  # Unix/Linux/Mac
                    activate_script = venv_path / 'bin' / 'activate'

                if activate_script.exists():
                    logger.info(f"[TERMINAL] Detected venv at: {venv_path}")
                    return venv_path

        return None

    def _get_venv_activation_command(self, venv_path: Path) -> str:
        """Get the command to activate a virtual environment."""
        if os.name == 'nt':  # Windows
            # Use call to run in same shell context
            activate_script = venv_path / 'Scripts' / 'activate.bat'
            return f'call "{activate_script}"'
        else:  # Unix/Linux/Mac
            activate_script = venv_path / 'bin' / 'activate'
            return f'. "{activate_script}"'

    def _load_env_file(self, workspace_path: Path) -> Dict[str, str]:
        """Load environment variables from .env file if it exists."""
        env_vars = {}
        env_file = workspace_path / '.env'

        if env_file.exists() and env_file.is_file():
            try:
                with open(env_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        # Skip comments and empty lines
                        if line and not line.startswith('#') and '=' in line:
                            key, value = line.split('=', 1)
                            # Remove quotes if present
                            value = value.strip().strip('"').strip("'")
                            env_vars[key.strip()] = value
                logger.info(f"[TERMINAL] Loaded {len(env_vars)} environment variables from .env")
            except Exception as e:
                logger.warning(f"[TERMINAL] Failed to load .env file: {e}")

        return env_vars

    def _preprocess_command(self, session: TerminalSession, command_data: str) -> str:
        """Preprocess command data before sending to shell.

        Handles special commands and control characters.
        Returns the processed command data, or None if fully handled.
        """
        # In PTY mode we let control characters flow; the shell handles them.
        if getattr(session, 'is_pty', False):
            return command_data
        # Handle Ctrl+C (ETX character)
        if '\x03' in command_data:
            # Try to send interrupt signal to the process group
            try:
                if os.name == 'nt':  # Windows
                    import signal
                    # Send Ctrl+C event to the process group
                    # Note: This may not work perfectly with PIPE-only processes
                    try:
                        os.kill(session.process.pid, signal.CTRL_C_EVENT)
                    except:
                        # If CTRL_C_EVENT doesn't work, try CTRL_BREAK_EVENT
                        os.kill(session.process.pid, signal.CTRL_BREAK_EVENT)
                else:  # Unix
                    import signal
                    os.killpg(os.getpgid(session.process.pid), signal.SIGINT)

                logger.info(f"[TERMINAL] Sent interrupt signal to session {session.session_id}")
            except Exception as e:
                logger.warning(f"[TERMINAL] Failed to send interrupt signal: {e}")

            # Remove \x03 from command data (already handled as signal)
            command_data = command_data.replace('\x03', '')

            # If only \x03 was sent, return empty to avoid sending to stdin
            if not command_data or command_data.strip() == '':
                return ''

        # Check if this is a clear screen command
        # Note: cmd.exe with stdin=PIPE doesn't have a console, so cls won't work.
        # We intercept it and send ANSI clear sequences directly to clients.
        stripped_command = command_data.strip().lower()

        if stripped_command in ['cls', 'clear']:
            # Send ANSI clear sequence to all subscribers
            # \x1b[2J - Clear entire screen
            # \x1b[3J - Clear scrollback buffer
            # \x1b[H  - Move cursor to home position (1,1)
            clear_sequence = '\x1b[2J\x1b[3J\x1b[H'
            self._broadcast_to_subscribers(session, {"type": "output", "data": clear_sequence})

            # Return just newline to trigger shell to output new prompt; caller will normalize
            return '\n'

        return command_data

    def _register_routes(self) -> None:
        """Register terminal routes."""
        self.app.route("/api/terminal/create", methods=["POST"], endpoint="terminal_create")(self.create_session_route)
        self.app.route("/api/terminal/send", methods=["POST"], endpoint="terminal_send")(self.send_command_route)
        self.app.route("/api/terminal/stream", methods=["GET"], endpoint="terminal_stream")(self.stream_output_route)
        self.app.route("/api/terminal/output", methods=["GET"], endpoint="terminal_output")(self.get_output_route)
        self.app.route("/api/terminal/kill", methods=["POST"], endpoint="terminal_kill")(self.kill_session_route)
        self.app.route("/api/terminal/list", methods=["GET"], endpoint="terminal_list")(self.list_sessions_route)
        self.app.route("/api/terminal/resize", methods=["POST"], endpoint="terminal_resize")(self.resize_session_route)

    def create_session_route(self):
        """Create a new persistent terminal session."""
        try:
            data = request.get_json(force=True)
            chat_id = data.get("chat_id")

            if not chat_id:
                return jsonify({"success": False, "error": "chat_id is required"}), 400

            workspace_path = self._get_workspace_path(chat_id)
            if not workspace_path or not workspace_path.exists():
                return jsonify({"success": False, "error": "No workspace set"}), 404

            # Create new session
            logger.info(f"[TERMINAL] Create session requested for chat_id={chat_id}, workspace={workspace_path}")
            session = self._create_new_session(str(workspace_path))

            return jsonify({
                "success": True,
                "session_id": session.session_id,
                "workspace_path": session.workspace_path,
                "local_echo": session.local_echo,
                "platform": session.platform,
                "shell": session.shell,
                "line_ending": session.line_ending,
                "created_at": session.created_at,
            })

        except Exception as err:
            logger.error(f"[TERMINAL] Create session failed: {err}")
            return jsonify({"success": False, "error": str(err)}), 500

    def send_command_route(self):
        """Send input data to a persistent terminal session."""
        try:
            data = request.get_json(force=True)
            session_id = data.get("session_id")
            payload_key = "data" if "data" in data else "command"
            raw_payload = data.get(payload_key, "")

            if not session_id:
                return jsonify({"success": False, "error": "session_id is required"}), 400

            if not isinstance(raw_payload, str):
                return jsonify({"success": False, "error": "Input payload must be a string"}), 400

            session = self._get_session(session_id)
            if not session:
                return jsonify({"success": False, "error": "Session not found"}), 404

            if not self._session_running(session):
                return jsonify({"success": False, "error": "Session is not alive"}), 400

            # Security check
            dangerous_commands = ['rm -rf /', 'dd if=', 'mkfs', 'format', ':(){:|:&};:']
            if payload_key == "command":
                lower_command = raw_payload.lower()
                if any(dangerous_cmd in lower_command for dangerous_cmd in dangerous_commands):
                    return jsonify({"success": False, "error": "Command contains potentially dangerous operations"}), 400

            payload_to_write = raw_payload
            if payload_key == "command" and not raw_payload.endswith("\n") and not raw_payload.endswith("\r"):
                payload_to_write = f"{raw_payload}\n"

            # Preprocess the command first (e.g., Ctrl+C, cls/clear)
            payload_to_write = self._preprocess_command(session, payload_to_write)

            # If preprocessing consumed the entire command (e.g., Ctrl+C was handled),
            # we still return success but don't send anything to stdin
            if not payload_to_write:
                logger.info(f"[TERMINAL] Preprocess consumed input for session {session_id}")
                return jsonify({"success": True})

            # Align line endings with underlying shell expectations AFTER preprocessing
            try:
                line_ending = session.line_ending or os.linesep
            except Exception:
                line_ending = os.linesep

            logger.debug(f"[TERMINAL] Normalizing input for session {session_id} with line_ending={repr(line_ending)}")
            if line_ending == "\r\n":
                normalized_payload = payload_to_write.replace("\r\n", "\n").replace("\r", "\n")
                payload_to_write = normalized_payload.replace("\n", "\r\n")
            else:
                payload_to_write = payload_to_write.replace("\r\n", "\n")

            # Send command to shell stdin / PTY
            try:
                if getattr(session, 'is_pty', False):
                    if os.name == 'nt' and session.winpty_proc is not None:
                        session.winpty_proc.write(payload_to_write)
                    elif session.master_fd is not None:
                        os.write(session.master_fd, payload_to_write.encode('utf-8', errors='ignore'))
                    else:
                        session.process.stdin.write(payload_to_write)
                        session.process.stdin.flush()
                else:
                    session.process.stdin.write(payload_to_write)
                    session.process.stdin.flush()
                session.last_activity = time.time()
                log_preview = payload_to_write.replace("\r", "\\r").replace("\n", "\\n")
                logger.info(f"[TERMINAL] Sent input to session {session_id}: {log_preview[:200]}")

                return jsonify({"success": True})
            except Exception as e:
                logger.error(f"[TERMINAL] Failed to send command: {e}")
                return jsonify({"success": False, "error": "Failed to send command"}), 500

        except Exception as err:
            logger.error(f"[TERMINAL] Send command failed: {err}")
            return jsonify({"success": False, "error": str(err)}), 500

    def get_output_route(self):
        """Get output from a terminal session (non-blocking poll)."""
        try:
            session_id = request.args.get("session_id")
            if not session_id:
                return jsonify({"success": False, "error": "session_id is required"}), 400

            session = self._get_session(session_id)
            if not session:
                return jsonify({"success": False, "error": "Session not found"}), 404

            # Collect all available output (non-blocking)
            output_lines = []
            try:
                while not session.output_queue.empty():
                    line = session.output_queue.get_nowait()
                    if line is None:  # End signal
                        break
                    output_lines.append(line)
            except queue.Empty:
                pass

            is_alive = self._session_running(session)

            return jsonify({
                "success": True,
                "output": "".join(output_lines),
                "is_alive": is_alive
            })

        except Exception as err:
            logger.error(f"[TERMINAL] Get output failed: {err}")
            return jsonify({"success": False, "error": str(err)}), 500

    def stream_output_route(self):
        """Stream output from a terminal session over Server-Sent Events."""
        try:
            session_id = request.args.get("session_id")
            if not session_id:
                return jsonify({"success": False, "error": "session_id is required"}), 400

            session = self._get_session(session_id)
            if not session:
                return jsonify({"success": False, "error": "Session not found"}), 404

            subscriber_id, subscriber_queue = self._register_stream_subscriber(session)

            def event_stream():
                try:
                    yield self._format_sse_event({
                        "type": "ready",
                        "session_id": session.session_id,
                        "workspace_path": session.workspace_path,
                        "is_alive": self._session_running(session),
                        "local_echo": session.local_echo,
                        "platform": session.platform,
                        "shell": session.shell,
                        "line_ending": session.line_ending,
                    })

                    while True:
                        try:
                            payload = subscriber_queue.get(timeout=1.0)
                        except queue.Empty:
                            if not self._session_running(session):
                                yield self._format_sse_event({
                                    "type": "terminated",
                                    "session_id": session.session_id,
                                    "is_alive": False
                                })
                                break
                            continue

                        if payload is None:
                            yield self._format_sse_event({
                                "type": "terminated",
                                "session_id": session.session_id,
                                "is_alive": False
                            })
                            break

                        payload_dict = dict(payload)
                        payload_dict.setdefault("type", "output")
                        payload_dict["session_id"] = session.session_id
                        yield self._format_sse_event(payload_dict)
                except GeneratorExit:
                    logger.info(f"[TERMINAL] Stream client disconnected for session {session_id}")
                    raise
                except Exception as err:
                    logger.error(f"[TERMINAL] Error during terminal stream for session {session_id}: {err}")
                    yield self._format_sse_event({
                        "type": "error",
                        "session_id": session.session_id,
                        "message": str(err)
                    })
                finally:
                    self._remove_stream_subscriber(session, subscriber_id)

            headers = {
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Content-Type": "text/event-stream",
                "X-Accel-Buffering": "no"
            }

            return Response(stream_with_context(event_stream()), headers=headers)
        except Exception as err:
            logger.error(f"[TERMINAL] Stream output failed: {err}")
            return jsonify({"success": False, "error": str(err)}), 500

    def kill_session_route(self):
        """Kill a terminal session."""
        try:
            data = request.get_json(force=True)
            session_id = data.get("session_id")

            if not session_id:
                return jsonify({"success": False, "error": "session_id is required"}), 400

            success = self._kill_session(session_id)

            return jsonify({"success": success})

        except Exception as err:
            logger.error(f"[TERMINAL] Kill session failed: {err}")
            return jsonify({"success": False, "error": str(err)}), 500

    def list_sessions_route(self):
        """List all active terminal sessions."""
        try:
            with self._session_lock:
                sessions = [
                    {
                        "session_id": sid,
                        "workspace_path": session.workspace_path,
                        "created_at": session.created_at,
                        "last_activity": session.last_activity,
                        "is_alive": self._session_running(session),
                        "local_echo": session.local_echo,
                        "platform": session.platform,
                        "shell": session.shell,
                        "line_ending": session.line_ending,
                    }
                    for sid, session in self._sessions.items()
                ]

            logger.info(f"[TERMINAL] List sessions: count={len(sessions)}")
            return jsonify({
                "success": True,
                "sessions": sessions
            })

        except Exception as err:
            logger.error(f"[TERMINAL] List sessions failed: {err}")
            return jsonify({"success": False, "error": str(err)}), 500

    def resize_session_route(self):
        """Resize a terminal session PTY to match client rows/cols."""
        try:
            data = request.get_json(force=True)
            session_id = data.get("session_id")
            rows = int(data.get("rows", 0))
            cols = int(data.get("cols", 0))

            if not session_id:
                return jsonify({"success": False, "error": "session_id is required"}), 400
            if rows <= 0 or cols <= 0:
                return jsonify({"success": False, "error": "rows and cols must be > 0"}), 400

            session = self._get_session(session_id)
            if not session:
                return jsonify({"success": False, "error": "Session not found"}), 404

            if not getattr(session, 'is_pty', False):
                return jsonify({"success": True, "note": "not a PTY session"})

            if os.name == 'nt' and session.winpty_proc is not None:
                try:
                    session.winpty_proc.set_size(rows, cols)
                    return jsonify({"success": True})
                except Exception as e:
                    logger.warn(f"[TERMINAL] Failed to resize Windows PTY: {e}")
                    return jsonify({"success": False, "error": str(e)}), 500
            else:
                try:
                    import fcntl, termios, struct
                    if session.master_fd is None:
                        return jsonify({"success": False, "error": "missing PTY master fd"}), 500
                    winsz = struct.pack('HHHH', rows, cols, 0, 0)
                    fcntl.ioctl(session.master_fd, termios.TIOCSWINSZ, winsz)
                    return jsonify({"success": True})
                except Exception as e:
                    logger.warn(f"[TERMINAL] Failed to resize Unix PTY: {e}")
                    return jsonify({"success": False, "error": str(e)}), 500
        except Exception as err:
            logger.error(f"[TERMINAL] Resize failed: {err}")
            return jsonify({"success": False, "error": str(err)}), 500


def register_terminal_routes(app: Flask) -> None:
    """Register the terminal routes with the Flask application."""
    TerminalRoute(app)
