// status: complete
import { apiUrl } from '../../config/api';
import logger from '../core/logger';
import { performanceTracker } from '../core/performanceTracker';
import { sendButtonStateManager } from './SendButtonStateManager';
import { planStore, PlanSummary } from '../agentic/PlanStore';
import type { RouterDecision, DomainExecution } from '../../types/messages';

type ChatLive = {
  state: 'thinking' | 'responding' | 'static';
  lastAssistantId: string | null;
  contentBuf: string;
  thoughtsBuf: string;
  routerDecision: RouterDecision | null;
  domainExecution: DomainExecution | null;
  planSummary: PlanSummary | null;
  error: {
    message: string;
    receivedAt: number;
    messageId?: string | null;
  } | null;
  version: number;
};

type Listener = (chatId: string, snap: ChatLive) => void;
type StateListener = (chatId: string, state: ChatLive['state']) => void;

interface BaseSSEEvent {
  chat_id?: string;
  type: string;
}

interface ChatStateEvent extends BaseSSEEvent {
  type: 'chat_state';
  state?: 'thinking' | 'responding' | 'static';
}

interface ContentEvent extends BaseSSEEvent {
  type: 'thoughts' | 'answer';
  content?: string;
}

interface CompleteEvent extends BaseSSEEvent {
  type: 'complete';
}

interface MessageIdsEvent extends BaseSSEEvent {
  type: 'message_ids';
  content?: string;
}

interface FileStateEvent extends BaseSSEEvent {
  type: 'file_state';
  file_id?: string;
  temp_id?: string;
  api_state?: string;
  provider?: string;
}

type FilesystemEventType = 'created' | 'deleted' | 'modified' | 'moved';

interface FileSystemEvent extends BaseSSEEvent {
  type: 'filesystem';
  event?: FilesystemEventType;
  path?: string;
  previous_path?: string;
  is_directory?: boolean;
}

interface RouterDecisionEvent extends BaseSSEEvent {
  type: 'router_decision';
  selected_route?: string;
  available_routes?: any[];
  selected_model?: string;
  tools_needed?: boolean | null;
  execution_type?: string | null;
  fastpath_params?: string | null;
  error?: string | null;
}

interface TaskflowPlanEvent extends BaseSSEEvent {
  type: 'taskflow_plan';
  plan_id: string;
  fingerprint?: string;
  plan: any;
  status?: string;
}

interface PlanPendingApprovalEvent extends BaseSSEEvent {
  type: 'plan_pending_approval';
  plan_id: string;
  message?: string;
}

interface ErrorEvent extends BaseSSEEvent {
  type: 'error';
  content?: string;
  message_id?: string;
}

interface DomainExecutionEvent extends BaseSSEEvent {
  type: 'domain_execution';
  content?: string;
}

interface DomainExecutionUpdateEvent extends BaseSSEEvent {
  type: 'domain_execution_update';
  content?: string;
  task_id?: string;
}

interface CoderOperationEvent extends BaseSSEEvent {
  type: 'coder_operation';
  content?: string;
}

interface CoderWorkspacePromptEvent extends BaseSSEEvent {
  type: 'coder_workspace_prompt';
  content?: string;
}

interface CoderFileChangeEvent extends BaseSSEEvent {
  type: 'coder_file_change';
  workspace_path?: string;
  file_path?: string;
  operation?: 'write' | 'edit' | 'move';
  content?: string;
  previous_path?: string;
}

type SSEEvent =
  | ChatStateEvent
  | ContentEvent
  | CompleteEvent
  | MessageIdsEvent
  | FileStateEvent
  | FileSystemEvent
  | RouterDecisionEvent
  | TaskflowPlanEvent
  | PlanPendingApprovalEvent
  | ErrorEvent
  | DomainExecutionEvent
  | DomainExecutionUpdateEvent
  | CoderOperationEvent
  | CoderWorkspacePromptEvent
  | CoderFileChangeEvent;

