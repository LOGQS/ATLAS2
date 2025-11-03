import React, { useCallback, memo, useEffect, useRef } from 'react';
import Editor, { type BeforeMount } from '@monaco-editor/react';
import { FileBreadcrumb } from './FileBreadcrumb';
import { PanelHeader } from '../ui/PanelHeader';
import { PanelHeaderButton } from '../ui/PanelHeaderButton';
import { Icons } from '../ui/Icons';
import type * as Monaco from 'monaco-editor';

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
  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      onContentChange(value);
    }
  }, [onContentChange]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const layoutFrameRef = useRef<number | null>(null);

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
    };
  }, []);

  useEffect(() => {
    scheduleEditorLayout();
  }, [scheduleEditorLayout, document?.filePath]);

  const handleEditorMount = useCallback<EditorOnMount>((editorInstance, _monaco) => {
    editorRef.current = editorInstance;
    scheduleEditorLayout();

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
      </div>
    </div>
  );
});

EditorPane.displayName = 'EditorPane';
