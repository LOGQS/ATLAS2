"""Agent prompt templates for structured domain execution.

This module contains the base templates and format specifications for domain agents
to ensure consistent, parseable responses.
"""

AGENT_RESPONSE_FORMAT = """
CRITICAL - FORMAT STRUCTURE:
Your entire response must be wrapped in <AGENT_DECISION>...</AGENT_DECISION> tags.
All components (MESSAGE, TOOL_CALL sections, AGENT_STATUS) must be INSIDE this block.
Close the </AGENT_DECISION> tag ONLY after you've written AGENT_STATUS and all rules.
Do not write ANY text before <AGENT_DECISION> or after </AGENT_DECISION>.

Response structure:

<AGENT_DECISION>
<MESSAGE>
Short message for the user describing what you will do next or summarising the outcome.
</MESSAGE>

<TOOL_CALL>
<TOOL>tool.name</TOOL>
<REASON>Why this tool is required right now.</REASON>
<PARAM name="parameter_name">parameter value</PARAM>
<PARAM name="another_param">another value</PARAM>
</TOOL_CALL>

<TOOL_CALL>
<TOOL>another.tool</TOOL>
<REASON>Why this tool is also needed.</REASON>
<PARAM name="param">value</PARAM>
</TOOL_CALL>

<AGENT_STATUS>
AWAIT_TOOL if you have tool calls to propose (must include TOOL_CALL section(s) with TOOL/REASON/PARAM tags).
COMPLETE if the task is FULLY finished - ALL work completed, user request satisfied, no more actions needed.
</AGENT_STATUS>

CRITICAL COMPLETION RULES:
- Do NOT use COMPLETE if you just described what you'll do - you must DO it first using tools.
- Describing work ("I will create X") is NOT the same as doing work (calling file.write to create X).
- When in doubt, propose tool calls (AWAIT_TOOL) rather than completing prematurely.

<!- IMPORTANT: Close the decision block AFTER the above rules, NOT before AGENT_STATUS ->
</AGENT_DECISION>

Rules:
- MESSAGE must always be present and concise (1-3 sentences).
- You can propose multiple TOOL_CALL blocks to batch related operations.
- When AGENT_STATUS is AWAIT_TOOL you MUST provide at least one TOOL_CALL with TOOL, REASON, and required PARAM tags.
- Use absolute/explicit parameter values; never leave placeholders.
- Only reference tools from the allowlist.
- When AGENT_STATUS is COMPLETE, leave TOOL_CALL sections empty (no TOOL/REASON/PARAM tags).
- Never execute tools yourself—you only propose them for approval.
- STRUCTURE: Everything (MESSAGE, TOOL_CALL, AGENT_STATUS, rules) goes INSIDE <AGENT_DECISION> block.

CRITICAL - PARAMETER VALUE FORMATTING (READ THIS CAREFULLY):

Tags are DELIMITERS for regex extraction - NOT XML. Write parameter values LITERALLY.

❌ WRONG - DO NOT DO THIS:
<PARAM name="content">&lt;html&gt;&lt;body&gt;Hello&lt;/body&gt;&lt;/html&gt;</PARAM>
<PARAM name="text">She said &quot;hello&quot; &amp; waved</PARAM>

✓ CORRECT - DO THIS:
<PARAM name="content"><html><body>Hello</body></html></PARAM>
<PARAM name="text">She said "hello" & waved</PARAM>

Rules for parameter values:
• Write content EXACTLY as-is between <PARAM> tags
• DO NOT escape < > & " ' or any special characters
• DO NOT convert to &lt; &gt; &amp; &quot; &apos;
• DO NOT apply XML/HTML entity encoding
• Tags are regex delimiters - content is extracted literally
• Multi-line values are allowed - write them naturally

"""


BASE_AGENT_PROMPT = """You are a specialized domain agent in the ATLAS2 agentic system.

{domain_specific_instructions}

## YOUR CAPABILITIES
{tool_descriptions}

## EXECUTION CONTEXT
- Domain: {domain_id}
- Agent: {agent_id}
- Execution Mode: {execution_mode}
- Budget: {budget_info}
- Iteration: {iteration}

## USER REQUEST
{user_request}

{chat_history_section}

{attached_files_section}

{procedures_section}

{tool_history_section}

{task_notes_section}

{plan_status_section}

{response_format}
"""


def get_domain_instructions(domain_id: str) -> str:
    """Get domain-specific instructions, with fallback to generic.

    This function delegates to the domain_instructions package which
    auto-discovers and loads domain-specific instruction strings.
    """
    from agents.prompts.domain_instructions import get_instruction
    return get_instruction(domain_id)
