"""
Domain instructions package - Auto-discovers and loads all domain-specific instructions.
"""

from pathlib import Path
import importlib
from typing import Dict

from utils.logger import get_logger


logger = get_logger(__name__)


def _discover_domain_instructions() -> Dict[str, str]:
    """Auto-discover all domain instruction modules in this package.

    Returns:
        Dictionary mapping domain_id to instruction string
    """
    instructions = {}
    instructions_dir = Path(__file__).parent

    instruction_files = [
        f for f in instructions_dir.glob("*.py")
        if f.name != "__init__.py" and not f.name.startswith("_")
    ]

    for instruction_file in sorted(instruction_files):
        module_name = instruction_file.stem  # domain_id

        try:
            module = importlib.import_module(f"agents.prompts.domain_instructions.{module_name}")

            if hasattr(module, "get_domain_instruction"):
                instruction = module.get_domain_instruction()
                instructions[module_name] = instruction
                logger.info(f"Loaded domain instruction for '{module_name}' from {instruction_file.name}")
            else:
                logger.warning(f"Module {instruction_file.name} does not have get_domain_instruction() function, skipping")

        except Exception as e:
            logger.error(f"Failed to load domain instruction from {instruction_file.name}: {e}")

    logger.info(f"Domain instruction auto-discovery complete: {len(instructions)} instructions loaded")
    return instructions


# Auto-discover and load all domain instructions on module import
_DOMAIN_INSTRUCTIONS = _discover_domain_instructions()


def get_instruction(domain_id: str) -> str:
    """Get domain-specific instruction string by domain_id.

    Args:
        domain_id: The domain identifier (e.g., "coder", "web_researcher")

    Returns:
        The domain-specific instruction string, or a default if not found
    """
    return _DOMAIN_INSTRUCTIONS.get(
        domain_id,
        "You are a specialized agent. Follow your domain guidelines and user instructions carefully."
    )


__all__ = ["get_instruction"]
