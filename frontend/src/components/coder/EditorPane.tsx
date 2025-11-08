import React, { useCallback, memo, useEffect, useRef, useState } from 'react';
import Editor, { type BeforeMount } from '@monaco-editor/react';
import { FileBreadcrumb } from './FileBreadcrumb';
import { PanelHeader } from '../ui/PanelHeader';
import { PanelHeaderButton } from '../ui/PanelHeaderButton';
import { Icons } from '../ui/Icons';
import { InlineDiffOverlay } from './InlineDiffOverlay';
import { useCoderContext } from '../../contexts/CoderContext';
import useMonacoScrollControl from '../../hooks/ui/useMonacoScrollControl';
import type * as Monaco from 'monaco-editor';
import '../../styles/coder/StreamingDiff.css';
import logger from '../../utils/core/logger';

type EditorOnMount = NonNullable<React.ComponentProps<typeof Editor>['onMount']>;

interface EditorPaneProps {
  document: {
    filePath: string;
    content: string;
    originalContent: string;
    language: string;
    isBinary: boolean;
  } | undefined;
  isUnsaved: boolean;
  isLoading: boolean;
  isActive: boolean;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onReset: () => void;
  onHistoryClick: () => void;
  onEditorWillMount: BeforeMount;
  onPaneClick: () => void;
  chatId?: string;
}

