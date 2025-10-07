"""
Domain configurations package - Auto-discovers and registers all domains.
"""

from pathlib import Path
import importlib
from typing import List

from agents.domains.domain_registry import domain_registry, DomainSpec
from utils.logger import get_logger


logger = get_logger(__name__)


def discover_and_register_domains() -> List[str]:
    """Auto-discover all domain modules in this package and register them.

    Returns:
        List of registered domain IDs
    """
    registered_domains = []
    domain_configs_dir = Path(__file__).parent

    domain_files = [
        f for f in domain_configs_dir.glob("*.py")
        if f.name != "__init__.py" and not f.name.startswith("_")
    ]

    for domain_file in sorted(domain_files):
        module_name = domain_file.stem  

        try:
            module = importlib.import_module(f"agents.domains.domain_configs.{module_name}")

            if hasattr(module, "get_domain_spec"):
                domain_spec: DomainSpec = module.get_domain_spec()
                domain_registry.register(domain_spec)
                registered_domains.append(domain_spec.domain_id)
                logger.info(f"Registered domain '{domain_spec.domain_id}' from {module_name}.py")
            else:
                logger.warning(f"Module {module_name}.py does not have get_domain_spec() function, skipping")

        except Exception as e:
            logger.error(f"Failed to load domain from {module_name}.py: {e}")

    logger.info(f"Domain auto-discovery complete: {len(registered_domains)} domains registered")
    return registered_domains


_registered = discover_and_register_domains()


__all__ = ["discover_and_register_domains"]
