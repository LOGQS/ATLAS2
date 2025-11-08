# status: complete

import logging
from pathlib import Path
import time
import re
import threading


class WerkzeugRequestAggregator(logging.Filter):
    """
    Aggregates repetitive werkzeug HTTP request logs to reduce spam.
    Repetitive requests are batched and logged as summaries.
    """

    def __init__(self, flush_interval=30):
        super().__init__()
        self.flush_interval = flush_interval
        self.request_counts = {}
        self.last_flush = time.time()
        self.lock = threading.Lock()

    def filter(self, record):
        # Only process werkzeug INFO logs
        if record.name != 'werkzeug' or record.levelno != logging.INFO:
            return True

        # Extract request pattern from log message
        # Format: "127.0.0.1 - - [timestamp] "GET /path HTTP/1.1" 200 -"
        match = re.match(r'^(\S+)\s+-\s+-\s+\[.+?\]\s+"(\w+)\s+(\S+)\s+HTTP/[\d.]+"\s+(\d+)', record.getMessage())

        if not match:
            return True

        ip, method, path, status = match.groups()
        key = (ip, method, path, status)

        with self.lock:
            current_time = time.time()

            # Flush aggregated logs if interval elapsed
            if current_time - self.last_flush >= self.flush_interval:
                self._flush_aggregated_logs()
                self.last_flush = current_time

            # Aggregate this request
            if key not in self.request_counts:
                self.request_counts[key] = {
                    'count': 0,
                    'first_seen': current_time,
                    'last_record': record
                }

            self.request_counts[key]['count'] += 1
            self.request_counts[key]['last_seen'] = current_time

            # Block this individual log from being emitted
            return False

    def _flush_aggregated_logs(self):
        """Emit summary logs for aggregated requests"""
        if not self.request_counts:
            return

        logger = logging.getLogger('werkzeug')

        for (ip, method, path, status), data in self.request_counts.items():
            count = data['count']
            if count == 1:
                # Single occurrence - log normally
                logger.info(f"{ip} - - \"{method} {path}\" {status} -")
            else:
                # Multiple occurrences - log with count
                duration = data['last_seen'] - data['first_seen']
                logger.info(
                    f"{ip} - - \"{method} {path}\" {status} - "
                    f"[repeated {count}x over {duration:.1f}s]"
                )

        self.request_counts.clear()


def setup_logger():
    """Setup simple logger that outputs to logs/atlas.log"""
    logs_dir = Path("..") / "logs"
    logs_dir.mkdir(exist_ok=True)

    file_handler = logging.FileHandler(logs_dir / "atlas.log", encoding='utf-8')
    file_handler.setLevel(logging.DEBUG)

    stream_handler = logging.StreamHandler()
    stream_handler.setLevel(logging.DEBUG)

    # Add aggregator filter to both handlers
    aggregator = WerkzeugRequestAggregator(flush_interval=30)
    file_handler.addFilter(aggregator)
    stream_handler.addFilter(aggregator)

    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s | %(levelname)s | %(name)s | %(message)s',
        handlers=[file_handler, stream_handler]
    )


def get_logger(name):
    """Get logger for a module"""
    return logging.getLogger(name)


setup_logger()