import time
import threading
from collections import deque
from typing import Dict, Optional

class RateLimiter:
    """Token/request based rate limiter supporting global and model scopes."""

    WINDOW_SECONDS = {
        "minute": 60,
        "hour": 3600,
        "day": 86400,
    }

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.request_logs: Dict[str, deque] = {}
        self.token_logs: Dict[str, deque] = {}
        self.limits: Dict[str, Dict[str, Optional[int]]] = {}

    def _configure_key(self, key: str, limits: Dict[str, Optional[int]]):
        self.limits[key] = limits
        self.request_logs.setdefault(key, deque())
        self.token_logs.setdefault(key, deque())

    def configure_provider(self, provider: str, limits: Dict[str, Dict]):
        with self.lock:
            global_limits = limits.get("global", limits)
            self._configure_key(provider, global_limits)
            for model, lim in limits.get("models", {}).items():
                self._configure_key(f"{provider}:{model}", lim)

    def _update_key(self, key: str, limits: Dict[str, Optional[int]]):
        if key not in self.limits:
            self._configure_key(key, limits)
        else:
            self.limits[key].update(limits)

    def update_limits(self, provider: str, limits: Dict[str, Dict]):
        with self.lock:
            if "global" in limits or not isinstance(next(iter(limits.values()), None), dict):
                global_limits = limits.get("global", limits)
                self._update_key(provider, global_limits)
            for model, lim in limits.get("models", {}).items():
                self._update_key(f"{provider}:{model}", lim)

    def _prune(self, key: str, now: float):
        req_log = self.request_logs.get(key)
        tok_log = self.token_logs.get(key)
        if req_log is None or tok_log is None:
            return
        cutoff = now - self.WINDOW_SECONDS['day']
        while req_log and req_log[0] < cutoff:
            req_log.popleft()
        while tok_log and tok_log[0][0] < cutoff:
            tok_log.popleft()

    def _counts(self, key: str, now: float):
        req_log = self.request_logs.get(key, deque())
        tok_log = self.token_logs.get(key, deque())
        counts = {
            'requests_min': len([t for t in req_log if t > now - self.WINDOW_SECONDS['minute']]),
            'requests_hour': len([t for t in req_log if t > now - self.WINDOW_SECONDS['hour']]),
            'requests_day': len(req_log),
            'tokens_min': sum(v for ts, v in tok_log if ts > now - self.WINDOW_SECONDS['minute']),
            'tokens_hour': sum(v for ts, v in tok_log if ts > now - self.WINDOW_SECONDS['hour']),
            'tokens_day': sum(v for ts, v in tok_log),
        }
        # also track earliest timestamps for wait calculation
        counts['earliest_req_min'] = next((t for t in req_log if t > now - self.WINDOW_SECONDS['minute']), None)
        counts['earliest_req_hour'] = next((t for t in req_log if t > now - self.WINDOW_SECONDS['hour']), None)
        counts['earliest_req_day'] = req_log[0] if req_log else None
        counts['earliest_tok_min'] = next((ts for ts, _ in tok_log if ts > now - self.WINDOW_SECONDS['minute']), None)
        counts['earliest_tok_hour'] = next((ts for ts, _ in tok_log if ts > now - self.WINDOW_SECONDS['hour']), None)
        counts['earliest_tok_day'] = tok_log[0][0] if tok_log else None
        return counts

    def _wait_for_key(self, key: str, tokens: int):
        limits = self.limits.get(key)
        if not limits or not limits.get("enabled"):
            return
        while True:
            with self.lock:
                now = time.time()
                self._prune(key, now)
                c = self._counts(key, now)
                wait_time = 0.0
                # Request limits
                if limits.get("rpm") is not None and c["requests_min"] >= limits["rpm"] and c["earliest_req_min"] is not None:
                    wait_time = max(wait_time, c["earliest_req_min"] + self.WINDOW_SECONDS["minute"] - now)
                if limits.get("rph") is not None and c["requests_hour"] >= limits["rph"] and c["earliest_req_hour"] is not None:
                    wait_time = max(wait_time, c["earliest_req_hour"] + self.WINDOW_SECONDS["hour"] - now)
                if limits.get("rpd") is not None and c["requests_day"] >= limits["rpd"] and c["earliest_req_day"] is not None:
                    wait_time = max(wait_time, c["earliest_req_day"] + self.WINDOW_SECONDS["day"] - now)
                # Token limits
                if limits.get("tpm") is not None and c["tokens_min"] + tokens > limits["tpm"] and c["earliest_tok_min"] is not None:
                    wait_time = max(wait_time, c["earliest_tok_min"] + self.WINDOW_SECONDS["minute"] - now)
                if limits.get("tph") is not None and c["tokens_hour"] + tokens > limits["tph"] and c["earliest_tok_hour"] is not None:
                    wait_time = max(wait_time, c["earliest_tok_hour"] + self.WINDOW_SECONDS["hour"] - now)
                if limits.get("tpd") is not None and c["tokens_day"] + tokens > limits["tpd"] and c["earliest_tok_day"] is not None:
                    wait_time = max(wait_time, c["earliest_tok_day"] + self.WINDOW_SECONDS["day"] - now)
                if wait_time <= 0:
                    self.request_logs[key].append(now)
                    self.token_logs[key].append((now, tokens))
                    return
            if wait_time > 0:
                time.sleep(wait_time)

    def wait(self, provider: str, tokens: int = 0, model: Optional[str] = None):
        self._wait_for_key(provider, tokens)
        if model is not None:
            self._wait_for_key(f"{provider}:{model}", tokens)

rate_limiter = RateLimiter()
