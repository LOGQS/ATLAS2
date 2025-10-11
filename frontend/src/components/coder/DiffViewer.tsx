import React, { useMemo, memo, useState } from 'react';
import { diffLines as computeDiff, Change } from 'diff';
import '../../styles/coder/DiffViewer.css';

type ViewMode = 'unified' | 'split';

interface DiffViewerProps {
  original: string;
  modified: string;
  language?: string;
  defaultMode?: ViewMode;
}

interface DiffLine {
  originalLineNum: number | null;
  modifiedLineNum: number | null;
  content: string;
  type: 'added' | 'removed' | 'unchanged';
}

interface SplitDiffLine {
  originalLineNum: number | null;
  modifiedLineNum: number | null;
  originalContent: string | null;
  modifiedContent: string | null;
  type: 'added' | 'removed' | 'unchanged' | 'modified';
}

// Memoized diff line component for better rendering performance
const DiffLineComponent = memo<{ line: DiffLine; index: number }>(({ line, index }) => {
  let className = 'diff-line';

  if (line.type === 'added') {
    className += ' diff-line-added';
  } else if (line.type === 'removed') {
    className += ' diff-line-removed';
  }

  const displayLineNum = line.type === 'removed'
    ? line.originalLineNum
    : line.modifiedLineNum;

  return (
    <div key={index} className={className}>
      <span className="diff-line-number">{displayLineNum}</span>
      <span className="diff-line-indicator">
        {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
      </span>
      <span className="diff-line-content">{line.content || ' '}</span>
    </div>
  );
});

DiffLineComponent.displayName = 'DiffLineComponent';

// Memoized split diff line component for side-by-side view
const SplitDiffLineComponent = memo<{ line: SplitDiffLine; index: number }>(({ line, index }) => {
  return (
    <div key={index} className="split-diff-line">
      {/* Original (Left) Side */}
      <div className={`split-diff-side ${
        line.type === 'removed' || line.type === 'modified' ? 'split-diff-removed' :
        line.type === 'unchanged' ? 'split-diff-unchanged' : ''
      }`}>
        <span className="diff-line-number">{line.originalLineNum ?? ''}</span>
        <span className="diff-line-indicator">
          {line.type === 'removed' || line.type === 'modified' ? '-' : ' '}
        </span>
        <span className="diff-line-content">{line.originalContent ?? ' '}</span>
      </div>

      {/* Modified (Right) Side */}
      <div className={`split-diff-side ${
        line.type === 'added' || line.type === 'modified' ? 'split-diff-added' :
        line.type === 'unchanged' ? 'split-diff-unchanged' : ''
      }`}>
        <span className="diff-line-number">{line.modifiedLineNum ?? ''}</span>
        <span className="diff-line-indicator">
          {line.type === 'added' || line.type === 'modified' ? '+' : ' '}
        </span>
        <span className="diff-line-content">{line.modifiedContent ?? ' '}</span>
      </div>
    </div>
  );
});

SplitDiffLineComponent.displayName = 'SplitDiffLineComponent';

export const DiffViewer = memo<DiffViewerProps>(({ original, modified, defaultMode = 'unified' }) => {
  const [viewMode, setViewMode] = useState<ViewMode>(defaultMode);
  const diffLines = useMemo(() => {
    const changes = computeDiff(original, modified);
    const result: DiffLine[] = [];
    let originalLineNum = 1;
    let modifiedLineNum = 1;

    changes.forEach((change: Change) => {
      const lines = change.value.split('\n').filter((line, idx, arr) => {
        // Keep empty lines except the last one if it's empty
        return idx < arr.length - 1 || line !== '';
      });

      lines.forEach((line) => {
        if (change.added) {
          result.push({
            originalLineNum: null,
            modifiedLineNum: modifiedLineNum++,
            content: line,
            type: 'added'
          });
        } else if (change.removed) {
          result.push({
            originalLineNum: originalLineNum++,
            modifiedLineNum: null,
            content: line,
            type: 'removed'
          });
        } else {
          result.push({
            originalLineNum: originalLineNum++,
            modifiedLineNum: modifiedLineNum++,
            content: line,
            type: 'unchanged'
          });
        }
      });
    });

    return result;
  }, [original, modified]);

  // Compute split diff for side-by-side view
  const splitDiffLines = useMemo(() => {
    const changes = computeDiff(original, modified);
    const result: SplitDiffLine[] = [];
    let originalLineNum = 1;
    let modifiedLineNum = 1;

    // Track removals and additions for pairing
    const removals: { lineNum: number; content: string }[] = [];
    const additions: { lineNum: number; content: string }[] = [];

    changes.forEach((change: Change) => {
      const lines = change.value.split('\n').filter((line, idx, arr) => {
        return idx < arr.length - 1 || line !== '';
      });

      if (change.removed) {
        lines.forEach(line => {
          removals.push({ lineNum: originalLineNum++, content: line });
        });
      } else if (change.added) {
        lines.forEach(line => {
          additions.push({ lineNum: modifiedLineNum++, content: line });
        });
      } else {
        // First, pair up any pending removals and additions
        while (removals.length > 0 && additions.length > 0) {
          const removed = removals.shift()!;
          const added = additions.shift()!;
          result.push({
            originalLineNum: removed.lineNum,
            modifiedLineNum: added.lineNum,
            originalContent: removed.content,
            modifiedContent: added.content,
            type: 'modified'
          });
        }

        // Add remaining removals (no corresponding addition)
        while (removals.length > 0) {
          const removed = removals.shift()!;
          result.push({
            originalLineNum: removed.lineNum,
            modifiedLineNum: null,
            originalContent: removed.content,
            modifiedContent: null,
            type: 'removed'
          });
        }

        // Add remaining additions (no corresponding removal)
        while (additions.length > 0) {
          const added = additions.shift()!;
          result.push({
            originalLineNum: null,
            modifiedLineNum: added.lineNum,
            originalContent: null,
            modifiedContent: added.content,
            type: 'added'
          });
        }

        // Add unchanged lines
        lines.forEach((line) => {
          result.push({
            originalLineNum: originalLineNum++,
            modifiedLineNum: modifiedLineNum++,
            originalContent: line,
            modifiedContent: line,
            type: 'unchanged'
          });
        });
      }
    });

    // Handle any remaining removals/additions at the end
    while (removals.length > 0 && additions.length > 0) {
      const removed = removals.shift()!;
      const added = additions.shift()!;
      result.push({
        originalLineNum: removed.lineNum,
        modifiedLineNum: added.lineNum,
        originalContent: removed.content,
        modifiedContent: added.content,
        type: 'modified'
      });
    }

    while (removals.length > 0) {
      const removed = removals.shift()!;
      result.push({
        originalLineNum: removed.lineNum,
        modifiedLineNum: null,
        originalContent: removed.content,
        modifiedContent: null,
        type: 'removed'
      });
    }

    while (additions.length > 0) {
      const added = additions.shift()!;
      result.push({
        originalLineNum: null,
        modifiedLineNum: added.lineNum,
        originalContent: null,
        modifiedContent: added.content,
        type: 'added'
      });
    }

    return result;
  }, [original, modified]);

  return (
    <div className="diff-viewer">
      {/* View Mode Toggle */}
      <div className="diff-header">
        <button
          className={`diff-mode-btn ${viewMode === 'unified' ? 'active' : ''}`}
          onClick={() => setViewMode('unified')}
          title="Unified view"
        >
          Unified
        </button>
        <button
          className={`diff-mode-btn ${viewMode === 'split' ? 'active' : ''}`}
          onClick={() => setViewMode('split')}
          title="Side-by-side view"
        >
          Split
        </button>
      </div>

      {/* Diff Content */}
      <div className={`diff-container ${viewMode === 'split' ? 'split-mode' : ''}`}>
        {viewMode === 'unified' ? (
          diffLines.map((line, index) => (
            <DiffLineComponent key={index} line={line} index={index} />
          ))
        ) : (
          splitDiffLines.map((line, index) => (
            <SplitDiffLineComponent key={index} line={line} index={index} />
          ))
        )}
      </div>
    </div>
  );
});

DiffViewer.displayName = 'DiffViewer';
