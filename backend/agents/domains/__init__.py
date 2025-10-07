"""Domain system for ATLAS2 single domain execution.

This package contains the domain registry, domain configurations,
and related infrastructure for the single domain execution mode.

Domain configurations are auto-discovered from the domain_configs/ subdirectory.
Each domain is defined in its own file for better maintainability and scalability.
"""

from agents.domains.domain_registry import (
    domain_registry,
    DomainRegistry,
    DomainSpec,
    AgentSpec,
    AgentBudget,
    DomainProcedure,
    ExecutionMode,
)

from agents.domains import domain_configs

__all__ = [
    "domain_registry",
    "DomainRegistry",
    "DomainSpec",
    "AgentSpec",
    "AgentBudget",
    "DomainProcedure",
    "ExecutionMode",
]
