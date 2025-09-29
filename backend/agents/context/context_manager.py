# status: simple implementation, will make more efficient later

def get_router_context(chat_history=None, current_message=None):
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