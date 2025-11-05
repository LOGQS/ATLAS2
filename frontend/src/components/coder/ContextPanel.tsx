import React from 'react';
import { Icons } from '../ui/Icons';
import '../../styles/coder/MockPanels.css';

export const ContextPanel: React.FC = () => {
  return (
    <div className="mock-panel">
      <div className="mock-panel__header">
        <div className="mock-panel__title">
          <Icons.FileCode className="w-5 h-5" />
          <h3>Files in Context</h3>
        </div>
        <span className="mock-panel__coming-soon-badge">Coming Soon</span>
      </div>

      <div className="mock-panel__content">
        {/* Mock file list */}
        <div className="mock-panel__context-file">
          <div className="mock-panel__context-file-info">
            <Icons.File className="w-4 h-4" />
            <span className="mock-panel__context-file-path">src/components/auth.tsx</span>
          </div>
          <span className="mock-panel__context-file-tokens">2,450 tokens</span>
        </div>

        <div className="mock-panel__context-file">
          <div className="mock-panel__context-file-info">
            <Icons.File className="w-4 h-4" />
            <span className="mock-panel__context-file-path">src/utils/helpers.ts</span>
          </div>
          <span className="mock-panel__context-file-tokens">1,200 tokens</span>
        </div>

        <div className="mock-panel__context-file">
          <div className="mock-panel__context-file-info">
            <Icons.File className="w-4 h-4" />
            <span className="mock-panel__context-file-path">src/hooks/useData.ts</span>
          </div>
          <span className="mock-panel__context-file-tokens">890 tokens</span>
        </div>

        {/* Token usage summary */}
        <div className="mock-panel__context-summary">
          <div className="mock-panel__context-total">
            <span className="mock-panel__context-label">Total Context:</span>
            <span className="mock-panel__context-value">4,540 / 25,000 tokens</span>
          </div>
          <div className="mock-panel__context-progress-bar">
            <div className="mock-panel__context-progress-fill" style={{ width: '18%' }} />
          </div>
        </div>

        {/* Auto-indexing section */}
        <div className="mock-panel__context-section">
          <div className="mock-panel__section-title">
            <Icons.Zap className="w-4 h-4" />
            <span>Auto-Indexing</span>
          </div>
          <div className="mock-panel__indexing-status">
            <div className="mock-panel__indexing-progress">
              <div className="mock-panel__indexing-spinner" />
              <span>Indexing workspace...</span>
            </div>
            <span className="mock-panel__indexing-percent">42%</span>
          </div>
          <div className="mock-panel__progress-bar">
            <div className="mock-panel__progress-fill" style={{ width: '42%' }} />
          </div>
        </div>
      </div>
    </div>
  );
};
