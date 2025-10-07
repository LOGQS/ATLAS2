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

    def get_all_tools(self) -> List[ToolSpec]:
        return list(self._tools.values())


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

    from agents.context.context_manager import context_manager
    token_estimate = context_manager.estimate_request_tokens(
        role="agent_tools",
        provider=provider,
        model=model,
        system_prompt=None,
        chat_history=[],
        current_message=prompt,
        file_attachments=attachments
    )
    from agents.context.context_manager import ContextManager
    num_tools = len(tool_registry.get_all_tools())
    tool_overhead_tokens = num_tools * ContextManager.TOOL_OVERHEAD_TOKENS_PER_TOOL
    total_estimated = token_estimate['estimated_tokens']['total'] + tool_overhead_tokens
    _logger.debug(f"Agent tool estimated tokens: {total_estimated} (prompt: {token_estimate['estimated_tokens']['total']}, tool overhead: {tool_overhead_tokens})")

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

    actual_tokens_data = context_manager.extract_actual_tokens_from_response(response, provider)
    actual_tokens_count = actual_tokens_data['total_tokens'] if actual_tokens_data else 0

    estimated_tokens_with_overhead = total_estimated

    token_usage = actual_tokens_data if actual_tokens_data else {
        'total_tokens': estimated_tokens_with_overhead
    }

    from utils.db_utils import db
    if actual_tokens_count > 0:
        db.save_token_usage(
            chat_id=ctx.chat_id,
            role='agent_tools',
            provider=provider,
            model=model,
            estimated_tokens=0,
            actual_tokens=actual_tokens_count,
            plan_id=ctx.plan_id
        )
    else:
        db.save_token_usage(
            chat_id=ctx.chat_id,
            role='agent_tools',
            provider=provider,
            model=model,
            estimated_tokens=estimated_tokens_with_overhead,
            actual_tokens=0,
            plan_id=ctx.plan_id
        )
    _logger.debug(f"[TokenUsage] Saved agent_tools token usage for chat {ctx.chat_id}, task {ctx.task_id}")

    output_text = response.get("text", "")
    metadata = {
        "provider": provider,
        "model": model,
        "thoughts": response.get("thoughts"),
        "usage": token_usage,
        "token_estimate": token_estimate,
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
        in_schema={
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "The prompt to send to the language model"
                },
                "provider": {
                    "type": "string",
                    "description": "Provider to use (defaults to configured default provider)"
                },
                "model": {
                    "type": "string",
                    "description": "Model to use (defaults to configured default model)"
                },
                "include_thoughts": {
                    "type": "boolean",
                    "default": False,
                    "description": "Include reasoning/thoughts in the response"
                },
                "commit_to_context": {
                    "type": "boolean",
                    "default": True,
                    "description": "Save the result to conversation context"
                },
                "attached_file_ids": {
                    "type": "array",
                    "description": "File IDs to attach to this generation"
                },
                "role": {
                    "type": "string",
                    "default": "assistant",
                    "description": "Role for the message (assistant, user, etc.)"
                }
            },
            "required": ["prompt"]
        },
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

    try:
        from .file_ops.read_func import read_file_spec
        from .file_ops.write_func import write_file_spec
        from .file_ops.edit_func import edit_file_spec
        from .file_ops.move_func import move_file_spec
        from .file_ops.move_lines_func import move_lines_spec
        from .file_ops.search_func import search_files_spec
        from .file_ops.list_func import list_dir_spec
        from .file_ops.attach_func import attach_file_spec

        tool_registry.register(read_file_spec)
        tool_registry.register(write_file_spec)
        tool_registry.register(edit_file_spec)
        tool_registry.register(move_file_spec)
        tool_registry.register(move_lines_spec)
        tool_registry.register(search_files_spec)
        tool_registry.register(list_dir_spec)
        tool_registry.register(attach_file_spec)
        _logger.info("File operations tools registered successfully")
    except ImportError as e:
        _logger.warning(f"Could not import file operations tools: {e}")
    except Exception as e:
        _logger.error(f"Error registering file operations tools: {e}")

    try:
        from .plan_tools import write_plan_spec, update_plan_spec

        tool_registry.register(write_plan_spec)
        tool_registry.register(update_plan_spec)
        _logger.info("Plan management tools registered successfully")
    except ImportError as e:
        _logger.warning(f"Could not import plan tools: {e}")
    except Exception as e:
        _logger.error(f"Error registering plan tools: {e}")


register_builtin_tools()
