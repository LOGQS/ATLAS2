"""Coder Domain - Software development, file operations, and code analysis."""

from agents.domains.domain_registry import (
    DomainSpec,
    AgentSpec,
    AgentBudget,
    DomainProcedure,
    ExecutionMode,
)


def get_domain_spec() -> DomainSpec:
    """Returns the coder domain specification."""
    return DomainSpec(
        domain_id="coder",
        name="Coder",
        description="Software development, file operations, and code analysis",
        agents=[
            AgentSpec(
                agent_id="dev_agent",
                name="Development Agent",
                description="Handles complex software development tasks across multiple files",
                system_prompt="""You are a software development specialist. Your role is to:
- Understand code structure before making changes
- Edit files carefully with proper error handling
- Run tests after changes
- Debug and refactor code
- Maintain code quality and consistency
- Work with designated workspace by default
- Build and verify projects

Always test changes and maintain backwards compatibility.""",
                execution_mode=ExecutionMode.SEQUENTIAL,
                default_budget=AgentBudget(
                    max_tool_calls=40,
                    max_iterations=20,
                    max_time_seconds=300,
                    max_context_tokens=25000,
                ),
                model_preference="gpt-oss-120b",
                # Two-model spec-driven development
                planner_model="gpt-oss-120b",  # Used for planning phase: generates high-level plan + detailed code spec
                writer_model="openrouter/polaris-alpha",  # Used for execution phase: writes actual code
                writer_fallback_models=["minimax/minimax-m2:free", "gpt-oss-120b", "qwen-3-235b-a22b-thinking-2507", "moonshotai/kimi-k2-instruct-0905"],  # Fallback on rate limits
            )
        ],
        tool_allowlist=[
            "file.read", "file.write", "file.edit", "file.move", "file.search",
            "file.list_dir", "file.move_lines", "bash.execute", "git.status",
            "git.add", "git.commit", "code.analyze", "test.run", "llm.generate",
            "plan.write", "plan.update",
        ],
        procedures=[
            DomainProcedure(
                procedure_id="code_modification_workflow",
                name="Code Modification Workflow",
                description="Safe workflow for modifying code",
                content="""1. Read and understand existing code
2. Identify all files that need changes
3. Plan modifications carefully
4. Make changes incrementally
5. Run tests after each change
6. Verify no regressions introduced
7. Document changes if needed
8. Use workspace directory unless specified otherwise""",
                tags=["coding", "workflow", "safety"],
            )
        ],
        global_context_allowlist=["user_request", "chat_history", "attached_files", "workspace_path"],
        parallel_capable=False,
    )
