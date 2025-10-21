// Domain Execution Visualization Component
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import '../../styles/agentic/DomainBox.css';
import logger from '../../utils/core/logger';
import useScrollControl from '../../hooks/ui/useScrollControl';
import type { DomainExecution, ContextSnapshot, ToolOperation } from '../../types/messages';
import { apiUrl } from '../../config/api';
import { Icons } from '../ui/Icons';

const PARAM_PRIORITY = [
  'file_path',
  'path',
  'target_path',
  'directory',
  'command',
  'pattern',
  'start_line',
  'end_line',
];

const normalizeParams = (raw: unknown): Array<[string, unknown]> => {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.reduce<Array<[string, unknown]>>((acc, entry) => {
      if (Array.isArray(entry) && entry.length >= 2) {
        const name = typeof entry[0] === 'string' ? entry[0] : String(entry[0]);
        acc.push([name, entry[1]]);
      } else if (entry && typeof entry === 'object') {
        const provisional = entry as { name?: string; value?: unknown };
        if (typeof provisional.name === 'string') {
          acc.push([provisional.name, provisional.value]);
        }
      }
      return acc;
    }, []);
  }
  if (typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>);
  }
  return [];
};

const formatParamValue = (
  value: unknown,
  maxLength = 40,
): { short: string; full: string } => {
  const limit = Math.max(4, maxLength);

  if (value === null) {
    return { short: 'null', full: 'null' };
  }
  if (value === undefined) {
    return { short: 'undefined', full: 'undefined' };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const display = trimmed.length > 0 ? trimmed : '(empty)';
    const short =
      display.length > limit ? `${display.slice(0, limit - 3)}...` : display;
    return { short, full: display };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    const str = String(value);
    return { short: str, full: str };
  }

  try {
    const serialized = JSON.stringify(value);
    if (!serialized) {
      return { short: '(empty)', full: '(empty)' };
    }
    const short =
      serialized.length > limit
        ? `${serialized.slice(0, limit - 3)}...`
        : serialized;
    return { short, full: serialized };
  } catch {
    const fallback = String(value);
    const short =
      fallback.length > limit ? `${fallback.slice(0, limit - 3)}...` : fallback;
    return { short, full: fallback };
  }
};

const buildParamChips = (
  raw: unknown,
  limit = 3,
): {
  chips: Array<{ name: string; shortValue: string; fullValue: string }>;
  remaining: number;
} => {
  const pairs = normalizeParams(raw);
  if (pairs.length === 0) {
    return { chips: [], remaining: 0 };
  }

  const sorted = pairs.slice().sort((a, b) => {
    const indexA = PARAM_PRIORITY.indexOf(a[0]);
    const indexB = PARAM_PRIORITY.indexOf(b[0]);
    const weightA = indexA === -1 ? PARAM_PRIORITY.length : indexA;
    const weightB = indexB === -1 ? PARAM_PRIORITY.length : indexB;
    if (weightA !== weightB) {
      return weightA - weightB;
    }
    return a[0].localeCompare(b[0]);
  });

  const limited = sorted.slice(0, Math.max(0, limit));
  const chips = limited.map(([name, value]) => {
    const formatted = formatParamValue(value);
    return {
      name,
      shortValue: formatted.short,
      fullValue: formatted.full,
    };
  });

  return {
    chips,
    remaining: Math.max(0, sorted.length - limited.length),
  };
};

const formatActionType = (type: string): string => {
  if (!type) {
    return 'Action';
  }
  return type
    .split('_')
    .map((segment) =>
      segment.length > 0
        ? segment.charAt(0).toUpperCase() + segment.slice(1)
        : segment,
    )
    .join(' ');
};

const getStatusLabel = (status: string): string => {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'in_progress':
      return 'In progress';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'aborted':
      return 'Aborted';
    default:
      return status || 'Unknown';
  }
};

