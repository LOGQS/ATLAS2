import React from 'react';
import { Icons } from '../ui/Icons';
import '../../styles/coder/PlanViewer.css';

interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
}

interface Plan {
  description: string;
  steps: PlanStep[];
}

interface PlanViewerProps {
  plan?: Plan | null;
}

export const PlanViewer: React.FC<PlanViewerProps> = ({ plan }) => {
  if (!plan) {
    return (
      <div className="plan-viewer__empty">
        <Icons.List className="w-12 h-12 opacity-30" />
        <p className="text-sm text-white/60 mt-4">No execution plan</p>
        <p className="text-xs text-white/40 mt-2">
          A plan will appear when the agent starts working
        </p>
      </div>
    );
  }

  const completedCount = plan.steps.filter(s => s.status === 'completed').length;
  const totalCount = plan.steps.length;
  const progressPercentage = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  return (
    <div className="plan-viewer">
      <div className="plan-viewer__header">
        <div className="plan-viewer__title-section">
          <h3 className="plan-viewer__title">{plan.description || 'Execution Plan'}</h3>
          <button className="plan-viewer__edit-button" disabled title="Coming Soon">
            <Icons.Edit className="w-4 h-4" />
            <span>Edit Plan</span>
          </button>
        </div>
        <div className="plan-viewer__progress-section">
          <div className="plan-viewer__progress-text">
            {completedCount} / {totalCount} steps completed
          </div>
          <div className="plan-viewer__progress-bar">
            <div
              className="plan-viewer__progress-fill"
              style={{ width: `${progressPercentage}%` }}
            />
          </div>
        </div>
      </div>

      <div className="plan-viewer__steps">
        {plan.steps.map((step, index) => {
          const stepNumber = index + 1;
          const statusIcon = {
            completed: <Icons.Check className="w-4 h-4 text-green-400" />,
            in_progress: <div className="plan-viewer__step-spinner" />,
            failed: <Icons.Close className="w-4 h-4 text-red-400" />,
            pending: <Icons.Circle className="w-4 h-4 text-gray-500" />,
          }[step.status];

          return (
            <div key={step.id} className={`plan-viewer__step plan-viewer__step--${step.status}`}>
              <div className="plan-viewer__step-indicator">
                <div className="plan-viewer__step-number">{stepNumber}</div>
                <div className="plan-viewer__step-status-icon">{statusIcon}</div>
              </div>
              <div className="plan-viewer__step-content">
                <div className="plan-viewer__step-description">{step.description}</div>
                {step.result && (
                  <div className="plan-viewer__step-result">
                    <Icons.CheckCircle className="w-3.5 h-3.5 text-green-400" />
                    <span>{step.result}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
