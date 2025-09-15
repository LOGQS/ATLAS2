// status: complete

import React, { useState, useRef, useEffect, useCallback} from 'react';
import './styles/app/App.css';
import LeftSidebar from './components/layout/LeftSidebar';
import RightSidebar from './components/layout/RightSidebar';
import Chat from './components/chat/Chat';
import ModalWindow from './components/ui/ModalWindow';
import AttachedFiles from './components/files/AttachedFiles';
import ChatVersionsWindow from './components/chat/ChatVersionsWindow';
import KnowledgeSection from './sections/KnowledgeSection';
import GalleryWindow from './sections/GalleryWindow';
import SearchWindow from './sections/SearchWindow';
import SettingsWindow from './sections/SettingsWindow';
import logger from './utils/core/logger';
import { performanceTracker } from './utils/core/performanceTracker';
import { apiUrl } from './config/api';
import { BrowserStorage } from './utils/storage/BrowserStorage';
import { liveStore, sendButtonStateManager } from './utils/chat/LiveStore';
import { useAppState } from './hooks/app/useAppState';
import { useFileManagement } from './hooks/files/useFileManagement';
import { useDragDrop } from './hooks/files/useDragDrop';
// TEST_FRAMEWORK_IMPORT - Remove this line and the next to remove test framework
import TestUI from './tests/versioning/TestUI';

interface ChatItem {
  id: string;
  name: string;
  isActive: boolean;
  state?: 'thinking' | 'responding' | 'static';
  last_active?: string;
}


