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

**File Handling**
- Upload files and have the AI read them
- Handles PDFs, text files, etc.

**Technical Bits**
- Flask backend, React frontend
- SQLite for storage
- Server-sent events for live updates
- Multiprocessing for file uploads

## Setup

Need Node.js 16+ and Python 3.8+

```bash
git clone [<repo-url>](https://github.com/LOGQS/ATLAS2.git)
cd ATLAS2
python -m venv .venv
call .venv\Scripts\activate.bat
npm run install:all
```

If `npm run install:all` does not work, manually install:              

```bash
git clone [<repo-url>](https://github.com/LOGQS/ATLAS2.git)
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
REACT_APP_API_BASE_URL=http://localhost:5000 (or wherever you want to run it in)
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
│   │   └── providers.py
│   ├── file_utils/
│   │   ├── file_handler.py
│   │   ├── file_operations.py
│   │   ├── file_provider_manager.py
│   │   ├── file_sync.py
│   │   ├── markdown_processor.py
│   │   └── upload_worker.py
│   ├── route/
│   │   ├── chat_route.py
│   │   ├── db_route.py
│   │   └── file_route.py
│   └── utils/
│       ├── cancellation_manager.py
│       ├── config.py
│       ├── db_utils.py
│       ├── logger.py
│       ├── rate_limiter.py
│       └── token_counter.py
├── frontend/
│   ├── node_modules/
│   ├── package.json
│   ├── public/
│   │   ├── index.html
│   │   └── manifest.json
│   └── src/
│       ├── App.tsx
│       ├── index.tsx
│       ├── components/
│       │   ├── AttachedFiles.tsx
│       │   ├── Chat.tsx
│       │   ├── LeftSidebar.tsx
│       │   ├── MessageRenderer.tsx
│       │   ├── ModalWindow.tsx
│       │   ├── RightSidebar.tsx
│       │   ├── ThinkBox.tsx
│       │   ├── UserMessage.tsx
│       │   └── UserMessageFiles.tsx
│       ├── config/
│       │   └── api.ts
│       ├── hooks/
│       │   ├── useAppState.ts
│       │   └── useFileManagement.ts
│       ├── sections/
│       │   ├── GalleryWindow.tsx
│       │   ├── KnowledgeSection.tsx
│       │   ├── SearchWindow.tsx
│       │   └── SettingsWindow.tsx
│       ├── styles/
│       │   ├── App.css
│       │   ├── AttachedFiles.css
│       │   ├── Chat.css
│       │   ├── GalleryWindow.css
│       │   ├── KnowledgeSection.css
│       │   ├── LeftSidebar.css
│       │   ├── MessageRenderer.css
│       │   ├── ModalWindow.css
│       │   ├── RightSidebar.css
│       │   ├── SearchWindow.css
│       │   ├── SettingsWindow.css
│       │   ├── ThinkBox.css
│       │   └── UserMessageFiles.css
│       └── utils/
│           ├── BrowserStorage.ts
│           ├── LiveStore.ts
│           └── logger.ts
├── LICENSE
├── package.json
├── requirements.txt
```

## License

MIT - see [LICENSE](LICENSE)
