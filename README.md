# ATLAS2

An AI chat application.

## Project Status

🚧 **Work in Progress** - Still building this thing out.

### Features

**Chat**
- Talk to AI models (Gemini for now)
- Real-time responses 
- Save conversation history
- Export/import chats
- **Message-level versioning**: Edit, retry, or delete any message; each operation creates a new chat version
- **Chat version tree**: Visualize and switch between different chat versions (branches)
- **Message version switcher**: Switch between different versions of a message

**File Handling**
- Upload files and have the AI read them
- Handles PDFs, text files, etc.

**Technical Bits**
- Flask backend, React frontend
- SQLite for storage
- Server-sent events for live updates
- Multiprocessing for file uploads
- Modular hooks and state managers for versioning, TTS, and chat operations

## Setup

Need Node.js 16+ and Python 3.8+

```bash
git clone https://github.com/LOGQS/ATLAS2.git
cd ATLAS2
python -m venv .venv
call .venv\Scripts\activate.bat
npm run install:all
```

If `npm run install:all` does not work, manually install:              

```bash
git clone https://github.com/LOGQS/ATLAS2.git
cd ATLAS2
npm install
python -m venv .venv
call .venv\Scripts\activate.bat
pip install -r requirements.txt
cd frontend
npm install
```

Create `.env` file in root dir:
```env
GEMINI_API_KEY=your_key_here
GROQ_API_KEY=your_key_here
REACT_APP_API_BASE_URL=http://localhost:5000
```

Run it:
```bash
npm start
```

Backend runs on port 5000, frontend on 3000.

## Project Structure

