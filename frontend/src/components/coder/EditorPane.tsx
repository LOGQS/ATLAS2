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

  const handleEditorChangeRef = useRef(onContentChange);
  useEffect(() => {
    handleEditorChangeRef.current = onContentChange;
  }, [onContentChange]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [monacoEditor, setMonacoEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoApiRef = useRef<typeof Monaco | null>(null);
  const isApplyingExternalRef = useRef(false);
  const lastSyncedContentRef = useRef('');
  const lastSyncedFileRef = useRef<string | undefined>(undefined);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const layoutFrameRef = useRef<number | null>(null);
  const streamingDecorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const decorationDebounceRef = useRef<number | null>(null);
  const isStreamingActiveRef = useRef(false);
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
      monacoApiRef.current = null;
      lastSyncedContentRef.current = '';
      lastSyncedFileRef.current = undefined;
      setMonacoEditor(null);
    };
  }, []);

  useEffect(() => {
    scheduleEditorLayout();
  }, [scheduleEditorLayout, document?.filePath]);

  const applyIncrementalContent = useCallback((nextContent: string, resetView: boolean, replaceAll = false) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) {
      return;
    }

    const previousContent = lastSyncedContentRef.current;

    if (replaceAll) {
      if (previousContent === nextContent) {
        return;
      }
      isApplyingExternalRef.current = true;
      model.setValue(nextContent);
      isApplyingExternalRef.current = false;
      if (resetView) {
        editor.setScrollTop(0);
        editor.revealLine(1);
      }
      lastSyncedContentRef.current = nextContent;
      return;
    }

    if (previousContent === nextContent) {
      return;
    }

    const prevLength = previousContent.length;
    const nextLength = nextContent.length;
    let start = 0;
    const minLen = Math.min(prevLength, nextLength);
    while (start < minLen && previousContent.charCodeAt(start) === nextContent.charCodeAt(start)) {
      start++;
    }

    let endPrev = prevLength - 1;
    let endNext = nextLength - 1;
    while (endPrev >= start && endNext >= start && previousContent.charCodeAt(endPrev) === nextContent.charCodeAt(endNext)) {
      endPrev--;
      endNext--;
    }

    const deleteFrom = start;
    const deleteTo = endPrev + 1;
    const insertText = nextContent.slice(start, endNext + 1);

    const rangeStart = model.getPositionAt(deleteFrom);
    const rangeEnd = model.getPositionAt(deleteTo);
    const monacoApi = monacoApiRef.current ?? (typeof window !== 'undefined' ? (window as any).monaco : null);
    const range = monacoApi
      ? new monacoApi.Range(rangeStart.lineNumber, rangeStart.column, rangeEnd.lineNumber, rangeEnd.column)
      : {
          startLineNumber: rangeStart.lineNumber,
          startColumn: rangeStart.column,
          endLineNumber: rangeEnd.lineNumber,
          endColumn: rangeEnd.column,
        };

    isApplyingExternalRef.current = true;
    model.pushEditOperations([], [{ range, text: insertText }], () => null);
    isApplyingExternalRef.current = false;
    if (resetView) {
      editor.revealLineInCenter(rangeStart.lineNumber);
    }
    lastSyncedContentRef.current = nextContent;
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) {
      if (document) {
        lastSyncedContentRef.current = document.content;
        lastSyncedFileRef.current = document.filePath;
      } else {
        lastSyncedContentRef.current = '';
        lastSyncedFileRef.current = undefined;
      }
      return;
    }

    if (!document) {
      applyIncrementalContent('', true, true);
      lastSyncedFileRef.current = undefined;
      return;
    }

    const isNewFile = lastSyncedFileRef.current !== document.filePath;
    applyIncrementalContent(document.content, isNewFile, isNewFile);
    lastSyncedFileRef.current = document.filePath;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document?.content, document?.filePath, applyIncrementalContent]);

  useEffect(() => {
    if (!document?.filePath) {
      setBackendDecorations(null);
      isStreamingActiveRef.current = false;
      return;
    }

    const normalizePath = (path: string) =>
      path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');

    const normalizedPath = normalizePath(document.filePath);
    const cached = decorationCacheRef.current.get(normalizedPath) || null;
    setBackendDecorations(cached);
  }, [document?.filePath]);

  const handleEditorMount = useCallback<EditorOnMount>((editorInstance, monacoInstance) => {
    editorRef.current = editorInstance;
    setMonacoEditor(editorInstance);
    monacoApiRef.current = monacoInstance as typeof Monaco;
    lastSyncedContentRef.current = editorInstance.getValue();
    scheduleEditorLayout();

    logger.info('[BACKEND-DECORATIONS] Editor mounted, checking for pending diff');

    // Initialize decorations collection now that editor is ready
    if (!streamingDecorationsRef.current) {
      logger.info('[BACKEND-DECORATIONS] Creating decorations collection on mount');
      streamingDecorationsRef.current = editorInstance.createDecorationsCollection();
    }

    editorInstance.onDidChangeModelContent(() => {
      if (isApplyingExternalRef.current) {
        return;
      }
      const value = editorInstance.getValue();
      lastSyncedContentRef.current = value;
      handleEditorChangeRef.current(value);
    });

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
      const { file_path, decorations, update_type, content, delta, offset } = event.detail;
      const eventPath = normalizePath(file_path);

      // Handle content updates for active file
      if (eventPath && documentPath && eventPath === documentPath) {
        const editor = editorRef.current;
        const model = editor?.getModel();
        const monacoApi = monacoApiRef.current ?? (typeof window !== 'undefined' ? (window as any).monaco : null);

        if (editor && model && monacoApi && update_type) {
          const applyFullContent = (text: string) => {
            model.setValue(text);
            lastSyncedContentRef.current = text;
            logger.debug('[FULL-APPLY] Applied full content', {
              contentLength: text.length,
            });
          };

          isApplyingExternalRef.current = true;
          try {
            if (update_type === 'delta' && typeof delta === 'string' && typeof offset === 'number') {
              const currentContent = model.getValue();

              if (currentContent.length === offset) {
                const endPosition = model.getFullModelRange().getEndPosition();
                const insertRange = new monacoApi.Range(
                  endPosition.lineNumber,
                  endPosition.column,
                  endPosition.lineNumber,
                  endPosition.column
                );

                model.pushEditOperations([], [{ range: insertRange, text: delta }], () => null);
                lastSyncedContentRef.current = currentContent + delta;

                logger.debug('[DELTA-APPLY] Applied delta append', {
                  offset,
                  deltaLength: delta.length,
                  newLength: lastSyncedContentRef.current.length,
                });
              } else {
                logger.warn('[DELTA-APPLY] Offset mismatch, falling back to full content', {
                  expectedOffset: currentContent.length,
                  receivedOffset: offset,
                });
                if (typeof content === 'string') {
                  applyFullContent(content);
                }
              }
            } else if (update_type === 'full' && typeof content === 'string') {
              applyFullContent(content);
            }
          } finally {
            isApplyingExternalRef.current = false;
          }
        }

        // Handle decorations
        logger.info('[BACKEND-DECORATIONS] Received decorations for file', file_path, {
          decorationCount: Array.isArray(decorations) ? decorations.length : 0,
        });
        if (Array.isArray(decorations) && decorations.length > 0) {
          setBackendDecorations(decorations);
        }
      }

      // Cache decorations for inactive files
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

  // Apply backend decorations to Monaco editor (debounced)
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

    // Clear existing debounce timer
    if (decorationDebounceRef.current !== null) {
      window.clearTimeout(decorationDebounceRef.current);
    }

    if (!backendDecorations || backendDecorations.length === 0) {
      // Clear decorations immediately if no backend decorations
      logger.info('[BACKEND-DECORATIONS] Clearing decorations (no backend decorations)');
      streamingDecorationsRef.current.clear();
      return;
    }

    // Debounce decoration updates to reduce Monaco API calls
    decorationDebounceRef.current = window.setTimeout(() => {
      decorationDebounceRef.current = null;

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

      if (streamingDecorationsRef.current) {
        streamingDecorationsRef.current.set(monacoDecorations);
      }
    }, 100); // 100ms debounce

    return () => {
      // Clean up debounce timer
      if (decorationDebounceRef.current !== null) {
        window.clearTimeout(decorationDebounceRef.current);
        decorationDebounceRef.current = null;
      }
    };
  }, [backendDecorations]);

  // Disable expensive Monaco features during streaming to improve performance
  // Only toggle on streaming state transitions to avoid flashing
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const hasDecorations = !!(backendDecorations && backendDecorations.length > 0);
    const wasStreaming = isStreamingActiveRef.current;

    if (hasDecorations && !wasStreaming) {
      isStreamingActiveRef.current = true;
      editor.updateOptions({
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        parameterHints: { enabled: false },
        hover: { enabled: false },
        codeLens: false,
      });
      logger.debug('[MONACO-OPT] Disabled expensive features - streaming started');
    } else if (!hasDecorations && wasStreaming) {
      isStreamingActiveRef.current = false;
      editor.updateOptions({
        quickSuggestions: true,
        suggestOnTriggerCharacters: true,
        parameterHints: { enabled: true },
        hover: { enabled: true },
        codeLens: true,
      });
      logger.debug('[MONACO-OPT] Re-enabled features - streaming ended');
    }
  }, [backendDecorations]);

  useEffect(() => {
    return () => {
      const editor = editorRef.current;
      if (editor && isStreamingActiveRef.current) {
        editor.updateOptions({
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          parameterHints: { enabled: true },
          hover: { enabled: true },
          codeLens: true,
        });
        isStreamingActiveRef.current = false;
        logger.debug('[MONACO-OPT] Re-enabled features on unmount');
      }
    };
  }, []);

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
          defaultValue={document?.content ?? ''}
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
