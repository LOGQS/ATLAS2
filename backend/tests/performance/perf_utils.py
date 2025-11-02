# status: added

"""
Performance measurement helpers for worker startup behavior.

These utilities allow tests to gather timing metrics for multiprocessing
worker initialization without leaving orphaned processes around.
"""

import contextlib
import time
import uuid
from typing import Generator, Optional, Tuple

from chat.chat_worker import start_chat_process
from chat.worker_pool import PooledWorker, WorkerPool
from utils import startup_cache



@contextlib.contextmanager
def worker_pool_with_metrics(
    pool_size: int = 1,
    max_parallel_spawn: Optional[int] = None,
    wait_timeout: float = 60.0,
) -> Generator[Tuple[WorkerPool, PooledWorker, float], None, None]:
    """
    Context manager that yields a worker pool along with the measured time
    needed to make the first pooled worker ready.
    """
    start = time.perf_counter()
    pool = WorkerPool(pool_size=pool_size, max_parallel_spawn=max_parallel_spawn)

    worker: Optional[PooledWorker] = None
    try:
        worker = pool._ready_workers.get(timeout=wait_timeout)  # type: ignore[attr-defined]
        elapsed = time.perf_counter() - start
        yield pool, worker, elapsed
    finally:
        if worker is not None:
            pool._ready_workers.put(worker)  # type: ignore[attr-defined]
        pool.shutdown()


def measure_direct_worker_startup(timeout: float = 40.0) -> Tuple[float, bool]:
    """
    Spawn a chat worker directly and measure how long initialization takes.

    Returns:
        A tuple of (elapsed_seconds, success_flag).
    """
    chat_id = f"perf_{uuid.uuid4().hex[:10]}"
    start = time.perf_counter()
    process, conn = start_chat_process(chat_id)

    try:
        deadline = start + timeout
        while True:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                return time.perf_counter() - start, False

            if not conn.poll(max(remaining, 0.0)):
                return time.perf_counter() - start, False

            response = conn.recv()
            if startup_cache.handle_parent_message(conn, response):
                continue

            elapsed = time.perf_counter() - start
            success = bool(response.get("success")) if isinstance(response, dict) else False
            return elapsed, success
    finally:
        try:
            if conn:
                try:
                    conn.send({"command": "stop", "chat_id": chat_id})
                    if conn.poll(5.0):
                        try:
                            conn.recv()
                        except EOFError:
                            pass
                finally:
                    conn.close()
        except (BrokenPipeError, OSError):
            pass

        process.join(timeout=5.0)
        if process.is_alive():
            process.terminate()
            process.join(timeout=5.0)
