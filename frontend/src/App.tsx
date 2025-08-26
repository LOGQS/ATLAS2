// status: complete

import React, { useState, useRef, useEffect, useCallback} from 'react';
import { flushSync } from 'react-dom';
import './styles/App.css';
import LeftSidebar from './components/LeftSidebar';
import RightSidebar from './components/RightSidebar';
import Chat from './components/Chat';
import ModalWindow from './components/ModalWindow';
import AttachedFiles from './components/AttachedFiles';
import KnowledgeSection from './sections/KnowledgeSection';
import GalleryWindow from './sections/GalleryWindow';
import SearchWindow from './sections/SearchWindow';
import SettingsWindow from './sections/SettingsWindow';
import logger from './utils/logger';
import { apiUrl } from './config/api';
import { BrowserStorage } from './utils/BrowserStorage';
import { liveStore } from './utils/LiveStore';
import { useAppState } from './hooks/useAppState';
import { useFileManagement } from './hooks/useFileManagement';

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
  const [pendingFirstMessages, setPendingFirstMessages] = useState<Map<string, string>>(new Map());
  const [isAppInitialized, setIsAppInitialized] = useState(false);

  const { activeModal, handleOpenModal, handleCloseModal } = useAppState();
  const { 
    attachedFiles, 
    fileInputRef, 
    hasUnreadyFiles, 
    initializeAttachedFiles, 
    handleAddFileClick, 
    handleFileSelect, 
    handleRemoveFile, 
    clearAttachedFiles, 
    handleClearAllFiles 
  } = useFileManagement(isAppInitialized);

  useEffect(() => {
    if (isAppInitialized) return;
    
    const initializeApp = async () => {
      logger.info('[App.useEffect] Initializing app');
      liveStore.start();
      await loadChatsFromDatabase();
      await loadActiveChat();
      
      // Restore attached files from localStorage
      initializeAttachedFiles();
      
      setIsAppInitialized(true);
    };
    initializeApp();
  }, [isAppInitialized, initializeAttachedFiles]);

  useEffect(() => {
    const unsubs = chats.map(chat =>
      liveStore.subscribe(chat.id, (_id, snap) => {
        setChats(prev => prev.map(c => c.id === _id ? { ...c, state: snap.state } : c));
      })
    );
    return () => unsubs.forEach(unsub => unsub && unsub());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats.map(c => c.id).join(',')]); 

  const loadActiveChat = async () => {
    try {
      const response = await fetch(apiUrl('/api/db/active-chat'));
      const data = await response.json();
      
      if (response.ok) {
        const activeChat = data.active_chat;
        logger.info('[App.loadActiveChat] Loaded active chat from database:', activeChat);
        
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
      logger.error('[App.loadActiveChat] Failed to load active chat:', error);
    }
  };

  const loadChatsFromDatabase = async () => {
    try {
      logger.info('[App.loadChatsFromDatabase] Loading chats from database');
      const response = await fetch(apiUrl('/api/db/chats'));
      const data = await response.json();
      
      if (response.ok) {
        logger.info('[App.loadChatsFromDatabase] Successfully loaded chats:', data.chats.length);
        const chatsFromDb = data.chats.map((chat: any) => ({
          id: chat.id,
          name: chat.name,
          isActive: false,
          state: chat.state || 'static'
        }));
        
        const settings = BrowserStorage.getUISettings();
        if (settings.chatOrder && settings.chatOrder.length > 0) {
          const orderedChats: ChatItem[] = [];
          const chatMap = new Map<string, ChatItem>(chatsFromDb.map((chat: ChatItem) => [chat.id, chat]));
          
          settings.chatOrder.forEach(chatId => {
            if (chatMap.has(chatId)) {
              const chat = chatMap.get(chatId);
              if (chat) {
                orderedChats.push(chat);
                chatMap.delete(chatId);
              }
            }
          });
          
          chatMap.forEach((chat) => {
            orderedChats.push(chat);
          });
          
          setChats(orderedChats);
        } else {
          setChats(chatsFromDb);
        }
      } else {
        logger.error('[App.loadChatsFromDatabase] Failed to load chats:', data.error);
      }
    } catch (error) {
      logger.error('[App.loadChatsFromDatabase] Failed to load chats:', error);
    }
  };
  const bottomInputRef = useRef<HTMLInputElement>(null);
  const chatRef = useRef<any>(null);

  const createNewChatInBackground = async (chatId: string, chatName: string, firstMessage: string) => {
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
        return;
      }

      logger.info('Chat created successfully in DB');
      
      try {
        await fetch(apiUrl(`/api/db/chat/${chatId}/name`), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name: chatName })
        });
      } catch (error) {
        logger.warn('Failed to set chat name:', error);
      }

      await syncActiveChat(chatId);
    } catch (error) {
      logger.error('Failed to create chat:', error);
    }
  };


  const handleSend = async () => {
    if (message.trim() && !isActiveChatStreaming) {
      if (!hasMessageBeenSent || activeChatId === 'none') {
        const chatId = `chat_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const chatName = message.split(' ').slice(0, 4).join(' ');
        const messageToSend = message;
        const filesToSend = [...attachedFiles]; // Make a copy
        
        setCenterFading(true);
        setHasMessageBeenSent(true);
        document.body.classList.add('chat-active');
        setMessage('');
        clearAttachedFiles(); 
        
        const newChat: ChatItem = {
          id: chatId,
          name: chatName,
          isActive: true,
          state: 'static'
        };
        setChats(prev => prev.map(chat => ({ ...chat, isActive: false })).concat([newChat]));
        setActiveChatId(chatId);
        setPendingFirstMessages(prev => new Map(prev).set(chatId, JSON.stringify({message: messageToSend, files: filesToSend})));
        
        bottomInputRef.current?.focus();
        
        createNewChatInBackground(chatId, chatName, messageToSend);
      } else {
        if (activeChatId !== 'none' && chatRef.current) {
          logger.info('Sending message to active chat:', activeChatId);
          // Pass the current attached files to the chat component
          const filesToSend = [...attachedFiles]; // Make a copy
          chatRef.current.handleNewMessage(message, filesToSend);
          setMessage('');
          clearAttachedFiles();
        } else {
          logger.warn('Attempted to send message but no active chat or invalid ref:', { activeChatId, hasRef: !!chatRef.current });
        }
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (isSendDisabled) {
        logger.info('Enter key pressed but send is disabled:', {
          isActiveChatStreaming,
          hasUnreadyFiles,
          activeChatId
        });
        return;
      }
      logger.info('Enter key pressed on input, sending message for active chat:', activeChatId);
      handleSend();
    }
  };

  const syncActiveChat = async (chatId: string) => {
    try {
      await fetch(apiUrl('/api/db/active-chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ chat_id: chatId })
      });
      
      logger.info('[App.syncActiveChat] Backend sync completed for:', chatId);
    } catch (error) {
      logger.error('[App.syncActiveChat] Failed to sync active chat:', error);
    }
  };


  const handleChatSelect = useCallback((chatId: string) => {
    if (activeChatId === chatId) return;
    
    logger.info('Switching to chat:', chatId);
    
    setActiveChatId(chatId);
    logger.info(`[DIA][APP-switch] to=${chatId}`);
    setChats(prev => prev.map(chat => ({ 
      ...chat, 
      isActive: chat.id === chatId 
    })));
    setMessage('');
    
    if (!hasMessageBeenSent) {
      setHasMessageBeenSent(true);
      document.body.classList.add('chat-active');
    }
    
    syncActiveChat(chatId);
  }, [activeChatId, hasMessageBeenSent]);

  const handleNewChat = () => {
    logger.info('Starting new chat');
    
    // Ensure atomic state updates to prevent render artifacts
    flushSync(() => {
      setHasMessageBeenSent(false);
      setCenterFading(false);
      setActiveChatId('none');
    });
    
    setMessage('');
    setChats(prev => prev.map(chat => ({ ...chat, isActive: false })));
    document.body.classList.remove('chat-active');
    
    syncActiveChat('none');
  };

  const handleDeleteChat = async (chatId: string) => {
    logger.info('Deleting chat:', chatId);
    
    const originalChats = chats;
    const originalPendingMessages = new Map(pendingFirstMessages);
    
    setChats(prev => prev.filter(chat => chat.id !== chatId));
    setPendingFirstMessages(prev => {
      const newMap = new Map(prev);
      newMap.delete(chatId);
      return newMap;
    });
    
    if (activeChatId === chatId) {
      handleNewChat();
    }
    
    try {
      const response = await fetch(apiUrl(`/api/db/chat/${chatId}`), {
        method: 'DELETE'
      });
      
      if (response.ok) {
        logger.info('Chat deleted successfully');
      } else {
        const data = await response.json();
        logger.error('Failed to delete chat:', data.error);
        
        setChats(originalChats);
        setPendingFirstMessages(originalPendingMessages);
      }
    } catch (error) {
      logger.error('Failed to delete chat:', error);
      
      setChats(originalChats);
      setPendingFirstMessages(originalPendingMessages);
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


  const activeChat = chats.find(chat => chat.id === activeChatId);
  const isActiveChatStreaming = activeChatId !== 'none' && activeChat && (activeChat.state === 'thinking' || activeChat.state === 'responding');
  
  const isSendDisabled = isActiveChatStreaming || (chatRef.current?.isBusy?.() ?? false) || hasUnreadyFiles;

  const handleChatStateChange = useCallback((chatId: string, state: 'thinking' | 'responding' | 'static') => {
    logger.info('Chat state changed:', chatId, state);
    setChats(prev => prev.map(chat => 
      chat.id === chatId ? { ...chat, state } : chat
    ));
  }, []);

  const handleFirstMessageSent = useCallback((chatId: string) => {
    logger.info('First message sent for chat:', chatId);
    setPendingFirstMessages(prev => {
      const newMap = new Map(prev);
      newMap.delete(chatId);
      return newMap;
    });
  }, []);

  const handleActiveStateChange = useCallback((chatId: string, isReallyActive: boolean) => {
    logger.info('Chat confirms active state:', chatId, isReallyActive);
    if (isReallyActive) {
      setActiveChatId(chatId);
    } else {
      setActiveChatId(prev => prev === chatId ? 'none' : prev);
    }
  }, []);

  const handleBulkDelete = async (chatIds: string[]) => {
    try {
      logger.info('Bulk deleting chats:', chatIds);
      const response = await fetch(apiUrl('/api/db/chats/bulk-delete'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ chat_ids: chatIds })
      });
      
      if (response.ok) {
        const data = await response.json();
        logger.info('Bulk delete completed:', data.message);
        
        setChats(prev => prev.filter(chat => !chatIds.includes(chat.id)));
        
        
        setPendingFirstMessages(prev => {
          const newMap = new Map(prev);
          chatIds.forEach(id => newMap.delete(id));
          return newMap;
        });
        
        if (chatIds.includes(activeChatId)) {
          await handleNewChat();
        }
      } else {
        const data = await response.json();
        logger.error('Failed to bulk delete chats:', data.error);
      }
    } catch (error) {
      logger.error('Failed to bulk delete chats:', error);
    }
  };

  const handleBulkExport = async (chatIds: string[]) => {
    try {
      logger.info('Bulk exporting chats:', chatIds);
      const response = await fetch(apiUrl('/api/db/chats/bulk-export'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ chat_ids: chatIds })
      });
      
      if (response.ok) {
        const data = await response.json();
        logger.info('Bulk export completed:', data.export_count, 'chats');
        
        data.exported_chats.forEach((chat: any) => {
          const jsonData = JSON.stringify(chat, null, 2);
          const blob = new Blob([jsonData], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          
          const a = document.createElement('a');
          a.href = url;
          a.download = `chat_${chat.name?.replace(/[^a-zA-Z0-9]/g, '_') || chat.id}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        });
      } else {
        const data = await response.json();
        logger.error('Failed to bulk export chats:', data.error);
      }
    } catch (error) {
      logger.error('Failed to bulk export chats:', error);
    }
  };

  const handleBulkImport = async (files: FileList) => {
    try {
      logger.info('Bulk importing chats from', files.length, 'files');
      const chatsToImport: any[] = [];
      
      const fileArray = Array.from(files);
      logger.info('Processing files:', fileArray.map(f => f.name));
      
      for (const file of fileArray) {
        if (file.type === 'application/json' || file.name.endsWith('.json')) {
          try {
            logger.info('Processing file:', file.name);
            const text = await file.text();
            const chatData = JSON.parse(text);
            chatsToImport.push(chatData);
            logger.info('Successfully processed file:', file.name);
          } catch (error) {
            logger.error('Failed to parse JSON file:', file.name, error);
          }
        } else {
          logger.warn('Skipping non-JSON file:', file.name);
        }
      }
      
      if (chatsToImport.length === 0) {
        logger.warn('No valid JSON files found for import');
        return;
      }
      
      const response = await fetch(apiUrl('/api/db/chats/bulk-import'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ chats: chatsToImport })
      });
      
      if (response.ok) {
        const data = await response.json();
        logger.info('Bulk import completed:', data.message);
        
        await loadChatsFromDatabase();
      } else {
        const data = await response.json();
        logger.error('Failed to bulk import chats:', data.error);
      }
    } catch (error) {
      logger.error('Failed to bulk import chats:', error);
    }
  };

  const handleChatReorder = (reorderedChats: ChatItem[]) => {
    setChats(reorderedChats);
  };

  return (
    <div className="app">
      <LeftSidebar 
        chats={chats}
        activeChat={activeChatId}
        onChatSelect={handleChatSelect}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onEditChat={handleEditChat}
        onBulkDelete={handleBulkDelete}
        onBulkExport={handleBulkExport}
        onBulkImport={handleBulkImport}
        onChatsReload={loadChatsFromDatabase}
        onChatReorder={handleChatReorder}
        onOpenModal={handleOpenModal}
      />
      <div className="main-content">
        <div className="chat-container">
          <h1 className={`title ${centerFading ? 'fading' : ''} ${hasMessageBeenSent ? 'hidden' : ''}`}>
            How can I help you?
          </h1>
          <div className={`input-container center ${centerFading ? 'fading' : ''} ${hasMessageBeenSent ? 'hidden' : ''}`}>
            <div className="input-row">
              <div className="input-wrapper">
                <button 
                  className="add-file-button-inline"
                  title="Add File"
                  onClick={handleAddFileClick}
                >
                  +
                </button>
                <input
                  type="text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={handleKeyPress}
                  className="message-input with-file-button"
                  placeholder=""
                />
              </div>
              <button 
                onClick={() => {
                  logger.info('Send button clicked for active chat:', activeChatId);
                  handleSend();
                }} 
                className={`send-button ${isSendDisabled ? 'loading' : ''}`}
                disabled={isSendDisabled}
                title={
                  isActiveChatStreaming ? 'Chat is processing...' :
                  hasUnreadyFiles ? 'Waiting for files to finish processing...' :
                  'Send message'
                }
              >
                {isActiveChatStreaming ? (
                  <div className="loading-spinner"></div>
                ) : hasUnreadyFiles ? (
                  <span style={{ fontSize: '12px', opacity: 0.7 }}>📎</span>
                ) : (
                  '→'
                )}
              </button>
            </div>
            
            <AttachedFiles
              files={attachedFiles}
              onRemoveFile={handleRemoveFile}
              onClearAll={handleClearAllFiles}
              className="main-screen-attached"
            />
            
            {attachedFiles.length > 0 && hasUnreadyFiles && (
              <div style={{ 
                fontSize: '12px', 
                color: 'rgba(255, 255, 255, 0.6)', 
                textAlign: 'center', 
                marginTop: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px'
              }}>
                <span>📎</span>
                <span>Files are still processing... Send will be enabled when ready</span>
              </div>
            )}
          </div>
        </div>
        
        {(hasMessageBeenSent && activeChatId !== 'none') && (
          <>
            <Chat 
              key={activeChatId} 
              ref={chatRef} 
              chatId={activeChatId} 
              isActive={true}
              firstMessage={pendingFirstMessages.get(activeChatId) || ''}
              onChatStateChange={handleChatStateChange}
              onFirstMessageSent={handleFirstMessageSent}
              onActiveStateChange={handleActiveStateChange}
            />
            
            <div className="bottom-input-area">
              <AttachedFiles
                files={attachedFiles}
                onRemoveFile={handleRemoveFile}
                onClearAll={handleClearAllFiles}
                className="chat-screen-attached"
              />
              
              {attachedFiles.length > 0 && hasUnreadyFiles && (
                <div style={{ 
                  fontSize: '11px', 
                  color: 'rgba(255, 255, 255, 0.5)', 
                  textAlign: 'center', 
                  marginTop: '6px',
                  marginBottom: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px'
                }}>
                  <span>📎</span>
                  <span>Files processing... Send disabled until ready</span>
                </div>
              )}
              
              <div className="bottom-input-container">
                <div className="input-wrapper">
                  <button 
                    className="add-file-button-inline"
                    title="Add File"
                    onClick={handleAddFileClick}
                  >
                    +
                  </button>
                  <input
                    ref={bottomInputRef}
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyPress}
                    className="message-input with-file-button"
                    placeholder=""
                  />
                </div>
                <button 
                  onClick={() => {
                    logger.info('Bottom send button clicked for active chat:', activeChatId);
                    handleSend();
                  }} 
                  className={`send-button ${isSendDisabled ? 'loading' : ''}`}
                  disabled={isSendDisabled}
                  title={
                    isActiveChatStreaming ? 'Chat is processing...' :
                    hasUnreadyFiles ? 'Waiting for files to finish processing...' :
                    'Send message'
                  }
                >
                  {isActiveChatStreaming ? (
                    <div className="loading-spinner"></div>
                  ) : hasUnreadyFiles ? (
                    <span style={{ fontSize: '12px', opacity: 0.7 }}>📎</span>
                  ) : (
                    '→'
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      <RightSidebar onOpenModal={handleOpenModal} />
      
      <ModalWindow 
        isOpen={activeModal === 'gallery'} 
        onClose={handleCloseModal}
        className="gallery-modal"
      >
        <GalleryWindow />
      </ModalWindow>
      
      <ModalWindow 
        isOpen={activeModal === 'search'} 
        onClose={handleCloseModal}
        className="search-modal"
      >
        <SearchWindow />
      </ModalWindow>
      
      <ModalWindow 
        isOpen={activeModal === 'settings'} 
        onClose={handleCloseModal}
        className="settings-modal"
      >
        <SettingsWindow />
      </ModalWindow>

      <ModalWindow 
        isOpen={activeModal === 'profiles'} 
        onClose={handleCloseModal}
        className="profiles-modal"
      >
        <KnowledgeSection activeSubsection="profiles" onSubsectionChange={() => {}} />
      </ModalWindow>

      <ModalWindow 
        isOpen={activeModal === 'files'} 
        onClose={handleCloseModal}
        className="files-modal"
      >
        <KnowledgeSection activeSubsection="files" onSubsectionChange={() => {}} />
      </ModalWindow>

      <ModalWindow 
        isOpen={activeModal === 'folders'} 
        onClose={handleCloseModal}
        className="folders-modal"
      >
        <KnowledgeSection activeSubsection="folders" onSubsectionChange={() => {}} />
      </ModalWindow>

      <ModalWindow 
        isOpen={activeModal === 'web'} 
        onClose={handleCloseModal}
        className="web-modal"
      >
        <KnowledgeSection activeSubsection="web" onSubsectionChange={() => {}} />
      </ModalWindow>
      
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileSelect}
        accept="*"
      />
    </div>
  );
}

export default App;
