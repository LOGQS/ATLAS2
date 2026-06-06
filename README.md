# ATLAS2

A locally-hosted AI assistant with chat, code editing, and web capabilities.

## Project Status
- Update (06.06.2026): Dropped, moved on to atlas3 from atlas2.

🚧 **Work in Progress** - Active development, not close to finishing.

### Features

**Chat**
- Multiple AI providers: Gemini, Groq, OpenRouter, Cerebras, HuggingFace
- Real-time streaming responses with Server-Sent Events
- Multiple concurrent chat sessions
- Message editing, retry, and deletion
- Chat history with import/export
- **Message-level versioning**: Edit, retry, or delete any message; each operation creates a new version branch
- **Chat version tree**: Visualize and navigate different chat versions and branches
- Router system for intelligent request routing based on complexity
- Context analysis and token tracking

**Voice & Audio**
- Speech-to-text with Groq Whisper and local Faster-Whisper
- Voice chat mode with continuous listening
- Text-to-speech for assistant responses
- Push-to-talk and auto-stop on silence

**Agentic System**
- Domain-based agent architecture (coder, web, teacher, system, data processor, memory, GUI control)
- 20+ built-in tools: file operations, web search, system commands, RAG, image generation
- Multi-step planning and execution
- Tool approval workflow
- Execution tracking with real-time activity feed

**Code Editor (Coder Mode)**
- Full-featured IDE with Monaco editor
- Multi-file editing with tabs and split panes
- Integrated terminal (xterm.js)
- File tree browser with lazy loading
- Command palette and quick file search
- Git integration (status, commit, diff)
- Checkpoint system for file history
- Diff viewer for code changes
- Two-model spec-driven development (planner + writer agents)
- Workspace management and history

**Web Capabilities**
- Web search
- Persistent browser sessions
- Browser automation with two modes: researcher and controller
- Profile management for anti-detection
- Live browser viewport streaming
- Screenshot capture
- Browser visibility toggle

**File Handling**
- Drag-and-drop file upload with multiprocessing
- File conversion to markdown (PDFs, Office docs, images via OCR)
- Live filesystem watching
- File browser with tree view
- Multi-file attachments per message
- Provider-specific file handling (Gemini API uploads)

**Image Generation**
- Pollinations AI integration
- Multiple Flux models (flux, flux-pro, flux-realism, flux-anime, flux-3d, turbo)
- Image gallery with filtering
- Customizable dimensions and generation parameters

**Knowledge & RAG**
- Document indexing with LlamaIndex
- ChromaDB vector store for semantic search
- HuggingFace embeddings
- Source tracking and management

**Versioning System**
- Complete version tree for chat branching
- Message version switching
- Parent-child relationship tracking
- Version visualization with D3.js

**Technical Architecture**
- Flask backend with REST API (port 5000)
- React 19 + TypeScript frontend (port 3000)
- Terminal service with WebSockets (port 5051)
- SQLite database with WAL mode
- Dual execution: async for cloud providers, multiprocessing for local/isolation
- Pre-spawned worker pool for zero-latency chat processing
- Rate limiting with per-provider token tracking
- Comprehensive logging and performance monitoring

## Setup

**Requirements:** Node.js 16+, Python 3.8+, Windows (locally hosted)

**Quick Setup:**
```bash
git clone https://github.com/LOGQS/ATLAS2.git
cd ATLAS2
python -m venv .venv
call .venv\Scripts\activate.bat
npm run install:all
```

**Manual Setup** (if quick setup fails):
```bash
git clone https://github.com/LOGQS/ATLAS2.git
cd ATLAS2
npm install
python -m venv .venv
call .venv\Scripts\activate.bat
pip install -r requirements.txt
crawl4ai-setup
cd frontend
npm install
```

**Environment Configuration:**

