// status: alpha

import React, { useMemo } from 'react';
import '../../styles/agentic/ContextTimeline.css';
import { ContextCommitEntry } from '../../utils/agentic/PlanStore';

interface ContextTimelineProps {
  commits: ContextCommitEntry[];
}

const ContextTimeline: React.FC<ContextTimelineProps> = ({ commits }) => {
  const ordered = useMemo(() => [...commits].slice().reverse(), [commits]);
  const eventCount = ordered.length;

  if (eventCount === 0) {
    return null;
  }

  const getRelativeTime = (timestamp: number) => {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffSeconds = Math.round(diffMs / 1000);
    if (diffSeconds < 30) {
      return 'just now';
    }
    if (diffSeconds < 90) {
      return '1m ago';
    }
    const diffMinutes = Math.round(diffSeconds / 60);
    if (diffMinutes < 60) {
      return `${diffMinutes}m ago`;
    }
    const diffHours = Math.round(diffMinutes / 60);
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    const diffDays = Math.round(diffHours / 24);
    return `${diffDays}d ago`;
  };

  return (
    <section className="context-timeline" aria-label="Context timeline">
      <header className="context-timeline__header">
        <strong>Context Timeline</strong>
        <span className="context-timeline__badge">{eventCount} updates</span>
      </header>
      <ul className="context-timeline__list">
        {ordered.map((commit, index) => {
          const timestamp = new Date(commit.timestamp);
          const formattedTime = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const relativeTime = getRelativeTime(commit.timestamp);

          return (
            <li key={`${commit.newCtxId}-${index}`} className="context-timeline__item">
              <div className="context-timeline__item-header">
                <span className="context-timeline__ctx">{commit.newCtxId}</span>
                <div className="context-timeline__time-group">
                  <time
                    className="context-timeline__time"
                    dateTime={timestamp.toISOString()}
                    title={timestamp.toLocaleString()}
                  >
                    {formattedTime}
                  </time>
                  <span className="context-timeline__time-relative">{relativeTime}</span>
                </div>
              </div>
              <div className="context-timeline__meta">
                <span className="context-timeline__meta-label">from {commit.baseCtxId}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default ContextTimeline;
