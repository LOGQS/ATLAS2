// status: complete
import { apiUrl } from '../../config/api';
import logger from '../core/logger';
import { performanceTracker } from '../core/performanceTracker';
import { sendButtonStateManager } from './SendButtonStateManager';
import type { RouterDecision, DomainExecution } from '../../types/messages';
import { ChunkedTextBuffer } from '../text/ChunkedTextBuffer';

export type CoderStreamSegment =
  | {
      id: string;
      iteration: number;
      type: 'thoughts';
      buffer?: ChunkedTextBuffer;
      text?: string;
      status: 'streaming' | 'complete';
    }
  | {
      id: string;
      iteration: number;
      type: 'agent_response';
      buffer?: ChunkedTextBuffer;
      text?: string;
      status: 'streaming' | 'complete';
    }
  | {
      id: string;
      iteration: number;
      type: 'tool_call';
      toolIndex: number;
      status: 'streaming' | 'complete';
      tool?: string;
      reason?: string;
      params: Array<{ name: string; value: string }>;
    };

type CoderStreamPayload = {
  iteration: number;
  segment: 'thoughts' | 'agent_response' | 'tool_call';
  action: 'start' | 'append' | 'complete' | 'field' | 'param' | 'param_update';
  text?: string;
  field?: 'tool' | 'reason';
  value?: string;
  name?: string;
  tool_index?: number;
  toolIndex?: number;
  complete?: boolean;
};

