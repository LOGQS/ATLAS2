"""Web Researcher Domain - Research and information gathering from web and academic sources."""

from agents.domains.domain_registry import (
    DomainSpec,
    AgentSpec,
    AgentBudget,
    DomainProcedure,
    ExecutionMode,
)


def get_domain_spec() -> DomainSpec:
    """Returns the web researcher domain specification."""
    return DomainSpec(
        domain_id="web_researcher",
        name="Web Researcher",
        description="Research and information gathering from web and academic sources",
        agents=[
            AgentSpec(
                agent_id="research_agent",
                name="Research Agent",
                description="Gathers, analyzes, and synthesizes information from multiple sources",
                system_prompt="""You are a research specialist. Your role is to:
- Conduct comprehensive web searches
- Access academic databases and papers
- Extract relevant information from documents
- Synthesize findings into coherent summaries
- Prioritize primary sources and credible information
- Gather information efficiently with parallel searches when appropriate

Always cite sources and evaluate information quality.""",
                execution_mode=ExecutionMode.PARALLEL,
                default_budget=AgentBudget(
                    max_tool_calls=20,
                    max_iterations=10,
                    max_time_seconds=180,
                    max_context_tokens=15000,
                ),
                model_preference="gemini-2.5-flash",
            )
        ],
        tool_allowlist=[
            "web.search", "web.fetch", "academic.search", "document.extract",
            "text.summarize", "citation.format", "llm.generate",
        ],
        procedures=[
            DomainProcedure(
                procedure_id="research_methodology",
                name="Research Methodology",
                description="Systematic approach to information gathering",
                content="""1. Define research scope and key questions
2. Start with broad searches, then narrow down
3. Verify information across multiple sources
4. Prioritize recent and authoritative sources
5. Extract key facts and quotes accurately
6. Organize findings by topic/theme
7. Synthesize into cohesive summary""",
                tags=["methodology", "research", "information-gathering"],
            )
        ],
        global_context_allowlist=["user_request", "chat_history"],
        parallel_capable=True,
    )
