from __future__ import annotations

import asyncio
import concurrent.futures
import random
import re
import urllib.parse
import uuid
from typing import Any, Dict, List, Optional
import psutil

from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode, GeolocationConfig, UndetectedAdapter, ProxyConfig, RoundRobinProxyStrategy
from crawl4ai.async_crawler_strategy import AsyncPlaywrightCrawlerStrategy
from crawl4ai.async_dispatcher import MemoryAdaptiveDispatcher, RateLimiter
from crawl4ai import CrawlerMonitor, DisplayMode

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec

_logger = get_logger(__name__)

# Anti-detection configuration pools
_US_LOCALES = ["en-US"]
_US_TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"]
_US_GEOLOCATIONS = [
    {"latitude": 40.7128, "longitude": -74.0060},  # NYC
    {"latitude": 41.8781, "longitude": -87.6298},  # Chicago
    {"latitude": 34.0522, "longitude": -118.2437}, # LA
    {"latitude": 37.7749, "longitude": -122.4194}, # SF
]

_DATE_PATTERNS = [
    re.compile(r"\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b"),
    re.compile(r"\b\d{4}-\d{2}-\d{2}\b"),
    re.compile(r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+\d{4}\b", re.IGNORECASE),
    re.compile(r"\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b", re.IGNORECASE),
]

_NOISE_KEYWORDS = (
    "feedback", "videos", "short videos", "images", "news", "top stories",
    "shopping results", "discussions and forums", "people also search",
    "related searches", "things to know", "people also ask"
)

_BLOCK_SPLIT_RE = re.compile(r'\n###\s+')
_EXCLUDE_URL_PATTERNS = [
    re.compile(r'google\.(com|de|co\.uk)/search\?', re.IGNORECASE),
    re.compile(r'google\.(com|de|co\.uk)/(setprefs|webhp|intl|preferences|history|url)', re.IGNORECASE),
    re.compile(r'(accounts|policies|support|translate)\.google\.com', re.IGNORECASE),
    re.compile(r'/url\?.*[?&](ved|sa|ei)=', re.IGNORECASE),
]


def _normalize_text(value: str) -> str:
    """Normalize whitespace and remove stray markdown characters."""
    if not value:
        return ""
    value = re.sub(r"[_`*]+", " ", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip(" -–—\u00a0")


def _clean_url(candidate: str) -> str:
    """Remove scroll-to-text fragments and trailing punctuation from URLs."""
    if not candidate:
        return ""
    cleaned = re.sub(r'#:~:text=.*$', '', candidate)
    cleaned = re.sub(r'[,;\s]+$', '', cleaned)
    return cleaned.strip()


def _fallback_source_from_url(url: str) -> str:
    """Derive a human-readable source name from a URL."""
    try:
        netloc = urllib.parse.urlparse(url).netloc.lower()
    except Exception:
        return "N/A"
    if not netloc:
        return "N/A"
    netloc = netloc.split(":")[0]
    if netloc.startswith("www."):
        netloc = netloc[4:]
    parts = netloc.split(".")
    if len(parts) >= 2 and len(parts[-1]) <= 3:
        core = parts[-2]
    else:
        core = parts[0]
    return core.upper() if len(core) <= 4 else core.capitalize()


def _is_source_candidate(line: str) -> bool:
    """Heuristic to determine whether a line is likely the result source."""
    stripped = line.strip()
    if not stripped:
        return False
    words = stripped.split()
    if len(words) > 10:
        return False
    lower = stripped.lower()
    if stripped.startswith(("http", "www", "[", "!", "#", "*")):
        return False
    if any(keyword in lower for keyword in _NOISE_KEYWORDS) or "translate.google" in lower:
        return False
    if re.search(r'[.,!?]{2,}', stripped):
        return False
    if re.search(r"https?://", stripped):
        return False
    return any(ch.isalpha() for ch in stripped)


def _is_noise_line(line: str) -> bool:
    """Return True if the line should be ignored when building snippets."""
    stripped = line.strip()
    if not stripped:
        return True
    lower = stripped.lower()
    if stripped.startswith(("![", "[", "#", "*", "http", "www")):
        return True
    if "translate.google" in lower:
        return True
    if any(keyword in lower for keyword in _NOISE_KEYWORDS):
        return True
    if stripped == stripped.upper() and len(stripped.split()) <= 3:
        return True
    if "·" in stripped or "youtube" in lower:
        return True
    if lower.startswith(("show more", "show all", "view all")):
        return True
    return False


def _extract_date_fragment(text: str) -> str:
    """Extract the first recognizable date fragment from text."""
    if not text:
        return "N/A"
    for pattern in _DATE_PATTERNS:
        match = pattern.search(text)
        if match:
            return match.group(0)
    return "N/A"


def _detect_captcha(content: str) -> bool:
    """Detect CAPTCHA in page content."""
    if not content:
        return False
    indicators = [
        "unusual traffic",
        "verify you're not a robot",
        "prove you're human",
    ]
    return any(ind in content.lower() for ind in indicators)


def _check_system_memory(threshold_percent: float = 85.0) -> tuple[bool, float]:
    """
    Check if system has enough available memory.

    Returns:
        (is_ok, memory_percent): True if memory is below threshold, current memory percentage
    """

    try:
        memory = psutil.virtual_memory()
        memory_percent = memory.percent
        is_ok = memory_percent < threshold_percent

        if not is_ok:
            _logger.warning(f"System memory usage high: {memory_percent:.1f}% (threshold: {threshold_percent}%)")
        else:
            _logger.debug(f"System memory OK: {memory_percent:.1f}%")

        return is_ok, memory_percent
    except Exception as e:
        _logger.warning(f"Failed to check system memory: {e}")
        return True, 0.0


def _fetch_free_proxies_from_source() -> List[str]:
    """
    Fetch free proxy list from public GitHub source.

    Returns:
        List of proxy strings in format "ip:port"
    """
    import urllib.request

    proxy_sources = [
        "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt",
        "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text"
    ]

    proxies = []
    for source_url in proxy_sources:
        try:
            _logger.debug(f"Fetching proxies from {source_url}")
            req = urllib.request.Request(source_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=10) as response:
                content = response.read().decode('utf-8')
                for line in content.splitlines():
                    line = line.strip()
                    if line and not line.startswith('#'):
                        # Basic validation: ip:port format
                        if ':' in line and len(line.split(':')) == 2:
                            proxies.append(line)

            if len(proxies) >= 10:  # Found enough proxies, stop fetching
                break

        except Exception as e:
            _logger.debug(f"Failed to fetch from {source_url}: {e}")
            continue

    return proxies[:20]  # Return max 20 proxies to avoid overhead


def _load_proxies() -> Optional[Any]:
    """
    Load proxies from proxies.txt file if available, or auto-fetch from GitHub sources.

    File format (one proxy per line):
        ip:port:username:password
        or ip:port (without authentication)

    Returns:
        RoundRobinProxyStrategy if proxies loaded successfully, None otherwise
    """
    from pathlib import Path
    import time

    # Look for proxies.txt in data/web folder
    project_root = Path(__file__).parent.parent.parent.parent
    data_web_dir = project_root / "data" / "web"
    data_web_dir.mkdir(parents=True, exist_ok=True)  # Create if doesn't exist
    proxy_file = data_web_dir / "proxies.txt"

    # Check if file exists and is recent (< 24 hours old)
    file_is_recent = False
    if proxy_file.exists():
        file_age_hours = (time.time() - proxy_file.stat().st_mtime) / 3600
        file_is_recent = file_age_hours < 24

    # Auto-fetch proxies if file doesn't exist or is old
    if not proxy_file.exists() or not file_is_recent:
        _logger.info("Fetching free proxies from GitHub sources...")
        fetched_proxies = _fetch_free_proxies_from_source()

        if fetched_proxies:
            _logger.info(f"Fetched {len(fetched_proxies)} proxies, saving to {proxy_file}")
            with open(proxy_file, 'w') as f:
                f.write("# Auto-fetched free proxies\n")
                f.write("# Format: ip:port or ip:port:username:password\n")
                f.write(f"# Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
                for proxy in fetched_proxies:
                    f.write(f"{proxy}\n")
        else:
            _logger.warning("Failed to fetch proxies from any source. Proceeding without proxies.")
            return None

    # Load proxies from file
    if not proxy_file.exists():
        return None

    proxies = []
    with open(proxy_file, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue

            parts = line.split(':')
            if len(parts) == 2:
                # ip:port -> http://ip:port
                proxies.append(ProxyConfig(server=f"http://{parts[0]}:{parts[1]}"))
            elif len(parts) == 4:
                # ip:port:username:password
                proxies.append(ProxyConfig(
                    server=f"http://{parts[0]}:{parts[1]}",
                    username=parts[2],
                    password=parts[3]
                ))
            else:
                _logger.warning(f"Invalid proxy format: {line}")

    if proxies:
        _logger.info(f"Loaded {len(proxies)} proxies for rotation")
        return RoundRobinProxyStrategy(proxies)

    _logger.debug("No valid proxies found")
    return None


def _extract_results_from_google_markdown(markdown: str) -> List[Dict[str, str]]:
    """Extract search results from Google markdown."""
    results = []
    seen_urls = set()
    blocks = _BLOCK_SPLIT_RE.split('\n' + markdown)

    for block in blocks:
        block = block.strip()
        if not block or '[' not in block:
            continue

        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines or not lines[0].startswith('['):
            continue

        raw_title = lines[0]
        title = _normalize_text(raw_title.lstrip('[').split(']')[0])
        if not title:
            continue

        url_matches = re.findall(r'\]\((https?://[^\)]+)\)', block)
        if not url_matches:
            continue

        url = None
        for candidate in url_matches:
            cleaned = _clean_url(candidate)
            if not cleaned:
                continue
            if any(pattern.search(cleaned) for pattern in _EXCLUDE_URL_PATTERNS) or cleaned in seen_urls:
                continue
            url = cleaned
            break

        if not url:
            continue

        source = "N/A"
        source_idx = 0
        for idx, line in enumerate(lines[1:], 1):
            if _is_source_candidate(line):
                source = _normalize_text(line)
                source_idx = idx
                break

        snippet_lines = []
        snippet_start = source_idx + 1 if source != "N/A" else 1
        paa_detected = False
        for line in lines[snippet_start:]:
            if _is_noise_line(line):
                if any(keyword in line.lower() for keyword in _NOISE_KEYWORDS):
                    paa_detected = True
                continue

            if paa_detected:
                break

            cleaned_line = _normalize_text(line)
            if not cleaned_line:
                continue

            if snippet_lines and cleaned_line.endswith('?'):
                break

            snippet_lines.append(cleaned_line)
            if cleaned_line.endswith('.') or len(' '.join(snippet_lines)) >= 200:
                break

        snippet = ' '.join(snippet_lines).strip() or "N/A"
        date_fragment = _extract_date_fragment(' '.join(snippet_lines)) if snippet != "N/A" else "N/A"
        if date_fragment == "N/A":
            date_fragment = _extract_date_fragment(block)

        snippet = snippet.replace(date_fragment, '').strip()
        snippet = _normalize_text(snippet)
        if not snippet:
            snippet = "N/A"

        if date_fragment != "N/A" and not re.search(r'\d', date_fragment):
            date_fragment = "N/A"

        if source == "N/A":
            source = _fallback_source_from_url(url)

        seen_urls.add(url)
        results.append({
            "title": title,
            "url": url,
            "snippet": snippet,
            "source": source,
            "date": date_fragment or "N/A",
        })

    return results


def _create_browser_config(headless: bool, managed_ready: bool, browser_profile: Optional[str], use_undetected: bool = False):
    """Create optimized browser configuration with anti-detection."""
    viewport_width = random.randint(1366, 1920)
    viewport_height = random.randint(768, 1080)

    extra_args = [
        "--lang=en-US",
        "--accept-lang=en-US,en;q=0.9",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-notifications",
        "--disable-popup-blocking",
        "--disable-save-password-bubble",
        "--disable-translate",
        "--disable-extensions",
    ]

    return {
        "browser_type": "chromium",
        "headless": headless,
        "verbose": False,
        "enable_stealth": True,
        "user_agent_mode": "random",
        "viewport_width": viewport_width,
        "viewport_height": viewport_height,
        "use_persistent_context": managed_ready,
        "user_data_dir": str(browser_profile) if browser_profile else None,
        "use_managed_browser": managed_ready,
        "java_script_enabled": True,
        "text_mode": True,  # Performance: disable images for search results
        "light_mode": True,  # Performance: reduce background features
        "extra_args": extra_args,
        "headers": {
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Referer": "https://www.google.com/",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
        },
    }


def _build_search_url(query: str, page_num: int) -> str:
    """Build Google search URL for given query and page number."""
    params = {"q": query, "hl": "en", "gl": "us"}
    if page_num > 0:
        params["start"] = page_num * 10
    query_string = urllib.parse.urlencode(params, safe=":+")
    return f"https://www.google.com/search?{query_string}"


def _run_async_in_thread(coro):
    """Execute async coroutine safely from sync context."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        with concurrent.futures.ThreadPoolExecutor() as executor:
            return executor.submit(asyncio.run, coro).result()

    new_loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(new_loop)
        return new_loop.run_until_complete(coro)
    finally:
        asyncio.set_event_loop(None)
        new_loop.close()


async def _search_single_query(
    crawler,
    query: str,
    num_results: int,
    locale: str,
    timezone_id: str,
    geolocation: dict,
    proxy_strategy: Optional[Any] = None,
) -> tuple[List[Dict[str, str]], dict]:
    """Search single query with pagination using arun_many() and dispatcher."""
    max_pages = 3
    urls = [_build_search_url(query, page) for page in range(max_pages)]

    # Create base config using .clone() pattern
    base_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        locale=locale,
        timezone_id=timezone_id,
        geolocation=GeolocationConfig(**geolocation),
        simulate_user=True,
        override_navigator=True,
        magic=True,
        wait_for="css:#search",
        remove_overlay_elements=True,
        page_timeout=15000,
        delay_before_return_html=1.5,
        wait_until="networkidle",
        proxy_rotation_strategy=proxy_strategy,  # Optional proxy rotation
    )

    # Create dispatcher with built-in rate limiting and memory management
    dispatcher = MemoryAdaptiveDispatcher(
        memory_threshold_percent=85.0,
        check_interval=1.0,
        max_session_permit=max_pages,
        rate_limiter=RateLimiter(
            base_delay=(1.5, 3.0),
            max_delay=30.0,
            max_retries=3,
            rate_limit_codes=[429, 503]
        ),
        monitor=CrawlerMonitor()  # Simplified - use default settings
    )

    _logger.info(f"Crawling {max_pages} pages for query: '{query[:50]}...'")

    # Use arun_many() with dispatcher for parallel page crawling
    results = await crawler.arun_many(
        urls=urls,
        config=base_config,
        dispatcher=dispatcher
    )

    # Process results and extract search data
    all_results: List[Dict[str, str]] = []
    seen_urls: set[str] = set()
    metadata = {
        "pages_crawled": 0,
        "pages_failed": 0,
        "captcha_detected": False,
        "total_memory_mb": 0.0,
        "total_duration_sec": 0.0,
    }

    for idx, result in enumerate(results):
        if not result.success:
            metadata["pages_failed"] += 1
            _logger.warning(f"Page {idx+1} failed for query '{query[:30]}...': {result.error_message}")
            continue

        # Track dispatch metadata
        if result.dispatch_result:
            metadata["total_memory_mb"] += result.dispatch_result.memory_usage
            duration = (result.dispatch_result.end_time - result.dispatch_result.start_time).total_seconds()
            metadata["total_duration_sec"] += duration

        # Check for CAPTCHA
        if _detect_captcha(result.markdown):
            metadata["captcha_detected"] = True
            _logger.warning(f"CAPTCHA detected on page {idx+1} for query '{query[:30]}...'")
            continue

        metadata["pages_crawled"] += 1

        # Extract results from this page
        page_results = _extract_results_from_google_markdown(result.markdown)
        for search_result in page_results:
            if search_result["url"] not in seen_urls:
                seen_urls.add(search_result["url"])
                all_results.append(search_result)
                if len(all_results) >= num_results:
                    break

        # Early exit if we have enough results
        if len(all_results) >= num_results:
            break

    return all_results[:num_results], metadata


async def _execute_searches_with_persistent_browser(
    queries: List[str],
    results_per_query: int,
    profile_ready: bool,
    browser_profile: Optional[str],
    max_concurrent: int = 3,
) -> Dict[str, Any]:
    """Execute searches using persistent browser with parallel query execution."""
    results_by_query = {}

    # Load optional proxy rotation strategy
    proxy_strategy = _load_proxies()
    if proxy_strategy:
        _logger.info("Proxy rotation enabled")
    else:
        _logger.debug("No proxies configured, using direct connection")

    # Create browser config with .clone() pattern
    browser_config_dict = _create_browser_config(
        headless=True,
        managed_ready=profile_ready,
        browser_profile=browser_profile,
        use_undetected=False,
    )
    browser_config = BrowserConfig(**browser_config_dict)

    # Try with regular stealth mode first
    try:
        async with AsyncWebCrawler(config=browser_config) as crawler:
            _logger.info(f"Starting parallel search for {len(queries)} queries (max_concurrent={max_concurrent})")

            # Control query-level concurrency with semaphore (page-level handled by dispatcher)
            semaphore = asyncio.Semaphore(max_concurrent)

            async def search_with_semaphore(query: str) -> tuple[str, Any]:
                """Execute search with concurrency control."""
                async with semaphore:
                    try:
                        _logger.info(f"Starting search for query: '{query}'")

                        # Randomize locale/timezone/geo per query for anti-detection
                        locale = random.choice(_US_LOCALES)
                        timezone_id = random.choice(_US_TIMEZONES)
                        geolocation = random.choice(_US_GEOLOCATIONS)

                        results, metadata = await _search_single_query(
                            crawler,
                            query,
                            results_per_query,
                            locale,
                            timezone_id,
                            geolocation,
                            proxy_strategy,
                        )

                        return query, {
                            "status": "success",
                            "results": results,
                            "count": len(results),
                            "metadata": metadata,
                        }
                    except Exception as e:
                        _logger.error(f"Search failed for query '{query}': {str(e)}")
                        return query, {
                            "status": "error",
                            "error": str(e),
                            "results": [],
                            "count": 0,
                            "metadata": {},
                        }

            # Execute all queries in parallel (controlled by semaphore)
            search_results = await asyncio.gather(*[search_with_semaphore(q) for q in queries])

            # Convert to dictionary
            for query, result_data in search_results:
                results_by_query[query] = result_data

        return results_by_query

    except Exception as first_attempt_error:
        _logger.warning(f"Regular crawl failed, trying UndetectedAdapter: {str(first_attempt_error)}")

        try:
            # Fallback to undetected browser (non-headless)
            browser_config_dict["headless"] = False
            browser_config_undetected = BrowserConfig(**browser_config_dict)
            strategy = AsyncPlaywrightCrawlerStrategy(
                browser_config=browser_config_undetected,
                browser_adapter=UndetectedAdapter(),
            )

            async with AsyncWebCrawler(crawler_strategy=strategy, config=browser_config_undetected) as crawler:
                semaphore = asyncio.Semaphore(max_concurrent)

                async def search_with_semaphore_undetected(query: str) -> tuple[str, Any]:
                    async with semaphore:
                        try:
                            locale = random.choice(_US_LOCALES)
                            timezone_id = random.choice(_US_TIMEZONES)
                            geolocation = random.choice(_US_GEOLOCATIONS)

                            results, metadata = await _search_single_query(
                                crawler, query, results_per_query, locale, timezone_id, geolocation, proxy_strategy
                            )
                            return query, {
                                "status": "success",
                                "results": results,
                                "count": len(results),
                                "metadata": metadata,
                            }
                        except Exception as e:
                            return query, {
                                "status": "error",
                                "error": str(e),
                                "results": [],
                                "count": 0,
                                "metadata": {},
                            }

                search_results = await asyncio.gather(*[search_with_semaphore_undetected(q) for q in queries])

                for query, result_data in search_results:
                    results_by_query[query] = result_data

            return results_by_query

        except Exception as undetected_error:
            _logger.error(f"UndetectedAdapter fallback failed: {str(undetected_error)}")
            raise undetected_error


def _format_search_results(results_by_query: Dict[str, Any]) -> str:
    """Format search results into readable text output."""
    output_lines = []

    for query, data in results_by_query.items():
        output_lines.append(f"### Search Results for: \"{query}\"")

        if data["status"] == "error":
            output_lines.append(f"ERROR: {data.get('error', 'Unknown error')}")
            output_lines.append("")
            continue

        results = data["results"]
        if not results:
            output_lines.append("No results found.")
            output_lines.append("")
            continue

        for idx, result in enumerate(results, 1):
            output_lines.append(f"{idx}. {result['title']}")
            output_lines.append(f"   URL: {result['url']}")
            output_lines.append(f"   Snippet: {result['snippet']}")
            output_lines.append(f"   Date: {result.get('date', 'N/A')}")
            output_lines.append(f"   Source: {result.get('source', 'N/A')}")
            output_lines.append("")

    return "\n".join(output_lines)


def _tool_web_search(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Perform Google web search using crawl4ai with enhanced anti-detection.

    This tool:
    - Uses persistent browser session for faster execution
    - Executes multiple queries in parallel (up to 3 concurrent)
    - Progressive anti-detection: Stealth → UndetectedAdapter fallback
    - Performance optimizations: text_mode, light_mode, reduced timeouts
    - Supports single or multiple queries
    - Extracts structured results (title, URL, snippet, date, source)
    - Implements retry logic with CAPTCHA detection
    """
    query_param = params.get("query")
    results_per_query = params.get("results_per_query", 5)

    if not query_param:
        raise ValueError("query parameter is required")

    # Normalize query to list
    if isinstance(query_param, str):
        queries = [query_param]
    elif isinstance(query_param, list):
        queries = [str(q).strip() for q in query_param if str(q).strip()]
    else:
        raise ValueError("query must be a string or list of strings")

    if not queries:
        raise ValueError("At least one query is required")

    if not isinstance(results_per_query, int) or results_per_query < 1:
        raise ValueError("results_per_query must be a positive integer")

    if results_per_query > 10:
        raise ValueError("results_per_query cannot exceed 10 (maximum: 10)")

    # Check if browser profile is ready
    from utils.web_browser_profile import check_profile_exists, get_profile_status, get_profile_dir

    profile_ready = check_profile_exists()
    browser_profile = get_profile_dir() if profile_ready else None

    if not profile_ready:
        profile_status = get_profile_status()
        _logger.warning(
            f"Managed browser profile not found at {profile_status['path']}. "
            "Search will use default browser profile with reduced anti-detection. "
            "For better results, set up the managed profile first."
        )

    # Check system memory before starting
    memory_ok, memory_percent = _check_system_memory(threshold_percent=85.0)
    if not memory_ok:
        _logger.warning(
            f"High system memory usage ({memory_percent:.1f}%). "
            "Search may be slower or fail. Consider closing other applications."
        )

    # Execute searches with persistent browser and parallel execution
    try:
        results_by_query = _run_async_in_thread(
            _execute_searches_with_persistent_browser(
                queries,
                results_per_query,
                profile_ready,
                browser_profile,
                max_concurrent=min(3, len(queries)),  # Max 3 concurrent queries
            )
        )
    except Exception as e:
        _logger.error(f"Web search execution failed: {str(e)}")
        # Return error for all queries
        results_by_query = {
            query: {
                "status": "error",
                "error": str(e),
                "results": [],
                "count": 0,
            }
            for query in queries
        }

    formatted_output = _format_search_results(results_by_query)

    success_count = sum(1 for data in results_by_query.values() if data["status"] == "success")
    error_count = len(results_by_query) - success_count
    total_results = sum(data.get("count", 0) for data in results_by_query.values())

    # Aggregate performance metadata from DispatchResult
    total_pages_crawled = sum(data.get("metadata", {}).get("pages_crawled", 0) for data in results_by_query.values())
    total_pages_failed = sum(data.get("metadata", {}).get("pages_failed", 0) for data in results_by_query.values())
    total_memory_mb = sum(data.get("metadata", {}).get("total_memory_mb", 0.0) for data in results_by_query.values())
    total_duration_sec = sum(data.get("metadata", {}).get("total_duration_sec", 0.0) for data in results_by_query.values())
    captcha_count = sum(1 for data in results_by_query.values() if data.get("metadata", {}).get("captcha_detected", False))

    return ToolResult(
        output={
            "status": "completed",
            "queries_processed": len(queries),
            "queries_successful": success_count,
            "queries_failed": error_count,
            "total_results": total_results,
            "results_by_query": results_by_query,
            "formatted_output": formatted_output,
            "profile_ready": profile_ready,
        },
        metadata={
            "total_queries": len(queries),
            "total_results": total_results,
            "profile_used": profile_ready,
            "pages_crawled": total_pages_crawled,
            "pages_failed": total_pages_failed,
            "total_memory_mb": round(total_memory_mb, 2),
            "total_duration_sec": round(total_duration_sec, 2),
            "captcha_detected_count": captcha_count,
        }
    )


web_search_spec = ToolSpec(
    name="web.search",
    version="1.0",
    description=(
        "Search Google function"
        "Returns structured results (title, URL, snippet, date, source) for each query. "
    ),
    effects=["net"],
    in_schema={
        "type": "object",
        "properties": {
            "query": {
                "description": "Search query or list of queries to execute",
                "oneOf": [
                    {"type": "string"},
                    {"type": "array", "items": {"type": "string"}}
                ]
            },
            "results_per_query": {
                "type": "integer",
                "default": 10,
                "description": "Number of results to return per query (1-10, default: 10)"
            }
        },
        "required": ["query"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "queries_processed": {"type": "integer"},
            "queries_successful": {"type": "integer"},
            "queries_failed": {"type": "integer"},
            "total_results": {"type": "integer"},
            "results_by_query": {"type": "object"},
            "formatted_output": {"type": "string"},
            "profile_ready": {"type": "boolean"}
        }
    },
    fn=_tool_web_search,
    rate_key="web.search"
)
