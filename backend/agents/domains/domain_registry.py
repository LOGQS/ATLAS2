"""Domain Registry System for Single Domain Execution.

This module provides the abstraction layer for managing domains, agents, and their configurations.
Each domain represents a specialized capability area with its own agents, tools, and procedures.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
from enum import Enum

from utils.logger import get_logger


logger = get_logger(__name__)


class ExecutionMode(Enum):
    """Execution modes for agents within a domain."""
    SEQUENTIAL = "sequential" 
    PARALLEL = "parallel" 
    ADAPTIVE = "adaptive" 


@dataclass
class AgentBudget:
    """Resource budgets for agent execution."""
    max_tool_calls: Optional[int] = None
    max_iterations: Optional[int] = None
    max_time_seconds: Optional[int] = None
    max_context_tokens: Optional[int] = None


@dataclass
class AgentSpec:
    """Specification for an agent within a domain."""
    agent_id: str
    name: str
    description: str
    system_prompt: str
    execution_mode: ExecutionMode
    default_budget: AgentBudget
    model_preference: Optional[str] = None
    # Two-model spec-driven development (used by coder domain)
    planner_model: Optional[str] = None  # Model for planning phase
    writer_model: Optional[str] = None  # Model for execution phase
    writer_fallback_models: Optional[List[str]] = None  # Fallback models for rate limits

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "agent_id": self.agent_id,
            "name": self.name,
            "description": self.description,
            "system_prompt": self.system_prompt,
            "execution_mode": self.execution_mode.value,
            "default_budget": {
                "max_tool_calls": self.default_budget.max_tool_calls,
                "max_iterations": self.default_budget.max_iterations,
                "max_time_seconds": self.default_budget.max_time_seconds,
                "max_context_tokens": self.default_budget.max_context_tokens,
            },
            "model_preference": self.model_preference,
            "planner_model": self.planner_model,
            "writer_model": self.writer_model,
            "writer_fallback_models": self.writer_fallback_models,
        }


@dataclass
class DomainProcedure:
    """A retrievable procedure/knowledge bank for a domain."""
    procedure_id: str
    name: str
    description: str
    content: str  
    tags: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "procedure_id": self.procedure_id,
            "name": self.name,
            "description": self.description,
            "content": self.content,
            "tags": self.tags,
        }


@dataclass
class DomainSpec:
    """Complete specification for a domain."""
    domain_id: str
    name: str
    description: str
    agents: List[AgentSpec]
    tool_allowlist: List[str] 
    procedures: List[DomainProcedure]
    global_context_allowlist: List[str]  
    parallel_capable: bool = False 

    def get_agent(self, agent_id: str) -> Optional[AgentSpec]:
        """Get an agent by ID."""
        for agent in self.agents:
            if agent.agent_id == agent_id:
                return agent
        return None

    def get_procedure(self, procedure_id: str) -> Optional[DomainProcedure]:
        """Get a procedure by ID."""
        for procedure in self.procedures:
            if procedure.procedure_id == procedure_id:
                return procedure
        return None

    def search_procedures(self, tags: List[str]) -> List[DomainProcedure]:
        """Search procedures by tags."""
        results = []
        for procedure in self.procedures:
            if any(tag in procedure.tags for tag in tags):
                results.append(procedure)
        return results

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "domain_id": self.domain_id,
            "name": self.name,
            "description": self.description,
            "agents": [agent.to_dict() for agent in self.agents],
            "tool_allowlist": self.tool_allowlist,
            "procedures": [proc.to_dict() for proc in self.procedures],
            "global_context_allowlist": self.global_context_allowlist,
            "parallel_capable": self.parallel_capable,
        }


class DomainRegistry:
    """Registry of available domains."""

    def __init__(self):
        self._domains: Dict[str, DomainSpec] = {}
        self._logger = get_logger(__name__)

    def register(self, spec: DomainSpec) -> None:
        """Register a domain specification."""
        if spec.domain_id in self._domains:
            self._logger.warning(f"Domain {spec.domain_id} already registered, overwriting")
        self._domains[spec.domain_id] = spec
        self._logger.info(f"Registered domain {spec.domain_id} with {len(spec.agents)} agent(s)")

    def get(self, domain_id: str) -> DomainSpec:
        """Get a domain by ID."""
        if domain_id not in self._domains:
            raise KeyError(f"Domain {domain_id} is not registered")
        return self._domains[domain_id]

    def list(self) -> List[str]:
        """List all registered domain IDs."""
        return sorted(self._domains.keys())

    def get_all_domains(self) -> List[DomainSpec]:
        """Get all registered domain specifications."""
        return list(self._domains.values())

    def find_agent(self, domain_id: str, agent_id: str) -> Optional[AgentSpec]:
        """Find an agent in a specific domain."""
        try:
            domain = self.get(domain_id)
            return domain.get_agent(agent_id)
        except KeyError:
            return None

    def get_domain_descriptions_for_router(self) -> str:
        """Get formatted domain descriptions for router prompt.

        Returns:
            Formatted string of all domains with their descriptions for router consumption.
        """
        if not self._domains:
            return "No domains available."

        lines = []
        for domain_id in sorted(self._domains.keys()):
            domain = self._domains[domain_id]
            lines.append(f"- {domain_id}: {domain.description}")

        return "\n".join(lines)

    def get_available_domains(self) -> List[Dict[str, str]]:
        """Get list of available domains with their metadata.

        Returns:
            List of dicts containing domain_id, name, and description.
        """
        return [
            {
                "domain_id": domain.domain_id,
                "name": domain.name,
                "description": domain.description
            }
            for domain in sorted(self._domains.values(), key=lambda d: d.domain_id)
        ]


domain_registry = DomainRegistry()
