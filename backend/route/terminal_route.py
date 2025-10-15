"""Routes for terminal command execution in workspace."""

from __future__ import annotations

import json
import os
import threading
import uuid
import time
import queue
from pathlib import Path
from typing import Dict, Any, Optional
from dataclasses import dataclass, field

from flask import Flask, jsonify, request, Response, stream_with_context

from utils.logger import get_logger
from utils.db_utils import db

logger = get_logger(__name__)


@dataclass
class TerminalSession:
    """Represents an active persistent terminal session with PTY."""
    session_id: str
    workspace_path: str
    winpty_proc: Optional[Any] = None
    output_queue: queue.Queue = field(default_factory=queue.Queue)
    output_thread: Optional[threading.Thread] = None
    created_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.time)
    is_alive: bool = True
    subscribers: Dict[str, queue.Queue] = field(default_factory=dict)
    subscribers_lock: threading.Lock = field(default_factory=threading.Lock)


class TerminalRoute:
    """Route handler for persistent terminal sessions."""

    _PTY_READ_SIZE = 256  
    _OUTPUT_FLUSH_INTERVAL = 0.05 
    _OUTPUT_MAX_BUFFER = 512  

    _VENV_NAMES = ['venv', '.venv', 'env', 'virtualenv', '.virtualenv']

    def __init__(self, app: Flask):
        self.app = app
        self._sessions: Dict[str, TerminalSession] = {}
        self._session_lock = threading.Lock()
        self._register_routes()

    @staticmethod
    def _session_running(session: 'TerminalSession') -> bool:
        """Check if PTY session is alive."""
        return session.is_alive

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
        """Remove a stream subscriber from the session."""
        with session.subscribers_lock:
            session.subscribers.pop(subscriber_id, None)
        logger.info(f"[TERMINAL] Removed stream subscriber {subscriber_id} for session {session.session_id}")

    def _broadcast_to_subscribers(self, session: TerminalSession, payload: Optional[Dict[str, Any]]) -> None:
        """Broadcast a payload to all active subscribers for the session."""
        with session.subscribers_lock:
            for subscriber_queue in session.subscribers.values():
                try:
                    subscriber_queue.put_nowait(payload.copy() if payload is not None else None)
                except Exception as exc:
                    logger.warning(f"[TERMINAL] Failed to publish output to subscriber for session {session.session_id}: {exc}")

    def _create_shell_process(self, workspace_path: Path) -> TerminalSession:
        """Create a persistent PTY-based shell session."""
        try:
            from winpty import PtyProcess
        except ImportError:
            raise RuntimeError("pywinpty is required. Install with: pip install pywinpty")

        venv_path = self._detect_venv(workspace_path)
        startup_commands = []

        if venv_path:
            activation_cmd = self._get_venv_activation_command(venv_path)
            startup_commands.append(activation_cmd)
            logger.info(f"[TERMINAL] Will auto-activate venv: {venv_path}")

        env = os.environ.copy()
        env_vars = self._load_env_file(workspace_path)
        env.update(env_vars)
        env['TERM'] = 'xterm-256color'

        winpty_proc = PtyProcess.spawn('cmd.exe', cwd=str(workspace_path), env=env)

        try:
            winpty_proc.write('chcp 65001 > NUL\r\n')
        except Exception as e:
            logger.warning(f"[TERMINAL] Failed to set UTF-8 encoding: {e}")

        for cmd in startup_commands:
            try:
                winpty_proc.write(cmd + '\r\n')
            except Exception as e:
                logger.warning(f"[TERMINAL] Failed to execute startup command '{cmd}': {e}")

        session = TerminalSession(
            session_id='',
            workspace_path=str(workspace_path),
            winpty_proc=winpty_proc,
        )
        logger.info("[TERMINAL] Created PTY session using pywinpty")
        return session

    def _output_reader_thread(self, session: TerminalSession):
        """Background thread to read output from PTY."""
        try:
            logger.info(f"[TERMINAL] Output reader started for session {session.session_id}")
            buffer: list[str] = []
            last_flush = time.time()
            flush_interval = self._OUTPUT_FLUSH_INTERVAL
            max_buffer = self._OUTPUT_MAX_BUFFER

            while self._session_running(session):
                try:
                    data = session.winpty_proc.read(self._PTY_READ_SIZE)
                    if isinstance(data, (bytes, bytearray)):
                        ch = data.decode('utf-8', errors='ignore')
                    else:
                        ch = str(data)
                except Exception:
                    ch = ''

                if ch:
                    buffer.append(ch)
                    now = time.time()

                    has_newline = '\n' in ch or '\r' in ch
                    buffer_full = len(''.join(buffer)) >= max_buffer
                    time_to_flush = (now - last_flush) >= flush_interval

                    if has_newline or buffer_full or time_to_flush:
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

            if buffer:
                chunk = ''.join(buffer)
                session.output_queue.put(chunk)
                self._broadcast_to_subscribers(session, {"type": "output", "data": chunk})
        except Exception as e:
            logger.error(f"[TERMINAL] Output reader error: {e}")
        finally:
            logger.info(f"[TERMINAL] Output reader stopping for session {session.session_id}")
            session.is_alive = False
            session.output_queue.put(None)
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
        """Create a new persistent PTY terminal session."""
        session_id = str(uuid.uuid4())

        session = self._create_shell_process(Path(workspace_path))
        session.session_id = session_id
        session.workspace_path = workspace_path

        output_thread = threading.Thread(
            target=self._output_reader_thread,
            args=(session,),
            daemon=True
        )
        output_thread.start()
        session.output_thread = output_thread

        with self._session_lock:
            self._sessions[session_id] = session

        logger.info(f"[TERMINAL] Created PTY session {session_id} for {workspace_path}")
        return session

    def _get_session(self, session_id: str) -> Optional[TerminalSession]:
        """Get existing session by ID."""
        with self._session_lock:
            return self._sessions.get(session_id)

    def _kill_session(self, session_id: str) -> bool:
        """Kill a PTY terminal session and its shell process."""
        with self._session_lock:
            session = self._sessions.get(session_id)
            if not session:
                return False

            session.is_alive = False

            try:
                if session.winpty_proc is not None:
                    try:
                        session.winpty_proc.terminate(True)
                    except Exception as e:
                        logger.debug(f"[TERMINAL] PTY terminate failed, trying close: {e}")
                        try:
                            session.winpty_proc.close(True)
                        except Exception as e2:
                            logger.warning(f"[TERMINAL] PTY close also failed: {e2}")
                logger.info(f"[TERMINAL] Killed PTY session {session_id}")
            except Exception as e:
                logger.warning(f"[TERMINAL] Error killing session {session_id}: {e}")

            self._broadcast_to_subscribers(session, {"type": "terminated"})
            self._broadcast_to_subscribers(session, None)

            del self._sessions[session_id]
            return True

    def _detect_venv(self, workspace_path: Path) -> Optional[Path]:
        """Detect Python virtual environment in workspace."""
        for venv_name in self._VENV_NAMES:
            venv_path = workspace_path / venv_name
            if venv_path.exists() and venv_path.is_dir():
                activate_script = venv_path / 'Scripts' / 'activate.bat'
                if activate_script.exists():
                    logger.info(f"[TERMINAL] Detected venv at: {venv_path}")
                    return venv_path

        return None

    def _get_venv_activation_command(self, venv_path: Path) -> str:
        """Get the command to activate a virtual environment."""
        activate_script = venv_path / 'Scripts' / 'activate.bat'
        return f'call "{activate_script}"'

    def _load_env_file(self, workspace_path: Path) -> Dict[str, str]:
        """Load environment variables from .env file if it exists."""
        env_vars = {}
        env_file = workspace_path / '.env'

        if env_file.exists() and env_file.is_file():
            try:
                with open(env_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith('#') and '=' in line:
                            key, value = line.split('=', 1)
                            value = value.strip().strip('"').strip("'")
                            env_vars[key.strip()] = value
                logger.info(f"[TERMINAL] Loaded {len(env_vars)} environment variables from .env")
            except Exception as e:
                logger.warning(f"[TERMINAL] Failed to load .env file: {e}")

        return env_vars

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

            logger.info(f"[TERMINAL] Create session requested for chat_id={chat_id}, workspace={workspace_path}")
            session = self._create_new_session(str(workspace_path))

            return jsonify({
                "success": True,
                "session_id": session.session_id,
                "workspace_path": session.workspace_path,
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

            dangerous_patterns = ['rm -rf /', 'dd if=', 'mkfs', 'format c:', ':(){:|:&};:']
            lower_payload = raw_payload.lower()
            for pattern in dangerous_patterns:
                if pattern in lower_payload:
                    logger.warning(f"[TERMINAL] Blocked potentially dangerous command for session {session_id}: {raw_payload[:100]}")
                    return jsonify({"success": False, "error": "Command contains potentially dangerous operations"}), 400

            payload_to_write = raw_payload
            if payload_key == "command" and not raw_payload.endswith("\n") and not raw_payload.endswith("\r"):
                payload_to_write = f"{raw_payload}\n"

            normalized_payload = payload_to_write.replace("\r\n", "\n").replace("\r", "\n")
            payload_to_write = normalized_payload.replace("\n", "\r\n")

            try:
                session.winpty_proc.write(payload_to_write)
                session.last_activity = time.time()
                log_preview = payload_to_write.replace("\r", "\\r").replace("\n", "\\n")
                logger.info(f"[TERMINAL] Sent input to PTY session {session_id}: {log_preview[:200]}")
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

            output_lines = []
            try:
                while not session.output_queue.empty():
                    line = session.output_queue.get_nowait()
                    if line is None: 
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
        """Resize a PTY terminal session to match client rows/cols."""
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

            try:
                session.winpty_proc.setwinsize(rows, cols)
                return jsonify({"success": True})
            except Exception as e:
                logger.warning(f"[TERMINAL] Failed to resize PTY: {e}")
                return jsonify({"success": False, "error": str(e)}), 500
        except Exception as err:
            logger.error(f"[TERMINAL] Resize failed: {err}")
            return jsonify({"success": False, "error": str(err)}), 500


def register_terminal_routes(app: Flask) -> None:
    """Register the terminal routes with the Flask application."""
    TerminalRoute(app)
