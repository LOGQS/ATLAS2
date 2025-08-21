// status: complete

import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import UserMessage from './UserMessage';
import ThinkBox from './ThinkBox';
import '../styles/Chat.css';
import '../styles/ThinkBox.css';
import logger from '../utils/logger';
import { apiUrl } from '../config/api';

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
  onStreamingStateChange?: (chatId: string, isStreaming: boolean) => void;
  onChatStateChange?: (chatId: string, state: 'thinking' | 'responding' | 'static') => void;
  isActive?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
  firstMessage?: string;
}

let messageIdCounter = 0;
const generateUniqueMessageId = (): number => {
  return Date.now() * 1000 + (messageIdCounter++);
};

const Chat = forwardRef<any, ChatProps>(({ chatId, onMessageSent, onStreamingStateChange, onChatStateChange, isActive = true, firstMessage }, ref) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDelayedLoading, setShowDelayedLoading] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<number | null>(null);
  const [config, setConfig] = useState<{provider: string, model: string} | null>(null);
  const [firstMessageSent, setFirstMessageSent] = useState(false);
  const [justFinishedStreaming, setJustFinishedStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const loadingHistoryRef = useRef<string | null>(null);
  const loadHistoryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const delayedLoadingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const resumePollRef = useRef<number | null>(null);

  const scrollToBottom = useCallback(() => {
    const container = messagesEndRef.current?.parentElement;
    if (container) {
      logger.info(`[SCROLL] Chat ${chatId} - Before scrollToBottom - scrollTop: ${container.scrollTop}, scrollHeight: ${container.scrollHeight}`);
      container.scrollTop = container.scrollHeight;
      logger.info(`[SCROLL] Chat ${chatId} - After scrollToBottom - scrollTop: ${container.scrollTop}`);
    }
  }, [chatId]);

  const stopResumePolling = useCallback(() => {
    if (resumePollRef.current !== null) {
      clearInterval(resumePollRef.current);
      resumePollRef.current = null;
    }
  }, []);

  const startResumePolling = useCallback((targetChatId: string, assistantMessageId: number) => {
    stopResumePolling();
    resumePollRef.current = window.setInterval(async () => {
      try {
        const [histRes, stateRes] = await Promise.all([
          fetch(apiUrl(`/api/db/chat/${targetChatId}`)),
          fetch(apiUrl(`/api/db/chat/${targetChatId}/state`))
        ]);
        if (!histRes.ok) return;

        const hist = await histRes.json();
        const last = hist.history[hist.history.length - 1];

        if (!last || last.role !== 'assistant') {
          stopResumePolling();
          onStreamingStateChange?.(targetChatId, false);
          return;
        }

        setMessages(prev => prev.map(m =>
          m.id === assistantMessageId
            ? { ...m, content: last.content || '', thoughts: last.thoughts || '', isStreaming: false, isStreamingResponse: true }
            : m
        ));

        if (stateRes.ok) {
          const stateData = await stateRes.json();
          if (stateData.state === 'static') {
            stopResumePolling();
            setStreamingMessageId(null);
            onStreamingStateChange?.(targetChatId, false);
          }
        }
      } catch { /* ignore transient errors */ }
    }, 400);
  }, [onStreamingStateChange, stopResumePolling]);

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
  }, []);


  const loadChatHistoryImmediate = useCallback(async (targetChatId: string) => {
    if (!targetChatId) return;
    
    if (loadingHistoryRef.current === targetChatId) return;
    
    loadingHistoryRef.current = targetChatId;
    
    try {
      logger.info('Loading chat history for:', targetChatId);
      const [historyResponse, stateResponse] = await Promise.all([
        fetch(apiUrl(`/api/db/chat/${targetChatId}`)),
        fetch(apiUrl(`/api/db/chat/${targetChatId}/state`))
      ]);
      
      if (historyResponse.ok) {
        const data = await historyResponse.json();
        
        let chatState = 'static';
        if (stateResponse.ok) {
          const stateData = await stateResponse.json();
          chatState = stateData.state || 'static';
        }
        
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
            isStreaming: isLastAssistant && chatState === 'thinking',
            isStreamingResponse: isLastAssistant && chatState === 'responding'
          };
        });
        
        logger.info('Loaded chat history:', formattedMessages.length, 'messages for chat:', targetChatId);
        setMessages(formattedMessages);
        
      } else if (historyResponse.status === 404) {
        logger.info('Chat not found, starting fresh:', targetChatId);
        setMessages([]);
      } else {
        const errorData = await historyResponse.json();
        logger.error('Failed to load chat history:', errorData.error);
      }
    } catch (error) {
      logger.error('Failed to load chat history:', error);
    } finally {
      loadingHistoryRef.current = null;
    }
  }, []);

  const loadChatHistory = useCallback(async () => {
    if (!chatId) return;
    
    if (loadHistoryTimeoutRef.current) {
      clearTimeout(loadHistoryTimeoutRef.current);
    }
    
    return new Promise<void>((resolve) => {
      loadHistoryTimeoutRef.current = setTimeout(async () => {
        await loadChatHistoryImmediate(chatId);
        resolve();
      }, 10);
    });
  }, [chatId, loadChatHistoryImmediate]);

  const checkAndResumeStreaming = useCallback(async (targetChatId: string, messages: Message[]) => {
    try {
      const response = await fetch(apiUrl(`/api/db/chat/${targetChatId}/state`));
      const data = await response.json();
      
      if (response.ok) {
        const chatState = data.state;
        
        if (chatState && (chatState === 'thinking' || chatState === 'responding')) {
          logger.info('Resuming streaming for chat:', targetChatId, 'state:', chatState);
          
          logger.info('Reloading chat history to get latest content from backend...');
          await loadChatHistoryImmediate(targetChatId);
          
          setTimeout(() => {
            setMessages(prev => {
              const lastAssistantMessage = prev.slice().reverse().find(msg => msg.role === 'assistant');
              
              if (lastAssistantMessage) {
                setStreamingMessageId(lastAssistantMessage.id);
                
                if (onStreamingStateChange) {
                  onStreamingStateChange(targetChatId, true);
                }
                
                const next = prev.map(msg => 
                  msg.id === lastAssistantMessage.id 
                    ? { 
                        ...msg, 
                        isStreaming: chatState === 'thinking',
                        isStreamingResponse: chatState === 'responding'
                      }
                    : msg
                );
                
                startResumePolling(targetChatId, lastAssistantMessage.id);
                return next;
              }
              return prev;
            });
          }, 100);
        }
      }
    } catch (error) {
      logger.error('Error checking chat state for resume:', error);
    }
  }, [onStreamingStateChange, loadChatHistoryImmediate, startResumePolling]);

  const verifyAllChunksProcessed = useCallback(async (assistantMessageId: number) => {
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      
      if (chatId) {
        const response = await fetch(apiUrl(`/api/db/chat/${chatId}`));
        if (response.ok) {
          const data = await response.json();
          const lastMessage = data.history[data.history.length - 1];
          
          if (lastMessage && lastMessage.role === 'assistant') {
            setMessages(prev => prev.map(msg => {
              if (msg.id === assistantMessageId) {
                const newContent = lastMessage.content || msg.content;
                const newThoughts = lastMessage.thoughts || msg.thoughts;
                
                const contentChanged = newContent !== msg.content || newThoughts !== msg.thoughts;
                
                if (contentChanged) {
                  logger.info('Verified and updated final message content from database');
                  return {
                    ...msg,
                    content: newContent,
                    thoughts: newThoughts,
                    isStreamingResponse: false
                  };
                } else {
                  return { ...msg, isStreamingResponse: false };
                }
              }
              return msg;
            }));
            return;
          }
        }
      }
      
      setMessages(prev => prev.map(msg => 
        msg.id === assistantMessageId 
          ? { ...msg, isStreamingResponse: false }
          : msg
      ));
    } catch (error) {
      logger.error('Error verifying chunks:', error);
      setMessages(prev => prev.map(msg => 
        msg.id === assistantMessageId 
          ? { ...msg, isStreamingResponse: false }
          : msg
      ));
    }
  }, [chatId]);

  const streamAIResponse = useCallback(async (userMessage: string) => {
    if (!isActive) {
      logger.warn('Attempted to stream response to inactive chat:', chatId);
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
      setJustFinishedStreaming(false);
      
      if (onStreamingStateChange) {
        onStreamingStateChange(chatId!, true);
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
        })
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
        
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const jsonStr = line.slice(6);
              const chunk = JSON.parse(jsonStr);

              if (chunk.type === 'chat_state') {
                if (onChatStateChange && chunk.chat_id) {
                  onChatStateChange(chunk.chat_id, chunk.state);
                }
              } else if (chunk.type === 'thoughts') {
                if (delayedLoadingTimeoutRef.current) {
                  clearTimeout(delayedLoadingTimeoutRef.current);
                  delayedLoadingTimeoutRef.current = null;
                }
                setShowDelayedLoading(false);
                
                logger.info(`[SCROLL] Chat ${chatId} - Updating thoughts during streaming (thoughts chunk)`);
                setMessages(prev => prev.map(msg => 
                  msg.id === assistantMessageId 
                    ? { ...msg, thoughts: (msg.thoughts || '') + chunk.content }
                    : msg
                ));
              } else if (chunk.type === 'answer') {
                if (delayedLoadingTimeoutRef.current) {
                  clearTimeout(delayedLoadingTimeoutRef.current);
                  delayedLoadingTimeoutRef.current = null;
                }
                setShowDelayedLoading(false);
                
                logger.info(`[SCROLL] Chat ${chatId} - Updating message content during streaming (answer chunk)`);
                setMessages(prev => prev.map(msg => 
                  msg.id === assistantMessageId 
                    ? { 
                        ...msg, 
                        isStreaming: false,
                        isStreamingResponse: true,
                        content: msg.content + chunk.content 
                      }
                    : msg
                ));
              } else if (chunk.type === 'complete') {
                if (delayedLoadingTimeoutRef.current) {
                  clearTimeout(delayedLoadingTimeoutRef.current);
                  delayedLoadingTimeoutRef.current = null;
                }
                setShowDelayedLoading(false);
                
                await verifyAllChunksProcessed(assistantMessageId);
                logger.info('Streaming complete for message');
                logger.info(`[SCROLL] Chat ${chatId} - Setting streamingMessageId to null (streaming complete)`);
                setStreamingMessageId(null);
                setJustFinishedStreaming(true);
                setLoading(false);
                
                if (onStreamingStateChange) {
                  onStreamingStateChange(chatId!, false);
                }
              }
            } catch (e) {
              logger.error('Error parsing chunk:', e);
            }
          }
        }
      }
    } catch (error) {
      if (delayedLoadingTimeoutRef.current) {
        clearTimeout(delayedLoadingTimeoutRef.current);
        delayedLoadingTimeoutRef.current = null;
      }
      setShowDelayedLoading(false);
      
      logger.error('Streaming error:', error);
      setLoading(false);
      logger.info(`[SCROLL] Chat ${chatId} - Setting streamingMessageId to null (streaming error)`);
      setStreamingMessageId(null);
      
      if (onStreamingStateChange) {
        onStreamingStateChange(chatId!, false);
      }
      
      setMessages(prev => prev.map(msg => 
        msg.isStreaming 
          ? { 
              ...msg, 
              isStreaming: false, 
              content: msg.content || 'Error: Failed to get response from server' 
            }
          : msg
      ));
    }
  }, [config, onStreamingStateChange, chatId, onChatStateChange, verifyAllChunksProcessed, isActive]);

  const handleNewMessage = useCallback((content: string) => {
    if (!isActive) {
      logger.warn('Attempted to send message to inactive chat:', chatId);
      return;
    }

    logger.info('New message for active chat:', chatId, content.substring(0, 50));
    setLoading(true);

    streamAIResponse(content);
    
    if (onMessageSent) {
      onMessageSent(content);
    }
  }, [streamAIResponse, onMessageSent, isActive, chatId]);

  useImperativeHandle(ref, () => ({
    handleNewMessage
  }));

  useEffect(() => {
    logger.info('Chat ID changed to:', chatId, 'clearing all state');
    setMessages([]);
    setFirstMessageSent(false);
    setJustFinishedStreaming(false);
    setShowDelayedLoading(false);
    setStreamingMessageId(null);
    setLoading(false);
    loadingHistoryRef.current = null;
    
    if (loadHistoryTimeoutRef.current) {
      clearTimeout(loadHistoryTimeoutRef.current);
      loadHistoryTimeoutRef.current = null;
    }
    
    if (delayedLoadingTimeoutRef.current) {
      clearTimeout(delayedLoadingTimeoutRef.current);
      delayedLoadingTimeoutRef.current = null;
    }
    
    stopResumePolling();
  }, [chatId, stopResumePolling]);

  useEffect(() => {
    if (chatId && isActive && streamingMessageId === null && !(firstMessage && !firstMessageSent) && !justFinishedStreaming) {
      logger.info(`[SCROLL] Chat ${chatId} - useEffect[chatId,streamingMessageId,...] - triggering loadChatHistory`);
      loadChatHistory().then(() => {
        setTimeout(() => {
          checkAndResumeStreaming(chatId, []);
        }, 100);
      });
    }
  }, [chatId, isActive, streamingMessageId, firstMessage, firstMessageSent, justFinishedStreaming, loadChatHistory, checkAndResumeStreaming]);

  useEffect(() => {
    if (chatId && isActive && firstMessage && firstMessage.trim() && config && !firstMessageSent) {
      setTimeout(() => {
        handleNewMessage(firstMessage);
        setFirstMessageSent(true);
      }, 200);
    }
  }, [chatId, isActive, firstMessage, config, firstMessageSent, handleNewMessage]);

  useEffect(() => {
    return () => {
      if (delayedLoadingTimeoutRef.current) {
        clearTimeout(delayedLoadingTimeoutRef.current);
      }
      if (loadHistoryTimeoutRef.current) {
        clearTimeout(loadHistoryTimeoutRef.current);
      }
      stopResumePolling();
    };
  }, [stopResumePolling]);

  const renderMessage = (message: Message, index: number) => {
    if (message.role === 'user') {
      const isFirstMessage = index === 0 && message.role === 'user';
      return (
        <UserMessage 
          key={message.id}
          content={message.content}
          isFirstMessage={isFirstMessage}
        />
      );
    }

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
          <span className={`cursor ${!message.isStreamingResponse ? 'hidden' : ''}`}>|</span>
        </div>
      </div>
    );
  };

  return (
    <div className="chat-messages">
      <div className="messages-container">
        <div className="spacer" style={{flexGrow: 1}}></div>
        {messages.slice().reverse().map((message, index) => renderMessage(message, messages.length - 1 - index))}
        {loading && messages.length > 0 && !streamingMessageId && (
          <div className="typing-indicator">
            <div className="typing-animation">
              <div className="dot"></div>
              <div className="dot"></div>
              <div className="dot"></div>
            </div>
          </div>
        )}
        {showDelayedLoading && (
          <div className="delayed-loading-indicator">
            <div className="delayed-loading-content">
              <div className="delayed-loading-spinner"></div>
              <span>Thinking...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
});

Chat.displayName = 'Chat';

export default Chat;