// status: complete

import React, { useState, useRef, useEffect, useCallback} from 'react';
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
import { BrowserStorage, AttachedFile } from './utils/BrowserStorage';
import { liveStore } from './utils/LiveStore';

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
  const [activeModal, setActiveModal] = useState<string | null>(null);
  const [isAppInitialized, setIsAppInitialized] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isAppInitialized) return;
    
    const initializeApp = async () => {
      logger.info('[App.useEffect] Initializing app');
      liveStore.start();
      await loadChatsFromDatabase();
      await loadActiveChat();
      
      // Restore attached files from localStorage
      const savedFiles = BrowserStorage.getAttachedFiles();
      if (savedFiles.length > 0) {
        logger.info('[App.useEffect] Restored attached files from localStorage:', savedFiles.length);
        setAttachedFiles(savedFiles);
      }
      
      setIsAppInitialized(true);
    };
    initializeApp();
  }, [isAppInitialized]);

  useEffect(() => {
    const unsubs = chats.map(chat =>
      liveStore.subscribe(chat.id, (_id, snap) => {
        setChats(prev => prev.map(c => c.id === _id ? { ...c, state: snap.state } : c));
      })
    );
    return () => unsubs.forEach(unsub => unsub && unsub());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats.map(c => c.id).join(',')]); 

  // Save attached files to localStorage whenever they change
  useEffect(() => {
    if (isAppInitialized) {
      BrowserStorage.setAttachedFiles(attachedFiles);
    }
  }, [attachedFiles, isAppInitialized]);

  // Real-time file state updates via SSE (no polling needed!)
  useEffect(() => {
    if (!isAppInitialized) return;

    const handleFileStateUpdate = (event: CustomEvent) => {
      const { file_id, api_state, provider } = event.detail;
      logger.info(`[App] Received SSE file state update: ${file_id} -> ${api_state}`);
      
      setAttachedFiles(prev => {
        let matchFound = false;
        let tempFileMatched = false;
        
        const updated = prev.map(file => {
          // First try exact ID match
          if (file.id === file_id) {
            const oldState = file.api_state;
            const newFile = { ...file, api_state, provider: provider || file.provider };
            logger.info(`[App] Updated file state by ID: ${file.name} ${oldState} -> ${api_state}`);
            matchFound = true;
            return newFile;
          }
          return file;
        });
        
        // If no ID match, try to match temp files by name (race condition fix)
        if (!matchFound) {
          const tempUpdated = prev.map(file => {
            // Match temp files that are still being processed
            if (file.id.startsWith('temp_') && ['selected', 'processing_md', 'uploading'].includes(file.api_state || 'selected')) {
              const oldState = file.api_state;
              const newFile = { 
                ...file, 
                id: file_id, // Update to real ID
                api_state, 
                provider: provider || file.provider 
              };
              logger.info(`[App] Updated temp file by name match: ${file.name} ${oldState} -> ${api_state} (ID: ${file.id} -> ${file_id})`);
              tempFileMatched = true;
              return newFile;
            }
            return file;
          });
          
          if (tempFileMatched) {
            return tempUpdated;
          } else {
            logger.warn(`[App] No file found with ID ${file_id}, will be updated when upload response arrives`);
          }
        }
        
        return updated;
      });
    };

    window.addEventListener('fileStateUpdate', handleFileStateUpdate as EventListener);
    
    return () => {
      window.removeEventListener('fileStateUpdate', handleFileStateUpdate as EventListener);
    };
  }, [isAppInitialized]);

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
    setHasMessageBeenSent(false);
    setCenterFading(false);
    setMessage('');
    
    setActiveChatId('none');
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
  
  // Check if any files are currently processing (not ready for sending)
  const hasProcessingFiles = attachedFiles.some(file => {
    const processingStates = ['selected', 'uploading', 'processing', 'processing_md', 'local_processing', 'api_processing'];
    return file.api_state && processingStates.includes(file.api_state);
  });
  
  const isSendDisabled = isActiveChatStreaming || (chatRef.current?.isBusy?.() ?? false) || hasProcessingFiles;

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

  const handleOpenModal = (modalType: string) => {
    logger.info('Opening modal:', modalType);
    setActiveModal(modalType);
  };

  const handleCloseModal = () => {
    logger.info('Closing modal');
    setActiveModal(null);
  };

  const handleFileUpload = async (files: FileList) => {
    try {
      logger.info('[App] Starting backend upload for files:', files.length);
      
      const formData = new FormData();
      
      for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
      }
      
      const response = await fetch(apiUrl('/api/files/upload'), {
        method: 'POST',
        body: formData
      });
      
      if (response.ok) {
        const data = await response.json();
        logger.info('[App] Files uploaded to backend successfully:', data.files?.length || 1, data.files?.map((f: { name: any; api_state: any; }) => ({ name: f.name, api_state: f.api_state })));
        
        const uploadedFiles = data.files || [data.file];
        
        // Replace optimistic temp files with real backend data (avoid duplicates)
        setAttachedFiles(prev => {
          const existingIds = new Set(prev.map(f => f.id));
          
          // Remove temp files 
          const withoutTemp = prev.filter(f => !f.id.startsWith('temp_'));
          
          // Only add files that don't already exist (SSE might have already added them)
          const realFiles = uploadedFiles
            .filter((file: any) => !existingIds.has(file.id))
            .map((file: any) => ({
              id: file.id,
              name: file.name,
              size: file.size,
              type: file.type,
              api_state: file.api_state || 'local',
              provider: file.provider || undefined
            }));
          
          if (realFiles.length > 0) {
            logger.info('[App] Added new files from upload response:', realFiles.map((f: { id: any; name: any; api_state: any; }) => ({ id: f.id, name: f.name, api_state: f.api_state })));
          } else {
            logger.info('[App] No new files to add - already exist via SSE');
          }
          
          return [...withoutTemp, ...realFiles];
        });
        
        if (data.errors && data.errors.length > 0) {
          logger.warn('Some files failed to upload:', data.errors);
        }
      } else {
        const errorData = await response.json();
        logger.error('Failed to upload files:', errorData.error || errorData.errors);
        
        // Remove temp files that failed to upload
        setAttachedFiles(prev => prev.filter(f => !f.id.startsWith('temp_')));
      }
    } catch (error) {
      logger.error('[App] Error uploading files:', error);
      
      // Remove temp files on error
      setAttachedFiles(prev => prev.filter(f => !f.id.startsWith('temp_')));
    }
  };

  const handleAddFileClick = () => {
    logger.info('Add file button clicked - opening file picker');
    fileInputRef.current?.click();
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      handleFileSelectionImmediate(files);
      event.target.value = '';
    }
  };

  const handleFileSelectionImmediate = async (files: FileList) => {
    try {
      logger.info('Files selected, adding to UI immediately:', files.length);
      
      // Immediately add files to UI state with optimistic 'selected' state
      const optimisticFiles = Array.from(files).map(file => ({
        id: `temp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        name: file.name,
        size: file.size,
        type: file.type,
        api_state: 'selected' as const,
        provider: undefined
      }));
      
      logger.info('[App] Adding optimistic files:', optimisticFiles.length, optimisticFiles.map(f => ({ name: f.name, api_state: f.api_state })));
      setAttachedFiles(prev => [...prev, ...optimisticFiles]);
      
      // Start upload process - this will update states from backend
      handleFileUpload(files);
      
    } catch (error) {
      logger.error('Error handling immediate file selection:', error);
    }
  };

  const handleRemoveFile = async (fileId: string) => {
    logger.info('Removing/canceling attached file with ID:', fileId);
    
    const fileToRemove = attachedFiles.find(file => file.id === fileId);
    if (!fileToRemove) {
      logger.warn('File not found in attached files:', fileId);
      return;
    }

    // Immediately remove from UI (optimistic removal)
    setAttachedFiles(prev => prev.filter(file => file.id !== fileId));
    
    // If it's a temp file (still being processed, not yet uploaded to backend),
    // no backend cleanup needed
    if (fileId.startsWith('temp_')) {
      logger.info('Canceled temp file (no backend cleanup needed):', fileId);
      return;
    }
    
    // For real files uploaded to backend, delete from backend
    try {
      const response = await fetch(apiUrl(`/api/files/${fileId}`), {
        method: 'DELETE'
      });
      
      if (response.ok) {
        const data = await response.json();
        logger.info('File deleted successfully from backend:', data.message);
      } else {
        const errorData = await response.json();
        logger.error('Failed to delete file from backend:', errorData.error);
        
        // On backend deletion failure, restore the file to UI
        setAttachedFiles(prev => {
          if (prev.some(f => f.id === fileId)) return prev;
          return [...prev, fileToRemove];
        });
      }
    } catch (error) {
      logger.error('Error deleting file from backend:', error);
      
      // On network error, restore the file to UI
      setAttachedFiles(prev => {
        if (prev.some(f => f.id === fileId)) return prev;
        return [...prev, fileToRemove];
      });
    }
  };

  const clearAttachedFiles = () => {
    setAttachedFiles([]);
    BrowserStorage.clearAttachedFiles();
  };

  const handleClearAllFiles = async () => {
    if (attachedFiles.length === 0) return;
    
    logger.info('Clearing all attached files:', attachedFiles.length);
    
    const filesToClear = [...attachedFiles];
    const fileIds = filesToClear.map(file => file.id);
    
    clearAttachedFiles();
    
    try {
      const response = await fetch(apiUrl('/api/files/batch'), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_ids: fileIds })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        logger.error('Failed to batch delete files from backend:', errorData.error);
        setAttachedFiles(filesToClear);
      } else {
        logger.info('Successfully cleared all attached files');
      }
    } catch (error) {
      logger.error('Error during batch delete:', error);
      setAttachedFiles(filesToClear);
    }
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
              >
                {isActiveChatStreaming ? (
                  <div className="loading-spinner"></div>
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
                >
                  {isActiveChatStreaming ? (
                    <div className="loading-spinner"></div>
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
