// status: alpha

import React, { useState } from 'react';
import '../../styles/agentic/PlanBox.css';
import { PlanSummary, TaskStateEntry } from '../../utils/agentic/PlanStore';
import { apiUrl } from '../../config/api';

interface PlanBoxProps {
  summary: PlanSummary;
  tasks: TaskStateEntry[];
  chatId: string;
}

const formatLabel = (value: string) =>
  String(value)
    .toLowerCase()
    .split('_')
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');

const PlanBox: React.FC<PlanBoxProps> = ({ summary, tasks, chatId }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ordered = [...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId));
  const planStatus = (summary.plan as any)?.status || 'PENDING_APPROVAL';
  const normalizedPlanStatus = String(planStatus).toLowerCase().replace(/[^a-z0-9_]/g, '-');
  const planStatusLabel = formatLabel(planStatus);
  const isPending = planStatus === 'PENDING_APPROVAL';
  const isApproved = planStatus === 'APPROVED';
  const isDenied = planStatus === 'DENIED';

  const fingerprint = summary.fingerprint || '';
  const displayFingerprint = fingerprint ? fingerprint.slice(0, 12).toUpperCase() : '—';
  const planName = (() => {
    const rawName = (summary.plan as any)?.name;
    if (typeof rawName === 'string' && rawName.trim().length > 0) {
      return rawName.trim();
    }
    return 'Execution Plan';
  })();
  const planObjective = (() => {
    const candidate = (summary.plan as any)?.objective || (summary.plan as any)?.description;
    return typeof candidate === 'string' ? candidate.trim() : '';
  })();

  const totalTasks = ordered.length;
  const completedTasks = ordered.filter(task => task.state === 'DONE').length;
  const runningTasks = ordered.filter(task => task.state === 'RUNNING').length;
  const queuedTasks = Math.max(totalTasks - completedTasks - runningTasks, 0);
  const hasRenderedTasks = totalTasks > 0;

  const previewEntries: Array<[string, any]> = summary.plan
    ? Object.entries((summary.plan as any).tasks || {})
    : [];
  const hasPreviewEntries = isPending && previewEntries.length > 0;

  const handleApprove = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/api/chats/${chatId}/plan/${summary.planId}/approve`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Failed to approve plan');
        console.error('Plan approval failed:', { status: response.status, error: data.error });
      }
    } catch (err) {
      setError('Network error');
      console.error('Plan approval failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDeny = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/api/chats/${chatId}/plan/${summary.planId}/deny`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Failed to deny plan');
        console.error('Plan denial failed:', { status: response.status, error: data.error });
      }
    } catch (err) {
      setError('Network error');
      console.error('Plan denial failed:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={`plan-box plan-box--${normalizedPlanStatus}`} aria-label="Plan overview">
      <header className="plan-box__header">
        <div className="plan-box__title">
          <span className="plan-box__eyebrow">Plan</span>
          <div className="plan-box__title-row">
            <h3 className="plan-box__heading">{planName}</h3>
            <span className={`plan-box__status plan-box__status--${normalizedPlanStatus}`}>
              {planStatusLabel}
            </span>
          </div>
          <div className="plan-box__meta">ID · {summary.planId}</div>
        </div>
        <div className="plan-box__fingerprint" title="Plan fingerprint">
          <span className="plan-box__fingerprint-label">Fingerprint</span>
          <span className="plan-box__fingerprint-value">{displayFingerprint}</span>
        </div>
      </header>

      {planObjective && (
        <p className="plan-box__objective">{planObjective}</p>
      )}

      {hasRenderedTasks && (
        <div className="plan-box__stats">
          <div className="plan-box__stat">
            <span className="plan-box__stat-value">{totalTasks}</span>
            <span className="plan-box__stat-label">Tasks</span>
          </div>
          <div className="plan-box__stat">
            <span className="plan-box__stat-value">{runningTasks}</span>
            <span className="plan-box__stat-label">In Flight</span>
          </div>
          <div className="plan-box__stat">
            <span className="plan-box__stat-value">{completedTasks}</span>
            <span className="plan-box__stat-label">Completed</span>
          </div>
          {queuedTasks > 0 && (
            <div className="plan-box__stat">
              <span className="plan-box__stat-value">{queuedTasks}</span>
              <span className="plan-box__stat-label">Queued</span>
            </div>
          )}
        </div>
      )}

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
              {loading ? 'Approving…' : 'Approve plan'}
            </button>
            <button
              className="plan-box__deny-btn"
              onClick={handleDeny}
              disabled={loading}
            >
              {loading ? 'Denying…' : 'Reject plan'}
            </button>
          </div>
        </div>
      )}

      {isApproved && (
        <div className="plan-box__status-message plan-box__status-message--approved">
          Plan approved and executing…
        </div>
      )}

      {isDenied && (
        <div className="plan-box__status-message plan-box__status-message--denied">
          Plan denied by user
        </div>
      )}

      <div className={`plan-box__body ${hasRenderedTasks ? 'plan-box__body--has-tasks' : ''}`}>
        {hasPreviewEntries && (
          <div className="plan-box__plan-preview">
            <div className="plan-box__plan-preview-header">
              <span className="plan-box__plan-preview-title">Planned Tasks</span>
              <span className="plan-box__plan-preview-subtitle">Review before approval</span>
            </div>
            <div className="plan-box__plan-preview-list">
              {previewEntries.map(([taskId, task]) => {
                const previewDescription = typeof task?.description === 'string'
                  ? task.description
                  : typeof task?.summary === 'string'
                    ? task.summary
                    : typeof task?.objective === 'string'
                      ? task.objective
                      : '';
                const previewTool = typeof task?.tool === 'string' ? task.tool : '';
                return (
                  <div key={taskId} className="plan-box__planned-task">
                    <div className="plan-box__planned-task-main">
                      <span className="plan-box__planned-task-id">{taskId}</span>
                      {previewDescription && (
                        <p className="plan-box__planned-task-description">{previewDescription}</p>
                      )}
                    </div>
                    {previewTool && (
                      <span className="plan-box__planned-task-tool">{previewTool}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {hasRenderedTasks ? (
          ordered.map(task => {
            const taskStateLabel = formatLabel(task.state);
            const taskStateClass = String(task.state).toLowerCase().replace(/[^a-z0-9_]/g, '-');
            const taskTool = typeof task.payload?.tool === 'string'
              ? task.payload.tool
              : typeof task.payload?.metadata?.tool === 'string'
                ? task.payload.metadata.tool
                : undefined;
            const taskDescription = typeof task.payload?.summary === 'string'
              ? task.payload.summary
              : typeof task.payload?.description === 'string'
                ? task.payload.description
                : undefined;

            return (
              <div
                key={`${task.taskId}-${task.attempt}`}
                className={`plan-box__task plan-box__task--${taskStateClass}`}
              >
                <div className="plan-box__task-header">
                  <span className="plan-box__task-id">{task.taskId}</span>
                  <span className="plan-box__task-state">{taskStateLabel}</span>
                </div>
                <div className="plan-box__task-meta">
                  <span className="plan-box__task-attempt">Attempt {task.attempt}</span>
                  {taskTool && <span className="plan-box__task-tool">{taskTool}</span>}
                </div>
                {taskDescription && (
                  <p className="plan-box__task-description">{taskDescription}</p>
                )}
              </div>
            );
          })
        ) : (
          !isPending && (
            <p className="plan-box__empty">Waiting for tasks…</p>
          )
        )}
      </div>
    </section>
  );
};

export default PlanBox;
