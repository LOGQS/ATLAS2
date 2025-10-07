// Domain Execution Visualization Component
import React, { useState, useEffect, useRef } from 'react';
import '../../styles/agentic/DomainBox.css';
import logger from '../../utils/core/logger';
import useScrollControl from '../../hooks/ui/useScrollControl';
import type { DomainExecution, ContextSnapshot } from '../../types/messages';

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

  const domainBoxContentRef = useRef<HTMLDivElement | null>(null);
  const actionsEndRef = useRef<HTMLDivElement>(null);

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

  if (!isVisible || (!domainExecution && !isProcessing)) {
    return null;
  }

  const currentContext = getCurrentContext();
  const actions = domainExecution?.actions || [];
  const plan = domainExecution?.plan;
  const taskDescription = plan?.task_description || domainExecution?.output || 'Executing domain task...';

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
            <div className="context-header">
              <span className="context-label">Active Context</span>
              <div className="context-controls">
                <button
                  className={`context-toggle ${expandedContext ? 'active' : ''}`}
                  onClick={() => setExpandedContext(!expandedContext)}
                  title={expandedContext ? 'Collapse' : 'Expand'}
                >
                  {expandedContext ? '−' : '+'}
                </button>
                {expandedContext && (
                  <button
                    className={`context-toggle ${showRawContext ? 'active' : ''}`}
                    onClick={() => setShowRawContext(!showRawContext)}
                    title="Toggle raw JSON"
                  >
                    {'{}'}
                  </button>
                )}
              </div>
            </div>
            {expandedContext && (
              <div className="context-content">
                {showRawContext && currentContext.full_context ? (
                  <pre className="context-raw">
                    {JSON.stringify(currentContext.full_context, null, 2)}
                  </pre>
                ) : (
                  <div className="context-summary">
                    <div className="context-item">
                      <span className="context-key">Size:</span>
                      <span className="context-value">{currentContext.context_size} tokens</span>
                    </div>
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
          <div className="flow-header">
            <span className="flow-label">Action Flow</span>
            <span className="flow-count">{actions.length} actions</span>
          </div>
          <div className="flow-graph">
            {actions.map((action, index) => (
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
                    <div className="node-type">{action.action_type}</div>
                    <div className="node-description">{action.description}</div>
                    <div className="node-timestamp">
                      {new Date(action.timestamp).toLocaleTimeString()}
                    </div>
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
            ))}
            <div ref={actionsEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default DomainBox;
