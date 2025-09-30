# status: stable

from llama_index.embeddings.huggingface import HuggingFaceEmbedding
from utils.logger import get_logger

_logger = get_logger(__name__)


def configure_embedding_model(embed_model: str):
    """Configure and return the embedding model with GPU support."""
    if embed_model.startswith("BAAI/") or embed_model.startswith("sentence-transformers/"):
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
            embedding_model = HuggingFaceEmbedding(
                model_name=embed_model,
                device=device,
                trust_remote_code=True,
            )
            _logger.info(f"Using {embed_model} on {device}")
            return embedding_model
        except ImportError:
            _logger.warning("torch not available, falling back to CPU")
            return HuggingFaceEmbedding(model_name=embed_model)
    else:
        if not embed_model.startswith(("local:", "openai", "nomic-embed")):
            embed_model = f"local:{embed_model}"
        return embed_model