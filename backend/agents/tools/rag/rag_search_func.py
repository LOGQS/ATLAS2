from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

from llama_index.core import VectorStoreIndex, StorageContext, Settings
from llama_index.vector_stores.chroma import ChromaVectorStore
from llama_index.embeddings.huggingface import HuggingFaceEmbedding
import chromadb

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec
from .rag_utils import configure_embedding_model

_logger = get_logger(__name__)

CONTEXT_LINES = 2


def estimate_line_numbers(
    file_path: str,
    start_char: int,
    end_char: int,
    context: int = CONTEXT_LINES,
) -> str:
    """
    Inclusive 1-based line numbers that will actually be printed,
    i.e. [chunk ± context].
    """
    try:
        cache = estimate_line_numbers.__dict__.setdefault("_cache", {})
        if file_path not in cache:
            cache[file_path] = Path(file_path).read_text(encoding="utf-8")
        text = cache[file_path]

        start_ln0 = text.count("\n", 0, start_char)
        end_ln0 = text.count("\n", 0, end_char)

        ctx_start = max(0, start_ln0 - context)
        ctx_end = end_ln0 + context
        ctx_start_h = ctx_start + 1
        ctx_end_h = ctx_end + 1
        return f"{ctx_start_h}-{ctx_end_h}" if ctx_start_h != ctx_end_h else str(ctx_start_h)
    except Exception as e:
        _logger.debug(f"Error estimating line numbers for {file_path}: {e}")
        return "unknown"


def get_chunk_with_context(
    file_path: str,
    start_char: int,
    end_char: int,
    context_lines: int = CONTEXT_LINES,
) -> str:
    """
    Build the display block, tagging:
      >>>   for the real chunk
            four spaces for context
    """
    try:
        text = Path(file_path).read_text(encoding="utf-8")
        lines = text.splitlines()

        start_ln0 = text.count("\n", 0, start_char)
        end_ln0 = text.count("\n", 0, end_char)

        ctx_s = max(0, start_ln0 - context_lines)
        ctx_e = min(len(lines) - 1, end_ln0 + context_lines)

        tagged = []
        for i in range(ctx_s, ctx_e + 1):
            prefix = ">>> " if start_ln0 <= i <= end_ln0 else "    "
            tagged.append(f"{prefix}{lines[i]}")
        return "\n".join(tagged)
    except Exception:
        return "Could not read original file context"


def _tool_rag_search(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Search indexed content with vector similarity (semantic search).

    Fetch the `top_k` most relevant chunks for `query` using vector embeddings.
    """
    query = params.get("query", "")
    index_name = params.get("index_name")
    top_k = params.get("top_k", 5)

    default_persist_dir = str(Path(__file__).resolve().parent.parent.parent.parent.parent / "data" / "rag_data")
    persist_dir = params.get("persist_dir", default_persist_dir)

    embed_model = params.get("embed_model", "sentence-transformers/all-MiniLM-L6-v2")
    similarity = params.get("similarity", "cosine")

    if not query or not query.strip():
        raise ValueError(
            "query is required and cannot be empty or whitespace-only. "
            "Provide a search query to find relevant content."
        )

    if len(query) > 5000:
        raise ValueError(
            f"query is too long ({len(query)} characters, ~{len(query)//4} tokens). "
            "Maximum recommended length is ~5000 characters (~1250 tokens). "
            "Break long queries into smaller, focused searches."
        )

    if not index_name or not index_name.strip():
        raise ValueError("index_name is required and cannot be empty")

    if not isinstance(top_k, int) or top_k <= 0:
        raise ValueError(
            f"top_k must be a positive integer, got: {top_k}. "
            "Specify how many results to return (e.g., top_k=5)."
        )

    if top_k > 1000:
        raise ValueError(
            f"top_k ({top_k}) is too large. "
            "Maximum is 1000 results to prevent performance issues. "
            "Use smaller top_k values for better performance."
        )

    valid_similarities = {"cosine", "euclidean", "dot_product", "l2"}
    if similarity not in valid_similarities:
        raise ValueError(
            f"similarity '{similarity}' is not valid. "
            f"Choose from: {', '.join(sorted(valid_similarities))}. "
            "Default is 'cosine' for most use cases."
        )

    _logger.info(f"Searching '{index_name}' for: {query[:50]}...")

    Settings.embed_model = configure_embedding_model(embed_model)

    pdir = Path(persist_dir) / index_name
    if not pdir.exists():
        raise ValueError(
            f"Index '{index_name}' does not exist. "
            f"Create the index first using rag.index before searching. "
            f"Available indices can be found in: {Path(persist_dir)}"
        )

    try:
        chroma_client = chromadb.PersistentClient(path=str(pdir))
        chroma_collection = chroma_client.get_or_create_collection(index_name)
        vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
        storage_ctx = StorageContext.from_defaults(vector_store=vector_store)

        index = VectorStoreIndex.from_vector_store(vector_store, storage_context=storage_ctx)

        raw_k = max(top_k * 2, top_k + 5)
        retriever = index.as_retriever(
            similarity_top_k=raw_k,
            similarity_measure=similarity,
        )
        nodes = retriever.retrieve(query)[:top_k] 

        hits = [
            {
                "chunk": n.get_content(),
                "score": n.score,
                "source": n.node.metadata.get("file_path", "unknown"),
                "line_range": estimate_line_numbers(
                    n.node.metadata.get("file_path", "unknown"),
                    n.node.start_char_idx or 0,
                    n.node.end_char_idx or 0,
                    CONTEXT_LINES,
                ),
                "start_char_idx": n.node.start_char_idx,
                "end_char_idx": n.node.end_char_idx,
                "node_id": n.node.node_id,
                "all_metadata": dict(n.node.metadata),
            }
            for n in nodes
        ]

        _logger.info(f"Found {len(hits)} results")

        return ToolResult(
            output={
                "query": query,
                "index": index_name,
                "hits": hits
            },
            metadata={"found": len(hits)}
        )

    except Exception as e:
        _logger.error(f"Search failed: {e}")
        return ToolResult(
            output={
                "query": query,
                "index": index_name,
                "hits": []
            },
            metadata={"found": 0, "error": str(e)}
        )


rag_search_spec = ToolSpec(
    name="rag.search",
    version="1.0",
    description="Search indexed content with vector similarity (semantic search)",
    effects=["disk"],
    in_schema={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query"
            },
            "index_name": {
                "type": "string",
                "description": "Index to search"
            },
            "top_k": {
                "type": "integer",
                "default": 5,
                "description": "Number of results"
            },
            "persist_dir": {
                "type": "string",
                "description": "Base directory for index storage (default: data/rag_data)"
            },
            "embed_model": {
                "type": "string",
                "default": "sentence-transformers/all-MiniLM-L6-v2",
                "description": "HuggingFace embedding model (must match indexing)"
            },
            "similarity": {
                "type": "string",
                "default": "cosine",
                "description": "Similarity measure: cosine, euclidean, etc."
            }
        },
        "required": ["query", "index_name"]
    },
    out_schema={
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "index": {"type": "string"},
            "hits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "chunk": {"type": "string"},
                        "score": {"type": "number"},
                        "source": {"type": "string"},
                        "line_range": {"type": "string"},
                        "start_char_idx": {"type": "integer"},
                        "end_char_idx": {"type": "integer"},
                        "node_id": {"type": "string"},
                        "all_metadata": {"type": "object"}
                    }
                }
            }
        }
    },
    fn=_tool_rag_search,
    rate_key="rag.search"
)


__all__ = ['rag_search_spec', 'estimate_line_numbers', 'get_chunk_with_context']