# status: complete

from typing import TypedDict, Optional, List, Dict, Any


class TokenBreakdownDict(TypedDict):
    """Token breakdown for a single component"""
    estimated: int
    actual: int
    calls: int


class EstimatedTokensDict(TypedDict):
    """Estimated tokens broken down by component"""
    system_prompt: int
    chat_history: int
    current_message: int
    file_attachments: int
    total: int


class FileBreakdownEntry(TypedDict):
    """Token breakdown for a single file attachment"""
    file: str
    estimated_tokens: int
    method: str


class PerMessageBreakdown(TypedDict):
    """Token breakdown for a single message"""
    index: int
    role: str
    content_preview: str
    tokens: int


class BreakdownDetails(TypedDict):
    """Detailed breakdown of token estimation"""
    system_prompt_tokens: int
    system_prompt_present: bool
    history_messages_count: int
    history_total_tokens: int
    per_message_breakdown: List[PerMessageBreakdown]
    current_message_tokens: int
    current_message_length: int
    file_count: int
    file_breakdown: List[FileBreakdownEntry]


class TokenEstimationResult(TypedDict):
    """Result of token estimation for a request"""
    role: str
    estimated_tokens: EstimatedTokensDict
    method: str
    model: str
    provider: str
    breakdown_details: BreakdownDetails


class TokenUsageDict(TypedDict):
    """Actual token usage from provider response"""
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cached_tokens: Optional[int]


class MessageTokensResult(TypedDict):
    """Result of counting tokens in messages"""
    total: int
    per_message: List[int]
    method: str


class SegmentInfo(TypedDict):
    """Information about a prompt segment"""
    label: str
    tokens: int
    content_preview: str


class RequestTotalInfo(TypedDict):
    """Total token information for a request"""
    tokens: int
    method: str
    is_estimated: bool


class InputOutputInfo(TypedDict):
    """Input or output information for a request"""
    total: RequestTotalInfo
    segments: List[SegmentInfo]


class SystemPromptInfo(TypedDict):
    """System prompt information in analysis"""
    content: Optional[str]
    tokens: int
    method: str
    is_estimated: bool


class RequestAnalysis(TypedDict):
    """Analysis of a single request"""
    role: str
    label: str
    provider: str
    model: str
    input: InputOutputInfo
    output: Optional[InputOutputInfo]
    notes: List[str]


class InteractionAnalysis(TypedDict):
    """Complete interaction analysis result"""
    chat_id: str
    system_prompt: SystemPromptInfo
    requests: List[RequestAnalysis]
    generated_at: int


class RoleInfoDict(TypedDict):
    """Provider and model information for a role"""
    provider: str
    model: str
    method: str
    last_used: str