type ChatLive = {
  state: 'thinking' | 'responding' | 'static';
  lastAssistantId: string | null;
  contentBuf: string;
  thoughtsBuf: string;
  routerDecision: RouterDecision | null;
  domainExecution: DomainExecution | null;
  coderStream: CoderStreamSegment[];
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

interface ModelRetryEvent extends BaseSSEEvent {
  type: 'model_retry';
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

interface CoderStreamEvent extends BaseSSEEvent {
  type: 'coder_stream';
  content?: string;
  task_id?: string;
}

interface CoderFileOperationEvent extends BaseSSEEvent {
  type: 'coder_file_operation';
  task_id: string;
  domain_id: string;
  payload: {
    tool_call_id: string;
    operation: 'streaming_write' | 'streaming_edit';
    file_path: string;
    file_existed: boolean;
    decorations: Array<{
      startLine: number;
      endLine: number;
      startColumn: number;
      endColumn: number;
      type: 'add' | 'remove' | 'modify';
      className: string;
    }>;
    content: string;
    metadata: {
      file_size: string;
      file_size_bytes: number;
      lines_added: number;
      lines_removed: number;
    };
  };
}

interface CoderFileRevertEvent extends BaseSSEEvent {
  type: 'coder_file_revert';
  task_id: string;
  domain_id: string;
  payload: {
    file_path: string;
    reverted_to: 'original' | 'deleted';
    content: string;
  };
}

type SSEEvent =
  | ChatStateEvent
  | ContentEvent
  | CompleteEvent
  | MessageIdsEvent
  | FileStateEvent
  | FileSystemEvent
  | RouterDecisionEvent
  | ErrorEvent
  | DomainExecutionEvent
  | DomainExecutionUpdateEvent
  | ModelRetryEvent
  | CoderOperationEvent
  | CoderWorkspacePromptEvent
  | CoderFileChangeEvent
  | CoderStreamEvent
  | CoderFileOperationEvent
  | CoderFileRevertEvent;

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
  private readonly MAX_CODER_STREAM_SEGMENTS = 600;
  private readonly MIN_COMPLETED_ITERATIONS_TO_KEEP = 5;

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

  private handleChatStateEvent(chatId: string, ev: ChatStateEvent, cur: ChatLive): ChatLive {
    const next = { ...cur };
    const oldState = next.state;
    const requestedState = ev.state || 'static';
    next.state = requestedState;
    if (next.state !== 'static') {
      next.error = null;
    }

    if (oldState !== requestedState) {
      const ts = new Date().toISOString();
      logger.info(`[UX_PERF][FRONT] state_transition chat=${chatId} from=${oldState} to=${requestedState} ts=${ts}`);
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
    if (cur.thoughtsBuf.length === 0 && addedContent.length > 0) {
      const ts = new Date().toISOString();
      logger.info(`[UX_PERF][FRONT] first_thoughts_chunk chat=${chatId} size=${addedContent.length} ts=${ts}`);
    }
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
    if (cur.contentBuf.length === 0 && addedContent.length > 0) {
      const ts = new Date().toISOString();
      logger.info(`[UX_PERF][FRONT] first_answer_chunk chat=${chatId} size=${addedContent.length} ts=${ts}`);
    }
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

      // Preserve model_retry if it exists (not sent by backend in domain_execution events)
      // But clear it if status is 'running' (retry succeeded) or terminal states
      const existingRetry = next.domainExecution?.model_retry;
      next.domainExecution = domainExecution;

      if (existingRetry && !domainExecution.model_retry && next.domainExecution) {
        const status = domainExecution.status;
        // Clear retry on success (running) or terminal states (completed/failed/aborted)
        if (status === 'running' || status === 'completed' || status === 'failed' || status === 'aborted') {
          logger.info(`[DOMAIN-EXEC-LIVESTORE] Clearing model_retry due to status: ${status}`);
        } else {
          // Preserve retry for other states (starting, waiting_user)
          next.domainExecution.model_retry = existingRetry;
          logger.info(`[DOMAIN-EXEC-LIVESTORE] Preserved existing model_retry data (status: ${status})`);
        }
      }

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

  private handleCoderStreamEvent(chatId: string, ev: CoderStreamEvent, cur: ChatLive): ChatLive {
    if (!ev.content) {
      logger.warn(`[CODER-STREAM] Missing content payload for chat ${chatId}`);
      return cur;
    }

    let payload: CoderStreamPayload;
    try {
      payload = JSON.parse(ev.content) as CoderStreamPayload;
    } catch (err) {
      logger.error(`[CODER-STREAM] Failed to parse payload for ${chatId}`, err);
      return cur;
    }

    const iteration = payload.iteration;
    const segment = payload.segment;
    const action = payload.action;

    if (typeof iteration !== 'number' || !segment || !action) {
      logger.warn(`[CODER-STREAM] Invalid payload structure for ${chatId}: ${ev.content}`);
      return cur;
    }

    // Log received event with details
    const eventInfo = segment === 'tool_call' && (action === 'param' || action === 'param_update')
      ? `${segment}.${action} (${payload.name}: ${payload.value?.length || 0}b)`
      : segment === 'tool_call' && action === 'field'
      ? `${segment}.${action} (${payload.field}=${payload.value})`
      : `${segment}.${action}`;
    logger.debug(`[SSE-RECV] iter=${iteration}, event=${eventInfo}`);

    const toolIndex = payload.toolIndex ?? payload.tool_index ?? 0;
    const next: ChatLive = {
      ...cur,
      coderStream: [...cur.coderStream],
    };
    let changed = false;

    const ensureSegment = (id: string, factory: () => CoderStreamSegment) => {
      const existingIdx = next.coderStream.findIndex(seg => seg.id === id);
      if (existingIdx !== -1) {
        return { segment: next.coderStream[existingIdx], index: existingIdx };
      }
      const created = factory();
      next.coderStream.push(created);
      changed = true;
      return { segment: created, index: next.coderStream.length - 1 };
    };

    const updateSegment = (index: number, updated: CoderStreamSegment) => {
      changed = true;
      next.coderStream = [
        ...next.coderStream.slice(0, index),
        updated,
        ...next.coderStream.slice(index + 1),
      ];
    };

    const finalizeTextSegment = <T extends Extract<CoderStreamSegment, { type: 'thoughts' | 'agent_response' }>>(seg: T): T => {
      if (seg.buffer) {
        const text = seg.buffer.finalize();
        return { ...seg, buffer: undefined, text };
      }
      return seg;
    };

    if (segment === 'thoughts') {
      const id = `iter-${iteration}-thoughts`;
      const { segment: seg, index } = ensureSegment(id, () => ({
        id,
        iteration,
        type: 'thoughts',
        buffer: new ChunkedTextBuffer(),
        status: 'streaming',
      }));
      const thoughtSeg = seg as Extract<CoderStreamSegment, { type: 'thoughts' }>;

      if (action === 'start') {
        if (thoughtSeg.status !== 'streaming') {
          const updated = { ...thoughtSeg, status: 'streaming' } as typeof thoughtSeg;
          updateSegment(index, updated);
        }
      } else if (action === 'append' && payload.text) {
        if (thoughtSeg.buffer) {
          thoughtSeg.buffer.append(payload.text);
          const updated = { ...thoughtSeg };
          updateSegment(index, updated);
        } else {
          logger.warn(`[CODER-STREAM] Received append for finalized thoughts segment ${id} on chat ${chatId}`);
        }
      } else if (action === 'complete') {
        if (thoughtSeg.status !== 'complete') {
          const updated = { ...finalizeTextSegment(thoughtSeg), status: 'complete' } as typeof thoughtSeg;
          updateSegment(index, updated);
        }
      }
    } else if (segment === 'agent_response') {
      const id = `iter-${iteration}-response`;
      const { segment: seg, index } = ensureSegment(id, () => ({
        id,
        iteration,
        type: 'agent_response',
        buffer: new ChunkedTextBuffer(),
        status: 'streaming',
      }));
      const responseSeg = seg as Extract<CoderStreamSegment, { type: 'agent_response' }>;

      if (action === 'start') {
        if (responseSeg.status !== 'streaming') {
          const updated = { ...responseSeg, status: 'streaming' } as typeof responseSeg;
          updateSegment(index, updated);
        }
      } else if (action === 'append' && payload.text) {
        if (responseSeg.buffer) {
          responseSeg.buffer.append(payload.text);
          const updated = { ...responseSeg };
          updateSegment(index, updated);
        } else {
          logger.warn(`[CODER-STREAM] Received append for finalized agent_response segment ${id} on chat ${chatId}`);
        }
      } else if (action === 'complete') {
        if (responseSeg.status !== 'complete') {
          const updated = { ...finalizeTextSegment(responseSeg), status: 'complete' } as typeof responseSeg;
          updateSegment(index, updated);
        }
      }
    } else if (segment === 'tool_call') {
      const id = `iter-${iteration}-tool-${toolIndex}`;
      const { segment: seg, index } = ensureSegment(id, () => ({
        id,
        iteration,
        type: 'tool_call',
        toolIndex,
        status: 'streaming',
        params: [],
      }));
      const toolSeg = seg as Extract<CoderStreamSegment, { type: 'tool_call' }>;

      if (toolSeg.type !== 'tool_call') {
        logger.warn(`[CODER-STREAM] Segment type mismatch for tool call ${id} on chat ${chatId}`);
        return cur;
      }

      if (action === 'start') {
        if (toolSeg.status !== 'streaming') {
          const updated = { ...toolSeg, status: 'streaming' } as typeof toolSeg;
          updateSegment(index, updated);
        }
      } else if (action === 'field') {
        if (payload.field === 'tool') {
          if ((payload.value || '') !== (toolSeg.tool || '')) {
            const updated = { ...toolSeg, tool: payload.value || '' } as typeof toolSeg;
            updateSegment(index, updated);
          }
        } else if (payload.field === 'reason') {
          if ((payload.value || '') !== (toolSeg.reason || '')) {
            const updated = { ...toolSeg, reason: payload.value || '' } as typeof toolSeg;
            updateSegment(index, updated);
          }
        }
      } else if (action === 'param' && payload.name) {
        const params = toolSeg.params || [];
        const existingIndex = params.findIndex(p => p.name === payload.name);
        let updatedParams: Array<{ name: string; value: string }>;

        if (existingIndex >= 0) {
          // Update existing param (final complete value)
          updatedParams = [...params];
          updatedParams[existingIndex] = { name: payload.name, value: payload.value || '' };
        } else {
          // Add new param
          updatedParams = [...params, { name: payload.name, value: payload.value || '' }];
        }

        const updated = { ...toolSeg, params: updatedParams } as typeof toolSeg;
        updateSegment(index, updated);
      } else if (action === 'param_update' && payload.name) {
        // Incremental parameter update (streaming content)
        const params = toolSeg.params || [];
        const existingIndex = params.findIndex(p => p.name === payload.name);
        let updatedParams: Array<{ name: string; value: string }>;

        if (existingIndex >= 0) {
          // Update existing streaming param
          updatedParams = [...params];
          updatedParams[existingIndex] = { name: payload.name, value: payload.value || '' };
        } else {
          // First chunk of streaming param
          updatedParams = [...params, { name: payload.name, value: payload.value || '' }];
        }

        const updated = { ...toolSeg, params: updatedParams } as typeof toolSeg;
        updateSegment(index, updated);
      } else if (action === 'complete') {
        if (toolSeg.status !== 'complete') {
          const updated = { ...toolSeg, status: 'complete' } as typeof toolSeg;
          updateSegment(index, updated);
        }
      }
    }

    if (changed) {
      next.coderStream = this.pruneCoderStream(next.coderStream);
      next.version = cur.version + 1;
    }
    return next;
  }

  private pruneCoderStream(segments: CoderStreamSegment[]): CoderStreamSegment[] {
    if (segments.length <= this.MAX_CODER_STREAM_SEGMENTS) {
      return segments;
    }

    const iterationInfo = new Map<number, { hasStreaming: boolean; segmentCount: number }>();
    for (const seg of segments) {
      const info = iterationInfo.get(seg.iteration) ?? { hasStreaming: false, segmentCount: 0 };
      info.hasStreaming = info.hasStreaming || seg.status === 'streaming';
      info.segmentCount += 1;
      iterationInfo.set(seg.iteration, info);
    }

    const removableIterations = Array.from(iterationInfo.entries())
      .filter(([, info]) => !info.hasStreaming)
      .map(([iteration]) => iteration)
      .sort((a, b) => a - b);

    if (removableIterations.length <= this.MIN_COMPLETED_ITERATIONS_TO_KEEP) {
      return segments;
    }

    let remainingRemovable = removableIterations.length;
    let currentLength = segments.length;
    const dropIterations = new Set<number>();

    for (const iteration of removableIterations) {
      if (currentLength <= this.MAX_CODER_STREAM_SEGMENTS) {
        break;
      }
      if (remainingRemovable <= this.MIN_COMPLETED_ITERATIONS_TO_KEEP) {
        break;
      }
      dropIterations.add(iteration);
      const info = iterationInfo.get(iteration);
      if (info) {
        currentLength -= info.segmentCount;
      }
      remainingRemovable -= 1;
    }

    if (dropIterations.size === 0) {
      return segments;
    }

    return segments.filter(seg => !dropIterations.has(seg.iteration));
  }

  private handleModelRetryEvent(chatId: string, ev: ModelRetryEvent, cur: ChatLive): ChatLive {
    const next = { ...cur };
    logger.info(`[MODEL-RETRY] Retry event for ${chatId}`);
    try {
      const retryData = JSON.parse(ev.content || '{}');
      logger.info(`[MODEL-RETRY] Attempt ${retryData.attempt}/${retryData.max_attempts}, waiting ${retryData.delay_seconds}s`);
      logger.info(`[MODEL-RETRY] Current domainExecution exists: ${!!next.domainExecution}`);

      // Add retry info to domain execution if it exists
      if (next.domainExecution) {
        next.domainExecution = {
          ...next.domainExecution,
          model_retry: retryData,
        };
        next.version++;
        this.enableParentFromBridge(chatId, 'Model retry');
        logger.info(`[MODEL-RETRY] Updated domainExecution with retry data, version: ${next.version}`);
      } else {
        logger.warn(`[MODEL-RETRY] No domainExecution found for ${chatId}, retry event ignored!`);
      }
    } catch (err) {
      logger.error(`[MODEL-RETRY] Failed to parse retry event for ${chatId}:`, err);
    }
    return next;
  }

  private handleCoderFileOperationEvent(chatId: string, ev: CoderFileOperationEvent, cur: ChatLive): ChatLive {
    logger.info(`[FILE-OP] Received file operation event for ${chatId}`, {
      file: ev.payload?.file_path,
      operation: ev.payload?.operation,
      decorationCount: ev.payload?.decorations?.length || 0,
      contentLength: ev.payload?.content?.length || 0,
    });

    // Emit custom event for file operation
    const customEvent = new CustomEvent('coderFileOperation', {
      detail: {
        chatId,
        ...ev.payload,
      },
    });
    window.dispatchEvent(customEvent);

    // Return unchanged state (file operations are handled by file system watchers)
    return cur;
  }

  private handleCoderFileRevertEvent(chatId: string, ev: CoderFileRevertEvent, cur: ChatLive): ChatLive {
    logger.info(`[FILE-REVERT] Received file revert event for ${chatId}`, {
      file: ev.payload?.file_path,
      revertedTo: ev.payload?.reverted_to,
    });

    // Emit custom event for file revert
    const customEvent = new CustomEvent('coderFileRevert', {
      detail: {
        chatId,
        ...ev.payload,
      },
    });
    window.dispatchEvent(customEvent);

    // Return unchanged state (file reverts are handled by file system watchers)
    return cur;
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

        const cur: ChatLive = this.byChat.get(chatId) ?? ({
          state: 'static',
          lastAssistantId: null,
          contentBuf: '',
          thoughtsBuf: '',
          routerDecision: null,
          domainExecution: null,
          coderStream: [],
          error: null,
          version: 0
        } as ChatLive);

        if (ev.type === 'router_decision') {
          const next = this.handleRouterDecisionEvent(chatId, ev as RouterDecisionEvent, cur);
          logger.info(`[LIVESTORE_SSE] Storing router decision for ${chatId}:`);
          logger.info(`[LIVESTORE_SSE] - Selected route: ${next.routerDecision?.selectedRoute}`);
          logger.info(`[LIVESTORE_SSE] - Available routes: ${next.routerDecision?.availableRoutes.length}`);

          this.byChat.set(chatId, next);
          this.emit(chatId, next, { eventType: ev.type });
          return;
        }

        logger.info(`[LIVESTORE_SSE] Processing ${ev.type} event for chat: ${chatId}`);

        // Debug log for file operation events
        if (ev.type === 'coder_file_operation' || ev.type === 'coder_file_revert') {
          logger.info(`[LIVESTORE_SSE] ${ev.type} event structure:`, {
            hasTaskId: !!(ev as any).task_id,
            hasDomainId: !!(ev as any).domain_id,
            hasPayload: !!(ev as any).payload,
            payloadKeys: (ev as any).payload ? Object.keys((ev as any).payload) : [],
          });
        }

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
          case 'coder_stream':
            next = this.handleCoderStreamEvent(chatId, ev as CoderStreamEvent, cur);
            break;
          case 'coder_file_operation':
            next = this.handleCoderFileOperationEvent(chatId, ev as CoderFileOperationEvent, cur);
            break;
          case 'coder_file_revert':
            next = this.handleCoderFileRevertEvent(chatId, ev as CoderFileRevertEvent, cur);
            break;
          case 'domain_execution':
            next = this.handleDomainExecutionEvent(chatId, ev as DomainExecutionEvent, cur);
            break;
          case 'domain_execution_update':
            next = this.handleDomainExecutionEvent(chatId, ev as DomainExecutionUpdateEvent, cur);
            break;
          case 'model_retry':
            next = this.handleModelRetryEvent(chatId, ev as ModelRetryEvent, cur);
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
      const ts = new Date().toISOString();
      logger.info(`[UX_PERF][FRONT] sse_opened ts=${ts}`);
    };
  }

  beginLocalStream(chatId: string): void {
    const cur: ChatLive = this.byChat.get(chatId) ?? ({
      state: 'static',
      lastAssistantId: null,
      contentBuf: '',
      thoughtsBuf: '',
      routerDecision: null,
      domainExecution: null,
      coderStream: [],
      error: null,
      version: 0
    } as ChatLive);
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
