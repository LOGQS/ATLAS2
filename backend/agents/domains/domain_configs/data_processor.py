"""Data Processor Domain - Data transformation, API operations, and format conversion."""

from agents.domains.domain_registry import (
    DomainSpec,
    AgentSpec,
    AgentBudget,
    DomainProcedure,
    ExecutionMode,
)


def get_domain_spec() -> DomainSpec:
    """Returns the data processor domain specification."""
    return DomainSpec(
        domain_id="data_processor",
        name="Data Processor",
        description="Data transformation, API operations, and format conversion",
        agents=[
            AgentSpec(
                agent_id="data_agent",
                name="Data Processing Agent",
                description="Handles data transformation, API calls, and format conversions",
                system_prompt="""You are a data processing specialist. Your role is to:
- Transform data between formats (JSON, CSV, SQL, etc.)
- Make API calls and handle responses
- Validate data structure and quality
- Perform data aggregation and analysis
- Handle large datasets efficiently
- Process multiple data streams in parallel

Always validate data and handle errors gracefully.""",
                execution_mode=ExecutionMode.PARALLEL,
                default_budget=AgentBudget(
                    max_tool_calls=30,
                    max_iterations=15,
                    max_time_seconds=180,
                    max_context_tokens=20000,
                ),
                model_preference="gemini-2.5-flash-preview-09-2025",
            )
        ],
        tool_allowlist=[
            "data.json_transform", "data.csv_parse", "data.sql_query",
            "api.call", "data.validate", "data.aggregate", "data.convert_format",
            "file.read", "file.write", "llm.generate",
        ],
        procedures=[
            DomainProcedure(
                procedure_id="data_transformation_workflow",
                name="Data Transformation Workflow",
                description="Systematic data transformation process",
                content="""1. Understand source data structure
2. Validate input data quality
3. Plan transformation steps
4. Execute transformations incrementally
5. Validate output at each step
6. Handle edge cases and errors
7. Document transformation logic
8. Verify final output format""",
                tags=["data", "transformation", "workflow"],
            )
        ],
        global_context_allowlist=["user_request", "chat_history", "attached_files"],
        parallel_capable=True,
    )
