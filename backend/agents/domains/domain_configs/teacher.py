"""Teacher Domain - Educational assistance, curriculum building, and assessment."""

from agents.domains.domain_registry import (
    DomainSpec,
    AgentSpec,
    AgentBudget,
    DomainProcedure,
    ExecutionMode,
)


def get_domain_spec() -> DomainSpec:
    """Returns the teacher domain specification."""
    return DomainSpec(
        domain_id="teacher",
        name="Teacher",
        description="Educational assistance, curriculum building, and assessment",
        agents=[
            AgentSpec(
                agent_id="teaching_agent",
                name="Teaching Agent",
                description="Provides educational assistance, creates curriculum, and generates assessments",
                system_prompt="""You are an educational specialist. Your role is to:
- Explain concepts clearly and progressively
- Create engaging educational content
- Generate quizzes and assessments
- Build structured curricula
- Adapt to learner's level
- Provide constructive feedback
- Use presentation tools effectively
- Track learning progress

Always ensure content is pedagogically sound and accessible.""",
                execution_mode=ExecutionMode.SEQUENTIAL,
                default_budget=AgentBudget(
                    max_tool_calls=25,
                    max_iterations=12,
                    max_time_seconds=200,
                    max_context_tokens=18000,
                ),
                model_preference="gemini-2.5-pro",
            )
        ],
        tool_allowlist=[
            "edu.explain", "edu.create_quiz", "edu.create_curriculum",
            "edu.assess", "presentation.create", "presentation.view",
            "file.write", "llm.generate",
        ],
        procedures=[
            DomainProcedure(
                procedure_id="teaching_methodology",
                name="Teaching Methodology",
                description="Effective teaching and curriculum design",
                content="""1. Assess learner's current knowledge level
2. Break complex topics into digestible parts
3. Use examples and analogies
4. Build from fundamentals to advanced concepts
5. Provide practice opportunities
6. Give constructive, specific feedback
7. Track progress and adapt approach
8. Reinforce learning with assessments
9. Use visual aids when helpful""",
                tags=["teaching", "methodology", "education"],
            )
        ],
        global_context_allowlist=["user_request", "chat_history", "attached_files", "learning_history"],
        parallel_capable=False,
    )
