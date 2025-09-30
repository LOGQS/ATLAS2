# status: stable

from __future__ import annotations

import hashlib
import json
import multiprocessing
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional

from llama_index.core import (
    VectorStoreIndex,
    SimpleDirectoryReader,
    StorageContext,
    Settings,
    Document,
)
from llama_index.core.node_parser import CodeSplitter, SentenceSplitter
from llama_index.vector_stores.chroma import ChromaVectorStore
from llama_index.embeddings.huggingface import HuggingFaceEmbedding
import chromadb

from utils.logger import get_logger
from ...tools.tool_registry import ToolExecutionContext, ToolResult, ToolSpec
from .rag_utils import configure_embedding_model

_logger = get_logger(__name__)

CONTEXT_LINES = 2

EXT2LANG = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".jsx": "javascript",
    ".tsx": "typescript",
    ".c": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".hxx": "cpp",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".scala": "scala",
    ".go": "go",
    ".rs": "rust",
    ".cs": "csharp",
    ".php": "php",
    ".rb": "ruby",
    ".swift": "swift",
    ".m": "objective-c",
    ".mm": "objective-c",
    ".pl": "perl",
    ".pm": "perl",
    ".sh": "bash",
    ".bat": "bash",
    ".ps1": "powershell",
    ".psm1": "powershell",
    ".psd1": "powershell",
    ".lua": "lua",
    ".r": "r",
    ".jl": "julia",
    ".dart": "dart",
    ".groovy": "groovy",
    ".vb": "visual-basic",
    ".vbs": "visual-basic",
    ".fs": "fsharp",
    ".fsx": "fsharp",
    ".fsi": "fsharp",
    ".fsproj": "fsharp",
    ".sql": "sql",
    ".psql": "sql",
    ".asm": "assembly",
    ".s": "assembly",
    ".clj": "clojure",
    ".cljs": "clojure",
    ".cljc": "clojure",
    ".edn": "clojure",
    ".erl": "erlang",
    ".hrl": "erlang",
    ".ex": "elixir",
    ".exs": "elixir",
    ".el": "emacs-lisp",
    ".lisp": "commonlisp",
    ".scm": "scheme",
    ".ss": "scheme",
    ".rkt": "racket",
    ".ml": "ocaml",
    ".mli": "ocaml",
    ".ocaml": "ocaml",
    ".nim": "nim",
    ".d": "d",
    ".vala": "vala",
    ".v": "verilog",
    ".sv": "verilog",
    ".svh": "verilog",
    ".verilog": "verilog",
    ".vhdl": "vhdl",
    ".ada": "ada",
    ".adb": "ada",
    ".ads": "ada",
    ".pas": "pascal",
    ".pp": "pascal",
    ".inc": "pascal",
    ".tcl": "tcl",
    ".awk": "awk",
}


def _sha256_file(file_path: Path) -> str:
    """Calculate SHA-256 hash of a file."""
    h = hashlib.sha256()
    with file_path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_content(content: str) -> str:
    """Calculate SHA-256 hash of content string."""
    return hashlib.sha256(content.encode('utf-8')).hexdigest()


def _load_manifest(persist_dir: Path) -> Dict[str, str]:
    """Load file hash manifest for incremental indexing."""
    manifest_file = persist_dir / "manifest.json"
    try:
        with manifest_file.open() as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def _save_manifest(persist_dir: Path, manifest: Dict[str, str]) -> None:
    """Save file hash manifest."""
    manifest_file = persist_dir / "manifest.json"
    with manifest_file.open("w") as f:
        json.dump(manifest, f, indent=2)


def _get_parser_for_file(
    file_path: Path,
    token_chunk: int,       
    line_chunk: int = 200,   
    overlap: int = 200,        
):
    """Return a node-parser tuned per file type."""
    lang = EXT2LANG.get(file_path.suffix.lower())
    if lang:
        return CodeSplitter(
            language=lang,
            chunk_lines=line_chunk,
            chunk_lines_overlap=overlap,
        )
    
    return SentenceSplitter(
        chunk_size=token_chunk * 2,
        chunk_overlap=overlap,
        tokenizer="regex",
    )


def _process_single_document(args):
    """Process a single document - designed for parallel execution."""
    doc, token_chunk, overlap = args
    file_path = Path(doc.metadata.get("file_path", ""))
    parser = _get_parser_for_file(file_path, token_chunk, overlap)
    return parser.get_nodes_from_documents([doc])


def _hash_file_parallel(file_path: Path) -> tuple:
    """Hash a single file - designed for parallel execution."""
    try:
        current_hash = _sha256_file(file_path)
        return str(file_path), current_hash, None
    except Exception as e:
        return str(file_path), None, str(e)