const formatTimestamp = (isoString: string): string => {
  if (!isoString) {
    return '';
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const getToolIconForName = (toolName?: string) => {
  if (!toolName) {
    return Icons.Info;
  }
  const lower = toolName.toLowerCase();
  if (lower.startsWith('file.')) {
    return Icons.File;
  }
  if (lower.startsWith('git.')) {
    return Icons.History;
  }
  if (
    lower.startsWith('bash') ||
    lower.startsWith('shell') ||
    lower.startsWith('cmd') ||
    lower.startsWith('powershell')
  ) {
    return Icons.Terminal;
  }
  if (lower.startsWith('test.') || lower.includes('test')) {
    return Icons.Check;
  }
  if (lower.startsWith('code.')) {
    return Icons.FileCode;
  }
  if (lower.startsWith('llm.') || lower.includes('model')) {
    return Icons.Zap;
  }
  if (lower.includes('search')) {
    return Icons.Search;
  }
  return Icons.Info;
};

const getShortCallId = (callId?: string): string => {
  if (!callId) {
    return '';
  }
  if (callId.length <= 14) {
    return callId;
  }
  return `${callId.slice(0, 8)}...${callId.slice(-4)}`;
};

const formatElapsedSeconds = (seconds?: number): string => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return '';
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const rounded = Math.round(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${mins}m ${secs}s`;
};

const truncateTaskDescription = (description: string, maxLength = 20): string => {
  if (!description) {
    return '';
  }
  const trimmed = description.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 1)}…`;
};

const summarizeResult = (
  result: unknown,
  maxLength = 140,
): { short: string; full: string } | null => {
  if (result === null || result === undefined) {
    return null;
  }

  let full = '';
  if (typeof result === 'string') {
    full = result.trim();
  } else {
    try {
      full = JSON.stringify(result);
    } catch {
      full = String(result);
    }
  }

  if (!full) {
    return null;
  }

  const collapsed = full.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return null;
  }

  const limit = Math.max(4, maxLength);
  const short =
    collapsed.length > limit
      ? `${collapsed.slice(0, limit - 3)}...`
      : collapsed;

  return { short, full: collapsed };
};

interface DomainBoxProps {
  domainExecution: DomainExecution | null;
  isProcessing?: boolean;
  isVisible?: boolean;
  chatId?: string;
  messageId?: string;
  chatScrollControl?: {
    shouldAutoScroll: () => boolean;
    onStreamStart: () => void;
    onStreamEnd: () => void;
    forceScrollToBottom: () => void;
  };
}

const DomainBox: React.FC<DomainBoxProps> = ({
  domainExecution,
  isProcessing = false,
  isVisible = true,
  chatId,
  messageId
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [selectedAction, setSelectedAction] = useState<string | null>(null);
  const [showRawContext, setShowRawContext] = useState(false);
  const [expandedContext, setExpandedContext] = useState(false);
  const [isActionFlowCollapsed, setIsActionFlowCollapsed] = useState(false);
  const [isToolHistoryCollapsed, setIsToolHistoryCollapsed] = useState(false);
  const [decisionState, setDecisionState] = useState<'idle' | 'accepting' | 'rejecting'>('idle');
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [showApprovalUI, setShowApprovalUI] = useState(true);
  const [confirmedDecision, setConfirmedDecision] = useState<'accept' | 'reject' | null>(null);
  const [autoAcceptEnabled, setAutoAcceptEnabled] = useState(() => {
    return localStorage.getItem('coder-auto-accept') === 'true';
  });

  const domainBoxContentRef = useRef<HTMLDivElement | null>(null);
  const actionsEndRef = useRef<HTMLDivElement>(null);
  const autoAcceptTriggered = useRef<string | null>(null); // Track which tool was auto-accepted

  const domainBoxScrollControl = useScrollControl({
    chatId: `domainbox-${chatId}-${messageId}`,
    streamingState: isProcessing ? 'thinking' : 'static',
    containerRef: domainBoxContentRef,
    scrollType: 'thinkbox',
    isIsolated: true,
  });

  useEffect(() => {
    if (isProcessing && domainExecution?.actions && domainBoxScrollControl.shouldAutoScroll()) {
      actionsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [domainExecution?.actions, isProcessing, domainBoxScrollControl]);

  useEffect(() => {
    if (isProcessing) {
      domainBoxScrollControl.onStreamStart();
    } else {
      domainBoxScrollControl.onStreamEnd();
    }
  }, [isProcessing, domainBoxScrollControl]);

  const toggleCollapse = () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    logger.info(`[DOMAINBOX] Manual toggle for ${chatId}: ${next ? 'collapsed' : 'expanded'}`);
    try {
      window.dispatchEvent(
        new CustomEvent('chatContentResized', {
          detail: { chatId, messageId, source: 'domainbox', collapsed: next },
        })
      );
    } catch (e) {
      logger.warn(`[DOMAINBOX] Failed to dispatch resize event:`, e);
    }
  };

  const getActionStatusClass = (status: string): string => {
    switch (status) {
      case 'completed':
        return 'completed';
      case 'in_progress':
        return 'in-progress';
      case 'failed':
        return 'failed';
      default:
        return 'pending';
    }
  };

  const getStepStatusClass = (status: string): string => {
    return getActionStatusClass(status);
  };

  const getCurrentContext = (): ContextSnapshot | null => {
    if (!domainExecution?.context_snapshots || domainExecution.context_snapshots.length === 0) {
      return null;
    }
    return domainExecution.context_snapshots[domainExecution.context_snapshots.length - 1];
  };
  const currentContext = getCurrentContext();
  const actions = domainExecution?.actions || [];
  const pendingTool = domainExecution?.pending_tool || null;
  const isWaitingForUser = domainExecution?.status === 'waiting_user';
  const plan = domainExecution?.plan;
  const taskDescription = plan?.task_description || domainExecution?.output || 'Executing domain task...';
  const toolHistory = domainExecution?.tool_history || [];
  const isCoderDomain = domainExecution?.domain_id === 'coder';

  const getLinesAdded = (operation: Partial<ToolOperation> | undefined): number => {
    if (!operation) return 0;
    if (typeof operation.linesAdded === 'number') return operation.linesAdded;
    if (typeof (operation as any).lines_added === 'number') return (operation as any).lines_added;
    return 0;
  };

  const getLinesRemoved = (operation: Partial<ToolOperation> | undefined): number => {
    if (!operation) return 0;
    if (typeof operation.linesRemoved === 'number') return operation.linesRemoved;
    if (typeof (operation as any).lines_removed === 'number') return (operation as any).lines_removed;
    return 0;
  };

  const getCheckpointId = (
    operation: Partial<ToolOperation> | undefined,
    position: 'before' | 'after'
  ): number | null => {
    if (!operation) return null;
    const directKey = position === 'before' ? 'before_checkpoint_id' : 'after_checkpoint_id';
    if (typeof (operation as any)[directKey] === 'number') {
      return (operation as any)[directKey] as number;
    }
    const checkpointIds = operation.checkpoint_ids;
    if (checkpointIds && typeof checkpointIds[position] === 'number') {
      return checkpointIds[position] as number;
    }
    return null;
  };

  const getCheckpointCreated = (
    operation: Partial<ToolOperation> | undefined,
    position: 'before' | 'after'
  ): boolean | undefined => {
    if (!operation) return undefined;
    const directKey = position === 'before' ? 'before_checkpoint_created' : 'after_checkpoint_created';
    if ((operation as any)[directKey] !== undefined) {
      return Boolean((operation as any)[directKey]);
    }
    const checkpointCreated = operation.checkpoint_created;
    if (checkpointCreated && typeof checkpointCreated[position] !== 'undefined') {
      return Boolean(checkpointCreated[position]);
    }
    return undefined;
  };

  const checkpointChipClassName = (position: 'before' | 'after', created?: boolean) => {
    const classes = ['checkpoint-chip', position];
    if (created === false) {
      classes.push('reused');
    }
    return classes.join(' ');
  };

  const renderCheckpointChip = (
    position: 'before' | 'after',
    operation: Partial<ToolOperation> | undefined
  ) => {
    const id = getCheckpointId(operation, position);
    const created = getCheckpointCreated(operation, position);
    const classNames = [checkpointChipClassName(position, created)];
    let label: string;
    let title: string | undefined;

    if (id == null) {
      classNames.push('missing');
      label = position === 'before' ? 'No pre-checkpoint' : 'No post-checkpoint';
    } else {
      label = `${position === 'before' ? 'Before' : 'After'} · #${id}${created === false ? ' (reused)' : ''}`;
      title = created === false ? 'Reused existing checkpoint' : 'New checkpoint created';
    }

    return (
      <span className={classNames.join(' ')} title={title}>
        {label}
      </span>
    );
  };

  const formatOperationType = (type?: string): string => {
    if (!type) return 'Operation';
    return type
      .split('_')
      .filter(Boolean)
      .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ');
  };

  const formatCallId = (callId?: string): string => {
    if (!callId) return '—';
    const trimmed = callId.trim();
    if (trimmed.length <= 8) {
      return trimmed;
    }
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
  };

  const formatTimestampCompact = (iso?: string): string => {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  type DisplayOperation = ToolOperation & {
    callId: string;
    tool: string;
    executedAt: string;
  };

  const coderFileOperations = useMemo<DisplayOperation[]>(() => {
    if (!isCoderDomain) {
      return [];
    }
    return toolHistory.flatMap(entry => {
      const ops = Array.isArray(entry.ops) ? entry.ops : [];
      return ops
        .filter(op => op && typeof op === 'object')
        .filter(op => {
          const opType = String((op as any).type || '');
          return opType === 'file_write' || opType === 'file_edit' || opType === 'notebook_edit';
        })
        .map(op => ({
          ...op,
          callId: entry.call_id,
          tool: entry.tool,
          executedAt: entry.executed_at,
        }));
    });
  }, [isCoderDomain, toolHistory]);

  const coderOpsByCallId = useMemo(() => {
    const map = new Map<string, DisplayOperation[]>();
    coderFileOperations.forEach(op => {
      if (!map.has(op.callId)) {
        map.set(op.callId, []);
      }
      map.get(op.callId)!.push(op);
    });
    return map;
  }, [coderFileOperations]);

  const coderFileOperationTotals = useMemo(() => {
    return coderFileOperations.reduce(
      (acc, op) => {
        acc.added += getLinesAdded(op);
        acc.removed += getLinesRemoved(op);
        return acc;
      },
      { added: 0, removed: 0 }
    );
  }, [coderFileOperations]);

  const executionMetadata = domainExecution?.metadata;
  const pendingToolSummary = buildParamChips(pendingTool?.params, 1);
  const pendingToolPrimaryParam = pendingToolSummary.chips[0];
  const hasExecutionStats =
    !!executionMetadata &&
    (typeof executionMetadata.iterations === 'number' ||
      typeof executionMetadata.tool_calls === 'number' ||
      typeof executionMetadata.elapsed_seconds === 'number');
  const hasHeaderDetails = !!taskDescription || hasExecutionStats || !!pendingTool;

  useEffect(() => {
    if (!isWaitingForUser) {
      setDecisionState('idle');
      setDecisionError(null);
      setShowApprovalUI(true);
      setConfirmedDecision(null);
    } else {
      // Reset UI when a new tool appears (different call_id)
      setDecisionError(null);
      setShowApprovalUI(true);
      setConfirmedDecision(null);
    }
  }, [isWaitingForUser, pendingTool]);

  // Tool decision handler - defined early so it can be used in useEffects below
  const handleToolDecision = useCallback(async (decision: 'accept' | 'reject') => {
    if (!pendingTool || !chatId || !domainExecution) {
      return;
    }

    const pendingState = decision === 'accept' ? 'accepting' : 'rejecting';
    setDecisionState(pendingState);
    setDecisionError(null);

    try {
      const endpoint = apiUrl(`/api/chats/${chatId}/domain/${domainExecution.task_id}/tool/${pendingTool.call_id}/decision`);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          assistant_message_id: messageId ?? null
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        const errorMsg = data?.error || `Failed to ${decision} tool call`;
        throw new Error(errorMsg);
      }

      logger.info(`[DOMAINBOX] Submitted tool decision '${decision}' for ${pendingTool.tool}`, { chatId, taskId: domainExecution.task_id });

      // Show confirmed state for 650ms before hiding UI
      setConfirmedDecision(decision);
      await new Promise(resolve => setTimeout(resolve, 650));
      setShowApprovalUI(false);
    } catch (error) {
      logger.error('[DOMAINBOX] Tool decision failed', error);
      setDecisionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDecisionState('idle');
    }
  }, [pendingTool, chatId, domainExecution, messageId]);

  // Listen for auto-accept setting changes
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'coder-auto-accept') {
        setAutoAcceptEnabled(e.newValue === 'true');
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Auto-accept logic
  useEffect(() => {
    if (!autoAcceptEnabled || !isWaitingForUser || !pendingTool || !chatId || !domainExecution) {
      return;
    }

    // Guard against double-triggering
    if (autoAcceptTriggered.current === pendingTool.call_id) {
      return;
    }

    // Guard against already processing decision
    if (decisionState !== 'idle') {
      return;
    }

    logger.info(`[DOMAINBOX] Auto-accepting tool: ${pendingTool.tool}`, {
      chatId,
      taskId: domainExecution.task_id,
      callId: pendingTool.call_id
    });

    // Mark this tool as auto-accepted to prevent re-triggering
    autoAcceptTriggered.current = pendingTool.call_id;

    // Hide the approval UI immediately
    setShowApprovalUI(false);

    // Automatically accept the tool
    handleToolDecision('accept');
  }, [autoAcceptEnabled, isWaitingForUser, pendingTool, chatId, domainExecution, decisionState, handleToolDecision]);

  // Reset auto-accept trigger when tool changes
  useEffect(() => {
    if (!pendingTool) {
      autoAcceptTriggered.current = null;
    }
  }, [pendingTool]);

  // Auto-collapse/expand based on execution state
  useEffect(() => {
    if (isProcessing) {
      // Auto-expand when execution starts
      setIsCollapsed(false);
    } else if (domainExecution && !isProcessing) {
      // Auto-collapse when execution completes with a terminal status
      const terminalStatuses = ['completed', 'failed', 'aborted'];
      if (terminalStatuses.includes(domainExecution.status)) {
        setIsCollapsed(true);
      }
    }
  }, [isProcessing, domainExecution]);

  if (!isVisible || (!domainExecution && !isProcessing)) {
    return null;
  }

  return (
    <div className="domain-box">
      <div
        className="domain-box-header"
        onClick={toggleCollapse}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            toggleCollapse();
          }
        }}
      >
        <div className="domain-box-title">
          <div className="domain-icon">
            <div className="icon-layer"></div>
            <div className="icon-layer"></div>
            <div className="icon-layer"></div>
          </div>
          <span className="domain-label">
            {isProcessing ? 'Domain Executing' : 'Domain Execution'}
          </span>
          {domainExecution && (
            <div className="domain-badge">
              <span className="domain-badge-text">{domainExecution.domain_id}</span>
            </div>
          )}
          {isProcessing && (
            <div className="execution-indicator">
              <div className="pulse-dot"></div>
              <div className="pulse-dot"></div>
              <div className="pulse-dot"></div>
            </div>
          )}
        </div>
        {hasHeaderDetails && (
          <div className="domain-box-header-details">
            {(taskDescription || hasExecutionStats) && (
              <div className="domain-stat-group">
                {taskDescription && (
                  <span className="domain-stat-chip task-chip" title={taskDescription}>
                    <span className="stat-label">Task</span>
                    <span className="stat-value">{truncateTaskDescription(taskDescription, 20)}</span>
                  </span>
                )}
                {hasExecutionStats && executionMetadata && typeof executionMetadata.iterations === 'number' && (
                  <span className="domain-stat-chip" title="Agent iterations">
                    <span className="stat-label">Iterations</span>
                    <span className="stat-value">{executionMetadata.iterations}</span>
                  </span>
                )}
                {hasExecutionStats && executionMetadata && typeof executionMetadata.tool_calls === 'number' && (
                  <span className="domain-stat-chip" title="Tool calls used">
                    <span className="stat-label">Tool calls</span>
                    <span className="stat-value">{executionMetadata.tool_calls}</span>
                  </span>
                )}
                {hasExecutionStats && executionMetadata && typeof executionMetadata.elapsed_seconds === 'number' && (
                  <span className="domain-stat-chip" title="Elapsed execution time">
                    <span className="stat-label">Elapsed</span>
                    <span className="stat-value">
                      {formatElapsedSeconds(executionMetadata.elapsed_seconds)}
                    </span>
                  </span>
                )}
              </div>
            )}
            {pendingTool && (
              <div
                className="pending-tool-summary"
                title={pendingTool.reason || pendingTool.tool_description || ''}
              >
                <span className="pending-tool-name">{pendingTool.tool}</span>
                {pendingToolPrimaryParam && (
                  <span className="pending-tool-param">
                    {pendingToolPrimaryParam.shortValue}
                    {pendingToolSummary.remaining > 0 && ` (+${pendingToolSummary.remaining} more)`}
                  </span>
                )}
                {!pendingToolPrimaryParam && pendingTool.reason && (
                  <span className="pending-tool-param">
                    {formatParamValue(pendingTool.reason, 32).short}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        <div className={`collapse-arrow ${isCollapsed ? 'collapsed' : ''}`}>
          <div className="arrow-icon"></div>
        </div>
      </div>

      <div
        className={`domain-box-content ${isCollapsed ? 'collapsed' : ''}`}
        ref={domainBoxContentRef}
      >
        {/* Task Description */}
        <div className="task-description">
          <div className="task-label">Task:</div>
          <div className="task-text">{taskDescription}</div>
        </div>

        {/* Active Context Display */}
        {currentContext && (
          <div className="context-display">
            <div
              className="context-header"
              onClick={() => setExpandedContext(!expandedContext)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  setExpandedContext(!expandedContext);
                }
              }}
            >
              <span className="context-label">Active Context</span>
              <span className="context-info">
                {currentContext.context_size} tokens
              </span>
              <div className={`section-collapse-arrow ${expandedContext ? '' : 'collapsed'}`}>
                <div className="arrow-icon"></div>
              </div>
            </div>
            {expandedContext && (
              <div className="context-content">
                <div className="context-controls">
                  <button
                    className={`context-toggle ${showRawContext ? 'active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowRawContext(!showRawContext);
                    }}
                    title="Toggle raw JSON"
                  >
                    {'{}'}
                  </button>
                </div>
                {showRawContext && currentContext.full_context ? (
                  <pre className="context-raw">
                    {JSON.stringify(currentContext.full_context, null, 2)}
                  </pre>
                ) : (
                  <div className="context-summary">
                    <div className="context-item">
                      <span className="context-key">Summary:</span>
                      <span className="context-value">{currentContext.summary}</span>
                    </div>
                    <div className="context-item">
                      <span className="context-key">Updated:</span>
                      <span className="context-value">
                        {new Date(currentContext.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Execution Plan */}
        {plan && (
          <div className="execution-plan">
            <div className="plan-header">
              <span className="plan-label">Execution Plan</span>
              <span className="plan-progress">
                {plan.steps.filter((s) => s.status === 'completed').length} / {plan.steps.length}
              </span>
            </div>
            <div className="plan-steps">
              {plan.steps.map((step, index) => (
                <div key={step.step_id} className={`plan-step ${getStepStatusClass(step.status)}`}>
                  <div className="step-indicator">
                    <div className="step-number">{index + 1}</div>
                    <div className={`step-status-icon ${step.status}`}>
                      {step.status === 'completed' && '✓'}
                      {step.status === 'failed' && '✗'}
                      {step.status === 'in_progress' && '⋯'}
                    </div>
                  </div>
                  <div className="step-content">
                    <div className="step-description">{step.description}</div>
                    {step.result && <div className="step-result">{step.result}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Action Flow Graph */}
        <div className="action-flow">
          <div
            className="flow-header"
            onClick={() => setIsActionFlowCollapsed(!isActionFlowCollapsed)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                setIsActionFlowCollapsed(!isActionFlowCollapsed);
              }
            }}
          >
            <span className="flow-label">Action Flow</span>
            <span className="flow-count">{actions.length} actions</span>
            <div className={`section-collapse-arrow ${isActionFlowCollapsed ? 'collapsed' : ''}`}>
              <div className="arrow-icon"></div>
            </div>
          </div>
          <div className={`flow-graph ${isActionFlowCollapsed ? 'collapsed' : ''}`}>
            {actions.map((action, index) => {
              const metadata = action.metadata || {};
              const toolName = typeof metadata.tool === 'string' ? metadata.tool : undefined;
              const callId = typeof metadata.call_id === 'string' ? metadata.call_id : undefined;
              const paramSummary = buildParamChips(metadata.params, 3);
              const ToolIconComponent = toolName ? getToolIconForName(toolName) : undefined;
              const statusLabel = getStatusLabel(action.status);
              const timestampDisplay = formatTimestamp(action.timestamp);
              const timestampTitle = (() => {
                const date = new Date(action.timestamp);
                return Number.isNaN(date.getTime()) ? action.timestamp : date.toLocaleString();
              })();
              const resultSummary = summarizeResult(action.result, 160);
              const formattedType = formatActionType(action.action_type);
              const shortCallId = getShortCallId(callId);

              return (
                <div key={action.action_id} className="action-node-wrapper">
                  <div
                    className={`action-node ${getActionStatusClass(action.status)} ${
                      selectedAction === action.action_id ? 'selected' : ''
                    }`}
                    onClick={() =>
                      setSelectedAction(selectedAction === action.action_id ? null : action.action_id)
                    }
                  >
                    <div className="node-indicator">
                      <div className={`node-dot ${action.status}`}></div>
                    </div>
                    <div className="node-content">
                      <div className="node-header">
                        <div className="node-title">
                          {ToolIconComponent && (
                            <ToolIconComponent className="node-tool-icon" />
                          )}
                          <span className="node-type">{formattedType}</span>
                          {toolName && <span className="node-tool-name">{toolName}</span>}
                        </div>
                        <div className="node-badges">
                          {callId && (
                            <span className="node-call-id" title={`Call ID ${callId}`}>
                              {shortCallId}
                            </span>
                          )}
                          <span className={`node-status-badge ${action.status}`}>
                            {statusLabel}
                          </span>
                          <span className="node-timestamp" title={timestampTitle}>
                            {timestampDisplay}
                          </span>
                        </div>
                      </div>
                      <div className="node-description">{action.description}</div>
                      {paramSummary.chips.length > 0 && (
                        <div className="node-params">
                          {paramSummary.chips.map((chip, chipIndex) => (
                            <span
                              key={`${action.action_id}-param-${chip.name}-${chipIndex}`}
                              className="node-param-chip"
                              title={`${chip.name}=${chip.fullValue}`}
                            >
                              <span className="param-name">{chip.name}</span>
                              <span className="param-value">{chip.shortValue}</span>
                            </span>
                          ))}
                          {paramSummary.remaining > 0 && (
                            <span
                              className="node-param-chip more"
                              title={`+${paramSummary.remaining} more parameter(s)`}
                            >
                              +{paramSummary.remaining} more
                            </span>
                          )}
                        </div>
                      )}
                      {resultSummary && (
                        <div className="node-result" title={resultSummary.full}>
                          {resultSummary.short}
                        </div>
                      )}
                    </div>
                  </div>
                  {selectedAction === action.action_id && action.result && (
                    <div className="action-details">
                      <div className="details-content">
                        {typeof action.result === 'string' ? (
                          <div>{action.result}</div>
                        ) : (
                          <pre>{JSON.stringify(action.result, null, 2)}</pre>
                        )}
                      </div>
                    </div>
                  )}
                  {index < actions.length - 1 && (
                    <div className="flow-connector">
                      <div className="connector-line"></div>
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={actionsEndRef} />
          </div>
        </div>

        {isCoderDomain && coderFileOperations.length > 0 && (
          <div className="coder-ops-card">
            <div className="coder-ops-header">
              <Icons.FileCode className="coder-ops-icon" />
              <div className="coder-ops-header-copy">
                <div className="coder-ops-title">File Operations</div>
                <div className="coder-ops-subtitle">
                  {coderFileOperations.length} change{coderFileOperations.length !== 1 ? 's' : ''}
                  {(coderFileOperationTotals.added > 0 || coderFileOperationTotals.removed > 0) && (
                    <span className="coder-ops-subtitle-diff">
                      {coderFileOperationTotals.added > 0 && (
                        <span className="diff-pill added">+{coderFileOperationTotals.added}</span>
                      )}
                      {coderFileOperationTotals.removed > 0 && (
                        <span className="diff-pill removed">-{coderFileOperationTotals.removed}</span>
                      )}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <ul className="coder-ops-list">
              {coderFileOperations.map((operation, index) => {
                const linesAdded = getLinesAdded(operation);
                const linesRemoved = getLinesRemoved(operation);
                const operationPath = operation.path || operation.absolute_path || 'Unknown path';

                return (
                  <li key={`${operation.callId}-${operationPath}-${index}`} className="coder-ops-entry">
                    <div className="coder-ops-entry-main">
                      <span className="coder-ops-path" title={operationPath}>
                        {operationPath}
                      </span>
                      <div className="coder-ops-diff">
                        {linesAdded > 0 && <span className="diff-pill added">+{linesAdded}</span>}
                        {linesRemoved > 0 && <span className="diff-pill removed">-{linesRemoved}</span>}
                        {linesAdded === 0 && linesRemoved === 0 && (
                          <span className="diff-pill neutral">No delta</span>
                        )}
                      </div>
                    </div>
                    <div className="coder-ops-meta">
                      <span className="coder-ops-meta-item">
                        {formatOperationType(operation.type)} via {operation.tool}
                      </span>
                      <span className="coder-ops-meta-item">Call {formatCallId(operation.callId)}</span>
                      <span className="coder-ops-meta-item">{formatTimestampCompact(operation.executedAt)}</span>
                    </div>
                    <div className="coder-ops-checkpoints">
                      {renderCheckpointChip('before', operation)}
                      {renderCheckpointChip('after', operation)}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {toolHistory.length > 0 && (
          <div className="tool-history">
            <div
              className="tool-history-header"
              onClick={() => setIsToolHistoryCollapsed(!isToolHistoryCollapsed)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  setIsToolHistoryCollapsed(!isToolHistoryCollapsed);
                }
              }}
            >
              <span className="tool-history-label">Tool History</span>
              <span className="tool-history-count">
                {toolHistory.length} call{toolHistory.length !== 1 ? 's' : ''}
              </span>
              <div className={`section-collapse-arrow ${isToolHistoryCollapsed ? 'collapsed' : ''}`}>
                <div className="arrow-icon"></div>
              </div>
            </div>
            <div className={`tool-history-list ${isToolHistoryCollapsed ? 'collapsed' : ''}`}>
              {toolHistory.map((entry) => {
                const ToolHistoryIcon = getToolIconForName(entry.tool);
                const paramSummary = buildParamChips(entry.params, 2);
                const statusClass = entry.accepted ? 'accepted' : 'rejected';
                const resultSummary = summarizeResult(entry.result_summary, 120);
                const callIdDisplay = getShortCallId(entry.call_id);
                const timestampDisplay = formatTimestamp(entry.executed_at);
                const timestampTitle = (() => {
                  const date = new Date(entry.executed_at);
                  return Number.isNaN(date.getTime()) ? entry.executed_at : date.toLocaleString();
                })();
                const operationsForEntry = coderOpsByCallId.get(entry.call_id) ?? [];

                return (
                  <div key={entry.call_id} className={`tool-history-item ${statusClass}`}>
                    <div className="tool-history-icon">
                      <ToolHistoryIcon className="tool-icon" />
                    </div>
                    <div className="tool-history-body">
                      <div className="tool-history-title">
                        <span className="tool-history-tool">{entry.tool}</span>
                        <span className={`tool-history-status ${statusClass}`}>
                          {entry.accepted ? 'Accepted' : 'Rejected'}
                        </span>
                      </div>
                      <div className="tool-history-meta">
                        <span className="tool-history-call-id" title={`Call ID ${entry.call_id}`}>
                          {callIdDisplay}
                        </span>
                        <span className="tool-history-time" title={timestampTitle}>
                          {timestampDisplay}
                        </span>
                      </div>
                      {paramSummary.chips.length > 0 && (
                        <div className="tool-history-params">
                          {paramSummary.chips.map((chip, chipIndex) => (
                            <span
                              key={`${entry.call_id}-history-param-${chip.name}-${chipIndex}`}
                              className="tool-history-param"
                              title={`${chip.name}=${chip.fullValue}`}
                            >
                              <span className="param-name">{chip.name}</span>
                              <span className="param-value">{chip.shortValue}</span>
                            </span>
                          ))}
                          {paramSummary.remaining > 0 && (
                            <span
                              className="tool-history-param more"
                              title={`+${paramSummary.remaining} more parameter(s)`}
                            >
                              +{paramSummary.remaining} more
                            </span>
                          )}
                        </div>
                      )}
                      {resultSummary && (
                        <div className="tool-history-result" title={resultSummary.full}>
                          {resultSummary.short}
                        </div>
                      )}
                      {isCoderDomain && operationsForEntry.length > 0 && (
                        <div className="tool-history-ops">
                          {operationsForEntry.map((operation, opIndex) => {
                            const linesAddedOp = getLinesAdded(operation);
                            const linesRemovedOp = getLinesRemoved(operation);
                            const operationPath = operation.path || operation.absolute_path || 'Unknown path';

                            return (
                              <div key={`${entry.call_id}-file-op-${opIndex}`} className="tool-history-op">
                                <div className="tool-history-op-header">
                                  <span className="tool-history-op-path" title={operationPath}>
                                    {operationPath}
                                  </span>
                                  <div className="tool-history-op-diff">
                                    {linesAddedOp > 0 && <span className="diff-pill added">+{linesAddedOp}</span>}
                                    {linesRemovedOp > 0 && <span className="diff-pill removed">-{linesRemovedOp}</span>}
                                    {linesAddedOp === 0 && linesRemovedOp === 0 && (
                                      <span className="diff-pill neutral">No delta</span>
                                    )}
                                  </div>
                                </div>
                                <div className="tool-history-op-footnote">
                                  <span className="tool-history-op-kind">{formatOperationType(operation.type)}</span>
                                  <div className="tool-history-op-checkpoints">
                                    {renderCheckpointChip('before', operation)}
                                    {renderCheckpointChip('after', operation)}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Tool Approval - appears after action flow */}
        {pendingTool && isWaitingForUser && showApprovalUI && (
          <div className="domain-tool-approval">
            <div className="domain-tool-approval-header">
              <div className="tool-approval-heading">Tool Approval Required</div>
              <div className="tool-approval-subheading">Call ID: {pendingTool.call_id}</div>
            </div>
            <div className="tool-approval-body">
              <div className="tool-approval-name">{pendingTool.tool}</div>
              {pendingTool.tool_description && (
                <div className="tool-approval-description">{pendingTool.tool_description}</div>
              )}
              {domainExecution?.agent_message && (
                <div className="tool-approval-message">
                  <span className="label">Agent:</span>
                  <span>{domainExecution.agent_message}</span>
                </div>
              )}
              <div className="tool-approval-reason">
                <span className="label">Reason:</span>
                <span>{pendingTool.reason || 'No reason provided'}</span>
              </div>
              <div className="tool-approval-params">
                <span className="label">Parameters:</span>
                <ul>
                  {pendingTool.params.map(([name, value]) => (
                    <li key={name}>
                      <span className="param-name">{name}</span>
                      <span className="param-value">
                        {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {decisionError && (
              <div className="domain-tool-approval-error" role="alert">
                {decisionError}
              </div>
            )}
            <div className="domain-tool-approval-actions">
              <button
                type="button"
                className={`approval-button approve ${confirmedDecision === 'accept' ? 'confirmed' : ''}`}
                onClick={() => handleToolDecision('accept')}
                disabled={decisionState !== 'idle'}
              >
                {decisionState === 'accepting' ? 'Accepting…' : 'Accept'}
              </button>
              <button
                type="button"
                className={`approval-button reject ${confirmedDecision === 'reject' ? 'confirmed' : ''}`}
                onClick={() => handleToolDecision('reject')}
                disabled={decisionState !== 'idle'}
              >
                {decisionState === 'rejecting' ? 'Rejecting…' : 'Reject'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DomainBox;
