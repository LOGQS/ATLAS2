// status: complete

import React, { useState, useRef, useEffect, useCallback} from 'react';
import './styles/App.css';
import LeftSidebar from './components/LeftSidebar';
import RightSidebar from './components/RightSidebar';
import Chat from './components/Chat';
import logger from './utils/logger';
import { apiUrl } from './config/api';

interface ChatItem {
  id: string;
  name: string;
  isActive: boolean;
  state?: 'thinking' | 'responding' | 'static';
}

function App() {
  const [message, setMessage] = useState('');
  const [hasMessageBeenSent, setHasMessageBeenSent] = useState(false);
  const [centerFading, setCenterFading] = useState(false);
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [activeChatId, setActiveChatId] = useState<string>('none');
  const [firstMessage, setFirstMessage] = useState<string>('');
  const [streamingChats, setStreamingChats] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadChatsFromDatabase();
    loadActiveChat();
  }, []);

  const loadActiveChat = async () => {
    try {
      const response = await fetch(apiUrl('/api/db/active-chat'));
      const data = await response.json();
      
      if (response.ok) {
        const activeChat = data.active_chat;
        logger.info('Loaded active chat from database:', activeChat);
        
        if (activeChat && activeChat !== 'none') {
          setActiveChatId(activeChat);
          setHasMessageBeenSent(true);
          document.body.classList.add('chat-active');
          
          setChats(prev => prev.map(chat => ({ 
            ...chat, 
            isActive: chat.id === activeChat 
          })));
        }
      }
    } catch (error) {
      logger.error('Failed to load active chat:', error);
    }
  };

  const loadChatsFromDatabase = async () => {
    try {
      logger.info('Loading chats from database');
      const response = await fetch(apiUrl('/api/db/chats'));
      const data = await response.json();
      
      if (response.ok) {
        logger.info('Successfully loaded chats:', data.chats.length);
        setChats(data.chats.map((chat: any) => ({
          id: chat.id,
          name: chat.name,
          isActive: false,
          state: chat.state || 'static'
        })));
      } else {
        logger.error('Failed to load chats:', data.error);
      }
    } catch (error) {
      logger.error('Failed to load chats:', error);
    }
  };
  const bottomInputRef = useRef<HTMLInputElement>(null);
  const chatRef = useRef<any>(null);

  const createNewChat = async (firstMessageText: string) => {
    const chatId = `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const chatName = firstMessageText.split(' ').slice(0, 4).join(' ');
    
    logger.info('Creating new chat in DB:', { chatId, chatName });
    
    try {
      const response = await fetch(apiUrl('/api/db/chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          system_prompt: null
        })
      });

      if (!response.ok) {
        const data = await response.json();
        logger.error('Failed to create chat in database:', data.error);
        return null;
      }

      logger.info('Chat created successfully in DB');
      
      try {
        const nameResponse = await fetch(apiUrl(`/api/db/chat/${chatId}/name`), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name: chatName })
        });
        
        if (!nameResponse.ok) {
          logger.warn('Failed to set chat name, but continuing with creation');
        }
      } catch (error) {
        logger.warn('Failed to set chat name:', error);
      }

      const newChat: ChatItem = {
        id: chatId,
        name: chatName,
        isActive: true,
        state: 'static'
      };

      setChats(prev => prev.map(chat => ({ ...chat, isActive: false })).concat([newChat]));
      await setActiveChat(chatId);
      return chatId;
    } catch (error) {
      logger.error('Failed to create chat:', error);
      return null;
    }
  };

  const handleSend = async () => {
    if (message.trim() && !isActiveChatStreaming) {
      if (!hasMessageBeenSent) {
        const chatId = await createNewChat(message);
        if (chatId) {
          setFirstMessage(message);
          setCenterFading(true);
          setTimeout(() => {
            setHasMessageBeenSent(true);
            document.body.classList.add('chat-active');
            setTimeout(() => {
              setMessage('');
              bottomInputRef.current?.focus();
            }, 400);
          }, 500);
        }
      } else {
        if (activeChatId !== 'none' && chatRef.current) {
          logger.info('Sending message to active chat:', activeChatId);
          chatRef.current.handleNewMessage(message);
          setMessage('');
        } else {
          logger.warn('Attempted to send message but no active chat or invalid ref:', { activeChatId, hasRef: !!chatRef.current });
        }
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      logger.info('Enter key pressed on input, sending message for active chat:', activeChatId);
      handleSend();
    }
  };

  const setActiveChat = async (chatId: string) => {
    try {
      await fetch(apiUrl('/api/db/active-chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ chat_id: chatId })
      });
      
      setActiveChatId(chatId);
      logger.info('Active chat changed to:', chatId);
    } catch (error) {
      logger.error('Failed to set active chat:', error);
      setActiveChatId(chatId);
    }
  };

  const handleChatSelect = async (chatId: string) => {
    logger.info('Switching to chat:', chatId);
    setChats(prev => prev.map(chat => ({ 
      ...chat, 
      isActive: chat.id === chatId 
    })));
    
    setMessage('');
    setFirstMessage('');
    
    await setActiveChat(chatId);
    
    if (!hasMessageBeenSent) {
      setHasMessageBeenSent(true);
      document.body.classList.add('chat-active');
    }
  };

  const handleNewChat = async () => {
    logger.info('Starting new chat');
    setHasMessageBeenSent(false);
    setCenterFading(false);
    setMessage('');
    setFirstMessage('');
    
    setStreamingChats(new Set());
    
    await setActiveChat('none');
    setChats(prev => prev.map(chat => ({ ...chat, isActive: false })));
    document.body.classList.remove('chat-active');
  };

  const handleDeleteChat = async (chatId: string) => {
    try {
      logger.info('Deleting chat:', chatId);
      const response = await fetch(apiUrl(`/api/db/chat/${chatId}`), {
        method: 'DELETE'
      });
      
      if (response.ok) {
        logger.info('Chat deleted successfully');
        setChats(prev => prev.filter(chat => chat.id !== chatId));
        
        setStreamingChats(prev => {
          const newSet = new Set(prev);
          newSet.delete(chatId);
          return newSet;
        });
        
        if (activeChatId === chatId) {
          await handleNewChat();
        }
      } else {
        const data = await response.json();
        logger.error('Failed to delete chat:', data.error);
      }
    } catch (error) {
      logger.error('Failed to delete chat:', error);
    }
  };

  const handleEditChat = async (chatId: string, newName: string) => {
    try {
      logger.info('Updating chat name:', chatId, newName);
      const response = await fetch(apiUrl(`/api/db/chat/${chatId}/name`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: newName })
      });
      
      if (response.ok) {
        logger.info('Chat name updated successfully');
        setChats(prev => prev.map(chat => 
          chat.id === chatId ? { ...chat, name: newName } : chat
        ));
      } else {
        const data = await response.json();
        logger.error('Failed to update chat name:', data.error);
      }
    } catch (error) {
      logger.error('Failed to update chat name:', error);
    }
  };

  const handleStreamingStateChange = useCallback((chatId: string, streaming: boolean) => {
    if (streaming) {
      setStreamingChats(prev => new Set(prev).add(chatId));
      logger.info('Chat started streaming:', chatId);
    } else {
      setStreamingChats(prev => {
        const newSet = new Set(prev);
        newSet.delete(chatId);
        logger.info('Chat stopped streaming:', chatId);
        return newSet;
      });
    }
  }, []);

  const isActiveChatStreaming = activeChatId !== 'none' && streamingChats.has(activeChatId);

  const handleChatStateChange = useCallback((chatId: string, state: 'thinking' | 'responding' | 'static') => {
    logger.info('Chat state changed:', chatId, state);
    setChats(prev => prev.map(chat => 
      chat.id === chatId ? { ...chat, state } : chat
    ));
  }, []);


  return (
    <div className="app">
      <LeftSidebar 
        chats={chats}
        activeChat={activeChatId}
        onChatSelect={handleChatSelect}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onEditChat={handleEditChat}
      />
      <div className="main-content">
        <div className="chat-container">
          <h1 className={`title ${centerFading ? 'fading' : ''} ${hasMessageBeenSent ? 'hidden' : ''}`}>
            How can I help you?
          </h1>
          <div className={`input-container center ${centerFading ? 'fading' : ''} ${hasMessageBeenSent ? 'hidden' : ''}`}>
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyPress}
              className="message-input"
              placeholder=""
            />
            <button 
              onClick={() => {
                logger.info('Send button clicked for active chat:', activeChatId);
                handleSend();
              }} 
              className={`send-button ${isActiveChatStreaming ? 'loading' : ''}`}
              disabled={isActiveChatStreaming}
            >
              {isActiveChatStreaming ? (
                <div className="loading-spinner"></div>
              ) : (
                '→'
              )}
            </button>
          </div>
        </div>
        
        {hasMessageBeenSent && activeChatId !== 'none' && (
          <>
            <Chat 
              key={activeChatId}
              ref={chatRef} 
              chatId={activeChatId} 
              isActive={true}
              firstMessage={firstMessage}
              onStreamingStateChange={handleStreamingStateChange}
              onChatStateChange={handleChatStateChange}
            />
            <div className="bottom-input-container">
              <input
                ref={bottomInputRef}
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyPress}
                className="message-input"
                placeholder=""
              />
              <button 
                onClick={() => {
                  logger.info('Bottom send button clicked for active chat:', activeChatId);
                  handleSend();
                }} 
                className={`send-button ${isActiveChatStreaming ? 'loading' : ''}`}
                disabled={isActiveChatStreaming}
              >
                {isActiveChatStreaming ? (
                  <div className="loading-spinner"></div>
                ) : (
                  '→'
                )}
              </button>
            </div>
          </>
        )}
      </div>
      <RightSidebar />
    </div>
  );
}

export default App;
