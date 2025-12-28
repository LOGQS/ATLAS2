"""Domain system for ATLAS2 single domain execution.

Domain configurations are auto-discovered from domain_configs/ subdirectory.
"""

from agents.domains.domain_registry import domain_registry
from agents.domains import domain_configs as _domain_configs # triggers auto-discovery

__all__ = ["domain_registry"]
