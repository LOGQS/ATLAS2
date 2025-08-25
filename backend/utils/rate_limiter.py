import time
import threading
from collections import deque
from typing import Dict, Optional, Callable, Any
from utils.logger import get_logger

logger = get_logger(__name__)

class RateLimiter:
    """
    Scalable rate limiter for any model call. Tracks globally, queues/delays requests.
    """
    
    def __init__(self, requests_per_minute: int = 60, burst_size: int = 10):
        self.requests_per_minute = requests_per_minute
        self.burst_size = burst_size
        self.trackers: Dict[str, deque] = {}
        self.locks: Dict[str, threading.RLock] = {}
        self.main_lock = threading.RLock()
    
    def _get_tracker(self, key: str) -> tuple[deque, threading.RLock]:
        """Get or create tracker and lock for key"""
        with self.main_lock:
            if key not in self.trackers:
                self.trackers[key] = deque()
                self.locks[key] = threading.RLock()
            return self.trackers[key], self.locks[key]
    
    def _cleanup_old(self, tracker: deque, current_time: float):
        """Remove requests older than 1 minute"""
        cutoff = current_time - 60.0
        while tracker and tracker[0] < cutoff:
            tracker.popleft()
    
    def _calculate_wait_time(self, tracker: deque, current_time: float) -> float:
        """Calculate how long to wait before next request"""
        if len(tracker) < self.burst_size:
            return 0.0
        
        if len(tracker) >= self.requests_per_minute:
            return tracker[0] + 60.0 - current_time
        
        interval = 60.0 / self.requests_per_minute
        last_request = tracker[-1] if tracker else current_time - interval
        return max(0.0, last_request + interval - current_time)
    
    def execute(self, callback: Callable, key: str, *args, **kwargs) -> Any:
        """
        Execute callback with rate limiting
        
        Args:
            callback: Function to execute
            key: Rate limit key (e.g., "gemini:model-name" or just "gemini")
            *args, **kwargs: Arguments for callback
        """
        tracker, lock = self._get_tracker(key)
        
        with lock:
            current_time = time.time()
            self._cleanup_old(tracker, current_time)
            
            wait_time = self._calculate_wait_time(tracker, current_time)
            
            if wait_time > 0:
                if wait_time > 300:
                    raise Exception(f"Rate limit exceeded for {key}. Wait time: {wait_time:.1f}s")
                
                logger.info(f"Rate limiting {key}, waiting {wait_time:.2f}s")
                time.sleep(wait_time)
                current_time = time.time()
            
            tracker.append(current_time)
            return callback(*args, **kwargs)
    
    def check_status(self, key: str) -> Dict[str, Any]:
        """Get current status for a key"""
        tracker, lock = self._get_tracker(key)
        
        with lock:
            current_time = time.time()
            self._cleanup_old(tracker, current_time)
            
            return {
                "requests_in_window": len(tracker),
                "requests_per_minute": self.requests_per_minute,
                "burst_size": self.burst_size,
                "next_available": current_time + self._calculate_wait_time(tracker, current_time)
            }

_rate_limiter: Optional[RateLimiter] = None
_lock = threading.Lock()

def get_rate_limiter(requests_per_minute: int = 60, burst_size: int = 10) -> RateLimiter:
    """Get or create global rate limiter"""
    global _rate_limiter
    with _lock:
        if _rate_limiter is None:
            _rate_limiter = RateLimiter(requests_per_minute, burst_size)
        return _rate_limiter

def rate_limited(key: str, requests_per_minute: int = 60, burst_size: int = 10):
    """Decorator for rate limiting functions"""
    def decorator(func: Callable):
        def wrapper(*args, **kwargs):
            limiter = get_rate_limiter(requests_per_minute, burst_size)
            return limiter.execute(func, key, *args, **kwargs)
        return wrapper
    return decorator
