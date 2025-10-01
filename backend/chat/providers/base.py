# status: complete

class DisabledProvider:
    """Base class for disabled/placeholder providers"""

    def __init__(self, name: str = "DisabledProvider"):
        self.name = name
        self.status = "disabled"

    def is_available(self) -> bool:
        return False

    def get_available_models(self) -> dict:
        return {}

class HuggingFace(DisabledProvider):
    """HuggingFace API (currently disabled)"""

    def __init__(self):
        super().__init__("HuggingFace")
