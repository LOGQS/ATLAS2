# status: stable

from typing import List, Any
from llama_index.embeddings.huggingface import HuggingFaceEmbedding
from llama_index.core.embeddings import BaseEmbedding
from llama_index.core.bridge.pydantic import PrivateAttr
from utils.logger import get_logger
from utils.config import EMBEDDING_MODEL_MAP

_logger = get_logger(__name__)


def configure_embedding_model(embed_model: str):
    """
    Configure and return the embedding model with GPU support.

    Args:
        embed_model: Model name or speed setting ("fast"/"slow")

    Returns:
        Configured embedding model compatible with LlamaIndex
    """
    # Resolve speed shortcuts to actual model names
    normalized = embed_model.strip().lower()
    if normalized in EMBEDDING_MODEL_MAP:
        embed_model = EMBEDDING_MODEL_MAP[normalized]
        _logger.info(f"Speed mode '{normalized}' resolved to {embed_model}")

    model_lower = embed_model.lower()

    # Handle GTE models (Alibaba-NLP/gte-*)
    if "gte-" in model_lower or embed_model.startswith("Alibaba-NLP/"):
        try:
            from sentence_transformers import SentenceTransformer

            model = SentenceTransformer(embed_model, trust_remote_code=True)
            _logger.info(f"Using {embed_model} (GTE model with normalization)")

            # Wrap for LlamaIndex compatibility with normalized embeddings
            class _GTEWrapper(BaseEmbedding):
                _model: Any = PrivateAttr()

                def __init__(self, model, **kwargs):
                    super().__init__(**kwargs)
                    self._model = model

                @classmethod
                def class_name(cls) -> str:
                    return "GTE"

                async def _aget_query_embedding(self, query: str) -> List[float]:
                    return self._get_query_embedding(query)

                def _get_query_embedding(self, query: str) -> List[float]:
                    """Get query embedding with normalization."""
                    emb = self._model.encode(query, normalize_embeddings=True)
                    return emb.tolist()

                async def _aget_text_embedding(self, text: str) -> List[float]:
                    return self._get_text_embedding(text)

                def _get_text_embedding(self, text: str) -> List[float]:
                    """Get text embedding with normalization."""
                    emb = self._model.encode(text, normalize_embeddings=True)
                    return emb.tolist()

            return _GTEWrapper(model=model)

        except ImportError as e:
            _logger.error(f"Failed to load {embed_model}: {e}. Install sentence-transformers: pip install sentence-transformers")
            raise
        except OSError as e:
            # Handle gated repo or authentication errors
            error_msg = str(e)
            if "gated repo" in error_msg.lower() or "401" in error_msg:
                _logger.error(
                    f"Authentication required for {embed_model}. "
                    "This model requires HuggingFace authentication. "
                    "Please run: huggingface-cli login"
                )
            raise
        except Exception as e:
            _logger.error(f"Failed to load {embed_model}: {e}")
            raise

    # Handle E5-small-v2 (fast mode) with prefix requirements
    if "e5-small-v2" in model_lower or embed_model == "intfloat/e5-small-v2":
        try:
            from sentence_transformers import SentenceTransformer

            model = SentenceTransformer(embed_model)
            _logger.info(f"Using {embed_model} (E5 mode with query/passage prefixes)")

            # Wrap to conform to LlamaIndex embedding interface
            class _E5Wrapper(BaseEmbedding):
                _model: Any = PrivateAttr()

                def __init__(self, model, **kwargs):
                    super().__init__(**kwargs)
                    self._model = model

                @classmethod
                def class_name(cls) -> str:
                    return "E5SmallV2"

                async def _aget_query_embedding(self, query: str) -> List[float]:
                    return self._get_query_embedding(query)

                def _get_query_embedding(self, query: str) -> List[float]:
                    """Get query embedding with explicit query prefix."""
                    if not query.lower().startswith("query:"):
                        query = "query: " + query
                    emb = self._model.encode(query, normalize_embeddings=True)
                    return emb.tolist()

                async def _aget_text_embedding(self, text: str) -> List[float]:
                    return self._get_text_embedding(text)

                def _get_text_embedding(self, text: str) -> List[float]:
                    """Get embedding with automatic query prefix for E5 models."""
                    # E5 models require "query: " or "passage: " prefix
                    if not text.lower().startswith(("query:", "passage:")):
                        text = "query: " + text
                    emb = self._model.encode(text, normalize_embeddings=True)
                    return emb.tolist()

            return _E5Wrapper(model=model)

        except ImportError as e:
            _logger.error(f"Failed to load {embed_model}: {e}. Install sentence-transformers: pip install sentence-transformers")
            raise
        except OSError as e:
            error_msg = str(e)
            if "gated repo" in error_msg.lower() or "401" in error_msg:
                _logger.error(
                    f"Authentication required for {embed_model}. "
                    "Please run: huggingface-cli login"
                )
            raise
        except Exception as e:
            _logger.error(f"Failed to load {embed_model}: {e}")
            raise

    # Handle standard BAAI/sentence-transformers models
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
        except OSError as e:
            error_msg = str(e)
            if "gated repo" in error_msg.lower() or "401" in error_msg:
                _logger.error(
                    f"Authentication required for {embed_model}. "
                    "Please run: huggingface-cli login"
                )
            raise

    # If no specific handler matched, raise an error
    raise ValueError(
        f"Unsupported embedding model: {embed_model}. "
        f"Supported options: 'fast', 'slow', 'intfloat/e5-small-v2', 'Alibaba-NLP/gte-multilingual-base', "
        f"or models starting with 'BAAI/', 'sentence-transformers/', or 'Alibaba-NLP/'"
    )