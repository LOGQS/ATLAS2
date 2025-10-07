"""Web Controller Domain - Browser automation, web scraping, and web interaction."""

from agents.domains.domain_registry import (
    DomainSpec,
    AgentSpec,
    AgentBudget,
    DomainProcedure,
    ExecutionMode,
)


def get_domain_spec() -> DomainSpec:
    """Returns the web controller domain specification."""
    return DomainSpec(
        domain_id="web_controller",
        name="Web Controller",
        description="Browser automation, web scraping, and web interaction",
        agents=[
            AgentSpec(
                agent_id="browser_agent",
                name="Browser Agent",
                description="Controls browser for navigation, scraping, and web automation",
                system_prompt="""You are a browser automation specialist. Your role is to:
- Navigate websites precisely
- Handle dynamic content and page loads
- Fill forms and interact with web elements
- Extract structured data from pages
- Manage multiple browser tabs when needed
- Handle authentication and cookies
- Screenshot and analyze pages visually

Always wait for page loads and handle dynamic content properly.""",
                execution_mode=ExecutionMode.ADAPTIVE,
                default_budget=AgentBudget(
                    max_tool_calls=25,
                    max_iterations=12,
                    max_time_seconds=200,
                    max_context_tokens=12000,
                ),
                model_preference="gemini-2.5-flash",
            )
        ],
        tool_allowlist=[
            "browser.navigate", "browser.click", "browser.fill_form", "browser.wait",
            "browser.screenshot", "browser.scrape", "browser.new_tab",
            "browser.execute_js", "text.extract", "llm.generate",
        ],
        procedures=[
            DomainProcedure(
                procedure_id="web_scraping_workflow",
                name="Web Scraping Workflow",
                description="Reliable web scraping methodology",
                content="""1. Navigate to target URL
2. Wait for page to fully load
3. Identify key elements to extract
4. Handle pagination if present
5. Extract data systematically
6. Verify data quality
7. Handle errors and retries gracefully
8. Screenshot for verification""",
                tags=["scraping", "workflow", "browser"],
            )
        ],
        global_context_allowlist=["user_request", "chat_history"],
        parallel_capable=True,
    )
