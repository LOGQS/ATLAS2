# status: complete

"""
Multiprocessing upload worker infrastructure with persistent worker reuse.
This reduces the number of new Python interpreter spawns which avoids repeated
antivirus scans on Windows while preserving true process-based cancellation.
"""

import atexit
import multiprocessing
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional


if hasattr(multiprocessing, "set_start_method"):
    try:
        multiprocessing.set_start_method("spawn", force=True)
    except RuntimeError:
        pass


class UploadWorkerTimeout(Exception):
    """Raised when an upload worker does not finish within the expected timeout."""


class UploadWorkerCancelled(Exception):
    """Raised when an upload is cancelled while waiting for completion."""


class UploadWorkerTerminated(Exception):
    """Raised when the worker process exited before returning a result."""


@dataclass
class _WorkerInfo:
    """Internal structure for tracking worker state."""

    process: multiprocessing.Process
    conn: Any
    current_handle: Optional["UploadTaskHandle"] = None


class UploadTaskHandle:
    """Handle for interacting with a persistent upload worker."""

    def __init__(self, pool: "UploadProcessPool", worker_id: str, file_id: str):
        self._pool = pool
        self.worker_id = worker_id
        self.file_id = file_id
        self._result: Optional[Dict[str, Any]] = None
        self._terminated = False

    @property
    def process(self) -> Optional[multiprocessing.Process]:
        worker = self._pool._get_worker(self.worker_id)
        return worker.process if worker else None

    def is_alive(self) -> bool:
        process = self.process
        return bool(process and process.is_alive())

    def poll(self, timeout: float = 0.0) -> bool:
        if self._result is not None:
            return True
        return self._pool._poll(self, timeout)

    def recv(self) -> Dict[str, Any]:
        if self._result is not None:
            return self._result
        result = self._pool._recv(self)
        self._result = result
        return result

    def result(
        self,
        timeout: Optional[float] = None,
        *,
        poll_interval: float = 0.1,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> Dict[str, Any]:
        if self._result is not None:
            return self._result
        result = self._pool._wait_for_result(
            self,
            timeout=timeout,
            poll_interval=poll_interval,
            cancel_check=cancel_check,
        )
        self._result = result
        return result

    def terminate(self) -> None:
        if self._terminated:
            return
        self._pool._terminate_handle(self)
        self._terminated = True


class UploadProcessPool:
    """Pool that reuses persistent upload worker processes."""

    def __init__(self, max_workers: Optional[int] = None):
        self._ctx = multiprocessing.get_context("spawn")
        cpu_count = max(1, multiprocessing.cpu_count())
        self._max_workers = max_workers or min(max(2, cpu_count), 8)
        self._workers: Dict[str, _WorkerInfo] = {}
        self._idle_workers: list[str] = []
        self._active_handles: Dict[str, UploadTaskHandle] = {}
        self._counter = 0
        self._lock = threading.Lock()
        self._available = threading.Condition(self._lock)
        self._shutdown = False

    def submit(self, file_path: str, display_name: Optional[str], file_id: str) -> UploadTaskHandle:
        with self._available:
            if self._shutdown:
                raise RuntimeError("UploadProcessPool has been shut down")

            worker_id = self._acquire_worker_locked()
            worker = self._workers[worker_id]

            handle = UploadTaskHandle(self, worker_id, file_id)
            worker.current_handle = handle
            self._active_handles[file_id] = handle

            message = {
                "command": "upload",
                "file_path": file_path,
                "display_name": display_name,
                "file_id": file_id,
            }
            conn = worker.conn

        try:
            conn.send(message)
        except (BrokenPipeError, EOFError, OSError) as exc:
            with self._available:
                if file_id in self._active_handles:
                    del self._active_handles[file_id]
                self._close_worker_locked(worker_id, terminate=False)
            raise UploadWorkerTerminated("Failed to dispatch upload task") from exc

        return handle

    def shutdown(self) -> None:
        with self._available:
            if self._shutdown:
                return
            self._shutdown = True

            for worker_id, worker in list(self._workers.items()):
                try:
                    worker.conn.send({"command": "shutdown"})
                except (BrokenPipeError, EOFError, OSError):
                    pass

            for worker_id in list(self._workers.keys()):
                self._close_worker_locked(worker_id, terminate=False)

    def _acquire_worker_locked(self) -> str:
        while True:
            self._cleanup_dead_workers_locked()

            if self._idle_workers:
                worker_id = self._idle_workers.pop(0)
                return worker_id

            if len(self._workers) < self._max_workers:
                return self._spawn_worker_locked()

            self._available.wait()

    def _spawn_worker_locked(self) -> str:
        parent_conn, child_conn = self._ctx.Pipe()
        process = self._ctx.Process(target=_persistent_upload_worker, args=(child_conn,), daemon=True)
        process.start()
        child_conn.close()

        worker_id = f"worker-{self._counter}".strip()
        self._counter += 1
        self._workers[worker_id] = _WorkerInfo(process=process, conn=parent_conn)
        return worker_id

    def _cleanup_dead_workers_locked(self) -> None:
        dead_ids = [worker_id for worker_id, worker in self._workers.items() if not worker.process.is_alive()]
        for worker_id in dead_ids:
            self._close_worker_locked(worker_id, terminate=False)

    def _close_worker_locked(self, worker_id: str, *, terminate: bool = True) -> None:
        worker = self._workers.pop(worker_id, None)
        if not worker:
            return

        if worker_id in self._idle_workers:
            self._idle_workers.remove(worker_id)

        handle = worker.current_handle
        if handle and handle.file_id in self._active_handles:
            del self._active_handles[handle.file_id]

        if terminate and worker.process.is_alive():
            worker.process.terminate()
            worker.process.join(timeout=1)
            if worker.process.is_alive():
                try:
                    worker.process.kill()
                except AttributeError:
                    pass

        try:
            worker.conn.close()
        except Exception:
            pass

        self._available.notify_all()

    def _release_worker(self, handle: UploadTaskHandle) -> None:
        with self._available:
            worker = self._workers.get(handle.worker_id)
            if not worker:
                return

            if not worker.process.is_alive():
                self._close_worker_locked(handle.worker_id, terminate=False)
                return

            worker.current_handle = None
            if handle.file_id in self._active_handles:
                del self._active_handles[handle.file_id]

            if handle.worker_id in self._idle_workers:
                # Already marked idle due to previous cleanup
                self._available.notify_all()
                return

            self._idle_workers.append(handle.worker_id)
            self._available.notify()

    def _terminate_handle(self, handle: UploadTaskHandle) -> None:
        with self._available:
            worker = self._workers.get(handle.worker_id)
            if not worker:
                return
            if worker.process.is_alive():
                worker.process.terminate()
                worker.process.join(timeout=1)
                if worker.process.is_alive():
                    try:
                        worker.process.kill()
                    except AttributeError:
                        pass
            self._close_worker_locked(handle.worker_id, terminate=False)

    def _get_worker(self, worker_id: str) -> Optional[_WorkerInfo]:
        with self._lock:
            return self._workers.get(worker_id)

    def _poll(self, handle: UploadTaskHandle, timeout: float) -> bool:
        worker = self._get_worker(handle.worker_id)
        if not worker:
            return False
        if handle._result is not None:
            return True
        try:
            return worker.conn.poll(timeout)
        except (BrokenPipeError, EOFError, OSError):
            self._handle_worker_failure(handle)
            raise UploadWorkerTerminated("Upload worker connection closed")

    def _recv(self, handle: UploadTaskHandle) -> Dict[str, Any]:
        worker = self._get_worker(handle.worker_id)
        if not worker:
            raise UploadWorkerTerminated("Upload worker exited before sending a result")

        try:
            message = worker.conn.recv()
        except (EOFError, BrokenPipeError, OSError) as exc:
            self._handle_worker_failure(handle)
            raise UploadWorkerTerminated("Upload worker exited unexpectedly") from exc

        if isinstance(message, dict) and "result" in message:
            result = message["result"]
        else:
            result = message

        self._release_worker(handle)
        return result

    def _wait_for_result(
        self,
        handle: UploadTaskHandle,
        *,
        timeout: Optional[float],
        poll_interval: float,
        cancel_check: Optional[Callable[[], bool]],
    ) -> Dict[str, Any]:
        start_time = time.time()

        while True:
            remaining = None
            if timeout is not None:
                elapsed = time.time() - start_time
                remaining = timeout - elapsed
                if remaining <= 0:
                    raise UploadWorkerTimeout(
                        f"Upload worker timed out after {timeout} seconds"
                    )

            wait_time = poll_interval if remaining is None else min(poll_interval, remaining)

            try:
                if self._poll(handle, wait_time):
                    return self._recv(handle)
            except UploadWorkerTerminated:
                raise

            if cancel_check and cancel_check():
                raise UploadWorkerCancelled("Upload was cancelled")

            worker = self._get_worker(handle.worker_id)
            if worker is None or not worker.process.is_alive():
                self._handle_worker_failure(handle)
                raise UploadWorkerTerminated("Upload worker exited before completion")

    def _handle_worker_failure(self, handle: UploadTaskHandle) -> None:
        with self._available:
            if handle.file_id in self._active_handles:
                del self._active_handles[handle.file_id]
            self._close_worker_locked(handle.worker_id, terminate=False)


def _persistent_upload_worker(child_conn):
    """Worker loop that processes upload commands sequentially."""
    try:
        backend_dir = Path(__file__).parent.parent
        if str(backend_dir) not in sys.path:
            sys.path.insert(0, str(backend_dir))

        from utils.config import Config, get_provider_map
        from utils.logger import get_logger
        from utils.rate_limiter import get_rate_limiter

        worker_logger = get_logger(__name__)
        provider = None
        limiter = None

        try:
            provider_map = get_provider_map()
            default_provider = Config.get_default_provider()
            provider = provider_map.get(default_provider)

            if provider and provider.is_available():
                limiter = get_rate_limiter(
                    Config.get_rate_limit_requests_per_minute(),
                    Config.get_rate_limit_burst_size(),
                )
                worker_logger.info(
                    f"[WORKER] Initialized upload worker for provider {default_provider}"
                )
            else:
                worker_logger.error(
                    f"[WORKER] Default provider {default_provider} unavailable"
                )
                provider = None
        except Exception as init_error:
            worker_logger.error(
                f"[WORKER] Failed to initialize provider context: {init_error}"
            )
            provider = None

        while True:
            try:
                command = child_conn.recv()
            except EOFError:
                break

            if not isinstance(command, dict):
                continue

            action = command.get("command")

            if action == "shutdown":
                break

            if action != "upload":
                continue

            file_path = command.get("file_path")
            display_name = command.get("display_name")
            file_id = command.get("file_id")

            result: Dict[str, Any]
            if not provider or not provider.is_available():
                result = {
                    "success": False,
                    "error": "Provider not available",
                    "state": "error",
                    "file_id": file_id,
                }
            else:
                result = _execute_upload_task(
                    provider=provider,
                    limiter=limiter,
                    file_path=file_path,
                    display_name=display_name,
                    file_id=file_id,
                    logger=worker_logger,
                )

            try:
                child_conn.send({"type": "result", "file_id": file_id, "result": result})
            except (BrokenPipeError, EOFError, OSError):
                break

    finally:
        try:
            child_conn.close()
        except Exception:
            pass


def _execute_upload_task(
    *,
    provider,
    limiter,
    file_path: str,
    display_name: Optional[str],
    file_id: str,
    logger,
) -> Dict[str, Any]:
    """Execute the actual upload operation inside the worker."""
    try:
        file_path_obj = Path(file_path)
        if not file_path_obj.exists():
            return {
                "success": False,
                "error": "File does not exist",
                "state": "error",
                "file_id": file_id,
            }

        file_size = file_path_obj.stat().st_size
        size_limit = getattr(provider, "FILE_SIZE_LIMIT", None)
        if size_limit and file_size > size_limit:
            return {
                "success": False,
                "error": f"File size {file_size} exceeds limit of {size_limit} bytes",
                "state": "error",
                "file_id": file_id,
            }

        upload_kwargs = {"file": str(file_path)}
        if file_path_obj.suffix.lower() == ".md":
            upload_kwargs["config"] = {"mime_type": "text/markdown"}

        logger.info(f"[WORKER] Executing upload for file {file_id}")

        if limiter is not None:
            uploaded_file = limiter.execute(
                provider.client.files.upload,
                "gemini:upload",
                **upload_kwargs,
            )
        else:
            uploaded_file = provider.client.files.upload(**upload_kwargs)

        logger.info(f"[WORKER] Upload completed for file {file_id}: {uploaded_file.name}")

        state_value = getattr(uploaded_file, "state", None)
        if hasattr(state_value, "name"):
            state_value = state_value.name.lower()
        elif isinstance(state_value, str):
            state_value = state_value.lower()
        else:
            state_value = "uploaded"

        return {
            "success": True,
            "api_file_name": uploaded_file.name,
            "display_name": display_name or file_path_obj.name,
            "state": state_value,
            "file_id": file_id,
        }

    except KeyboardInterrupt:
        logger.info(f"[WORKER] Upload process interrupted for file {file_id}")
        return {
            "success": False,
            "error": "Upload process terminated",
            "state": "error",
            "file_id": file_id,
        }

    except Exception as exc:
        logger.error(f"[WORKER] Upload failed for file {file_id}: {exc}")
        return {
            "success": False,
            "error": str(exc),
            "state": "error",
            "file_id": file_id,
        }


_upload_pool = UploadProcessPool()


def start_upload_process(file_path: str, display_name: Optional[str], file_id: str) -> UploadTaskHandle:
    """Submit an upload job to the persistent worker pool."""
    return _upload_pool.submit(file_path, display_name, file_id)


def shutdown_upload_pool() -> None:
    """Shutdown the global upload pool, used during interpreter exit."""
    _upload_pool.shutdown()


atexit.register(shutdown_upload_pool)
