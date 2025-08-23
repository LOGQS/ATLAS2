// status: complete

import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import UserMessage from './UserMessage';
import ThinkBox from './ThinkBox';
import '../styles/Chat.css';
import '../styles/ThinkBox.css';
import logger from '../utils/logger';
import { apiUrl } from '../config/api';
import { subscribe } from '../utils/chatstate';

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

// Robust SSE parser that handles CRLF and multi-line events
function parseSSE(buffer: string): string[] {
  const lines = buffer.split(/\r?\n/);
  const events: string[] = [];
  let event: string[] = [];
  
  for (const line of lines) {
    if (line === '') { // event boundary
      if (event.length) { 
        events.push(event.join('\n')); 
        event = [];
      }
    } else if (line.startsWith('data:')) {
      event.push(line.slice(5).trimStart());
    }
  }
  
  return events;
}

// Simple cache to track loaded chats across component instances
const chatCache = new Map<string, Message[]>();
const chatCacheTimestamps = new Map<string, number>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const Chat = forwardRef<any, ChatProps>(({ chatId, onMessageSent, onChatStateChange, onFirstMessageSent, onActiveStateChange, isActive = true, firstMessage }, ref) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDelayedLoading, setShowDelayedLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<number | null>(null);
  const [config, setConfig] = useState<{provider: string, model: string} | null>(null);
  const [firstMessageSent, setFirstMessageSent] = useState(false);
  const [currentChatState, setCurrentChatState] = useState<'thinking' | 'responding' | 'static'>('static');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const loadingHistoryRef = useRef<string | null>(null);
  const delayedLoadingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const loadedChatRef = useRef<string | null>(null);
  const currentLoadingChatRef = useRef<string | null>(null);
  const isLoadingRef = useRef<boolean>(false);

  const scrollToBottom = useCallback(() => {
    const container = messagesEndRef.current?.parentElement;
    if (container) {
      logger.info(`[SCROLL] Chat ${chatId} - Before scrollToBottom - scrollTop: ${container.scrollTop}, scrollHeight: ${container.scrollHeight}`);
      container.scrollTop = container.scrollHeight;
      logger.info(`[SCROLL] Chat ${chatId} - After scrollToBottom - scrollTop: ${container.scrollTop}`);
    }
  }, [chatId]);

  // Cache management functions
  const isCacheValid = useCallback((targetChatId: string): boolean => {
    const timestamp = chatCacheTimestamps.get(targetChatId);
    if (!timestamp) return false;
    return Date.now() - timestamp < CACHE_TTL;
  }, []);

  const getCachedMessages = useCallback((targetChatId: string): Message[] | null => {
    if (isCacheValid(targetChatId)) {
      const cached = chatCache.get(targetChatId);
      if (cached) {
        logger.info(`[Cache] Using cached messages for chat ${targetChatId}`);
        return cached;
      }
    }
    return null;
  }, [isCacheValid]);

  const setCachedMessages = useCallback((targetChatId: string, messages: Message[]) => {
    chatCache.set(targetChatId, [...messages]);
    chatCacheTimestamps.set(targetChatId, Date.now());
    logger.info(`[Cache] Cached ${messages.length} messages for chat ${targetChatId}`);
  }, []);

  const verifyAllChunksProcessed = useCallback(async (assistantMessageId: number, targetChatId: string) => {
    logger.info(`[VERIFY] Starting verification for chat ${targetChatId}, messageId ${assistantMessageId}`);
    logger.info(`[VERIFY] Current loading state: ${loading}, streamingMessageId: ${streamingMessageId}`);
    
    try {
      if (targetChatId) {
        logger.info(`[VERIFY] Making fetch request to /api/db/chat/${targetChatId}`);
        const fetchStartTime = Date.now();
        
        // Add timeout to prevent hanging for 20+ seconds
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          logger.warn(`[VERIFY] Verification timeout after 5 seconds for chat ${targetChatId}`);
          controller.abort();
        }, 5000);
        
        try {
          const response = await fetch(apiUrl(`/api/db/chat/${targetChatId}`), {
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          
          const fetchDuration = Date.now() - fetchStartTime;
          logger.info(`[VERIFY] Fetch completed in ${fetchDuration}ms, status: ${response.status}`);
        
        if (response.ok) {
          logger.info(`[VERIFY] Response OK, parsing JSON...`);
          const data = await response.json();
          logger.info(`[VERIFY] Parsed JSON, history length: ${data.history?.length || 0}`);
          
          const lastMessage = data.history[data.history.length - 1];
          logger.info(`[VERIFY] Last message role: ${lastMessage?.role}, id: ${lastMessage?.id}`);
          
          if (lastMessage && lastMessage.role === 'assistant') {
            logger.info(`[VERIFY] Found assistant message, updating UI state...`);
            setMessages(prev => prev.map(msg => {
              if (msg.id === assistantMessageId) {
                const newContent = lastMessage.content || msg.content;
                const newThoughts = lastMessage.thoughts || msg.thoughts;
                
                const contentChanged = newContent !== msg.content || newThoughts !== msg.thoughts;
                logger.info(`[VERIFY] Message ${assistantMessageId} content changed: ${contentChanged}`);
                
                if (contentChanged) {
                  logger.info(`[VERIFY] Updating message content for ${assistantMessageId}`);
                  return {
                    ...msg,
                    content: newContent,
                    thoughts: newThoughts,
                    isStreamingResponse: false
                  };
                } else {
                  logger.info(`[VERIFY] No content change for message ${assistantMessageId}, just marking complete`);
                  return { ...msg, isStreamingResponse: false };
                }
              }
              return msg;
            }));
            
            logger.info(`[VERIFY] Calling onChatStateChange with 'static' for chat ${targetChatId}`);
            if (onChatStateChange) {
              onChatStateChange(targetChatId, 'static');
            }
            logger.info(`[VERIFY] Verification complete for chat ${targetChatId}, returning early`);
            return;
          } else {
            logger.warn(`[VERIFY] No assistant message found in response for chat ${targetChatId}`);
          }
        } else {
          logger.warn(`[VERIFY] HTTP ${response.status} response for chat ${targetChatId}`);
        }
        } catch (timeoutError) {
          clearTimeout(timeoutId);
          if (timeoutError instanceof Error && timeoutError.name === 'AbortError') {
            logger.warn(`[VERIFY] Verification timeout or abort for chat ${targetChatId}`);
          } else {
            logger.error(`[VERIFY] Fetch error for chat ${targetChatId}:`, timeoutError);
          }
        }
      } else {
        logger.warn(`[VERIFY] No targetChatId provided`);
      }
      
      logger.info(`[VERIFY] Fallback: updating message ${assistantMessageId} without database verification`);
      setMessages(prev => prev.map(msg => 
        msg.id === assistantMessageId 
          ? { ...msg, isStreamingResponse: false }
          : msg
      ));
      
      logger.info(`[VERIFY] Fallback: calling onChatStateChange with 'static' for chat ${targetChatId}`);
      if (onChatStateChange) {
        onChatStateChange(targetChatId, 'static');
      }
      logger.info(`[VERIFY] Fallback verification complete for chat ${targetChatId}`);
    } catch (error) {
      logger.error(`[VERIFY] Error during verification for chat ${targetChatId}:`, error);
      setMessages(prev => prev.map(msg => 
        msg.id === assistantMessageId 
          ? { ...msg, isStreamingResponse: false }
          : msg
      ));
      
      logger.info(`[VERIFY] Error fallback: calling onChatStateChange with 'static' for chat ${targetChatId}`);
      if (onChatStateChange) {
        onChatStateChange(targetChatId, 'static');
      }
      logger.info(`[VERIFY] Error recovery complete for chat ${targetChatId}`);
    }
  }, [onChatStateChange, loading, streamingMessageId]);

  // Common chunk processing function to avoid duplication
  const processChunk = useCallback((chunk: any, assistantMessageId: number, targetChatId: string) => {
    if (!mountedRef.current) {
      logger.warn(`[CHUNK] Component unmounted, ignoring chunk type: ${chunk.type} for chat ${targetChatId}`);
      return;
    }

    logger.info(`[CHUNK] Processing chunk type: ${chunk.type} for chat ${targetChatId}, messageId: ${assistantMessageId}`);

    if (chunk.type === 'chat_state') {
      if (onChatStateChange && chunk.chat_id) onChatStateChange(chunk.chat_id, chunk.state);
      if (chunk.state === 'static') {
        setShowDelayedLoading(false);
        setLoading(false);
        setStreamingMessageId(null);
        // Don't enable send button here - wait for complete signal and verification
      }
      return null;
    } else if (chunk.type === 'thoughts') {
      if (delayedLoadingTimeoutRef.current) {
        clearTimeout(delayedLoadingTimeoutRef.current);
        delayedLoadingTimeoutRef.current = null;
      }
      setShowDelayedLoading(false);
      
      logger.info(`[SCROLL] Chat ${targetChatId} - Updating thoughts during streaming`);
      setMessages(prev => prev.map(msg =>
        msg.id === assistantMessageId
          ? {
              ...msg,
              thoughts: (() => {
                const prevT = msg.thoughts || '';
                const c = chunk.content || '';
                return c.startsWith(prevT) ? c : prevT + c;
              })()
            }
          : msg
      ));
    } else if (chunk.type === 'answer') {
      if (delayedLoadingTimeoutRef.current) {
        clearTimeout(delayedLoadingTimeoutRef.current);
        delayedLoadingTimeoutRef.current = null;
      }
      setShowDelayedLoading(false);
      
      logger.info(`[SCROLL] Chat ${targetChatId} - Updating message content during streaming`);
      setMessages(prev => prev.map(msg =>
        msg.id === assistantMessageId
          ? {
              ...msg,
              isStreaming: false,
              isStreamingResponse: true,
              content: (() => {
                const prevC = msg.content || '';
                const c = chunk.content || '';
                return c.startsWith(prevC) ? c : prevC + c;
              })()
            }
          : msg
      ));
    } else if (chunk.type === 'complete') {
      logger.info(`[CHUNK] Received COMPLETE chunk for chat ${targetChatId}, messageId: ${assistantMessageId}`);
      return 'complete';
    } else if (chunk.type === 'error') {
      logger.error(`[CHUNK] Received ERROR chunk for chat ${targetChatId}, messageId: ${assistantMessageId}:`, chunk.content);
      return 'error';
    }
    return null;
  }, [onChatStateChange]);

  const resumeStream = useCallback(async (targetChatId: string, assistantMessageId: number) => {
    if (!isActive || !mountedRef.current) {
      logger.warn('Attempted to resume stream for inactive/unmounted chat:', targetChatId);
      return;
    }

    logger.info(`[resumeStream] Connecting to stream for chat: ${targetChatId}`);
    
    try {
      setStreamingMessageId(assistantMessageId);
      
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      
      // Connect to ongoing stream (backend handles whether it's resume or existing stream)
      const response = await fetch(apiUrl('/api/chat/stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: targetChatId,
          resume: true
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

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          buffer += decoder.decode(value || new Uint8Array(), { stream: false });
          for (const payload of parseSSE(buffer)) {
            if (!mountedRef.current) break;
            try {
              const chunk = JSON.parse(payload);
              const result = processChunk(chunk, assistantMessageId, targetChatId);
              
              if (result === 'complete') {
                if (delayedLoadingTimeoutRef.current) {
                  clearTimeout(delayedLoadingTimeoutRef.current);
                  delayedLoadingTimeoutRef.current = null;
                }
                setShowDelayedLoading(false);
                await verifyAllChunksProcessed(assistantMessageId, targetChatId);
                logger.info(`[resumeStream] ==================== RESUME STREAM STATE RESET ====================`);
                logger.info(`[resumeStream] Stream complete for chat ${targetChatId}, resetting states`);
                logger.info(`[resumeStream] Current states before reset: loading=${loading}, streamingMessageId=${streamingMessageId}`);
                setStreamingMessageId(null);
                setLoading(false);
                logger.info(`[resumeStream] ==================== RESUME STREAM STATE RESET COMPLETE ====================`);
              } else if (result === 'error') {
                logger.error('Stream error:', chunk.content);
                setShowDelayedLoading(false);
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
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        
        for (const payload of parseSSE(buffer)) {
          if (!mountedRef.current) break;
          try {
            const chunk = JSON.parse(payload);
            const result = processChunk(chunk, assistantMessageId, targetChatId);
            
            if (result === 'complete') {
              if (delayedLoadingTimeoutRef.current) {
                clearTimeout(delayedLoadingTimeoutRef.current);
                delayedLoadingTimeoutRef.current = null;
              }
              setShowDelayedLoading(false);
              await verifyAllChunksProcessed(assistantMessageId, targetChatId);
              logger.info(`[resumeStream] Stream complete for chat ${targetChatId}`);
              setStreamingMessageId(null);
              setLoading(false);
            } else if (result === 'error') {
              logger.error('Stream error:', chunk.content);
              setShowDelayedLoading(false);
              setLoading(false);
              setStreamingMessageId(null);
            }
          } catch (e) {
            logger.error('Error parsing resume chunk:', e);
          }
        }
        
        // Keep only the tail after last event boundary
        const lastSep = buffer.lastIndexOf('\n\n');
        buffer = lastSep >= 0 ? buffer.slice(lastSep + 2) : buffer;
      }
    } catch (error) {
      // Don't log AbortError as it's expected when switching chats
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info(`[resumeStream] Stream aborted for chat ${targetChatId} (client disconnected, backend continues)`);
        return; // Exit early, don't update UI state
      } else {
        logger.error(`[resumeStream] Error for chat ${targetChatId}:`, error);
      }
      
      setShowDelayedLoading(false);
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
      if (abortControllerRef.current) {
        abortControllerRef.current = null;
      }
    }
  }, [isActive, processChunk, verifyAllChunksProcessed, loading, streamingMessageId, onChatStateChange]);

  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    const container = messagesEndRef.current?.parentElement;
    if (container) {
      logger.info(`[SCROLL] Chat ${chatId} useEffect[messages] - Current scroll position: ${container.scrollTop}, scrollHeight: ${container.scrollHeight}, messages.length: ${messages.length}`);
    }
    if (lastMessage && (lastMessage.isStreaming || lastMessage.isStreamingResponse)) {
      logger.info(`[SCROLL] Chat ${chatId} useEffect[messages] - triggering scrollToBottom because message is streaming`);
      scrollToBottom();
    }
  }, [messages, chatId, scrollToBottom]);

  useEffect(() => {
    if (streamingMessageId) {
      logger.info(`[SCROLL] Chat ${chatId} useEffect[streamingMessageId] - triggering scrollToBottom for messageId: ${streamingMessageId}`);
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

  const loadChatHistoryImmediate = useCallback(async (targetChatId: string, retryCount = 0) => {
    if (!targetChatId) return;
    
    // Check cache first
    const cachedMessages = getCachedMessages(targetChatId);
    if (cachedMessages && loadedChatRef.current === targetChatId && messages.length > 0) {
      logger.info(`[Chat.loadChatHistoryImmediate] Chat history already loaded for: ${targetChatId}`);
      return;
    }
    
    if (cachedMessages) {
      logger.info(`[Chat.loadChatHistoryImmediate] Loading from cache for: ${targetChatId}`);
      setMessages(cachedMessages);
      loadedChatRef.current = targetChatId;
      setIsLoadingHistory(false);
      return;
    }
    
    // Prevent concurrent loads for the same chat
    if (currentLoadingChatRef.current === targetChatId || isLoadingRef.current) {
      logger.info(`[Chat.loadChatHistoryImmediate] Already loading history for chat: ${targetChatId}`);
      return;
    }
    
    // Only abort previous request if it's for a different chat
    if (abortControllerRef.current && currentLoadingChatRef.current !== targetChatId) {
      logger.info(`[Chat.loadChatHistoryImmediate] Aborting previous request for: ${currentLoadingChatRef.current}`);
      abortControllerRef.current.abort();
    }
    
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    
    currentLoadingChatRef.current = targetChatId;
    loadingHistoryRef.current = targetChatId;
    isLoadingRef.current = true;
    setIsLoadingHistory(true);
    
    try {
      logger.info('[Chat.loadChatHistoryImmediate] Loading chat history for:', targetChatId);
      
      // Load backend state first - this is the source of truth
      const stateResponse = await fetch(apiUrl(`/api/db/chat/${targetChatId}/state`), { signal: abortController.signal });
      let chatState: 'thinking' | 'responding' | 'static' = 'static';
      if (stateResponse.ok) {
        const stateData = await stateResponse.json();
        chatState = (stateData.state as 'thinking' | 'responding' | 'static') || 'static';
        logger.info(`[loadChatHistoryImmediate] Backend state for chat ${targetChatId}: ${chatState}`);
      }
      
      // Load latest history from database (always fresh from backend)
      const historyResponse = await fetch(apiUrl(`/api/db/chat/${targetChatId}`), { signal: abortController.signal });
      
      if (historyResponse.ok) {
        const data = await historyResponse.json();
        
        if (chatState !== 'thinking' && chatState !== 'responding') {
          setStreamingMessageId(null);
          setShowDelayedLoading(false);
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
        
        logger.info(`[loadChatHistoryImmediate] Loaded ${formattedMessages.length} messages for chat ${targetChatId} with state: ${chatState}`);
        setMessages(formattedMessages);
        setCachedMessages(targetChatId, formattedMessages);
        loadedChatRef.current = targetChatId;
        
        // Update parent component with backend state
        if (onChatStateChange) {
          onChatStateChange(targetChatId, chatState);
        }
        
      } else if (historyResponse.status === 404) {
        logger.info(`[loadChatHistoryImmediate] Chat ${targetChatId} not found, starting fresh`);
        setMessages([]);
        loadedChatRef.current = targetChatId;
        
        // Ensure parent knows this is a static chat
        if (onChatStateChange) {
          onChatStateChange(targetChatId, 'static');
        }
      } else {
        const errorData = await historyResponse.json();
        logger.error('Failed to load chat history:', errorData.error);
      }
    } catch (error) {
      // Don't log AbortError as it's expected when switching chats
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('Chat history loading aborted (expected when switching chats)');
        return; // Exit early, don't update UI state
      } else {
        logger.error('Failed to load chat history:', error);
      }
      
      if (!abortController.signal.aborted) {
        setMessages([]); // ensure UI renders even on error
      }
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
      if (currentLoadingChatRef.current === targetChatId) {
        currentLoadingChatRef.current = null;
      }
      loadingHistoryRef.current = null;
      isLoadingRef.current = false;
      setIsLoadingHistory(false);
    }
  }, [messages.length, onChatStateChange, getCachedMessages, setCachedMessages]);

  // Update cache when messages change (debounced to avoid excessive updates)
  useEffect(() => {
    if (chatId && messages.length > 0 && loadedChatRef.current === chatId) {
      const timeoutId = setTimeout(() => {
        setCachedMessages(chatId, messages);
      }, 100); // Small delay to batch updates
      
      return () => clearTimeout(timeoutId);
    }
  }, [messages, chatId, setCachedMessages]);


  const checkAndResumeStreaming = useCallback(async (targetChatId: string) => {
    // Prevent multiple calls for the same chat while we're already checking
    if (currentLoadingChatRef.current === targetChatId && isLoadingRef.current) {
      logger.info(`[Chat.checkAndResumeStreaming] Already checking state for chat: ${targetChatId}`);
      return;
    }
    
    try {
      // 1) Read authoritative state from backend
      const stateRes = await fetch(apiUrl(`/api/db/chat/${targetChatId}/state`));
      const stateJson = await stateRes.json();
      const chatState = stateRes.ok ? (stateJson.state as 'thinking' | 'responding' | 'static') : 'static';

      logger.info(`[Chat.checkAndResumeStreaming] Backend state for chat ${targetChatId}: ${chatState}`);

      // 2) If not active, ensure UI reflects static state
      if (chatState !== 'thinking' && chatState !== 'responding') {
        setStreamingMessageId(null);
        setLoading(false);
        setShowDelayedLoading(false);
        if (onChatStateChange) {
          onChatStateChange(targetChatId, 'static');
        }
        return;
      }

      // 3) If backend is actively processing, reconnect to stream
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      
      if (lastAssistant) {
        setStreamingMessageId(lastAssistant.id);
        
        // Update UI to reflect backend state
        setMessages(prev => prev.map(m =>
          m.id === lastAssistant.id
            ? {
                ...m,
                isStreaming: chatState === 'thinking',
                isStreamingResponse: chatState === 'responding'
              }
            : m
        ));
        
        // Connect to ongoing stream (backend will handle reconnection)
        logger.info(`[Chat.checkAndResumeStreaming] Reconnecting to ongoing stream for chat ${targetChatId}`);
        resumeStream(targetChatId, lastAssistant.id);
        
        if (onChatStateChange) {
          onChatStateChange(targetChatId, chatState);
        }
      }
    } catch (e) {
      logger.error('[Chat.checkAndResumeStreaming] failed:', e);
      setStreamingMessageId(null);
      setLoading(false);
      setShowDelayedLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    
    try {
      logger.info('Starting AI response stream for:', userMessage.substring(0, 50) + '...');
      const assistantMessageId = generateUniqueMessageId();
      
      const userMsg: Message = {
        id: generateUniqueMessageId(),
        role: 'user',
        content: userMessage,
        timestamp: new Date().toISOString(),
        isStreaming: false,
        isStreamingResponse: false
      };
      
      if (delayedLoadingTimeoutRef.current) {
        clearTimeout(delayedLoadingTimeoutRef.current);
      }
      
      delayedLoadingTimeoutRef.current = setTimeout(() => {
        setShowDelayedLoading(true);
      }, 5000);
      
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

      logger.info(`[SCROLL] Chat ${chatId} - Adding new user and assistant messages to state`);
      setMessages(prev => [...prev, userMsg, assistantMessage]);
      setStreamingMessageId(assistantMessageId);
      
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      
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
          for (const payload of parseSSE(buffer)) {
            if (!mountedRef.current) break;
            try {
              const chunk = JSON.parse(payload);
              const result = processChunk(chunk, assistantMessageId, chatId!);
              
              if (result === 'complete') {
                if (delayedLoadingTimeoutRef.current) {
                  clearTimeout(delayedLoadingTimeoutRef.current);
                  delayedLoadingTimeoutRef.current = null;
                }
                setShowDelayedLoading(false);
                logger.info(`[STREAM] Completion signal received for chat ${chatId}, verifying chunks...`);
                await verifyAllChunksProcessed(assistantMessageId, chatId!);
                logger.info(`[STREAM] Streaming complete for chat ${chatId}, resetting states`);
                setStreamingMessageId(null);
                setLoading(false);
              }
            } catch (e) {
              logger.error('Error parsing final chunk:', e);
            }
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        
        for (const payload of parseSSE(buffer)) {
          if (!mountedRef.current) break;
          try {
            const chunk = JSON.parse(payload);
            const result = processChunk(chunk, assistantMessageId, chatId!);
            
            if (result === 'complete') {
              logger.info(`[STREAM] Main loop completion signal received for chat ${chatId}, messageId ${assistantMessageId}`);
              logger.info(`[STREAM] Current states before verification - loading: ${loading}, streamingMessageId: ${streamingMessageId}`);
              
              if (delayedLoadingTimeoutRef.current) {
                clearTimeout(delayedLoadingTimeoutRef.current);
                delayedLoadingTimeoutRef.current = null;
                logger.info(`[STREAM] Cleared delayed loading timeout`);
              }
              setShowDelayedLoading(false);
              
              // CRITICAL: Keep loading states active during verification to prevent duplicate sends
              logger.info(`[STREAM] Keeping loading states active during verification for chat ${chatId}`);
              logger.info(`[STREAM] Starting chunk verification for chat ${chatId}...`);
              
              try {
                await verifyAllChunksProcessed(assistantMessageId, chatId!);
                logger.info(`[STREAM] Chunk verification completed for chat ${chatId}`);
              } catch (error) {
                logger.error(`[STREAM] Verification failed for chat ${chatId}:`, error);
              }
              
              logger.info(`[STREAM] ==================== STATE RESET ====================`);
              logger.info(`[STREAM] About to reset loading states for chat ${chatId}`);
              logger.info(`[STREAM] Current states before reset: loading=${loading}, streamingMessageId=${streamingMessageId}`);
              logger.info(`[STREAM] Setting streamingMessageId: ${streamingMessageId} -> null`);
              setStreamingMessageId(null);
              logger.info(`[STREAM] Setting loading: ${loading} -> false`);
              setLoading(false);
              logger.info(`[STREAM] ==================== STATE RESET COMPLETE ====================`);
              logger.info(`[STREAM] Main loop streaming complete for chat ${chatId}, all states reset`);
            }
          } catch (e) {
            logger.error('Error parsing chunk:', e);
          }
        }
        
        // Keep only the tail after last event boundary
        const lastSep = buffer.lastIndexOf('\n\n');
        buffer = lastSep >= 0 ? buffer.slice(lastSep + 2) : buffer;
      }
    } catch (error) {
      if (delayedLoadingTimeoutRef.current) {
        clearTimeout(delayedLoadingTimeoutRef.current);
        delayedLoadingTimeoutRef.current = null;
      }
      setShowDelayedLoading(false);
      
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
      if (abortControllerRef.current) {
        abortControllerRef.current = null;
      }
    }
  }, [isActive, config, chatId, processChunk, verifyAllChunksProcessed, loading, streamingMessageId]);

  const handleNewMessage = useCallback((content: string) => {
    logger.info(`[SEND] ==================== MESSAGE SEND ATTEMPT ====================`);
    logger.info(`[SEND] handleNewMessage called for chat ${chatId}: "${content.substring(0, 50)}"`);
    logger.info(`[SEND] Current state - isActive: ${isActive}, loading: ${loading}, streamingMessageId: ${streamingMessageId}`);
    logger.info(`[SEND] Current chat state: ${currentChatState}`);
    logger.info(`[SEND] Show delayed loading: ${showDelayedLoading}`);
    
    if (!isActive) {
      logger.warn(`[SEND] BLOCKED: Chat ${chatId} is not active`);
      return;
    }

    // Enhanced duplicate prevention with detailed logging
    if (loading && streamingMessageId) {
      logger.warn(`[SEND] ==================== DUPLICATE PREVENTION TRIGGERED ====================`);
      logger.warn(`[SEND] BLOCKING: Message already being processed for chat ${chatId}`);
      logger.warn(`[SEND] Blocking reason: loading=${loading} AND streamingMessageId=${streamingMessageId}`);
      logger.warn(`[SEND] This suggests completion signal was received but verification is still running`);
      logger.warn(`[SEND] If this is a legitimate follow-up message, the completion flow has a bug`);
      logger.warn(`[SEND] ==================== END DUPLICATE PREVENTION ====================`);
      return;
    }
    
    if (loading && !streamingMessageId) {
      logger.warn(`[SEND] UNUSUAL STATE: loading=true but streamingMessageId=null for chat ${chatId}`);
      logger.warn(`[SEND] This suggests loading state cleanup issue - allowing message to proceed`);
    }
    
    if (!loading && streamingMessageId) {
      logger.warn(`[SEND] UNUSUAL STATE: loading=false but streamingMessageId=${streamingMessageId} for chat ${chatId}`);
      logger.warn(`[SEND] This suggests incomplete state cleanup - allowing message to proceed but may cause issues`);
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
  }, [chatId, isActive, loading, streamingMessageId, currentChatState, showDelayedLoading, streamAIResponse, onMessageSent]);

  useImperativeHandle(ref, () => ({
    handleNewMessage
  }));

  useEffect(() => {
    logger.info('[Chat.useEffect1] Chat ID or active state changed:', chatId, isActive);
    
    // Reset mounted state for new chat
    mountedRef.current = true;
    
    // Abort HTTP streaming when switching chats (but backend continues processing)
    const previousChat = loadedChatRef.current;
    if (abortControllerRef.current && previousChat !== chatId) {
      logger.info(`[Chat.useEffect1] Aborting HTTP stream for previous chat ${previousChat} (backend continues processing)`);
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    // Only clear state if this is actually a different chat AND not switching back to a previously loaded chat
    const isDifferentChat = previousChat !== chatId;
    const isNewChat = chatId && firstMessage; // New chat has firstMessage
    const isSwitchingBackToExisting = isDifferentChat && !isNewChat;
    
    if (isDifferentChat && isNewChat) {
      logger.info('[Chat.useEffect1] Clearing state for new chat:', chatId);
      setFirstMessageSent(false);
      setShowDelayedLoading(false);
      setStreamingMessageId(null);
      setLoading(false);
      setIsLoadingHistory(false);
      loadingHistoryRef.current = null;
      loadedChatRef.current = null;
      setMessages([]);
      
      if (delayedLoadingTimeoutRef.current) {
        clearTimeout(delayedLoadingTimeoutRef.current);
        delayedLoadingTimeoutRef.current = null;
      }
    } else if (isSwitchingBackToExisting) {
      logger.info('[Chat.useEffect1] Switching to existing chat:', chatId);
      
      // Check cache first before deciding to load
      const cachedMessages = chatId ? getCachedMessages(chatId) : null;
      if (cachedMessages) {
        logger.info('[Chat.useEffect1] Found cached messages, using them');
        setMessages(cachedMessages);
        loadedChatRef.current = chatId || null;
        setIsLoadingHistory(false);
      } else if (loadedChatRef.current !== chatId) {
        logger.info('[Chat.useEffect1] Chat not in cache, will load from backend');
        setMessages([]);
        setIsLoadingHistory(true);
      } else {
        logger.info('[Chat.useEffect1] Chat already loaded, keeping existing messages');
      }
      
      // Clear loading states
      setShowDelayedLoading(false);
      setLoading(false);
      
      if (delayedLoadingTimeoutRef.current) {
        clearTimeout(delayedLoadingTimeoutRef.current);
        delayedLoadingTimeoutRef.current = null;
      }
    }
    
    // Notify active state change once per chat/isActive combination
    if (onActiveStateChange && chatId) {
      logger.info('[Chat.useEffect1] Calling onActiveStateChange:', chatId, isActive);
      onActiveStateChange(chatId, isActive);
    }
  }, [chatId, isActive, onActiveStateChange, firstMessage, getCachedMessages]);

  useEffect(() => {
    // Only load history for existing chats (not new chats with firstMessage)  
    if (chatId && isActive && !firstMessage) {
      // Check if we need to load this chat
      const needsLoading = loadedChatRef.current !== chatId;
      const isNotCurrentlyLoading = currentLoadingChatRef.current !== chatId;
      const hasMessages = messages.length > 0;
      
      // Skip if already loaded with messages
      if (!needsLoading && hasMessages) {
        logger.info(`[Chat.useEffect3] Chat ${chatId} - already loaded in cache, no sync needed`);
        return;
      }
      
      if (needsLoading && isNotCurrentlyLoading) {
        logger.info(`[Chat.useEffect3] Chat ${chatId} - loading existing chat and syncing with backend`);
        
        // Add a small delay to debounce rapid successive calls
        const timeoutId = setTimeout(async () => {
          if (!mountedRef.current || loadedChatRef.current === chatId) return;
          
          logger.info(`[Chat.useEffect3] Chat ${chatId} - executing sync with backend`);
          
          try {
            // Step 1: Load latest database content (this updates UI with current backend state)
            await loadChatHistoryImmediate(chatId);
            
            // Step 2: If chat is actively processing in backend, reconnect to stream
            if (chatId && mountedRef.current && isActive) {
              logger.info(`[Chat.useEffect3] Chat ${chatId} - checking for active streams to reconnect`);
              await checkAndResumeStreaming(chatId);
            }
          } catch (error) {
            logger.error(`[Chat.useEffect3] Error syncing chat ${chatId} with backend:`, error);
          }
        }, 10); // Small debounce delay
        
        return () => clearTimeout(timeoutId);
      }
    }
  }, [chatId, isActive, firstMessage, messages.length, loadChatHistoryImmediate, checkAndResumeStreaming]);

  useEffect(() => {
    if (chatId && isActive && firstMessage && firstMessage.trim() && config && !firstMessageSent) {
      // Mark this chat as loaded to prevent history loading
      loadedChatRef.current = chatId;
      
      // Small delay to ensure component is fully initialized
      const timeoutId = setTimeout(() => {
        if (mountedRef.current && isActive) {
          logger.info('Sending first message for new chat:', chatId);
          handleNewMessage(firstMessage);
          setFirstMessageSent(true);
          if (onFirstMessageSent) {
            onFirstMessageSent(chatId);
          }
        }
      }, 50);
      
      return () => clearTimeout(timeoutId);
    }
  }, [chatId, isActive, firstMessage, config, firstMessageSent, handleNewMessage, onFirstMessageSent]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;


      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (delayedLoadingTimeoutRef.current) clearTimeout(delayedLoadingTimeoutRef.current);
    };
  }, [chatId]);

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
          <span className={`cursor ${!isLastAssistantMessage || currentChatState !== 'responding' ? 'hidden' : ''}`}>|</span>
        </div>
      </div>
    );
  };

  return (
    <div className="chat-messages">
      <div className="messages-container">
        <div className="spacer" style={{flexGrow: 1}}></div>
        {showDelayedLoading && (
          <div className="delayed-loading-indicator" aria-live="polite">
            <div className="delayed-loading-content">
              <div className="delayed-loading-spinner"></div>
              <span>Thinking...</span>
            </div>
          </div>
        )}
        {loading && messages.length > 0 && !streamingMessageId && (
          <div className="typing-indicator">
            <div className="typing-animation">
              <div className="dot"></div>
              <div className="dot"></div>
              <div className="dot"></div>
            </div>
          </div>
        )}
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