// status: alpha

import React from 'react';
import '../../styles/agentic/ContextTimeline.css';
import { ContextCommitEntry } from '../../utils/agentic/PlanStore';

interface ContextTimelineProps {
  commits: ContextCommitEntry[];
}

const ContextTimeline: React.FC<ContextTimelineProps> = ({ commits }) => {
  if (commits.length === 0) {
    return null;
  }

  const ordered = [...commits].slice().reverse();

  return (
    <section className="context-timeline" aria-label="Context timeline">
      <header className="context-timeline__header">
        <strong>Context Timeline</strong>
      </header>
      <ul className="context-timeline__list">
        {ordered.map((commit) => (
          <li key={commit.newCtxId} className="context-timeline__item">
            <div className="context-timeline__ctx">{commit.newCtxId}</div>
            <div className="context-timeline__meta">
              <span>from {commit.baseCtxId}</span>
              <time dateTime={new Date(commit.timestamp).toISOString()}>{new Date(commit.timestamp).toLocaleTimeString()}</time>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default ContextTimeline;
