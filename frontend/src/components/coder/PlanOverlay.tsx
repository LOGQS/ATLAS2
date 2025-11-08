import React, { useState, useCallback } from 'react';
import { Icons } from '../ui/Icons';
import type { ExecutionPlan } from '../../types/messages';
import '../../styles/coder/PlanOverlay.css';

interface PlanOverlayProps {
  plan: ExecutionPlan | null | undefined;
}

const getStatusColor = (status: string): string => {
  switch (status) {
    case 'completed':
      return 'text-green-400';
    case 'failed':
      return 'text-red-400';
    case 'in_progress':
      return 'text-blue-400';
    case 'skipped':
      return 'text-yellow-400';
    default:
      return 'text-gray-400';
  }
};

export const PlanOverlay: React.FC<PlanOverlayProps> = ({ plan }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);

  if (!plan) return null;

  return (
    <div className={`plan-overlay ${isExpanded ? 'plan-overlay--expanded' : 'plan-overlay--collapsed'}`}>
      <div className="plan-overlay__header" onClick={toggleExpanded}>
        <div className="plan-overlay__header-left">
          <Icons.List className="w-4 h-4 text-blue-400" />
          <span className="plan-overlay__title">Current Plan</span>
          {!isExpanded && (
            <span className="plan-overlay__summary">{plan.task_description}</span>
          )}
        </div>
        <div className="plan-overlay__header-right">
          <span className="plan-overlay__badge">
            {plan.steps.filter(s => s.status === 'completed').length}/{plan.steps.length}
          </span>
          <Icons.ChevronRight
            className={`plan-overlay__chevron ${isExpanded ? 'plan-overlay__chevron--expanded' : ''}`}
          />
        </div>
      </div>

      {isExpanded && (
        <div className="plan-overlay__content">
          <div className="plan-overlay__description">
            {plan.task_description}
          </div>
          <ul className="plan-overlay__steps">
            {plan.steps.map((step, idx) => (
              <li key={step.step_id || idx} className="plan-overlay__step">
                <span className={`plan-overlay__step-status ${getStatusColor(step.status)}`}>
                  {step.status === 'completed' && '✓'}
                  {step.status === 'in_progress' && '⟳'}
                  {step.status === 'pending' && '○'}
                  {step.status === 'failed' && '✗'}
                  {step.status === 'skipped' && '−'}
                </span>
                <span className="plan-overlay__step-text">{step.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
