# ATLAS Creation System Documentation

## 1. Core Utility Files

### `creationsHelper.ts`

**Purpose:** Defines creation types and provides core utilities for handling creation functionality.

**Structure:**
- **CreationType Definition:** Defines all supported creation types:
  ```typescript
  export type CreationType = 
    | 'code'         // Any programming language with syntax highlighting
    | 'markdown'     // Formatted text documents 
    | 'html'         // HTML content (already supported via htmlPreview)
    | 'svg'          // SVG graphics
    | 'mermaid'      // Mermaid diagrams (flowcharts, sequence diagrams, etc.)
    | 'react'        // React components
    | 'placeholder'  // For placeholder images with specified dimensions
  ```
  
- **Creation Interface:**
  ```typescript
  export interface Creation {
    type: CreationType;
    content: string;
    title?: string;
    language?: string; // For code blocks
    metadata?: Record<string, unknown>; // Additional data specific to certain creation types
    id?: string; // Unique identifier for the creation
  }
  ```

- **Custom Event Types:**
  ```typescript
  export type ShowCreationEvent = CustomEvent<Creation>;
  export type UpdateStreamingContentEvent = CustomEvent<{content: string}>;
  ```

- **Global Event Declarations:**
  ```typescript
  declare global {
    interface WindowEventMap {
      'show-creation': ShowCreationEvent;
      'show-creation-modal': CustomEvent<Creation>;
      'update-streaming-content': UpdateStreamingContentEvent;
      'streaming-complete': Event;
    }
  }
  ```

- **Core Functions:**
  - `showCreation(creation)`: Dispatches event to show a creation in the viewer
  - `updateStreamingContent(content)`: Updates content during streaming process
  - `completeStreaming()`: Signals when streaming is complete
  - `detectCreations(content)`: Parses content for creation directives using regex patterns
  - `isValidCreationType(type)`: Validates if a type is a supported creation type
  - `removeCreationDirectives(content)`: Cleans content by removing creation directives

### `creationManager.ts`

**Purpose:** Singleton class that manages all creations throughout the application with persistent storage.

**Structure:**
- **Type Definitions:**
  ```typescript
  export type CreationEvent = 'add' | 'update' | 'remove' | 'view';
  export type CreationListener = (event: CreationEvent, creation: Creation, allCreations: Creation[]) => void;
  ```

- **Singleton Implementation:**
  ```typescript
  class CreationManager {
    private static instance: CreationManager;
    private creations: Creation[] = [];
    private listeners: CreationListener[] = [];
    private creationHistory: string[] = []; // Store IDs of viewed creations in order
    
    private constructor() {
      this.initializeStorage();
      this.checkBackendHealth();
    }
    
    public static getInstance(): CreationManager {
      if (!CreationManager.instance) {
        CreationManager.instance = new CreationManager();
      }
      return CreationManager.instance;
    }
  }
  ```

- **Backend Health Monitoring:**
  - Checks API health endpoint to determine if backend storage is available
  - Implements retry logic with exponential backoff
  - Fallbacks to session storage when backend is unavailable

- **Storage Management:**
  - `initializeStorage()`: Sets up storage and attempts to load existing creations
  - `saveToFileStorage()`: Persists data to backend API when available
  - `loadFromFileStorage()`: Retrieves creations from backend storage
  - `saveToSessionStorage()`: Fallback storage method using browser session storage
  - `loadFromSessionStorage()`: Loads from session storage when backend is unavailable

- **Creation Operations:**
  - `addCreation(creation)`: Adds new creation with auto-generated ID if needed
  - `getCreations()`: Retrieves all creations as an array
  - `getCreationsByType(type)`: Filters creations by specified type
  - `getCreationById(id)`: Looks up a specific creation by ID
  - `viewCreation(id)`: Records viewing history and triggers 'view' event
  - `removeCreation(id)`: Deletes a creation and updates storage
  - `renameCreation(id, newTitle)`: Updates creation title
  - `clearCreations()`: Removes all creations

- **History Management:**
  - Maintains an ordered array of viewed creation IDs
  - `getViewHistory()`: Returns the full history array
  - `getRecentCreations(limit)`: Returns most recently viewed creations

- **Event System:**
  - Observer pattern for notifying components of creation changes
  - `subscribe(listener)`: Registers a callback for creation events
  - `notifyListeners(event, creation, allCreations)`: Triggers all callbacks
  - Throttling for 'view' events to prevent notification spam

## 2. UI Components

### `CreationContent.tsx`

**Purpose:** Core renderer that handles specialized rendering for each creation type.

**Structure:**
- **Props Interface:**
  ```typescript
  interface CreationContentProps {
    creation: Creation;
    viewMode?: 'inline' | 'window' | 'fullscreen';
    showToolbar?: boolean;
  }
  ```

- **State Management:**
  - Theme state ('dark' | 'light')
  - Font size controls (10px to 24px range)
  - Line number visibility toggle
  - SandPack view mode for React components ('code' | 'preview' | 'split')
  