export const EditorPane = memo<EditorPaneProps>(({
  document,
  isUnsaved,
  isLoading,
  isActive,
  onContentChange,
  onSave,
  onReset,
  onHistoryClick,
  onEditorWillMount,
  onPaneClick,
  chatId,
}) => {
  const { pendingDiffs, acceptDiff, rejectDiff, acceptAllDiffs, rejectAllDiffs } = useCoderContext();

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      onContentChange(value);
    }
  }, [onContentChange]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [monacoEditor, setMonacoEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const layoutFrameRef = useRef<number | null>(null);
  const streamingDecorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Track backend decorations for this file
  const decorationCacheRef = useRef<Map<string, Array<{
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    type: 'add' | 'remove' | 'modify';
    className: string;
  }>>>(new Map());

  const [backendDecorations, setBackendDecorations] = useState<Array<{
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    type: 'add' | 'remove' | 'modify';
    className: string;
  }> | null>(null);

  // Auto-scroll control for streaming file content - uses Monaco API
  const isStreamingContent = !!backendDecorations && document?.filePath;
  const streamingState: 'thinking' | 'responding' | 'static' = isStreamingContent ? 'responding' : 'static';

  const scrollControl = useMonacoScrollControl({
    chatId: `editor-${document?.filePath}`,
    streamingState,
    editor: monacoEditor
  });

  const { isStreaming: scrollControlStreaming, isAutoScrollEnabled: scrollControlEnabled } = scrollControl;

  const scheduleEditorLayout = useCallback(() => {
    if (!editorRef.current) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }

    if (layoutFrameRef.current !== null) {
      window.cancelAnimationFrame(layoutFrameRef.current);
    }
    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = null;
      // Guard against editors that might have been disposed during the frame
      editorRef.current?.layout();
    });
  }, []);

  useEffect(() => {
    return () => {
      if (layoutFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(layoutFrameRef.current);
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      editorRef.current = null;
      setMonacoEditor(null);
    };
  }, []);

  useEffect(() => {
    scheduleEditorLayout();
  }, [scheduleEditorLayout, document?.filePath]);

  useEffect(() => {
    if (!document?.filePath) {
      setBackendDecorations(null);
      return;
    }

    const normalizePath = (path: string) =>
      path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');

    const normalizedPath = normalizePath(document.filePath);
    const cached = decorationCacheRef.current.get(normalizedPath) || null;
    setBackendDecorations(cached);
  }, [document?.filePath]);

  const handleEditorMount = useCallback<EditorOnMount>((editorInstance, _monaco) => {
    editorRef.current = editorInstance;
    setMonacoEditor(editorInstance);
    scheduleEditorLayout();

    logger.info('[BACKEND-DECORATIONS] Editor mounted, checking for pending diff');

    // Initialize decorations collection now that editor is ready
    if (!streamingDecorationsRef.current) {
      logger.info('[BACKEND-DECORATIONS] Creating decorations collection on mount');
      streamingDecorationsRef.current = editorInstance.createDecorationsCollection();
    }

    editorInstance.onKeyDown((e) => {
      const key = e.browserEvent.key;

      if ((e.browserEvent.ctrlKey || e.browserEvent.metaKey) && key === 's') {
        e.preventDefault();
        e.stopPropagation();
        onSave();
        return;
      }

      if ((key === 'a' || key === 's' || key === 'd') &&
          !e.browserEvent.ctrlKey && !e.browserEvent.metaKey &&
          !e.browserEvent.shiftKey && !e.browserEvent.altKey) {
        editorInstance.trigger('keyboard', 'type', { text: key });
        e.preventDefault();
        e.stopPropagation();
      }
    });

    if (!containerRef.current || typeof ResizeObserver === 'undefined') {
      return;
    }

    resizeObserverRef.current?.disconnect();

    const observer = new ResizeObserver(() => {
      scheduleEditorLayout();
    });

    observer.observe(containerRef.current);
    resizeObserverRef.current = observer;
  }, [onSave, scheduleEditorLayout]);

  // Listen for backend file operation events
  useEffect(() => {
    if (!chatId || !document?.filePath) return;

    const normalizePath = (path?: string | null) => {
      if (!path) return null;
      return path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
    };

    const documentPath = normalizePath(document.filePath);

    const handleFileOperation = (event: CustomEvent) => {
      const { file_path, decorations } = event.detail;
      const eventPath = normalizePath(file_path);

      if (eventPath && documentPath && eventPath === documentPath) {
        logger.info('[BACKEND-DECORATIONS] Received decorations for file', file_path, {
          decorationCount: Array.isArray(decorations) ? decorations.length : 0,
        });
        if (Array.isArray(decorations) && decorations.length > 0) {
          setBackendDecorations(decorations);
        }
      }

      if (eventPath && Array.isArray(decorations) && decorations.length > 0) {
        decorationCacheRef.current.set(eventPath, decorations);
        if (!documentPath || eventPath !== documentPath) {
          logger.debug('[BACKEND-DECORATIONS] Cached decorations for inactive file', eventPath);
        }
      }
    };

    const handleClearDecorations = (event: CustomEvent) => {
      const { file_path } = event.detail;
      const eventPath = normalizePath(file_path);

      if (eventPath) {
        decorationCacheRef.current.delete(eventPath);
      }

      if (eventPath && documentPath && eventPath === documentPath) {
        logger.info('[BACKEND-DECORATIONS] Clearing decorations for accepted file', file_path);
        setBackendDecorations(null);
      }
    };

    window.addEventListener('coderFileOperation', handleFileOperation as EventListener);
    window.addEventListener('clearFileDecorations', handleClearDecorations as EventListener);

    return () => {
      window.removeEventListener('coderFileOperation', handleFileOperation as EventListener);
      window.removeEventListener('clearFileDecorations', handleClearDecorations as EventListener);
    };
  }, [chatId, document?.filePath]);

  // Apply backend decorations to Monaco editor
  useEffect(() => {
    const editor = editorRef.current;

    if (!editor) {
      logger.info('[BACKEND-DECORATIONS] No editor ref yet, decorations will be applied when editor mounts');
      return;
    }

    // Initialize decorations collection if not already created
    if (!streamingDecorationsRef.current) {
      logger.info('[BACKEND-DECORATIONS] Creating new decorations collection');
      streamingDecorationsRef.current = editor.createDecorationsCollection();
    }

    if (!backendDecorations || backendDecorations.length === 0) {
      // Clear decorations if no backend decorations
      logger.info('[BACKEND-DECORATIONS] Clearing decorations (no backend decorations)');
      streamingDecorationsRef.current.clear();
      return;
    }

    // Convert backend decoration format to Monaco decoration format
    const decorationStatusClass = 'streaming-diff--idle';

    const monacoDecorations = backendDecorations.map((d: any) => ({
      range: new (window as any).monaco.Range(
        d.startLine,
        d.startColumn,
        d.endLine,
        d.endColumn
      ),
      options: {
        isWholeLine: d.endColumn === 1,
        className: [d.className, decorationStatusClass].filter(Boolean).join(' '),
      },
    }));

    logger.info('[BACKEND-DECORATIONS] Applying decorations', {
      count: monacoDecorations.length,
      decorations: monacoDecorations.map((d: any) => ({
        startLine: d.range.startLineNumber,
        endLine: d.range.endLineNumber,
        className: d.options.className,
      })),
    });

    streamingDecorationsRef.current.set(monacoDecorations);

    return () => {
      // Clean up on unmount or decoration change
      logger.info('[BACKEND-DECORATIONS] Cleanup: clearing decorations');
      streamingDecorationsRef.current?.clear();
    };
  }, [backendDecorations]);

  // Scroll to bottom handler
  const handleScrollToBottom = useCallback(() => {
    scrollControl.forceScrollToBottom();
  }, [scrollControl]);

  // Show/hide scroll button based on autoscroll state
  useEffect(() => {
    if (scrollControlStreaming) {
      setShowScrollButton(!scrollControlEnabled);
    } else {
      setShowScrollButton(false);
    }
  }, [scrollControlStreaming, scrollControlEnabled]);

  // Filter diffs for current file
  const currentFileDiffs = document
    ? Array.from(pendingDiffs.values()).filter(diff => diff.filePath === document.filePath)
    : [];
  const hasDiffs = currentFileDiffs.length > 0;

  if (!document) {
    return (
      <div
        className="welcome-screen flex-1"
        onClick={onPaneClick}
        style={{ opacity: isActive ? 1 : 0.6 }}
      >
        <div className="welcome-icon">
          <Icons.File className="w-16 h-16 opacity-50" />
        </div>
        <h3 className="welcome-title">No File Selected</h3>
        <p className="welcome-text">
          {isActive ? 'Select a file from the sidebar to start editing' : 'Click to activate this pane'}
        </p>
      </div>
    );
  }

  return (
    <div
      className={`flex-1 h-full flex flex-col ${isActive ? '' : 'opacity-60'}`}
      onClick={onPaneClick}
      style={{background: 'var(--bolt-elements-bg-depth-1)'}}
    >
      <PanelHeader>
        <FileBreadcrumb filePath={document.filePath} />
        <div className="flex gap-2 ml-auto items-center">
          <div title="View file history">
            <PanelHeaderButton onClick={onHistoryClick}>
              <Icons.Time className="w-3.5 h-3.5" />
              History
            </PanelHeaderButton>
          </div>
          {hasDiffs && (
            <>
              <PanelHeaderButton onClick={acceptAllDiffs}>
                <Icons.Check className="w-3.5 h-3.5" />
                Accept All ({currentFileDiffs.length})
              </PanelHeaderButton>
              <PanelHeaderButton onClick={rejectAllDiffs}>
                <Icons.Close className="w-3.5 h-3.5" />
                Reject All
              </PanelHeaderButton>
            </>
          )}
          {isUnsaved && (
            <>
              <PanelHeaderButton onClick={onSave}>
                <Icons.Save className="w-3.5 h-3.5" />
                Save
              </PanelHeaderButton>
              <PanelHeaderButton onClick={onReset}>
                <Icons.Discard className="w-3.5 h-3.5" />
                Reset
              </PanelHeaderButton>
            </>
          )}
        </div>
      </PanelHeader>

      <div className="flex-1 relative overflow-hidden modern-scrollbar" ref={containerRef}>
        {isLoading && (
          <div className="loading-overlay">
            <div className="spinner"></div>
          </div>
        )}
        <Editor
          height="100%"
          language={document.language}
          value={document.content}
          onChange={handleEditorChange}
          beforeMount={onEditorWillMount}
          onMount={handleEditorMount}
          theme="vs-dark"
          options={{
            fontSize: 14,
            fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Monaco', monospace",
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            automaticLayout: false,
            tabSize: 2,
            wordWrap: 'on',
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            folding: true,
            lineNumbers: 'on',
            renderLineHighlight: 'all',
            bracketPairColorization: { enabled: true },
          }}
        />
        {hasDiffs && (
          <InlineDiffOverlay
            diffs={currentFileDiffs}
            editor={editorRef.current}
            onAccept={acceptDiff}
            onReject={rejectDiff}
          />
        )}

        {/* Scroll to bottom button */}
        {showScrollButton && (
          <button
            className="editor-pane__scroll-button"
            onClick={handleScrollToBottom}
            aria-label="Scroll to bottom"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M10 3L10 14M10 14L6 10M10 14L14 10"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M4 17L16 17"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
});

EditorPane.displayName = 'EditorPane';
