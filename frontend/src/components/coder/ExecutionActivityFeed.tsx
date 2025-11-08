import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Icons } from '../ui/Icons';
import { IterationContainer } from './IterationContainer';
import type { DomainExecution } from '../../types/messages';
import type { CoderStreamSegment } from '../../utils/chat/LiveStore';
import { apiUrl } from '../../config/api';
import logger from '../../utils/core/logger';
import '../../styles/coder/ExecutionActivityFeed.css';
import { getBufferText } from '../../utils/text/ChunkedTextBuffer';

const getStreamText = (segment?: Extract<CoderStreamSegment, { type: 'thoughts' | 'agent_response' }>) => {
  if (!segment) {
    return '';
  }
  return segment.text ?? getBufferText(segment.buffer);
};

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
  domainExecution: DomainExecution | null;
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
  domainExecution,
}) => {
  // All hooks must be called before any conditional returns
  const [decisionState, setDecisionState] = useState<'idle' | 'accepting' | 'rejecting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const autoAcceptMarker = useRef<string | null>(null);

  const hasPending = Boolean(pendingTool && chatId && taskId);
  const callId = pendingTool?.call_id ?? null;

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

  const submitDecision = useCallback(async (decision: 'accept' | 'reject', batchMode: boolean) => {
    if (!chatId || !taskId) return;
    if (!batchMode && !callId) return;

    // Optimistically update UI immediately
    if (decision === 'accept' && callId) {
      onDecision(callId);

      // Clear decorations for accepted file operations
      const toolName = pendingTool?.tool || segment.tool;
      if (toolName === 'file.write' || toolName === 'file.edit') {
        const filePathParam = params.find(p => p.name === 'file_path');
        if (filePathParam?.value) {
          logger.info('[TOOL-ACCEPT] Dispatching clear decorations event for', filePathParam.value);
          window.dispatchEvent(new CustomEvent('clearFileDecorations', {
            detail: { file_path: filePathParam.value }
          }));
        }
      }
    }

    const pendingState = decision === 'accept' ? 'accepting' : 'rejecting';
    setDecisionState(pendingState);
    setError(null);

    try {
      const target = batchMode ? 'batch_all' : callId!;

      logger.info(`[APPROVAL] Preparing ${decision} for ${batchMode ? totalPending : 1} tool(s)`);

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
  }, [chatId, taskId, callId, totalPending, onDecision, pendingTool, segment, params]);

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
  const [executingTools, setExecutingTools] = useState<Set<string>>(new Set());
  const [completedToolsFromExecution, setCompletedToolsFromExecution] = useState<Set<string>>(new Set());

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
  const toolHistory = useMemo(() => domainExecution?.tool_history ?? [], [domainExecution?.tool_history]);
  const taskId = domainExecution?.task_id;
  const pendingTools = useMemo(() => domainExecution?.pending_tools ?? [], [domainExecution?.pending_tools]);
  const isWaitingForUser = domainExecution?.status === 'waiting_user';

  // Determine current iteration: if streaming, use highest iteration number from stream
  // If not streaming, fall back to metadata. This ensures "Current" badge appears immediately
  // when streaming starts, not after the response completes.
  // When execution is complete, there is no "current" iteration - all are historical.
  const currentIterationNumber = useMemo(() => {
    const isComplete = domainExecution?.status === 'completed' ||
                       domainExecution?.status === 'failed' ||
                       domainExecution?.status === 'aborted';

    // If execution is complete, no iteration is "current"
    if (isComplete) {
      return null;
    }

    if (coderStream.length > 0) {
      // Find the highest iteration number in the stream (the one being actively streamed)
      return Math.max(...coderStream.map(s => s.iteration));
    }
    // No streaming, use metadata
    return domainExecution?.metadata?.iterations ?? null;
  }, [coderStream, domainExecution?.metadata?.iterations, domainExecution?.status]);

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

    const processedCallIds = new Set<string>();

    for (const executedTool of sortedHistory) {
      const callId = executedTool.call_id;

      // Guard against malformed records
      if (!callId) {
        continue;
      }

      // Skip duplicate execution records that share the same call_id
      if (processedCallIds.has(callId)) {
        continue;
      }

      // Find matching iteration by tool name
      let matched = false;

      for (const [, group] of Array.from(groups.entries()).sort((a, b) => a[0] - b[0])) {
        const matchingToolCall = group.toolCalls.find(tc =>
          tc.tool === executedTool.tool &&
          !group.executedTools.some(et => et.call_id === callId)
        );

        if (matchingToolCall) {
          group.executedTools.push(executedTool);
          processedCallIds.add(callId);
          matched = true;
          break;
        }
      }

      // If no match found, add to the earliest iteration with tool calls
      if (!matched && groups.size > 0) {
        const firstGroupWithTools = Array.from(groups.values()).find(g => g.toolCalls.length > 0);
        if (firstGroupWithTools) {
          firstGroupWithTools.executedTools.push(executedTool);
          processedCallIds.add(callId);
        }
      }
    }

    // Determine status for each iteration
    const executionCompleted = domainExecution?.status === 'completed' ||
                                domainExecution?.status === 'failed' ||
                                domainExecution?.status === 'aborted';

    for (const group of Array.from(groups.values())) {
      const isCurrentIter = currentIterationNumber !== null && group.number === currentIterationNumber;
      const hasStreamingSegment =
        (group.thoughts?.status === 'streaming') ||
        (group.response?.status === 'streaming') ||
        group.toolCalls.some((tc: ToolCallSegment) => tc.status === 'streaming');

      if (isCurrentIter) {
        // If execution is complete, mark current iteration as completed
        if (executionCompleted) {
          group.status = 'completed';
        } else if (isWaitingForUser && pendingTools.length > 0) {
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
  }, [coderStream, toolHistory, currentIterationNumber, isWaitingForUser, pendingTools, domainExecution?.status]);

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
                    {getStreamText(group.thoughts) || (group.thoughts.status === 'complete' ? 'No reasoning shared.' : 'Gathering thoughts...')}
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
                    {getStreamText(group.response) || (group.response.status === 'complete' ? 'Agent response is empty.' : 'Composing response...')}
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
                    domainExecution={domainExecution}
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

        {/* Show waiting state if tools executed but no new iteration yet (and execution not complete) */}
        {isWaitingForUser === false &&
         pendingTools.length === 0 &&
         domainExecution?.tool_history &&
         domainExecution.tool_history.length > 0 &&
         coderStream.length > 0 &&
         domainExecution?.status !== 'completed' &&
         domainExecution?.status !== 'failed' &&
         domainExecution?.status !== 'aborted' && (
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

      {isProcessing && (
        <div className="exec-activity-feed__processing">
          <div className="exec-activity-feed__spinner" />
          <span className="text-sm text-white/60">Processing...</span>
        </div>
      )}
    </div>
  );
};
