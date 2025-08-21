# status: complete

import logging
from pathlib import Path


def setup_logger():
    """Setup simple logger that outputs to logs/atlas.log"""
    logs_dir = Path("..") / "logs"
    logs_dir.mkdir(exist_ok=True)
    
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s | %(levelname)s | %(name)s | %(message)s',
        handlers=[
            logging.FileHandler(logs_dir / "atlas.log", encoding='utf-8'),
            logging.StreamHandler()
        ]
    )


def get_logger(name):
    """Get logger for a module"""
    return logging.getLogger(name)


setup_logger()