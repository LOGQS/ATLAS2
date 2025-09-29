// status: alpha

import { apiUrl } from '../../config/api';
import logger from '../core/logger';

export interface PlanSummary {
  planId: string;
  fingerprint: string;
  plan: any;
}

export interface TaskStateEntry {
  taskId: string;
  state: string;
  attempt: number;
  payload: Record<string, any>;
  updatedAt: number;
}

export interface ToolCallEntry {
  id: string;
  tool: string;
  provider?: string;
  model?: string;
  latencyMs: number;
  tokens?: number;
  cost?: number;
  timestamp: number;
  payload: Record<string, any>;
}

export interface ContextCommitEntry {
  baseCtxId: string;
  newCtxId: string;
  ops: any;
  timestamp: number;
}

export interface PlanExecutionState {
  summary: PlanSummary | null;
  tasks: Map<string, TaskStateEntry>;
  toolCalls: ToolCallEntry[];
  contextCommits: ContextCommitEntry[];
  lastEventAt: number;
}

export type PlanListener = (chatId: string, state: PlanExecutionState) => void;

interface PlanEventPayload {
  type: string;
  chat_id: string;
  plan_id: string;
  [key: string]: any;
}

class PlanStore {
  private es: EventSource | null = null;
  private plans = new Map<string, PlanExecutionState>();
  private listeners = new Map<string, Set<PlanListener>>();

  registerPlan(chatId: string, payload: { plan_id: string; fingerprint: string; plan: any }) {
    logger.info(`[PlanStore] Registering plan ${payload.plan_id} for chat ${chatId}`);
    const next: PlanExecutionState = {
      summary: {
        planId: payload.plan_id,
        fingerprint: payload.fingerprint,
        plan: payload.plan
      },
      tasks: new Map(),
      toolCalls: [],
      contextCommits: [],
      lastEventAt: Date.now()
    };
    this.plans.set(chatId, next);
    this.emit(chatId, next);
    this.start();
  }

  get(chatId: string): PlanExecutionState | undefined {
    return this.plans.get(chatId);
  }

  subscribe(chatId: string, listener: PlanListener) {
    if (!this.listeners.has(chatId)) {
      this.listeners.set(chatId, new Set());
    }
    this.listeners.get(chatId)!.add(listener);

    const current = this.get(chatId);
    if (current) {
      listener(chatId, current);
    }

    return () => {
      const set = this.listeners.get(chatId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(chatId);
      }
    };
  }

  private emit(chatId: string, state: PlanExecutionState) {
    const listeners = this.listeners.get(chatId);
    if (!listeners) {
      return;
    }
    listeners.forEach(listener => {
      try {
        listener(chatId, state);
      } catch (err) {
        logger.error('[PlanStore] Listener error', err);
      }
    });
  }

  private start() {
    if (this.es) {
      return;
    }

    logger.info('[PlanStore] Opening plan SSE stream');
    this.es = new EventSource(apiUrl('/sse/plan_events'));

    this.es.onmessage = (event) => {
      try {
        const payload: PlanEventPayload = JSON.parse(event.data);
        this.handleEvent(payload);
      } catch (err) {
        logger.error('[PlanStore] Failed to parse plan SSE event', err);
      }
    };

    this.es.onerror = (err) => {
      logger.warn('[PlanStore] SSE error, resetting connection', err);
      if (this.es) {
        this.es.close();
        this.es = null;
      }
      setTimeout(() => this.start(), 2000);
    };
  }

  private handleEvent(event: PlanEventPayload) {
    const chatId = event.chat_id;
    const planId = event.plan_id;
    if (!chatId || !planId) {
      return;
    }

    const state = this.plans.get(chatId);
    if (!state || !state.summary || state.summary.planId !== planId) {
      logger.debug(`[PlanStore] Ignoring event for chat ${chatId} plan ${planId} (no active state)`);
      return;
    }

    state.lastEventAt = Date.now();

    switch (event.type) {
      case 'plan_created': {
        state.summary = {
          planId,
          fingerprint: event.fingerprint,
          plan: event.plan
        };
        break;
      }
      case 'task_state_changed': {
        const taskId = event.task_id;
        if (!taskId) break;
        const prev = state.tasks.get(taskId);
        const entry: TaskStateEntry = {
          taskId,
          state: event.state || prev?.state || 'PENDING',
          attempt: event.attempt || prev?.attempt || 1,
          payload: { ...event },
          updatedAt: Date.now()
        };
        state.tasks.set(taskId, entry);
        break;
      }
      case 'tool_called': {
        const call: ToolCallEntry = {
          id: `${planId}-${event.task_id}-${event.attempt || 1}-${Date.now()}`,
          tool: event.tool,
          provider: event.provider,
          model: event.model,
          latencyMs: event.latency_ms || 0,
          tokens: event.tokens,
          cost: event.cost,
          timestamp: Date.now(),
          payload: { ...event }
        };
        state.toolCalls = [...state.toolCalls.slice(-49), call];
        break;
      }
      case 'context_committed': {
        const commit: ContextCommitEntry = {
          baseCtxId: event.base_ctx_id,
          newCtxId: event.new_ctx_id,
          ops: event.ops,
          timestamp: Date.now()
        };
        state.contextCommits = [...state.contextCommits.slice(-49), commit];
        break;
      }
      case 'plan_approved': {
        if (state.summary) {
          state.summary.plan = { ...state.summary.plan, status: 'APPROVED' };
        }
        break;
      }
      case 'plan_denied': {
        if (state.summary) {
          state.summary.plan = { ...state.summary.plan, status: 'DENIED' };
        }
        break;
      }
      case 'execution_complete': {
        if (event.final_output && state.summary) {
          state.summary.plan = { ...state.summary.plan, status: 'COMPLETED', final_output: event.final_output };
        }
        break;
      }
      case 'execution_failed': {
        if (state.summary) {
          state.summary.plan = { ...state.summary.plan, status: 'FAILED', error: event.error };
        }
        break;
      }
      default:
        logger.debug(`[PlanStore] Unhandled plan event type: ${event.type}`);
        break;
    }

    this.plans.set(chatId, state);
    this.emit(chatId, state);
  }
}

export const planStore = new PlanStore();
