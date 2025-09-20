# status: complete

from typing import Dict, Optional, List
from utils.logger import get_logger
from utils.config import Config, ROUTE_MODEL_MAP, available_routes
from utils.format_validator import extract_route_choice
from context.context_manager import get_router_context

logger = get_logger(__name__)

class Router:
    """Routes incoming requests to appropriate models based on complexity classification."""

    def __init__(self):
        self.router_model = Config.get_router_model()
        self.router_enabled = Config.get_default_router_state()
        logger.info(f"Router initialized - enabled: {self.router_enabled}, model: {self.router_model}")

    def route_request(self, message: str, chat_history: Optional[List[Dict]] = None) -> Dict[str, str]:
        """Route a request to the appropriate model.

        Args:
            message: The user's message
            chat_history: Previous chat history

        Returns:
            Dict containing the model to use and the selected route
        """
        if not self.router_enabled:
            logger.debug("Router disabled, using default model")
            return {
                'model': Config.get_default_model(),
                'route': None,
                'available_routes': available_routes
            }

        try:
            router_context = get_router_context(chat_history, message)
            router_prompt = self._build_router_prompt(router_context)
            router_response = self._call_router_model(router_prompt)

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
            logger.info("Router Response:")
            logger.info(router_response)
            logger.info("=" * 60)

            route_choice = extract_route_choice(router_response)
            selected_model = ROUTE_MODEL_MAP.get(route_choice, Config.get_default_model())

            logger.info(f"Router decision: {route_choice} -> {selected_model}")
            return {
                'model': selected_model,
                'route': route_choice,
                'available_routes': available_routes
            }

        except Exception as e:
            logger.error(f"Router error, falling back to default model: {str(e)}")
            return {
                'model': Config.get_default_model(),
                'route': None,
                'available_routes': available_routes
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

        from agents.prompts.router_prompt import router_system_prompt

        prompt = router_system_prompt.replace("{available_routes}", routes_str.strip())
        prompt = prompt.replace("{available_information}", context)

        return prompt

    def _call_router_model(self, prompt: str) -> str:
        """Call the router model with the prompt.

        Args:
            prompt: The complete router prompt

        Returns:
            The router model's response
        """
        from chat.chat import Chat
        import uuid

        temp_chat_id = f"router_temp_{uuid.uuid4()}"
        chat = Chat(chat_id=temp_chat_id)

        response = chat.generate_text(
            message=prompt,
            provider="gemini",
            model=self.router_model,
            include_reasoning=False, 
            use_router=False 
        )

        if response.get("error"):
            raise ValueError(f"Router model error: {response['error']}")

        return response.get("text", "")

router = Router()