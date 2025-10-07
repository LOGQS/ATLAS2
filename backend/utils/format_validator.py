"""Format validator for router responses"""

import re
from typing import Dict, Optional
from utils.logger import get_logger

logger = get_logger(__name__)

def _extract_tag(response: str, tag: str, required: bool = False) -> Optional[str]:
    """Generic tag extraction with optional requirement check."""
    pattern = rf'<{tag}>\s*(.*?)\s*</{tag}>'
    match = re.search(pattern, response, re.IGNORECASE | re.DOTALL)

    if not match:
        if required:
            logger.error(f"Missing required <{tag}> tag in response: {response[:200]}...")
            raise ValueError(f"Invalid router response format - missing <{tag}> tag")
        return None

    return match.group(1).strip()

def extract_route_choice(router_response: str) -> str:
    """Extract and validate the route choice."""
    if not router_response:
        raise ValueError("Router response is empty")

    choice = _extract_tag(router_response, 'CHOICE', required=True)

    from utils.config import available_routes
    valid_routes = [route["route_name"] for route in available_routes]

    if choice not in valid_routes:
        logger.error(f"Invalid route '{choice}'. Valid: {valid_routes}")
        raise ValueError(f"Invalid route choice: {choice}")

    logger.debug(f"Extracted route: {choice}")
    return choice

def extract_tools_needed(response: str) -> Optional[bool]:
    """Extract boolean tools requirement."""
    value = _extract_tag(response, 'TOOLS_NEEDED')
    if not value:
        return None

    value_upper = value.upper()
    if value_upper == "YES":
        return True
    if value_upper == "NO":
        return False

    logger.warning(f"Invalid TOOLS_NEEDED value: {value}")
    return None

def extract_router_metadata(router_response: str) -> Dict[str, any]:
    """Extract all router metadata in one pass."""
    metadata = {
        "choice": None,
        "tools_needed": None,
        "execution_type": None,
        "fastpath_params": None,
        "domain_id": None
    }

    try:
        metadata["choice"] = extract_route_choice(router_response)
    except ValueError as e:
        logger.warning(f"Route extraction failed: {e}")

    metadata["tools_needed"] = extract_tools_needed(router_response)
    metadata["execution_type"] = _extract_tag(router_response, 'EXECUTION_TYPE')
    metadata["domain_id"] = _extract_tag(router_response, 'DOMAIN')

    fastpath = _extract_tag(router_response, 'FASTPATH_PARAMS')
    metadata["fastpath_params"] = fastpath if fastpath else None

    return metadata

def validate_router_response_format(response: str) -> bool:
    """Validate router response contains required tags."""
    required = ['<ROUTE>', '</ROUTE>', '<CHOICE>', '</CHOICE>']

    if not all(tag in response for tag in required):
        missing = [tag for tag in required if tag not in response]
        logger.warning(f"Missing required tags: {missing}")
        return False

    enhanced = ['<TOOLS_NEEDED>', '<EXECUTION_TYPE>']
    if all(tag in response for tag in enhanced):
        logger.debug("Enhanced routing format detected")

    return True
