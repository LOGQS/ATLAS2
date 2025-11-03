"""System Manager Domain - Operating system control and system-level operations."""

from agents.domains.domain_registry import (
    DomainSpec,
    AgentSpec,
    AgentBudget,
    DomainProcedure,
    ExecutionMode,
)


def get_domain_spec() -> DomainSpec:
    """Returns the system manager domain specification."""
    return DomainSpec(
        domain_id="system_manager",
        name="System Manager",
        description="Operating system control and system-level operations",
        agents=[
            AgentSpec(
                agent_id="system_agent",
                name="System Agent",
                description="Manages system-level operations, processes, and configuration",
                system_prompt="""You are a system management specialist. Your role is to:
- Manage system processes and services
- Configure network and system settings
- Monitor system resources
- Perform system optimization
- Handle Windows registry operations carefully
- Require elevated permissions appropriately
- Ensure system stability and security

Always verify operations before execution and warn about destructive actions.""",
                execution_mode=ExecutionMode.SEQUENTIAL,
                default_budget=AgentBudget(
                    max_tool_calls=20,
                    max_iterations=10,
                    max_time_seconds=150,
                    max_context_tokens=10000,
                ),
                model_preference="gemini-2.5-flash-preview-09-2025",
            )
        ],
        tool_allowlist=[
            "system.process_list", "system.process_kill", "system.registry_read",
            "system.registry_write", "system.network_config", "system.resource_monitor",
            "system.service_control", "bash.execute", "llm.generate",
        ],
        procedures=[
            DomainProcedure(
                procedure_id="safe_system_operations",
                name="Safe System Operations",
                description="Safety guidelines for system-level operations",
                content="""1. Always verify system state before changes
2. Create backups before registry modifications
3. Request elevated permissions only when needed
4. Warn user about potentially destructive operations
5. Monitor system resources during operations
6. Log all system changes
7. Have rollback plan for critical operations
8. Test on non-production systems first""",
                tags=["safety", "system", "operations"],
            )
        ],
        global_context_allowlist=["user_request", "system_info"],
        parallel_capable=False,
    )
