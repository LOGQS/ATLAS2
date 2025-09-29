// status: alpha

import { useEffect, useState } from 'react';
import { planStore, PlanExecutionState } from '../../utils/agentic/PlanStore';

export function usePlanExecution(chatId?: string): PlanExecutionState | undefined {
  const [state, setState] = useState<PlanExecutionState | undefined>(() => {
    if (!chatId) {
      return undefined;
    }
    const current = planStore.get(chatId);
    return current ? cloneState(current) : undefined;
  });

  useEffect(() => {
    if (!chatId) {
      setState(undefined);
      return;
    }

    return planStore.subscribe(chatId, (_, next) => {
      setState(cloneState(next));
    });
  }, [chatId]);

  return state;
}

function cloneState(source: PlanExecutionState): PlanExecutionState {
  return {
    summary: source.summary ? { ...source.summary } : null,
    tasks: new Map(source.tasks),
    toolCalls: [...source.toolCalls],
    contextCommits: [...source.contextCommits],
    lastEventAt: source.lastEventAt,
  };
}
