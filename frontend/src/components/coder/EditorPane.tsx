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
import type { StreamingDiffData } from '../../utils/coder/streamingDiff';
import '../../styles/coder/StreamingDiff.css';

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
  streamingDiff?: StreamingDiffData | null;
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
  streamingDiff,
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
  const pendingDiffRef = useRef<StreamingDiffData | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Auto-scroll control for streaming file content - uses Monaco API
  const isStreamingContent = !!streamingDiff && streamingDiff.filePath === document?.filePath;
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

  const handleEditorMount = useCallback<EditorOnMount>((editorInstance, _monaco) => {
    editorRef.current = editorInstance;
    setMonacoEditor(editorInstance);
    scheduleEditorLayout();

    console.log('[STREAMING_DIFF][EDITOR] Editor mounted, checking for pending diff');

    // Initialize decorations collection now that editor is ready
    if (!streamingDecorationsRef.current) {
      console.log('[STREAMING_DIFF][EDITOR] Creating decorations collection on mount');
      streamingDecorationsRef.current = editorInstance.createDecorationsCollection();
    }

    // Apply any pending diff that arrived before editor was ready
    if (pendingDiffRef.current) {
      console.log('[STREAMING_DIFF][EDITOR] Applying pending diff after mount:', {
        count: pendingDiffRef.current.decorations.length
      });
      streamingDecorationsRef.current.set(pendingDiffRef.current.decorations);
      pendingDiffRef.current = null;
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

  // Apply streaming diff decorations using modern decorations collection API
  useEffect(() => {
    const editor = editorRef.current;

    console.log('[STREAMING_DIFF][EDITOR] Decorations effect triggered', {
      hasEditor: !!editor,
      hasDiff: !!streamingDiff,
      decorationsCount: streamingDiff?.decorations.length,
      editMode: streamingDiff?.editMode,
      filePath: streamingDiff?.filePath,
      documentPath: document?.filePath
    });

    if (!editor) {
      console.log('[STREAMING_DIFF][EDITOR] No editor ref yet, saving diff for when editor mounts');
      // Store the pending diff to apply when editor mounts
      pendingDiffRef.current = streamingDiff ?? null;
      return;
    }

    // Initialize decorations collection if not already created
    if (!streamingDecorationsRef.current) {
      console.log('[STREAMING_DIFF][EDITOR] Creating new decorations collection');
      streamingDecorationsRef.current = editor.createDecorationsCollection();
    }

    // Check if we have a pending diff from before editor was ready
    const diffToApply = streamingDiff ?? pendingDiffRef.current;
    if (diffToApply) {
      pendingDiffRef.current = null;
    }

    if (!diffToApply) {
      // Clear streaming decorations if no diff
      console.log('[STREAMING_DIFF][EDITOR] Clearing decorations (no diff)');
      streamingDecorationsRef.current.clear();
      return;
    }

    // Apply streaming diff decorations
    console.log('[STREAMING_DIFF][EDITOR] Applying decorations:', {
      count: diffToApply.decorations.length,
      decorations: diffToApply.decorations.map(d => ({
        startLine: d.range.startLineNumber,
        endLine: d.range.endLineNumber,
        className: d.options.className
      }))
    });

    streamingDecorationsRef.current.set(diffToApply.decorations);

    return () => {
      // Clean up on unmount or diff change
      console.log('[STREAMING_DIFF][EDITOR] Cleanup: clearing decorations');
      streamingDecorationsRef.current?.clear();
    };
  }, [streamingDiff, document]);

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