def _tool_rag_index(params: Dict[str, Any], ctx: ToolExecutionContext) -> ToolResult:
    """
    Index content or files with full RAG capabilities (embeddings + vector DB).

    Supports two modes:
    1. Content mode: Index a content string directly
    2. File mode: Index files/directories with incremental updates
    """
    content = params.get("content")
    file_paths = params.get("file_paths", [])
    index_name = params.get("index_name", f"idx_{ctx.task_id}")

    default_persist_dir = str(Path(__file__).resolve().parent.parent.parent.parent.parent / "data" / "rag_data")
    persist_dir = params.get("persist_dir", default_persist_dir)

    chunk_size = params.get("chunk_size", 4096)
    overlap = params.get("overlap", 200)
    embed_model = params.get("embed_model", "sentence-transformers/all-MiniLM-L6-v2")
    incremental = params.get("incremental", True)
    max_workers = params.get("max_workers") or multiprocessing.cpu_count()

    if content and not file_paths:
        return _index_content_mode(
            content=content,
            index_name=index_name,
            persist_dir=persist_dir,
            chunk_size=chunk_size,
            overlap=overlap,
            embed_model=embed_model,
            ctx=ctx
        )
    elif file_paths:
        return _index_file_mode(
            file_paths=file_paths,
            index_name=index_name,
            persist_dir=persist_dir,
            chunk_size=chunk_size,
            overlap=overlap,
            embed_model=embed_model,
            incremental=incremental,
            max_workers=max_workers,
            ctx=ctx
        )
    else:
        raise ValueError("Either 'content' or 'file_paths' must be provided")


def _index_content_mode(
    content: str,
    index_name: str,
    persist_dir: str,
    chunk_size: int,
    overlap: int,
    embed_model: str,
    ctx: ToolExecutionContext
) -> ToolResult:
    """Index a single content string (lightweight mode for tool use)."""
    if not content:
        raise ValueError("Content is required for indexing")

    content_hash = _sha256_content(content)

    pdir = Path(persist_dir) / index_name
    pdir.mkdir(parents=True, exist_ok=True)

    manifest = _load_manifest(pdir)
    if manifest.get("content_hash") == content_hash:
        _logger.info(f"Content unchanged for '{index_name}', skipping")
        return ToolResult(
            output={
                "index_name": index_name,
                "chunks": manifest.get("chunk_count", 0),
                "status": "unchanged"
            },
            metadata={"skipped": True}
        )

    Settings.embed_model = configure_embedding_model(embed_model)

    doc = Document(text=content, metadata={"source": "content_string"})

    parser = SentenceSplitter(
        chunk_size=chunk_size * 2,
        chunk_overlap=overlap,
        tokenizer="regex",
    )
    nodes = parser.get_nodes_from_documents([doc])

    _logger.info(f"Generated {len(nodes)} nodes from content")

    chroma_client = chromadb.PersistentClient(path=str(pdir))
    chroma_collection = chroma_client.get_or_create_collection(index_name)
    vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
    storage_ctx = StorageContext.from_defaults(vector_store=vector_store)

    try:
        index = VectorStoreIndex.from_vector_store(vector_store, storage_context=storage_ctx)
        index.insert_nodes(nodes)
    except Exception:
        index = VectorStoreIndex(nodes=nodes, storage_context=storage_ctx, show_progress=True)

    index.storage_context.persist(persist_dir=str(pdir))
    manifest = {"content_hash": content_hash, "chunk_count": len(nodes)}
    _save_manifest(pdir, manifest)

    _logger.info(f"Indexed {len(nodes)} chunks into '{index_name}'")

    return ToolResult(
        output={
            "index_name": index_name,
            "chunks": len(nodes),
            "content_hash": content_hash[:8],
            "status": "indexed"
        },
        metadata=manifest
    )


