import React, { useState } from 'react';
import { Icons } from '../ui/Icons';
import '../../styles/coder/CheckpointTimeline.css';

interface CodeChunk {
  id: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
}

interface Checkpoint {
  id: string;
  timestamp: string;
  operation: string;
  tool: string;
  filePath: string;
  changes: CodeChunk[];
  callId?: string;
}

interface CheckpointTimelineProps {
  checkpoints?: Checkpoint[];
  onRevertCheckpoint?: (checkpointId: string) => void;
  onRevertChunk?: (chunkId: string) => void;
}

export const CheckpointTimeline: React.FC<CheckpointTimelineProps> = ({
  checkpoints = [],
  onRevertCheckpoint,
  onRevertChunk,
}) => {
  const [expandedCheckpoints, setExpandedCheckpoints] = useState<Set<string>>(new Set());

  const toggleCheckpoint = (checkpointId: string) => {
    setExpandedCheckpoints(prev => {
      const next = new Set(prev);
      if (next.has(checkpointId)) {
        next.delete(checkpointId);
      } else {
        next.add(checkpointId);
      }
      return next;
    });
  };

  const formatTime = (timestamp: string): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const formatCallId = (callId?: string): string => {
    if (!callId) return '—';
    const trimmed = callId.trim();
    if (trimmed.length <= 8) return trimmed;
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
  };

  if (checkpoints.length === 0) {
    return (
      <div className="checkpoint-timeline__empty">
        <Icons.History className="w-12 h-12 opacity-30" />
        <p className="text-sm text-white/60 mt-4">No checkpoints yet</p>
        <p className="text-xs text-white/40 mt-2">
          File changes will be tracked here as checkpoints
        </p>
      </div>
    );
  }

  return (
    <div className="checkpoint-timeline">
      <div className="checkpoint-timeline__header">
        <h3 className="checkpoint-timeline__title">
          <Icons.History className="w-4 h-4" />
          Tool Call History
        </h3>
        <span className="checkpoint-timeline__count">{checkpoints.length} checkpoint{checkpoints.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="checkpoint-timeline__list">
        {checkpoints.map((checkpoint, index) => {
          const isExpanded = expandedCheckpoints.has(checkpoint.id);
          const hasChanges = checkpoint.changes && checkpoint.changes.length > 0;

          return (
            <div key={checkpoint.id} className="checkpoint-timeline__item">
              {/* Connection line to next checkpoint */}
              {index < checkpoints.length - 1 && (
                <div className="checkpoint-timeline__connector" />
              )}

              {/* Checkpoint node */}
              <div className="checkpoint-timeline__node">
                <div className="checkpoint-timeline__dot" />
              </div>

              {/* Checkpoint content */}
              <div className="checkpoint-timeline__content">
                <div className="checkpoint-timeline__header-inner">
                  <div className="checkpoint-timeline__info">
                    <div className="checkpoint-timeline__operation">
                      <Icons.FileCode className="w-4 h-4" />
                      <span className="checkpoint-timeline__operation-type">{checkpoint.operation}</span>
                    </div>
                    <div className="checkpoint-timeline__file-path" title={checkpoint.filePath}>
                      {checkpoint.filePath}
                    </div>
                  </div>
                  <div className="checkpoint-timeline__meta">
                    <span className="checkpoint-timeline__time">{formatTime(checkpoint.timestamp)}</span>
                  </div>
                </div>

                <div className="checkpoint-timeline__details">
                  <span className="checkpoint-timeline__tool">via {checkpoint.tool}</span>
                  {checkpoint.callId && (
                    <span className="checkpoint-timeline__call-id">Call {formatCallId(checkpoint.callId)}</span>
                  )}
                </div>

                {/* Expandable code chunks */}
                {hasChanges && (
                  <details
                    className="checkpoint-timeline__changes"
                    open={isExpanded}
                    onToggle={() => toggleCheckpoint(checkpoint.id)}
                  >
                    <summary className="checkpoint-timeline__changes-summary">
                      <Icons.ChevronRight className={`w-4 h-4 checkpoint-timeline__chevron ${isExpanded ? 'checkpoint-timeline__chevron--expanded' : ''}`} />
                      <span>View Changes ({checkpoint.changes.length} chunk{checkpoint.changes.length !== 1 ? 's' : ''})</span>
                    </summary>

                    <div className="checkpoint-timeline__changes-content">
                      {checkpoint.changes.map((change) => (
                        <div key={change.id} className="checkpoint-timeline__code-chunk">
                          <div className="checkpoint-timeline__chunk-header">
                            <div className="checkpoint-timeline__chunk-diff-stats">
                              {change.linesAdded > 0 && (
                                <span className="checkpoint-timeline__diff-stat checkpoint-timeline__diff-stat--added">+{change.linesAdded}</span>
                              )}
                              {change.linesRemoved > 0 && (
                                <span className="checkpoint-timeline__diff-stat checkpoint-timeline__diff-stat--removed">-{change.linesRemoved}</span>
                              )}
                              {change.linesAdded === 0 && change.linesRemoved === 0 && (
                                <span className="checkpoint-timeline__diff-stat checkpoint-timeline__diff-stat--neutral">No delta</span>
                              )}
                            </div>
                            {onRevertChunk && (
                              <button
                                className="checkpoint-timeline__chunk-revert-button"
                                onClick={() => onRevertChunk(change.id)}
                                title="Revert this chunk"
                              >
                                <Icons.Undo className="w-3.5 h-3.5" />
                                <span>Revert</span>
                              </button>
                            )}
                          </div>
                          <pre className="checkpoint-timeline__chunk-diff">{change.diff}</pre>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* Revert checkpoint button */}
                {onRevertCheckpoint && (
                  <button
                    className="checkpoint-timeline__revert-button"
                    onClick={() => onRevertCheckpoint(checkpoint.id)}
                    title="Revert all changes in this checkpoint"
                  >
                    <Icons.Undo className="w-4 h-4" />
                    <span>Revert to here</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
