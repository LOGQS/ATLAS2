"""Format validator for router responses"""

import re
from utils.logger import get_logger

logger = get_logger(__name__)

def extract_route_choice(router_response: str) -> str:
    """Extract the route choice from router response.

    Args:
        router_response: The full response from the router model

    Returns:
        The selected route name (e.g., "simple" or "complex")

    Raises:
        ValueError: If the response format is invalid
    """
    if not router_response:
        raise ValueError("Router response is empty")

    choice_pattern = r'<CHOICE>\s*(.+?)\s*</CHOICE>'
    match = re.search(choice_pattern, router_response, re.IGNORECASE | re.DOTALL)

    if not match:
        logger.error(f"Could not find <CHOICE> tag in router response: {router_response[:200]}...")
        raise ValueError("Invalid router response format - missing <CHOICE> tag")

    choice = match.group(1).strip()

    from utils.config import available_routes
    valid_routes = [route["route_name"] for route in available_routes]

    if choice not in valid_routes:
        logger.error(f"Invalid route choice '{choice}'. Valid routes: {valid_routes}")
        raise ValueError(f"Invalid route choice: {choice}")

    logger.debug(f"Extracted route choice: {choice}")
    return choice

def validate_router_response_format(response: str) -> bool:
    """Validate that router response contains all required tags.

    Args:
        response: The router response to validate

    Returns:
        True if format is valid, False otherwise
    """
    required_tags = ['<ROUTE>', '</ROUTE>', '<CHOICE>', '</CHOICE>']

    for tag in required_tags:
        if tag not in response:
            logger.warning(f"Router response missing required tag: {tag}")
            return False

    return True