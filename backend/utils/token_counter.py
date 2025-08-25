# status: complete
    
from chat.providers import *

def count_tokens(text: str, model: str = "", provider: str = "unknown") -> int:
    """
    Count tokens using appropriate provider.
    Fallback: 1 token ≈ 4 characters.
    
    Args:
        text (str): Input text.
        model (str): Model name.
        provider (str): Provider name.
    
    Returns:
        int: Token count.
    """
    if provider == "unknown":
        return max(1, len(text) // 4)
    
    provider_map = {
        "gemini": Gemini(),
        "huggingface": HuggingFace(),
        "openrouter": OpenRouter()
    }
    
    provider_instance = provider_map.get(provider)
    if provider_instance and hasattr(provider_instance, 'count_tokens'):
        return provider_instance.count_tokens(text, model)
    
    return max(1, len(text) // 4)