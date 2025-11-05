import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Icons } from '../ui/Icons';
import { IterationContainer } from './IterationContainer';
import type { DomainExecution, ToolOperation } from '../../types/messages';
import type { CoderStreamSegment } from '../../utils/chat/LiveStore';
import { apiUrl } from '../../config/api';
import '../../styles/coder/ExecutionActivityFeed.css';

interface ExecutionActivityFeedProps {
  domainExecution: DomainExecution | null;
  coderStream: CoderStreamSegment[];
  isProcessing?: boolean;
  chatId?: string;
  autoAcceptEnabled?: boolean;
}

type ToolCallSegment = Extract<CoderStreamSegment, { type: 'tool_call' }>;
type PendingTool = NonNullable<DomainExecution['pending_tools']>[number];
type ToolExecutionRecord = NonNullable<DomainExecution['tool_history']>[number];

interface IterationGroup {
  number: number;
  thoughts?: Extract<CoderStreamSegment, { type: 'thoughts' }>;
  response?: Extract<CoderStreamSegment, { type: 'agent_response' }>;
  toolCalls: ToolCallSegment[];
  executedTools: ToolExecutionRecord[];
  status: 'streaming' | 'waiting_user' | 'executing' | 'completed';
  summary: string;
}

const getToolIcon = (toolName?: string) => {
  if (!toolName) return Icons.Info;
  const lower = toolName.toLowerCase();
  if (lower.includes('file') || lower.includes('edit') || lower.includes('write')) {
    return Icons.FileCode;
  }
  if (lower.includes('bash') || lower.includes('terminal') || lower.includes('cmd')) {
    return Icons.Terminal;
  }
  if (lower.includes('git')) {
    return Icons.History;
  }
  if (lower.includes('test')) {
    return Icons.Check;
  }
  return Icons.Info;
};

const formatTimestamp = (isoString: string): string => {
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const getStatusColor = (status: string): string => {
  switch (status) {
    case 'completed':
      return 'text-green-400';
    case 'failed':
      return 'text-red-400';
    case 'in_progress':
      return 'text-blue-400';
    default:
      return 'text-gray-400';
  }
};

const generateIterationSummary = (group: IterationGroup): string => {
  const toolCount = group.executedTools.length;
  const toolCallCount = group.toolCalls.length;

  if (toolCount === 0 && toolCallCount > 0) {
    // Tools proposed but not executed yet
    return `Proposed ${toolCallCount} tool${toolCallCount !== 1 ? 's' : ''}`;
  }

  if (toolCount === 0) {
    return 'Thinking...';
  }

  // Calculate stats from executed tools
  let totalAdded = 0;
  let totalRemoved = 0;
  const toolNames = new Set<string>();

  for (const tool of group.executedTools) {
    toolNames.add(tool.tool);
    if (tool.ops) {
      for (const op of tool.ops) {
        if (op.lines_added !== undefined) totalAdded += op.lines_added;
        if (op.lines_removed !== undefined) totalRemoved += op.lines_removed;
      }
    }
  }

  const toolSummary = Array.from(toolNames).slice(0, 2).join(', ');
  const moreSuffix = toolNames.size > 2 ? ` +${toolNames.size - 2} more` : '';

  if (totalAdded > 0 || totalRemoved > 0) {
    return `✅ ${toolSummary}${moreSuffix} (+${totalAdded}, -${totalRemoved})`;
  }

  return `✅ ${toolCount} tool${toolCount !== 1 ? 's' : ''} executed`;
};

const truncate = (value: string, maxLength = 80) => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
};

const normalizeParamValue = (value: any, maxLength = 100) => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return truncate(value, maxLength);
  }
  try {
    return truncate(JSON.stringify(value), maxLength);
  } catch {
    return truncate(String(value), maxLength);
  }
};

interface ToolProposalCardProps {
  segment: ToolCallSegment;
  pendingTool?: PendingTool;
  chatId?: string;
  taskId?: string;
  autoAcceptEnabled?: boolean;
  isWaitingForUser: boolean;
  isFirstPending: boolean;
  totalPending: number;
  isExecuting: boolean;
  isCompleted: boolean;
  onDecision: (callId: string) => void;
}

