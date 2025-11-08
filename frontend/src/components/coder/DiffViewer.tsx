import { useMemo, memo, useState } from 'react';
import { diffLines as computeDiff, Change } from 'diff';
import '../../styles/coder/DiffViewer.css';

type ViewMode = 'unified' | 'split';

interface DiffViewerProps {
  original: string;
  modified: string;
  language?: string; // Reserved for future syntax highlighting implementation
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

const splitAndFilterLines = (value: string): string[] => {
  return value.split('\n').filter((line, idx, arr) => {
    return idx < arr.length - 1 || line !== '';
  });
};

const flushPendingChanges = (
  removals: { lineNum: number; content: string }[],
  additions: { lineNum: number; content: string }[],
  result: SplitDiffLine[]
): void => {
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
};

const DiffLineComponent = memo<{ line: DiffLine }>(({ line }) => {
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
    <div className={className}>
      <span className="diff-line-number">{displayLineNum}</span>
      <span className="diff-line-indicator">
        {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
      </span>
      <span className="diff-line-content">{line.content || ' '}</span>
    </div>
  );
});

DiffLineComponent.displayName = 'DiffLineComponent';

const SplitDiffLineComponent = memo<{ line: SplitDiffLine }>(({ line }) => {
  return (
    <div className="split-diff-line">
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
      const lines = splitAndFilterLines(change.value);

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

  const splitDiffLines = useMemo(() => {
    const changes = computeDiff(original, modified);
    const result: SplitDiffLine[] = [];
    let originalLineNum = 1;
    let modifiedLineNum = 1;

    const removals: { lineNum: number; content: string }[] = [];
    const additions: { lineNum: number; content: string }[] = [];

    changes.forEach((change: Change) => {
      const lines = splitAndFilterLines(change.value);

      if (change.removed) {
        lines.forEach(line => {
          removals.push({ lineNum: originalLineNum++, content: line });
        });
      } else if (change.added) {
        lines.forEach(line => {
          additions.push({ lineNum: modifiedLineNum++, content: line });
        });
      } else {
        flushPendingChanges(removals, additions, result);

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

    flushPendingChanges(removals, additions, result);

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
            <DiffLineComponent key={index} line={line} />
          ))
        ) : (
          splitDiffLines.map((line, index) => (
            <SplitDiffLineComponent key={index} line={line} />
          ))
        )}
      </div>
    </div>
  );
});

DiffViewer.displayName = 'DiffViewer';
