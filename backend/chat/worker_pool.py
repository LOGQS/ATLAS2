# status: complete

"""
Worker Pool Manager for Chat Processes

Pre-spawns a pool of chat workers to eliminate spawn latency while maintaining
true cancellation capability. Workers are spawned in parallel and replaced
immediately upon consumption.
"""

import multiprocessing
import threading
import queue
import time
import uuid
from typing import Optional, Tuple, Any
from dataclasses import dataclass
from pathlib import Path
import sys

backend_dir = Path(__file__).parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from utils.logger import get_logger
from utils.config import Config

logger = get_logger(__name__)  


@dataclass
class PooledWorker:
    """Represents a pre-spawned worker ready for use"""
    process: multiprocessing.Process
    conn: Any
    spawned_at: float
    worker_id: str


class WorkerPool:
    """
    Manages a pool of pre-spawned chat workers.

    Workers are spawned in parallel during initialization and replaced
    immediately when consumed to maintain zero-latency availability.
    """

    def __init__(self, pool_size: Optional[int] = None,
                 max_parallel_spawn: Optional[int] = None):
        """
        Initialize the worker pool.

        Args:
            pool_size: Target number of ready workers to maintain
            max_parallel_spawn: Maximum workers to spawn simultaneously
        """
        self.pool_size = pool_size or Config.get_worker_pool_size()
        self.max_parallel_spawn = max_parallel_spawn or Config.get_worker_max_parallel_spawn()

        self._ready_workers = queue.Queue()

        self._spawning_count = 0
        self._spawning_lock = threading.Lock()

        self._total_workers = 0
        self._total_lock = threading.Lock()

        self._shutdown = False
        self._worker_counter = 0

        self._populate_pool()

        logger.info(f"WorkerPool initialized with target size {pool_size}")

    def _get_worker_id(self) -> str:
        """Generate unique worker ID"""
        self._worker_counter += 1
        return f"pool_worker_{self._worker_counter}"

    def _spawn_worker_sync(self) -> Optional[PooledWorker]:
        """Spawn a single worker synchronously"""
        if self._shutdown:
            return None

        worker_id = self._get_worker_id()

        try:
            from chat.chat_worker import start_chat_process

            placeholder_chat_id = f"__pool_internal_{uuid.uuid4().hex[:8]}"

            logger.debug(f"Spawning worker {worker_id}")
            process, conn = start_chat_process(placeholder_chat_id)

            if conn.poll(Config.get_worker_init_timeout()):
                response = conn.recv()
                if response.get('success'):
                    worker = PooledWorker(
                        process=process,
                        conn=conn,
                        spawned_at=time.time(),
                        worker_id=worker_id
                    )
                    logger.info(f"Successfully spawned worker {worker_id}")
                    return worker
                else:
                    logger.error(f"Worker {worker_id} initialization failed: {response.get('error')}")
                    process.terminate()
            else:
                logger.error(f"Worker {worker_id} initialization timeout")
                process.terminate()

        except Exception as e:
            logger.error(f"Failed to spawn worker {worker_id}: {e}")

        return None

    def _spawn_workers_parallel(self, count: int) -> None:
        """Spawn multiple workers in parallel"""
        if self._shutdown or count <= 0:
            return

        spawn_count = min(count, self.max_parallel_spawn)

        with self._spawning_lock:
            self._spawning_count += spawn_count

        with self._total_lock:
            self._total_workers += spawn_count

        def spawn_and_queue():
            """Thread target for spawning a worker"""
            try:
                worker = self._spawn_worker_sync()
                if worker:
                    self._ready_workers.put(worker)
                else:
                    with self._total_lock:
                        self._total_workers -= 1
            finally:
                with self._spawning_lock:
                    self._spawning_count -= 1

        threads = []
        for _ in range(spawn_count):
            thread = threading.Thread(target=spawn_and_queue, daemon=True)
            thread.start()
            threads.append(thread)

        logger.info(f"Started {spawn_count} parallel worker spawn threads")

    def _populate_pool(self) -> None:
        """Populate the pool to target size"""
        current_ready = self._ready_workers.qsize()

        with self._spawning_lock:
            current_spawning = self._spawning_count

        needed = self.pool_size - current_ready - current_spawning

        if needed > 0:
            logger.info(f"Populating pool: need {needed} workers (ready={current_ready}, spawning={current_spawning})")
            self._spawn_workers_parallel(needed)

    def _lazy_maintenance(self) -> None:
        """Perform lazy maintenance when needed (no polling)"""
        try:
            self._cleanup_dead_workers()
            self._populate_pool()
        except Exception as e:
            logger.error(f"Pool maintenance error: {e}")

    def _cleanup_dead_workers(self) -> None:
        """Remove dead workers from ready queue"""
        cleaned = []
        dead_count = 0

        while not self._ready_workers.empty():
            try:
                worker = self._ready_workers.get_nowait()
                if worker.process.is_alive():
                    cleaned.append(worker)
                else:
                    dead_count += 1
                    with self._total_lock:
                        self._total_workers -= 1
                    logger.warning(f"Removed dead worker {worker.worker_id}")
            except queue.Empty:
                break

        for worker in cleaned:
            self._ready_workers.put(worker)

        if dead_count > 0:
            logger.info(f"Cleaned up {dead_count} dead workers")

    def get_worker(self, chat_id: str) -> Optional[Tuple[multiprocessing.Process, Any]]:
        """
        Get a worker from the pool for immediate use.

        Args:
            chat_id: The chat ID that will use this worker

        Returns:
            Tuple of (process, connection) or None if unavailable
        """
        self._lazy_maintenance()

        stats_before = self.get_stats()
        logger.info(f"[POOL-GET] Request for chat {chat_id} - Pool state: ready={stats_before['ready_workers']}, spawning={stats_before['spawning_workers']}, total={stats_before['total_workers']}")

        worker = None

        try:
            worker = self._ready_workers.get_nowait()
            age_seconds = time.time() - worker.spawned_at
            logger.info(f"[POOL-GET] SUCCESS - Retrieved worker {worker.worker_id} (age={age_seconds:.1f}s) for chat {chat_id}")
        except queue.Empty:
            if self._ready_workers.qsize() == 0 and self._spawning_count == 0:
                logger.warning(f"[POOL-GET] EMPTY - No workers available for {chat_id}, attempting emergency spawn")
                worker = self._spawn_worker_sync()
                if not worker:
                    logger.error(f"[POOL-GET] FAILED - Emergency spawn failed for {chat_id}")
                    return None
                else:
                    logger.info(f"[POOL-GET] EMERGENCY - Successfully spawned emergency worker {worker.worker_id} for {chat_id}")
            else:
                logger.warning(f"[POOL-GET] WAITING - No ready workers for {chat_id}, {self._spawning_count} workers currently spawning")
                return None

        with self._total_lock:
            self._total_workers -= 1

        threading.Thread(
            target=self._spawn_replacement,
            daemon=True
        ).start()

        stats_after = self.get_stats()
        logger.info(f"[POOL-GET] After retrieval for {chat_id} - Pool state: ready={stats_after['ready_workers']}, spawning={stats_after['spawning_workers']}, total={stats_after['total_workers']}")

        return (worker.process, worker.conn)

    def _spawn_replacement(self) -> None:
        """Spawn a replacement worker in background"""
        logger.info("[POOL-REPLACE] Starting replacement worker spawn")
        self._spawn_workers_parallel(1)
        logger.debug("[POOL-REPLACE] Replacement spawn initiated")

    def shutdown(self) -> None:
        """Shutdown the pool and terminate all workers"""
        logger.info("Shutting down worker pool")
        self._shutdown = True

        terminated = 0
        while not self._ready_workers.empty():
            try:
                worker = self._ready_workers.get_nowait()
                worker.process.terminate()
                worker.process.join(timeout=1.0)
                if worker.process.is_alive():
                    worker.process.kill()
                terminated += 1
            except queue.Empty:
                break

        logger.info(f"Terminated {terminated} pooled workers")

    def get_stats(self) -> dict:
        """Get pool statistics"""
        return {
            'ready_workers': self._ready_workers.qsize(),
            'spawning_workers': self._spawning_count,
            'total_workers': self._total_workers,
            'target_size': self.pool_size
        }


