// status: complete

import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import UserMessage from './UserMessage';
import ThinkBox from './ThinkBox';
import '../styles/Chat.css';
import '../styles/ThinkBox.css';
import logger, { sample, compact } from '../utils/logger';
import { apiUrl } from '../config/api';
import { subscribe } from '../utils/chatstate';
import { streamReconciler } from '../utils/streamReconciler';

// UUID v4 generator without external dependencies
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

// Stream metadata for correlation tracking
type StreamMeta = { sid: string; chatId: string; msgId: number };

function mkStreamMeta(chatId: string, msgId: number): StreamMeta {
  return { sid: generateUUID(), chatId, msgId };
}

interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  thoughts?: string;
  provider?: string;
  model?: string;
  timestamp: string;
  isStreaming?: boolean;
  isStreamingResponse?: boolean;
}

interface ChatProps {
  chatId?: string;
  onMessageSent?: (message: string) => void;
  onChatStateChange?: (chatId: string, state: 'thinking' | 'responding' | 'static') => void;
  onFirstMessageSent?: (chatId: string) => void;
  onActiveStateChange?: (chatId: string, isReallyActive: boolean) => void;
  isActive?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
  firstMessage?: string;
}

let messageIdCounter = 0;
const generateUniqueMessageId = (): number => {
  return Date.now() * 1000 + (messageIdCounter++);
};

// Robust SSE parser that handles CRLF and multi-line events, returns leftover buffer
function drainSSE(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let pos = 0;

  while (true) {
    const nn = buffer.indexOf('\n\n', pos);
    const crlf = buffer.indexOf('\r\n\r\n', pos);
    let sep = -1, adv = 0;

    if (nn !== -1 && (crlf === -1 || nn < crlf)) { sep = nn; adv = 2; }
    else if (crlf !== -1) { sep = crlf; adv = 4; }
    else break; // no full event yet

    const block = buffer.slice(pos, sep);
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');

    if (data.length) events.push(data);
    pos = sep + adv;
  }

  return { events, rest: buffer.slice(pos) };
}


// Overlap-safe append function for handling backend resends (instrumented)
function appendWithOverlap(prev: string, next: string, maxOverlap = 200): string {
  const prevLen = prev?.length ?? 0;
  const nextLen = next?.length ?? 0;
  let used = 0;

  if (!prev) { 
    logger.debug(`[APPEND] prev=0 next=${nextLen} usedOverlap=0 out=${nextLen}`);
    return next || '';
  }
  if (!next) { 
    logger.debug(`[APPEND] prev=${prevLen} next=0 usedOverlap=0 out=${prevLen}`);
    return prev;
  }

  // adapt to long paragraphs
  const dyn = Math.min(Math.max(200, Math.floor(prevLen * 0.25)), 4096);
  const start = Math.max(0, prevLen - dyn);
  const win = prev.slice(start);
  for (let i = Math.min(win.length, next.length); i > 0; i--) {
    if (win.endsWith(next.slice(0, i))) { 
      used = i; 
      break;
    }
  }
  const outLen = prevLen + (nextLen - used);
  logger.debug(`[APPEND] prev=${prevLen} next=${nextLen} overlapWin=${win.length} usedOverlap=${used} out=${outLen}`);
  return used ? prev + next.slice(used) : prev + next;
}