def _index_file_mode(
    file_paths: List[str],
    index_name: str,
    persist_dir: str,
    chunk_size: int,
    overlap: int,
    embed_model: str,
    incremental: bool,
    max_workers: int,
    ctx: ToolExecutionContext
) -> ToolResult:
    """Index files/directories with full parallel processing (complete RAG mode)."""
    pdir = Path(persist_dir) / index_name
    pdir.mkdir(parents=True, exist_ok=True)

    manifest = _load_manifest(pdir) if incremental else {}

    all_files = []
    for path_str in file_paths:
        path = Path(path_str).resolve()
        if path.is_dir():
            all_files.extend([f for f in path.rglob("*") if f.is_file()])
        else:
            all_files.append(path)

    _logger.info(f"Found {len(all_files)} files to check")

    changed_files = []
    if incremental and all_files:
        _logger.info(f"Checking file hashes in parallel with {max_workers} workers...")

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            hash_futures = {executor.submit(_hash_file_parallel, f): f for f in all_files}

            for future in as_completed(hash_futures):
                file_path_str, current_hash, error = future.result()

                if error:
                    _logger.warning(f"Could not hash {file_path_str}: {error}")
                    continue

                stored_hash = manifest.get(file_path_str)
                if stored_hash != current_hash:
                    changed_files.append(Path(file_path_str))
                    manifest[file_path_str] = current_hash
    else:
        changed_files = all_files
        for file_path in all_files:
            try:
                manifest[str(file_path)] = _sha256_file(file_path)
            except Exception as e:
                _logger.warning(f"Could not hash {file_path}: {e}")

    if not changed_files and incremental:
        _logger.info(f"No changes detected, loading existing index from {pdir}")
        try:
            chroma_client = chromadb.PersistentClient(path=str(pdir))
            chroma_collection = chroma_client.get_or_create_collection(index_name)
            return ToolResult(
                output={
                    "index_name": index_name,
                    "chunks": len(manifest),
                    "status": "unchanged"
                },
                metadata={"skipped": True}
            )
        except Exception as e:
            _logger.warning(f"Could not load existing index: {e}, rebuilding...")
            changed_files = all_files

    if not changed_files:
        _logger.info("No files to process")
        return ToolResult(
            output={"index_name": index_name, "chunks": 0, "status": "empty"},
            metadata={}
        )

    _logger.info(f"Processing {len(changed_files)} {'changed' if incremental else ''} files")

    docs = SimpleDirectoryReader(
        input_files=[str(f) for f in changed_files],
        recursive=False,
        exclude_hidden=True,
    ).load_data()

    Settings.embed_model = configure_embedding_model(embed_model)

    _logger.info(f"Parsing documents in parallel with {max_workers} workers...")
    all_nodes = []
    doc_args = [(doc, chunk_size, overlap) for doc in docs]

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        parse_futures = [executor.submit(_process_single_document, args) for args in doc_args]

        for i, future in enumerate(as_completed(parse_futures), 1):
            try:
                nodes = future.result()
                all_nodes.extend(nodes)
                if i % 10 == 0 or i == len(parse_futures):
                    _logger.info(f"Processed {i}/{len(parse_futures)} documents")
            except Exception as e:
                _logger.warning(f"Failed to process document: {e}")

    _logger.info(f"Generated {len(all_nodes)} nodes from {len(docs)} documents")

    chroma_client = chromadb.PersistentClient(path=str(pdir))
    chroma_collection = chroma_client.get_or_create_collection(index_name)
    vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
    storage_ctx = StorageContext.from_defaults(vector_store=vector_store)

    _logger.info("Creating embeddings and building index...")
    if incremental and manifest:
        try:
            index = VectorStoreIndex.from_vector_store(vector_store, storage_context=storage_ctx)
            index.insert_nodes(all_nodes)
        except Exception as e:
            _logger.warning(f"Could not update existing index: {e}, creating new one")
            index = VectorStoreIndex(nodes=all_nodes, storage_context=storage_ctx, show_progress=True)
    else:
        index = VectorStoreIndex(nodes=all_nodes, storage_context=storage_ctx, show_progress=True)

    index.storage_context.persist(persist_dir=str(pdir))
    _save_manifest(pdir, manifest)

    _logger.info(f"Successfully indexed {len(all_nodes)} chunks from {len(changed_files)} files")

    return ToolResult(
        output={
            "index_name": index_name,
            "chunks": len(all_nodes),
            "files": len(changed_files),
            "status": "indexed"
        },
        metadata={"files_processed": len(changed_files), "nodes_created": len(all_nodes)}
    )


rag_index_spec = ToolSpec(
    name="rag.index",
    version="1.0",
    description="Index content or files with vector embeddings for semantic search",
    effects=["disk", "context"],
    in_schema={
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "Content to index (content mode)"
            },
            "file_paths": {
                "type": "array",
                "items": {"type": "string"},
                "description": "File or directory paths to index (file mode)"
            },
            "index_name": {
                "type": "string",
                "description": "Index identifier"
            },
            "persist_dir": {
                "type": "string",
                "description": "Base directory for index storage (default: data/rag_data)"
            },
            "chunk_size": {
                "type": "integer",
                "default": 4096,
                "description": "Token count per chunk for text"
            },
            "overlap": {
                "type": "integer",
                "default": 200,
                "description": "Overlap between chunks"
            },
            "embed_model": {
                "type": "string",
                "default": "sentence-transformers/all-MiniLM-L6-v2",
                "description": "HuggingFace embedding model"
            },
            "incremental": {
                "type": "boolean",
                "default": True,
                "description": "Skip unchanged files"
            },
            "max_workers": {
                "type": "integer",
                "description": "Parallel workers (default: CPU count)"
            }
        }
    },
    out_schema={
        "type": "object",
        "properties": {
            "index_name": {"type": "string"},
            "chunks": {"type": "integer"},
            "status": {"type": "string"}
        }
    },
    fn=_tool_rag_index,
    rate_key="rag.index"
)