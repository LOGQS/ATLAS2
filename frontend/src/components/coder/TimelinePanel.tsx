import React from 'react';
import { Icons } from '../ui/Icons';
import '../../styles/coder/MockPanels.css';

export const TimelinePanel: React.FC = () => {
  return (
    <div className="mock-panel">
      <div className="mock-panel__header">
        <div className="mock-panel__title">
          <Icons.Clock className="w-5 h-5" />
          <h3>Session Timeline</h3>
        </div>
        <span className="mock-panel__coming-soon-badge">Coming Soon</span>
      </div>

      <div className="mock-panel__content">
        <div className="mock-panel__timeline-view-toggle">
          <button className="mock-panel__timeline-view-button mock-panel__timeline-view-button--active">Global</button>
          <button className="mock-panel__timeline-view-button">File-specific</button>
        </div>

        {/* Mock timeline slider */}
        <div className="mock-panel__timeline-slider">
          <div className="mock-panel__timeline-slider-header">
            <span className="mock-panel__timeline-time">00:00</span>
            <span className="mock-panel__timeline-time">12:45</span>
          </div>
          <div className="mock-panel__timeline-track">
            {/* Mock checkpoint markers */}
            <div className="mock-panel__timeline-marker" style={{ left: '15%' }} title="Checkpoint 1" />
            <div className="mock-panel__timeline-marker" style={{ left: '35%' }} title="Checkpoint 2" />
            <div className="mock-panel__timeline-marker" style={{ left: '62%' }} title="Checkpoint 3" />
            <div className="mock-panel__timeline-marker mock-panel__timeline-marker--active" style={{ left: '85%' }} title="Current Position" />

            {/* Mock slider thumb */}
            <div className="mock-panel__timeline-thumb" style={{ left: '85%' }} />
          </div>
        </div>

        {/* Mock timeline controls */}
        <div className="mock-panel__timeline-controls">
          <button className="mock-panel__timeline-control-button" title="Previous Checkpoint">
            <Icons.SkipBack className="w-4 h-4" />
          </button>
          <button className="mock-panel__timeline-control-button" title="Play">
            <Icons.Play className="w-4 h-4" />
          </button>
          <button className="mock-panel__timeline-control-button" title="Next Checkpoint">
            <Icons.SkipForward className="w-4 h-4" />
          </button>
        </div>

        {/* Current state info */}
        <div className="mock-panel__timeline-state">
          <div className="mock-panel__timeline-state-label">Current State</div>
          <div className="mock-panel__timeline-state-details">
            <div className="mock-panel__timeline-state-item">
              <Icons.FileCode className="w-4 h-4" />
              <span>5 files modified</span>
            </div>
            <div className="mock-panel__timeline-state-item">
              <Icons.GitBranch className="w-4 h-4" />
              <span>12 checkpoints</span>
            </div>
            <div className="mock-panel__timeline-state-item">
              <Icons.Clock className="w-4 h-4" />
              <span>12m 45s elapsed</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
