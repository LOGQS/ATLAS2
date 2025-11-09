"""Web Domain - Unified web research, browser automation, and web interaction.

This domain merges web research and browser control capabilities under a single
orchestrated agent that can switch between modes based on task requirements.
"""

from agents.domains.domain_registry import (
    DomainSpec,
    AgentSpec,
    AgentBudget,
    DomainProcedure,
    ExecutionMode,
)


def get_domain_spec() -> DomainSpec:
    """Returns the unified web domain specification."""
    return DomainSpec(
        domain_id="web",
        name="Web Agent",
        description="Unified web research, browser automation, and web interaction",
        agents=[
            AgentSpec(
                agent_id="web_agent",
                name="Web Agent",
                description="Orchestrates web research and browser control with planning and multi-mode execution",
                system_prompt="""You are a web operations specialist. Your role is to:
- Plan web-related tasks systematically
- Conduct comprehensive web research and information gathering
- Control browsers for automation and interaction
- Extract and synthesize information from multiple sources
- Navigate websites and interact with web elements
- Handle dynamic content and page loads
- Coordinate research and automation tasks efficiently

You can operate in multiple modes:
- Research mode: Web searches, academic databases, document extraction, synthesis
- Control mode: Browser navigation, scraping, form filling, screenshots
- Coordinated mode: Combine both capabilities for complex tasks

Always prioritize accuracy, source credibility, and robust error handling.""",
                execution_mode=ExecutionMode.ADAPTIVE,
                default_budget=AgentBudget(
                    max_tool_calls=40,
                    max_iterations=20,
                    max_time_seconds=300,
                    max_context_tokens=20000,
                ),
                model_preference="gemini-2.5-flash-preview-09-2025",
                # Three-phase architecture: planning + dual execution modes
                planner_model="gemini-2.5-flash-preview-09-2025",
                # Note: Execution model selection will be handled by phase-specific instructions
                # Research mode and Control mode both use the same base model but different contexts
            )
        ],
        tool_allowlist=[
            # Web research tools
            "web.search", "web.fetch", "academic.search", "document.extract",
            "text.summarize", "citation.format",
            # Browser control tools
            "browser.navigate", "browser.click", "browser.fill_form", "browser.wait",
            "browser.screenshot", "browser.scrape", "browser.new_tab", "browser.execute_js",
            # Shared tools
            "text.extract", "llm.generate",
            # Plan management
            "plan.write", "plan.update",
        ],
        procedures=[
            DomainProcedure(
                procedure_id="web_task_methodology",
                name="Web Task Methodology",
                description="Systematic approach to web research and automation",
                content="""1. Analyze task requirements and scope
2. Determine which modes are needed (research, control, or both)
3. Create structured execution plan
4. For research tasks:
   - Start with broad searches, then narrow down
   - Verify information across multiple sources
   - Prioritize credible and recent sources
   - Extract key facts and citations
   - Synthesize findings coherently
5. For browser control tasks:
   - Navigate to target URLs
   - Wait for page loads and dynamic content
   - Identify and interact with elements
   - Handle pagination and navigation flows
   - Screenshot for verification
   - Extract data systematically
6. For coordinated tasks:
   - Execute research phase first (gather information)
   - Use research insights to guide browser interactions
   - Validate browser-extracted data against research
7. Handle errors gracefully with retries
8. Document sources and actions taken""",
                tags=["web", "research", "automation", "methodology"],
            ),
            DomainProcedure(
                procedure_id="research_methodology",
                name="Research Methodology",
                description="Information gathering and synthesis",
                content="""1. Define research scope and key questions
2. Execute parallel searches when appropriate
3. Access academic databases for scholarly sources
4. Extract relevant information from documents
5. Evaluate source credibility and quality
6. Organize findings by topic/theme
7. Synthesize into coherent summary with citations
8. Prioritize primary sources and recent information""",
                tags=["research", "information-gathering", "synthesis"],
            ),
            DomainProcedure(
                procedure_id="browser_automation_workflow",
                name="Browser Automation Workflow",
                description="Reliable web scraping and interaction",
                content="""1. Navigate to target URL
2. Wait for page to fully load (handle dynamic content)
3. Identify key elements to interact with or extract
4. Execute interactions (clicks, form fills, etc.)
5. Handle pagination if present
6. Extract data systematically with validation
7. Screenshot for verification and debugging
8. Manage multiple tabs when needed
9. Handle authentication and cookies
10. Implement retry logic for network errors""",
                tags=["browser", "automation", "scraping", "workflow"],
            ),
        ],
        global_context_allowlist=["user_request", "chat_history", "attached_files"],
        parallel_capable=True,  # Can spawn multiple instances for parallel operations
    )
