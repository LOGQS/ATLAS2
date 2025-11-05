import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Icons } from '../ui/Icons';
import type { DomainExecution } from '../../types/messages';
import logger from '../../utils/core/logger';
import { apiUrl } from '../../config/api';
import '../../styles/coder/ToolApprovalPanel.css';

interface ToolApprovalPanelProps {
  chatId: string;
  domainExecution: DomainExecution;
  autoAcceptEnabled?: boolean;
}

const getShortCallId = (callId: string): string => {
  if (!callId) return '';
  if (callId === 'batch_all') return 'BATCH';
  return callId.slice(-8).toUpperCase();
};

const formatParamValue = (value: any, maxLength: number = 100): { short: string; full: string } => {
  const full = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const short = full.length > maxLength ? full.slice(0, maxLength) + '...' : full;
  return { short, full };
};

export const ToolApprovalPanel: React.FC<ToolApprovalPanelProps> = ({
  chatId,
  domainExecution,
  autoAcceptEnabled = false,
}) => {
  const [decisionState, setDecisionState] = useState<'idle' | 'accepting' | 'rejecting'>('idle');
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [confirmedDecision, setConfirmedDecision] = useState<'accept' | 'reject' | null>(null);
  const [showApprovalUI, setShowApprovalUI] = useState(true);
  const autoAcceptTriggered = useRef<string | null>(null);

  const pendingTools = useMemo(() => domainExecution?.pending_tools || [], [domainExecution?.pending_tools]);
  const hasPendingTools = pendingTools.length > 0;
  const isWaitingForUser = domainExecution?.status === 'waiting_user';
  const firstPendingTool = pendingTools[0];

  // Reset UI when waiting state changes
  useEffect(() => {
    if (!isWaitingForUser) {
      setDecisionState('idle');
      setDecisionError(null);
      setShowApprovalUI(true);
      setConfirmedDecision(null);
    } else {
      setDecisionError(null);
      setShowApprovalUI(true);
      setConfirmedDecision(null);
    }
  }, [isWaitingForUser, pendingTools]);

  // Reset auto-accept trigger when tools change
  useEffect(() => {
    if (!hasPendingTools) {
      autoAcceptTriggered.current = null;
    }
  }, [hasPendingTools]);

  // Tool decision handler
  const handleToolDecision = useCallback(async (decision: 'accept' | 'reject', batchMode: boolean = true) => {
    if (!hasPendingTools || !chatId || !domainExecution) {
      return;
    }

    const pendingState = decision === 'accept' ? 'accepting' : 'rejecting';
    setDecisionState(pendingState);
    setDecisionError(null);

    try {
      const callId = batchMode ? 'batch_all' : firstPendingTool?.call_id || 'batch_all';
      const endpoint = apiUrl(`/api/chats/${chatId}/domain/${domainExecution.task_id}/tool/${callId}/decision`);

      const toolDesc = batchMode
        ? `${pendingTools.length} tool(s)`
        : firstPendingTool?.tool || 'tool';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          batch_mode: batchMode,
          assistant_message_id: null
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        const errorMsg = data?.error || `Failed to ${decision} ${toolDesc}`;
        throw new Error(errorMsg);
      }

      logger.info(`[TOOL_APPROVAL] Submitted tool decision '${decision}' (batch=${batchMode}) for ${toolDesc}`, {
        chatId,
        taskId: domainExecution.task_id,
        toolCount: pendingTools.length
      });

      setConfirmedDecision(decision);
      await new Promise(resolve => setTimeout(resolve, 650));
      setShowApprovalUI(false);
    } catch (error) {
      logger.error('[TOOL_APPROVAL] Tool decision failed', error);
      setDecisionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDecisionState('idle');
    }
  }, [hasPendingTools, pendingTools, firstPendingTool, chatId, domainExecution]);

  // Auto-accept logic
  useEffect(() => {
    if (!autoAcceptEnabled || !isWaitingForUser || !hasPendingTools || !chatId || !domainExecution) {
      return;
    }

    const markerId = firstPendingTool?.call_id || '';
    if (autoAcceptTriggered.current === markerId) {
      return;
    }

    if (decisionState !== 'idle') {
      return;
    }

    const toolDesc = pendingTools.length === 1
      ? firstPendingTool?.tool || 'tool'
      : `${pendingTools.length} tools`;

    logger.info(`[TOOL_APPROVAL] Auto-accepting ${toolDesc}`, {
      chatId,
      taskId: domainExecution.task_id,
      toolCount: pendingTools.length
    });

    autoAcceptTriggered.current = markerId;
    setShowApprovalUI(false);
    handleToolDecision('accept', true);
  }, [autoAcceptEnabled, isWaitingForUser, hasPendingTools, pendingTools, firstPendingTool, chatId, domainExecution, decisionState, handleToolDecision]);

  if (!isWaitingForUser || !hasPendingTools || !showApprovalUI) {
    return null;
  }

  return (
    <div className="tool-approval-panel">
      <div className="tool-approval-panel__header">
        <div className="tool-approval-panel__heading">
          <Icons.Info className="w-5 h-5 text-yellow-400" />
          <span>Tool Approval Required {pendingTools.length > 1 && `(${pendingTools.length} tools)`}</span>
        </div>
        {domainExecution?.agent_message && (
          <div className="tool-approval-panel__message">
            {domainExecution.agent_message}
          </div>
        )}
      </div>

      <div className="tool-approval-panel__body">
        {pendingTools.map((tool, index) => (
          <div key={tool.call_id} className="tool-approval-panel__item">
            <div className="tool-approval-panel__item-header">
              <div className="tool-approval-panel__item-name">
                {pendingTools.length > 1 && <span className="tool-number">{index + 1}.</span>}
                {tool.tool}
              </div>
              <div className="tool-approval-panel__item-id">ID: {getShortCallId(tool.call_id)}</div>
            </div>

            {tool.reason && (
              <div className="tool-approval-panel__item-reason">
                <strong>Reason:</strong> {tool.reason}
              </div>
            )}

            {tool.tool_description && (
              <div className="tool-approval-panel__item-description">
                {tool.tool_description}
              </div>
            )}

            {tool.params && tool.params.length > 0 && (
              <div className="tool-approval-panel__item-params">
                <div className="tool-approval-panel__params-label">Parameters:</div>
                {tool.params.slice(0, 3).map(([key, value], i) => {
                  const formatted = formatParamValue(value, 100);
                  return (
                    <div key={i} className="tool-approval-panel__param">
                      <span className="tool-approval-panel__param-key">{key}:</span>
                      <span className="tool-approval-panel__param-value">{formatted.short}</span>
                    </div>
                  );
                })}
                {tool.params.length > 3 && (
                  <div className="tool-approval-panel__param-more">
                    +{tool.params.length - 3} more parameter{tool.params.length - 3 !== 1 ? 's' : ''}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {decisionError && (
        <div className="tool-approval-panel__error">
          <Icons.Info className="w-4 h-4" />
          <span>{decisionError}</span>
        </div>
      )}

      <div className="tool-approval-panel__actions">
        <button
          type="button"
          className={`tool-approval-panel__button tool-approval-panel__button--accept ${confirmedDecision === 'accept' ? 'tool-approval-panel__button--confirmed' : ''}`}
          onClick={() => handleToolDecision('accept', true)}
          disabled={decisionState !== 'idle'}
          title={pendingTools.length > 1 ? `Accept all ${pendingTools.length} tools` : 'Accept tool'}
        >
          {decisionState === 'accepting' ? (
            <>
              <Icons.Refresh className="w-4 h-4 animate-spin" />
              <span>Accepting...</span>
            </>
          ) : (
            <>
              <Icons.Check className="w-4 h-4" />
              <span>{pendingTools.length > 1 ? `Accept All (${pendingTools.length})` : 'Accept'}</span>
            </>
          )}
        </button>
        <button
          type="button"
          className={`tool-approval-panel__button tool-approval-panel__button--reject ${confirmedDecision === 'reject' ? 'tool-approval-panel__button--confirmed' : ''}`}
          onClick={() => handleToolDecision('reject', true)}
          disabled={decisionState !== 'idle'}
          title={pendingTools.length > 1 ? `Reject all ${pendingTools.length} tools` : 'Reject tool'}
        >
          {decisionState === 'rejecting' ? (
            <>
              <Icons.Refresh className="w-4 h-4 animate-spin" />
              <span>Rejecting...</span>
            </>
          ) : (
            <>
              <Icons.Close className="w-4 h-4" />
              <span>{pendingTools.length > 1 ? `Reject All (${pendingTools.length})` : 'Reject'}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
