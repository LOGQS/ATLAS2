import React, { useEffect, useState, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { Icons } from '../ui/Icons';
import '../../styles/coder/InlineDiffOverlay.css';

interface DiffChunk {
  startLine: number;
  endLine: number;
  type: 'added' | 'removed' | 'modified';
}

interface DiffData {
  toolCallId: string;
  filePath: string;
  chunks: DiffChunk[];
  before: string;
  after: string;
}

interface InlineDiffOverlayProps {
  diffs: DiffData[];
  editor: monaco.editor.IStandaloneCodeEditor | null;
  onAccept: (toolCallId: string) => void;
  onReject: (toolCallId: string) => void;
}

export const InlineDiffOverlay: React.FC<InlineDiffOverlayProps> = ({
  diffs,
  editor,
  onAccept,
  onReject,
}) => {
  const [hoveredDiff, setHoveredDiff] = useState<string | null>(null);
  const [buttonPositions, setButtonPositions] = useState<Map<string, { top: number; right: number }>>(new Map());
  const overlayRef = useRef<HTMLDivElement>(null);

  // Calculate button positions based on diff chunks and editor scroll
  useEffect(() => {
    if (!editor || diffs.length === 0) {
      return;
    }

    const updatePositions = () => {
      const newPositions = new Map<string, { top: number; right: number }>();

      diffs.forEach(diff => {
        if (diff.chunks.length > 0) {
          // Use the first chunk's start line for positioning
          const firstChunk = diff.chunks[0];
          const lineTop = editor.getTopForLineNumber(firstChunk.startLine);
          const scrollTop = editor.getScrollTop();

          // Calculate position relative to the editor viewport
          const top = lineTop - scrollTop;

          newPositions.set(diff.toolCallId, { top, right: 12 });
        }
      });

      setButtonPositions(newPositions);
    };

    // Update positions initially
    updatePositions();

    // Update positions on scroll
    const scrollDisposable = editor.onDidScrollChange(updatePositions);

    // Update positions when content changes
    const changeDisposable = editor.onDidChangeModelContent(updatePositions);

    return () => {
      scrollDisposable.dispose();
      changeDisposable.dispose();
    };
  }, [editor, diffs]);

  // Apply Monaco decorations for diff highlighting
  useEffect(() => {
    if (!editor || diffs.length === 0) {
      return;
    }

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];

    diffs.forEach(diff => {
      diff.chunks.forEach(chunk => {
        const range = new monaco.Range(
          chunk.startLine,
          1,
          chunk.endLine,
          Number.MAX_VALUE
        );

        let className = 'inline-diff__line-added';
        if (chunk.type === 'removed') {
          className = 'inline-diff__line-removed';
        } else if (chunk.type === 'modified') {
          className = 'inline-diff__line-modified';
        }

        decorations.push({
          range,
          options: {
            isWholeLine: true,
            className,
            linesDecorationsClassName: `inline-diff__line-gutter-${chunk.type}`,
          },
        });
      });
    });

    const decorationIds = editor.deltaDecorations([], decorations);

    return () => {
      editor.deltaDecorations(decorationIds, []);
    };
  }, [editor, diffs]);

  if (!editor || diffs.length === 0) {
    return null;
  }

  return (
    <div className="inline-diff-overlay" ref={overlayRef}>
      {diffs.map(diff => {
        const position = buttonPositions.get(diff.toolCallId);
        if (!position) return null;

        const isHovered = hoveredDiff === diff.toolCallId;

        return (
          <div
            key={diff.toolCallId}
            className={`inline-diff__button-group ${isHovered ? 'inline-diff__button-group--visible' : ''}`}
            style={{
              position: 'absolute',
              top: `${position.top}px`,
              right: `${position.right}px`,
            }}
            onMouseEnter={() => setHoveredDiff(diff.toolCallId)}
            onMouseLeave={() => setHoveredDiff(null)}
          >
            <button
              className="inline-diff__action-button inline-diff__action-button--accept"
              onClick={() => onAccept(diff.toolCallId)}
              title="Accept this change"
            >
              <Icons.Check className="w-4 h-4" />
              <span>Accept</span>
            </button>
            <button
              className="inline-diff__action-button inline-diff__action-button--reject"
              onClick={() => onReject(diff.toolCallId)}
              title="Reject this change"
            >
              <Icons.Close className="w-4 h-4" />
              <span>Reject</span>
            </button>
          </div>
        );
      })}
    </div>
  );
};
