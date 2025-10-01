# status: complete
"""Token usage route handler for context and token tracking"""

from typing import Tuple
from flask import Flask, request, jsonify
from utils.db_utils import db
from utils.logger import get_logger
from utils.config import Config
from utils.db_route_utils import (
    ResponseBuilder,
    handle_route_error,
    ensure_chat_exists
)
from agents.context.context_manager import context_manager

logger = get_logger(__name__)


class TokenRoute:
    """Handler for token usage and context tracking operations"""

    def __init__(self, app: Flask):
        self.app = app
        self._register_routes()

    def _register_routes(self):
        """Register all token-related routes"""
        self.app.route('/api/chat/<chat_id>/token-usage', methods=['GET'])(self.get_token_usage)
        self.app.route('/api/chat/<chat_id>/estimate-tokens', methods=['POST'])(self.estimate_tokens)
        self.app.route('/api/chats/<chat_id>/context-analysis', methods=['GET'])(self.get_context_analysis)

    def _handle_route_error(self, operation: str, error: Exception, context: dict = None) -> Tuple:
        """Wrapper for standardized error handling"""
        return handle_route_error(operation, error, context, logger)

    def get_token_usage(self, chat_id: str):
        """
        Get comprehensive token usage for a chat broken down by role.

        GET /api/chat/<chat_id>/token-usage

        Returns:
            {
                "success": true,
                "chat_id": str,
                "roles": {
                    "router": {...},
                    "planner": {...},
                    "assistant": {...},
                    "agent_tools": {...}
                },
                "total_tokens": int
            }
        """
        try:
            logger.info(f"[TokenUsage] GET request for chat_id: {chat_id}")

            error_response = ensure_chat_exists(chat_id, db)
            if error_response:
                logger.warning(f"[TokenUsage] Chat does not exist: {chat_id}")
                return error_response

            usage_data = db.get_token_usage_by_chat(chat_id)
            logger.info(f"[TokenUsage] Retrieved token usage from database: {usage_data}")

            token_breakdown = usage_data

            role_info = {}
            for role in ['router', 'planner', 'assistant', 'agent_tools']:
                recent = db.get_most_recent_token_usage(chat_id, role)
                if recent:
                    provider = recent.get('provider', 'unknown')
                    method = Config.get_token_counting_method(provider)
                    method_display = {
                        'native': f'{provider}_native',
                        'tiktoken': 'tiktoken_cl100k_base',
                        'fallback': 'char_approximation_4:1'
                    }.get(method, 'unknown')

                    role_info[role] = {
                        "provider": provider,
                        "model": recent.get('model', 'unknown'),
                        "method": method_display,
                        "last_used": recent.get('timestamp', '')
                    }

            total_tokens = sum(
                role_data['estimated'] + role_data['actual']
                for role_data in usage_data.values()
            )

            logger.info(f"[TokenUsage] Token breakdown: {token_breakdown}")
            logger.info(f"[TokenUsage] Role info: {role_info}")
            logger.info(f"[TokenUsage] Total tokens: {total_tokens}")

            return ResponseBuilder.success(
                success=True,
                chat_id=chat_id,
                roles=token_breakdown,
                role_info=role_info,
                total_tokens=total_tokens,
                note="Token usage tracking active. Showing last-used provider/model per role."
            )

        except Exception as e:
            return self._handle_route_error(
                "get_token_usage",
                e,
                {"chat_id": chat_id}
            )

    def estimate_tokens(self, chat_id: str):
        """
        Estimate tokens for a hypothetical request.

        POST /api/chat/<chat_id>/estimate-tokens
        Body: {
            "message": str,
            "provider": str,
            "model": str,
            "role": str (optional, defaults to "assistant"),
            "file_attachments": List[str] (optional)
        }

        Returns:
            {
                "success": true,
                "estimation": {
                    "role": str,
                    "estimated_tokens": {...},
                    "method": str,
                    "model": str,
                    "provider": str,
                    "breakdown_details": {...}
                }
            }
        """
        try:
            logger.info(f"[TokenEstimate] POST request for chat_id: {chat_id}")

            error_response = ensure_chat_exists(chat_id, db)
            if error_response:
                logger.warning(f"[TokenEstimate] Chat does not exist: {chat_id}")
                return error_response

            data = request.get_json()
            if not data:
                logger.warning(f"[TokenEstimate] No request body provided")
                return ResponseBuilder.error("Request body is required", 400)

            message = data.get('message', '')
            role = data.get('role', 'assistant')
            file_attachments = data.get('file_attachments', [])

            provider = data.get('provider')
            model = data.get('model')

            if not provider or not model:
                recent_usage = db.get_most_recent_token_usage(chat_id, role)
                if recent_usage:
                    if not provider:
                        provider = recent_usage.get('provider')
                        logger.info(f"[TokenEstimate] Using last-used provider from chat: {provider}")
                    if not model:
                        model = recent_usage.get('model')
                        logger.info(f"[TokenEstimate] Using last-used model from chat: {model}")

            if not provider:
                provider = Config.get_default_provider()
                logger.info(f"[TokenEstimate] Using default provider: {provider}")
            if not model:
                model = Config.get_default_model()
                logger.info(f"[TokenEstimate] Using default model: {model}")

            logger.info(f"[TokenEstimate] Request params - role: {role}, provider: {provider}, model: {model}, message_length: {len(message)}, attachments: {len(file_attachments)}")

            if not message:
                logger.warning(f"[TokenEstimate] No message provided")
                return ResponseBuilder.error("Message is required", 400)

            chat_history = db.get_chat_history(chat_id)
            logger.info(f"[TokenEstimate] Retrieved {len(chat_history)} messages from chat history")

            chat_info = db.get_chat(chat_id)
            system_prompt = chat_info.get('system_prompt') if chat_info else None
            logger.info(f"[TokenEstimate] System prompt length: {len(system_prompt) if system_prompt else 0}")

            estimation = context_manager.estimate_request_tokens(
                role=role,
                provider=provider,
                model=model,
                system_prompt=system_prompt,
                chat_history=chat_history,
                current_message=message,
                file_attachments=file_attachments
            )

            logger.info(f"[TokenEstimate] Estimation result: {estimation}")

            return ResponseBuilder.success(
                success=True,
                estimation=estimation
            )

        except Exception as e:
            return self._handle_route_error(
                "estimate_tokens",
                e,
                {"chat_id": chat_id}
            )

    def get_context_analysis(self, chat_id: str):
        """
        Get forensic analysis of the latest interaction in a chat.

        This provides detailed breakdown of prompts sent to router/planner/assistant
        with token counts per segment.

        GET /api/chats/<chat_id>/context-analysis

        Returns:
            {
                "success": true,
                "data": {
                    "chat_id": str,
                    "system_prompt": {...},
                    "requests": [
                        {
                            "role": "router"|"planner"|"assistant",
                            "label": str,
                            "provider": str,
                            "model": str,
                            "input": {
                                "total": {...},
                                "segments": [...]
                            },
                            "output": {...} (optional),
                            "notes": [...]
                        }
                    ],
                    "generated_at": int
                }
            }
        """
        try:
            logger.info(f"[ContextAnalysis] GET request for chat_id: {chat_id}")

            error_response = ensure_chat_exists(chat_id, db)
            if error_response:
                logger.warning(f"[ContextAnalysis] Chat does not exist: {chat_id}")
                return error_response

            analysis = context_manager.analyze_latest_interaction(chat_id)

            logger.info(f"[ContextAnalysis] Analysis completed successfully for chat {chat_id}")
            logger.debug(f"[ContextAnalysis] Found {len(analysis.get('requests', []))} requests in analysis")

            return jsonify({
                'success': True,
                'data': analysis
            })

        except Exception as e:
            return self._handle_route_error(
                "get_context_analysis",
                e,
                {"chat_id": chat_id}
            )


def register_token_routes(app: Flask):
    """Convenience function to register token routes"""
    return TokenRoute(app)