const ToolProposalCard: React.FC<ToolProposalCardProps> = ({
  segment,
  pendingTool,
  chatId,
  taskId,
  autoAcceptEnabled = false,
  isWaitingForUser,
  isFirstPending,
  totalPending,
  isExecuting,
  isCompleted,
  onDecision,
}) => {
  // All hooks must be called before any conditional returns
  const [decisionState, setDecisionState] = useState<'idle' | 'accepting' | 'rejecting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const autoAcceptMarker = useRef<string | null>(null);

  const hasPending = Boolean(pendingTool && chatId && taskId);
  const callId = pendingTool?.call_id ?? null;

  const submitDecision = useCallback(async (decision: 'accept' | 'reject', batchMode: boolean) => {
    if (!chatId || !taskId) return;
    if (!batchMode && !callId) return;

    // Optimistically update UI immediately
    if (decision === 'accept' && callId) {
      onDecision(callId);
    }

    const pendingState = decision === 'accept' ? 'accepting' : 'rejecting';
    setDecisionState(pendingState);
    setError(null);

    try {
      const target = batchMode ? 'batch_all' : callId!;
      const response = await fetch(apiUrl(`/api/chats/${chatId}/domain/${taskId}/tool/${target}/decision`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          batch_mode: batchMode,
          assistant_message_id: null,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || `Failed to ${decision} tool${batchMode && totalPending > 1 ? 's' : ''}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDecisionState('idle');
    }
  }, [chatId, taskId, callId, totalPending, onDecision]);

  useEffect(() => {
    if (!autoAcceptEnabled || !hasPending || !isWaitingForUser || decisionState !== 'idle') {
      return;
    }

    const marker = callId || 'batch_all';
    if (autoAcceptMarker.current === marker) {
      return;
    }

    autoAcceptMarker.current = marker;
    submitDecision('accept', totalPending > 1);
  }, [autoAcceptEnabled, hasPending, isWaitingForUser, decisionState, callId, totalPending, submitDecision]);

  const displayTool = pendingTool?.tool || segment.tool || 'Tool proposal';
  const displayReason = pendingTool?.reason || segment.reason || '';
  const displayDescription = pendingTool?.tool_description || '';
  const streaming = segment.status === 'streaming' && !pendingTool;
  const disableActions = !hasPending || !isWaitingForUser || decisionState !== 'idle';

  const params = useMemo(() => {
    if (pendingTool?.params && pendingTool.params.length > 0) {
      return pendingTool.params.map(([key, value]) => ({
        name: key,
        value: normalizeParamValue(value),
      }));
    }
    return segment.params.map(({ name, value }) => ({
      name,
      value: normalizeParamValue(value),
    }));
  }, [pendingTool?.params, segment.params]);

  // Conditional returns after all hooks
  if (isExecuting && !isCompleted) {
    return (
      <div className="exec-activity-feed__stream-card exec-activity-feed__stream-card--executing">
        <div className="exec-activity-feed__stream-header">
          <Icons.Activity className="w-4 h-4 text-blue-400 animate-spin" />
          <div className="exec-activity-feed__stream-header-text">
            <span>Executing Tool · Iteration {segment.iteration}</span>
            <span className="exec-activity-feed__stream-subtitle">{segment.tool || pendingTool?.tool || 'Tool'}</span>
          </div>
          <span className="exec-activity-feed__stream-pill exec-activity-feed__stream-pill--executing">Executing...</span>
        </div>
      </div>
    );
  }

  if (isCompleted) {
    return null;
  }

  return (
    <div className="exec-activity-feed__stream-card exec-activity-feed__stream-card--tool">
      <div className="exec-activity-feed__stream-header">
        <Icons.Activity className="w-4 h-4 text-amber-300" />
        <div className="exec-activity-feed__stream-header-text">
          <span>Tool Proposal · Iteration {segment.iteration}</span>
          <span className="exec-activity-feed__stream-subtitle">{displayTool}</span>
        </div>
        {streaming && <span className="exec-activity-feed__stream-pill">Streaming</span>}
        {!streaming && isWaitingForUser && <span className="exec-activity-feed__stream-pill exec-activity-feed__stream-pill--pending">Awaiting decision</span>}
      </div>

      <div className="exec-activity-feed__stream-body">
        {displayReason && (
          <div className="exec-activity-feed__stream-section">
            <p className="exec-activity-feed__stream-label">Reason</p>
            <p className="exec-activity-feed__stream-text">{displayReason}</p>
          </div>
        )}
        {displayDescription && (
          <div className="exec-activity-feed__stream-section">
            <p className="exec-activity-feed__stream-label">Description</p>
            <p className="exec-activity-feed__stream-text">{displayDescription}</p>
          </div>
        )}
        {params.length > 0 && (
          <div className="exec-activity-feed__stream-section">
            <p className="exec-activity-feed__stream-label">Parameters</p>
            <div className="exec-activity-feed__stream-params">
              {params.map(param => (
                <div key={`${segment.id}-${param.name}-${param.value}`} className="exec-activity-feed__param">
                  <span className="exec-activity-feed__param-key">{param.name}</span>
                  <span className="exec-activity-feed__param-value">{param.value || '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {isWaitingForUser && (
        <div className="exec-activity-feed__tool-actions">
          <button
            type="button"
            className="exec-activity-feed__tool-button exec-activity-feed__tool-button--accept"
            onClick={() => submitDecision('accept', false)}
            disabled={disableActions}
          >
            {decisionState === 'accepting' ? 'Accepting…' : 'Accept'}
          </button>
          <button
            type="button"
            className="exec-activity-feed__tool-button exec-activity-feed__tool-button--reject"
            onClick={() => submitDecision('reject', false)}
            disabled={disableActions}
          >
            {decisionState === 'rejecting' ? 'Rejecting…' : 'Reject'}
          </button>
          {totalPending > 1 && isFirstPending && (
            <>
              <button
                type="button"
                className="exec-activity-feed__tool-button exec-activity-feed__tool-button--accept-all"
                onClick={() => submitDecision('accept', true)}
                disabled={disableActions}
              >
                {decisionState === 'accepting' ? 'Accepting…' : `Accept All (${totalPending})`}
              </button>
              <button
                type="button"
                className="exec-activity-feed__tool-button exec-activity-feed__tool-button--reject-all"
                onClick={() => submitDecision('reject', true)}
                disabled={disableActions}
              >
                {decisionState === 'rejecting' ? 'Rejecting…' : `Reject All (${totalPending})`}
              </button>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="exec-activity-feed__tool-error">
          <Icons.Info className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};

export const ExecutionActivityFeed: React.FC<ExecutionActivityFeedProps> = ({
  domainExecution,
  coderStream,
  isProcessing = false,
  chatId,
  autoAcceptEnabled = false,
}) => {
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [executingTools, setExecutingTools] = useState<Set<string>>(new Set());
  const [completedToolsFromExecution, setCompletedToolsFromExecution] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((id: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Track when tools complete execution via domain_execution updates
  useEffect(() => {
    if (!domainExecution?.tool_history) return;

    const completedCallIds = new Set(domainExecution.tool_history.map(t => t.call_id));

    // Remove from executing set if now in tool_history
    setExecutingTools(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const callId of Array.from(prev)) {
        if (completedCallIds.has(callId)) {
          next.delete(callId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    setCompletedToolsFromExecution(completedCallIds);
  }, [domainExecution?.tool_history]);

  const handleToolDecision = useCallback((callId: string) => {
    // Optimistically add to executing set to hide proposal immediately
    setExecutingTools(prev => new Set(prev).add(callId));
  }, []);

  // Extract all data before any conditional returns (hooks must be called unconditionally)
  const actions = domainExecution?.actions ?? [];
  const toolHistory = useMemo(() => domainExecution?.tool_history ?? [], [domainExecution?.tool_history]);
  const plan = domainExecution?.plan;
  const taskId = domainExecution?.task_id;
  const currentIterationNumber = domainExecution?.metadata?.iterations ?? null;
  const pendingTools = useMemo(() => domainExecution?.pending_tools ?? [], [domainExecution?.pending_tools]);
  const isWaitingForUser = domainExecution?.status === 'waiting_user';

  // Group streaming segments and tool history by iteration
  const iterationGroups = useMemo((): IterationGroup[] => {
    const groups = new Map<number, IterationGroup>();

    // Group coderStream segments by iteration
    for (const segment of coderStream) {
      if (!groups.has(segment.iteration)) {
        groups.set(segment.iteration, {
          number: segment.iteration,
          toolCalls: [],
          executedTools: [],
          status: 'streaming',
          summary: '',
        });
      }

      const group = groups.get(segment.iteration)!;

      if (segment.type === 'thoughts') {
        group.thoughts = segment;
      } else if (segment.type === 'agent_response') {
        group.response = segment;
      } else if (segment.type === 'tool_call') {
        group.toolCalls.push(segment);
      }
    }

    // Match tool_history items to iterations
    // Strategy: Match by tool name and approximate sequential order
    const sortedHistory = [...toolHistory].sort((a, b) =>
      new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime()
    );

    for (const executedTool of sortedHistory) {
      // Find matching iteration by tool name
      let matched = false;

      for (const [, group] of Array.from(groups.entries()).sort((a, b) => a[0] - b[0])) {
        const matchingToolCall = group.toolCalls.find(tc =>
          tc.tool === executedTool.tool &&
          !group.executedTools.some(et => et.call_id === executedTool.call_id)
        );

        if (matchingToolCall) {
          group.executedTools.push(executedTool);
          matched = true;
          break;
        }
      }

      // If no match found, add to the earliest iteration with tool calls
      if (!matched && groups.size > 0) {
        const firstGroupWithTools = Array.from(groups.values()).find(g => g.toolCalls.length > 0);
        if (firstGroupWithTools) {
          firstGroupWithTools.executedTools.push(executedTool);
        }
      }
    }

    // Determine status for each iteration
    for (const group of Array.from(groups.values())) {
      const isCurrentIter = currentIterationNumber !== null && group.number === currentIterationNumber;
      const hasStreamingSegment =
        (group.thoughts?.status === 'streaming') ||
        (group.response?.status === 'streaming') ||
        group.toolCalls.some((tc: ToolCallSegment) => tc.status === 'streaming');

      if (isCurrentIter) {
        if (isWaitingForUser && pendingTools.length > 0) {
          group.status = 'waiting_user';
        } else if (hasStreamingSegment) {
          group.status = 'streaming';
        } else if (group.toolCalls.length > 0 && group.executedTools.length === 0) {
          group.status = 'executing';
        } else {
          group.status = 'executing';
        }
      } else {
        group.status = 'completed';
      }

      // Generate summary
      group.summary = generateIterationSummary(group);
    }

    // Sort by iteration number (oldest first = chronological order)
    return Array.from(groups.values()).sort((a, b) => a.number - b.number);
  }, [coderStream, toolHistory, currentIterationNumber, isWaitingForUser, pendingTools]);

  // Early return check after all hooks
  const hasStream = coderStream.length > 0;
  if (!domainExecution && !hasStream) {
    return (
      <div className="exec-activity-feed__empty">
        <Icons.Activity className="w-12 h-12 opacity-30" />
        <p className="text-sm text-white/60 mt-4">No execution activity yet</p>
        <p className="text-xs text-white/40 mt-2">
          Agent thoughts, responses, and tool calls will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="exec-activity-feed">
      <div className="exec-activity-feed__stream">
        {/* Render iterations in chronological order (oldest first) */}
        {iterationGroups.map((group) => {
          const isCurrentIter = currentIterationNumber !== null && group.number === currentIterationNumber;

          return (
            <IterationContainer
              key={group.number}
              iterationNumber={group.number}
              isCurrentIteration={isCurrentIter}
              status={group.status}
              summary={group.summary}
            >
              {/* Agent Thoughts */}
              {group.thoughts && (
                <div className="exec-activity-feed__stream-card exec-activity-feed__stream-card--thoughts">
                  <div className="exec-activity-feed__stream-header">
                    <Icons.Lightbulb className="w-4 h-4 text-sky-300" />
                    <div className="exec-activity-feed__stream-header-text">
                      <span>Agent Thoughts</span>
                    </div>
                    {group.thoughts.status === 'streaming' && <span className="exec-activity-feed__stream-pill">Streaming</span>}
                  </div>
                  <pre className="exec-activity-feed__stream-text">
                    {group.thoughts.text || (group.thoughts.status === 'complete' ? 'No reasoning shared.' : 'Gathering thoughts...')}
                  </pre>
                </div>
              )}

              {/* Agent Response */}
              {group.response && (
                <div className="exec-activity-feed__stream-card exec-activity-feed__stream-card--response">
                  <div className="exec-activity-feed__stream-header">
                    <Icons.Bot className="w-4 h-4 text-emerald-300" />
                    <div className="exec-activity-feed__stream-header-text">
                      <span>Agent Response</span>
                    </div>
                    {group.response.status === 'streaming' && <span className="exec-activity-feed__stream-pill">Streaming</span>}
                  </div>
                  <pre className="exec-activity-feed__stream-text">
                    {group.response.text || (group.response.status === 'complete' ? 'Agent response is empty.' : 'Composing response...')}
                  </pre>
                </div>
              )}

              {/* Tool Proposals */}
              {group.toolCalls.map((toolCall) => {
                const pendingTool = isCurrentIter ? pendingTools[toolCall.toolIndex] : undefined;
                const totalPending = isCurrentIter ? pendingTools.length : 0;
                const callId = pendingTool?.call_id;
                const isExecuting = callId ? executingTools.has(callId) : false;
                const isCompleted = callId ? completedToolsFromExecution.has(callId) : false;

                return (
                  <ToolProposalCard
                    key={toolCall.id}
                    segment={toolCall}
                    pendingTool={pendingTool}
                    chatId={chatId}
                    taskId={taskId}
                    autoAcceptEnabled={autoAcceptEnabled}
                    isWaitingForUser={Boolean(isWaitingForUser && isCurrentIter)}
                    isFirstPending={Boolean(isCurrentIter && toolCall.toolIndex === 0)}
                    totalPending={totalPending}
                    isExecuting={isExecuting}
                    isCompleted={isCompleted}
                    onDecision={handleToolDecision}
                  />
                );
              })}

              {/* Executed Tools Results */}
              {group.executedTools.map((executedTool) => (
                <div
                  key={executedTool.call_id}
                  className={`iteration-container__execution-result ${executedTool.error ? 'iteration-container__execution-error' : ''}`}
                >
                  <div className="iteration-container__execution-header">
                    {executedTool.error ? (
                      <Icons.Info className="w-4 h-4" />
                    ) : (
                      <Icons.Check className="w-4 h-4" />
                    )}
                    <span>Executed: {executedTool.tool}</span>
                  </div>
                  {executedTool.ops && executedTool.ops.length > 0 && (
                    <div className="iteration-container__execution-stats">
                      {executedTool.ops[0].path && (
                        <span>
                          <Icons.FileCode className="w-3 h-3" />
                          {executedTool.ops[0].path}
                        </span>
                      )}
                      {(executedTool.ops[0].lines_added !== undefined || executedTool.ops[0].lines_removed !== undefined) && (
                        <span>
                          <span className="text-green-400">+{executedTool.ops[0].lines_added || 0}</span>
                          {' / '}
                          <span className="text-red-400">-{executedTool.ops[0].lines_removed || 0}</span>
                        </span>
                      )}
                    </div>
                  )}
                  {executedTool.result_summary && (
                    <div className="iteration-container__execution-summary">
                      {executedTool.result_summary}
                    </div>
                  )}
                  {executedTool.error && (
                    <div className="iteration-container__execution-summary">
                      Error: {executedTool.error}
                    </div>
                  )}
                </div>
              ))}
            </IterationContainer>
          );
        })}

        {/* Show waiting state if tools executed but no new iteration yet */}
        {isWaitingForUser === false && pendingTools.length === 0 && domainExecution?.tool_history && domainExecution.tool_history.length > 0 && coderStream.length > 0 && (
          <div className="exec-activity-feed__waiting-state">
            <div className="exec-activity-feed__spinner" />
            <span className="text-sm text-white/60">Waiting for model response...</span>
          </div>
        )}

        {isProcessing && coderStream.length === 0 && (
          <div className="exec-activity-feed__processing-placeholder">
            <div className="exec-activity-feed__spinner" />
            <span className="text-sm text-white/60">Agent is preparing a response…</span>
          </div>
        )}
      </div>

      {plan && (
        <div className="exec-activity-feed__plan-box">
          <div className="exec-activity-feed__plan-header">
            <Icons.List className="w-4 h-4 text-blue-400" />
            <span className="exec-activity-feed__plan-title">
              Current Plan: {plan.task_description}
            </span>
          </div>
          <ul className="exec-activity-feed__plan-steps">
            {plan.steps.map((step, idx) => (
              <li key={step.step_id || idx} className="exec-activity-feed__plan-step">
                <span className={`exec-activity-feed__step-status ${getStatusColor(step.status)}`}>
                  {step.status === 'completed' && '✓'}
                  {step.status === 'in_progress' && '⟳'}
                  {step.status === 'pending' && '○'}
                  {step.status === 'failed' && '✗'}
                </span>
                <span className="exec-activity-feed__step-text">{step.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="exec-activity-feed__timeline">
        {actions.map((action, idx) => {
          const isExpanded = expandedItems.has(action.action_id);
          const ActionIcon = getToolIcon(action.action_type);

          return (
            <details
              key={action.action_id || idx}
              className="exec-activity-feed__item"
              open={isExpanded}
              onToggle={() => toggleExpanded(action.action_id)}
            >
              <summary className="exec-activity-feed__item-summary">
                <ActionIcon className={`w-4 h-4 ${getStatusColor(action.status)}`} />
                <div className="exec-activity-feed__item-info">
                  <span className="exec-activity-feed__item-title">{action.description}</span>
                  {action.timestamp && (
                    <span className="exec-activity-feed__item-time">
                      {formatTimestamp(action.timestamp)}
                    </span>
                  )}
                </div>
                <Icons.ChevronRight className={`exec-activity-feed__chevron ${isExpanded ? 'exec-activity-feed__chevron--expanded' : ''}`} />
              </summary>
              {action.result && (
                <div className="exec-activity-feed__item-content">
                  <pre className="exec-activity-feed__result">
                    {typeof action.result === 'string'
                      ? action.result
                      : JSON.stringify(action.result, null, 2)}
                  </pre>
                </div>
              )}
            </details>
          );
        })}

        {toolHistory.map((tool, idx) => {
          const isExpanded = expandedItems.has(tool.call_id);
          const ToolIcon = getToolIcon(tool.tool);
          const hasOps = tool.ops && tool.ops.length > 0;

          return (
            <details
              key={tool.call_id || idx}
              className="exec-activity-feed__item"
              open={isExpanded}
              onToggle={() => toggleExpanded(tool.call_id)}
            >
              <summary className="exec-activity-feed__item-summary">
                <ToolIcon className="w-4 h-4 text-sky-400" />
                <div className="exec-activity-feed__item-info">
                  <span className="exec-activity-feed__item-title">
                    {tool.tool}
                    {hasOps && tool.ops?.[0]?.path && `: ${tool.ops[0].path}`}
                  </span>
                  {tool.executed_at && (
                    <span className="exec-activity-feed__item-time">
                      {formatTimestamp(tool.executed_at)}
                    </span>
                  )}
                </div>
                <Icons.ChevronRight className={`exec-activity-feed__chevron ${isExpanded ? 'exec-activity-feed__chevron--expanded' : ''}`} />
              </summary>
              <div className="exec-activity-feed__item-content">
                {tool.params && tool.params.length > 0 && (
                  <div className="exec-activity-feed__section">
                    <p className="exec-activity-feed__section-label">PARAMETERS:</p>
                    <div className="exec-activity-feed__params">
                      {tool.params.slice(0, 3).map(([key, value], i) => (
                        <div key={i} className="exec-activity-feed__param">
                          <span className="exec-activity-feed__param-key">{key}:</span>
                          <span className="exec-activity-feed__param-value">
                            {typeof value === 'string' && value.length > 50
                              ? `${value.slice(0, 50)}...`
                              : String(value)}
                          </span>
                        </div>
                      ))}
                      {tool.params.length > 3 && (
                        <div className="exec-activity-feed__param-more">
                          +{tool.params.length - 3} more parameter{tool.params.length - 3 !== 1 ? 's' : ''}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {hasOps && (
                  <div className="exec-activity-feed__section">
                    <p className="exec-activity-feed__section-label">CHANGES:</p>
                    {tool.ops?.map((op: ToolOperation, i: number) => (
                      <div key={i} className="exec-activity-feed__changes">
                        {op.lines_added !== undefined && op.lines_removed !== undefined && (
                          <p className="exec-activity-feed__change-stats">
                            <span className="text-green-400">+{op.lines_added}</span>{' '}
                            <span className="text-red-400">-{op.lines_removed}</span> lines
                          </p>
                        )}
                        {op.before_checkpoint_id && (
                          <p className="exec-activity-feed__checkpoint-info">
                            Checkpoint #{op.before_checkpoint_id} created
                          </p>
                        )}
                        {op.after_checkpoint_id && (
                          <p className="exec-activity-feed__checkpoint-info">
                            Checkpoint #{op.after_checkpoint_id} saved
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {tool.result_summary && (
                  <div className="exec-activity-feed__section">
                    <p className="exec-activity-feed__section-label">RESULT:</p>
                    <pre className="exec-activity-feed__result">{tool.result_summary}</pre>
                  </div>
                )}

                {tool.error && (
                  <div className="exec-activity-feed__section">
                    <p className="exec-activity-feed__section-label text-red-400">ERROR:</p>
                    <pre className="exec-activity-feed__result text-red-300">{tool.error}</pre>
                  </div>
                )}
              </div>
            </details>
          );
        })}
      </div>

      {isProcessing && (
        <div className="exec-activity-feed__processing">
          <div className="exec-activity-feed__spinner" />
          <span className="text-sm text-white/60">Processing...</span>
        </div>
      )}
    </div>
  );
};
