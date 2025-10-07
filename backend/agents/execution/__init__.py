"""Execution engine for ATLAS2 agentic system.

This package contains executors for different execution modes:
- Single domain execution
- Multi-domain orchestration (future)
- Iterative refinement (future)
"""

from agents.execution.single_domain_executor import (
    single_domain_executor,
    SingleDomainExecutor,
    DomainExecutionContext,
    ActionRecord,
)

__all__ = [
    "single_domain_executor",
    "SingleDomainExecutor",
    "DomainExecutionContext",
    "ActionRecord",
]
