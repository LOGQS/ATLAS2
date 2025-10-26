#!/usr/bin/env python3
"""
RAG Tools Test UI - Interactive testing for RAG indexing and search with vector embeddings
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext
import sys
import os
import json
import threading
import time

# Add backend directory to Python path
# File is at: backend/tests/agents/rag_tools_test.py
# We need:  backend/ in the path
backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, backend_dir)

from agents.tools.tool_registry import ToolExecutionContext, tool_registry
from agents.tools.rag.rag_search_func import get_chunk_with_context
from pathlib import Path


class SettingsWindow:
    """Settings dialog for RAG configuration."""

    def __init__(self, parent, settings):
        self.window = tk.Toplevel(parent)
        self.window.title("RAG Settings")
        self.window.geometry("550x550")
        self.window.resizable(True, True)
        self.window.minsize(500, 500)

        self.settings = settings.copy()
        self.result = None

        frame = ttk.LabelFrame(self.window, text="Index Settings", padding=10)
        frame.grid(row=0, column=0, padx=10, pady=10, sticky="ew")

        ttk.Label(frame, text="Index Name:").grid(row=0, column=0, sticky="w", pady=5)
        self.index_name_var = tk.StringVar(value=settings.get('index_name', 'test_index'))
        ttk.Entry(frame, textvariable=self.index_name_var, width=30).grid(row=0, column=1, pady=5)

        ttk.Label(frame, text="Persist Directory:").grid(row=1, column=0, sticky="w", pady=5)
        self.persist_dir_var = tk.StringVar(value=settings.get('persist_dir', 'rag_index'))
        ttk.Entry(frame, textvariable=self.persist_dir_var, width=30).grid(row=1, column=1, pady=5)

        ttk.Label(frame, text="Chunk Size (tokens):").grid(row=2, column=0, sticky="w", pady=5)
        self.chunk_size_var = tk.IntVar(value=settings.get('chunk_size', 4096))
        ttk.Spinbox(frame, from_=512, to=16384, increment=512, textvariable=self.chunk_size_var, width=10).grid(
            row=2, column=1, pady=5, sticky="w"
        )

        ttk.Label(frame, text="Overlap:").grid(row=3, column=0, sticky="w", pady=5)
        self.overlap_var = tk.IntVar(value=settings.get('overlap', 200))
        ttk.Spinbox(frame, from_=50, to=500, increment=50, textvariable=self.overlap_var, width=10).grid(
            row=3, column=1, pady=5, sticky="w"
        )

        ttk.Label(frame, text="Embedding Speed:").grid(row=4, column=0, sticky="w", pady=5)
        self.speed_var = tk.StringVar(value=settings.get('speed', ''))
        speed_frame = ttk.Frame(frame)
        speed_frame.grid(row=4, column=1, pady=5, sticky="w")
        speed_combo = ttk.Combobox(speed_frame, textvariable=self.speed_var,
                                   values=['', 'fast', 'slow'], width=12, state='readonly')
        speed_combo.grid(row=0, column=0)
        ttk.Label(speed_frame, text="(fast=33MB, slow=305MB)", font=("Arial", 8)).grid(row=0, column=1, padx=5)

        ttk.Label(frame, text="Embedding Model:").grid(row=5, column=0, sticky="w", pady=5)
        self.embed_model_var = tk.StringVar(value=settings.get('embed_model', 'fast'))
        embed_entry = ttk.Entry(frame, textvariable=self.embed_model_var, width=30)
        embed_entry.grid(row=5, column=1, pady=5)
        ttk.Label(frame, text="(overridden by speed if set)", font=("Arial", 8)).grid(row=6, column=1, sticky="w")

        self.incremental_var = tk.BooleanVar(value=settings.get('incremental', True))
        ttk.Checkbutton(frame, text="Incremental Indexing", variable=self.incremental_var).grid(
            row=7, column=0, columnspan=2, sticky="w", pady=5
        )

        search_frame = ttk.LabelFrame(self.window, text="Search Settings", padding=10)
        search_frame.grid(row=1, column=0, padx=10, pady=10, sticky="ew")

        ttk.Label(search_frame, text="Max Results:").grid(row=0, column=0, sticky="w", pady=5)
        self.top_k_var = tk.IntVar(value=settings.get('top_k', 5))
        ttk.Spinbox(search_frame, from_=1, to=50, textvariable=self.top_k_var, width=10).grid(
            row=0, column=1, pady=5
        )

        ttk.Label(search_frame, text="Similarity:").grid(row=1, column=0, sticky="w", pady=5)
        self.similarity_var = tk.StringVar(value=settings.get('similarity', 'cosine'))
        ttk.Combobox(search_frame, textvariable=self.similarity_var, values=['cosine', 'euclidean', 'dot_product'],
                     width=15, state='readonly').grid(row=1, column=1, pady=5)

        display_frame = ttk.LabelFrame(self.window, text="Display Settings", padding=10)
        display_frame.grid(row=2, column=0, padx=10, pady=10, sticky="ew")

        self.show_context_var = tk.BooleanVar(value=settings.get('show_context', True))
        ttk.Checkbutton(display_frame, text="Show Context Lines", variable=self.show_context_var).grid(
            row=0, column=0, sticky="w", pady=5
        )

        button_frame = ttk.Frame(self.window)
        button_frame.grid(row=3, column=0, pady=10)

        ttk.Button(button_frame, text="OK", command=self.ok_clicked).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="Cancel", command=self.window.destroy).pack(side=tk.LEFT, padx=5)

    def ok_clicked(self):
        self.result = {
            'index_name': self.index_name_var.get(),
            'persist_dir': self.persist_dir_var.get(),
            'chunk_size': self.chunk_size_var.get(),
            'overlap': self.overlap_var.get(),
            'speed': self.speed_var.get(),
            'embed_model': self.embed_model_var.get(),
            'incremental': self.incremental_var.get(),
            'top_k': self.top_k_var.get(),
            'similarity': self.similarity_var.get(),
            'show_context': self.show_context_var.get()
        }
        self.window.destroy()


class RAGTestUI:
    """Main UI for testing RAG tools with vector embeddings."""

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("RAG Tools Test UI (Vector Embeddings)")
        self.root.geometry("1000x700")

        self.file_paths = []

        # Path resolution: tests/agents/rag_tools_test.py -> agents -> tests -> backend -> ATLAS2 (root)
        # Need 4 parents to reach root, then data/rag_data/test_rag_data
        default_persist_dir = str(Path(__file__).resolve().parent.parent.parent.parent / "data" / "rag_data" / "test_rag_data")

        self.settings = {
            'index_name': 'test_index',
            'persist_dir': default_persist_dir,
            'chunk_size': 4096,
            'overlap': 200,
            'speed': '',  # '' means use embed_model, 'fast' or 'slow' to use speed mode
            'embed_model': 'fast',
            'incremental': True,
            'top_k': 5,
            'similarity': 'cosine',
            'show_context': True
        }

        self.index_tool = tool_registry.get("rag.index")
        self.search_tool = tool_registry.get("rag.search")

        self.setup_ui()

    def setup_ui(self):
        """Setup the UI components."""

        toolbar = ttk.Frame(self.root)
        toolbar.pack(side=tk.TOP, fill=tk.X, padx=5, pady=5)

        ttk.Button(toolbar, text="Select Files", command=self.select_files).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="Select Folder", command=self.select_folder).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="Clear Files", command=self.clear_files).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="Settings", command=self.show_settings).pack(side=tk.LEFT, padx=2)

        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=5)

        ttk.Button(toolbar, text="Index Files", command=self.index_files).pack(side=tk.LEFT, padx=2)

        paned = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        left_frame = ttk.Frame(paned)
        paned.add(left_frame, weight=1)

        ttk.Label(left_frame, text="Files to Index:").pack(anchor=tk.W)

        list_frame = ttk.Frame(left_frame)
        list_frame.pack(fill=tk.BOTH, expand=True)

        scrollbar = ttk.Scrollbar(list_frame)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        self.file_listbox = tk.Listbox(list_frame, yscrollcommand=scrollbar.set, selectmode=tk.EXTENDED)
        self.file_listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.config(command=self.file_listbox.yview)

        self.file_count_label = ttk.Label(left_frame, text="0 files selected")
        self.file_count_label.pack(anchor=tk.W, pady=5)

        right_frame = ttk.Frame(paned)
        paned.add(right_frame, weight=2)

        search_frame = ttk.Frame(right_frame)
        search_frame.pack(fill=tk.X, pady=(0, 5))

        ttk.Label(search_frame, text="Search:").pack(side=tk.LEFT, padx=(0, 5))

        self.search_var = tk.StringVar()
        search_entry = ttk.Entry(search_frame, textvariable=self.search_var)
        search_entry.pack(side=tk.LEFT, fill=tk.X, expand=True)
        search_entry.bind('<Return>', lambda e: self.search())

        ttk.Button(search_frame, text="Search", command=self.search).pack(side=tk.LEFT, padx=(5, 0))

        self.notebook = ttk.Notebook(right_frame)
        self.notebook.pack(fill=tk.BOTH, expand=True)

        results_frame = ttk.Frame(self.notebook)
        self.notebook.add(results_frame, text="Search Results")

        self.results_text = scrolledtext.ScrolledText(results_frame, wrap=tk.WORD, width=60, height=20)
        self.results_text.pack(fill=tk.BOTH, expand=True)

        log_frame = ttk.Frame(self.notebook)
        self.notebook.add(log_frame, text="Index Log")

        self.log_text = scrolledtext.ScrolledText(log_frame, wrap=tk.WORD, width=60, height=20)
        self.log_text.pack(fill=tk.BOTH, expand=True)

        # Status bar with speed indicator
        status_frame = ttk.Frame(self.root)
        status_frame.pack(side=tk.BOTTOM, fill=tk.X)

        self.status_var = tk.StringVar(value="Ready")
        status_bar = ttk.Label(status_frame, textvariable=self.status_var, relief=tk.SUNKEN)
        status_bar.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self.speed_indicator_var = tk.StringVar(value="Model: default")
        speed_indicator = ttk.Label(status_frame, textvariable=self.speed_indicator_var, relief=tk.SUNKEN, width=30)
        speed_indicator.pack(side=tk.RIGHT)

        self._update_speed_indicator()

    def select_files(self):
        """Select files to index."""
        files = filedialog.askopenfilenames(
            title="Select files to index",
            filetypes=[("All Files", "*.*")]
        )

        if files:
            for file in files:
                if file not in self.file_paths:
                    self.file_paths.append(file)
                    self.file_listbox.insert(tk.END, os.path.basename(file))

            self.update_file_count()

    def select_folder(self):
        """Select a folder and add all code files, ignoring common build/cache directories."""
        folder = filedialog.askdirectory(title="Select folder to index")

        if not folder:
            return

        # Directories to ignore (case-insensitive)
        ignore_dirs = {
            '.git', '.svn', '.hg',
            'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache',
            '.venv', 'venv', 'env',
            'dist', 'build', 'out', 'target',
            'bin', 'obj', '.next', '.nuxt',
            'coverage', '.coverage',
            '.idea', '.vscode', '.vs'
        }

        # Code file extensions
        code_extensions = {
            '.py', '.js', '.ts', '.jsx', '.tsx',
            '.java', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
            '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.kts',
            '.scala', '.r', '.m', '.mm', '.html', '.css', '.scss', '.sass',
            '.sql', '.sh', '.bat', '.ps1', '.lua', '.dart', '.groovy',
            '.vb', '.fs', '.fsx', '.clj', '.cljs', '.erl', '.ex', '.exs',
            '.jl', '.nim', '.v', '.vhdl', '.asm', '.lisp', '.scm', '.rkt',
            '.ml', '.mli', '.hs', '.elm', '.f90', '.f', '.pas', '.pp',
            '.tcl', '.awk', '.sed', '.pl', '.pm', '.vue', '.svelte',
            '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
            '.md', '.rst', '.tex', '.txt'
        }

        added_count = 0
        self.log(f"Scanning folder: {folder}")

        for root, dirs, files in os.walk(folder):
            # Filter out ignored directories (modify dirs in-place to prevent traversal)
            dirs[:] = [d for d in dirs if d.lower() not in ignore_dirs and not d.startswith('.')]

            for file in files:
                file_path = os.path.join(root, file)
                file_ext = os.path.splitext(file)[1].lower()

                # Only add code files
                if file_ext in code_extensions:
                    if file_path not in self.file_paths:
                        self.file_paths.append(file_path)
                        # Show relative path for better readability
                        rel_path = os.path.relpath(file_path, folder)
                        self.file_listbox.insert(tk.END, rel_path)
                        added_count += 1

        self.update_file_count()
        self.log(f"Added {added_count} code files from folder")
        messagebox.showinfo("Folder Added", f"Added {added_count} code files from:\n{folder}")

    def clear_files(self):
        """Clear the file list."""
        self.file_paths.clear()
        self.file_listbox.delete(0, tk.END)
        self.update_file_count()

    def update_file_count(self):
        """Update the file count label."""
        count = len(self.file_paths)
        self.file_count_label.config(text=f"{count} file{'s' if count != 1 else ''} selected")

    def show_settings(self):
        """Show settings dialog."""
        dialog = SettingsWindow(self.root, self.settings)
        self.root.wait_window(dialog.window)

        if dialog.result:
            self.settings.update(dialog.result)
            self.log(f"Settings updated: {json.dumps(self.settings, indent=2)}")
            self._update_speed_indicator()

    def _update_speed_indicator(self):
        """Update the speed indicator in the status bar."""
        if self.settings['speed']:
            speed_info = {
                'fast': 'Fast (e5-small-v2, 33MB)',
                'slow': 'Slow (gte-multilingual-base, 305MB)'
            }
            indicator = f"Speed: {speed_info.get(self.settings['speed'], self.settings['speed'])}"
        else:
            model_short = self.settings['embed_model'].split('/')[-1]
            indicator = f"Model: {model_short}"
        self.speed_indicator_var.set(indicator)

    def index_files(self):
        """Index selected files using the RAG tool."""
        if not self.file_paths:
            messagebox.showwarning("No Files", "Please select files to index first.")
            return

        self.status_var.set("Indexing files...")
        self.log_text.delete(1.0, tk.END)
        self.log("Starting indexing process...")

        # Log which model is being used
        if self.settings['speed']:
            speed_models = {'fast': 'intfloat/e5-small-v2 (33MB)', 'slow': 'Alibaba-NLP/gte-multilingual-base (305MB)'}
            model_info = speed_models.get(self.settings['speed'], self.settings['speed'])
            self.log(f"Using speed mode: {self.settings['speed']} -> {model_info}")
        else:
            self.log(f"Using embedding model: {self.settings['embed_model']}")

        thread = threading.Thread(target=self._index_worker, daemon=True)
        thread.start()

    def _index_worker(self):
        """Worker thread for indexing with full RAG."""
        start_time = time.time()
        try:
            ctx = ToolExecutionContext(
                chat_id="test_chat",
                plan_id="test_plan",
                task_id="test_task",
                ctx_id="test_ctx"
            )

            self.log(f"\nIndexing {len(self.file_paths)} files...")
            self.log(f"Index: {self.settings['index_name']}")
            self.log(f"Chunk size: {self.settings['chunk_size']}, Overlap: {self.settings['overlap']}")

            # Build params with speed if set
            params = {
                'file_paths': self.file_paths,
                'index_name': self.settings['index_name'],
                'persist_dir': self.settings['persist_dir'],
                'chunk_size': self.settings['chunk_size'],
                'overlap': self.settings['overlap'],
                'embed_model': self.settings['embed_model'],
                'incremental': self.settings['incremental']
            }

            # Add speed parameter if set
            if self.settings['speed']:
                params['speed'] = self.settings['speed']

            result = self.index_tool.fn(params, ctx)

            elapsed_time = time.time() - start_time
            output = result.output
            chunks = output.get('chunks', 0)
            status = output.get('status', 'unknown')

            self.log(f"\n✅ Indexing complete!")
            self.log(f"  Status: {status}")
            self.log(f"  Chunks created: {chunks}")
            if output.get('files'):
                self.log(f"  Files processed: {output['files']}")
            self.log(f"  ⏱️  Time taken: {elapsed_time:.2f} seconds ({elapsed_time/60:.2f} minutes)")

            self.root.after(0, lambda: self.status_var.set(
                f"Indexed {len(self.file_paths)} files, {chunks} chunks in {elapsed_time:.1f}s"
            ))

        except Exception as e:
            elapsed_time = time.time() - start_time
            self.log(f"\n❌ Indexing failed after {elapsed_time:.2f} seconds: {str(e)}")
            import traceback
            self.log(traceback.format_exc())
            self.root.after(0, lambda: self.status_var.set("Indexing failed"))

    def search(self):
        """Search the index using vector similarity."""
        query = self.search_var.get().strip()
        if not query:
            messagebox.showwarning("No Query", "Please enter a search query.")
            return

        self.status_var.set(f"Searching for: {query}")
        self.results_text.delete(1.0, tk.END)

        thread = threading.Thread(target=self._search_worker, args=(query,), daemon=True)
        thread.start()

    def _search_worker(self, query):
        """Worker thread for searching with vector similarity."""
        try:
            ctx = ToolExecutionContext(
                chat_id="test_chat",
                plan_id="test_plan",
                task_id="test_task",
                ctx_id="test_ctx"
            )

            # Build params with speed if set
            params = {
                'query': query,
                'index_name': self.settings['index_name'],
                'persist_dir': self.settings['persist_dir'],
                'top_k': self.settings['top_k'],
                'embed_model': self.settings['embed_model'],
                'similarity': self.settings['similarity']
            }

            # Add speed parameter if set (must match indexing speed)
            if self.settings['speed']:
                params['speed'] = self.settings['speed']

            result = self.search_tool.fn(params, ctx)

            output = result.output
            hits = output.get('hits', [])

            self.root.after(0, lambda: self._display_results(query, hits))

        except Exception as e:
            error_msg = f"Search failed: {str(e)}"
            self.root.after(0, lambda: self.results_text.insert(tk.END, error_msg))
            self.root.after(0, lambda: self.status_var.set("Search failed"))

    def _display_results(self, query, hits):
        """Display search results."""
        self.results_text.delete(1.0, tk.END)

        if not hits:
            self.results_text.insert(tk.END, f"No results found for: {query}")
            self.status_var.set("No results found")
            return

        self.results_text.insert(tk.END, f"Found {len(hits)} results for: {query}\n")
        self.results_text.insert(tk.END, f"(Using {self.settings['similarity']} similarity)\n")
        self.results_text.insert(tk.END, "=" * 80 + "\n\n")

        for i, hit in enumerate(hits, 1):
            self.results_text.insert(tk.END, f"Result #{i}\n", "heading")
            self.results_text.insert(tk.END, "-" * 60 + "\n")

            self.results_text.insert(tk.END, f"Score: {hit['score']:.4f}\n", "score")
            self.results_text.insert(tk.END, f"Source: {hit['source']}\n")

            if hit.get('line_range'):
                self.results_text.insert(tk.END, f"Lines: {hit['line_range']}\n")

            self.results_text.insert(tk.END, "\nContent:\n", "content_label")

            if self.settings['show_context'] and hit.get('start_char_idx') is not None:
                try:
                    context = get_chunk_with_context(
                        hit['source'],
                        hit['start_char_idx'],
                        hit['end_char_idx']
                    )
                    self.results_text.insert(tk.END, context + "\n")
                except:
                    self.results_text.insert(tk.END, hit['chunk'] + "\n")
            else:
                self.results_text.insert(tk.END, hit['chunk'] + "\n")

            self.results_text.insert(tk.END, "\n" + "=" * 80 + "\n\n")

        self.results_text.tag_config("heading", font=("Arial", 11, "bold"))
        self.results_text.tag_config("score", foreground="blue")
        self.results_text.tag_config("content_label", font=("Arial", 10, "bold"))

        self.status_var.set(f"Found {len(hits)} results")

        self.notebook.select(0)

    def log(self, message):
        """Log a message to the log tab."""
        self.root.after(0, lambda: self.log_text.insert(tk.END, message + "\n"))
        self.root.after(0, lambda: self.log_text.see(tk.END))

    def run(self):
        """Run the application."""
        self.root.mainloop()


if __name__ == "__main__":
    app = RAGTestUI()
    app.run()