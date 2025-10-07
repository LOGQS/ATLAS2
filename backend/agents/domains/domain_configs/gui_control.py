"""GUI Control Domain - Application automation and GUI interaction."""

from agents.domains.domain_registry import (
    DomainSpec,
    AgentSpec,
    AgentBudget,
    DomainProcedure,
    ExecutionMode,
)


def get_domain_spec() -> DomainSpec:
    """Returns the GUI control domain specification."""
    return DomainSpec(
        domain_id="gui_control",
        name="GUI Control",
        description="Application automation and GUI interaction on user's system",
        agents=[
            AgentSpec(
                agent_id="gui_automator",
                name="GUI Automator",
                description="Automates GUI interactions, window management, and application control",
                system_prompt="""You are a GUI automation specialist. Your role is to:
- Precisely interact with GUI elements (buttons, inputs, windows)
- Navigate application interfaces efficiently
- Handle dynamic UI states and wait for elements
- Extract information from visual interfaces
- Manage multiple windows and applications

Always verify UI state before actions and handle errors gracefully.""",
                execution_mode=ExecutionMode.SEQUENTIAL,
                default_budget=AgentBudget(
                    max_tool_calls=30,
                    max_iterations=15,
                    max_time_seconds=120,
                    max_context_tokens=8000,
                ),
                model_preference="gemini-2.5-flash",
            )
        ],
        tool_allowlist=[
            "gui.click", "gui.type", "gui.find_element", "gui.screenshot",
            "gui.window_manage", "gui.wait_for_element", "gui.get_text",
            "file.read", "file.write",  
        ],
        procedures=[
            DomainProcedure(
                procedure_id="gui_safe_automation",
                name="Safe GUI Automation",
                description="Best practices for safe and reliable GUI automation",
                content="""1. Always take screenshot before critical actions
2. Verify element existence before interaction
3. Use appropriate wait times for dynamic content
4. Handle popups and unexpected dialogs
5. Maintain cursor position awareness
6. Use keyboard shortcuts when more reliable than clicking""",
                tags=["safety", "reliability", "best-practices"],
            )
        ],
        global_context_allowlist=["user_request", "chat_history", "attached_files"],
        parallel_capable=False,
    )
