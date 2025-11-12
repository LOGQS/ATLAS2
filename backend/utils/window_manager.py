"""Windows API utilities for managing browser window visibility.

Simple, robust window hiding without threading complexity.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes
import time
from typing import Optional
from dataclasses import dataclass

from utils.logger import get_logger

_logger = get_logger(__name__)

# Windows API Constants
SW_HIDE = 0
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000


@dataclass
class WindowHandle:
    """Captured browser window handle."""
    hwnd: int
    title: str


def _get_window_title(user32, hwnd: int) -> str:
    """Get window title safely."""
    try:
        length = user32.GetWindowTextLengthW(hwnd)
        if length > 0:
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            return buff.value
    except Exception:
        pass
    return ""


def _is_window_visible(user32, hwnd: int) -> bool:
    """Check if window is visible."""
    return bool(user32.IsWindowVisible(hwnd))


def find_browser_window(timeout_seconds: float = 3.0) -> Optional[WindowHandle]:
    """Find Chromium/Chrome browser window by enumerating windows.

    Args:
        timeout_seconds: Max time to search for window

    Returns:
        WindowHandle if found, None otherwise
    """
    user32 = ctypes.windll.user32
    found_window = None

    # Callback for EnumWindows
    EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)

    def enum_callback(hwnd, lParam):
        nonlocal found_window
        if found_window:
            return True  # Already found

        title = _get_window_title(user32, hwnd)
        if title and ('Chromium' in title or 'Chrome' in title) and _is_window_visible(user32, hwnd):
            _logger.info(f"[WINDOW_HIDE] Found browser: '{title}' (hwnd: {hwnd})")
            found_window = WindowHandle(hwnd=hwnd, title=title)
            return False  # Stop enumeration

        return True  # Continue enumeration

    callback = EnumWindowsProc(enum_callback)

    # Retry with short delays to catch window as it appears
    start_time = time.time()
    while time.time() - start_time < timeout_seconds:
        user32.EnumWindows(callback, 0)
        if found_window:
            return found_window
        time.sleep(0.05)  # Small delay between checks

    _logger.warning("[WINDOW_HIDE] Browser window not found within timeout")
    return None


def hide_window(hwnd: int, hide_from_alt_tab: bool = True) -> bool:
    """Hide window and remove from Alt+Tab.

    Args:
        hwnd: Window handle
        hide_from_alt_tab: Remove from Alt+Tab switcher

    Returns:
        True if successful
    """
    try:
        user32 = ctypes.windll.user32

        # Hide window
        user32.ShowWindow(hwnd, SW_HIDE)

        if hide_from_alt_tab:
            # Remove from Alt+Tab
            ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            ex_style |= WS_EX_TOOLWINDOW
            ex_style &= ~WS_EX_APPWINDOW
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style)

        _logger.info(f"[WINDOW_HIDE] Hidden browser window (hwnd: {hwnd})")
        return True
    except Exception as e:
        _logger.error(f"[WINDOW_HIDE] Failed to hide window: {e}")
        return False


def find_and_hide_browser(timeout_seconds: float = 3.0, hide_from_alt_tab: bool = True) -> Optional[WindowHandle]:
    """Find and hide browser window.

    Args:
        timeout_seconds: Max time to find window
        hide_from_alt_tab: Remove from Alt+Tab

    Returns:
        WindowHandle if successful, None otherwise
    """
    _logger.info("[WINDOW_HIDE] Searching for browser window...")
    window_handle = find_browser_window(timeout_seconds)

    if window_handle:
        if hide_window(window_handle.hwnd, hide_from_alt_tab):
            _logger.info("[WINDOW_HIDE] Browser window hidden successfully")
            return window_handle
        else:
            _logger.error("[WINDOW_HIDE] Failed to hide browser window")
            return None
    else:
        _logger.warning("[WINDOW_HIDE] Browser window not found")
        return None
