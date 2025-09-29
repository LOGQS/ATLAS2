// status: alpha

import React, { useState } from 'react';
import '../../styles/agentic/PlanBox.css';
import { PlanSummary, TaskStateEntry } from '../../utils/agentic/PlanStore';
import { apiCall } from '../../utils/api';

interface PlanBoxProps {
  summary: PlanSummary;
  tasks: TaskStateEntry[];
  chatId: string;
}

const PlanBox: React.FC<PlanBoxProps> = ({ summary, tasks, chatId }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ordered = [...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId));
  const planStatus = (summary.plan as any)?.status || 'PENDING_APPROVAL';
  const isPending = planStatus === 'PENDING_APPROVAL';
  const isApproved = planStatus === 'APPROVED';
  const isDenied = planStatus === 'DENIED';

  const handleApprove = async () => {
    setLoading(true);
    setError(null);
    try {
      await apiCall(`/api/chats/${chatId}/plan/${summary.planId}/approve`, 'POST');
    } catch (err) {
      setError('Failed to approve plan');
      console.error('Plan approval failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDeny = async () => {
    setLoading(true);
    setError(null);
    try {
      await apiCall(`/api/chats/${chatId}/plan/${summary.planId}/deny`, 'POST');
    } catch (err) {
      setError('Failed to deny plan');
      console.error('Plan denial failed:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={`plan-box plan-box--${planStatus.toLowerCase()}`} aria-label="Plan overview">
      <header className="plan-box__header">
        <div>
          <strong>Plan</strong>
          <span className="plan-box__meta">{summary.planId}</span>
          <span className={`plan-box__status plan-box__status--${planStatus.toLowerCase()}`}>
            {planStatus.replace('_', ' ')}
          </span>
        </div>
        <div className="plan-box__fingerprint" title="Plan fingerprint">
          {summary.fingerprint.slice(0, 8)}
        </div>
      </header>

      {error && (
        <div className="plan-box__error">
          {error}
        </div>
      )}

      {isPending && (
        <div className="plan-box__approval">
          <div className="plan-box__approval-message">
            This plan requires your approval before execution.
          </div>
          <div className="plan-box__approval-buttons">
            <button
              className="plan-box__approve-btn"
              onClick={handleApprove}
              disabled={loading}
            >
              {loading ? 'Approving...' : 'Accept'}
            </button>
            <button
              className="plan-box__deny-btn"
              onClick={handleDeny}
              disabled={loading}
            >
              {loading ? 'Denying...' : 'Deny'}
            </button>
          </div>
        </div>
      )}

      {isApproved && (
        <div className="plan-box__status-message plan-box__status-message--approved">
          Plan approved and executing...
        </div>
      )}

      {isDenied && (
        <div className="plan-box__status-message plan-box__status-message--denied">
          Plan denied by user
        </div>
      )}

      <div className="plan-box__body">
        {ordered.length === 0 && !isPending && (
          <p className="plan-box__empty">Waiting for tasks&hellip;</p>
        )}
        {isPending && summary.plan && (
          <div className="plan-box__plan-preview">
            <strong>Planned Tasks:</strong>
            {Object.entries((summary.plan as any).tasks || {}).map(([taskId, task]: [string, any]) => (
              <div key={taskId} className="plan-box__planned-task">
                <span className="plan-box__planned-task-id">{taskId}</span>
                <span className="plan-box__planned-task-tool">{task.tool}</span>
              </div>
            ))}
          </div>
        )}
        {ordered.map((task) => (
          <div key={`${task.taskId}-${task.attempt}`} className={`plan-box__task plan-box__task--${task.state.toLowerCase()}`}>
            <div className="plan-box__task-header">
              <span className="plan-box__task-id">{task.taskId}</span>
              <span className="plan-box__task-state">{task.state}</span>
            </div>
            <div className="plan-box__task-attempt">Attempt {task.attempt}</div>
          </div>
        ))}
      </div>
    </section>
  );
};

export default PlanBox;
