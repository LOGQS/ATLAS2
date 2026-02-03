"""Shared test fixtures and configuration for pytest.

This module provides common fixtures and utilities used across all test files.
"""

import sys
from pathlib import Path

backend_dir = Path(__file__).resolve().parents[1]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))


def pytest_configure(config):
    """Register custom pytest markers and warning filters."""
    config.addinivalue_line(
        "markers", "unit: mark test as a unit test"
    )
    config.addinivalue_line(
        "markers", "integration: mark test as an integration test"
    )
    config.addinivalue_line(
        "markers", "slow: mark test as slow running"
    )

    # Suppress third-party deprecation warnings we can't fix
    config.addinivalue_line(
        "filterwarnings", "ignore:Support for class-based `config` is deprecated:DeprecationWarning"
    )
    config.addinivalue_line(
        "filterwarnings", "ignore:read_text is deprecated:DeprecationWarning"
    )
    config.addinivalue_line(
        "filterwarnings", "ignore:open_text is deprecated:DeprecationWarning"
    )
    config.addinivalue_line(
        "filterwarnings", "ignore:Please use `import python_multipart` instead:PendingDeprecationWarning"
    )
    config.addinivalue_line(
        "filterwarnings", "ignore:pkg_resources is deprecated:UserWarning"
    )

