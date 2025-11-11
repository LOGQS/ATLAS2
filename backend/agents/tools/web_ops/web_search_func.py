from __future__ import annotations

import asyncio
import concurrent.futures
import random
import re
import time
import urllib.parse
import uuid
from typing import Any, Dict, List, Optional

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


async def _crawl_google_search_async(
    query: str,
    start_page: int = 0,
    session_id: Optional[str] = None,
    headless: bool = True,
) -> str:
    """Async Google search using crawl4ai with managed browser profile."""
    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode, GeolocationConfig
    except ImportError:
        raise ImportError(
            "crawl4ai not installed. Install with: pip install crawl4ai && crawl4ai-setup"
        )

    from utils.web_browser_profile import get_profile_dir, check_profile_exists

    params = {"q": query, "hl": "en", "gl": "us"}
    if start_page:
        params["start"] = start_page
    query_string = urllib.parse.urlencode(params, safe=":+")
    url = f"https://www.google.com/search?{query_string}"

    managed_ready = check_profile_exists()
    browser_profile = get_profile_dir() if managed_ready else None

    viewport_width = random.randint(1366, 1920)
    viewport_height = random.randint(768, 1080)
    locale = random.choice(_US_LOCALES)
    timezone_id = random.choice(_US_TIMEZONES)
    geolocation = random.choice(_US_GEOLOCATIONS)

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

    browser_config = BrowserConfig(
        browser_type="chromium",
        headless=headless,
        verbose=False,
        enable_stealth=True,
        user_agent_mode="random",
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        use_persistent_context=managed_ready,
        user_data_dir=str(browser_profile) if browser_profile else None,
        use_managed_browser=managed_ready,
        java_script_enabled=True,
        extra_args=extra_args,
        headers={
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Referer": "https://www.google.com/",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
        },
    )

    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        session_id=session_id,
        locale=locale,
        timezone_id=timezone_id,
        geolocation=GeolocationConfig(**geolocation),
        simulate_user=True,
        override_navigator=True,
        magic=True,
        wait_for="css:#search",
        remove_overlay_elements=True,
        page_timeout=20000,
        delay_before_return_html=2.0,
        wait_until="networkidle",
    )

    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(url=url, config=run_config)
        if not result.success:
            raise RuntimeError(f"Crawl failed: {result.error_message}")
        return result.markdown


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


def _search_google_with_retry(query: str, num_results: int, max_attempts: int = 3) -> List[Dict[str, str]]:
    """Search Google with retry logic and CAPTCHA detection."""
    all_results: List[Dict[str, str]] = []
    seen_urls: set[str] = set()
    page = 0
    max_pages = 3

    session_id = f"session-{uuid.uuid4().hex}"

    while len(all_results) < num_results and page < max_pages:
        start_index = page * 10

        for attempt in range(max_attempts):
            try:
                headless = True if attempt < max_attempts - 1 else False

                _logger.info(f"Searching Google: query='{query[:50]}...', page={page+1}, attempt={attempt+1}, headless={headless}")

                markdown = _run_async_in_thread(
                    _crawl_google_search_async(
                        query,
                        start_page=start_index,
                        session_id=session_id,
                        headless=headless,
                    )
                )

                if _detect_captcha(markdown):
                    _logger.warning(f"CAPTCHA detected, attempt {attempt+1}/{max_attempts}")
                    if attempt < max_attempts - 1:
                        time.sleep(5.0 * (attempt + 1))
                        continue
                    else:
                        raise RuntimeError("CAPTCHA detected after all attempts")

                page_results = _extract_results_from_google_markdown(markdown)
                if not page_results:
                    _logger.debug(f"No results found on page {page + 1} for query '{query}'")
                    break

                for result in page_results:
                    if result["url"] in seen_urls:
                        continue
                    seen_urls.add(result["url"])
                    all_results.append(result)
                    if len(all_results) >= num_results:
                        break

                break

            except Exception as e:
                _logger.warning(f"Search attempt {attempt+1} failed: {str(e)}")
                if attempt == max_attempts - 1:
                    raise RuntimeError(f"Failed to search after {max_attempts} attempts: {str(e)}")
                time.sleep(3.0 * (attempt + 1))

        page += 1
        if len(all_results) < num_results and page < max_pages:
            time.sleep(random.uniform(2.5, 4.0))

    return all_results[:num_results]


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
    Perform Google web search using crawl4ai with anti-detection measures.

    This tool:
    - Searches Google using managed browser profiles for anti-bot detection
    - Supports single or multiple queries
    - Extracts structured results (title, URL, snippet, date, source)
    - Implements retry logic with CAPTCHA detection
    - Returns formatted search results
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
    from utils.web_browser_profile import check_profile_exists, get_profile_status

    profile_ready = check_profile_exists()
    if not profile_ready:
        profile_status = get_profile_status()
        _logger.warning(
            f"Managed browser profile not found at {profile_status['path']}. "
            "Search will use default browser profile with reduced anti-detection. "
            "For better results, set up the managed profile first."
        )

    results_by_query = {}
    total_results = 0

    for query in queries:
        try:
            _logger.info(f"Executing web search for query: '{query}' (requesting {results_per_query} results)")

            results = _search_google_with_retry(query, results_per_query)

            results_by_query[query] = {
                "status": "success",
                "results": results,
                "count": len(results)
            }
            total_results += len(results)

            _logger.info(f"Successfully retrieved {len(results)} results for query '{query}'")

        except Exception as e:
            error_msg = str(e)
            _logger.error(f"Web search failed for query '{query}': {error_msg}")
            results_by_query[query] = {
                "status": "error",
                "error": error_msg,
                "results": [],
                "count": 0
            }

    formatted_output = _format_search_results(results_by_query)

    success_count = sum(1 for data in results_by_query.values() if data["status"] == "success")
    error_count = len(results_by_query) - success_count

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
        }
    )


web_search_spec = ToolSpec(
    name="web.search",
    version="1.0",
    description=(
        "Search Google and extract structured results using crawl4ai with anti-detection measures. "
        "Supports single or multiple queries. Returns title, URL, snippet, date, and source for each result. "
        "Uses managed browser profile when available for improved anti-bot detection."
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