```
ATLAS2/
├── backend/
│   ├── agents/
│   │   ├── prompts/
│   │   │   ├── planner_prompt.py
│   │   │   └── router_prompt.py
│   │   ├── roles/
│   │   │   ├── ag_interface.py
│   │   │   ├── planner.py
│   │   │   └── router.py
│   │   └── tools/
│   │       └── func_interface.py
│   ├── app.py
│   ├── chat/
│   │   ├── chat.py
│   │   ├── chat_worker.py
│   │   ├── providers.py
│   │   └── worker_pool.py
│   ├── context/
│   │   └── context_manager.py
│   ├── features/
│   │   ├── audio_processor.py
│   │   ├── image_generation.py
│   │   ├── image_providers.py
│   │   ├── stt.py
│   │   └── stt_providers.py
│   ├── file_utils/
│   │   ├── file_handler.py
│   │   ├── file_operations.py
│   │   ├── file_provider_manager.py
│   │   ├── file_sync.py
│   │   ├── filesystem_watcher.py
│   │   ├── markdown_processor.py
│   │   └── upload_worker.py
│   ├── route/
│   │   ├── agent_routes.py
│   │   ├── chat_route.py
│   │   ├── db_bulk_route.py
│   │   ├── db_chat_management_route.py
│   │   ├── db_message_route.py
│   │   ├── db_route_utils.py
│   │   ├── db_versioning_route.py
│   │   ├── file_browser_route.py
│   │   ├── file_route.py
│   │   ├── image_route.py
│   │   └── stt_route.py
│   └── utils/
│       ├── cancellation_manager.py
│       ├── config.py
│       ├── db_utils.py
│       ├── db_validation.py
│       ├── format_validator.py
│       ├── logger.py
│       ├── message_versioning.py
│       ├── rate_limiter.py
│       └── token_counter.py
├── frontend/
│   ├── build/
│   ├── node_modules/
│   ├── package-lock.json
│   ├── package.json
│   ├── public/
│   │   ├── index.html
│   │   └── manifest.json
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── chat/
│   │   │   │   ├── Chat.tsx
│   │   │   │   ├── ChatVersionsWindow.tsx
│   │   │   │   ├── RouterBox.tsx
│   │   │   │   └── ThinkBox.tsx
│   │   │   ├── files/
│   │   │   │   ├── AttachedFiles.tsx
│   │   │   │   ├── EmbeddedFileViewer.tsx
│   │   │   │   └── UserMessageFiles.tsx
│   │   │   ├── input/
│   │   │   │   ├── MessageInputArea.tsx
│   │   │   │   ├── SendButton.tsx
│   │   │   │   └── VoiceChatMuteButton.tsx
│   │   │   ├── layout/
│   │   │   │   ├── LeftSidebar.tsx
│   │   │   │   └── RightSidebar.tsx
│   │   │   ├── message/
│   │   │   │   ├── MessageControls.tsx
│   │   │   │   ├── MessageEditEmbed.tsx
│   │   │   │   ├── MessageInfoOverlay.tsx
│   │   │   │   ├── MessageRenderer.tsx
│   │   │   │   ├── MessageVersionSwitcher.tsx
│   │   │   │   ├── MessageWrapper.tsx
│   │   │   │   └── UserMessage.tsx
│   │   │   ├── ui/
│   │   │   │   ├── GlobalFileViewer.tsx
│   │   │   │   ├── ModalWindow.tsx
│   │   │   │   └── Tooltip.tsx
│   │   │   ├── versioning/
│   │   │   │   ├── VersioningHelpers.tsx
│   │   │   │   └── VersionNode.tsx
│   │   │   └── visualization/
│   │   │   │   ├── PerformanceMonitor.tsx
│   │   │   │   ├── TreeVisualization.tsx
│   │   │   │   └── TriggerLog.tsx
│   │   ├── config/
│   │   │   ├── api.ts
│   │   │   ├── chat.ts
│   │   │   └── providers.ts
│   │   ├── constants/
│   │   │   └── sources.ts
│   │   ├── hooks/
│   │   │   ├── app/
│   │   │   │   └── useAppState.ts
│   │   │   ├── audio/
│   │   │   │   └── useVoiceChat.ts
│   │   │   ├── chat/
│   │   │   │   ├── useBulkOperations.ts
│   │   │   │   ├── useChatHistory.ts
│   │   │   │   └── useMessageIdSync.ts
│   │   │   ├── files/
│   │   │   │   ├── FileOperations.ts
│   │   │   │   ├── FileStateUtils.ts
│   │   │   │   ├── useDragDrop.ts
│   │   │   │   ├── useFileBrowser.ts
│   │   │   │   ├── useFileManagement.ts
│   │   │   │   └── useLiveFileBrowser.ts
│   │   │   ├── sources/
│   │   │   │   └── useSourceManager.ts
│   │   │   ├── ui/
│   │   │   │   ├── useBottomInputToggle.ts
│   │   │   │   ├── useEditModal.ts
│   │   │   │   ├── usePendingOps.ts
│   │   │   │   ├── useScrollControl.ts
│   │   │   │   └── useTTS.ts
│   │   │   ├── versioning/
│   │   │   │   └── useVersioning.ts
│   │   ├── index.tsx
│   │   ├── sections/
│   │   │   ├── GalleryWindow.tsx
│   │   │   ├── KnowledgeSection.tsx
│   │   │   ├── SearchWindow.tsx
│   │   │   ├── SettingsWindow.tsx
│   │   │   ├── SourcesWindow.tsx
│   │   │   └── WorkspaceWindow.tsx
│   │   ├── styles/
│   │   │   ├── app/
│   │   │   │   └── App.css
│   │   │   ├── chat/
│   │   │   │   ├── Chat.css
│   │   │   │   ├── ChatVersionsWindow.css
│   │   │   │   ├── RouterBox.css
│   │   │   │   └── ThinkBox.css
│   │   │   ├── files/
│   │   │   │   ├── AttachedFiles.css
│   │   │   │   ├── EmbeddedFileViewer.css
│   │   │   │   └── UserMessageFiles.css
│   │   │   ├── layout/
│   │   │   │   ├── LeftSidebar.css
│   │   │   │   └── RightSidebar.css
│   │   │   ├── message/
│   │   │   │   ├── MessageControls.css
│   │   │   │   ├── MessageEditEmbed.css
│   │   │   │   ├── MessageInfoOverlay.css
│   │   │   │   ├── MessageRenderer.css
│   │   │   │   ├── MessageVersionSwitcher.css
│   │   │   │   └── MessageWrapper.css
│   │   │   ├── sections/
│   │   │   │   ├── GalleryWindow.css
│   │   │   │   ├── KnowledgeSection.css
│   │   │   │   ├── SearchWindow.css
│   │   │   │   ├── SettingsWindow.css
│   │   │   │   ├── SourcesWindow.css
│   │   │   │   └── WorkspaceWindow.css
│   │   │   ├── ui/
│   │   │   │   ├── GlobalFileViewer.css
│   │   │   │   ├── ModalWindow.css
│   │   │   │   └── Tooltip.css
│   │   │   └── visualization/
│   │   │   │   ├── PerformanceMonitor.css
│   │   │   │   ├── TreeVisualization.css
│   │   │   │   └── TriggerLog.css
│   │   ├── tests/
│   │   │   ├── expected_behaviours.md
│   │   │   ├── operations.txt
│   │   │   ├── ran_tests/
│   │   │   │   └── README.md
│   │   │   ├── versioning/
│   │   │   │   ├── mockEnvironment.ts
│   │   │   │   ├── README.md
│   │   │   │   ├── scenarios.ts
│   │   │   │   ├── testResultSaver.ts
│   │   │   │   ├── testRunner.ts
│   │   │   │   ├── TestUI.css
│   │   │   │   ├── TestUI.tsx
│   │   │   │   └── types.ts
│   │   ├── types/
│   │   │   └── messages.ts
│   │   ├── utils/
│   │   │   ├── audio/
│   │   │   │   └── audioRecorder.ts
│   │   │   ├── chat/
│   │   │   │   ├── ChatHistoryCache.ts
│   │   │   │   ├── ComponentReloadNotifier.ts
│   │   │   │   ├── LiveStore.ts
│   │   │   │   ├── OperationLoadingManager.ts
│   │   │   │   ├── SendButtonStateManager.ts
│   │   │   │   ├── chatHelpers.ts
│   │   │   │   └── chatUtils.ts
│   │   │   ├── core/
│   │   │   │   ├── logger.ts
│   │   │   │   └── performanceTracker.ts
│   │   │   ├── storage/
│   │   │   │   └── BrowserStorage.ts
│   │   │   ├── versioning/
│   │   │   │   └── versionSwitchLoadingManager.ts
│   │   └── tsconfig.json
├── LICENSE
├── node_modules/
├── package-lock.json
├── package.json
├── README.md
├── requirements.txt
```

## License

MIT - see [LICENSE](LICENSE)
