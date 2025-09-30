# status: alpha

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from chat.chat import Chat
from utils.config import Config
from utils.logger import get_logger


@dataclass
class ToolExecutionContext:
    """Execution context passed to tools."""

    chat_id: str
    plan_id: str
    task_id: str
    ctx_id: str


@dataclass
class ToolResult:
    """Standardised return type for tools."""

    output: Any
    ops: Optional[List[Dict[str, Any]]] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolSpec:
    """Specification and callable for a tool."""

    name: str
    version: str
    description: str
    effects: List[str]
    in_schema: Dict[str, Any]
    out_schema: Dict[str, Any]
    fn: Callable[[Dict[str, Any], ToolExecutionContext], ToolResult]
    rate_key: Optional[str] = None


class ToolRegistry:
    """Registry of available tools."""

    def __init__(self):
        self._tools: Dict[str, ToolSpec] = {}
        self._logger = get_logger(__name__)

    def register(self, spec: ToolSpec) -> None:
        if spec.name in self._tools:
            self._logger.warning("Tool %s already registered, overwriting", spec.name)
        self._tools[spec.name] = spec
        self._logger.info("Registered tool %s v%s", spec.name, spec.version)

    def get(self, name: str) -> ToolSpec:
        if name not in self._tools:
            raise KeyError(f"Tool {name} is not registered")
        return self._tools[name]

    def list(self) -> List[str]:
        return sorted(self._tools.keys())


tool_registry = ToolRegistry()
_logger = get_logger(__name__)


def _compute_input_hash(payload: Dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _tool_llm_generate(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    prompt = params.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("llm.generate requires non-empty string prompt")

    provider = params.get("provider") or Config.get_default_provider()
    model = params.get("model") or Config.get_default_model()
    include_thoughts = bool(params.get("include_thoughts", False))
    attachments = params.get("attached_file_ids") or []

    temp_chat = Chat(chat_id=f"router_temp_agent_{uuid.uuid4().hex}")
    response = temp_chat.generate_text(
        message=prompt,
        provider=provider,
        model=model,
        include_reasoning=include_thoughts,
        use_router=False,
        attached_file_ids=attachments,
    )

    if response.get("error"):
        raise RuntimeError(response["error"])

    output_text = response.get("text", "")
    metadata = {
        "provider": provider,
        "model": model,
        "thoughts": response.get("thoughts"),
        "usage": response.get("usage"),
        "input_hash": _compute_input_hash({
            "prompt": prompt,
            "provider": provider,
            "model": model,
            "include_thoughts": include_thoughts,
            "attachments": attachments,
        }),
    }

    ops: List[Dict[str, Any]] = []
    if params.get("commit_to_context", True):
        ops.append({
            "type": "message.append",
            "role": params.get("role", "assistant"),
            "content": output_text,
            "task_id": ctx.task_id,
            "plan_id": ctx.plan_id,
            "metadata": {
                "provider": provider,
                "model": model,
                "thoughts": response.get("thoughts"),
            },
        })

    return ToolResult(output=output_text, ops=ops, metadata=metadata)


def register_builtin_tools() -> None:
    llm_spec = ToolSpec(
        name="llm.generate",
        version="1.0",
        description="Generate text using language models",
        effects=["net"],
        in_schema={"type": "object"},
        out_schema={"type": "object"},
        fn=_tool_llm_generate,
        rate_key="llm.generate",
    )
    tool_registry.register(llm_spec)
    _logger.info("llm generate tool registered successfully")

    try:
        from .rag.index_func import rag_index_spec
        from .rag.rag_search_func import rag_search_spec

        tool_registry.register(rag_index_spec)
        tool_registry.register(rag_search_spec)
        _logger.info("RAG tools registered successfully")
    except ImportError as e:
        _logger.warning(f"Could not import RAG tools: {e}")
    except Exception as e:
        _logger.error(f"Error registering RAG tools: {e}")


register_builtin_tools()
