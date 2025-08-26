// status: complete

import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import UserMessage from './UserMessage';
import ThinkBox from './ThinkBox';
import MessageRenderer from './MessageRenderer';
import '../styles/Chat.css';
import '../styles/ThinkBox.css';
import '../styles/MessageRenderer.css';
import logger from '../utils/logger';
import { apiUrl } from '../config/api';
import { liveStore } from '../utils/LiveStore';

interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type?: string;
  api_state?: string;
  provider?: string;
}

interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  thoughts?: string;
  provider?: string;
  model?: string;
  timestamp: string;
  attachedFiles?: AttachedFile[];
}

interface ChatProps {
  chatId?: string;
  onMessageSent?: (message: string) => void;
  onChatStateChange?: (chatId: string, state: 'thinking' | 'responding' | 'static') => void;
  onFirstMessageSent?: (chatId: string) => void;
  onActiveStateChange?: (chatId: string, isReallyActive: boolean) => void;
  onBusyStateChange?: () => void;
  isActive?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
  firstMessage?: string;
}

let _mid = 0;
const genId = () => Date.now() * 1000 + (_mid++);

const Chat = forwardRef<any, ChatProps>(({ 
  chatId, 
  onMessageSent, 
  onChatStateChange, 
  onFirstMessageSent, 
  onActiveStateChange, 
  onBusyStateChange,
  isActive = true, 
  firstMessage 
}, ref) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [liveOverlay, setLiveOverlay] = useState({ 
    contentBuf: '', 
    thoughtsBuf: '', 
    state: 'static' as 'thinking' | 'responding' | 'static' 
  });
  const [firstMessageSent, setFirstMessageSent] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const container = messagesEndRef.current?.parentElement;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, []);

  const loadHistory = useCallback(async () => {
    if (!chatId) return;
    
    setIsLoading(true);
    try {
      logger.info(`[Chat] Loading history for ${chatId}`);
      const res = await fetch(apiUrl(`/api/db/chat/${chatId}`));
      const data = await res.json();
      
      if (res.ok) {
        const hist: Message[] = data.history || [];
        
        if (hist.length > 0) {
          setMessages(hist);
          logger.info(`[Chat] Loaded ${hist.length} messages for ${chatId} from DB`);
        } else {
          setMessages(prev => {
            if (prev.length > 0) {
              logger.info(`[Chat] Empty DB for ${chatId} - preserving ${prev.length} optimistic messages`);
              return prev;
            }
            logger.info(`[Chat] Empty DB for ${chatId} - no messages to preserve`);
            return [];
          });
        }
        
        const lastA = [...hist].reverse().find(m => m.role === 'assistant');
        liveStore.reconcileWithDB(chatId, lastA?.id ?? null, lastA?.content ?? '', lastA?.thoughts ?? '');
      } else if (res.status === 404) {
        setMessages(prev => {
          if (prev.length > 0) {
            logger.info(`[Chat] New chat ${chatId} - preserving ${prev.length} optimistic messages`);
            return prev; 
          }
          logger.info(`[Chat] New chat ${chatId} - no messages to preserve`);
          return [];
        });
      } else {
        logger.error(`[Chat] Failed to load history for ${chatId}:`, data.error);
      }
    } catch (e) {
      logger.error(`[Chat] Error loading history for ${chatId}:`, e);
    } finally {
      setIsLoading(false);
    }
  }, [chatId]);

  useEffect(() => {
    if (!chatId) return;
    
    return liveStore.subscribe(chatId, (_id, snap) => {
      setLiveOverlay({
        contentBuf: snap.contentBuf,
        thoughtsBuf: snap.thoughtsBuf,
        state: snap.state
      });
      
      if (onChatStateChange) {
        onChatStateChange(_id, snap.state);
      }
    });
  }, [chatId, onChatStateChange]);

  useEffect(() => {
    if (chatId) {
      loadHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]); 

  useEffect(() => {
    if (chatId && isActive && firstMessage && firstMessage.trim() && !firstMessageSent && !isLoading) {
      logger.info(`[Chat] Sending first message for new chat ${chatId}`);
      
      try {
        const parsed = JSON.parse(firstMessage);
        if (parsed.message && typeof parsed.message === 'string') {
          handleNewMessage(parsed.message, parsed.files || []);
        } else {
          handleNewMessage(firstMessage);
        }
      } catch {
        handleNewMessage(firstMessage);
      }
      
      setFirstMessageSent(true);
      if (onFirstMessageSent) {
        onFirstMessageSent(chatId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isActive, firstMessage, firstMessageSent, isLoading]);

  useEffect(() => {
    if (liveOverlay.state !== 'static' || messages.length > 0) {
      scrollToBottom();
    }
  }, [messages, liveOverlay.contentBuf, liveOverlay.thoughtsBuf, liveOverlay.state, scrollToBottom]);

  useEffect(() => {
    if (onActiveStateChange && chatId) {
      onActiveStateChange(chatId, isActive);
    }
  }, [chatId, isActive, onActiveStateChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (onBusyStateChange && chatId) {
      onBusyStateChange();
    }
  }, [liveOverlay.state, onBusyStateChange, chatId]);

  const handleNewMessage = useCallback(async (content: string, attachedFiles?: AttachedFile[]) => {
    if (!chatId || !isActive) {
      logger.warn(`[Chat] Cannot send message - chatId: ${chatId}, isActive: ${isActive}`);
      return;
    }
    if (liveOverlay.state !== 'static') {
      logger.warn(`[Chat] Cannot send message while streaming (state: ${liveOverlay.state})`);
      return;
    }

    if (liveOverlay.contentBuf || liveOverlay.thoughtsBuf) {
      setMessages(prev => {
        const updated = [...prev];
        const lastAssistantIdx = [...updated].reverse().findIndex(m => m.role === 'assistant');
        
        if (lastAssistantIdx !== -1) {
          const idx = updated.length - 1 - lastAssistantIdx;
          const msg = updated[idx];
          updated[idx] = {
            ...msg,
            content: msg.content + liveOverlay.contentBuf,
            thoughts: (msg.thoughts || '') + liveOverlay.thoughtsBuf
          };
        }
        return updated;
      });
    }

    setLiveOverlay({ contentBuf: '', thoughtsBuf: '', state: 'static' });
    liveStore.reset(chatId);

    const userMsg: Message = {
      id: genId(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      attachedFiles: attachedFiles || []
    };
    const assistantPlaceholder: Message = {
      id: genId(),
      role: 'assistant',
      content: '',
      thoughts: '',
      timestamp: new Date().toISOString()
    };
    setMessages(prev => [...prev, userMsg, assistantPlaceholder]);

    try {
      logger.info(`[Chat] Sending message to ${chatId}: "${content.substring(0, 50)}..."`);
      const response = await fetch(apiUrl('/api/chat/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          chat_id: chatId,
          include_reasoning: true,
          attached_file_ids: attachedFiles ? attachedFiles.map(f => f.id) : []
        })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      logger.info(`[Chat] Message sent successfully for ${chatId}`);
      onMessageSent?.(content);
    } catch (error) {
      logger.error(`[Chat] Failed to send message to ${chatId}:`, error);
    }
  }, [chatId, isActive, liveOverlay, onMessageSent]);

  useImperativeHandle(ref, () => ({
    handleNewMessage,
    isBusy: () => liveOverlay.state !== 'static'
  }));

  const rendered = (() => {
    const out = [...messages];
    
    const lastIdx = [...out].reverse().findIndex(m => m.role === 'assistant');
    
    if (lastIdx !== -1 && (liveOverlay.contentBuf || liveOverlay.thoughtsBuf)) {
      const idx = out.length - 1 - lastIdx;
      const m = out[idx];
      out[idx] = {
        ...m,
        content: m.content + liveOverlay.contentBuf,
        thoughts: (m.thoughts || '') + liveOverlay.thoughtsBuf
      };
    }
    
    return out;
  })();

  const renderMessage = (message: Message, originalIndex: number) => {
    if (message.role === 'user') {
      const isFirstMessage = originalIndex === 0;
      return (
        <UserMessage 
          key={message.id}
          content={message.content}
          isFirstMessage={isFirstMessage}
          attachedFiles={message.attachedFiles}
        />
      );
    }

    const lastAssistantMessage = [...rendered].reverse().find(m => m.role === 'assistant');
    const isLastAssistantMessage = message.id === lastAssistantMessage?.id;
    const showCursor = isLastAssistantMessage && liveOverlay.state === 'responding';

    return (
      <div key={message.id} className="assistant-message">
        {message.thoughts && (
          <ThinkBox 
            thoughts={message.thoughts}
            isStreaming={isLastAssistantMessage && liveOverlay.state === 'thinking'}
            isVisible={true}
            chatId={chatId}
          />
        )}
        
        <div className="response-content">
          <MessageRenderer 
            content={message.content} 
            showCursor={showCursor}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="chat-messages">
      <div className="messages-container">
        <div className="spacer" style={{flexGrow: 1}}></div>
        {isLoading ? (
          <div className="messages-skeleton">
            <div className="msg-skel" />
            <div className="msg-skel" />
          </div>
        ) : (
          rendered.slice().reverse().map((message) => {
            const originalIndex = messages.findIndex(m => m.id === message.id);
            return renderMessage(message, originalIndex);
          })
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
});

Chat.displayName = 'Chat';

export default Chat;