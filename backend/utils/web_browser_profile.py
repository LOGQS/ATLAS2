"""Browser profile management for web operations.

Manages the persistent browser profile used by crawl4ai for anti-bot detection.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Dict, Any

from utils.logger import get_logger

_logger = get_logger(__name__)

# Profile directory relative to project root
PROFILE_NAME = "google_serp"


def get_profile_dir() -> Path:
    """Get the managed browser profile directory path."""
    project_root = Path(__file__).resolve().parents[4]
    profile_dir = project_root / "data" / "managed_browser" / PROFILE_NAME
    return profile_dir


def check_profile_exists() -> bool:
    """Check if the managed browser profile exists and is valid.

    Returns:
        True if profile exists and setup is complete, False otherwise
    """
    profile_dir = get_profile_dir()

    if not profile_dir.exists():
        _logger.info(f"Profile directory does not exist: {profile_dir}")
        return False

    # Check if directory has content (not just empty folder)
    if not any(profile_dir.iterdir()):
        _logger.info(f"Profile directory is empty: {profile_dir}")
        return False

    # Check for setup completion marker
    marker_file = profile_dir / ".setup_complete"
    if not marker_file.exists():
        _logger.info(f"Profile exists but setup not complete (no marker file)")
        return False

    _logger.info(f"Valid profile found at: {profile_dir}")
    return True


def get_profile_status() -> Dict[str, Any]:
    """Get detailed profile status information.

    Returns:
        Dictionary with profile status details
    """
    profile_dir = get_profile_dir()
    exists = check_profile_exists()

    status = {
        "exists": exists,
        "path": str(profile_dir),
        "profile_name": PROFILE_NAME,
    }

    if exists:
        # Count files in profile to give user confidence
        try:
            file_count = sum(1 for _ in profile_dir.rglob('*') if _.is_file())
            status["file_count"] = file_count
            status["status"] = "ready"
        except Exception as e:
            _logger.warning(f"Error counting profile files: {e}")
            status["file_count"] = 0
            status["status"] = "ready"
    else:
        status["file_count"] = 0
        status["status"] = "missing"

    return status


def launch_profile_setup() -> Dict[str, Any]:
    """Launch browser profile setup using Playwright.

    Opens a managed Chromium browser for the user to:
    1. Accept Google consent/cookies
    2. Solve any CAPTCHA challenges
    3. Optionally sign in

    The browser profile will be saved and reused for future searches.

    Returns:
        Dictionary with success status and setup instructions
    """
    profile_dir = get_profile_dir()

    try:
        _logger.info(f"Preparing browser profile setup at: {profile_dir}")

        # Ensure profile directory exists
        profile_dir.parent.mkdir(parents=True, exist_ok=True)

        # Start background thread to run the browser setup
        import threading
        setup_thread = threading.Thread(
            target=_run_browser_setup,
            args=(profile_dir,),
            daemon=True
        )
        setup_thread.start()

        return {
            "success": True,
            "message": "Browser setup initiated. A browser window will open shortly.",
            "profile_path": str(profile_dir)
        }

    except Exception as e:
        error_msg = f"Failed to initiate profile setup: {str(e)}"
        _logger.error(error_msg)
        return {
            "success": False,
            "error": error_msg
        }


def _run_browser_setup(profile_dir: Path) -> None:
    """Run the browser setup process in a separate thread.

    Args:
        profile_dir: Path to store the browser profile
    """
    try:
        from playwright.sync_api import sync_playwright
        import time

        _logger.info(f"Launching Playwright browser for profile setup")

        # Get existing windows BEFORE launching
        import ctypes
        import ctypes.wintypes

        user32 = ctypes.windll.user32

        # Use Windows Event Hook - TRUE event-driven, no polling!
        chromium_hwnd = None
        hook_handle = None

        def get_window_title(hwnd):
            """Get window title safely."""
            try:
                length = user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buff = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buff, length + 1)
                    return buff.value
            except:
                pass
            return ""

        # Define callback for window events
        WinEventProc = ctypes.WINFUNCTYPE(
            None,
            ctypes.wintypes.HANDLE,
            ctypes.wintypes.DWORD,
            ctypes.wintypes.HWND,
            ctypes.wintypes.LONG,
            ctypes.wintypes.LONG,
            ctypes.wintypes.DWORD,
            ctypes.wintypes.DWORD
        )

        def win_event_callback(hWinEventHook, event, hwnd, idObject, idChild, dwEventThread, dwmsEventTime):
            nonlocal chromium_hwnd
            if chromium_hwnd:  # Already found
                return

            # Check if this is a top-level window (not a child control)
            if idObject == 0 and idChild == 0:
                title = get_window_title(hwnd)
                # Look for Chromium/Chrome in title
                if title and ('Chromium' in title or 'Chrome' in title):
                    chromium_hwnd = hwnd
                    _logger.info(f"[WINDOW_ACTIVATION] Window created event: '{title}' (hwnd: {hwnd})")

        callback = WinEventProc(win_event_callback)

        # Register hook for window creation events
        EVENT_OBJECT_SHOW = 0x8002  # Window shown
        WINEVENT_OUTOFCONTEXT = 0x0000

        _logger.info(f"[WINDOW_ACTIVATION] Registering window event hook...")
        hook_handle = user32.SetWinEventHook(
            EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW,
            None,
            callback,
            0, 0,
            WINEVENT_OUTOFCONTEXT
        )

        if not hook_handle:
            _logger.warning(f"[WINDOW_ACTIVATION] Failed to register window hook, falling back to polling")

        try:
            with sync_playwright() as pw:
                # Launch persistent context with the profile directory
                _logger.info(f"[WINDOW_ACTIVATION] Launching persistent context...")
                context = pw.chromium.launch_persistent_context(
                    user_data_dir=str(profile_dir),
                    headless=False,
                    viewport={"width": 1366, "height": 840},
                    args=["--lang=en-US", "--accept-lang=en-US,en;q=0.9"],
                )
                _logger.info(f"[WINDOW_ACTIVATION] Context launched, waiting for window event...")

                # Wait for the event hook to capture the window (with timeout)
                start_time = time.time()
                timeout = 5.0

                while not chromium_hwnd and (time.time() - start_time < timeout):
                    # Process Windows messages so the hook callback can fire
                    msg = ctypes.wintypes.MSG()
                    while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):  # PM_REMOVE = 1
                        user32.TranslateMessage(ctypes.byref(msg))
                        user32.DispatchMessageW(ctypes.byref(msg))
                    time.sleep(0.01)  # Tiny sleep to avoid burning CPU

                try:
                    if chromium_hwnd:
                        _logger.info(f"[WINDOW_ACTIVATION] Chromium window detected via event hook! (hwnd: {chromium_hwnd})")

                        # TRICK: Simulate Alt key to bypass foreground lock restrictions
                        keybd_event = ctypes.windll.user32.keybd_event
                        VK_MENU = 0x12  # Alt key
                        KEYEVENTF_KEYUP = 0x0002

                        keybd_event(VK_MENU, 0, 0, 0)  # Alt down
                        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)  # Alt up

                        # Bring to foreground (now allowed after Alt key)
                        user32.SetForegroundWindow(chromium_hwnd)

                        _logger.info(f"[WINDOW_ACTIVATION] Chromium window brought to foreground")
                    else:
                        _logger.warning("[WINDOW_ACTIVATION] Timeout waiting for Chromium window event")
                except Exception as e:
                    _logger.error(f"[WINDOW_ACTIVATION] Failed to bring browser to foreground: {e}", exc_info=True)

                # Use the default page that was created with the context (avoid creating extra tab)
                page = context.pages[0] if context.pages else context.new_page()

                # Navigate to Google to trigger consent prompts
                page.goto("https://www.google.com/search?q=test&hl=en&gl=us")

                _logger.info("Browser opened. Waiting for user to complete setup...")

                # Wait for user to close the browser
                # Use Playwright's page.wait_for_event() which is event-driven, not polling
                try:
                    # Wait indefinitely for the page to be closed
                    # This is event-driven - no polling
                    page.wait_for_event("close", timeout=0)  # timeout=0 means wait forever
                except Exception:
                    # Page was closed or context ended
                    pass
                finally:
                    try:
                        context.close()
                    except Exception:
                        pass
        finally:
            # Unregister the hook
            if hook_handle:
                user32.UnhookWinEvent(hook_handle)
                _logger.info(f"[WINDOW_ACTIVATION] Window event hook unregistered")

        _logger.info("Browser setup completed")

        # Create marker file to indicate setup is complete
        marker_file = profile_dir / ".setup_complete"
        try:
            marker_file.write_text("Profile setup completed")
            _logger.info(f"Created setup completion marker: {marker_file}")
        except Exception as e:
            _logger.error(f"Failed to create marker file: {e}")

        # Check if profile was created successfully
        profile_status = get_profile_status()

        # Notify frontend via SSE
        try:
            from route.chat_route import publish_content
            import json

            publish_content(
                "system_broadcast",
                "web_profile_updated",
                json.dumps({
                    "exists": profile_status["exists"],
                    "status": profile_status["status"]
                })
            )

            _logger.info("Profile update notification sent via SSE")

        except Exception as e:
            _logger.error(f"Failed to send profile update notification: {e}")

    except ImportError:
        _logger.error("Playwright is not installed. Install with: pip install playwright && playwright install")
    except Exception as e:
        _logger.error(f"Error during browser setup: {e}")


def ensure_profile_ready() -> Dict[str, Any]:
    """Ensure browser profile is ready for use.

    Checks if profile exists, and if not, provides guidance for setup.

    Returns:
        Dictionary with profile readiness status and next steps
    """
    status = get_profile_status()

    if status["exists"]:
        return {
            "ready": True,
            "message": "Browser profile is ready for use",
            "profile_path": status["path"]
        }
    else:
        return {
            "ready": False,
            "message": "Browser profile needs to be created",
            "action_required": "setup",
            "profile_path": status["path"]
        }