- **Advanced Rendering Systems:**
  - **Code rendering:** Syntax highlighting with SyntaxHighlighter
  - **Markdown rendering:** ReactMarkdown with remark-gfm plugin
  - **HTML rendering:** Iframe-based preview with sandbox
  - **SVG rendering:** Direct rendering via dangerouslySetInnerHTML
  - **Mermaid rendering:** Dynamic initialization with error handling
  - **React component rendering:** SandPack integration for live previews
  
- **Toolbar Functions:**
  - Copy to clipboard with toast notification
  - Download content as file with appropriate extensions
  - Font size controls
  - Theme toggle
  - Line number toggle for code
  - HTML preview launcher

- **React Component Handling:**
  - SandPack integration for React components
  - Error logging to backend API
  - Component source code download
  - View mode toggle between code and preview
  - Dependencies management

### `CreationViewer.tsx`

**Purpose:** Modal viewer that displays creations in a full-screen popup overlay.

**Structure:**
- **State Management:**
  - Visibility state
  - Current creation state
  - Rendered content (string or ReactNode)
  - Animation state ('entering' | 'visible' | 'exiting')
  
- **Event Handling:**
  - Listens for 'show-creation' custom events
  - Handles escape key for closing
  - Click outside to close functionality
  
- **Specialized Rendering:**
  - Leverages SyntaxHighlighter for code
  - ReactMarkdown for markdown content
  - Iframe for HTML content with "Open in Viewer" button
  - Direct rendering for SVG
  - Mermaid initialization for diagrams
  - Sandbox iframe for React components
  
- **UI Components:**
  - Modal overlay with animation
  - Header with creation title and type
  - Content area with rendered creation
  - Copy to clipboard functionality with feedback

### `CreationWindow.tsx`

**Purpose:** Side panel viewer for streaming and displaying creations.

**Structure:**
- **Props Interface:**
  ```typescript
  interface CreationWindowProps {
    creation: Creation | null;
    onClose: () => void;
    isStreaming?: boolean;
    content?: string;
  }
  ```

- **State Management:**
  - Animation state ('entering' | 'visible' | 'exiting')
  - View mode state ('code' | 'preview')
  - Displayed content for streaming updates
  
- **Streaming Support:**
  - Real-time content updates during streaming
  - Streaming indicator display
  - Auto-switching to preview mode after streaming ends
  
- **Event Handling:**
  - Escape key for closing
  - View mode toggle buttons
  
- **Layout:**
  - Side panel with fixed positioning
  - Header with type badge, title, and view mode toggle
  - Content area with code or preview rendering
  - Uses `CreationContent` component for preview mode

### `EnhancedCreationViewer.tsx`

**Purpose:** Advanced creation gallery with tabs, filtering, and management capabilities.

**Structure:**
- **Props Interface:**
  ```typescript
  interface EnhancedCreationViewerProps {
    isOpen: boolean;
    onClose: () => void;
  }
  ```

- **State Management:**
  - All creations list
  - Current selected creation
  - Active tab ('all' | 'recent' | 'html' | 'code' | 'other')
  - Filter text for search
  - Animation state ('entering' | 'entered' | 'exiting' | 'exited')
  - Toast notifications
  - Rename modal state
  
- **Creation Management:**
  - Integration with creationManager singleton
  - Subscription to creation events
  - Filtering by type and search text
  - Renaming functionality
  - Deletion capability
  
- **UI Components:**
  - Sidebar with tabs and search
  - Creation list with type icons and action buttons
  - Content view using `CreationContent` component
  - Rename modal with validation
  - Toast notifications for feedback
  
- **Advanced Features:**
  - Heuristic to detect meaningful creation changes
  - Debouncing for performance optimization
  - Click outside handling for modals
  - Keyboard navigation in rename modal

## 3. Styling

### `creation-window.css`

**Purpose:** Styling for the side panel creation window and notification components.

**Structure:**
- **Window Layout:**
  ```css
  .creation-window {
    position: fixed;
    right: 0;
    top: 0;
    width: 45%;
    max-width: 700px;
    min-width: 400px;
    height: 100vh;
    background-color: var(--bg-secondary);
    border-left: 1px solid var(--border-color);
    z-index: 1000;
    display: flex;
    flex-direction: column;
    box-shadow: -5px 0 15px rgba(0, 0, 0, 0.1);
    transform: translateX(100%);
    transition: transform 0.3s ease-in-out;
  }
  ```
  
- **Animation States:**
  ```css
  .creation-window.entering {
    transform: translateX(100%);
  }

  .creation-window.visible {
    transform: translateX(0);
  }

  .creation-window.exiting {
    transform: translateX(100%);
  }
  ```
  
- **Header Elements:**
  - Type badge with creation-specific colors
  - Title formatting with overflow handling
  - Close button styling
  
- **Type-Specific Styling:**
  ```css
  .creation-type-badge[data-type="html"] {
    background-color: #e34c26; /* HTML orange */
  }

  .creation-type-badge[data-type="code"] {
    background-color: #4a6ee0; /* Code blue */
  }

  .creation-type-badge[data-type="markdown"] {
    background-color: #1d70b8; /* Markdown blue */
  }
  
  /* etc. */
  ```
  