class LiveStore {
  private es: EventSource | null = null;
  private byChat = new Map<string, ChatLive>();
  private listeners = new Map<string, Set<Listener>>();
  private stateListeners = new Map<string, Set<StateListener>>();
  private processedMessageIds = new Map<string, number>(); 
  private readonly MESSAGE_ID_CLEANUP_INTERVAL = 5 * 60 * 1000; 
  private readonly MESSAGE_ID_MAX_AGE = 15 * 60 * 1000; 
  private lastCleanupTime = Date.now();
  private pendingVersionStreamParents = new Map<string, string>();

  registerVersionStream(childChatId: string, parentChatId: string) {
    sendButtonStateManager.setSendButtonDisabled(parentChatId, true);
    sendButtonStateManager.setSendButtonDisabled(childChatId, true);
    sendButtonStateManager.registerParentChild(childChatId, parentChatId);
    this.pendingVersionStreamParents.set(childChatId, parentChatId);
    logger.info(`[LIVESTORE_BRIDGE] Registered pending version stream child=${childChatId} parent=${parentChatId}`);
  }

  private enableParentFromBridge(chatId: string, context: string) {
    if (this.pendingVersionStreamParents.has(chatId)) {
      const parentId = this.pendingVersionStreamParents.get(chatId)!;
      sendButtonStateManager.setSendButtonDisabled(parentId, false);
      logger.info(`[LIVESTORE_BRIDGE] ${context} for child ${chatId}; re-enabled parent ${parentId}`);
    }
  }

