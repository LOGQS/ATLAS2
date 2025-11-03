# status: complete

from typing import Dict, Optional, List
from utils.logger import get_logger
from utils.config import Config, ROUTE_MODEL_MAP, available_routes, infer_provider_from_model
from utils.format_validator import extract_route_choice
from agents.context.context_manager import get_router_context
from agents.domains import domain_registry  # Ensure domains are registered at module load

logger = get_logger(__name__)

class Router:
    """Routes incoming requests to appropriate models based on complexity classification."""

    def __init__(self):
        self.router_model = Config.get_router_model()
        self.router_enabled = Config.get_default_router_state()
        logger.info(f"Router initialized - enabled: {self.router_enabled}, model: {self.router_model}")

    def route_request(self, message: str, chat_history: Optional[List[Dict]] = None, providers=None, chat_id: Optional[str] = None, attached_files: Optional[List[Dict]] = None) -> Dict[str, str]:
        """Route a request to the appropriate model.

        Args:
            message: The user's message
            chat_history: Previous chat history
            providers: Optional provider instances
            chat_id: Optional chat ID for token tracking
            attached_files: Optional list of files attached to current message

        Returns:
            Dict containing the model to use and the selected route
        """
        if not self.router_enabled:
            logger.debug("Router disabled, using default model")
            default_model = Config.get_default_model()
            default_provider = infer_provider_from_model(default_model)
            return {
                'model': default_model,
                'provider': default_provider,
                'route': None,
                'available_routes': available_routes
            }

        try:
            router_context = get_router_context(chat_history, message, attached_files)
            router_prompt = self._build_router_prompt(router_context)
            router_response = self._call_router_model(router_prompt, providers, chat_id)

            logger.info("=" * 60)
            logger.info("ROUTER REQUEST DUMP:")
            logger.info(f"Message: {message}")
            logger.info(f"Router Model: {self.router_model}")
            logger.info("Chat History Provided:")
            if chat_history:
                for idx, msg in enumerate(chat_history):
                    role = msg.get('role', 'unknown')
                    content = msg.get('content', '')[:200]
                    if len(msg.get('content', '')) > 200:
                        content += "..."
                    logger.info(f"  [{idx}] {role.upper()}: {content}")
            else:
                logger.info("  (No chat history)")
            logger.info("-" * 60)
            logger.info("FULL CONSTRUCTED ROUTER PROMPT:")
            logger.info(router_prompt)
            logger.info("-" * 60)
            logger.info("Router Response:")
            logger.info(router_response)
            logger.info("=" * 60)

            from utils.format_validator import extract_router_metadata
            router_metadata = extract_router_metadata(router_response)

            route_choice = router_metadata.get('choice') or extract_route_choice(router_response)
            selected_model = ROUTE_MODEL_MAP.get(route_choice, Config.get_default_model())
            selected_provider = infer_provider_from_model(selected_model)

            logger.info(f"Router decision: {route_choice} -> {selected_model} ({selected_provider} provider)")
            if router_metadata.get('tools_needed') is not None:
                logger.info(f"Tools needed: {router_metadata['tools_needed']}")
            if router_metadata.get('execution_type'):
                logger.info(f"Execution type: {router_metadata['execution_type']}")
            if router_metadata.get('domain_id'):
                logger.info(f"Domain: {router_metadata['domain_id']}")
            if router_metadata.get('fastpath_params'):
                logger.info(f"FastPath params: {router_metadata['fastpath_params']}")

            return {
                'model': selected_model,
                'provider': selected_provider,
                'route': route_choice,
                'available_routes': available_routes,
                'tools_needed': router_metadata.get('tools_needed'),
                'execution_type': router_metadata.get('execution_type'),
                'domain_id': router_metadata.get('domain_id'),
                'fastpath_params': router_metadata.get('fastpath_params')
            }

        except Exception as e:
            error_message = str(e)
            logger.error(f"Router error, falling back to default model: {error_message}")
            default_model = Config.get_default_model()
            default_provider = infer_provider_from_model(default_model)
            return {
                'model': default_model,
                'provider': default_provider,
                'route': None,
                'available_routes': available_routes,
                'error': error_message
            }

    def _build_router_prompt(self, context: str) -> str:
        """Build the complete router prompt.

        Args:
            context: The router context with chat history

        Returns:
            Complete prompt for the router
        """
        routes_str = ""
        for route in available_routes:
            routes_str += f"- {route['route_name']}: {route['route_description']} ({route['route_context']})\n"

        domains_str = domain_registry.get_domain_descriptions_for_router()

        from agents.prompts.router_prompt import router_system_prompt

        prompt = router_system_prompt.replace("{available_routes}", routes_str.strip())
        prompt = prompt.replace("{available_domains}", domains_str)
        prompt = prompt.replace("{available_information}", context)

        return prompt

    def _call_router_model(self, prompt: str, providers=None, chat_id: Optional[str] = None) -> str:
        """Call the router model with the prompt.

        Args:
            prompt: The complete router prompt
            providers: Optional provider instances to use (avoids Chat creation)
            chat_id: Optional chat ID for token tracking

        Returns:
            The router model's response
        """
        # Track router token usage
        from agents.context.context_manager import context_manager
        from utils.rate_limiter import get_rate_limiter

        router_provider = Config.get_router_provider()
        token_estimate = context_manager.estimate_request_tokens(
            role="router",
            provider=router_provider,
            model=self.router_model,
            system_prompt=None,
            chat_history=[],
            current_message=prompt,
            file_attachments=[]
        )
        estimated_tokens = token_estimate['estimated_tokens']['total']
        logger.debug(f"Router estimated tokens: {estimated_tokens}")

        limiter = get_rate_limiter()
        try:
            limiter.check_and_reserve(router_provider, self.router_model, estimated_tokens)
            logger.info(f"[RATE-LIMIT] Reserved capacity for router {router_provider}:{self.router_model} (estimated {estimated_tokens} tokens)")
        except Exception as rate_limit_error:
            logger.error(f"[RATE-LIMIT] Router rate limit check failed: {rate_limit_error}")
            raise

        if providers and router_provider in providers and providers[router_provider].is_available():
            response = providers[router_provider].generate_text(
                prompt=prompt,
                model=self.router_model,
                include_thoughts=False,
                chat_history=[],
                file_attachments=[]
            )
        else:
            from chat.chat import Chat
            import uuid

            temp_chat_id = f"router_temp_{uuid.uuid4()}"
            chat = Chat(chat_id=temp_chat_id)

            response = chat.generate_text(
                message=prompt,
                provider=router_provider,
                model=self.router_model,
                include_reasoning=False,
                use_router=False
            )

        # Extract actual token usage
        actual_tokens_data = context_manager.extract_actual_tokens_from_response(response, router_provider)
        actual_tokens = actual_tokens_data['total_tokens'] if actual_tokens_data else 0
        if actual_tokens_data:
            logger.info(f"Router actual tokens: {actual_tokens}")

        # Finalize rate limit with actual tokens
        if actual_tokens > 0:
            try:
                limiter.finalize_tokens(router_provider, self.router_model, estimated_tokens, actual_tokens)
                logger.info(f"[RATE-LIMIT] Finalized router token usage: estimated={estimated_tokens}, actual={actual_tokens}")
            except Exception as finalize_error:
                logger.warning(f"[RATE-LIMIT] Failed to finalize router tokens: {finalize_error}")

        # Save token usage to database if chat_id provided
        if chat_id and not chat_id.startswith("router_temp_"):
            from utils.db_utils import db
            # Save both estimated and actual tokens (actual may be 0 if not available)
            db.save_token_usage(
                chat_id=chat_id,
                role='router',
                provider=router_provider,
                model=self.router_model,
                estimated_tokens=estimated_tokens,
                actual_tokens=actual_tokens
            )
            logger.info(f"[TokenUsage] Saved router token usage for chat {chat_id}: estimated={estimated_tokens}, actual={actual_tokens}")

        if response.get("error"):
            raise ValueError(f"Router model error: {response['error']}")

        return response.get("text", "")

router = Router()