- **Creation Notification Box:**
  ```css
  .creation-notification {
    display: flex;
    align-items: center;
    margin: 10px 0;
    padding: 10px 12px;
    background-color: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  ```
  
- **Responsive Design:**
  ```css
  @media (max-width: 1024px) {
    .creation-window {
      width: 60%;
    }
  }

  @media (max-width: 768px) {
    .creation-window {
      width: 100%;
      max-width: 100%;
    }
  }
  ```

## 4. System Integration

These components work together to provide a comprehensive system for specialized content generation, viewing, and management:

1. **Content Creation Flow:**
   - The AI generates specialized content wrapped in creation directives
   - The message parser uses `creationsHelper.detectCreations()` to identify these directives
   - Detected creations are registered with `creationManager` for persistence
   - Creation notifications appear in messages for user interaction

2. **Viewing Flow:**
   - Clicking a creation notification triggers `showCreation()`
   - This dispatches a custom event that activates the appropriate viewer
   - The viewer renders the creation using specialized rendering based on type
   - The `creationManager` records the view in history

3. **Storage Flow:**
   - `creationManager` attempts to store creations in backend via API
   - If backend is unavailable, falls back to session storage
   - Periodic health checks attempt to reconnect to backend
   - When backend becomes available, session storage is migrated

4. **Management Flow:**
   - The `EnhancedCreationViewer` provides a gallery interface
   - Users can browse, filter, search, rename, and delete creations
   - The pub/sub system in `creationManager` ensures all views stay in sync
   - View history is maintained for quick access to recent creations

This architecture provides a flexible and extensible system for handling specialized content generation with robust persistence, advanced viewing options, and comprehensive management capabilities.

## 5. Technical Implementation Details

### Mermaid Diagram Rendering

The system loads the Mermaid library dynamically and initializes it with appropriate settings:

```typescript
let mermaid: any = null;
try {
  import('mermaid').then(m => {
    mermaid = m.default;
    
    if (!window.mermaidInitialized) {
      mermaid.initialize({
        startOnLoad: false,
        theme: document.body.classList.contains('light-theme') ? 'neutral' : 'dark',
        securityLevel: 'loose',
        logLevel: 'error',
        fontFamily: 'var(--font-sans)',
      });
      window.mermaidInitialized = true;
    }
  }).catch(e => {
    console.warn('Mermaid could not be loaded:', e);
  });
} catch (e) {
  console.warn('Mermaid import error:', e);
}
```

Rendering is handled through a ref-based approach with error handling and fallbacks.

### React Component Sandbox

React components are rendered using the SandPack library with a detailed configuration:

```typescript
<Sandpack
  template="react-ts"
  theme={theme === 'dark' ? 'dark' : 'light'}
  options={{
    showNavigator: false,
    showTabs: true,
    editorHeight: '100%',
    classes: {
      'sp-wrapper': 'custom-wrapper',
      'sp-layout': 'custom-layout',
      'sp-tab-button': 'custom-tab'
    },
    showConsole: true,
    showConsoleButton: false,
    showLineNumbers: showLineNumbers,
    wrapContent: true,
    showInlineErrors: true,
    showRefreshButton: true,
    resizablePanels: sandpackView === 'split'
  }}
  files={{
    "/App.tsx": creation.content,
    "/index.tsx": { /* Setup code */ },
    "/sandbox.config.json": { /* Configuration */ }
  }}
  customSetup={{
    dependencies: {
      "react": "^18.0.0",
      "react-dom": "^18.0.0",
      "d3": "^7.8.5", 
      "recharts": "^2.5.0",
      "prop-types": "^15.8.1",
      "lodash": "^4.17.21"
    }
  }}
/>
```

Error logging is implemented to capture and report React component errors to a backend API.

### Backend Persistence

The system implements a resilient storage strategy with backend health monitoring:

```typescript
private async checkBackendHealth(): Promise<void> {
  try {
    const response = await fetch('/api/health', {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache'
      }
    }).catch(() => {
      // Silently catch connection errors
      return { ok: false } as Response;
    });

    this.backendAvailable = response.ok;
    console.log(`Backend health check: ${this.backendAvailable ? 'Available' : 'Unavailable'}`);

    // If backend is available now and we haven't successfully loaded the gallery yet,
    // try to load it
    if (this.backendAvailable && !this.initialLoadAttempted && this.creations.length === 0) {
      console.log('Backend is now available. Attempting to load gallery...');
      this.loadFromFileStorage()
        .then(() => {
          this.initialLoadAttempted = true;
          console.log('Gallery loaded successfully after backend became available');
        })
        .catch(error => {
          console.warn('Failed to load gallery after backend became available:', error);
          // Continue using session storage
        });
    }

    // Retry logic with exponential backoff
    if (!this.backendAvailable && this.retryCount < this.maxRetries) {
      this.retryCount++;
      const retryDelay = Math.min(2000 * this.retryCount, 10000);
      // ...retry setup...
    }
  } catch (error) {
    // Error handling and retry logic
  }
}
```

This provides graceful degradation and automatic recovery when backend services are intermittently available.
