# status: added

import pytest

from .perf_utils import (
    measure_direct_worker_startup,
    worker_pool_with_metrics,
)


@pytest.mark.integration
@pytest.mark.slow
def test_worker_pool_initial_spawn_time_records_metrics():
    """
    Measure the time required for the worker pool to produce its first ready worker.
    """
    with worker_pool_with_metrics(pool_size=1, max_parallel_spawn=1) as (pool, worker, elapsed):
        assert elapsed >= 0
        assert worker.startup_seconds >= 0

        # elapsed accounts for queue retrieval overhead; it should never be less than the worker's own timing.
        # Allow 1s tolerance for timing measurement jitter
        assert elapsed >= worker.startup_seconds - 1.0

        stats = pool.get_stats()
        assert stats["target_size"] == 1


@pytest.mark.integration
@pytest.mark.slow
def test_direct_worker_startup_time_is_measurable():
    """
    Spawn a standalone worker process and confirm we can capture its initialization duration.
    """
    elapsed, success = measure_direct_worker_startup()

    assert success, "chat worker failed to initialize; check provider/database prerequisites"
    assert elapsed >= 0

    # Provide a sanity bound so failures are obvious without being overly strict.
    # Windows cold starts often land between 2-7 seconds; allow generous buffer for CI variability.
    assert elapsed < 30, f"Worker initialization took unusually long: {elapsed:.2f}s"
