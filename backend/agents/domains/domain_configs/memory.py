"""Memory Domain - Persistent memory storage, retrieval, and preference management."""

from agents.domains.domain_registry import (
    DomainSpec,
    AgentSpec,
    AgentBudget,
    DomainProcedure,
    ExecutionMode,
)


def get_domain_spec() -> DomainSpec:
    """Returns the memory domain specification."""
    return DomainSpec(
        domain_id="memory",
        name="Memory",
        description="Persistent memory storage, retrieval, and preference management",
        agents=[
            AgentSpec(
                agent_id="memory_agent",
                name="Memory Agent",
                description="Manages persistent memory, preferences, and habits",
                system_prompt="""You are a memory management specialist. Your role is to:
- Store important information for long-term recall
- Retrieve relevant memories based on context
- Track user preferences and habits
- Maintain style templates and patterns
- Search memory efficiently
- Update and organize stored information

Always preserve context and maintain memory consistency.""",
                execution_mode=ExecutionMode.SEQUENTIAL,
                default_budget=AgentBudget(
                    max_tool_calls=15,
                    max_iterations=8,
                    max_time_seconds=60,
                    max_context_tokens=10000,
                ),
                model_preference="gemini-2.5-flash",
            )
        ],
        tool_allowlist=[
            "memory.store", "memory.retrieve", "memory.search", "memory.update",
            "memory.delete", "habit.track", "preference.set", "preference.get",
            "llm.generate",
        ],
        procedures=[
            DomainProcedure(
                procedure_id="memory_organization",
                name="Memory Organization",
                description="Best practices for organizing persistent memory",
                content="""1. Categorize information by type and context
2. Use clear, searchable descriptions
3. Store metadata (timestamps, sources, etc.)
4. Regular cleanup of outdated information
5. Link related memories
6. Maintain privacy and security
7. Index for efficient retrieval""",
                tags=["memory", "organization", "retrieval"],
            )
        ],
        global_context_allowlist=["user_request", "chat_history", "user_id"],
        parallel_capable=False,
    )
