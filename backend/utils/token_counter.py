# status: complete

from agents.context.context_manager import context_manager


def count_tokens(text: str, model: str = "", provider: str = "unknown") -> int:
    """
    Count tokens using appropriate provider via context_manager.
    Fallback: 1 token ≈ 4 characters.

    Args:
        text (str): Input text.
        model (str): Model name.
        provider (str): Provider name.

    Returns:
        int: Token count.
    """
    if provider == "unknown" or not model:
        return max(1, len(text) // 4)
    return context_manager.count_tokens(text, model, provider)