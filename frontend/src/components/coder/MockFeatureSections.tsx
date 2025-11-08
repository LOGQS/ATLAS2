import React from 'react';
import { Icons } from '../ui/Icons';
import '../../styles/coder/MockFeatureSections.css';

export const LearningModeToggle: React.FC = () => {
  return (
    <div className="mock-feature__learning-mode-toggle mock-feature" title="Coming Soon">
      <label className="mock-feature__learning-mode-label">
        <input type="checkbox" disabled />
        <span className="mock-feature__learning-mode-text">
          <Icons.Book className="w-4 h-4" />
          <span>Learning Mode</span>
        </span>
        <Icons.Info className="w-4 h-4 mock-feature__learning-mode-info" />
      </label>
      <span className="mock-feature__badge">Coming Soon</span>
    </div>
  );
};

export const ConstraintsPanel: React.FC = () => {
  return (
    <details className="mock-feature__constraints-panel mock-feature">
      <summary className="mock-feature__constraints-header">
        <Icons.Shield className="w-4 h-4" />
        <span>Constraints</span>
        <span className="mock-feature__badge">Coming Soon</span>
      </summary>
      <div className="mock-feature__constraints-content">
        <div className="mock-feature__constraint-item">
          <Icons.Check className="w-3.5 h-3.5 text-green-400" />
          <span>Use TypeScript</span>
        </div>
        <div className="mock-feature__constraint-item">
          <Icons.Check className="w-3.5 h-3.5 text-green-400" />
          <span>No external dependencies</span>
        </div>
        <div className="mock-feature__constraint-item">
          <Icons.Check className="w-3.5 h-3.5 text-green-400" />
          <span>Follow ESLint rules</span>
        </div>
      </div>
    </details>
  );
};

export const LearnedPatternsSection: React.FC = () => {
  return (
    <div className="mock-feature__learned-patterns-section mock-feature">
      <div className="mock-feature__learned-patterns-header">
        <div className="mock-feature__learned-patterns-title">
          <Icons.Lightbulb className="w-4 h-4" />
          <span>Learned Patterns</span>
        </div>
        <span className="mock-feature__badge">Coming Soon</span>
      </div>
      <div className="mock-feature__learned-patterns-content">
        <div className="mock-feature__learned-patterns-count">
          <span className="mock-feature__count-number">0</span>
          <span className="mock-feature__count-label">patterns learned</span>
        </div>
        <button className="mock-feature__learned-patterns-button" disabled>
          View All
        </button>
      </div>
    </div>
  );
};

interface MemoryProposalBarProps {
  visible?: boolean;
}

export const MemoryProposalBar: React.FC<MemoryProposalBarProps> = ({ visible = true }) => {
  if (!visible) return null;

  return (
    <div className="mock-feature__memory-proposal-bar mock-feature">
      <div className="mock-feature__memory-proposal-content">
        <Icons.Lightbulb className="w-4 h-4" />
        <span className="mock-feature__memory-proposal-text">
          💡 Memory Proposal: Pattern detected in authentication flow
        </span>
        <span className="mock-feature__badge mock-feature__badge--small">Coming Soon</span>
      </div>
      <div className="mock-feature__memory-proposal-actions">
        <button className="mock-feature__memory-action-button mock-feature__memory-action-button--approve" disabled title="Coming Soon">
          <Icons.Check className="w-4 h-4" />
        </button>
        <button className="mock-feature__memory-action-button mock-feature__memory-action-button--reject" disabled title="Coming Soon">
          <Icons.Close className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export const SelectToModifyIndicator: React.FC = () => {
  // This would be integrated into editor context menu
  // Placeholder for documentation purposes
  return null;
};

export const AutocompleteIndicator: React.FC = () => {
  // Monaco already has autocomplete, this is just a visual indicator
  // Placeholder for documentation purposes
  return null;
};