  private cleanupProcessedMessageIds() {
    const now = Date.now();
    if (now - this.lastCleanupTime < this.MESSAGE_ID_CLEANUP_INTERVAL) {
      return;
    }

    let cleanedCount = 0;
    for (const [key, timestamp] of Array.from(this.processedMessageIds)) {
      if (now - timestamp > this.MESSAGE_ID_MAX_AGE) {
        this.processedMessageIds.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug(`[LiveStore] Cleaned up ${cleanedCount} old message ID entries`);
    }
    this.lastCleanupTime = now;
  }

  private handleFileStateEvent(ev: FileStateEvent): void {
    logger.info(`[LiveStore] File state event: ${ev.file_id} (temp:${ev.temp_id}) -> ${ev.api_state}`);
    window.dispatchEvent(new CustomEvent('fileStateUpdate', {
      detail: { file_id: ev.file_id, api_state: ev.api_state, provider: ev.provider, temp_id: ev.temp_id }
    }));
  }

  private handleFilesystemEvent(ev: FileSystemEvent): void {
    const action = ev.event || 'modified';
    logger.info(`[LiveStore] Filesystem event: ${action} -> ${ev.path}`);
    window.dispatchEvent(new CustomEvent('filesystemChange', {
      detail: {
        action,
        path: ev.path || '',
        previousPath: ev.previous_path || null,
        isDirectory: Boolean(ev.is_directory)
      }
    }));
  }

  private handleCoderFileChangeEvent(ev: CoderFileChangeEvent): void {
    const operation = ev.operation || 'edit';
    logger.info(`[LiveStore] Coder file change: ${operation} -> ${ev.file_path} (chat: ${ev.chat_id})`);
    window.dispatchEvent(new CustomEvent('coderFileChange', {
      detail: {
        chatId: ev.chat_id || null,
        workspacePath: ev.workspace_path || null,
        filePath: ev.file_path || '',
        operation,
        content: ev.content || null,
        previousPath: ev.previous_path || null,
      }
    }));
  }

  private handleRouterDecisionEvent(chatId: string, ev: RouterDecisionEvent, cur: ChatLive): ChatLive {
    const next = { ...cur };
    next.routerDecision = {
      selectedRoute: ev.selected_route || null,
      availableRoutes: ev.available_routes || [],
      selectedModel: ev.selected_model || null,
      toolsNeeded: ev.tools_needed ?? null,
      executionType: ev.execution_type || null,
      fastpathParams: ev.fastpath_params || null,
      error: ev.error || null
    };
    next.error = null;
    next.version++;
    if (ev.error) {
      logger.warn(`[ROUTER_LIVESTORE] Router decision with error for ${chatId}: ${ev.error}, falling back to model=${ev.selected_model}`);
    } else {
      logger.info(`[ROUTER_LIVESTORE] Router decision stored for ${chatId}: route=${ev.selected_route}, model=${ev.selected_model}, tools_needed=${ev.tools_needed} (type: ${typeof ev.tools_needed}), available=${ev.available_routes?.length || 0}`);
    }
    this.enableParentFromBridge(chatId, 'Router decision');
    return next;
  }

  private handleTaskflowPlanEvent(chatId: string, ev: any, cur: ChatLive): ChatLive {
    if (ev.plan_id && ev.plan) {
      const planData = { ...ev.plan };
      if (ev.status) {
        planData.status = ev.status;
      }
      planStore.registerPlan(chatId, { plan_id: ev.plan_id, fingerprint: ev.fingerprint || '', plan: planData });
    }
    const next = { ...cur };
    const planData = ev.plan ? { ...ev.plan } : null;
    if (planData && ev.status) {
      planData.status = ev.status;
    }
    next.planSummary = ev.plan_id ? { planId: ev.plan_id, fingerprint: ev.fingerprint || '', plan: planData } : null;
    next.version++;
    // For pending approval, keep chat in static state
    if (ev.status === 'PENDING_APPROVAL') {
      next.state = 'static';
    } else if (next.state === 'static') {
      next.state = 'thinking';
    }
    return next;
  }

  private handleChatStateEvent(chatId: string, ev: ChatStateEvent, cur: ChatLive): ChatLive {
    const next = { ...cur };
    const oldState = next.state;
    const requestedState = ev.state || 'static';
    next.state = requestedState;
    if (next.state !== 'static') {
      next.error = null;
    }

    if (oldState === 'static' && (requestedState === 'thinking' || requestedState === 'responding')) {
      if (next.contentBuf.length > 0 || next.thoughtsBuf.length > 0) {
        logger.debug(`[LIVESTORE_SSE] Clearing stale buffers for ${chatId} on new stream start`);
      }
      next.contentBuf = '';
      next.thoughtsBuf = '';
    }
    next.version++;
    logger.info(`[LIVESTORE_SSE] State change for ${chatId}: ${oldState} -> ${next.state}`);

    if (next.state === 'thinking' && oldState !== 'thinking') {
      performanceTracker.mark(performanceTracker.MARKS.STREAM_THINKING, chatId);
      performanceTracker.mark(performanceTracker.MARKS.FIRST_STREAM_EVENT, chatId);
    } else if (next.state === 'responding' && oldState !== 'responding') {
      performanceTracker.mark(performanceTracker.MARKS.STREAM_RESPONDING, chatId);
    }

    if ((next.state === 'thinking' || next.state === 'responding')) {
      this.enableParentFromBridge(chatId, 'First state');
    }
    return next;
  }

  private handleThoughtsEvent(chatId: string, ev: ContentEvent, cur: ChatLive): ChatLive {
    const next = { ...cur };
    const addedContent = ev.content || '';
    next.thoughtsBuf = cur.thoughtsBuf + addedContent;
    next.error = null;
    next.version++;
    logger.debug(`[LIVESTORE_SSE] Thoughts chunk for ${chatId}: +${addedContent.length} chars (total: ${next.thoughtsBuf.length})`);
    logger.debug(`[LIVESTORE_SSE] Thoughts content: "${addedContent.substring(0, 50)}..."`);
    this.enableParentFromBridge(chatId, 'First thoughts content');
    return next;
  }

  private handleAnswerEvent(chatId: string, ev: ContentEvent, cur: ChatLive): ChatLive {
    const next = { ...cur };
    const addedContent = ev.content || '';
    next.contentBuf = cur.contentBuf + addedContent;
    next.error = null;
    next.version++;
    logger.debug(`[LIVESTORE_SSE] Content chunk for ${chatId}: +${addedContent.length} chars (total: ${next.contentBuf.length})`);
    logger.debug(`[LIVESTORE_SSE] Content: "${addedContent.substring(0, 50)}..."`);
    this.enableParentFromBridge(chatId, 'First answer content');
    return next;
  }

  private handleCompleteEvent(chatId: string, cur: ChatLive): ChatLive {
    const next = { ...cur };
    const oldState = next.state;
    next.state = 'static';
    next.error = null;

    if (next.planSummary) {
      logger.info(`[LIVESTORE_SSE] Clearing planSummary for ${chatId} after stream completion`);
      next.planSummary = null;
    }

    next.version++;
    logger.debug(`[LIVESTORE_SSE] Stream complete for ${chatId}: ${oldState} -> static`);
    logger.debug(`[LIVESTORE_SSE] Final buffers - content: ${next.contentBuf.length}chars, thoughts: ${next.thoughtsBuf.length}chars`);

    performanceTracker.mark(performanceTracker.MARKS.STREAM_COMPLETE, chatId);

    if (this.pendingVersionStreamParents.has(chatId)) {
      const parentId = this.pendingVersionStreamParents.get(chatId)!;
      sendButtonStateManager.setSendButtonDisabled(chatId, false);
      sendButtonStateManager.clearSendButtonState(parentId);
      sendButtonStateManager.clearParentChild(chatId);
      this.pendingVersionStreamParents.delete(chatId);
      logger.debug(`[LIVESTORE_BRIDGE] Completed child ${chatId}; re-enabled both child and parent ${parentId}, cleared mapping`);
    }
    return next;
  }

  private handleErrorEvent(chatId: string, ev: ErrorEvent, cur: ChatLive): ChatLive {
    const next = { ...cur };
    const message = ev.content || 'Gemini returned an empty response. Please retry your request.';
    next.state = 'static';
    next.contentBuf = '';
    next.thoughtsBuf = '';
    next.planSummary = null;
    next.routerDecision = null;
    next.error = {
      message,
      receivedAt: Date.now(),
      messageId: ev.message_id || null
    };
    next.version++;
    this.enableParentFromBridge(chatId, 'Error event');
    logger.warn(`[LIVESTORE_SSE] Error event for ${chatId}: ${message}`);
    return next;
  }

  private handleDomainExecutionEvent(chatId: string, ev: DomainExecutionEvent | DomainExecutionUpdateEvent, cur: ChatLive): ChatLive {
    const next = { ...cur };
    logger.info(`[DOMAIN-EXEC-LIVESTORE] handleDomainExecutionEvent called for ${chatId}`);
    logger.info(`[DOMAIN-EXEC-LIVESTORE] Event content length: ${ev.content?.length || 0} chars`);
    logger.info(`[DOMAIN-EXEC-LIVESTORE] Event content preview: ${ev.content?.substring(0, 200)}`);
    try {
      const domainExecution = JSON.parse(ev.content || '{}');
      logger.info(`[DOMAIN-EXEC-LIVESTORE] Parsed domain execution: domain_id=${domainExecution.domain_id}, status=${domainExecution.status}, plan=${!!domainExecution.plan}, actions=${domainExecution.actions?.length || 0}`);
      next.domainExecution = domainExecution;
      next.version++;
      logger.info(`[DOMAIN-EXEC-LIVESTORE] Updated next.domainExecution, version=${next.version}`);
      logger.info(`[DOMAIN-EXEC-LIVESTORE] next.domainExecution is now: ${JSON.stringify(next.domainExecution).substring(0, 200)}`);
      this.enableParentFromBridge(chatId, 'Domain execution');
    } catch (err) {
      logger.error(`[DOMAIN-EXEC-LIVESTORE] Failed to parse domain execution for ${chatId}:`, err);
      logger.error(`[DOMAIN-EXEC-LIVESTORE] Event content was: ${ev.content}`);
    }
    return next;
  }

  private handleMessageIdsEvent(chatId: string, ev: MessageIdsEvent): void {
    try {
      const messageIds = JSON.parse(ev.content || '{}');
      const eventKey = `${chatId}-${messageIds.user_message_id}-${messageIds.assistant_message_id}`;

      this.cleanupProcessedMessageIds();

      if (this.processedMessageIds.has(eventKey)) {
        logger.debug(`[LiveStore] Ignoring duplicate message_ids event: ${eventKey}`);
        return;
      }
      this.processedMessageIds.set(eventKey, Date.now());

      logger.debug(`[LiveStore] Message IDs for ${chatId}: user=${messageIds.user_message_id}, assistant=${messageIds.assistant_message_id}`);

      window.dispatchEvent(new CustomEvent('messageIdsUpdate', {
        detail: {
          chatId: chatId,
          userMessageId: messageIds.user_message_id,
          assistantMessageId: messageIds.assistant_message_id
        }
      }));
    } catch (err) {
      logger.error(`[LiveStore] Failed to parse message_ids for ${chatId}:`, err);
    }
  }

  start() {
    if (this.es) return;
    
    logger.info('[LiveStore] Starting global SSE stream');
    this.es = new EventSource(apiUrl('/api/chat/stream/all'));
    
    this.es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as SSEEvent;
        
        if (ev.type === 'file_state') {
          this.handleFileStateEvent(ev as FileStateEvent);
          return;
        }

        if (ev.type === 'filesystem') {
          this.handleFilesystemEvent(ev as FileSystemEvent);
          return;
        }

        if (ev.type === 'coder_file_change') {
          this.handleCoderFileChangeEvent(ev as CoderFileChangeEvent);
          return;
        }

        if (ev.type === 'coder_workspace_prompt') {
          try {
            const detail = ev.content ? JSON.parse(ev.content) : {};
            detail.chatId = ev.chat_id || null;
            window.dispatchEvent(new CustomEvent('coderWorkspacePrompt', { detail }));
          } catch (err) {
            logger.error('[LiveStore] Failed to parse coder_workspace_prompt payload', err);
          }
          return;
        }

        if (ev.type === 'coder_operation') {
          if (!ev.content) {
            logger.warn('[LiveStore] coder_operation event missing content payload');
            return;
          }
          try {
            const detail = JSON.parse(ev.content);
            detail.chatId = ev.chat_id || null;
            window.dispatchEvent(new CustomEvent('coderOperation', { detail }));
          } catch (err) {
            logger.error('[LiveStore] Failed to parse coder_operation payload', err);
          }
          return;
        }

        const chatId = ev.chat_id as string;
        if (!chatId) {
          logger.debug(`[LIVESTORE_SSE] Received event without chatId, skipping`);
          return;
        }

        const cur = this.byChat.get(chatId) ?? {
          state: 'static',
          lastAssistantId: null,
          contentBuf: '',
          thoughtsBuf: '',
          routerDecision: null,
          domainExecution: null,
          planSummary: null,
          error: null,
          version: 0
        };

        if (ev.type === 'router_decision') {
          const next = this.handleRouterDecisionEvent(chatId, ev as RouterDecisionEvent, cur);
          logger.info(`[LIVESTORE_SSE] Storing router decision for ${chatId}:`);
          logger.info(`[LIVESTORE_SSE] - Selected route: ${next.routerDecision?.selectedRoute}`);
          logger.info(`[LIVESTORE_SSE] - Available routes: ${next.routerDecision?.availableRoutes.length}`);

          this.byChat.set(chatId, next);
          this.emit(chatId, next, { eventType: ev.type });
          return;
        }

        if (ev.type === 'taskflow_plan') {
          const next = this.handleTaskflowPlanEvent(chatId, ev as any, cur);
          this.byChat.set(chatId, next);
          this.emit(chatId, next, { eventType: ev.type });
          return;
        }

        if (ev.type === 'plan_pending_approval') {
          const next = { ...cur };
          next.state = 'static';
          next.version++;
          this.byChat.set(chatId, next);
          this.emit(chatId, next, { eventType: ev.type });
          return;
        }

        logger.info(`[LIVESTORE_SSE] Processing ${ev.type} event for chat: ${chatId}`);


        logger.info(`[LIVESTORE_SSE] Current state for ${chatId}: state=${cur.state}, content=${cur.contentBuf.length}chars, thoughts=${cur.thoughtsBuf.length}chars`);

        let next: ChatLive;

        switch (ev.type) {
          case 'chat_state':
            next = this.handleChatStateEvent(chatId, ev as ChatStateEvent, cur);
            break;
          case 'thoughts':
            next = this.handleThoughtsEvent(chatId, ev as ContentEvent, cur);
            break;
          case 'answer':
            next = this.handleAnswerEvent(chatId, ev as ContentEvent, cur);
            break;
          case 'domain_execution':
            next = this.handleDomainExecutionEvent(chatId, ev as DomainExecutionEvent, cur);
            break;
          case 'domain_execution_update':
            next = this.handleDomainExecutionEvent(chatId, ev as DomainExecutionUpdateEvent, cur);
            break;
          case 'complete':
            next = this.handleCompleteEvent(chatId, cur);
            break;
          case 'error':
            next = this.handleErrorEvent(chatId, ev as ErrorEvent, cur);
            break;
          case 'message_ids':
            this.handleMessageIdsEvent(chatId, ev as MessageIdsEvent);
            return;
          default:
            logger.debug(`[LiveStore] Unknown event type: ${(ev as any).type}`);
            return;
        }

        logger.info(`[DOMAIN-EXEC-LIVESTORE] Storing updated state for ${chatId}:`);
        logger.info(`[DOMAIN-EXEC-LIVESTORE] - Final state: ${next.state}`);
        logger.info(`[DOMAIN-EXEC-LIVESTORE] - Content buffer: ${next.contentBuf.length}chars`);
        logger.info(`[DOMAIN-EXEC-LIVESTORE] - Thoughts buffer: ${next.thoughtsBuf.length}chars`);
        logger.info(`[DOMAIN-EXEC-LIVESTORE] - Domain execution present: ${!!next.domainExecution}`);
        logger.info(`[DOMAIN-EXEC-LIVESTORE] - Router decision present: ${!!next.routerDecision}`);
        logger.info(`[DOMAIN-EXEC-LIVESTORE] - Version: ${next.version}`);

        const stateChanged = cur.state !== next.state;
        this.byChat.set(chatId, next);
        logger.info(`[DOMAIN-EXEC-LIVESTORE] About to emit event type: ${ev.type}`);
        this.emit(chatId, next, { eventType: ev.type, stateChanged });
        logger.info(`[DOMAIN-EXEC-LIVESTORE] Emitted successfully`);
      } catch (err) {
        logger.error('[LiveStore] Failed to process SSE event', err);
      }
    };
    
