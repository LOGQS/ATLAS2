"""
Coder domain pattern definitions using the agentic framework.

These patterns enable robust, validated pattern extraction for the coder domain.

Note: "Thoughts" come from the API response's separate field (include_thoughts parameter),
NOT from parsing the agent's text response. These patterns only extract what's in the
actual response content.
"""

from agentic import PatternSet, Pattern, SegmentType


CODER_PATTERN_SET = PatternSet(
    name="coder",
    patterns=[
        Pattern(
            name="message",
            start_tag="<MESSAGE>",
            end_tag="</MESSAGE>",
            segment_type=SegmentType.RESPONSE,
            greedy=False,
            expected_format=None 
        ),
        Pattern(
            name="tool_call",
            start_tag="<TOOL_CALL>",
            end_tag="</TOOL_CALL>",
            segment_type=SegmentType.TOOL,
            greedy=False,
            expected_format="line"  
        ),
        Pattern(
            name="agent_status",
            start_tag="<AGENT_STATUS>",
            end_tag="</AGENT_STATUS>",
            segment_type=SegmentType.RESPONSE,
            greedy=False,
            expected_format=None  
        ),
    ],
    default_response_behavior="explicit_only" 
)