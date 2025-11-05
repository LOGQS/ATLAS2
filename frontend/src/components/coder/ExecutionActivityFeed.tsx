import React, { useState } from 'react';
import { Icons } from '../ui/Icons';
import { ToolApprovalPanel } from './ToolApprovalPanel';
import type { DomainExecution, ToolOperation } from '../../types/messages';
import '../../styles/coder/ExecutionActivityFeed.css';

interface ExecutionActivityFeedProps {
  domainExecution: DomainExecution | null;
  isProcessing?: boolean;
  chatId?: string;
  autoAcceptEnabled?: boolean;
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

export const ExecutionActivityFeed: React.FC<ExecutionActivityFeedProps> = ({
  domainExecution,
  isProcessing = false,
  chatId,
  autoAcceptEnabled = false,
}) => {
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (!domainExecution) {
    return (
      <div className="exec-activity-feed__empty">
        <Icons.Activity className="w-12 h-12 opacity-30" />
        <p className="text-sm text-white/60 mt-4">No execution activity yet</p>
        <p className="text-xs text-white/40 mt-2">
          Agent actions and outputs will appear here
        </p>
      </div>
    );
  }

  const { actions = [], tool_history = [], plan, agent_message } = domainExecution;

  return (
    <div className="exec-activity-feed">
      {/* Current Plan - if exists */}
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

      {/* Tool Approval Panel - displayed when tools need approval */}
      {chatId && domainExecution && (
        <ToolApprovalPanel
          chatId={chatId}
          domainExecution={domainExecution}
          autoAcceptEnabled={autoAcceptEnabled}
        />
      )}

      {/* Actions Timeline */}
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

        {/* Tool History */}
        {tool_history.map((tool, idx) => {
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
                {/* Tool parameters */}
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
                    </div>
                  </div>
                )}

                {/* File operations */}
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
                      </div>
                    ))}
                  </div>
                )}

                {/* Result */}
                {tool.result_summary && (
                  <div className="exec-activity-feed__section">
                    <p className="exec-activity-feed__section-label">RESULT:</p>
                    <pre className="exec-activity-feed__result">{tool.result_summary}</pre>
                  </div>
                )}

                {/* Error */}
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

        {/* Agent Message - if exists */}
        {agent_message && (
          <details className="exec-activity-feed__item" open>
            <summary className="exec-activity-feed__item-summary">
              <Icons.Bot className="w-4 h-4 text-blue-400" />
              <div className="exec-activity-feed__item-info">
                <span className="exec-activity-feed__item-title">Agent Response</span>
              </div>
              <Icons.ChevronRight className="exec-activity-feed__chevron exec-activity-feed__chevron--expanded" />
            </summary>
            <div className="exec-activity-feed__item-content">
              <p className="exec-activity-feed__agent-message">{agent_message}</p>
            </div>
          </details>
        )}

        {/* Processing indicator */}
        {isProcessing && (
          <div className="exec-activity-feed__processing">
            <div className="exec-activity-feed__spinner" />
            <span className="text-sm text-white/60">Processing...</span>
          </div>
        )}
      </div>
    </div>
  );
};
