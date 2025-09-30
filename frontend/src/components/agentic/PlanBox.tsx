// status: complete

import React, { useState, useCallback, useEffect } from 'react';
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

const formatJSON = (obj: any): string => {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
};

const JSONViewer: React.FC<{ data: any; label?: string }> = ({ data, label }) => {
  if (!data) return null;

  const jsonString = formatJSON(data);

  return (
    <div className="json-viewer">
      {label && <div className="json-viewer-label">{label}</div>}
      <pre className="json-viewer-content">
        <code className="json-syntax">{jsonString}</code>
      </pre>
    </div>
  );
};

const TaskStateIcon: React.FC<{ state: string }> = ({ state }) => {
  const normalizedState = state.toUpperCase();

  if (normalizedState === 'DONE' || normalizedState === 'COMPLETED') {
    return (
      <svg className="task-state-icon task-state-icon--done" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="2" />
        <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (normalizedState === 'RUNNING') {
    return (
      <svg className="task-state-icon task-state-icon--running" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="8 4" className="spinning-circle" />
      </svg>
    );
  }

  if (normalizedState === 'RETRYING') {
    return (
      <svg className="task-state-icon task-state-icon--retrying" viewBox="0 0 16 16" fill="none">
        <path d="M8 2a6 6 0 0 1 6 6h-2a4 4 0 0 0-4-4V2z" fill="currentColor" className="spinning-arc" />
        <path d="M2 8a6 6 0 0 0 6 6v-2a4 4 0 0 1-4-4H2z" fill="currentColor" opacity="0.3" />
      </svg>
    );
  }

  if (normalizedState === 'FAILED') {
    return (
      <svg className="task-state-icon task-state-icon--failed" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="2" />
        <path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  if (normalizedState === 'PENDING' || normalizedState === 'WAITING' || normalizedState === 'QUEUED') {
    return (
      <svg className="task-state-icon task-state-icon--pending" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="2" opacity="0.4" />
        <circle cx="8" cy="8" r="2" fill="currentColor" opacity="0.6" />
      </svg>
    );
  }

  return null;
};

const PlanBox: React.FC<PlanBoxProps> = ({ summary, tasks, chatId }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [tasksCollapsed, setTasksCollapsed] = useState(false);
  const [plannedTasksCollapsed, setPlannedTasksCollapsed] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const ordered = [...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId));
  const planStatus = (summary.plan as any)?.status || 'PENDING_APPROVAL';
  const normalizedPlanStatus = String(planStatus).toLowerCase().replace(/[^a-z0-9_]/g, '-');
  const planStatusLabel = formatLabel(planStatus);
  const isPending = planStatus === 'PENDING_APPROVAL';
  const isApproved = planStatus === 'APPROVED';
  const isDenied = planStatus === 'DENIED';
  const isFailed = planStatus === 'FAILED';

  const fingerprint = summary.fingerprint || '';
  const displayFingerprint = fingerprint ? fingerprint.slice(0, 8).toUpperCase() : '—';
  const fullFingerprint = fingerprint.toUpperCase();

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

  const planError = (summary.plan as any)?.error || null;

  const totalTasks = ordered.length;
  const completedTasks = ordered.filter(task => task.state === 'DONE').length;
  const runningTasks = ordered.filter(task => task.state === 'RUNNING').length;
  const retryingTasks = ordered.filter(task => task.state === 'RETRYING').length;
  const failedTasks = ordered.filter(task => task.state === 'FAILED').length;
  const queuedTasks = Math.max(totalTasks - completedTasks - runningTasks - retryingTasks - failedTasks, 0);
  const hasRenderedTasks = totalTasks > 0;

  const previewEntries: Array<[string, any]> = summary.plan
    ? Object.entries((summary.plan as any).tasks || {})
    : [];
  const hasPreviewEntries = isPending && previewEntries.length > 0;

  useEffect(() => {
    const savedState = sessionStorage.getItem(`planbox-collapsed-${summary.planId}`);
    if (savedState !== null) {
      setIsCollapsed(JSON.parse(savedState));
    }
  }, [summary.planId]);

  useEffect(() => {
    if (isApproved && isCollapsed) {
      setIsCollapsed(false);
      sessionStorage.setItem(`planbox-collapsed-${summary.planId}`, 'false');
    }
  }, [isApproved, isCollapsed, summary.planId]);

  const toggleCollapse = useCallback(() => {
    const nextState = !isCollapsed;
    setIsCollapsed(nextState);
    sessionStorage.setItem(`planbox-collapsed-${summary.planId}`, JSON.stringify(nextState));
  }, [isCollapsed, summary.planId]);

  const toggleTasksCollapse = useCallback(() => {
    setTasksCollapsed(!tasksCollapsed);
  }, [tasksCollapsed]);

  const togglePlannedTasksCollapse = useCallback(() => {
    setPlannedTasksCollapsed(!plannedTasksCollapsed);
  }, [plannedTasksCollapsed]);

  const toggleTaskDetails = useCallback((taskId: string) => {
    setExpandedTaskId(prevId => prevId === taskId ? null : taskId);
  }, []);

  const handleCopyId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(summary.planId);
      const el = document.querySelector('.plan-box-id');
      if (el) {
        el.classList.add('copied');
        setTimeout(() => el.classList.remove('copied'), 300);
      }
    } catch (err) {
      console.error('Failed to copy plan ID:', err);
    }
  }, [summary.planId]);

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
      <header
        className="plan-box-header"
        onClick={toggleCollapse}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleCollapse();
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
      >
        <div className="plan-box-title-section">
          <div className="plan-icon" aria-hidden="true"></div>
          <div className="plan-box-title-content">
            <h3 className="plan-box-name" title={planName}>{planName}</h3>
            <div className="plan-box-meta-row">
              <span
                className="plan-box-id"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyId();
                }}
                role="button"
                tabIndex={0}
                aria-label="Copy plan ID"
                title="Click to copy"
              >
                {summary.planId}
              </span>
              {fingerprint && (
                <>
                  <span className="plan-box-meta-separator" aria-hidden="true">·</span>
                  <span
                    className="plan-box-fingerprint"
                    data-full-hash={fullFingerprint}
                    aria-label={`Fingerprint: ${fullFingerprint}`}
                    title={fullFingerprint}
                  >
                    {displayFingerprint}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="plan-box-header-right">
          <div className="plan-box-status" aria-label={`Status: ${planStatusLabel}`}>
            {planStatusLabel}
          </div>

          <div className={`collapse-arrow ${isCollapsed ? 'collapsed' : ''}`} aria-hidden="true">
            <div className="arrow-icon"></div>
          </div>
        </div>
      </header>

      <div className={`plan-box-content ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="plan-box-content-inner">
          {planObjective && (
            <p className="plan-box-objective">{planObjective}</p>
          )}

          {hasRenderedTasks && (
            <div className="plan-box-stats">
              <div className="plan-box-stat" aria-label={`${totalTasks} total tasks`}>
                <span className="plan-box-stat-value">{totalTasks}</span>
                <span className="plan-box-stat-label">Tasks</span>
              </div>
              <div className="plan-box-stat" aria-label={`${runningTasks} tasks running`}>
                <span className="plan-box-stat-value">{runningTasks}</span>
                <span className="plan-box-stat-label">Running</span>
              </div>
              {retryingTasks > 0 && (
                <div className="plan-box-stat plan-box-stat--retrying" aria-label={`${retryingTasks} retrying tasks`}>
                  <span className="plan-box-stat-value">{retryingTasks}</span>
                  <span className="plan-box-stat-label">Retrying</span>
                </div>
              )}
              <div className="plan-box-stat" aria-label={`${completedTasks} completed tasks`}>
                <span className="plan-box-stat-value">{completedTasks}</span>
                <span className="plan-box-stat-label">Done</span>
              </div>
              {failedTasks > 0 && (
                <div className="plan-box-stat plan-box-stat--failed" aria-label={`${failedTasks} failed tasks`}>
                  <span className="plan-box-stat-value">{failedTasks}</span>
                  <span className="plan-box-stat-label">Failed</span>
                </div>
              )}
              {queuedTasks > 0 && (
                <div className="plan-box-stat" aria-label={`${queuedTasks} queued tasks`}>
                  <span className="plan-box-stat-value">{queuedTasks}</span>
                  <span className="plan-box-stat-label">Queued</span>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="plan-box-error" role="alert">
              {error}
            </div>
          )}

          {planError && isFailed && (
            <div className="plan-box-plan-error" role="alert">
              <div className="plan-box-plan-error-header">
                <span className="plan-box-plan-error-icon">⚠</span>
                <span className="plan-box-plan-error-title">Plan Execution Failed</span>
              </div>
              <div className="plan-box-plan-error-message">{planError}</div>
            </div>
          )}

          {isPending && (
            <div className="plan-box-approval">
              <div className="plan-box-approval-message">
                This plan requires your approval before execution.
              </div>
              <div className="plan-box-approval-buttons">
                <button
                  className={`plan-box-approve-btn ${loading ? 'loading' : ''}`}
                  onClick={handleApprove}
                  disabled={loading}
                  aria-label="Approve plan"
                >
                  {loading ? '' : 'Approve'}
                </button>
                <button
                  className={`plan-box-deny-btn ${loading ? 'loading' : ''}`}
                  onClick={handleDeny}
                  disabled={loading}
                  aria-label="Deny plan"
                >
                  {loading ? '' : 'Reject'}
                </button>
              </div>
            </div>
          )}

          {isApproved && (
            <div className="plan-box-status-message plan-box-status-message--approved">
              Plan approved and executing…
            </div>
          )}

          {isDenied && (
            <div className="plan-box-status-message plan-box-status-message--denied">
              Plan denied by user
            </div>
          )}

          {hasPreviewEntries && (
            <div className="plan-box-section">
              <div
                className="plan-box-section-header"
                onClick={togglePlannedTasksCollapse}
                role="button"
                tabIndex={0}
                aria-expanded={!plannedTasksCollapsed}
              >
                <span className="plan-box-section-title">Planned Tasks</span>
                <span className="plan-box-section-count">{previewEntries.length}</span>
              </div>
              <div className={`plan-box-section-content ${plannedTasksCollapsed ? 'collapsed' : ''}`}>
                <div className="plan-box-planned-tasks">
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
                      <div key={taskId} className="plan-box-planned-task">
                        <div className="plan-box-planned-task-main">
                          <span className="plan-box-planned-task-id">{taskId}</span>
                          {previewDescription && (
                            <p className="plan-box-planned-task-description">{previewDescription}</p>
                          )}
                        </div>
                        {previewTool && (
                          <span className="plan-box-planned-task-tool">{previewTool}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {hasRenderedTasks && (
            <div className="plan-box-section">
              <div
                className="plan-box-section-header"
                onClick={toggleTasksCollapse}
                role="button"
                tabIndex={0}
                aria-expanded={!tasksCollapsed}
              >
                <span className="plan-box-section-title">Executing Tasks</span>
                <span className="plan-box-section-count">{ordered.length}</span>
              </div>
              <div className={`plan-box-section-content ${tasksCollapsed ? 'collapsed' : ''}`}>
                <div className="plan-box-tasks">
                  {ordered.map(task => {
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

                    const taskError = task.payload?.error || (task.state === 'FAILED' ? 'Task execution failed' : null);
                    const retryInfo = task.payload?.retry || task.payload?.retries;
                    const maxRetries = task.payload?.max_retries || 3;
                    const retryDelay = task.payload?.delay;

                    const isExpanded = expandedTaskId === task.taskId;
                    const isFailed = task.state === 'FAILED';
                    const isRetrying = task.state === 'RETRYING';

                    return (
                      <div
                        key={`${task.taskId}-${task.attempt}`}
                        className={`plan-box-task plan-box-task--${taskStateClass}`}
                        onClick={() => toggleTaskDetails(task.taskId)}
                        role="button"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                      >
                        <div className="plan-box-task-header">
                          <div className="plan-box-task-id-wrapper">
                            <TaskStateIcon state={task.state} />
                            <span className="plan-box-task-id">{task.taskId}</span>
                          </div>
                          <span className="plan-box-task-state">{taskStateLabel}</span>
                        </div>

                        {isRetrying && retryInfo !== undefined && (
                          <div className="plan-box-task-retry-banner">
                            <div className="plan-box-task-retry-spinner"></div>
                            <span className="plan-box-task-retry-text">
                              Retrying {retryInfo}/{maxRetries}
                              {retryDelay && ` (wait ${retryDelay.toFixed(1)}s)`}
                            </span>
                          </div>
                        )}

                        {isFailed && taskError && (
                          <div className="plan-box-task-error-banner">
                            <span className="plan-box-task-error-icon">!</span>
                            <span className="plan-box-task-error-text">{taskError}</span>
                          </div>
                        )}

                        <div className="plan-box-task-meta">
                          <span className="plan-box-task-attempt">Attempt {task.attempt}</span>
                          {taskTool && <span className="plan-box-task-tool">{taskTool}</span>}
                        </div>
                        {taskDescription && (
                          <p className="plan-box-task-description">{taskDescription}</p>
                        )}

                        {/* Expandable task details */}
                        <div className={`plan-box-task-details ${isExpanded ? 'expanded' : ''}`}>
                          <div className="plan-box-task-inspector">
                            <div className="plan-box-task-detail-section">
                              <div className="plan-box-task-detail-section-header">Basic Info</div>
                              <div className="plan-box-task-detail-grid">
                                <div className="plan-box-task-detail-item">
                                  <div className="plan-box-task-detail-label">Task ID</div>
                                  <div className="plan-box-task-detail-value">{task.taskId}</div>
                                </div>
                                <div className="plan-box-task-detail-item">
                                  <div className="plan-box-task-detail-label">State</div>
                                  <div className="plan-box-task-detail-value">{task.state}</div>
                                </div>
                                <div className="plan-box-task-detail-item">
                                  <div className="plan-box-task-detail-label">Attempt</div>
                                  <div className="plan-box-task-detail-value">{task.attempt}</div>
                                </div>
                                {taskTool && (
                                  <div className="plan-box-task-detail-item">
                                    <div className="plan-box-task-detail-label">Tool</div>
                                    <div className="plan-box-task-detail-value">{taskTool}</div>
                                  </div>
                                )}
                                {task.updatedAt && (
                                  <div className="plan-box-task-detail-item">
                                    <div className="plan-box-task-detail-label">Updated</div>
                                    <div className="plan-box-task-detail-value">
                                      {new Date(task.updatedAt).toLocaleString()}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>

                            {isFailed && taskError && (
                              <div className="plan-box-task-detail-section plan-box-task-detail-section--error">
                                <div className="plan-box-task-detail-section-header">Error Details</div>
                                <div className="plan-box-task-error-details">
                                  <div className="plan-box-task-error-message">{taskError}</div>
                                  {retryInfo !== undefined && (
                                    <div className="plan-box-task-error-retries">
                                      Retries attempted: {retryInfo}/{maxRetries}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}

                            {task.payload && Object.keys(task.payload).length > 0 && (
                              <div className="plan-box-task-detail-section">
                                <div className="plan-box-task-detail-section-header">Task Payload</div>
                                <JSONViewer data={task.payload} />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {!hasRenderedTasks && !isPending && (
            <p className="plan-box-empty">Waiting for tasks…</p>
          )}
        </div>
      </div>
    </section>
  );
};

export default PlanBox;