Create `.env` file in root directory:
```env
# API keys for the providers you want to use
GEMINI_API_KEY=your_gemini_key_here
GROQ_API_KEY=your_groq_key_here
CEREBRAS_API_KEY=your_cerebras_key_here
OPENROUTER_API_KEY=your_openrouter_key_here
POLLINATIONS_API_KEY=your_pollinations_key_here

# Frontend Configuration
REACT_APP_API_BASE_URL=http://localhost:5000
REACT_APP_TERMINAL_API_BASE_URL=http://localhost:5051

# Optional: Model-specific rate limit overrides
# Format: ATLAS_MODEL_OPTIONS_<PROVIDER>_<MODEL>={"rate_limit": {...}}
# Example: ATLAS_MODEL_OPTIONS_GEMINI_GEMINI_2_5_PRO={"rate_limit": {"requests_per_minute": 2, "requests_per_day": 50, "tokens_per_minute": 125000}}
```

**Run:**
```bash
npm start
```

This starts three services:
- **Backend**: http://localhost:5000 (Flask API)
- **Terminal**: http://localhost:5051 (WebSocket service)
- **Frontend**: http://localhost:3000 (React app)

## Project Structure

```
ATLAS2/
├── backend/                           # Python Flask backend (port 5000)
│   ├── agents/                        # Agentic system
│   │   ├── context/                   # Context management for agents
│   │   │   └── context_manager.py     # Token tracking, context building
│   │   ├── domains/                   # Domain-based agent specialization
│   │   │   ├── domain_configs/        # Domain specifications
│   │   │   │   ├── coder.py           # Code development domain
│   │   │   │   ├── web.py             # Web research/automation domain
│   │   │   │   ├── teacher.py         # Educational domain
│   │   │   │   ├── data_processor.py  # Data processing domain
│   │   │   │   ├── system_manager.py  # System operations domain
│   │   │   │   ├── memory.py          # Long-term memory domain
│   │   │   │   └── gui_control.py     # GUI automation domain
│   │   │   └── domain_registry.py     # Central domain registry
│   │   ├── events/                    # Event system for agent coordination
│   │   ├── execution/                 # Agent execution engine
│   │   │   └── single_domain_executor.py  # Domain task executor
│   │   ├── models/                    # Data models for agents
│   │   ├── prompts/                   # Agent prompt templates
│   │   │   ├── agent_prompt_templates.py  # Base templates
│   │   │   └── domain_instructions/   # Domain-specific instructions
│   │   ├── services/                  # Agent services
│   │   │   └── context_store.py       # Context storage
│   │   └── tools/                     # Tool registry and implementations
│   │       ├── tool_registry.py       # Central tool registry
│   │       ├── file_ops/              # File operation tools
│   │       │   ├── read_func.py       # Read files
│   │       │   ├── write_func.py      # Write files
│   │       │   ├── edit_func.py       # Edit files with diffs
│   │       │   ├── move_func.py       # Move/rename files
│   │       │   ├── search_func.py     # Search for files
│   │       │   ├── list_func.py       # List directory contents
│   │       │   ├── grep_func.py       # Search file contents
│   │       │   ├── attach_func.py     # Attach files to context
│   │       │   ├── move_lines_func.py # Move lines between files
│   │       │   └── notebook_edit_func.py  # Edit Jupyter notebooks
│   │       ├── llm/                   # LLM tool
│   │       │   └── llm_generate_func.py  # Generate text with LLMs
│   │       ├── media_generation/      # Media generation tools
│   │       │   └── image_generate_func.py  # Generate images
│   │       ├── plan_tools.py          # Planning tools
│   │       ├── rag/                   # RAG tools
│   │       │   ├── index_func.py      # Index documents
│   │       │   ├── rag_search_func.py # Search indexed docs
│   │       │   └── rag_utils.py       # RAG utilities
│   │       ├── system_ops/            # System operation tools
│   │       │   ├── exec_func.py       # Execute shell commands
│   │       │   └── exec_manage_func.py  # Manage executions
│   │       └── web_ops/               # Web operation tools
│   │           └── web_search_func.py # Web search with Crawl4AI
│   ├── app.py                         # Main Flask application
│   ├── chat/                          # Chat processing system
│   │   ├── chat.py                    # Main chat orchestrator
│   │   ├── chat_worker.py             # Worker process handler
│   │   ├── providers/                 # AI provider implementations
│   │   │   ├── base.py                # Base provider interface
│   │   │   ├── gemini.py              # Google Gemini
│   │   │   ├── groq.py                # Groq
│   │   │   ├── cerebras.py            # Cerebras
│   │   │   ├── openrouter.py          # OpenRouter
│   │   │   └── huggingface.py         # HuggingFace
│   │   └── worker_pool.py             # Pre-spawned worker pool
│   ├── features/                      # Feature implementations
│   │   ├── audio_processor.py         # Audio format conversion
│   │   ├── image_generation.py        # Image generation API
│   │   ├── image_providers.py         # Image generation providers
│   │   ├── stt.py                     # Speech-to-text
│   │   └── stt_providers.py           # STT providers (Groq, local)
│   ├── file_utils/                    # File handling utilities
│   │   ├── file_converter.py          # Convert files to markdown
│   │   ├── file_handler.py            # File operations
│   │   ├── file_operations.py         # Low-level file ops
│   │   ├── file_provider_manager.py   # Provider-specific uploads
│   │   ├── file_sync.py               # Database-filesystem sync
│   │   ├── filesystem_watcher.py      # Live file watching
│   │   ├── markdown_processor.py      # Markdown processing
│   │   └── upload_worker.py           # Background upload processing
│   ├── route/                         # API route definitions
│   │   ├── agent_routes.py            # Agent execution endpoints
│   │   ├── chat_route.py              # Chat endpoints
│   │   ├── coder_git_route.py         # Git operations
│   │   ├── coder_workspace_route.py   # Workspace management
│   │   ├── db_bulk_route.py           # Bulk database operations
│   │   ├── db_chat_management_route.py  # Chat CRUD
│   │   ├── db_message_route.py        # Message operations
│   │   ├── db_route_utils.py          # Route utilities
│   │   ├── db_versioning_route.py     # Versioning operations
│   │   ├── file_browser_route.py      # File browser API
│   │   ├── file_route.py              # File upload/download
│   │   ├── folder_picker_route.py     # Native folder picker
│   │   ├── image_route.py             # Image generation API
│   │   ├── rate_limit_route.py        # Rate limit management
│   │   ├── stt_route.py               # Speech-to-text API
│   │   └── token_route.py             # Token usage tracking
│   ├── services/                      # Backend services
│   │   └── web/                       # Web automation services
│   │       └── session_manager.py     # Browser session manager
│   ├── tests/                         # Backend tests
│   └── utils/                         # Backend utilities
│       ├── cancellation_manager.py    # Cancellation tracking
│       ├── config.py                  # Configuration management
│       ├── db_utils.py                # Database operations
│       ├── db_validation.py           # Input validation
│       ├── format_validator.py        # Response validation
│       ├── logger.py                  # Logging system
│       ├── message_versioning.py      # Message version tracking
│       ├── rate_limiter.py            # Rate limiting
│       ├── retry_handler.py           # Retry logic
│       ├── token_counter.py           # Token counting
│       ├── web_browser_profile.py     # Browser profile management
│       └── window_manager.py          # Window operations (Windows)
├── frontend/                          # React + TypeScript frontend (port 3000)
│   ├── public/                        # Static assets
│   │   ├── index.html
│   │   └── manifest.json
│   ├── src/
│   │   ├── App.tsx                    # Main application (2400+ lines)
│   │   ├── index.tsx                  # Entry point
│   │   ├── components/                # UI components
│   │   │   ├── agentic/               # Agentic UI components
│   │   │   │   └── DomainBox.tsx      # Domain execution UI
│   │   │   ├── chat/                  # Chat components
│   │   │   │   ├── Chat.tsx           # Main chat interface
│   │   │   │   ├── ChatVersionsWindow.tsx  # Version tree modal
│   │   │   │   ├── ContextWindow.tsx  # Context analysis
│   │   │   │   ├── RouterBox.tsx      # Router decision display
│   │   │   │   └── ThinkBox.tsx       # Reasoning display
│   │   │   ├── coder/                 # IDE components (28 files)
│   │   │   │   ├── EditorPane.tsx     # Monaco editor wrapper
│   │   │   │   ├── TabBar.tsx         # File tabs
│   │   │   │   ├── FileTree.tsx       # File browser tree
│   │   │   │   ├── DiffViewer.tsx     # Diff comparison
│   │   │   │   ├── TerminalPanel.tsx  # Integrated terminal
│   │   │   │   ├── CommandPalette.tsx # Command palette
│   │   │   │   ├── QuickFileSearch.tsx  # File search
│   │   │   │   ├── CheckpointTimeline.tsx  # File history
│   │   │   │   ├── ToolApprovalPanel.tsx  # Tool approval UI
│   │   │   │   ├── ExecutionActivityFeed.tsx  # Activity log
│   │   │   │   ├── PlanOverlay.tsx    # Plan visualization
│   │   │   │   ├── WorkspacePickerModal.tsx  # Workspace picker
│   │   │   │   └── SearchPanel.tsx    # Code search
│   │   │   ├── files/                 # File components
│   │   │   │   ├── AttachedFiles.tsx  # Attachment list
│   │   │   │   ├── EmbeddedFileViewer.tsx  # Inline viewer
│   │   │   │   └── UserMessageFiles.tsx  # Message files
│   │   │   ├── input/                 # Input components
│   │   │   │   ├── MessageInputArea.tsx  # Message input
│   │   │   │   ├── SendButton.tsx     # Send/stop button
│   │   │   │   └── VoiceChatMuteButton.tsx  # Mic control
│   │   │   ├── layout/                # Layout components
│   │   │   │   ├── LeftSidebar.tsx    # Chat history sidebar
│   │   │   │   └── RightSidebar.tsx   # Settings sidebar
│   │   │   ├── message/               # Message components
│   │   │   │   ├── MessageRenderer.tsx  # Markdown rendering
│   │   │   │   ├── MessageWrapper.tsx # Message container
│   │   │   │   ├── MessageControls.tsx  # Message actions
│   │   │   │   ├── UserMessage.tsx    # User message
│   │   │   │   ├── MessageVersionSwitcher.tsx  # Version nav
│   │   │   │   ├── MessageInfoOverlay.tsx  # Message metadata
│   │   │   │   └── MessageEditEmbed.tsx  # Inline editing
│   │   │   ├── ui/                    # UI primitives
│   │   │   │   ├── GlobalFileViewer.tsx  # File viewer modal
│   │   │   │   ├── ModalWindow.tsx    # Modal component
│   │   │   │   ├── Tooltip.tsx        # Tooltip component
│   │   │   │   ├── IconButton.tsx     # Icon button
│   │   │   │   ├── Slider.tsx         # Toggle slider
│   │   │   │   ├── Icons.tsx          # Icon library
│   │   │   │   └── PanelHeader.tsx    # Panel header
│   │   │   ├── versioning/            # Versioning components
│   │   │   │   ├── VersionNode.tsx    # Tree node
│   │   │   │   └── VersioningHelpers.tsx  # Version utilities
│   │   │   ├── visualization/         # Visualization components
│   │   │   │   ├── TreeVisualization.tsx  # Tree renderer
│   │   │   │   ├── TriggerLog.tsx     # Debug logger
│   │   │   │   └── PerformanceMonitor.tsx  # Performance display
│   │   │   └── web/                   # Web automation components
│   │   │       ├── ResearcherView.tsx # Research mode
│   │   │       ├── ControllerView.tsx # Controller mode
│   │   │       ├── BrowserViewport.tsx  # Browser display
│   │   │       ├── ProfileSetupView.tsx  # Profile setup
│   │   │       ├── WebActivityPanel.tsx  # Activity timeline
│   │   │       └── BrowserSettingsOverlay.tsx  # Settings
│   │   ├── config/                    # Configuration
│   │   │   ├── api.ts                 # API endpoints
│   │   │   ├── chat.ts                # Chat config
│   │   │   ├── monaco.ts              # Editor config
│   │   │   └── providers.ts           # Provider config
│   │   ├── constants/                 # Constants
│   │   ├── contexts/                  # React contexts
│   │   │   ├── CoderContext.tsx       # Coder state (2400+ lines)
│   │   │   └── WebContext.tsx         # Web state (490+ lines)
│   │   ├── hooks/                     # Custom React hooks
│   │   │   ├── app/                   # App hooks
│   │   │   ├── audio/                 # Audio hooks
│   │   │   │   └── useVoiceChat.ts    # Voice chat
│   │   │   ├── chat/                  # Chat hooks
│   │   │   │   ├── useChatHistory.ts  # History loading
│   │   │   │   ├── useBulkOperations.ts  # Bulk ops
│   │   │   │   └── useMessageIdSync.ts  # ID sync
│   │   │   ├── files/                 # File hooks
│   │   │   │   ├── useFileManagement.ts  # File state
│   │   │   │   ├── useFileBrowser.ts  # File browser
│   │   │   │   ├── useLiveFileBrowser.ts  # Live updates
│   │   │   │   └── useDragDrop.ts     # Drag & drop
│   │   │   ├── sources/               # Source hooks
│   │   │   ├── ui/                    # UI hooks
│   │   │   │   ├── useTTS.ts          # Text-to-speech
│   │   │   │   ├── useScrollControl.ts  # Auto-scroll
│   │   │   │   └── usePendingOps.ts   # Loading states
│   │   │   └── versioning/            # Versioning hooks
│   │   │       └── useVersioning.ts   # Version management
│   │   ├── sections/                  # Major windows/sections
│   │   │   ├── CoderWindow.tsx        # IDE workspace (690+ lines)
│   │   │   ├── WebWindow.tsx          # Browser interface (285+ lines)
│   │   │   ├── SettingsWindow.tsx     # Settings (1100+ lines)
│   │   │   ├── SearchWindow.tsx       # Search (550+ lines)
│   │   │   ├── WorkspaceWindow.tsx    # Workspace mgmt (420+ lines)
│   │   │   ├── SourcesWindow.tsx      # Sources (550+ lines)
│   │   │   ├── GalleryWindow.tsx      # Image gallery (130+ lines)
│   │   │   └── KnowledgeSection.tsx   # Knowledge base (185+ lines)
│   │   ├── styles/                    # CSS modules (mirrors components)
│   │   ├── tests/                     # Frontend tests
│   │   ├── types/                     # TypeScript type definitions
│   │   │   ├── messages.ts            # Message types
│   │   │   └── contextAnalysis.ts     # Context types
│   │   ├── utils/                     # Utility functions
│   │   │   ├── audio/                 # Audio utilities
│   │   │   ├── chat/                  # Chat utilities
│   │   │   │   ├── LiveStore.ts       # SSE event handling
│   │   │   │   ├── ChatHistoryCache.ts  # Message caching
│   │   │   │   └── chatHelpers.ts     # Helper functions
│   │   │   ├── core/                  # Core utilities
│   │   │   │   ├── logger.ts          # Logging
│   │   │   │   └── performanceTracker.ts  # Performance
│   │   │   ├── storage/               # Storage utilities
│   │   │   ├── text/                  # Text utilities
│   │   │   └── versioning/            # Version utilities
│   │   └── tsconfig.json              # TypeScript config
│   ├── package.json                   # Frontend dependencies
│   └── tailwind.config.js             # Tailwind config
├── services/                          # Node.js services
│   └── terminal/                      # Terminal service (port 5051)
│       └── index.js                   # WebSocket terminal server
├── LICENSE                            # MIT License
├── package.json                       # Root package config
├── README.md                          # This file
└── requirements.txt                   # Python dependencies
```

## License

MIT - see [LICENSE](LICENSE)

---

<sub>Built with [Crawl4AI](https://github.com/unclecode/crawl4ai) for web scraping and [LlamaIndex](https://www.llamaindex.ai/) for RAG capabilities.</sub>