const Chat = forwardRef<any, ChatProps>(({ chatId, onMessageSent, onChatStateChange, onFirstMessageSent, onActiveStateChange, isActive = true, firstMessage }, ref) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<number | null>(null);
  const [config, setConfig] = useState<{provider: string, model: string} | null>(null);
  const [firstMessageSent, setFirstMessageSent] = useState(false);
  const [currentChatState, setCurrentChatState] = useState<'thinking' | 'responding' | 'static'>('static');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const loadedChatRef = useRef<string | null>(null);
  const prevChatIdRef = useRef<string | null>(null);
  const currentLoadingChatRef = useRef<string | null>(null);
  // Track which chat we are currently loading for
  const loadingForChatRef = useRef<string | null>(null);
  // Monotonic request sequence to ignore stale responses
  const requestSeqRef = useRef(0);
  // Dedicated refs for stream ownership (never touched by history loading)
  const streamOwnerChatRef = useRef<string | null>(null);
  const streamOwnerMsgRef = useRef<number | null>(null);
  // Dedicated refs for stream abort management
  const streamAbortRef = useRef<AbortController | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null); // For history loads
  const streamingChatIdRef = useRef<string | null>(null);
  // Stream correlation tracking
  const streamMetaRef = useRef<StreamMeta | null>(null);
  // Message length tracking for audit
  const msgLenRef = useRef<Record<number, number>>({});
  // removed processedChatRef; it caused no-render when re-activating same chat
  // In-flight promise map for coalescing concurrent resumes
  const inFlightResume = useRef<Map<string, Promise<void>>>(new Map());

  const scrollToBottom = useCallback(() => {
    const container = messagesEndRef.current?.parentElement;
    if (container) {
      logger.debug(`[SCROLL] Chat ${chatId} - Before scrollToBottom - scrollTop: ${container.scrollTop}, scrollHeight: ${container.scrollHeight}`);
      container.scrollTop = container.scrollHeight;
      logger.debug(`[SCROLL] Chat ${chatId} - After scrollToBottom - scrollTop: ${container.scrollTop}`);
    }
  }, [chatId]);

  // Text length growth audit function
  const auditLen = useCallback((msgId: number, newText: string, label: string, sid: string, seq: number) => {
    const prev = msgLenRef.current[msgId] ?? 0;
    const now = newText.length;

    // Treat decreases as a WARN (races can legitimately reorder baselines)
    if (now < prev) {
      logger.warn(`[AUDIT/len] sid=${sid} seq=${seq} msg=${msgId} ${label} lengthDecreased ${prev}->${now}`);
      // reset baseline to avoid cascading warnings
      msgLenRef.current[msgId] = now;
      return;
    }
    msgLenRef.current[msgId] = now;
  }, []);



  // Common chunk processing function to avoid duplication
  const processChunk = useCallback((chunk: any, _assistantMessageId: number, _targetChatId: string, meta?: StreamMeta, seq?: number) => {
    const curChat = streamOwnerChatRef.current;
    const curMsg  = streamOwnerMsgRef.current;

    logger.info(`[CHUNK/owner] expChat=${curChat} expMsg=${curMsg} curChat=${curChat} curMsg=${curMsg}`);

    if (!curChat || curMsg == null) return null;

    // Enhanced route-guard: require valid stream ownership
    // Block if chunk lacks chat_id OR if chat_id doesn't match current owner
    if (!chunk.chat_id || chunk.chat_id !== curChat) {
      logger.info(`[DIA][CHUNK-drop] sid=${meta?.sid} seq=${seq} got.chat=${chunk.chat_id || 'MISSING'} owner.chat=${curChat} reason=${!chunk.chat_id ? 'missing_chat_id' : 'chat_mismatch'}`);
      return null;
    }
    
    // Additional stream ID validation if available
    if (meta?.sid && streamMetaRef.current?.sid && meta.sid !== streamMetaRef.current.sid) {
      logger.info(`[DIA][CHUNK-drop] sid=${meta.sid} expected=${streamMetaRef.current.sid} reason=stream_mismatch`);
      return null;
    }

    // ===== states =====
    if (chunk.type === 'chat_state') {
      logger.info(`[STATE] sid=${meta?.sid ?? 'n/a'} state=${chunk.state} chat_id=${chunk.chat_id}`);
      onChatStateChange?.(chunk.chat_id ?? curChat, chunk.state);
      return null;
    }

    // Buffer first
    if (chunk.type === 'thoughts') {
      streamReconciler.push(curChat, 'thoughts', chunk.content || '');
    } else if (chunk.type === 'answer') {
      streamReconciler.push(curChat, 'content', chunk.content || '');
    } else if (chunk.type === 'complete') {
      logger.info(`[DIA][CHUNK-complete] chat=${curChat} msg=${curMsg}`);
      logger.info(`[CHUNK] Received COMPLETE chunk for chat ${curChat}, messageId: ${curMsg}`);
      streamReconciler.clear(curChat);
      return 'complete';
    } else if (chunk.type === 'error') {
      logger.error(`[CHUNK] Received ERROR chunk for chat ${curChat}, messageId: ${curMsg}:`, chunk.content);
      return 'error';
    }

    // Then patch UI against the **current** owner id
    if (chunk.type === 'thoughts' || chunk.type === 'answer') {
      if (sample('CHUNK-apply', 10)) logger.info(
        `[DIA][CHUNK-apply] sid=${meta?.sid} seq=${seq} type=${chunk.type} owner.chat=${curChat} owner.msg=${curMsg} ` +
        `deltaLen=${(chunk.content||'').length} buf=${streamReconciler.debugState(curChat)}`
      );
      setMessages(prev => prev.map(msg => {
        if (msg.id !== curMsg) return msg;
        
        // Get both current UI text and reconciler buffer
        const currentField = chunk.type === 'thoughts' ? msg.thoughts : msg.content;
        const reconciledText = streamReconciler.getBufferedText(curChat, chunk.type === 'thoughts' ? 'thoughts' : 'content');
        
        // Use the longer of the two as the base to prevent content regression
        const baseText = (reconciledText?.length ?? 0) > (currentField?.length ?? 0) ? reconciledText : currentField;
        const nextText = appendWithOverlap(baseText || '', chunk.content || '');
        
        // Prevent content shrinkage - if nextText is shorter than both current and reconciled, keep current
        if (nextText.length < Math.max(currentField?.length ?? 0, reconciledText?.length ?? 0)) {
          logger.warn(`[CHUNK/prevent-shrink] sid=${meta?.sid} seq=${seq} type=${chunk.type} keeping longer text cur=${currentField?.length} rec=${reconciledText?.length} next=${nextText.length}`);
          return msg; // Don't apply shrinking change
        }
        
        if (meta && typeof seq === 'number') {
          auditLen(curMsg, nextText, chunk.type === 'thoughts' ? 'thoughts' : 'content', meta.sid, seq);
        }
        return chunk.type === 'thoughts'
          ? { ...msg, thoughts: nextText }
          : { ...msg, isStreaming: false, isStreamingResponse: true, content: nextText };
      }));
    }

    return null;
  }, [onChatStateChange, auditLen]);

  const resumeStream = useCallback(async (targetChatId: string, assistantMessageId: number) => {
    logger.info(`[resumeStream] ===== RESUME STREAM CALLED =====`);
    logger.info(`[resumeStream] Chat: ${targetChatId}, Message ID: ${assistantMessageId}`);
    
    if (!isActive || !mountedRef.current) {
      logger.warn(`[resumeStream] CANNOT RESUME - isActive: ${isActive}, mounted: ${mountedRef.current}`);
      return;
    }

    if (streamingChatIdRef.current === targetChatId && streamAbortRef.current) {
      logger.info(`[STREAM/reuse] chat=${targetChatId} sid=${streamMetaRef.current?.sid ?? 'n/a'} (already attached)`);
      return;
    }

    // Create stream metadata for correlation
    const meta = mkStreamMeta(targetChatId, assistantMessageId);
    logger.info(`[STREAM/open] sid=${meta.sid} chat=${meta.chatId} msg=${meta.msgId}`);
    
    // Detect duplicate streams
    if (streamingChatIdRef.current && streamingChatIdRef.current === meta.chatId) {
      logger.warn(`[STREAM/dup] sid=${meta.sid} existingStreamForChat=${streamingChatIdRef.current} existingSid=${streamMetaRef.current?.sid ?? 'n/a'}`);
    }

    logger.info(`[resumeStream] Connecting to backend stream for chat: ${targetChatId}`);
    
    const abortController = new AbortController();
    try {
      logger.info(`[STREAM/acquire] sid=${meta.sid} chat=${meta.chatId} msg=${meta.msgId}`);
      setStreamingMessageId(assistantMessageId);
      // Set stream ownership (never touched by history loading)
      streamOwnerChatRef.current = targetChatId;
      streamOwnerMsgRef.current = assistantMessageId;
      // Set dedicated stream abort refs
      streamAbortRef.current = abortController;
      streamingChatIdRef.current = targetChatId;
      streamMetaRef.current = meta;
      
      logger.info(
        `[DIA][RESUME-own] sid=${meta.sid} chat=${targetChatId} msg=${assistantMessageId} ` +
        `buf=${streamReconciler.debugState(targetChatId)}`
      );
      
      // Connect to ongoing stream with simple attach (no message, no resume)
      const response = await fetch(apiUrl('/api/chat/stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: targetChatId
        }),
        signal: abortController.signal
      });

      if (!response.ok) {
        logger.error('Server response not ok:', response.status);
        throw new Error('Failed to get response from server');
      }
      
      logger.info('Started receiving resume streaming response');

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No response body');
      }

      let buffer = '';
      let seq = 0;

      while (true) {
        const { done, value } = await reader.read();
        
        logger.debug(`[DIA][RESUME-read] sid=${meta.sid} done=${done} bytes=${value?.length ?? 0}`);
        // Byte-level logging
        logger.debug(`[STREAM/read] sid=${meta.sid} bytes=${value?.length ?? 0} done=${done}`);
        
        if (done) {
          buffer += decoder.decode(value || new Uint8Array(), { stream: false });
          const { events, rest } = drainSSE(buffer);
          // SSE framing logging
          if (sample('STREAM/drain', 5)) logger.info(`[STREAM/drain] sid=${meta.sid} events=${events.length} restLen=${rest.length}`);
          
          for (const payload of events) {
            seq++;
            if (sample('STREAM/event', 20)) logger.info(`[STREAM/event] sid=${meta.sid} seq=${seq} rawPreview="${compact(payload, 120)}"`);
            
            try {
              const chunk = JSON.parse(payload);
              const result = processChunk(chunk, assistantMessageId, targetChatId, meta, seq);
              
              if (result === 'complete') {
                logger.info(`[resumeStream] Stream complete for chat ${targetChatId}, resetting states`);
                setStreamingMessageId(null);
                setLoading(false);
                onChatStateChange?.(targetChatId, 'static');
              } else if (result === 'error') {
                logger.error('Stream error:', chunk.content);
                setLoading(false);
                setStreamingMessageId(null);
                if (onChatStateChange) {
                  onChatStateChange(targetChatId, 'static');
                }
              }
            } catch (e) {
              logger.error('Error parsing final chunk:', e);
            }
          }
          buffer = rest; // should be "", but safe even if backend ends mid-chunk
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = drainSSE(buffer);
        // SSE framing logging  
        if (sample('STREAM/drain', 5)) logger.info(`[STREAM/drain] sid=${meta.sid} events=${events.length} restLen=${rest.length}`);
        
        for (const payload of events) {
          seq++;
          if (sample('STREAM/event', 20)) logger.info(`[STREAM/event] sid=${meta.sid} seq=${seq} rawPreview="${compact(payload, 120)}"`);
          
          try {
            const chunk = JSON.parse(payload);
            const result = processChunk(chunk, assistantMessageId, targetChatId, meta, seq);
            
            if (result === 'complete') {
              logger.info(`[resumeStream] Stream complete for chat ${targetChatId}`);
              setStreamingMessageId(null);
              setLoading(false);
              onChatStateChange?.(targetChatId, 'static');
            } else if (result === 'error') {
              logger.error('Stream error:', chunk.content);
              setLoading(false);
              setStreamingMessageId(null);
            }
          } catch (e) {
            logger.error('Error parsing resume chunk:', e);
          }
        }
        buffer = rest; // keep exact leftover bytes (no drops)
      }
    } catch (error) {
      // Enhanced error logging with stream metadata
      if (error instanceof Error) {
        logger.info(`[STREAM/catch] sid=${meta.sid} name=${error.name} message=${error.message}`);
        if (error.name === 'AbortError') {
          logger.info(`[DIA][RESUME-abort] sid=${meta.sid} chat=${targetChatId}`);
          logger.info(`[resumeStream] Stream aborted for chat ${targetChatId} (client disconnected, backend continues)`);
          return; // Exit early, don't update UI state
        } else {
          logger.error(`[resumeStream] Error for chat ${targetChatId}:`, error);
        }
      }
      
      setLoading(false);
      setStreamingMessageId(null);
      
      if (onChatStateChange) {
        onChatStateChange(targetChatId, 'static');
      }
      
      setMessages(prev => prev.map(msg => 
        msg.id === assistantMessageId 
          ? { 
              ...msg, 
              isStreaming: false,
              isStreamingResponse: false,
              content: msg.content || 'Error: Failed to resume stream from server' 
            }
          : msg
      ));
    } finally {
      // Clear dedicated stream abort refs if this is the current stream
      if (streamAbortRef.current === abortController) {
        streamAbortRef.current = null;
      }
      if (streamingChatIdRef.current === targetChatId) {
        streamingChatIdRef.current = null;
      }
      // Only clear stream ownership if this stream is still the owner
      if (streamOwnerChatRef.current === targetChatId && streamOwnerMsgRef.current === assistantMessageId) {
        streamOwnerChatRef.current = null;
        streamOwnerMsgRef.current = null;
      }
    }
  }, [isActive, processChunk, onChatStateChange]);

  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    const container = messagesEndRef.current?.parentElement;
    if (container) {
      logger.debug(`[SCROLL] Chat ${chatId} useEffect[messages] - Current scroll position: ${container.scrollTop}, scrollHeight: ${container.scrollHeight}, messages.length: ${messages.length}`);
    }
    if (lastMessage && (lastMessage.isStreaming || lastMessage.isStreamingResponse)) {
      logger.debug(`[SCROLL] Chat ${chatId} useEffect[messages] - triggering scrollToBottom because message is streaming`);
      scrollToBottom();
    }
  }, [messages, chatId, scrollToBottom]);

  useEffect(() => {
    if (streamingMessageId) {
      logger.debug(`[SCROLL] Chat ${chatId} useEffect[streamingMessageId] - triggering scrollToBottom for messageId: ${streamingMessageId}`);
      scrollToBottom();
    }
  }, [streamingMessageId, chatId, scrollToBottom]);

  useEffect(() => {
    if (!chatId) return;
    const off = subscribe((id, state) => {
      if (id === chatId) {
        setCurrentChatState(state);
      }
    });
    return off;
  }, [chatId]);

  useEffect(() => {
    // Only load config once
    if (config) return;
    
    const loadConfig = async () => {
      try {
        const response = await fetch(apiUrl('/api/db/config'));
        const data = await response.json();
        if (response.ok) {
          setConfig({ provider: data.provider, model: data.model });
          logger.info('Loaded config:', data);
        } else {
          logger.error('Failed to load config:', data.error);
          setConfig({ provider: 'gemini', model: 'gemini-2.5-flash' });
        }
      } catch (error) {
        logger.error('Failed to load config:', error);
        setConfig({ provider: 'gemini', model: 'gemini-2.5-flash' });
      }
    };
    loadConfig();
  }, [config]);

  const loadChatHistoryImmediate = useCallback(async (targetChatId: string, retryCount = 0): Promise<Message[]> => {
    if (!targetChatId) return [];
    
    // Allow only one loader per target chat; do not block other chats
    if (loadingForChatRef.current === targetChatId) {
      logger.info(`[Chat.loadChatHistoryImmediate] Already loading history for chat: ${targetChatId}`);
      return [];
    }
    
    const abortController = new AbortController();
    historyAbortRef.current = abortController;
    
    // Add abort listener to track when this gets aborted
    abortController.signal.addEventListener('abort', () => {
      logger.info(`[loadChatHistoryImmediate] AbortController aborted for ${targetChatId} - reason: ${abortController.signal.reason || 'unknown'}`);
    });
    
    const seq = ++requestSeqRef.current;
    loadingForChatRef.current = targetChatId;
    setIsLoadingHistory(true);
    
    try {
      logger.info('[Chat.loadChatHistoryImmediate] Loading chat history for:', targetChatId);
      
      // Load backend state first - this is the source of truth
      logger.info(`[loadChatHistoryImmediate] Making state fetch for ${targetChatId}`);
      const stateResponse = await fetch(apiUrl(`/api/db/chat/${targetChatId}/state`), { signal: abortController.signal });
      logger.info(`[loadChatHistoryImmediate] State fetch completed for ${targetChatId}`);
      
      let chatState: 'thinking' | 'responding' | 'static' = 'static';
      if (stateResponse.ok) {
        const stateData = await stateResponse.json();
        chatState = (stateData.state as 'thinking' | 'responding' | 'static') || 'static';
        logger.info(`[loadChatHistoryImmediate] Backend state for chat ${targetChatId}: ${chatState}`);
      }
      
      // Load latest history from database (always fresh from backend)
      logger.info(`[loadChatHistoryImmediate] Making history fetch for ${targetChatId}`);
      const historyResponse = await fetch(apiUrl(`/api/db/chat/${targetChatId}`), { signal: abortController.signal });
      logger.info(`[loadChatHistoryImmediate] History fetch completed for ${targetChatId}`);
      
      if (historyResponse.ok) {
        const data = await historyResponse.json();
        
        logger.info(
          `[DIA][DB-snap] chat=${targetChatId} state=${chatState} msgs=${data.history.length} ` +
          `buf=${streamReconciler.debugState(targetChatId)}`
        );
        
        if (chatState !== 'thinking' && chatState !== 'responding') {
          setStreamingMessageId(null);
          setLoading(false);
        }
        
        // Format messages based on latest database content and backend state
        const formattedMessages: Message[] = data.history.map((msg: any, index: number) => {
          const isLastAssistant = msg.role === 'assistant' && index === data.history.length - 1;
          
          return {
            id: msg.id || generateUniqueMessageId(),
            role: msg.role,
            content: msg.content || '',
            thoughts: msg.thoughts || '',
            provider: msg.provider,
            model: msg.model,
            timestamp: msg.timestamp,
            // UI streaming flags based on backend state
            isStreaming: isLastAssistant && chatState === 'thinking',
            isStreamingResponse: isLastAssistant && chatState === 'responding'
          };
        });
        
        // Ignore stale responses from a previous switch
        if (requestSeqRef.current !== seq || loadingForChatRef.current !== targetChatId) {
          logger.info(`[Chat.loadChatHistoryImmediate] Stale response ignored for ${targetChatId}`);
          return [];
        }
        
        logger.info(`[loadChatHistoryImmediate] ===== DB LOAD COMPLETE =====`);
        logger.info(`[loadChatHistoryImmediate] Loaded ${formattedMessages.length} messages for chat ${targetChatId}`);
        logger.info(`[loadChatHistoryImmediate] Backend state: ${chatState}`);
        logger.info(`[loadChatHistoryImmediate] Message details:`, formattedMessages.map(m => ({
          id: m.id, 
          role: m.role, 
          content: m.content.substring(0, 50) + '...', 
          isStreaming: m.isStreaming,
          isStreamingResponse: m.isStreamingResponse
        })));
        // Find the DB's current last assistant (if any)
        const lastAssistant = [...formattedMessages].reverse().find(m => m.role === 'assistant');

        // If this chat owns an active stream, retarget the reconciler **before** merging
        if (streamOwnerChatRef.current === targetChatId && lastAssistant) {
          const oldId = streamOwnerMsgRef.current;
          if (oldId && oldId !== lastAssistant.id) {
            // Synchronize both reconciler buffer and owner refs atomically
            streamReconciler.retarget(targetChatId, lastAssistant.id);
            streamOwnerMsgRef.current = lastAssistant.id;
            setStreamingMessageId(lastAssistant.id);
            
            // carry over audit baseline to the new id to avoid false "decrease"
            msgLenRef.current[lastAssistant.id] = msgLenRef.current[oldId] ?? 0;
            delete msgLenRef.current[oldId];
            
            logger.info(`[OWNER/retarget] chat=${targetChatId} oldMsg=${oldId} newMsg=${lastAssistant.id} bufferSynced=true`);
            
            // Verify synchronization
            const bufferState = streamReconciler.debugState(targetChatId);
            if (!bufferState.includes(`msgId:${lastAssistant.id}`)) {
              logger.error(`[OWNER/retarget-sync-fail] expected msgId:${lastAssistant.id} but got ${bufferState}`);
            }
          } else if (oldId === lastAssistant.id) {
            // Already synchronized, just update UI reference
            setStreamingMessageId(lastAssistant.id);
            logger.info(`[OWNER/already-synced] chat=${targetChatId} msg=${lastAssistant.id}`);
          }
        }

        // NOW merge, so buffer lands on the correct message id
        logger.info(`[loadChatHistoryImmediate] CALLING setMessages - FRONTEND SHOULD NOW SHOW ${formattedMessages.length} MESSAGES`);
        const merged = streamReconciler.mergeSnapshot(targetChatId, formattedMessages);
        
        const lastA = [...merged].reverse().find(m => m.role==='assistant');
        logger.info(
          `[DIA][DB-merge] chat=${targetChatId} merged.msgs=${merged.length} lastAid=${lastA?.id ?? 'none'} ` +
          `lastAlen=${lastA?.content?.length ?? 0} buf=${streamReconciler.debugState(targetChatId)}`
        );
        
        logger.info(`[DIA][DB-apply] chat=${targetChatId} applying merged snapshot to UI`);
        
        // Commit snapshot correctly; preserve longer text if we already have something
        setMessages(prev => {
          if (prev.length === 0) return merged;        // ← render the DB snapshot on cold render

          const mergedById = new Map(merged.map(m => [m.id, m]));
          const out = prev.map(p => {
            const m = mergedById.get(p.id);
            if (!m) return p;
            const content  = (m.content?.length  ?? 0) >= (p.content?.length  ?? 0) ? m.content  : p.content;
            const thoughts = (m.thoughts?.length ?? 0) >= (p.thoughts?.length ?? 0) ? m.thoughts : p.thoughts;
            return { ...p, ...m, content, thoughts };
          });

          // Append any DB messages that weren't in prev (e.g., when returning from another chat)
          const prevIds = new Set(prev.map(p => p.id));
          for (const m of merged) if (!prevIds.has(m.id)) out.push(m);

          return out;
        });

        // Optional: after applying the snapshot, reset audit baselines to current UI
        for (const m of merged) {
          msgLenRef.current[m.id] = Math.max(msgLenRef.current[m.id] ?? 0, (m.content?.length ?? 0));
        }


        logger.info(
          `[DIA][DB-retarget] chat=${targetChatId} newOwnerMsg=${streamOwnerMsgRef.current} ` +
          `buf=${streamReconciler.debugState(targetChatId)}`
        );

        loadedChatRef.current = targetChatId;
        logger.info(
          `[DIA][DB-done] chat=${targetChatId} loadedChatRef=${loadedChatRef.current} ` +
          `isLoadingHistory=${isLoadingHistory}`
        );
        logger.info(`[loadChatHistoryImmediate] ===== DB LOAD & RENDER COMPLETE =====`);
        
        // Update parent component with backend state
        if (onChatStateChange) {
          onChatStateChange(targetChatId, chatState);
        }
        
        return formattedMessages;
        
      } else if (historyResponse.status === 404) {
        logger.info(`[loadChatHistoryImmediate] Chat ${targetChatId} not found, starting fresh`);
        setMessages([]);
        loadedChatRef.current = targetChatId;
        
        // Ensure parent knows this is a static chat
        if (onChatStateChange) {
          onChatStateChange(targetChatId, 'static');
        }
        
        return [];
      } else {
        const errorData = await historyResponse.json();
        logger.error('Failed to load chat history:', errorData.error);
        return [];
      }
    } catch (error) {
      // Don't log AbortError as it's expected when switching chats
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('Chat history loading aborted (expected when switching chats)');
        return []; // Exit early, don't update UI state
      } else {
        logger.error('Failed to load chat history:', error);
      }
      
      if (!abortController.signal.aborted) {
        setMessages([]); // ensure UI renders even on error
      }
      
      return [];
    } finally {
      if (historyAbortRef.current === abortController) {
        historyAbortRef.current = null;
      }
      if (loadingForChatRef.current === targetChatId) loadingForChatRef.current = null;
      setIsLoadingHistory(false);
    }
  }, [isLoadingHistory, onChatStateChange]);



  // Keep a stable mirror of messages
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const checkAndResumeStreaming = useCallback(async (targetChatId: string, messagesFromDB?: Message[]) => {
    // Coalesce concurrent calls
    const existing = inFlightResume.current.get(targetChatId);
    if (existing) {
      logger.debug(`[checkAndResumeStreaming] Coalesced duplicate call for ${targetChatId}`);
      await existing;
      return;
    }

    const run = (async () => {
      logger.info(`[checkAndResumeStreaming] ===== CHECKING IF SHOULD RESUME STREAMING =====`);
      logger.info(`[checkAndResumeStreaming] Target chat: ${targetChatId}`);
      
      // 1) Read authoritative state from backend
      logger.info(`[checkAndResumeStreaming] Reading backend state...`);
      const stateRes = await fetch(apiUrl(`/api/db/chat/${targetChatId}/state`));
      const stateJson = await stateRes.json();
      const chatState = stateRes.ok ? (stateJson.state as 'thinking' | 'responding' | 'static') : 'static';

      logger.info(`[DIA][RESUME-check] chat=${targetChatId} state=${chatState}`);
      logger.info(`[checkAndResumeStreaming] Backend state for chat ${targetChatId}: ${chatState}`);

      // 2) If not active, ensure UI reflects static state
      if (chatState !== 'thinking' && chatState !== 'responding') {
        logger.info(`[checkAndResumeStreaming] Chat ${targetChatId} is STATIC - no streaming needed`);
        if (onChatStateChange) onChatStateChange(targetChatId, 'static');
        return;
      }

      // 3) If backend is actively processing, (re)connect to stream RIGHT NOW
      const useMessages = messagesFromDB || messagesRef.current;
      const lastAssistant = [...useMessages].reverse().find(m => m.role === 'assistant');

      if (lastAssistant) {
        logger.info(`[DIA][RESUME-attach] chat=${targetChatId} lastAid=${lastAssistant.id} len=${lastAssistant.content.length} buf=${streamReconciler.debugState(targetChatId)}`);
        // Normal path (we already have something to attach to)
        streamReconciler.begin(targetChatId);
        streamReconciler.setActiveMessage(targetChatId, lastAssistant.id);
        setStreamingMessageId(lastAssistant.id);
        setMessages(prev => prev.map(m =>
          m.id === lastAssistant.id
            ? { ...m, isStreaming: chatState === 'thinking', isStreamingResponse: chatState === 'responding' }
            : m
        ));
        resumeStream(targetChatId, lastAssistant.id);
        onChatStateChange?.(targetChatId, chatState);
      } else {
        // COLD START: no assistant message yet (DB not loaded or empty). Create a placeholder and attach.
        const placeholderId = generateUniqueMessageId();
        logger.info(`[DIA][RESUME-cold] chat=${targetChatId} placeholderId=${placeholderId} buf=${streamReconciler.debugState(targetChatId)}`);
        logger.info(`[RESUME/cold-start] chat=${targetChatId} placeholderMsgId=${placeholderId}`);
        const placeholder = {
          id: placeholderId,
          role: 'assistant' as const,
          content: '',
          thoughts: '',
          timestamp: new Date().toISOString(),
          isStreaming: chatState === 'thinking',
          isStreamingResponse: chatState === 'responding'
        };
        streamReconciler.begin(targetChatId);
        streamReconciler.setActiveMessage(targetChatId, placeholderId);
        setMessages(prev => [...prev, placeholder]);
        setStreamingMessageId(placeholderId);
        // take ownership for now; we will retarget to DB message id after snapshot lands
        streamOwnerChatRef.current = targetChatId;
        streamOwnerMsgRef.current = placeholderId;
        resumeStream(targetChatId, placeholderId);
        onChatStateChange?.(targetChatId, chatState);
      }
    })();

    inFlightResume.current.set(targetChatId, run);
    try { await run; } finally { inFlightResume.current.delete(targetChatId); }
  }, [resumeStream, onChatStateChange]);

  const streamAIResponse = useCallback(async (userMessage: string) => {
    if (!isActive || !mountedRef.current) {
      logger.warn('Attempted to stream response to inactive/unmounted chat:', chatId, 'isActive:', isActive, 'mounted:', mountedRef.current);
      return;
    }

    if (!config) {
      logger.error('Config not loaded yet');
      return;
    }
    
    let abortController: AbortController | undefined;
    let assistantMessageId: number = 0;
    try {
      logger.info('Starting AI response stream for:', userMessage.substring(0, 50) + '...');
      assistantMessageId = generateUniqueMessageId();
      
      const userMsg: Message = {
        id: generateUniqueMessageId(),
        role: 'user',
        content: userMessage,
        timestamp: new Date().toISOString(),
        isStreaming: false,
        isStreamingResponse: false
      };
      
      
      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        thoughts: '',
        timestamp: new Date().toISOString(),
        isStreaming: true,
        isStreamingResponse: false,
        provider: config.provider,
        model: config.model
      };

      logger.debug(`[SCROLL] Chat ${chatId} - Adding new user and assistant messages to state`);
      setMessages(prev => [...prev, userMsg, assistantMessage]);
      setStreamingMessageId(assistantMessageId);
      
      // Set stream ownership (never touched by history loading)
      streamOwnerChatRef.current = chatId || null;
      streamOwnerMsgRef.current = assistantMessageId;
      abortController = new AbortController();
      // Set dedicated stream abort refs
      streamAbortRef.current = abortController;
      streamingChatIdRef.current = chatId || null;
      
      // Set active message for stream reconciler
      if (chatId) {
        streamReconciler.begin(chatId);
        streamReconciler.setActiveMessage(chatId, assistantMessageId);
      }
      
      const response = await fetch(apiUrl('/api/chat/stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: userMessage,
          chat_id: chatId,
          provider: config.provider,
          model: config.model,
          include_reasoning: true
        }),
        signal: abortController.signal
      });

      if (!response.ok) {
        logger.error('Server response not ok:', response.status);
        throw new Error('Failed to get response from server');
      }
      
      logger.info('Started receiving streaming response');

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No response body');
      }

      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          buffer += decoder.decode(value || new Uint8Array(), { stream: false });
          const { events, rest } = drainSSE(buffer);
          for (const payload of events) {
            try {
              const chunk = JSON.parse(payload);
              const result = processChunk(chunk, assistantMessageId, chatId!);
              
              if (result === 'complete') {
                logger.info(`[STREAM] Completion signal received for chat ${chatId}`);
                setStreamingMessageId(null);
                setLoading(false);
                onChatStateChange?.(chatId!, 'static');
              }
            } catch (e) {
              logger.error('Error parsing final chunk:', e);
            }
          }
          buffer = rest; // should be "", but safe even if backend ends mid-chunk
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = drainSSE(buffer);
        for (const payload of events) {
          try {
            const chunk = JSON.parse(payload);
            const result = processChunk(chunk, assistantMessageId, chatId!);
            
            if (result === 'complete') {
              logger.info(`[STREAM] Main loop completion signal received for chat ${chatId}, messageId ${assistantMessageId}`);
              setStreamingMessageId(null);
              setLoading(false);
              onChatStateChange?.(chatId!, 'static');
              logger.info(`[STREAM] Main loop streaming complete for chat ${chatId}, all states reset`);
            }
          } catch (e) {
            logger.error('Error parsing chunk:', e);
          }
        }
        buffer = rest; // keep exact leftover bytes (no drops)
      }
    } catch (error) {
      
      // Don't log AbortError as it's expected when switching chats
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info(`[streamAIResponse] Stream aborted for chat ${chatId} (client disconnected, backend continues)`);
        return; // Exit early, don't update UI state
      } else {
        logger.error(`[streamAIResponse] Error for chat ${chatId}:`, error);
      }
      
      setLoading(false);
      setStreamingMessageId(null);
      
      setMessages(prev => prev.map(msg => 
        msg.isStreaming 
          ? { 
              ...msg, 
              isStreaming: false, 
              content: msg.content || 'Error: Failed to get response from server' 
            }
          : msg
      ));
    } finally {
      // Clear dedicated stream abort refs if this is the current stream
      if (abortController && streamAbortRef.current === abortController) {
        streamAbortRef.current = null;
      }
      if (streamingChatIdRef.current === chatId) {
        streamingChatIdRef.current = null;
      }
      // Only clear stream ownership if this stream is still the owner
      if (streamOwnerChatRef.current === chatId && streamOwnerMsgRef.current === assistantMessageId) {
        streamOwnerChatRef.current = null;
        streamOwnerMsgRef.current = null;
      }
    }
  }, [isActive, config, chatId, processChunk, onChatStateChange]);

  const handleNewMessage = useCallback((content: string) => {
    logger.info(`[SEND] ==================== MESSAGE SEND ATTEMPT ====================`);
    logger.info(`[SEND] handleNewMessage called for chat ${chatId}: "${content.substring(0, 50)}"`);
    logger.info(`[SEND] Current state - isActive: ${isActive}, loading: ${loading}, streamingMessageId: ${streamingMessageId}`);
    logger.info(`[SEND] Current chat state: ${currentChatState}`);
    
    if (!isActive) {
      logger.warn(`[SEND] BLOCKED: Chat ${chatId} is not active`);
      return;
    }

    // Prevent sending while streaming or loading history
    if (loading) {
      logger.warn(`[SEND] BLOCKED: Chat ${chatId} still streaming`);
      return;
    }

    if (streamingMessageId !== null) {
      logger.warn(`[SEND] BLOCKED: Chat ${chatId} has an active stream (streamingMessageId=${streamingMessageId})`);
      return;
    }

    if (isLoadingHistory && (!firstMessage || firstMessageSent)) {
      logger.warn(`[SEND] BLOCKED: Chat ${chatId} still loading history`);
      return;
    }

    logger.info(`[SEND] ==================== PROCEEDING WITH MESSAGE SEND ====================`);
    logger.info(`[SEND] Proceeding with send for chat ${chatId}: "${content.substring(0, 50)}"`);
    logger.info(`[SEND] Setting loading: true for chat ${chatId}`);
    logger.info(`[SEND] Previous loading state: ${loading} -> true`);
    setLoading(true);

    streamAIResponse(content);
    
    if (onMessageSent) {
      onMessageSent(content);
    }
  }, [chatId, isActive, loading, isLoadingHistory, streamingMessageId, currentChatState, streamAIResponse, onMessageSent, firstMessage, firstMessageSent]);

  useImperativeHandle(ref, () => ({
    handleNewMessage,
    isBusy: () => Boolean(
      loading ||
      isLoadingHistory ||
      streamingMessageId !== null
    )
  }));

  useEffect(() => {
    logger.debug(`[Chat.useEffect1] === EFFECT TRIGGERED ===`);
    logger.debug(`[Chat.useEffect1] chatId: ${chatId}, isActive: ${isActive}, firstMessage: ${!!firstMessage}`);
    // Always handle activation; do not skip. Rendering must never depend on past state.
    
    logger.debug(`[Chat.useEffect1] loadedChatRef.current: ${loadedChatRef.current}`);
    logger.debug(`[Chat.useEffect1] currentLoadingChatRef.current: ${currentLoadingChatRef.current}`);
    
    mountedRef.current = true;

    const isNewChat = !!(chatId && firstMessage);
    const isDifferentChat = prevChatIdRef.current !== chatId;
    
    // If a different chat becomes active, abort any in-flight operations for the old one
    if (isDifferentChat) {
      logger.debug(`[Chat.useEffect1] Aborting operations for previous chat ${prevChatIdRef.current} before switching to ${chatId}`);
      streamAbortRef.current?.abort('switching chats');   // stop stream
      historyAbortRef.current?.abort('switching chats');  // stop DB load
      
      // IMMEDIATELY null out stream ownership refs to prevent cross-chat pollution
      streamOwnerChatRef.current = null;
      streamOwnerMsgRef.current = null;
      streamingChatIdRef.current = null;
      streamMetaRef.current = null;
      
      // Clear reconciler for prev chat and begin for new
      if (prevChatIdRef.current) streamReconciler.clear(prevChatIdRef.current);
      if (chatId) streamReconciler.begin(chatId);
      
      logger.info(
        `[DIA][SWITCH] from=${prevChatIdRef.current} -> to=${chatId} ` +
        `clearedPrevBuf=${!!prevChatIdRef.current} newBuf=${chatId ? streamReconciler.debugState(chatId) : 'n/a'} ` +
        `clearedOwnership=true`
      );
    }
    
    logger.debug(`[Chat.useEffect1] isNewChat: ${isNewChat}, isDifferentChat: ${isDifferentChat}`);
    
    // No processed flag. We always reload on activation.

    if (!chatId || !isActive) {
      logger.debug(`[Chat.useEffect1] EARLY RETURN - chatId: ${chatId}, isActive: ${isActive}`);
      return;
    }

    // No processed marker.

    if (isNewChat && isDifferentChat) {
      logger.info(`[DIA][SWITCH-branch] new=${isNewChat} diff=${isDifferentChat} active=${isActive}`);
      logger.debug(`[Chat.useEffect1] HANDLING NEW CHAT`);
      // fresh new chat started by first message
      setFirstMessageSent(false);
      setStreamingMessageId(null);
      setLoading(false);
      setIsLoadingHistory(false);
      prevChatIdRef.current = chatId!;         // treat as current for next pass
      setMessages([]);
    } else if (isDifferentChat) {
      logger.info(`[DIA][SWITCH-branch] new=${isNewChat} diff=${isDifferentChat} active=${isActive}`);
      logger.debug(`[Chat.useEffect1] HANDLING EXISTING CHAT - STARTING LOAD`);
      // existing chat: clear and show skeleton, then load history
      setStreamingMessageId(null);
      setLoading(false);
      setIsLoadingHistory(true);
      loadedChatRef.current = null;
      loadingForChatRef.current = null;
      currentLoadingChatRef.current = null;
      requestSeqRef.current += 1; // invalidate older responses
      setMessages([]);
      
      // Always load history on activation of a different chat
        logger.debug(`[Chat.useEffect1] STARTING ASYNC LOAD for ${chatId}`);
        // start resume first, then load DB in parallel with robust error handling
        (async () => {
          try {
            if (!mountedRef.current) {
              logger.debug(`[Chat.useEffect1] Component unmounted, aborting load for ${chatId}`);
              return;
            }
            
            logger.info(`[DIA][RESUME-check] starting checkAndResume for ${chatId}`);
            await checkAndResumeRef.current(chatId);
            logger.info(`[DIA][RESUME-check] completed checkAndResume for ${chatId}`);
            
            if (!mountedRef.current) {
              logger.debug(`[Chat.useEffect1] Component unmounted after resume, aborting history load for ${chatId}`);
              return;
            }
            
            logger.info(`[DIA][HISTORY-load] starting loadHistory for ${chatId}`);
            await loadHistoryRef.current(chatId);
            logger.info(`[DIA][HISTORY-load] completed loadHistory for ${chatId}`);
          } catch (error) {
            logger.error(`[Chat.useEffect1] Error during async load for ${chatId}:`, error);
            // Ensure loadingForChatRef is cleared even on error
            if (loadingForChatRef.current === chatId) {
              loadingForChatRef.current = null;
              setIsLoadingHistory(false);
            }
          }
        })();
    } else {
      logger.info(`[DIA][SWITCH-branch] new=${isNewChat} diff=${isDifferentChat} active=${isActive}`);
      // Same chat re-activated. If not successfully loaded yet, force a load now.
      if (loadedChatRef.current !== chatId && (!firstMessage || firstMessageSent)) {
        logger.debug(`[Chat.useEffect1] SAME CHAT, NOT LOADED -> FORCING LOAD for ${chatId}`);
        setIsLoadingHistory(true);
        (async () => {
          try {
            logger.info(`[DIA][RESUME-check] starting checkAndResume for ${chatId} (same chat)`);
            await checkAndResumeRef.current(chatId);
            logger.info(`[DIA][RESUME-check] completed checkAndResume for ${chatId} (same chat)`);
            
            if (!mountedRef.current) {
              logger.debug(`[Chat.useEffect1] Component unmounted after resume, aborting history load for ${chatId} (same chat)`);
              return;
            }
            
            logger.info(`[DIA][HISTORY-load] starting loadHistory for ${chatId} (same chat)`);
            await loadHistoryRef.current(chatId);
            logger.info(`[DIA][HISTORY-load] completed loadHistory for ${chatId} (same chat)`);
          } catch (error) {
            logger.error(`[Chat.useEffect1] Error during same-chat load for ${chatId}:`, error);
            // Ensure loadingForChatRef is cleared even on error
            if (loadingForChatRef.current === chatId) {
              loadingForChatRef.current = null;
              setIsLoadingHistory(false);
            }
          }
        })();
      } else {
        logger.debug(`[Chat.useEffect1] CHAT ALREADY LOADED - no action needed`);
      }
    }

    // Call onActiveStateChange since we've already prevented duplicates at the effect level
    if (onActiveStateChange && chatId) {
      logger.debug(`[Chat.useEffect1] Calling onActiveStateChange(${chatId}, ${isActive})`);
      onActiveStateChange(chatId, isActive);
    }
    
    // record current as last active to compute future switches
    prevChatIdRef.current = chatId ?? null;
    logger.debug(`[Chat.useEffect1] === EFFECT COMPLETED ===`);
  }, [chatId, isActive, firstMessage, onActiveStateChange, firstMessageSent]);

  // Add refs for stable function calls
  const checkAndResumeRef = useRef(checkAndResumeStreaming);
  const loadHistoryRef = useRef(loadChatHistoryImmediate);
  useEffect(() => { checkAndResumeRef.current = checkAndResumeStreaming; }, [checkAndResumeStreaming]);
  useEffect(() => { loadHistoryRef.current = loadChatHistoryImmediate; }, [loadChatHistoryImmediate]);

  // History loading is now handled in the main useEffect above

  useEffect(() => {
    if (chatId && isActive && firstMessage && firstMessage.trim() && config && !firstMessageSent) {
      loadedChatRef.current = chatId;   // ensure no force-load races
      // Send first message immediately
      if (mountedRef.current && isActive) {
        logger.info('Sending first message for new chat:', chatId);
        handleNewMessage(firstMessage);
        setFirstMessageSent(true);
        if (onFirstMessageSent) {
          onFirstMessageSent(chatId);
        }
      }
    }
  }, [chatId, isActive, firstMessage, config, firstMessageSent, handleNewMessage, onFirstMessageSent]);

  useEffect(()=>{ logger.info(`[DIA][MOUNT] chat=${chatId}`); }, [chatId]);

  useEffect(() => {
    logger.info(`[Chat.mount] Component mounted - ensuring mountedRef.current = true`);
    mountedRef.current = true;
    
    return () => {
      logger.info(`[Chat.cleanup] Component cleanup - setting mountedRef.current = false`);
      mountedRef.current = false;
      // Note: No longer aborting controllers here as useEffect1 manages all abortion
    };
  }, []); // Only run on mount/unmount, not on chatId changes

  const renderMessage = (message: Message, originalIndex: number) => {
    if (message.role === 'user') {
      const isFirstMessage = originalIndex === 0; // original order
      return (
        <UserMessage 
          key={message.id}
          content={message.content}
          isFirstMessage={isFirstMessage}
        />
      );
    }

    // Check if this is the last assistant message
    const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant');
    const isLastAssistantMessage = message.id === lastAssistantMessage?.id;

    return (
      <div key={message.id} className="assistant-message">
        {message.thoughts && (
          <ThinkBox 
            thoughts={message.thoughts}
            isStreaming={message.isStreaming}
            isVisible={true}
            chatId={chatId}
          />
        )}
        
        <div className="response-content">
          {message.content}
          <span className={`cursor ${!isLastAssistantMessage || (streamingMessageId !== message.id) || (currentChatState !== 'responding' && !message.isStreamingResponse) ? 'hidden' : ''}`}>|</span>
        </div>
      </div>
    );
  };

  const frontendBusy = Boolean(loading || isLoadingHistory || streamingMessageId !== null);
  logger.info(`[Chat.render] ===== FRONTEND STATE =====`);
  logger.info(`[Chat.render] Chat: ${chatId}, Messages: ${messages.length}, isLoadingHistory: ${isLoadingHistory}`);
  logger.info(`[Chat.render] loading: ${loading}, streamingMessageId: ${streamingMessageId}, frontendBusy: ${frontendBusy}`);
  
  const lastAssist = [...messages].reverse().find(m=>m.role==='assistant');
  if (sample(`RENDER:${chatId}`, 30)) logger.info(
    `[DIA][RENDER] chat=${chatId} msgs=${messages.length} ` +
    `lastAid=${lastAssist?.id ?? 'none'} lastAlen=${lastAssist?.content?.length ?? 0} ` +
    `isLoadingHistory=${isLoadingHistory} streamingId=${streamingMessageId} state=${currentChatState}`
  );
  
  return (
    <div className="chat-messages">
      <div className="messages-container">
        <div className="spacer" style={{flexGrow: 1}}></div>
        {messages.slice().reverse().map((message) => {
          const originalIndex = messages.findIndex(m => m.id === message.id);
          return renderMessage(message, originalIndex);
        })}
        {isLoadingHistory && messages.length === 0 && (
          <div className="messages-skeleton">
            <div className="msg-skel" />
            <div className="msg-skel" />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
});

Chat.displayName = 'Chat';

export default Chat;
