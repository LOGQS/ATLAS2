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


const Chat = forwardRef<any, ChatProps>(({ chatId, onMessageSent, onChatStateChange, onFirstMessageSent, onActiveStateChange, isActive = true, firstMessage }, ref) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<number | null>(null);
  const [config, setConfig] = useState<{provider: string, model: string} | null>(null);
  const [firstMessageSent, setFirstMessageSent] = useState(false);
  const [currentChatState, setCurrentChatState] = useState<'thinking' | 'responding' | 'static'>('static');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const loadingHistoryRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const loadedChatRef = useRef<string | null>(null);
  const currentLoadingChatRef = useRef<string | null>(null);
  const isLoadingRef = useRef<boolean>(false);
  const processedChatRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    const container = messagesEndRef.current?.parentElement;
    if (container) {
      logger.info(`[SCROLL] Chat ${chatId} - Before scrollToBottom - scrollTop: ${container.scrollTop}, scrollHeight: ${container.scrollHeight}`);
      container.scrollTop = container.scrollHeight;
      logger.info(`[SCROLL] Chat ${chatId} - After scrollToBottom - scrollTop: ${container.scrollTop}`);
    }
  }, [chatId]);



  // Common chunk processing function to avoid duplication
  const processChunk = useCallback((chunk: any, assistantMessageId: number, targetChatId: string) => {
    if (!mountedRef.current) {
      logger.warn(`[CHUNK] Component unmounted, ignoring chunk type: ${chunk.type} for chat ${targetChatId}`);
      return;
    }

    logger.info(`[CHUNK] ===== PROCESSING LIVE CHUNK =====`);
    logger.info(`[CHUNK] Type: ${chunk.type}, Chat: ${targetChatId}, MessageId: ${assistantMessageId}`);

    if (chunk.type === 'chat_state') {
      if (onChatStateChange && chunk.chat_id) onChatStateChange(chunk.chat_id, chunk.state);
      if (chunk.state === 'static') {
        setLoading(false);
        setStreamingMessageId(null);
      }
      return null;
    } else if (chunk.type === 'thoughts') {
      
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
    logger.info(`[resumeStream] ===== RESUME STREAM CALLED =====`);
    logger.info(`[resumeStream] Chat: ${targetChatId}, Message ID: ${assistantMessageId}`);
    
    if (!isActive || !mountedRef.current) {
      logger.warn(`[resumeStream] CANNOT RESUME - isActive: ${isActive}, mounted: ${mountedRef.current}`);
      return;
    }

    logger.info(`[resumeStream] Connecting to backend stream for chat: ${targetChatId}`);
    
    try {
      setStreamingMessageId(assistantMessageId);
      
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      
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
                logger.info(`[resumeStream] Stream complete for chat ${targetChatId}, resetting states`);
                setStreamingMessageId(null);
                setLoading(false);
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
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        
        for (const payload of parseSSE(buffer)) {
          if (!mountedRef.current) break;
          try {
            const chunk = JSON.parse(payload);
            const result = processChunk(chunk, assistantMessageId, targetChatId);
            
            if (result === 'complete') {
              logger.info(`[resumeStream] Stream complete for chat ${targetChatId}`);
              setStreamingMessageId(null);
              setLoading(false);
            } else if (result === 'error') {
              logger.error('Stream error:', chunk.content);
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
  }, [isActive, processChunk, onChatStateChange]);

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

  const loadChatHistoryImmediate = useCallback(async (targetChatId: string, retryCount = 0): Promise<Message[]> => {
    if (!targetChatId) return [];
    
    // Prevent concurrent loads for the same chat
    if (currentLoadingChatRef.current === targetChatId || isLoadingRef.current) {
      logger.info(`[Chat.loadChatHistoryImmediate] Already loading history for chat: ${targetChatId}`);
      return [];
    }
    
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    
    // Add abort listener to track when this gets aborted
    abortController.signal.addEventListener('abort', () => {
      logger.info(`[loadChatHistoryImmediate] AbortController aborted for ${targetChatId} - reason: ${abortController.signal.reason || 'unknown'}`);
    });
    
    currentLoadingChatRef.current = targetChatId;
    loadingHistoryRef.current = targetChatId;
    isLoadingRef.current = true;
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
        logger.info(`[loadChatHistoryImmediate] CALLING setMessages - FRONTEND SHOULD NOW SHOW ${formattedMessages.length} MESSAGES`);
        setMessages(formattedMessages);
        loadedChatRef.current = targetChatId;
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
  }, [onChatStateChange]);



  const checkAndResumeStreaming = useCallback(async (targetChatId: string, messagesFromDB?: Message[]) => {
    logger.info(`[checkAndResumeStreaming] ===== CHECKING IF SHOULD RESUME STREAMING =====`);
    logger.info(`[checkAndResumeStreaming] Target chat: ${targetChatId}`);
    
    // Prevent multiple calls for the same chat while we're already checking
    if (currentLoadingChatRef.current === targetChatId && isLoadingRef.current) {
      logger.info(`[checkAndResumeStreaming] Already checking state for chat: ${targetChatId}`);
      return;
    }
    
    try {
      // 1) Read authoritative state from backend
      logger.info(`[checkAndResumeStreaming] Reading backend state...`);
      const stateRes = await fetch(apiUrl(`/api/db/chat/${targetChatId}/state`));
      const stateJson = await stateRes.json();
      const chatState = stateRes.ok ? (stateJson.state as 'thinking' | 'responding' | 'static') : 'static';

      logger.info(`[checkAndResumeStreaming] Backend state for chat ${targetChatId}: ${chatState}`);

      // 2) If not active, ensure UI reflects static state
      if (chatState !== 'thinking' && chatState !== 'responding') {
        logger.info(`[checkAndResumeStreaming] Chat ${targetChatId} is STATIC - no streaming needed`);
        setStreamingMessageId(null);
        setLoading(false);
        if (onChatStateChange) {
          onChatStateChange(targetChatId, 'static');
        }
        logger.info(`[checkAndResumeStreaming] ===== NO STREAMING NEEDED - COMPLETED =====`);
        return;
      }

      // 3) If backend is actively processing, reconnect to stream
      logger.info(`[checkAndResumeStreaming] Chat ${targetChatId} is RUNNING (${chatState}) - need to resume streaming`);
      const messagesToCheck = messagesFromDB || messages;
      logger.info(`[checkAndResumeStreaming] Using ${messagesToCheck.length} messages (${messagesFromDB ? 'from DB' : 'from React state'})`);
      const lastAssistant = [...messagesToCheck].reverse().find(m => m.role === 'assistant');
      
      if (lastAssistant) {
        logger.info(`[checkAndResumeStreaming] Found last assistant message to resume:`, {
          id: lastAssistant.id,
          content: lastAssistant.content.substring(0, 50) + '...'
        });
        
        setStreamingMessageId(lastAssistant.id);
        
        // Update UI to reflect backend state
        logger.info(`[checkAndResumeStreaming] Updating UI state for streaming: ${chatState}`);
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
        logger.info(`[checkAndResumeStreaming] ===== STARTING RESUME STREAM =====`);
        resumeStream(targetChatId, lastAssistant.id);
        
        if (onChatStateChange) {
          onChatStateChange(targetChatId, chatState);
        }
      } else {
        logger.warn(`[checkAndResumeStreaming] No assistant message found to resume for chat ${targetChatId}`);
      }
    } catch (e) {
      logger.error('[Chat.checkAndResumeStreaming] failed:', e);
      setStreamingMessageId(null);
      setLoading(false);
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
                logger.info(`[STREAM] Completion signal received for chat ${chatId}`);
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
              setStreamingMessageId(null);
              setLoading(false);
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
  }, [isActive, config, chatId, processChunk]);

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

    if (isLoadingHistory) {
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
  }, [chatId, isActive, loading, isLoadingHistory, streamingMessageId, currentChatState, streamAIResponse, onMessageSent]);

  useImperativeHandle(ref, () => ({
    handleNewMessage,
    isBusy: () => Boolean(
      loading ||
      isLoadingHistory ||
      streamingMessageId !== null
    )
  }));

  useEffect(() => {
    logger.info(`[Chat.useEffect1] === EFFECT TRIGGERED ===`);
    logger.info(`[Chat.useEffect1] chatId: ${chatId}, isActive: ${isActive}, firstMessage: ${!!firstMessage}`);
    logger.info(`[Chat.useEffect1] processedChatRef.current: ${processedChatRef.current}`);
    
    // Skip if we've already processed this exact chat switch
    if (processedChatRef.current === chatId && isActive && !firstMessage) {
      logger.info(`[Chat.useEffect1] SKIPPING - already processed chat ${chatId}`);
      return;
    }
    
    logger.info(`[Chat.useEffect1] loadedChatRef.current: ${loadedChatRef.current}`);
    logger.info(`[Chat.useEffect1] currentLoadingChatRef.current: ${currentLoadingChatRef.current}`);
    
    mountedRef.current = true;

    // Abort only if switching away from a different chat
    const prev = currentLoadingChatRef.current;
    if (abortControllerRef.current && prev && prev !== chatId) {
      logger.info(`[Chat.useEffect1] Aborting in-flight request for previous chat ${prev} FROM USEEFFECT1`);
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    } else if (abortControllerRef.current && prev === chatId) {
      logger.info(`[Chat.useEffect1] NOT aborting - same chat ${chatId}, prev: ${prev}`);
    } else if (!abortControllerRef.current) {
      logger.info(`[Chat.useEffect1] No abort controller to abort`);
    }

    const isNewChat = !!(chatId && firstMessage);
    const isDifferentChat = loadedChatRef.current !== chatId;
    
    logger.info(`[Chat.useEffect1] isNewChat: ${isNewChat}, isDifferentChat: ${isDifferentChat}`);
    
    // Clear processed flag if switching to a different chat
    if (isDifferentChat) {
      processedChatRef.current = null;
      logger.info(`[Chat.useEffect1] CLEARED processed flag for different chat`);
    }

    if (!chatId || !isActive) {
      logger.info(`[Chat.useEffect1] EARLY RETURN - chatId: ${chatId}, isActive: ${isActive}`);
      return;
    }

    // Mark this chat as processed to prevent duplicate calls
    processedChatRef.current = chatId;
    logger.info(`[Chat.useEffect1] MARKED ${chatId} as processed`);

    if (isNewChat && isDifferentChat) {
      logger.info(`[Chat.useEffect1] HANDLING NEW CHAT`);
      // fresh new chat started by first message
      setFirstMessageSent(false);
      setStreamingMessageId(null);
      setLoading(false);
      setIsLoadingHistory(false);
      loadingHistoryRef.current = null;
      loadedChatRef.current = null;
      setMessages([]);
    } else if (isDifferentChat) {
      logger.info(`[Chat.useEffect1] HANDLING EXISTING CHAT - STARTING LOAD`);
      // existing chat: clear and show skeleton, then load history
      setStreamingMessageId(null);
      setLoading(false);
      setIsLoadingHistory(true);
      loadingHistoryRef.current = chatId;
      loadedChatRef.current = null;
      setMessages([]);
      
      // Check if already loading this specific chat
      const alreadyLoading = currentLoadingChatRef.current === chatId;
      logger.info(`[Chat.useEffect1] Already loading ${chatId}? ${alreadyLoading}`);
      
      if (!alreadyLoading) {
        logger.info(`[Chat.useEffect1] STARTING ASYNC LOAD for ${chatId}`);
        // Load history immediately, no separate useEffect needed
        (async () => {
          if (!mountedRef.current) {
            logger.info(`[Chat.useEffect1] Component unmounted, aborting load for ${chatId}`);
            return;
          }
          
          logger.info(`[Chat.useEffect1] ===== STEP 1: LOADING ALL MESSAGES FROM DB =====`);
          const loadedMessages = await loadChatHistoryImmediate(chatId);
          
          logger.info(`[Chat.useEffect1] ===== STEP 2: CHECKING IF SHOULD RESUME STREAMING =====`);
          await checkAndResumeStreaming(chatId, loadedMessages);
          
          logger.info(`[Chat.useEffect1] ===== BOTH STEPS COMPLETED FOR ${chatId} =====`);
        })();
      } else {
        logger.info(`[Chat.useEffect1] SKIPPING LOAD - already in progress for ${chatId}`);
      }
    } else {
      logger.info(`[Chat.useEffect1] CHAT ALREADY LOADED - no action needed`);
    }

    // Call onActiveStateChange since we've already prevented duplicates at the effect level
    if (onActiveStateChange && chatId) {
      logger.info(`[Chat.useEffect1] Calling onActiveStateChange(${chatId}, ${isActive})`);
      onActiveStateChange(chatId, isActive);
    }
    
    logger.info(`[Chat.useEffect1] === EFFECT COMPLETED ===`);
  }, [chatId, isActive, firstMessage, onActiveStateChange, loadChatHistoryImmediate, checkAndResumeStreaming]);

  // History loading is now handled in the main useEffect above

  useEffect(() => {
    if (chatId && isActive && firstMessage && firstMessage.trim() && config && !firstMessageSent) {
      // Mark this chat as loaded to prevent history loading
      loadedChatRef.current = chatId;
      
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
          <span className={`cursor ${!isLastAssistantMessage || currentChatState !== 'responding' ? 'hidden' : ''}`}>|</span>
        </div>
      </div>
    );
  };

  const frontendBusy = Boolean(loading || isLoadingHistory || streamingMessageId !== null);
  logger.info(`[Chat.render] ===== FRONTEND STATE =====`);
  logger.info(`[Chat.render] Chat: ${chatId}, Messages: ${messages.length}, isLoadingHistory: ${isLoadingHistory}`);
  logger.info(`[Chat.render] loading: ${loading}, streamingMessageId: ${streamingMessageId}, frontendBusy: ${frontendBusy}`);
  
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