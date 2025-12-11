from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, Dict

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec, ProcessingMode
from .file_utils import validate_file_path, format_file_size, get_data_dir

_logger = get_logger(__name__)


def _tool_attach_file(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Attach a file for use with LLM providers (e.g., Gemini API).

    This tool:
    - Validates the file exists and is accessible
    - Uploads the file to the configured provider (e.g., Gemini)
    - Returns an attachment ID for use in subsequent LLM calls
    - Supports both textual and non-textual files
    - Tracks attachments in the file_ops data directory
    """
    file_path = params.get("file_path")
    display_name = params.get("display_name")

    if not file_path:
        raise ValueError("file_path is required")

    is_valid, error_msg, resolved_path = validate_file_path(
        file_path,
        must_exist=True,
        must_be_file=True,
        workspace_root=ctx.workspace_path,
    )
    if not is_valid:
        raise ValueError(f"Cannot attach file: {error_msg}")

    file_size = resolved_path.stat().st_size
    file_name = resolved_path.name
    display_name = display_name or file_name

    try:
        from file_utils.file_provider_manager import file_provider_manager
        from utils.config import Config

        provider_name = Config.get_default_provider()

        limits = file_provider_manager.get_provider_file_limits(provider_name)
        if not limits.get('supported'):
            raise ValueError(
                f"File attachments are not supported by the current provider '{provider_name}'. "
                "Configure a provider that supports file attachments (e.g., Gemini)."
            )

        size_limit = limits.get('size_limit', 0)
        if file_size > size_limit:
            raise ValueError(
                f"File '{file_path}' is too large ({format_file_size(file_size)}). "
                f"Maximum allowed size for {provider_name} is {format_file_size(size_limit)}."
            )

        from utils.config import get_provider_map
        provider_map = get_provider_map()
        provider = provider_map.get(provider_name)

        if not provider or not provider.is_available():
            raise ValueError(
                f"Provider '{provider_name}' is not available. "
                "Check your provider configuration."
            )

        _logger.info(f"Uploading file '{file_path}' to {provider_name}...")

        upload_kwargs = {"file": str(resolved_path)}

        if resolved_path.suffix.lower() == '.md':
            upload_kwargs["config"] = {"mime_type": "text/markdown"}

        from utils.rate_limiter import get_rate_limiter
        rate_config = Config.get_rate_limit_config(provider=provider_name)
        limiter = get_rate_limiter()

        uploaded_file = limiter.execute(
            provider.client.files.upload,
            f"{provider_name}:upload",
            limit_config=rate_config,
            **upload_kwargs,
        )

        api_file_name = uploaded_file.name
        file_state = uploaded_file.state.name.lower() if hasattr(uploaded_file.state, 'name') else 'uploaded'

        attachment_id = str(uuid.uuid4())
        attachment_record = {
            "attachment_id": attachment_id,
            "file_path": str(resolved_path),
            "display_name": display_name,
            "api_file_name": api_file_name,
            "provider": provider_name,
            "state": file_state,
            "file_size_bytes": file_size,
            "ctx_id": ctx.ctx_id,
            "task_id": ctx.task_id
        }

        attachments_dir = get_data_dir() / "attachments"
        attachments_dir.mkdir(parents=True, exist_ok=True)
        attachment_file = attachments_dir / f"{attachment_id}.json"

        with open(attachment_file, 'w', encoding='utf-8') as f:
            json.dump(attachment_record, f, indent=2)

        _logger.info(
            f"Successfully attached file '{file_path}' with ID {attachment_id} "
            f"(API name: {api_file_name}, state: {file_state})"
        )

        return ToolResult(
            output={
                "status": "success",
                "attachment_id": attachment_id,
                "api_file_name": api_file_name,
                "file_path": str(resolved_path),
                "display_name": display_name,
                "file_state": file_state,
                "provider": provider_name,
                "metadata": {
                    "file_size": format_file_size(file_size),
                    "file_size_bytes": file_size,
                    "file_name": file_name
                },
                "usage_note": (
                    f"File attached successfully. Use attachment_id '{attachment_id}' or "
                    f"api_file_name '{api_file_name}' in subsequent LLM calls."
                )
            },
            metadata={
                "attachment_id": attachment_id,
                "api_file_name": api_file_name,
                "file_path": str(resolved_path),
                "state": file_state
            }
        )

    except ImportError as e:
        raise ValueError(
            f"File attachment system not available: {str(e)}. "
            "Ensure the file_utils module is properly configured."
        )
    except PermissionError:
        raise ValueError(
            f"Cannot read '{file_path}': permission denied. "
            "Check that you have read access to this file."
        )
    except Exception as e:
        _logger.error(f"Error attaching file '{file_path}': {str(e)}")
        raise ValueError(f"Error attaching file '{file_path}': {str(e)}")


attach_file_spec = ToolSpec(
    name="file.attach",
    version="1.0",
    description="Attach a file for use with LLM providers (supports all file types including images, PDFs, etc.)",
    effects=["disk", "net"],
    in_schema={
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Path to the file to attach"
            },
            "display_name": {
                "type": "string",
                "description": "Optional display name for the file (defaults to file name)"
            }
        },
        "required": ["file_path"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "attachment_id": {"type": "string"},
            "api_file_name": {"type": "string"},
            "file_path": {"type": "string"},
            "display_name": {"type": "string"},
            "file_state": {"type": "string"},
            "provider": {"type": "string"},
            "metadata": {"type": "object"},
            "usage_note": {"type": "string"}
        }
    },
    fn=_tool_attach_file,
    rate_key="file.attach",
    timeout_seconds=60.0,  # File uploads involve network
    processing_mode=ProcessingMode.ASYNC,
)