_worker_pool: Optional[WorkerPool] = None
_pool_lock = threading.Lock()


def initialize_pool(pool_size: Optional[int] = None) -> WorkerPool:
    """
    Initialize the global worker pool.

    Args:
        pool_size: Target pool size (defaults to MAX_CONCURRENT_STREAMS + 1)

    Returns:
        The initialized WorkerPool instance
    """
    global _worker_pool

    with _pool_lock:
        if _worker_pool is None:
            if pool_size is None:
                pool_size = Config.get_worker_pool_size()

            _worker_pool = WorkerPool(pool_size=pool_size)
            logger.info(f"Initialized global worker pool with size {pool_size}")

        return _worker_pool


def get_pool() -> Optional[WorkerPool]:
    """Get the global worker pool instance"""
    return _worker_pool


def get_pooled_worker(chat_id: str) -> Optional[Tuple[multiprocessing.Process, Any]]:
    """
    Get a worker from the global pool.

    Args:
        chat_id: The chat ID that will use this worker

    Returns:
        Tuple of (process, connection) or None if pool not initialized
    """
    pool = get_pool()
    if pool:
        return pool.get_worker(chat_id)
    return None


def shutdown_pool() -> None:
    """Shutdown the global worker pool"""
    global _worker_pool

    with _pool_lock:
        if _worker_pool:
            _worker_pool.shutdown()
            _worker_pool = None
            logger.info("Global worker pool shut down")