"""Persistent browser session manager for the unified web workspace."""

from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

from utils.logger import get_logger
from utils.web_browser_profile import check_profile_exists, get_profile_dir
from utils.window_manager import find_and_hide_browser

try:
    from playwright.async_api import BrowserContext, Page, async_playwright
except ImportError:  # pragma: no cover - Playwright is required in runtime env
    BrowserContext = Page = None  # type: ignore[assignment]
    async_playwright = None

logger = get_logger(__name__)

DEFAULT_VIEWPORT = {"width": 1366, "height": 820}
DEFAULT_START_URL = "https://www.google.com/?hl=en&gl=us"
DEFAULT_BROWSER_ARGS = [
    # Anti-detection switches (from crawl4ai guidance)
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process,site-per-process",
    "--disable-site-isolation-trials",
    "--disable-web-security",
    "--no-default-browser-check",
    "--disable-infobars",
    "--lang=en-US",
    "--accept-lang=en-US,en;q=0.9",

    # CRITICAL: Prevent throttling of hidden windows for smooth streaming
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-ipc-flooding-protection",
]


class WebSessionError(Exception):
    """Domain-specific error raised when the shared browser session fails."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class SessionSnapshot:
    session_id: Optional[str]
    status: str
    profile_name: str
    viewer: Dict[str, Any]
    current_url: str
    page_title: str
    can_go_back: bool
    can_go_forward: bool
    is_loading: bool
    last_error: Optional[str]
    updated_at: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "session_id": self.session_id,
            "status": self.status,
            "profile_name": self.profile_name,
            "viewer": self.viewer,
            "current_url": self.current_url,
            "page_title": self.page_title,
            "can_go_back": self.can_go_back,
            "can_go_forward": self.can_go_forward,
            "is_loading": self.is_loading,
            "last_error": self.last_error,
            "updated_at": self.updated_at,
        }


class WebSessionManager:
    """Owns a single Playwright persistent context shared across the app."""

    def __init__(self) -> None:
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="WebSessionLoop",
            daemon=True,
        )
        self._thread.start()

        self._status_publisher: Optional[Callable[[Dict[str, Any]], None]] = None
        self._playwright = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None
        self._session_id: Optional[str] = None
        self._profile_name: str = "google_serp"
        self._status: str = "idle"
        self._last_error: Optional[str] = None
        self._viewport = DEFAULT_VIEWPORT.copy()
        self._current_url: str = "about:blank"
        self._current_title: str = ""
        self._can_back: bool = False
        self._can_forward: bool = False
        self._is_loading: bool = False
        self._nav_history: List[str] = []  # Track navigation history for forward detection
        self._nav_position: int = -1  # Current position in history
        self._history_traversal: bool = False  # True when actively stepping through history
        self._last_status_update = time.time()

        self._state_lock = threading.Lock()
        self._command_lock: Optional[asyncio.Lock] = None
        self._capture_lock: Optional[asyncio.Lock] = None

        self._run_sync(self._initialize_loop_state())

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    async def _initialize_loop_state(self) -> None:
        self._command_lock = asyncio.Lock()
        self._capture_lock = asyncio.Lock()

    def _run_sync(self, coro: Awaitable[Any]) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    def set_status_publisher(self, publisher: Callable[[Dict[str, Any]], None]) -> None:
        self._status_publisher = publisher

    # ------------------------------------------------------------------ #
    # Session lifecycle
    # ------------------------------------------------------------------ #
    def ensure_session(self, profile_name: Optional[str] = None, chat_id: Optional[str] = None) -> Dict[str, Any]:
        logger.info("[WEB_SESSION] ensure_session called profile=%s chat=%s", profile_name, chat_id)
        with self._state_lock:
            try:
                snapshot: SessionSnapshot = self._run_sync(self._ensure_session_async(profile_name, chat_id))
                return snapshot.to_dict()
            except WebSessionError as exc:
                logger.warning("[WEB_SESSION] ensure_session failed (%s): %s", exc.code, exc)
                self._status = exc.code
                self._last_error = str(exc)
                self._broadcast_status()
                return self._snapshot().to_dict()

    def has_active_session(self) -> bool:
        return self._context is not None and self._session_id is not None and self._status == "ready"

    async def _ensure_session_async(self, profile_name: Optional[str], chat_id: Optional[str]) -> SessionSnapshot:
        desired_profile = profile_name or self._profile_name

        if not check_profile_exists(desired_profile):
            raise WebSessionError("profile_missing", f"Browser profile '{desired_profile}' is not ready")

        if self._context and self._session_id and self._profile_name == desired_profile:
            return self._snapshot()

        await self._start_session(desired_profile, chat_id)
        return self._snapshot()

    async def _start_session(self, profile_name: str, chat_id: Optional[str]) -> None:
        if async_playwright is None:
            raise WebSessionError("playwright_missing", "Playwright is not installed. Install it to enable web browsing.")

        self._set_status("initializing")
        profile_dir = get_profile_dir(profile_name)

        try:
            self._playwright = await async_playwright().start()
            logger.info("[WEB_SESSION] Playwright started, launching persistent context")

            # Launch context normally
            self._context = await self._playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                headless=False,  # Anti-detection: keep visible mode, hide via Windows API
                viewport=self._viewport,
                args=DEFAULT_BROWSER_ARGS,
                ignore_default_args=["--enable-automation"],
            )

            logger.info("[WEB_SESSION] Context launched, hiding browser window...")

            # Hide window immediately after launch (no threading, simple & robust)
            loop = asyncio.get_event_loop()
            window_handle = await loop.run_in_executor(
                None,
                find_and_hide_browser,
                3.0,  # timeout
                True  # hide_from_alt_tab
            )

            if window_handle:
                logger.info(f"[WEB_SESSION] Browser window hidden (hwnd: {window_handle.hwnd})")
            else:
                logger.warning("[WEB_SESSION] Could not hide browser window - may be visible")

            self._page = self._context.pages[0] if self._context.pages else await self._context.new_page()
            logger.info("[WEB_SESSION] Chromium context ready, pages=%s", len(self._context.pages))
            self._profile_name = profile_name
            self._session_id = uuid.uuid4().hex
            self._last_error = None

            # Navigation and loading event listeners
            self._page.on("framenavigated", lambda _: asyncio.create_task(self._update_page_metadata()))
            self._page.on("load", lambda _: asyncio.create_task(self._handle_page_load()))
            self._page.on("close", lambda _: asyncio.create_task(self._handle_page_closed()))

            await self._page.goto(DEFAULT_START_URL, wait_until="domcontentloaded")
            logger.info("[WEB_SESSION] Navigated to start url %s", DEFAULT_START_URL)
            await self._update_page_metadata()
            self._set_status("ready", extra={"chat_id": chat_id})
        except Exception as exc:
            await self._destroy_async()
            raise WebSessionError("session_start_failed", f"Failed to launch shared browser: {exc}") from exc

    async def _handle_page_load(self) -> None:
        """Handle page load completion."""
        self._is_loading = False
        logger.info("[WEB_SESSION] Page finished loading")
        self._broadcast_status()

    async def _handle_page_closed(self) -> None:
        logger.warning("[WEB_SESSION] Browser page closed unexpectedly; tearing down context")
        await self._destroy_async()
        self._set_status("closed")

    async def _destroy_async(self) -> None:
        if self._context:
            try:
                await self._context.close()
            except Exception:
                logger.exception("[WEB_SESSION] Failed to close context cleanly")
        if self._playwright:
            try:
                await self._playwright.stop()
            except Exception:
                logger.exception("[WEB_SESSION] Failed to stop Playwright")

        self._context = None
        self._playwright = None
        self._page = None
        self._session_id = None
        self._current_url = "about:blank"
        self._current_title = ""

    # ------------------------------------------------------------------ #
    # Snapshot & status broadcasting
    # ------------------------------------------------------------------ #
    def get_status(self) -> Dict[str, Any]:
        return self._snapshot().to_dict()

    def _snapshot(self) -> SessionSnapshot:
        # Navigation state is updated only when needed (not on every snapshot)
        # to avoid performance overhead
        return SessionSnapshot(
            session_id=self._session_id,
            status=self._status,
            profile_name=self._profile_name,
            viewer={"viewport": self._viewport},
            current_url=self._current_url,
            page_title=self._current_title,
            can_go_back=getattr(self, '_can_back', False),
            can_go_forward=getattr(self, '_can_forward', False),
            is_loading=getattr(self, '_is_loading', False),
            last_error=self._last_error,
            updated_at=self._last_status_update,
        )

    def _set_status(self, status: str, extra: Optional[Dict[str, Any]] = None) -> None:
        self._status = status
        if status not in {"error", "profile_missing"}:
            self._last_error = None
        self._broadcast_status(extra=extra)

    def _broadcast_status(self, extra: Optional[Dict[str, Any]] = None) -> None:
        self._last_status_update = time.time()
        payload = self._snapshot().to_dict()
        if extra:
            payload.update(extra)

        if self._status_publisher:
            try:
                self._status_publisher(payload)
            except Exception:
                logger.exception("[WEB_SESSION] Failed to publish status payload")

    async def _update_page_metadata(self) -> None:
        if not self._page:
            return
        try:
            new_url = self._page.url or "about:blank"
            self._current_title = await self._page.title()

            navigation_by_history = self._history_traversal
            self._history_traversal = False

            # Track navigation history for forward/back buttons
            if new_url != self._current_url:
                if navigation_by_history:
                    # Only update the current url when replaying history entries
                    self._current_url = new_url
                else:
                    if self._nav_position < len(self._nav_history) - 1:
                        # Truncate forward history when branching away from it
                        self._nav_history = self._nav_history[: self._nav_position + 1]

                    if not self._nav_history or self._nav_history[-1] != new_url:
                        self._nav_history.append(new_url)
                    self._nav_position = len(self._nav_history) - 1
                    self._current_url = new_url
            else:
                self._current_url = new_url

            # Update navigation state
            self._can_back = self._nav_position > 0
            self._can_forward = self._nav_position < len(self._nav_history) - 1

            self._broadcast_status()
        except Exception:
            logger.exception("[WEB_SESSION] Failed to update page metadata")

    # ------------------------------------------------------------------ #
    # Frame capture
    # ------------------------------------------------------------------ #
    def capture_frame(self, session_id: str) -> bytes:
        # Removed debug log to prevent spam at 30 FPS
        if not self._session_id or session_id != self._session_id:
            raise WebSessionError("session_stale", "Requested session does not match active browser")
        return self._run_sync(self._capture_frame_async())

    async def _capture_frame_async(self) -> bytes:
        if not self._page or not self._capture_lock:
            raise WebSessionError("session_inactive", "Browser session is not ready")

        async with self._capture_lock:
            try:
                # Balanced optimization - responsive but stable
                return await asyncio.wait_for(
                    self._page.screenshot(
                        type="jpeg",
                        quality=55,  # Balanced quality/speed
                        full_page=False,  # Explicit: only viewport
                        omit_background=False,
                    ),
                    timeout=3.0,  # 3s timeout - fast enough, won't timeout during page loads
                )
            except asyncio.TimeoutError:
                logger.warning("[WEB_SESSION] Screenshot timeout (page still loading)")
                raise WebSessionError("screenshot_timeout", "Screenshot took too long (page loading)")
            except Exception as exc:
                logger.error("[WEB_SESSION] Frame capture failed: %s", exc)
                raise WebSessionError("frame_capture_failed", f"Failed to capture frame: {exc}") from exc

    # ------------------------------------------------------------------ #
    # Browser commands
    # ------------------------------------------------------------------ #
    def dispatch_command(self, session_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        logger.info("[WEB_SESSION] dispatch_command %s", payload.get("type"))
        if not self._session_id or session_id != self._session_id:
            raise WebSessionError("session_stale", "Requested session does not match active browser")
        return self._run_sync(self._dispatch_command_async(payload))

    async def _dispatch_command_async(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self._page or not self._command_lock:
            raise WebSessionError("session_inactive", "Browser session is not ready")

        async with self._command_lock:
            cmd_type = payload.get("type")
            metadata_required = False

            if cmd_type == "navigate":
                url = payload.get("url")
                if not url:
                    raise WebSessionError("invalid_command", "navigate command missing url")
                metadata_required = True
                self._is_loading = True
                self._broadcast_status()
                await self._page.goto(url, wait_until="domcontentloaded", timeout=60000)
            elif cmd_type == "reload":
                metadata_required = True
                self._is_loading = True
                self._broadcast_status()
                await self._page.reload(wait_until="domcontentloaded")
            elif cmd_type == "back":
                if self._nav_position <= 0:
                    logger.info("[WEB_SESSION] Back navigation requested with no history to traverse")
                    return {"status": "ok", "no_op": True}
                self._nav_position -= 1
                self._history_traversal = True
                self._is_loading = True
                self._broadcast_status()
                try:
                    await self._page.go_back(wait_until="domcontentloaded")
                except Exception as e:
                    self._nav_position += 1  # Revert on error
                    self._history_traversal = False
                    self._is_loading = False
                    raise
                # Event listener will handle metadata update
            elif cmd_type == "forward":
                if self._nav_position >= len(self._nav_history) - 1:
                    logger.info("[WEB_SESSION] Forward navigation requested with no forward history")
                    return {"status": "ok", "no_op": True}
                self._nav_position += 1
                self._history_traversal = True
                self._is_loading = True
                self._broadcast_status()
                try:
                    await self._page.go_forward(wait_until="domcontentloaded")
                except Exception as e:
                    self._nav_position -= 1  # Revert on error
                    self._history_traversal = False
                    self._is_loading = False
                    raise
                # Event listener will handle metadata update
            elif cmd_type == "click":
                x = payload.get("x")
                y = payload.get("y")
                button = payload.get("button", "left")
                if x is None or y is None:
                    raise WebSessionError("invalid_command", "click command missing coordinates")
                await self._page.mouse.click(float(x), float(y), button=button)
            elif cmd_type == "scroll":
                delta_x = float(payload.get("deltaX", 0.0))
                delta_y = float(payload.get("deltaY", 0.0))
                await self._page.mouse.wheel(delta_x, delta_y)
            elif cmd_type in {"key", "type"}:
                text = payload.get("text") or ""
                key = payload.get("key")
                if text:
                    await self._page.keyboard.type(text)
                elif key:
                    await self._page.keyboard.press(key)
                else:
                    raise WebSessionError("invalid_command", "key command missing key or text")
            else:
                raise WebSessionError("unknown_command", f"Command '{cmd_type}' is not supported")

            # Only manually update metadata for commands that need it
            # Back/forward rely on event listener to avoid race conditions
            if metadata_required and cmd_type not in ("back", "forward"):
                await self._update_page_metadata()
            return {"status": "ok"}

    # ------------------------------------------------------------------ #
    # Search integration
    # ------------------------------------------------------------------ #
    def run_structured_search(self, queries: List[str], results_per_query: int) -> Dict[str, Any]:
        return self._run_sync(self._run_structured_search_async(queries, results_per_query))

    async def _run_structured_search_async(self, queries: List[str], results_per_query: int) -> Dict[str, Any]:
        if not queries:
            return {}

        results: Dict[str, Any] = {}
        for query in queries:
            try:
                results[query] = await self._run_single_search(query, results_per_query)
            except WebSessionError as exc:
                results[query] = {
                    "status": "error",
                    "error": str(exc),
                    "results": [],
                    "count": 0,
                    "metadata": {"code": exc.code},
                }

        return results

    async def _run_single_search(self, query: str, limit: int) -> Dict[str, Any]:
        if not self._page or not self._command_lock:
            raise WebSessionError("session_inactive", "Browser session is not ready")

        async with self._command_lock:
            search_url = f"https://www.google.com/search?q={query}&num={min(max(limit, 1), 10)}&hl=en"
            await self._page.goto(search_url, wait_until="domcontentloaded", timeout=60000)
            await self._page.wait_for_selector("div#search", timeout=20000)

            results = await self._page.evaluate(
                """
                (maxResults) => {
                    const items = [];
                    const blocks = document.querySelectorAll('div#search div.g');
                    for (const block of blocks) {
                        if (items.length >= maxResults) break;
                        const link = block.querySelector('a');
                        const titleEl = block.querySelector('h3');
                        const snippetEl = block.querySelector('.VwiC3b, .yXK7lf');
                        if (!link || !titleEl) continue;
                        items.push({
                            title: titleEl.textContent?.trim() || '',
                            url: link.href,
                            snippet: snippetEl?.textContent?.trim() || '',
                            source: link.hostname || new URL(link.href).hostname,
                            date: block.querySelector('span.f')?.textContent || 'N/A'
                        });
                    }
                    return items;
                }
                """,
                min(max(limit, 1), 10),
            )

            await self._update_page_metadata()
            return {
                "status": "success",
                "results": results,
                "count": len(results),
                "metadata": {
                    "search_url": self._page.url,
                    "timestamp": time.time(),
                },
            }


web_session_manager = WebSessionManager()