function App() {
  const [message, setMessage] = useState('');
  const [hasMessageBeenSent, setHasMessageBeenSent] = useState(false);
  const [centerFading, setCenterFading] = useState(false);
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [activeChatId, setActiveChatId] = useState<string>('none');
  const [pendingFirstMessages, setPendingFirstMessages] = useState<Map<string, string>>(new Map());
  const [isAppInitialized, setIsAppInitialized] = useState(false);
  const [forceRender, setForceRender] = useState(0);
  const [sendDisabledFlag, setSendDisabledFlag] = useState(false);
  const [sendingByChat, setSendingByChat] = useState<Map<string, boolean>>(new Map());
  const setIsMessageBeingSent = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((value) => {
    setSendingByChat(prev => {
      const next = new Map(prev);
      if (activeChatId && activeChatId !== 'none') {
        const current = prev.get(activeChatId) ?? false;
        const final = typeof value === 'function' ? (value as (prevState: boolean) => boolean)(current) : value;
        next.set(activeChatId, final);
      }
      return next;
    });
  }, [activeChatId]);

  const { activeModal, handleOpenModal, handleCloseModal } = useAppState();
  const { 
    attachedFiles, 
    fileInputRef, 
    hasUnreadyFiles, 
    initializeAttachedFiles, 
    handleAddFileClick, 
    handleFileSelect, 
    handleFileSelectionImmediate,
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

  useEffect(() => {
    if (!activeChatId || activeChatId === 'none') {
      setSendDisabledFlag(false);
      return;
    }
    const unsubscribe = sendButtonStateManager.subscribe(activeChatId, (isDisabled) => {
      setSendDisabledFlag(isDisabled);
      // Nudge a render in case nothing else changes
      setForceRender(v => v + 1);
    });
    return () => {
      unsubscribe();
    };
  }, [activeChatId]);

  const loadActiveChat = async () => {
    try {
      const response = await fetch(apiUrl('/api/db/active-chat'));
      const data = await response.json();
      
      if (response.ok) {
        const activeChat = data.active_chat;
        logger.info('[App.loadActiveChat] Loaded active chat from database:', activeChat);
        
        if (activeChat && activeChat !== 'none') {
          setActiveChatId(activeChat);
          logger.info(`[ActiveChatId] Set initial active chat: ${activeChat}`);
          setHasMessageBeenSent(true);
          document.body.classList.add('chat-active');
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
          isActive: chat.isActive,
          state: chat.state || 'static',
          last_active: chat.last_active
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
  const centerInputRef = useRef<HTMLTextAreaElement>(null);
  const bottomInputRef = useRef<HTMLTextAreaElement>(null);
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
      } else {
        const data = await response.json();
        if (data.message === 'Chat already exists') {
          logger.info('Chat already exists in database (auto-created), proceeding');
        } else {
          logger.info('Chat created successfully in DB');
        }
      }
      
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
    logger.info('[SEND_DEBUG] handleSend called:', {
      messageLength: message.length,
      messageTrimmed: message.trim().length,
      isSendDisabled,
      isActiveChatStreaming,
      chatRefIsBusy: chatRef.current?.isBusy?.() ?? null,
      hasUnreadyFiles,
      activeChatId
    });

    if (message.trim() && !isSendDisabled) {
      setIsMessageBeingSent(true);
      if (!hasMessageBeenSent || activeChatId === 'none') {
        const chatId = `chat_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const chatName = message.split(' ').slice(0, 4).join(' ');

        performanceTracker.startTracking(chatId, chatId);
        performanceTracker.mark(performanceTracker.MARKS.CHAT_CREATED, chatId);
        const messageToSend = message;
        const filesToSend = [...attachedFiles];
        
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
        logger.info(`[ActiveChatId] Changed to new chat: ${chatId}`);
        logger.info(`[SidebarHighlight] Set to highlight new chat: ${chatId} (${chatName})`);
        setPendingFirstMessages(prev => new Map(prev).set(chatId, JSON.stringify({message: messageToSend, files: filesToSend})));
        
        setTimeout(() => bottomInputRef.current?.focus(), 100);
        
        createNewChatInBackground(chatId, chatName, messageToSend);
      } else {
        if (activeChatId !== 'none' && chatRef.current) {
          logger.info('Sending message to active chat:', activeChatId);
          const filesToSend = [...attachedFiles]; 
          chatRef.current.handleNewMessage(message, filesToSend);
          setMessage('');
          clearAttachedFiles();
          
          setTimeout(() => bottomInputRef.current?.focus(), 0);
        } else {
          logger.warn('Attempted to send message but no active chat or invalid ref:', { activeChatId, hasRef: !!chatRef.current });
        }
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
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


  const handleChatSelect = useCallback(async (chatId: string) => {
    if (activeChatId === chatId) return;
    
    logger.info('[MANUAL_SWITCH] ===== STARTING MANUAL CHAT SWITCH =====');
    logger.info('[MANUAL_SWITCH] Switching to chat:', chatId);
    
    const clickedChat = chats.find(chat => chat.id === chatId);
    let targetChatId = chatId;
    
    if (clickedChat?.last_active && clickedChat.last_active !== chatId) {
      logger.info(`[VersionMemory] Main chat ${chatId} has remembered version: ${clickedChat.last_active}`);
      
      try {
        const checkResponse = await fetch(apiUrl(`/api/db/chat/${clickedChat.last_active}`));
        if (checkResponse.ok) {
          targetChatId = clickedChat.last_active;
          logger.info(`[VersionMemory] Switching to remembered version: ${targetChatId}`);
        } else {
          logger.info(`[VersionMemory] Remembered version ${clickedChat.last_active} no longer exists, using main chat`);
          targetChatId = chatId;
        }
      } catch (error) {
        logger.warn(`[VersionMemory] Error checking remembered version: ${error}, using main chat`);
        targetChatId = chatId;
      }
    }
    
    logger.info(`[MANUAL_SWITCH] Setting activeChatId to: ${targetChatId}`);
    setActiveChatId(targetChatId);
    logger.info(`[MANUAL_SWITCH] ActiveChatId changed to: ${targetChatId}`);
    logger.info(`[MANUAL_SWITCH] Updating sidebar highlighting`);
    setChats(prev => prev.map(chat => ({ 
      ...chat, 
      isActive: chat.id === chatId 
    })));
    logger.info(`[MANUAL_SWITCH] Sidebar highlighted: ${chatId}`);
    logger.info(`[MANUAL_SWITCH] Clearing input and message states`);
    setMessage('');
    setSendingByChat(prev => {
      const next = new Map(prev);
      next.set(targetChatId, false);
      return next;
    });
    
    if (!hasMessageBeenSent) {
      logger.info(`[MANUAL_SWITCH] Setting hasMessageBeenSent=true`);
      setHasMessageBeenSent(true);
      document.body.classList.add('chat-active');
    }
    
    logger.info(`[MANUAL_SWITCH] Syncing active chat with backend`);
    await syncActiveChat(targetChatId);
    logger.info(`[MANUAL_SWITCH] Backend sync completed`);
    
    if (targetChatId !== chatId) {
      logger.info(`[MANUAL_SWITCH] Reloading chats for version highlighting update`);
      await loadChatsFromDatabase();
    }
    
    logger.info('[MANUAL_SWITCH] ===== MANUAL CHAT SWITCH COMPLETED =====');
  }, [activeChatId, hasMessageBeenSent, chats]);

  const handleChatSwitch = useCallback(async (newChatId: string) => {
    logger.info('[VERSION_SWITCH] ===== STARTING VERSION CHAT SWITCH =====');
    logger.info('[VERSION_SWITCH] Switching to version chat:', newChatId);
    
    if (activeChatId !== 'none') {
      setSendingByChat(prev => {
        const next = new Map(prev);
        next.delete(activeChatId);
        logger.info(`[VERSION_SWITCH] Cleared sending state for parent chat: ${activeChatId}`);
        return next;
      });
    }
    
    logger.info(`[VERSION_SWITCH] Setting activeChatId to: ${newChatId}`);
    setActiveChatId(newChatId);
    logger.info(`[VERSION_SWITCH] ActiveChatId changed to version chat: ${newChatId}`);
    
    logger.info(`[VERSION_SWITCH] Syncing active chat with backend`);
    await syncActiveChat(newChatId);
    logger.info(`[VERSION_SWITCH] Backend sync completed`);
    
    logger.info(`[VERSION_SWITCH] Reloading chats for parent highlighting update`);
    await loadChatsFromDatabase();
    logger.info(`[VERSION_SWITCH] Chats reloaded`);
    
    logger.info('[VERSION_SWITCH] ===== VERSION CHAT SWITCH COMPLETED =====');
  }, [activeChatId]);

  useEffect(() => {
    (window as any).handleChatSwitch = handleChatSwitch;
    
    return () => {
      delete (window as any).handleChatSwitch;
    };
  }, [handleChatSwitch]);

  const handleNewChat = () => {
    logger.info('Starting new chat');
    
    setHasMessageBeenSent(false);
    setCenterFading(false);
    setActiveChatId('none');
    
    logger.info(`[ActiveChatId] Changed to: none`);
    setMessage('');
    setSendingByChat(new Map());
    setChats(prev => prev.map(chat => ({ ...chat, isActive: false })));
    logger.info(`[SidebarHighlight] Cleared all highlighting (none selected)`);
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
    
    let shouldReturnToMainScreen = activeChatId === chatId;
    
    try {
      const response = await fetch(apiUrl(`/api/db/chat/${chatId}`), {
        method: 'DELETE'
      });
      
      if (response.ok) {
        const data = await response.json();
        logger.info('Chat deleted successfully');
        
        if (data.cascade_deleted && data.deleted_chats && activeChatId !== 'none') {
          shouldReturnToMainScreen = data.deleted_chats.includes(activeChatId);
          if (shouldReturnToMainScreen) {
            logger.info(`[CASCADE_DELETE] Current active chat ${activeChatId} was cascade deleted, returning to main screen`);
          }
        }
        
        if (shouldReturnToMainScreen) {
          handleNewChat();
        }
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
  const isSendInProgressForActive = sendingByChat.get(activeChatId) === true;
  const isGlobalSendDisabled = sendDisabledFlag;
  const isSendDisabled = isActiveChatStreaming || (chatRef.current?.isBusy?.() ?? false) || hasUnreadyFiles || isSendInProgressForActive || isGlobalSendDisabled;

  const { isDragOver, dragHandlers } = useDragDrop({
    onFilesDropped: handleFileSelectionImmediate,
    disabled: isSendDisabled
  });

  void forceRender; 

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

  const handleBusyStateChange = useCallback(() => {
    logger.info('[SEND_DEBUG] Chat busy state changed, forcing re-render');
    setForceRender(prev => prev + 1);
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
        
        const actuallyDeletedChats = data.deleted_chats || chatIds;
        logger.info(`[BULK_DELETE] Removed ${actuallyDeletedChats.length} chats from UI (requested: ${chatIds.length}, cascade: ${data.cascade_deleted})`);
        
        setChats(prev => prev.filter(chat => !actuallyDeletedChats.includes(chat.id)));
        
        setPendingFirstMessages(prev => {
          const newMap = new Map(prev);
          actuallyDeletedChats.forEach((id: string) => newMap.delete(id));
          return newMap;
        });
        
        if (data.active_chat_cleared) {
          logger.info('[BULK_DELETE] Active chat was cleared by backend, creating new chat');
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

  // TEST_FRAMEWORK_CONDITIONAL - Remove this block to remove test framework
  // Access test UI by adding ?test=versioning to the URL
  if (window.location.search.includes('test=versioning')) {
    return <TestUI />;
  }
  // END_TEST_FRAMEWORK_CONDITIONAL

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
        // TEMPORARY_DEBUG_TRIGGERLOG - props for debugging MessageVersionSwitcher visibility
        triggerLogProps={{
          activeChatId
        }}
      />
      <div className="main-content">
        <div className="chat-container">
          <h1 className={`title ${centerFading ? 'fading' : ''} ${hasMessageBeenSent ? 'hidden' : ''}`}>
            How can I help you?
          </h1>
          <div className={`input-container center ${centerFading ? 'fading' : ''} ${hasMessageBeenSent ? 'hidden' : ''}`}>
            <div className="input-row">
              <div 
                className={`input-wrapper ${isDragOver ? 'drag-over' : ''}`}
                {...dragHandlers}
              >
                <button 
                  className="add-file-button-inline"
                  title="Add File"
                  onClick={handleAddFileClick}
                >
                  +
                </button>
                <textarea
                  ref={centerInputRef}
                  value={message}
                  onChange={(e) => {
                    logger.info('[INPUT_DEBUG] Center input onChange:', {
                      newValue: e.target.value,
                      oldValue: message,
                      isSendDisabled,
                      isActiveChatStreaming,
                      chatRefIsBusy: chatRef.current?.isBusy?.() ?? null
                    });
                    setMessage(e.target.value);
                  }}
                  onKeyDown={handleKeyPress}
                  className="message-input with-file-button"
                  placeholder=""
                  rows={1}
                />
              </div>
              <button 
                onClick={() => {
                  logger.info('[SEND_DEBUG] Center send button clicked:', {
                    activeChatId,
                    messageLength: message.length,
                    isSendDisabled,
                    isActiveChatStreaming,
                    chatRefIsBusy: chatRef.current?.isBusy?.() ?? null,
                    hasUnreadyFiles
                  });
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
              onBusyStateChange={handleBusyStateChange}
              setIsMessageBeingSent={setIsMessageBeingSent}
              onChatSwitch={handleChatSwitch}
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
                <div 
                  className={`input-wrapper ${isDragOver ? 'drag-over' : ''}`}
                  {...dragHandlers}
                >
                  <button 
                    className="add-file-button-inline"
                    title="Add File"
                    onClick={handleAddFileClick}
                  >
                    +
                  </button>
                  <textarea
                    ref={bottomInputRef}
                    value={message}
                    onChange={(e) => {
                      logger.info('[INPUT_DEBUG] Bottom input onChange:', {
                        newValue: e.target.value,
                        oldValue: message,
                        isSendDisabled,
                        isActiveChatStreaming,
                        chatRefIsBusy: chatRef.current?.isBusy?.() ?? null
                      });
                      setMessage(e.target.value);
                    }}
                    onKeyDown={handleKeyPress}
                    className="message-input with-file-button"
                    placeholder=""
                    rows={1}
                  />
                </div>
                <button 
                  onClick={() => {
                    logger.info('[SEND_DEBUG] Bottom send button clicked:', {
                      activeChatId,
                      messageLength: message.length,
                      isSendDisabled,
                      isActiveChatStreaming,
                      chatRefIsBusy: chatRef.current?.isBusy?.() ?? null,
                      hasUnreadyFiles
                    });
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
      <RightSidebar 
        onOpenModal={handleOpenModal} 
        chatId={activeChatId !== 'none' ? activeChatId : undefined}
      />
      
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

      <ChatVersionsWindow
        isOpen={activeModal === 'chat-versions'}
        onClose={handleCloseModal}
        chatId={activeChatId !== 'none' ? activeChatId : undefined}
      />
      
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