    this.es.onerror = (e) => {
      logger.warn('[LiveStore] SSE connection error, will reconnect', e);
    };
    
    this.es.onopen = () => {
      logger.info('[LiveStore] SSE connection established');
    };
  }

  beginLocalStream(chatId: string): void {
    const cur = this.byChat.get(chatId) ?? {
      state: 'static',
      lastAssistantId: null,
      contentBuf: '',
      thoughtsBuf: '',
      routerDecision: null,
      domainExecution: null,
      planSummary: null,
      error: null,
      version: 0
    };
    if (cur.state !== 'static') {
      return; 
    }
    const next: ChatLive = {
      ...cur,
      state: 'thinking',
      error: null,
      contentBuf: '',
      thoughtsBuf: '',
      version: cur.version + 1
    };
    const stateChanged = cur.state !== next.state;
    this.byChat.set(chatId, next);
    this.emit(chatId, next, { stateChanged });
  }

  revertLocalStream(chatId: string): void {
    const cur = this.byChat.get(chatId);
    if (!cur) return;
    if (cur.state === 'thinking' && cur.contentBuf.length === 0 && cur.thoughtsBuf.length === 0) {
      const next: ChatLive = { ...cur, state: 'static', error: null, version: cur.version + 1 };
      const stateChanged = cur.state !== next.state;
      this.byChat.set(chatId, next);
      this.emit(chatId, next, { stateChanged, eventType: 'chat_state' });
    }
  }

  subscribeState(chatId: string, fn: StateListener) {
    if (!this.stateListeners.has(chatId)) {
      this.stateListeners.set(chatId, new Set());
    }
    this.stateListeners.get(chatId)!.add(fn);

    const snap = this.byChat.get(chatId);
    if (snap) {
      fn(chatId, snap.state);
    }

    return () => {
      const set = this.stateListeners.get(chatId);
      if (set) {
        set.delete(fn);
        if (set.size === 0) {
          this.stateListeners.delete(chatId);
        }
      }
    };
  }

  subscribe(chatId: string, fn: Listener) {
    logger.info(`[LIVESTORE_SUB] Subscribing to LiveStore for chat: ${chatId}`);
    
    if (!this.listeners.has(chatId)) {
      this.listeners.set(chatId, new Set());
      logger.info(`[LIVESTORE_SUB] Created new listener set for chat: ${chatId}`);
    }
    this.listeners.get(chatId)!.add(fn);
    
    const snap = this.byChat.get(chatId);
    if (snap) {
      logger.info(`[LIVESTORE_SUB] Sending initial state to new subscriber for ${chatId}:`);
      logger.info(`[LIVESTORE_SUB] - State: ${snap.state}, content: ${snap.contentBuf.length}chars, thoughts: ${snap.thoughtsBuf.length}chars`);
      fn(chatId, snap);
    } else {
      logger.info(`[LIVESTORE_SUB] No initial state found for chat: ${chatId}`);
    }
    
    return () => {
      logger.info(`[LIVESTORE_SUB] Unsubscribing from LiveStore for chat: ${chatId}`);
      const set = this.listeners.get(chatId);
      if (set) {
        set.delete(fn);
        if (set.size === 0) {
          this.listeners.delete(chatId);
          logger.info(`[LIVESTORE_SUB] Removed listener set for chat: ${chatId}`);
        }
      }
    };
  }

  get(chatId: string): ChatLive | undefined {
    return this.byChat.get(chatId);
  }

  reset(chatId: string) {
    this.byChat.delete(chatId);
    logger.debug(`[LiveStore] Reset state for ${chatId}`);
  }

  private emit(chatId: string, snap: ChatLive, options: { eventType?: SSEEvent['type'] | 'chat_state'; stateChanged?: boolean } = {}) {
    const stateListeners = this.stateListeners.get(chatId);
    if (options.stateChanged && stateListeners) {
      stateListeners.forEach(listener => {
        try {
          listener(chatId, snap.state);
        } catch (err) {
          logger.error(`[LIVESTORE_EMIT] Error in state listener for ${chatId}`, err);
        }
      });
    }

    const ls = this.listeners.get(chatId);
    if (!ls) {
      logger.debug(`[LIVESTORE_EMIT] No listeners for chat ${chatId}, skipping emit`);
      return;
    }
    
    logger.debug(`[LIVESTORE_EMIT] Emitting update for ${chatId} to ${ls.size} listeners`);
    
    const listenerList = Array.from(ls);
    listenerList.forEach((fn, index) => {
      try {
        fn(chatId, snap);
      } catch (err) {
        logger.error(`[LIVESTORE_EMIT] Error in listener ${index + 1}/${listenerList.length} for ${chatId}`, err);
      }
    });
  }

  reconcileWithDB(chatId: string, lastAssistantId: string | null, dbContent: string, dbThoughts: string) {
    const cur = this.byChat.get(chatId);
    if (!cur) return;
    
    const next = { ...cur, lastAssistantId, error: null };
    
    if (dbContent.length >= cur.contentBuf.length) {
      next.contentBuf = '';
    }
    if (dbThoughts.length >= cur.thoughtsBuf.length) {
      next.thoughtsBuf = '';
    }
    
    next.version++;
    
    const stateChanged = cur.state !== next.state;
    this.byChat.set(chatId, next);
    this.emit(chatId, next, { stateChanged });
    
    logger.debug(`[LiveStore] Reconciled ${chatId} with DB - lastAid=${lastAssistantId}, cleared buffers`);
  }

  stop() {
    if (this.es) {
      this.es.close();
      this.es = null;
      logger.info('[LiveStore] SSE stream stopped');
    }
  }
}

export const liveStore = new LiveStore();

export { reloadNotifier } from './ComponentReloadNotifier';
export { operationLoadingManager } from './OperationLoadingManager';
export { sendButtonStateManager } from './SendButtonStateManager';
