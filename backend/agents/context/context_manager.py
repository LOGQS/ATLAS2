# status: complete

from typing import Dict, Any, List, Optional
from utils.logger import get_logger
from utils.config import get_provider_map, Config
from agents.models.token_types import (
    TokenEstimationResult,
    TokenUsageDict,
    MessageTokensResult,
    InteractionAnalysis
)


class ContextManager:
    """
    Central hub for all context management including:
    - Building context for different roles (router, planner, assistant, agent)
    - Counting tokens per role and provider
    - Tracking token usage across requests
    """

    MESSAGE_OVERHEAD_TOKENS = 4
    GEMINI_IMAGE_BASE_TOKENS = 258
    GEMINI_VIDEO_TOKENS_PER_SEC = 263
    GEMINI_AUDIO_TOKENS_PER_SEC = 32

    IMAGE_SMALL_TOKENS = 200
    IMAGE_MEDIUM_TOKENS = 350
    IMAGE_LARGE_TOKENS = 500

    TOOL_OVERHEAD_TOKENS_PER_TOOL = 150

    def __init__(self):
        self.logger = get_logger(__name__)
        self._provider_map = None

    def _get_providers(self):
        """Lazy load providers to avoid circular imports."""
        if self._provider_map is None:
            self._provider_map = get_provider_map()
        return self._provider_map

    def build_router_context(self, chat_history=None, current_message=None):
        """Build router context with chat history and current message.

        Args:
            chat_history: List of chat messages
            current_message: The current user message

        Returns:
            Formatted context string for router
        """
        context_parts = []

        if chat_history:
            context_parts.append("Chat history:")
            context_parts.append("=" * 50)
            for msg in chat_history:
                role = msg.get('role', 'unknown')
                content = msg.get('content', '')
                if len(content) > 500:
                    content = content[:500] + "..."
                context_parts.append(f"{role.upper()}: {content}")
            context_parts.append("=" * 50)

        if current_message:
            context_parts.append(f"CURRENT REQUEST: {current_message}")

        return "\n".join(context_parts)

    def count_tokens(self, text: str, model: str, provider: str) -> int:
        """
        Count tokens for given text using provider-specific method.

        Args:
            text: Text to count tokens for
            model: Model name
            provider: Provider name

        Returns:
            Token count
        """
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

    def count_messages_tokens(
        self, messages: List[Dict[str, Any]], model: str, provider: str
    ) -> MessageTokensResult:
        """
        Count tokens in a list of messages.

        Args:
            messages: List of message dicts
            model: Model name
            provider: Provider name

        Returns:
            {
                'total': int,
                'per_message': List[int],
                'method': str
            }
        """
        if not messages:
            return {'total': 0, 'per_message': [], 'method': 'none'}

        providers = self._get_providers()
        provider_instance = providers.get(provider)
        counting_method = Config.get_token_counting_method(provider)

        if counting_method == "native" and provider_instance:
            try:
                total = 0
                per_message = []

                for msg in messages:
                    content = msg.get('content', '')
                    if isinstance(content, str):
                        tokens = provider_instance.count_tokens(content, model)
                        per_message.append(tokens)
                        total += tokens + self.MESSAGE_OVERHEAD_TOKENS
                    else:
                        per_message.append(0)

                return {
                    'total': total,
                    'per_message': per_message,
                    'method': f'{provider}_native'
                }
            except Exception as e:
                self.logger.warning(f"{provider} native counting failed: {e}, using fallback")

        if counting_method == "tiktoken":
            try:
                import tiktoken
            except ImportError as e:
                self.logger.warning(f"tiktoken not available for {provider} - falling back to character approximation. "
                                    f"Install with 'pip install tiktoken' for accurate counts. Error: {e}")
                counting_method = "fallback"  
            except Exception as e:
                self.logger.error(f"Unexpected error importing tiktoken: {e}. Using fallback.")
                counting_method = "fallback"

            if counting_method == "tiktoken":  
                try:
                    encoding_name = Config.get_tiktoken_encoding()
                    enc = tiktoken.get_encoding(encoding_name)

                    total = 0
                    per_message = []

                    for msg in messages:
                        content = msg.get('content', '')
                        role = msg.get('role', 'user')

                        if isinstance(content, str):
                            content_tokens = len(enc.encode(content))
                            role_tokens = len(enc.encode(role))
                            msg_total = content_tokens + role_tokens + self.MESSAGE_OVERHEAD_TOKENS
                            per_message.append(msg_total)
                            total += msg_total
                        else:
                            per_message.append(0)

                    return {
                        'total': total,
                        'per_message': per_message,
                        'method': f'tiktoken_{encoding_name}'
                    }
                except Exception as e:
                    self.logger.warning(f"tiktoken counting failed: {e}, using fallback")

        total = 0
        per_message = []
        for msg in messages:
            content = msg.get('content', '')
            if isinstance(content, str):
                tokens = self._fallback_count(content) + self.MESSAGE_OVERHEAD_TOKENS
                per_message.append(tokens)
                total += tokens
            else:
                per_message.append(0)

        return {
            'total': total,
            'per_message': per_message,
            'method': 'char_approximation'
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
        """
        Estimate tokens for a complete request broken down by component.

        Args:
            role: Role making the request (router, planner, assistant, agent)
            provider: Provider name
            model: Model name
            system_prompt: System prompt if any
            chat_history: Previous messages
            current_message: Current user message
            file_attachments: File attachments

        Returns:
            {
                "role": str,
                "estimated_tokens": {
                    "system_prompt": int,
                    "chat_history": int,
                    "current_message": int,
                    "file_attachments": int,
                    "total": int
                },
                "method": str,
                "model": str,
                "provider": str,
                "breakdown_details": {...}
            }
        """
        system_tokens = self.count_tokens(system_prompt or "", model, provider) if system_prompt else 0

        history_result = self.count_messages_tokens(chat_history or [], model, provider)
        history_tokens = history_result['total']

        message_tokens = self.count_tokens(current_message, model, provider)

        file_tokens = 0
        file_breakdown = []

        if file_attachments:
            counting_method = Config.get_token_counting_method(provider)

            if counting_method == "native" and provider == "gemini":
                providers = self._get_providers()
                gemini_provider = providers.get('gemini')

                if gemini_provider and gemini_provider.is_available():
                    try:
                        parts = []
                        if current_message:
                            parts.append({"text": current_message})

                        for api_file_name in file_attachments:
                            try:
                                file_info = gemini_provider.client.files.get(name=api_file_name)
                                parts.append({"file_data": {"file_uri": file_info.uri}})
                            except Exception as file_err:
                                self.logger.warning(f"Failed to get URI for file {api_file_name}: {file_err}")
                                file_tokens += self.GEMINI_IMAGE_BASE_TOKENS
                                file_breakdown.append({
                                    "file": str(api_file_name),
                                    "estimated_tokens": self.GEMINI_IMAGE_BASE_TOKENS,
                                    "method": "gemini_file_unavailable_fallback"
                                })
                                continue

                        if parts:
                            total_with_files = gemini_provider.count_tokens(parts, model)

                            message_tokens_alone = self.count_tokens(current_message, model, provider) if current_message else 0
                            file_tokens_from_api = max(0, total_with_files - message_tokens_alone)
                            file_tokens += file_tokens_from_api

                            files_in_parts = len(file_attachments) - len(file_breakdown)  
                            if files_in_parts > 0 and file_tokens_from_api > 0:
                                tokens_per_file = file_tokens_from_api // files_in_parts
                                for api_file_name in file_attachments[:files_in_parts]:  
                                    file_breakdown.append({
                                        "file": str(api_file_name),
                                        "estimated_tokens": tokens_per_file,
                                        "method": "gemini_native_multimodal"
                                    })

                            self.logger.debug(f"Gemini native multimodal counting: {file_tokens} tokens for {len(file_attachments)} files")
                    except Exception as e:
                        self.logger.warning(f"Gemini multimodal counting failed: {e}, using conservative estimate")
                        file_tokens = 0
                        file_breakdown = []
                        for attachment in file_attachments:
                            estimated_tokens = self.GEMINI_IMAGE_BASE_TOKENS
                            file_tokens += estimated_tokens
                            file_breakdown.append({
                                "file": str(attachment),
                                "estimated_tokens": estimated_tokens,
                                "method": "gemini_fallback_estimate"
                            })
                else:
                    for attachment in file_attachments:
                        estimated_tokens = self.GEMINI_IMAGE_BASE_TOKENS
                        file_tokens += estimated_tokens
                        file_breakdown.append({
                            "file": str(attachment),
                            "estimated_tokens": estimated_tokens,
                            "method": "gemini_unavailable_fallback"
                        })
            else:
                from utils.db_utils import db
                file_tokens = 0
                for attachment in file_attachments:
                    cached = db.get_file_token_count(attachment, provider, model)
                    if cached:
                        estimated_tokens = cached['token_count']
                        file_tokens += estimated_tokens
                        file_breakdown.append({
                            "file": str(attachment),
                            "estimated_tokens": estimated_tokens,
                            "method": f"{cached['method']}_cached"
                        })
                        continue

                    estimated_tokens = 100
                    estimation_method = "heuristic_estimation"

                    try:
                        file_info = db.get_file_record(attachment)
                        if file_info:
                            file_extension = file_info.get('file_extension', '').lower()
                            file_size = file_info.get('file_size', 0)

                            if file_extension in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']:
                                if file_size < 100 * 1024:
                                    estimated_tokens = self.IMAGE_SMALL_TOKENS
                                elif file_size < 500 * 1024:
                                    estimated_tokens = self.IMAGE_MEDIUM_TOKENS
                                else:
                                    estimated_tokens = self.IMAGE_LARGE_TOKENS

                            elif file_extension in ['.txt', '.md', '.pdf', '.doc', '.docx']:
                                if file_extension == '.pdf':
                                    estimated_tokens = max(100, file_size // 8)
                                elif file_extension in ['.doc', '.docx']:
                                    estimated_tokens = max(100, file_size // 10)
                                else:
                                    estimated_tokens = max(50, file_size // 4)

                                estimated_tokens = min(estimated_tokens, 10000)

                            elif file_extension in ['.py', '.js', '.ts', '.java', '.cpp', '.c', '.go', '.rs']:
                                estimated_tokens = max(50, file_size // 3)
                                estimated_tokens = min(estimated_tokens, 15000)

                            elif file_extension in ['.mp4', '.avi', '.mov', '.webm', '.mkv']:
                                size_mb = file_size / (1024 * 1024)
                                estimated_seconds = size_mb * 10
                                estimated_tokens = int(estimated_seconds * 250)
                                estimated_tokens = min(estimated_tokens, 50000)

                            elif file_extension in ['.mp3', '.wav', '.ogg', '.m4a']:
                                size_mb = file_size / (1024 * 1024)
                                estimated_seconds = size_mb * 30
                                estimated_tokens = int(estimated_seconds * self.GEMINI_AUDIO_TOKENS_PER_SEC)
                                estimated_tokens = min(estimated_tokens, 30000)

                            db.update_file_token_count(
                                attachment,
                                estimated_tokens,
                                provider,
                                model,
                                estimation_method
                            )

                    except Exception as e:
                        self.logger.warning(f"Failed to get file info for {attachment}: {e}, using default estimate")

                    file_tokens += estimated_tokens
                    file_breakdown.append({
                        "file": str(attachment),
                        "estimated_tokens": estimated_tokens,
                        "method": estimation_method
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

        counting_method = Config.get_token_counting_method(provider)
        if history_result['method'] != 'none':
            method_to_report = history_result['method']
        else:
            method_to_report = {
                'native': f'{provider}_native',
                'tiktoken': f'tiktoken_{Config.get_tiktoken_encoding()}',
                'fallback': 'char_approximation'
            }.get(counting_method, 'char_approximation')

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
        """
        Extract actual token usage from provider response.

        Args:
            response: Provider response dict
            provider: Provider name

        Returns:
            {
                'prompt_tokens': int,
                'completion_tokens': int,
                'total_tokens': int,
                'cached_tokens': int (optional for OpenRouter)
            } or None if not available
        """
        if not response:
            return None

        if 'usage' in response and response['usage']:
            usage = response['usage']
            if isinstance(usage, dict) and 'total_tokens' in usage:
                return usage

        counting_method = Config.get_token_counting_method(provider)

        if counting_method == "native" and provider == "gemini":
            metadata = response.get('usage_metadata')
            if metadata:
                if isinstance(metadata, dict):
                    return {
                        'prompt_tokens': metadata.get('prompt_token_count', 0),
                        'completion_tokens': metadata.get('candidates_token_count', 0),
                        'total_tokens': metadata.get('total_token_count', 0)
                    }
                else:
                    return {
                        'prompt_tokens': getattr(metadata, 'prompt_token_count', 0),
                        'completion_tokens': getattr(metadata, 'candidates_token_count', 0),
                        'total_tokens': getattr(metadata, 'total_token_count', 0)
                    }

        if counting_method == "tiktoken" and provider == "groq":
            usage = response.get('usage')
            if usage:
                if isinstance(usage, dict):
                    return {
                        'prompt_tokens': usage.get('prompt_tokens', 0),
                        'completion_tokens': usage.get('completion_tokens', 0),
                        'total_tokens': usage.get('total_tokens', 0)
                    }
                else:
                    return {
                        'prompt_tokens': getattr(usage, 'prompt_tokens', 0),
                        'completion_tokens': getattr(usage, 'completion_tokens', 0),
                        'total_tokens': getattr(usage, 'total_tokens', 0)
                    }

        if counting_method == "tiktoken" and provider == "openrouter":
            usage = response.get('usage')
            if usage:
                if isinstance(usage, dict):
                    result = {
                        'prompt_tokens': usage.get('prompt_tokens', 0),
                        'completion_tokens': usage.get('completion_tokens', 0),
                        'total_tokens': usage.get('total_tokens', 0)
                    }
                    # OpenRouter provides cached_tokens info
                    prompt_details = usage.get('prompt_tokens_details', {})
                    if prompt_details and 'cached_tokens' in prompt_details:
                        result['cached_tokens'] = prompt_details.get('cached_tokens', 0)
                    return result
                else:
                    # Object format
                    result = {
                        'prompt_tokens': getattr(usage, 'prompt_tokens', 0),
                        'completion_tokens': getattr(usage, 'completion_tokens', 0),
                        'total_tokens': getattr(usage, 'total_tokens', 0)
                    }
                    prompt_details = getattr(usage, 'prompt_tokens_details', None)
                    if prompt_details:
                        cached = getattr(prompt_details, 'cached_tokens', 0) if hasattr(prompt_details, 'cached_tokens') else prompt_details.get('cached_tokens', 0) if isinstance(prompt_details, dict) else 0
                        if cached:
                            result['cached_tokens'] = cached
                    return result

        # Generic tiktoken providers - fallback to standard format
        if counting_method == "tiktoken":
            usage = response.get('usage')
            if usage:
                if isinstance(usage, dict):
                    return {
                        'prompt_tokens': usage.get('prompt_tokens', 0),
                        'completion_tokens': usage.get('completion_tokens', 0),
                        'total_tokens': usage.get('total_tokens', 0)
                    }
                else:
                    return {
                        'prompt_tokens': getattr(usage, 'prompt_tokens', 0),
                        'completion_tokens': getattr(usage, 'completion_tokens', 0),
                        'total_tokens': getattr(usage, 'total_tokens', 0)
                    }

        return None

    def _reconstruct_router_prompt(self, chat_history: List[Dict[str, Any]], user_message: str) -> tuple[str, List[tuple[str, str]]]:
        """
        Reconstruct the exact router prompt and break it into segments.

        Returns:
            (full_prompt, segments) where segments is [(label, text), ...]
        """
        from agents.prompts.router_prompt import router_system_prompt
        from utils.config import available_routes

        # Build routes section
        routes_lines = []
        for route in available_routes:
            routes_lines.append(
                f"- {route['route_name']}: {route['route_description']} ({route['route_context']})"
            )
        routes_block = "\n".join(routes_lines)

        # Build context section
        context = self.build_router_context(chat_history, user_message)

        # Split template into segments
        try:
            before_routes, remainder = router_system_prompt.split("{available_routes}", 1)
            before_context, after_context = remainder.split("{available_information}", 1)
        except ValueError:
            # Fallback if template structure changes
            full_prompt = router_system_prompt.replace("{available_routes}", routes_block).replace("{available_information}", context)
            return full_prompt, [("Router Prompt", full_prompt)]

        # Build segments
        segments = [
            ("System Instructions", before_routes.strip()),
            ("Available Routes", routes_block.strip()),
            ("Context Preface", before_context.strip()),
            ("Conversation Context", context.strip()),
            ("Response Format", after_context.strip()),
        ]

        # Build full prompt
        full_prompt = "".join(text for _, text in segments)

        # Filter out empty segments
        segments = [(label, text) for label, text in segments if text]

        return full_prompt, segments

    def _reconstruct_planner_prompt(self, user_message: str) -> tuple[str, List[tuple[str, str]], List[tuple[str, str]]]:
        """
        Reconstruct the exact planner prompt and break it into segments.

        Returns:
            (full_prompt, prompt_segments, tool_entries) where:
                - prompt_segments is [(label, text), ...]
                - tool_entries is [(tool_name, formatted_entry), ...]
        """
        from agents.prompts.planner_prompt import planner_system_prompt
        from agents.tools.tool_registry import tool_registry

        # Build tools section
        tools_list = []
        tool_entries = []

        for tool_name in tool_registry.list():
            tool_spec = tool_registry.get(tool_name)
            params_info = ""
            if tool_spec.in_schema and "properties" in tool_spec.in_schema:
                required = tool_spec.in_schema.get("required", [])
                params = []
                for param_name, param_spec in tool_spec.in_schema["properties"].items():
                    param_type = param_spec.get("type", "any")
                    param_desc = param_spec.get("description", "")
                    param_required = " (required)" if param_name in required else " (optional)"
                    param_default = f", default: {param_spec['default']}" if "default" in param_spec else ""
                    params.append(
                        f"    - {param_name} ({param_type}){param_required}{param_default}: {param_desc}"
                    )
                if params:
                    params_info = "\n" + "\n".join(params)

            entry_text = f"- {tool_name}: {tool_spec.description}{params_info}"
            tools_list.append(entry_text)
            tool_entries.append((tool_name, entry_text))

        available_tools = "\n".join(tools_list)

        # Split template into segments
        try:
            before_tools, remainder = planner_system_prompt.split("{available_tools}", 1)
            before_user, after_user = remainder.split("{user_message}", 1)
        except ValueError:
            # Fallback if template structure changes
            full_prompt = planner_system_prompt.replace("{available_tools}", available_tools).replace("{user_message}", user_message)
            return full_prompt, [("Planner Prompt", full_prompt)], tool_entries

        # Build segments
        segments = [
            ("System Instructions", before_tools.strip()),
            ("Available Tools", available_tools.strip()),
            ("Task Format", before_user.strip()),
            ("User Request", user_message.strip()),
            ("Response Directive", after_user.strip()),
        ]

        # Build full prompt
        full_prompt = "".join(text for _, text in segments)

        # Filter out empty segments
        segments = [(label, text) for label, text in segments if text]

        return full_prompt, segments, tool_entries

    def _analyze_prompt_segments(
        self,
        segments: List[tuple[str, str]],
        model: str,
        provider: str
    ) -> List[Dict[str, Any]]:
        """
        Analyze token usage for each prompt segment.

        Returns:
            List of segment analysis dicts with label, tokens, method, etc.
        """
        segment_details = []

        for label, text in segments:
            tokens = self.count_tokens(text, model, provider)
            method = Config.get_token_counting_method(provider)
            method_display = {
                'native': f'{provider}_native',
                'tiktoken': f'tiktoken_{Config.get_tiktoken_encoding()}',
                'fallback': 'char_approximation'
            }.get(method, 'unknown')

            segment_details.append({
                "label": label,
                "tokens": tokens,
                "method": method_display,
                "is_estimated": method == 'fallback',
                "char_count": len(text)
            })

        return segment_details

    def analyze_latest_interaction(self, chat_id: str) -> InteractionAnalysis:
        """
        Forensic analysis of the most recent interaction in a chat.

        This reconstructs the exact prompts sent to router/planner/assistant
        and provides detailed token breakdowns by segment.

        Args:
            chat_id: The chat ID to analyze

        Returns:
            {
                "chat_id": str,
                "system_prompt": {...},
                "requests": [
                    {
                        "role": "router"|"planner"|"assistant",
                        "label": str,
                        "provider": str,
                        "model": str,
                        "input": {
                            "total": {"tokens": int, "method": str, "is_estimated": bool},
                            "segments": [...]
                        },
                        "output": {
                            "total": {"tokens": int, "method": str, "is_estimated": bool},
                            "segments": [...]
                        } (optional),
                        "notes": [str, ...]
                    }
                ],
                "generated_at": int (timestamp)
            }
        """
        from utils.db_utils import db
        import time

        # Get chat history and system prompt
        history = db.get_chat_history(chat_id)
        system_prompt = db.get_chat_system_prompt(chat_id)

        if not history:
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

        # Find the most recent assistant message
        assistant_msg = None
        assistant_idx = None
        for idx in range(len(history) - 1, -1, -1):
            if history[idx].get("role") == "assistant" and history[idx].get("content"):
                assistant_msg = history[idx]
                assistant_idx = idx
                break

        if not assistant_msg:
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

        # Find the corresponding user message
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

        # History before this interaction
        prior_history = history[:user_idx]

        # Query token_usage database to get actual router and assistant records
        router_usage = db.get_most_recent_token_usage(chat_id, 'router')
        assistant_usage = db.get_most_recent_token_usage(chat_id, 'assistant')

        # Get router metadata from assistant message for route decision info
        router_metadata = assistant_msg.get("routerDecision")

        requests = []

        # 1. Analyze Router (if database record exists)
        if router_usage:
            router_provider = router_usage['provider']
            router_model = router_usage['model']

            full_prompt, segments = self._reconstruct_router_prompt(
                prior_history,
                user_msg.get("content", "")
            )

            # Count total tokens
            total_tokens = self.count_tokens(full_prompt, router_model, router_provider)
            method = Config.get_token_counting_method(router_provider)
            method_display = {
                'native': f'{router_provider}_native',
                'tiktoken': f'tiktoken_{Config.get_tiktoken_encoding()}',
                'fallback': 'char_approximation'
            }.get(method, 'unknown')

            # Analyze segments
            segment_details = self._analyze_prompt_segments(segments, router_model, router_provider)

            has_actual_tokens = router_usage.get('actual_tokens', 0) > 0
            route_choice = router_metadata.get("route") if router_metadata else None

            if has_actual_tokens:
                actual_tokens = router_usage['actual_tokens']
                notes = []
                if route_choice:
                    notes.append(f"Selected Route: {route_choice}")
                notes.append(f"Total tokens from API: {actual_tokens}")

                requests.append({
                    "role": "router",
                    "label": "Router Decision",
                    "provider": router_provider,
                    "model": router_model,
                    "input": {
                        "total": {
                            "tokens": actual_tokens,
                            "method": method_display,
                            "is_estimated": False
                        },
                        "segments": segment_details
                    },
                    "notes": notes
                })
            else:
                notes = []
                if route_choice:
                    notes.append(f"Selected Route: {route_choice}")
                notes.append(f"Tokenizer: {method_display}")
                notes.append("Note: Using estimated tokens (no API usage data)")

                requests.append({
                    "role": "router",
                    "label": "Router Decision",
                    "provider": router_provider,
                    "model": router_model,
                    "input": {
                        "total": {
                            "tokens": total_tokens,
                            "method": method_display,
                            "is_estimated": True
                        },
                        "segments": segment_details
                    },
                    "notes": notes
                })

        # 2. Analyze Planner (if taskflow route was selected)
        if router_metadata and router_metadata.get("route") == "taskflow":
            planner_provider = Config.get_default_provider()
            planner_model = Config.get_default_model()

            full_prompt, segments, tool_entries = self._reconstruct_planner_prompt(
                user_msg.get("content", "")
            )

            # Count total tokens
            total_tokens = self.count_tokens(full_prompt, planner_model, planner_provider)
            method = Config.get_token_counting_method(planner_provider)
            method_display = {
                'native': f'{planner_provider}_native',
                'tiktoken': f'tiktoken_{Config.get_tiktoken_encoding()}',
                'fallback': 'char_approximation'
            }.get(method, 'unknown')

            # Analyze segments
            segment_details = self._analyze_prompt_segments(segments, planner_model, planner_provider)

            # Build notes
            notes = [
                "Activated for Taskflow route",
                f"Tools Available: {len(tool_entries)}",
                f"Tokenizer: {method_display}"
            ]

            requests.append({
                "role": "planner",
                "label": "Task Planner",
                "provider": planner_provider,
                "model": planner_model,
                "input": {
                    "total": {
                        "tokens": total_tokens,
                        "method": method_display,
                        "is_estimated": method == 'fallback'
                    },
                    "segments": segment_details
                },
                "notes": notes
            })

        # 3. Analyze Assistant
        # Use database record to get actual provider/model used
        if assistant_usage:
            provider = assistant_usage['provider']
            model = assistant_usage['model']
        else:
            # Fallback to message metadata or config defaults
            provider = assistant_msg.get("provider") or Config.get_default_provider()
            model = assistant_msg.get("model") or Config.get_default_model()

        attachments = [f.get("api_file_name") for f in user_msg.get("attachedFiles", []) if f.get("api_file_name")]

        # Estimate input tokens
        input_estimate = self.estimate_request_tokens(
            role="assistant",
            provider=provider,
            model=model,
            system_prompt=system_prompt,
            chat_history=prior_history,
            current_message=user_msg.get("content", ""),
            file_attachments=attachments
        )

        # Build input segments
        input_segments = []
        if system_prompt:
            input_segments.append({
                "label": "System Prompt",
                "tokens": input_estimate["estimated_tokens"]["system_prompt"],
                "method": input_estimate["method"],
                "is_estimated": True
            })
        if prior_history:
            input_segments.append({
                "label": f"Chat History ({len(prior_history)} messages)",
                "tokens": input_estimate["estimated_tokens"]["chat_history"],
                "method": input_estimate["method"],
                "is_estimated": True
            })
        if user_msg.get("content"):
            # User message uses native counting (not estimated) when we know the model
            user_msg_tokens = input_estimate["estimated_tokens"]["current_message"]
            user_msg_method = input_estimate["method"]
            input_segments.append({
                "label": "User Message",
                "tokens": user_msg_tokens,
                "method": user_msg_method,
                "is_estimated": False  # Native counting when model is known
            })
        if attachments:
            input_segments.append({
                "label": f"File Attachments ({len(attachments)} files)",
                "tokens": input_estimate["estimated_tokens"]["file_attachments"],
                "method": input_estimate["method"],
                "is_estimated": True,
                "details": input_estimate["breakdown_details"]["file_breakdown"]
            })

        # Analyze output tokens
        assistant_content = assistant_msg.get("content", "")
        assistant_thoughts = assistant_msg.get("thoughts") or ""

        output_tokens_content = self.count_tokens(assistant_content, model, provider) if assistant_content else 0
        output_tokens_thoughts = self.count_tokens(assistant_thoughts, model, provider) if assistant_thoughts else 0
        output_total = output_tokens_content + output_tokens_thoughts

        method = Config.get_token_counting_method(provider)
        method_display = {
            'native': f'{provider}_native',
            'tiktoken': f'tiktoken_{Config.get_tiktoken_encoding()}',
            'fallback': 'char_approximation'
        }.get(method, 'unknown')

        output_segments = []
        if assistant_content:
            output_segments.append({
                "label": "Assistant Response",
                "tokens": output_tokens_content,
                "method": method_display,
                "is_estimated": method == 'fallback'
            })
        if assistant_thoughts:
            output_segments.append({
                "label": "Internal Reasoning",
                "tokens": output_tokens_thoughts,
                "method": method_display,
                "is_estimated": method == 'fallback'
            })

        has_actual_tokens = assistant_usage and assistant_usage.get('actual_tokens', 0) > 0

        if has_actual_tokens:
            actual_total = assistant_usage['actual_tokens']
            input_total = input_estimate["estimated_tokens"]["total"]
            output_total_calc = max(0, actual_total - input_total)

            requests.append({
                "role": "assistant",
                "label": "Assistant Response",
                "provider": provider,
                "model": model,
                "input": {
                    "total": {
                        "tokens": input_total,
                        "method": input_estimate["method"],
                        "is_estimated": False
                    },
                    "segments": input_segments
                },
                "output": {
                    "total": {
                        "tokens": output_total_calc,
                        "method": method_display,
                        "is_estimated": False
                    },
                    "segments": output_segments
                },
                "notes": [f"Total tokens from API: {actual_total}"]
            })
        else:
            requests.append({
                "role": "assistant",
                "label": "Assistant Response",
                "provider": provider,
                "model": model,
                "input": {
                    "total": {
                        "tokens": input_estimate["estimated_tokens"]["total"],
                        "method": input_estimate["method"],
                        "is_estimated": True
                    },
                    "segments": input_segments
                },
                "output": {
                    "total": {
                        "tokens": output_total,
                        "method": method_display,
                        "is_estimated": True
                    },
                    "segments": output_segments
                },
                "notes": [
                    f"Input Tokenizer: {input_estimate['method']}",
                    f"Output Tokenizer: {method_display}",
                    "Note: Using estimated tokens (no API usage data)"
                ]
            })

        # System prompt analysis
        system_prompt_tokens = 0
        system_prompt_method = "none"
        if system_prompt:
            system_prompt_tokens = self.count_tokens(system_prompt, model, provider)
            method = Config.get_token_counting_method(provider)
            system_prompt_method = {
                'native': f'{provider}_native',
                'tiktoken': f'tiktoken_{Config.get_tiktoken_encoding()}',
                'fallback': 'char_approximation'
            }.get(method, 'unknown')

        return {
            "chat_id": chat_id,
            "system_prompt": {
                "content": system_prompt,
                "tokens": system_prompt_tokens,
                "method": system_prompt_method,
                "is_estimated": method == 'fallback' if system_prompt else True
            },
            "requests": requests,
            "generated_at": int(time.time() * 1000)
        }


# Global instance
context_manager = ContextManager()


# Backward compatibility function
def get_router_context(chat_history=None, current_message=None):
    """Legacy function for backward compatibility."""
    return context_manager.build_router_context(chat_history, current_message)