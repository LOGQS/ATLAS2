# status: complete

from typing import Dict, Any, List, Optional
from pathlib import Path
from utils.logger import get_logger
from utils.config import get_provider_map, Config
from agents.models.token_types import (
    TokenEstimationResult,
    TokenUsageDict,
    MessageTokensResult,
    InteractionAnalysis
)
from file_utils.extensions import (
    IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS,
    TEXT_EXTENSIONS, CODE_EXTENSIONS, DOCUMENT_EXTENSIONS,
    CONFIG_EXTENSIONS, WEB_EXTENSIONS, SCRIPT_EXTENSIONS
)


class ContextManager:
    """Central hub for token counting, context building, and usage tracking."""

    MESSAGE_OVERHEAD_TOKENS = 4
    TOOL_OVERHEAD_TOKENS_PER_TOOL = 150
    ROUTER_HISTORY_MAX_CHARS = 400_000

    # Provider-agnostic token estimation constants
    # Image: avg of OpenAI (~1542), Claude (750), Gemini (~2287) ≈ 1500 px/token
    IMAGE_PIXELS_PER_TOKEN = 1500
    IMAGE_MIN_TOKENS = 100
    # Audio: avg of Gemini (32) and transcription (~4) ≈ 18 tokens/sec
    AUDIO_TOKENS_PER_SECOND = 18
    # Video: based on Gemini (263), slightly conservative ≈ 200 tokens/sec
    VIDEO_TOKENS_PER_SECOND = 200 

    def __init__(self):
        self.logger = get_logger(__name__)
        self._provider_map = None

    def _get_providers(self):
        """Lazy load providers to avoid circular imports."""
        if self._provider_map is None:
            self._provider_map = get_provider_map()
        return self._provider_map

    def _truncate_chat_history(self, chat_history: List[Dict[str, Any]], max_chars: int) -> List[Dict[str, Any]]:
        """Truncate chat history to fit budget, removing oldest messages first."""
        if not chat_history:
            return []

        total_chars = 0
        keep_from_index = 0

        for i in range(len(chat_history) - 1, -1, -1):
            content = chat_history[i].get('content', '')
            # 500 max content chars + ~100 for role, separators, file annotations
            msg_chars = min(len(content), 500) + 100

            if total_chars + msg_chars > max_chars:
                keep_from_index = i + 1
                break
            total_chars += msg_chars

        keep_from_index = min(keep_from_index, len(chat_history) - 1)
        return chat_history[keep_from_index:]

    def _format_attached_files(self, files: List[Dict[str, Any]]) -> Optional[str]:
        """Format file list into '[Attached: file1, file2]' string."""
        if not files:
            return None
        file_names = [f.get('name', 'unknown') for f in files]
        return f"[Attached: {', '.join(file_names)}]"

    def build_router_context(self, chat_history=None, current_message=None, current_message_files=None):
        """Build router context with chat history, current message, and available tools."""
        context_parts = []

        if chat_history:
            truncated = self._truncate_chat_history(chat_history, self.ROUTER_HISTORY_MAX_CHARS)
            omitted = len(chat_history) - len(truncated)

            context_parts.append("--- Chat History ---")

            if omitted > 0:
                context_parts.append(f"[{omitted} older messages omitted]")

            for msg in truncated:
                role = msg.get('role', 'unknown')
                content = msg.get('content', '')
                if len(content) > 500:
                    content = content[:500] + "..."
                context_parts.append(f"{role.upper()}: {content}")

                formatted = self._format_attached_files(msg.get('attachedFiles', []))
                if formatted:
                    context_parts.append(formatted)

        if current_message:
            context_parts.append(f"\n--- Current Request ---\n{current_message}")

            formatted = self._format_attached_files(current_message_files)
            if formatted:
                context_parts.append(formatted)

        from agents.tools.tool_registry import tool_registry
        tools = tool_registry.get_all_tools()

        if tools:
            context_parts.append("\n--- Available Tools ---")

            for tool in tools:
                context_parts.append(f"\n{tool.name}:")
                context_parts.append(f"  Description: {tool.description}")

                if tool.in_schema and 'properties' in tool.in_schema:
                    required = tool.in_schema.get('required', [])
                    props = tool.in_schema['properties']

                    params_list = []
                    for param_name, param_spec in props.items():
                        param_type = param_spec.get('type', 'any')
                        is_required = ' (required)' if param_name in required else ''
                        params_list.append(f"{param_name}: {param_type}{is_required}")

                    if params_list:
                        context_parts.append(f"  Parameters: {', '.join(params_list)}")

        return "\n".join(context_parts)

    def count_tokens(self, text: str, model: str, provider: str) -> int:
        """Count tokens for given text using provider-specific method."""
        if not text:
            return 0

        providers = self._get_providers()
        provider_instance = providers.get(provider)

        if provider_instance and hasattr(provider_instance, 'count_tokens'):
            try:
                return provider_instance.count_tokens(text, model)
            except Exception as e:
                self.logger.warning(f"Provider token counting failed: {e}, using fallback")
                return self._fallback_count(text)

        return self._fallback_count(text)

    def _fallback_count(self, text: str) -> int:
        """Fallback token counting using configured ratio."""
        chars_per_token = Config.get_fallback_chars_per_token()
        return max(1, len(text) // chars_per_token)

    def _get_method_info(self, provider: str, source: str = 'counting') -> tuple:
        """
        Get token source display name and is_estimated flag.

        Hierarchy (most to least accurate):
        1. 'api' - From API response
        2. 'native' - Provider's counting API (e.g., Gemini countTokens)
        3. 'tiktoken' - Algorithmic counting
        4. 'fallback' - Character approximation (only true estimation)
        """
        if source == 'api':
            return f'{provider}_api', False

        method = Config.get_token_counting_method(provider)
        method_display = {
            'native': f'{provider}_native',
            'tiktoken': f'tiktoken_{Config.get_tiktoken_encoding()}',
            'fallback': 'char_approximation'
        }.get(method, 'char_approximation')

        is_estimated = (method == 'fallback')
        return method_display, is_estimated

    def _get_image_dimensions(self, file_path: Path) -> tuple:
        """Extract image dimensions using PIL."""
        try:
            from PIL import Image
            with Image.open(file_path) as img:
                return img.width, img.height
        except Exception as e:
            self.logger.debug(f"Failed to get image dimensions: {e}")
            return None, None

    def _get_media_duration(self, file_path: Path) -> Optional[float]:
        """Extract media duration in seconds using ffprobe."""
        try:
            import subprocess
            from file_utils.file_converter import _check_ffmpeg_available

            if not _check_ffmpeg_available():
                return None

            cmd = [
                'ffprobe',
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                str(file_path)
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                timeout=10,
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0
            )

            if result.returncode == 0:
                duration_str = result.stdout.decode('utf-8', errors='ignore').strip()
                if duration_str:
                    return float(duration_str)
            return None
        except Exception as e:
            self.logger.debug(f"Failed to get media duration: {e}")
            return None

    def _read_markdown_content(self, md_filename: str) -> Optional[str]:
        """Read markdown content from md_ver directory."""
        try:
            from file_utils.markdown_processor import setup_filespace

            files_dir = Path(setup_filespace())
            md_path = files_dir / "md_ver" / md_filename

            if md_path.exists():
                with open(md_path, 'r', encoding='utf-8') as f:
                    return f.read()
            return None
        except Exception as e:
            self.logger.debug(f"Failed to read markdown content: {e}")
            return None

    def _estimate_file_tokens_generic(self, attachment: str, db) -> tuple:
        """Provider-agnostic file token estimation based on file type and metadata."""
        try:
            file_info = db.get_file_record(attachment)
            if not file_info:
                return 250, "fallback_missing"

            file_extension = file_info.get('file_extension', '').lower()
            file_size = file_info.get('file_size', 0)

            from file_utils.file_provider_manager import get_file_path
            file_path = get_file_path(attachment)

            if file_extension in IMAGE_EXTENSIONS:
                if file_path and file_path.exists():
                    width, height = self._get_image_dimensions(file_path)
                    if width and height:
                        tokens = (width * height) // self.IMAGE_PIXELS_PER_TOKEN
                        return max(self.IMAGE_MIN_TOKENS, tokens), "image_dimensions"

                return 1400, "image_fallback"  # ~1920x1080

            if file_extension in AUDIO_EXTENSIONS:
                if file_path and file_path.exists():
                    duration = self._get_media_duration(file_path)
                    if duration:
                        tokens = int(duration * self.AUDIO_TOKENS_PER_SECOND)
                        return max(100, tokens), "audio_duration"

                return 540, "audio_fallback"  # ~30s

            if file_extension in VIDEO_EXTENSIONS:
                if file_path and file_path.exists():
                    duration = self._get_media_duration(file_path)
                    if duration:
                        tokens = int(duration * self.VIDEO_TOKENS_PER_SECOND)
                        return max(500, tokens), "video_duration"

                return 2000, "video_fallback"  # ~10s

            md_filename = file_info.get('md_filename')
            if md_filename:
                md_content = self._read_markdown_content(md_filename)
                if md_content:
                    tokens = len(md_content) // 4
                    return max(50, tokens), "markdown_content"

            text_like_extensions = TEXT_EXTENSIONS | CODE_EXTENSIONS | CONFIG_EXTENSIONS | WEB_EXTENSIONS | SCRIPT_EXTENSIONS
            if file_extension in text_like_extensions:
                return max(50, file_size // 4), "text_size_fallback"

            if file_extension in DOCUMENT_EXTENSIONS:
                return max(100, file_size // 10), "document_size_fallback"

            return 250, "fallback_unknown"

        except Exception as e:
            self.logger.debug(f"Failed to estimate file tokens for {attachment}: {e}")
            return 250, "fallback_error"

    def _estimate_single_file_tokens(
        self, attachment: str, provider: str, model: str, db, provider_instance
    ) -> tuple[int, str, bool]:
        """Estimate tokens for a single file with caching. Returns (tokens, method, was_cached)."""
        cached = db.get_file_token_count(attachment, provider, model)
        if cached:
            return cached['token_count'], f"{cached['method']}_cached", True

        if provider_instance and hasattr(provider_instance, 'estimate_file_tokens'):
            file_info = db.get_file_record(attachment)
            result = provider_instance.estimate_file_tokens(attachment, file_info)
            tokens, method = result['tokens'], result['method']
        else:
            tokens, method = self._estimate_file_tokens_generic(attachment, db)

        db.update_file_token_count(attachment, tokens, provider, model, method)
        return tokens, method, False

    def count_messages_tokens(
        self, messages: List[Dict[str, Any]], model: str, provider: str
    ) -> MessageTokensResult:
        """Count tokens in messages using batched counting, distributed proportionally."""
        if not messages:
            return {'total': 0, 'per_message': [], 'method': 'none'}

        prepared = []
        for msg in messages:
            role = msg.get('role', 'user')
            content = msg.get('content', '')
            prepared.append((role, content, len(role) + len(content)))

        total_chars = sum(char_len for _, _, char_len in prepared)

        if total_chars == 0:
            return {
                'total': len(messages) * self.MESSAGE_OVERHEAD_TOKENS,
                'per_message': [self.MESSAGE_OVERHEAD_TOKENS] * len(messages),
                'method': 'empty_messages'
            }

        batched_text = '\n'.join(f"{role}: {content}" for role, content, _ in prepared)

        providers = self._get_providers()
        provider_instance = providers.get(provider)
        counting_method = Config.get_token_counting_method(provider)

        total_content_tokens = 0
        method_name = 'char_approximation'

        if counting_method == "native" and provider_instance:
            try:
                total_content_tokens = provider_instance.count_tokens(batched_text, model)
                method_name = f'{provider}_native'
            except Exception as e:
                self.logger.warning(f"{provider} native counting failed: {e}, trying tiktoken")
                counting_method = "tiktoken"

        if counting_method == "tiktoken" and total_content_tokens == 0:
            try:
                import tiktoken
                encoding_name = Config.get_tiktoken_encoding()
                enc = tiktoken.get_encoding(encoding_name)
                total_content_tokens = len(enc.encode(batched_text))
                method_name = f'tiktoken_{encoding_name}'
            except ImportError:
                self.logger.debug("tiktoken not available, using fallback")
            except Exception as e:
                self.logger.warning(f"tiktoken counting failed: {e}, using fallback")

        if total_content_tokens == 0:
            total_content_tokens = self._fallback_count(batched_text)
            method_name = 'char_approximation'

        # Distribute tokens proportionally by character length + add per-message overhead
        per_message = []
        for _, _, char_len in prepared:
            proportion = char_len / total_chars
            msg_tokens = int(total_content_tokens * proportion) + self.MESSAGE_OVERHEAD_TOKENS
            per_message.append(msg_tokens)

        total = total_content_tokens + (len(messages) * self.MESSAGE_OVERHEAD_TOKENS)

        return {
            'total': total,
            'per_message': per_message,
            'method': method_name
        }

    def estimate_request_tokens(
        self,
        role: str,
        provider: str,
        model: str,
        system_prompt: Optional[str] = None,
        chat_history: Optional[List[Dict[str, Any]]] = None,
        current_message: str = "",
        file_attachments: Optional[List[Any]] = None
    ) -> TokenEstimationResult:
        """Estimate tokens for a complete request, broken down by component."""
        system_tokens = self.count_tokens(system_prompt or "", model, provider) if system_prompt else 0

        history_result = self.count_messages_tokens(chat_history or [], model, provider)
        history_tokens = history_result['total']

        message_tokens = self.count_tokens(current_message, model, provider)

        file_tokens = 0
        file_breakdown = []

        if file_attachments:
            from utils.db_utils import db
            providers = self._get_providers()
            provider_instance = providers.get(provider)

            for attachment in file_attachments:
                tokens, method, _ = self._estimate_single_file_tokens(
                    attachment, provider, model, db, provider_instance
                )
                file_tokens += tokens
                file_breakdown.append({
                    "file": str(attachment),
                    "estimated_tokens": tokens,
                    "method": method
                })

        total = system_tokens + history_tokens + message_tokens + file_tokens

        per_message_breakdown = []
        if chat_history:
            for idx, msg in enumerate(chat_history):
                msg_role = msg.get('role', 'unknown')
                msg_content = msg.get('content', '')
                msg_tokens = history_result['per_message'][idx] if idx < len(history_result['per_message']) else 0

                per_message_breakdown.append({
                    "index": idx,
                    "role": msg_role,
                    "content_preview": msg_content[:100] + ("..." if len(msg_content) > 100 else ""),
                    "tokens": msg_tokens
                })

        if history_result['method'] != 'none':
            method_to_report = history_result['method']
        else:
            method_to_report, _ = self._get_method_info(provider)

        return {
            "role": role,
            "estimated_tokens": {
                "system_prompt": system_tokens,
                "chat_history": history_tokens,
                "current_message": message_tokens,
                "file_attachments": file_tokens,
                "total": total
            },
            "method": method_to_report,
            "model": model,
            "provider": provider,
            "breakdown_details": {
                "system_prompt_tokens": system_tokens,
                "system_prompt_present": bool(system_prompt),
                "history_messages_count": len(chat_history) if chat_history else 0,
                "history_total_tokens": history_tokens,
                "per_message_breakdown": per_message_breakdown,
                "current_message_tokens": message_tokens,
                "current_message_length": len(current_message) if current_message else 0,
                "file_count": len(file_attachments) if file_attachments else 0,
                "file_breakdown": file_breakdown if file_breakdown else []
            }
        }

    def extract_actual_tokens_from_response(self, response: Dict[str, Any], provider: str) -> Optional[TokenUsageDict]:
        """Extract actual token usage from provider response via provider's extract_usage_from_response()."""
        if not response:
            return None

        providers = self._get_providers()
        provider_instance = providers.get(provider)

        if provider_instance and hasattr(provider_instance, 'extract_usage_from_response'):
            return provider_instance.extract_usage_from_response(response)

        return None

    def _reconstruct_router_prompt(self, chat_history: List[Dict[str, Any]], user_message: str) -> tuple[str, List[tuple[str, str]]]:
        """Reconstruct router prompt and break into labeled segments for forensic analysis."""
        from agents.prompts.router_prompt import router_system_prompt
        from utils.config import available_routes
        from agents.domains.domain_registry import domain_registry

        routes_lines = []
        for route in available_routes:
            routes_lines.append(
                f"- {route['route_name']}: {route['route_description']} ({route['route_context']})"
            )
        routes_block = "\n".join(routes_lines)
        domains_block = domain_registry.get_domain_descriptions_for_router()
        context = self.build_router_context(chat_history, user_message)

        try:
            before_routes, after_routes = router_system_prompt.split("{available_routes}", 1)
            before_context, after_context = after_routes.split("{available_information}", 1)
            before_domains, after_domains = after_context.split("{available_domains}", 1)
        except ValueError:
            full_prompt = (router_system_prompt
                .replace("{available_routes}", routes_block)
                .replace("{available_information}", context)
                .replace("{available_domains}", domains_block))
            return full_prompt, [("Router Prompt", full_prompt)]

        segments = [
            ("System Instructions", before_routes.strip()),
            ("Available Routes", routes_block.strip()),
            ("Context Preface", before_context.strip()),
            ("Conversation Context", context.strip()),
            ("Domain Preface", before_domains.strip()),
            ("Available Domains", domains_block.strip()),
            ("Response Format", after_domains.strip()),
        ]

        full_prompt = "".join(text for _, text in segments)
        segments = [(label, text) for label, text in segments if text]

        return full_prompt, segments

    def _analyze_prompt_segments(
        self,
        segments: List[tuple[str, str]],
        model: str,
        provider: str
    ) -> List[Dict[str, Any]]:
        """Count tokens for each prompt segment."""
        segment_details = []

        for label, text in segments:
            tokens = self.count_tokens(text, model, provider)
            method_display, is_estimated = self._get_method_info(provider)

            segment_details.append({
                "label": label,
                "tokens": tokens,
                "method": method_display,
                "is_estimated": is_estimated,
                "char_count": len(text)
            })

        return segment_details

    def _build_empty_analysis(self, chat_id: str, system_prompt: str) -> InteractionAnalysis:
        """Build empty analysis response for early returns."""
        import time
        return {
            "chat_id": chat_id,
            "system_prompt": {
                "content": system_prompt,
                "tokens": 0,
                "method": "none",
                "is_estimated": True
            },
            "requests": [],
            "generated_at": int(time.time() * 1000)
        }

    def analyze_latest_interaction(self, chat_id: str) -> InteractionAnalysis:
        """Forensic analysis of the most recent interaction, reconstructing prompts with token breakdowns."""
        from utils.db_utils import db
        import time

        history = db.get_chat_history(chat_id)
        system_prompt = db.get_chat_system_prompt(chat_id)

        if not history:
            return self._build_empty_analysis(chat_id, system_prompt)

        assistant_msg = None
        assistant_idx = None
        for idx in range(len(history) - 1, -1, -1):
            if history[idx].get("role") == "assistant" and history[idx].get("content"):
                assistant_msg = history[idx]
                assistant_idx = idx
                break

        if not assistant_msg:
            return self._build_empty_analysis(chat_id, system_prompt)

        user_msg = None
        user_idx = None
        for idx in range(assistant_idx - 1, -1, -1):
            if history[idx].get("role") == "user":
                user_msg = history[idx]
                user_idx = idx
                break

        if not user_msg:
            user_idx = assistant_idx
            user_msg = {"role": "user", "content": "", "attachedFiles": []}

        prior_history = history[:user_idx]

        router_usage = db.get_most_recent_token_usage(chat_id, 'router')
        assistant_usage = db.get_most_recent_token_usage(chat_id, 'assistant')

        # Discard router record if request_id doesn't match (different interaction)
        if router_usage and assistant_usage:
            router_rid = router_usage.get('request_id')
            assistant_rid = assistant_usage.get('request_id')
            if router_rid and assistant_rid and router_rid != assistant_rid:
                router_usage = None

        router_metadata = assistant_msg.get("routerDecision")
        requests = []

        if router_usage:
            router_provider = router_usage['provider']
            router_model = router_usage['model']

            full_prompt, segments = self._reconstruct_router_prompt(
                prior_history, user_msg.get("content", "")
            )

            segment_details = self._analyze_prompt_segments(segments, router_model, router_provider)
            route_choice = router_metadata.get("route") if router_metadata else None

            has_api_prompt = router_usage.get('prompt_tokens', 0) > 0
            has_api_total = router_usage.get('actual_tokens', 0) > 0

            notes = []
            if route_choice:
                notes.append(f"Selected Route: {route_choice}")

            if has_api_prompt:
                prompt_tokens = router_usage['prompt_tokens']
                method_display = f"{router_provider}_api"
                notes.append(f"Input tokens from API: {prompt_tokens}")

                requests.append({
                    "role": "router",
                    "label": "Router Decision",
                    "provider": router_provider,
                    "model": router_model,
                    "input": {
                        "total": {"tokens": prompt_tokens, "method": method_display, "is_estimated": False},
                        "segments": segment_details,
                        "segments_note": "Segment breakdown uses counting (not from API)"
                    },
                    "notes": notes
                })
            elif has_api_total:
                actual_tokens = router_usage['actual_tokens']
                method_display, _ = self._get_method_info(router_provider, 'api')
                notes.append(f"Total tokens from API: {actual_tokens}")

                requests.append({
                    "role": "router",
                    "label": "Router Decision",
                    "provider": router_provider,
                    "model": router_model,
                    "input": {
                        "total": {"tokens": actual_tokens, "method": method_display, "is_estimated": False},
                        "segments": segment_details,
                        "segments_note": "Segment breakdown uses counting (not from API)"
                    },
                    "notes": notes
                })
            else:
                total_tokens = self.count_tokens(full_prompt, router_model, router_provider)
                method_display, is_estimated = self._get_method_info(router_provider)
                notes.append(f"Counted via: {method_display}")

                requests.append({
                    "role": "router",
                    "label": "Router Decision",
                    "provider": router_provider,
                    "model": router_model,
                    "input": {
                        "total": {"tokens": total_tokens, "method": method_display, "is_estimated": is_estimated},
                        "segments": segment_details
                    },
                    "notes": notes
                })

        if assistant_usage:
            provider = assistant_usage['provider']
            model = assistant_usage['model']
        else:
            provider = assistant_msg.get("provider") or Config.get_default_provider()
            model = assistant_msg.get("model") or Config.get_default_model()

        attachments = [f.get("api_file_name") for f in user_msg.get("attachedFiles", []) if f.get("api_file_name")]

        counting_method, counting_is_estimated = self._get_method_info(provider)

        input_estimate = self.estimate_request_tokens(
            role="assistant",
            provider=provider,
            model=model,
            system_prompt=system_prompt,
            chat_history=prior_history,
            current_message=user_msg.get("content", ""),
            file_attachments=attachments
        )

        input_segments = []
        if system_prompt:
            input_segments.append({
                "label": "System Prompt",
                "tokens": input_estimate["estimated_tokens"]["system_prompt"],
                "method": counting_method,
                "is_estimated": counting_is_estimated
            })
        if prior_history:
            input_segments.append({
                "label": f"Chat History ({len(prior_history)} messages)",
                "tokens": input_estimate["estimated_tokens"]["chat_history"],
                "method": counting_method,
                "is_estimated": counting_is_estimated
            })
        if user_msg.get("content"):
            input_segments.append({
                "label": "User Message",
                "tokens": input_estimate["estimated_tokens"]["current_message"],
                "method": counting_method,
                "is_estimated": counting_is_estimated
            })
        if attachments:
            input_segments.append({
                "label": f"File Attachments ({len(attachments)} files)",
                "tokens": input_estimate["estimated_tokens"]["file_attachments"],
                "method": counting_method,
                "is_estimated": True,
                "details": input_estimate["breakdown_details"]["file_breakdown"]
            })

        assistant_content = assistant_msg.get("content", "")
        assistant_thoughts = assistant_msg.get("thoughts") or ""
        output_tokens_content = self.count_tokens(assistant_content, model, provider) if assistant_content else 0
        output_tokens_thoughts = self.count_tokens(assistant_thoughts, model, provider) if assistant_thoughts else 0
        counted_output_total = output_tokens_content + output_tokens_thoughts

        output_segments = []
        if assistant_content:
            output_segments.append({
                "label": "Assistant Response",
                "tokens": output_tokens_content,
                "method": counting_method,
                "is_estimated": counting_is_estimated
            })
        if assistant_thoughts:
            output_segments.append({
                "label": "Internal Reasoning",
                "tokens": output_tokens_thoughts,
                "method": counting_method,
                "is_estimated": counting_is_estimated
            })

        has_api_prompt = assistant_usage and assistant_usage.get('prompt_tokens', 0) > 0
        has_api_completion = assistant_usage and assistant_usage.get('completion_tokens', 0) > 0
        has_api_total = assistant_usage and assistant_usage.get('actual_tokens', 0) > 0

        notes = []

        if has_api_prompt and has_api_completion:
            api_input = assistant_usage['prompt_tokens']
            api_output = assistant_usage['completion_tokens']
            api_method = f"{provider}_api"
            notes.append(f"API: input={api_input}, output={api_output}")

            requests.append({
                "role": "assistant",
                "label": "Assistant Response",
                "provider": provider,
                "model": model,
                "input": {
                    "total": {"tokens": api_input, "method": api_method, "is_estimated": False},
                    "segments": input_segments,
                    "segments_note": "Segment breakdown uses counting (not from API)"
                },
                "output": {
                    "total": {"tokens": api_output, "method": api_method, "is_estimated": False},
                    "segments": output_segments
                },
                "notes": notes
            })
        elif has_api_total:
            api_total = assistant_usage['actual_tokens']
            counted_input = input_estimate["estimated_tokens"]["total"]
            notes.append(f"API total: {api_total}")
            notes.append(f"Input counted via {counting_method}, output counted via {counting_method}")

            requests.append({
                "role": "assistant",
                "label": "Assistant Response",
                "provider": provider,
                "model": model,
                "input": {
                    "total": {"tokens": counted_input, "method": counting_method, "is_estimated": counting_is_estimated},
                    "segments": input_segments
                },
                "output": {
                    "total": {"tokens": counted_output_total, "method": counting_method, "is_estimated": counting_is_estimated},
                    "segments": output_segments
                },
                "notes": notes
            })
        else:
            counted_input = input_estimate["estimated_tokens"]["total"]
            notes.append(f"Counted via: {counting_method}")

            requests.append({
                "role": "assistant",
                "label": "Assistant Response",
                "provider": provider,
                "model": model,
                "input": {
                    "total": {"tokens": counted_input, "method": counting_method, "is_estimated": counting_is_estimated},
                    "segments": input_segments
                },
                "output": {
                    "total": {"tokens": counted_output_total, "method": counting_method, "is_estimated": counting_is_estimated},
                    "segments": output_segments
                },
                "notes": notes
            })

        system_prompt_tokens = input_estimate["estimated_tokens"]["system_prompt"] if system_prompt else 0

        return {
            "chat_id": chat_id,
            "system_prompt": {
                "content": system_prompt,
                "tokens": system_prompt_tokens,
                "method": counting_method if system_prompt else "none",
                "is_estimated": counting_is_estimated if system_prompt else True
            },
            "requests": requests,
            "generated_at": int(time.time() * 1000)
        }



context_manager = ContextManager()


def get_router_context(chat_history=None, current_message=None, current_message_files=None):
    """Module-level convenience wrapper for context_manager.build_router_context()."""
    return context_manager.build_router_context(chat_history, current_message, current_message_files)