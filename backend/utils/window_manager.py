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
SW_SHOW = 5
SW_RESTORE = 9
GWL_EXSTYLE = -20
GWL_STYLE = -16
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
WS_THICKFRAME = 0x00040000  # Resizable border
WS_MAXIMIZEBOX = 0x00010000  # Maximize button


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


def resize_window(hwnd: int, width: int, height: int) -> bool:
    """Resize window to specific dimensions.

    Args:
        hwnd: Window handle
        width: Target width in pixels
        height: Target height in pixels

    Returns:
        True if successful
    """
    try:
        user32 = ctypes.windll.user32

        SWP_NOMOVE = 0x0002
        SWP_NOZORDER = 0x0004
        SWP_NOACTIVATE = 0x0010

        # Resize window (keep position and Z-order)
        user32.SetWindowPos(
            hwnd, 0, 0, 0, width, height,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
        )

        _logger.info(f"[WINDOW_RESIZE] Resized window to {width}x{height} (hwnd: {hwnd})")
        return True
    except Exception as e:
        _logger.error(f"[WINDOW_RESIZE] Failed to resize window: {e}")
        return False


def hide_window(hwnd: int, hide_from_alt_tab: bool = True) -> bool:
    """Hide window and remove from Alt+Tab.

    When hidden, lock viewport size for stable streaming.

    Args:
        hwnd: Window handle
        hide_from_alt_tab: Remove from Alt+Tab switcher

    Returns:
        True if successful
    """
    try:
        user32 = ctypes.windll.user32

        # CRITICAL: Restore window from fullscreen/maximized BEFORE hiding
        # This ensures stream always captures the correct fixed viewport size
        user32.ShowWindow(hwnd, SW_RESTORE)

        # Small delay to let window restore complete
        time.sleep(0.05)

        # Resize to fixed streaming dimensions (1366x920)
        resize_window(hwnd, 1366, 920)

        # Lock resize for stable stream capture
        disable_window_resize(hwnd)

        # Now hide the window
        user32.ShowWindow(hwnd, SW_HIDE)

        if hide_from_alt_tab:
            # Remove from Alt+Tab
            ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            ex_style |= WS_EX_TOOLWINDOW
            ex_style &= ~WS_EX_APPWINDOW
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style)

        _logger.info(f"[WINDOW_HIDE] Hidden browser window with locked size (hwnd: {hwnd})")
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


def disable_window_resize(hwnd: int) -> bool:
    """Disable window resizing by removing resize border and maximize button.

    Args:
        hwnd: Window handle

    Returns:
        True if successful
    """
    try:
        user32 = ctypes.windll.user32

        # Get current window style
        style = user32.GetWindowLongW(hwnd, GWL_STYLE)

        # Remove resize border and maximize button
        style &= ~WS_THICKFRAME
        style &= ~WS_MAXIMIZEBOX

        # Apply new style
        user32.SetWindowLongW(hwnd, GWL_STYLE, style)

        # Refresh window to apply style changes
        SWP_FRAMECHANGED = 0x0020
        SWP_NOMOVE = 0x0002
        SWP_NOSIZE = 0x0001
        SWP_NOZORDER = 0x0004
        user32.SetWindowPos(
            hwnd, 0, 0, 0, 0, 0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER
        )

        _logger.info(f"[WINDOW_RESIZE] Disabled resizing for window (hwnd: {hwnd})")
        return True
    except Exception as e:
        _logger.error(f"[WINDOW_RESIZE] Failed to disable resizing: {e}")
        return False


def enable_window_resize(hwnd: int) -> bool:
    """Enable window resizing by restoring resize border and maximize button.

    Args:
        hwnd: Window handle

    Returns:
        True if successful
    """
    try:
        user32 = ctypes.windll.user32

        # Get current window style
        style = user32.GetWindowLongW(hwnd, GWL_STYLE)

        # Restore resize border and maximize button
        style |= WS_THICKFRAME
        style |= WS_MAXIMIZEBOX

        # Apply new style
        user32.SetWindowLongW(hwnd, GWL_STYLE, style)

        # Refresh window to apply style changes
        SWP_FRAMECHANGED = 0x0020
        SWP_NOMOVE = 0x0002
        SWP_NOSIZE = 0x0001
        SWP_NOZORDER = 0x0004
        SWP_SHOWWINDOW = 0x0040
        user32.SetWindowPos(
            hwnd, 0, 0, 0, 0, 0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW
        )

        # Small delay to ensure styles apply
        time.sleep(0.02)

        _logger.info(f"[WINDOW_RESIZE] Enabled resizing for window (hwnd: {hwnd})")
        return True
    except Exception as e:
        _logger.error(f"[WINDOW_RESIZE] Failed to enable resizing: {e}")
        return False


def show_window(hwnd: int, restore_alt_tab: bool = True) -> bool:
    """Show hidden browser window and bring to foreground.

    When visible, user can resize freely (they're looking at real browser, not stream).

    Args:
        hwnd: Window handle
        restore_alt_tab: Restore in Alt+Tab switcher

    Returns:
        True if successful
    """
    try:
        user32 = ctypes.windll.user32

        if restore_alt_tab:
            # Restore to Alt+Tab
            ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            ex_style &= ~WS_EX_TOOLWINDOW
            ex_style |= WS_EX_APPWINDOW
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style)

        # Show window first
        user32.ShowWindow(hwnd, SW_RESTORE)
        user32.SetForegroundWindow(hwnd)

        # AFTER showing, enable resizing (styles apply better on visible windows)
        enable_window_resize(hwnd)

        _logger.info(f"[WINDOW_SHOW] Shown browser window with free resizing (hwnd: {hwnd})")
        return True
    except Exception as e:
        _logger.error(f"[WINDOW_SHOW] Failed to show window: {e}")
        return False
