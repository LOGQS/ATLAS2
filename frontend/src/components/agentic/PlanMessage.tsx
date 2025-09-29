import React, { useMemo } from 'react';
import PlanBox from './PlanBox';
import ContextTimeline from './ContextTimeline';
import LLMMonitor from './LLMMonitor';
import {
  ContextCommitEntry,
  PlanSummary,
  TaskStateEntry,
  ToolCallEntry
} from '../../utils/agentic/PlanStore';
import '../../styles/agentic/PlanMessage.css';

interface PlanMessageProps {
  summary: PlanSummary;
  tasks: TaskStateEntry[];
  commits: ContextCommitEntry[];
  toolCalls: ToolCallEntry[];
  chatId: string;
}

const PlanMessage: React.FC<PlanMessageProps> = ({
  summary,
  tasks,
  commits,
  toolCalls,
  chatId
}) => {
  const normalizedStatus = useMemo(() => {
    const rawStatus = (summary.plan as any)?.status || 'PENDING_APPROVAL';
    return String(rawStatus).toLowerCase().replace(/[^a-z0-9_]/g, '-');
  }, [summary.plan]);

  const hasInsights = commits.length > 0 || toolCalls.length > 0;

  return (
    <div className={`agentic-plan-message agentic-plan-message--${normalizedStatus}`}>
      <PlanBox summary={summary} tasks={tasks} chatId={chatId} />
      {hasInsights && (
        <div className="agentic-plan-message__grid">
          {commits.length > 0 && <ContextTimeline commits={commits} />}
          {toolCalls.length > 0 && <LLMMonitor calls={toolCalls} />}
        </div>
      )}
    </div>
  );
};

export default PlanMessage;
