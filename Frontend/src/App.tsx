import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { getActiveChatKey, getOpenChatsKey } from './utils/tabUtils';
import './App.css';
import './styles/creations.css';
import './styles/enhanced-creations.css';
import './styles/left-sidebar.css';
import './styles/modal.css';
import './styles/creation-window.css';
import './styles/focus-mode.css';
import './styles/settings-window.css';
import Chat from './components/Chat';
import HtmlPreview from './components/HtmlPreview';
import EnhancedCreationViewer from './components/EnhancedCreationViewer';
import LeftSidebar from './components/LeftSidebar';
import DeleteChatModal from './components/DeleteChatModal';
import CreationWindow from './components/CreationWindow';
import TaskSystem from './components/TaskSystem';
import SettingsWindow from './components/SettingsWindow';
import { Creation, CreationType } from './utils/creationsHelper';
import chatManager, { ChatHistoryItem } from './utils/chatManager';
import creationManager from './utils/creationManager';
import ChatSearchModal from './components/ChatSearchModal';
import AceEditor from 'react-ace';

// Import ace editor modes and themes
import 'ace-builds/src-noconflict/mode-javascript';
import 'ace-builds/src-noconflict/mode-typescript';
import 'ace-builds/src-noconflict/mode-python';
import 'ace-builds/src-noconflict/mode-java';
import 'ace-builds/src-noconflict/mode-html';
import 'ace-builds/src-noconflict/mode-css';
import 'ace-builds/src-noconflict/mode-json';
import 'ace-builds/src-noconflict/mode-xml';
import 'ace-builds/src-noconflict/mode-yaml';
import 'ace-builds/src-noconflict/mode-markdown';
import 'ace-builds/src-noconflict/mode-sql';
import 'ace-builds/src-noconflict/mode-sh';
import 'ace-builds/src-noconflict/mode-c_cpp';
import 'ace-builds/src-noconflict/mode-csharp';
import 'ace-builds/src-noconflict/mode-php';
import 'ace-builds/src-noconflict/mode-ruby';
import 'ace-builds/src-noconflict/mode-golang';
import 'ace-builds/src-noconflict/mode-rust';
import 'ace-builds/src-noconflict/mode-swift';
import 'ace-builds/src-noconflict/mode-kotlin';
import 'ace-builds/src-noconflict/theme-monokai';
import 'ace-builds/src-noconflict/theme-github';
import 'ace-builds/src-noconflict/ext-language_tools';

interface ImportResult {
  success: boolean;
  message: string;
  chatsImported?: number;
}

function App() {
  const activeChatKey = getActiveChatKey();
  const openChatsKey = getOpenChatsKey();
  const [isEnhancedViewerOpen, setIsEnhancedViewerOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatHistoryItem[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [openChatIds, setOpenChatIds] = useState<(string | null)[]>([]);
  const [isLoadingChat, setIsLoadingChat] = useState(false);
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [lastSelectedChatIndex, setLastSelectedChatIndex] = useState<number | null>(null);
  const [bulkOperationsOpen, setBulkOperationsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  
  // Add state for delete confirmation modal
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [bulkDeleteModalOpen, setBulkDeleteModalOpen] = useState(false);
  const [chatToDelete, setChatToDelete] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Add state for chat title editing
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingChatTitle, setEditingChatTitle] = useState('');
  const [isUpdatingTitle, setIsUpdatingTitle] = useState(false);
  
  // Add a new state to track loading state per chat
  const [loadingChatIds, setLoadingChatIds] = useState<Record<string, boolean>>({});
  
  // Add state for right creation window
  const [creationWindowOpen, setCreationWindowOpen] = useState(false);
  const [currentCreation, setCurrentCreation] = useState<Creation | null>(null);
  
  // Add state for task system
  const [isTaskSystemOpen, setIsTaskSystemOpen] = useState(false);

  // Focus mode state
  const [isFocusMode, setIsFocusMode] = useState(false);
  
  // Add state for settings window
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const [searchModalOpen, setSearchModalOpen] = useState(false);

  // Add creation modal state
  const [addCreationModalOpen, setAddCreationModalOpen] = useState(false);
  const [newCreationType, setNewCreationType] = useState<CreationType>('code');
  const [newCreationTitle, setNewCreationTitle] = useState('');
  const [newCreationContent, setNewCreationContent] = useState('');
  const [newCreationLanguage, setNewCreationLanguage] = useState('javascript');
  const [newCreationExternalDeps, setNewCreationExternalDeps] = useState('');

  // Rename creation modal state
  const [renameCreationModalOpen, setRenameCreationModalOpen] = useState(false);
  const [creationToRename, setCreationToRename] = useState<Creation | null>(null);
  const [renameCreationTitle, setRenameCreationTitle] = useState('');

  // Edit creation modal state
  const [editCreationModalOpen, setEditCreationModalOpen] = useState(false);
  const [creationToEdit, setCreationToEdit] = useState<Creation | null>(null);
  const [editCreationContent, setEditCreationContent] = useState('');
  const [editCreationLanguage, setEditCreationLanguage] = useState('');
  
  // Edit modal editor preferences
  const [editModalTheme, setEditModalTheme] = useState<'dark' | 'light'>('dark');
  const [editModalShowLineNumbers, setEditModalShowLineNumbers] = useState(true);
  const [editModalFontSize, setEditModalFontSize] = useState(14);

  // Modal refs for click-outside handling
  const addCreationModalRef = useRef<HTMLDivElement>(null);
  const renameCreationModalRef = useRef<HTMLDivElement>(null);
  const editCreationModalRef = useRef<HTMLDivElement>(null);

  // Helper function to map languages to Ace editor modes
  const getAceMode = (creationType: string, language?: string) => {
    if (creationType === 'code' && language) {
      const modeMap: Record<string, string> = {
        'javascript': 'javascript',
        'typescript': 'typescript',
        'python': 'python',
        'java': 'java',
        'cpp': 'c_cpp',
        'c': 'c_cpp',
        'csharp': 'csharp',
        'php': 'php',
        'ruby': 'ruby',
        'go': 'go',
        'rust': 'rust',
        'swift': 'swift',
        'kotlin': 'kotlin',
        'html': 'html',
        'css': 'css',
        'sql': 'sql',
        'bash': 'sh',
        'json': 'json',
        'xml': 'xml',
        'yaml': 'yaml'
      };
      return modeMap[language.toLowerCase()] || 'javascript';
    }
    
    // For other creation types
    const typeMap: Record<string, string> = {
      'html': 'html',
      'css': 'css',
      'markdown': 'markdown',
      'json': 'json',
      'xml': 'xml',
      'yaml': 'yaml'
    };
    return typeMap[creationType] || 'javascript';
  };
  
  // Load chat history when component mounts
  useEffect(() => {
    // Initial load
    setChatHistory(chatManager.getChats());
    
    // Subscribe to updates - prevent excessive rerenders 
    const unsubscribe = chatManager.subscribe((chats) => {
      // Only update if chats have actually changed
      setChatHistory(prevChats => {
        // Quick equality check based on length and ids
        if (prevChats.length !== chats.length) return chats;
        
        // Check if any titles or other properties have changed
        const hasChanges = chats.some((chat, index) => {
          return JSON.stringify(chat) !== JSON.stringify(prevChats[index]);
        });
        
        return hasChanges ? chats : prevChats;
      });
    });
    
    // Refresh chats from the backend on initial load only
    chatManager.refreshChats().catch(err => {
      console.log('Failed to refresh chat history, will use cached data:', err);
    });
    
    // Listen for chat events
    const handleChatCreated = (event: Event) => {

      // Cast to custom event to access the chat ID
      const customEvent = event as CustomEvent<{ chatId: string }>;
      if (customEvent.detail?.chatId) {
        // Set the active chat ID to the newly created chat
        setActiveChatId(customEvent.detail.chatId);
        setOpenChatIds(prev =>
          prev.map(id => (id === null ? customEvent.detail.chatId : id))
        );
      }
      
      // Refresh the chat history
      chatManager.refreshChats().catch(err => {
        console.log('Failed to refresh chat history after creation:', err);
      });
    };
    
    const handleChatUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ chatId: string }>;
      if (customEvent.detail?.chatId) {

        
        // If we have a chatId but no active chat selected, set this as the active chat
        if (!activeChatId) {

          setActiveChatId(customEvent.detail.chatId);
        }
        
        // Only refresh the specific chat that was updated, not the entire list
        chatManager.refreshChats().catch(err => {
          console.log('Failed to refresh chat history after update:', err);
        });
      }
    };
    
    const handleChatReset = (event: Event) => {
      const customEvent = event as CustomEvent<{ chatId: string }>;
      if (customEvent.detail?.chatId) {
        console.log(`Chat reset event received for ID: ${customEvent.detail.chatId}`);
        
        // Set this as the active chat if it's not already active
        if (activeChatId !== customEvent.detail.chatId) {
          setActiveChatId(customEvent.detail.chatId);
        }
        
        // Refresh the chat history to update the UI with the reset chat
        chatManager.refreshChats().catch(err => {
          console.log('Failed to refresh chat history after reset:', err);
        });
      }
    };
    
    window.addEventListener('chat-created', handleChatCreated);
    window.addEventListener('chat-updated', handleChatUpdated);
    window.addEventListener('chat-reset', handleChatReset);
    
    return () => {
      unsubscribe();
      window.removeEventListener('chat-created', handleChatCreated);
      window.removeEventListener('chat-updated', handleChatUpdated);
      window.removeEventListener('chat-reset', handleChatReset);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle focus mode
  const toggleFocusMode = useCallback(() => {
    setIsFocusMode(prev => !prev);
  }, []);


  // Function to handle keyboard shortcut for enhanced viewer
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Alt + C to open enhanced creation viewer
    if (e.altKey && e.key === 'c') {
      setIsEnhancedViewerOpen(true);
    }

    // Alt + F to toggle focus mode
    if (e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      toggleFocusMode();
    }
    
    // Escape to close enhanced viewer
    if (e.key === 'Escape') {
      if (isEnhancedViewerOpen) {
        setIsEnhancedViewerOpen(false);
      } else if (creationWindowOpen) {
        // Add logic to close creation window on Escape
        setCreationWindowOpen(false);
        setCurrentCreation(null);
      }
    }
  }, [isEnhancedViewerOpen, creationWindowOpen, toggleFocusMode]);

  // Add keyboard shortcut listener
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  useEffect(() => {
    // Event listener for opening the enhanced viewer
    window.addEventListener('open-enhanced-viewer', () => {
      setIsEnhancedViewerOpen(true);
    });
    
    // Add event listener for showing a creation in the right window
    window.addEventListener('show-creation-sidebar', (e: Event) => {
      const customEvent = e as CustomEvent<Creation>;
      if (customEvent.detail) {
        // Update creation first, then ensure window is open
        // This prevents the window from closing during creation transitions
        setCurrentCreation(customEvent.detail);
        if (!creationWindowOpen) {
          setCreationWindowOpen(true);
        }
      }
    });

    // Add event listener for updating creation during streaming (without closing window)
    window.addEventListener('stream-creation-update', (e: Event) => {
      const customEvent = e as CustomEvent<Creation>;
      if (customEvent.detail) {
        console.log('🏠 APP RECEIVED stream-creation-update EVENT:', {
          creationData: {
            type: customEvent.detail.type,
            title: customEvent.detail.title,
            language: customEvent.detail.language,
            id: customEvent.detail.id,
            contentLength: customEvent.detail.content?.length || 0,
            metadata: customEvent.detail.metadata
          },
          currentCreationWindowOpen: creationWindowOpen,
          currentCreation: currentCreation ? {
            type: currentCreation.type,
            title: currentCreation.title,
            id: currentCreation.id
          } : null,
          willOpenWindow: !creationWindowOpen
        });
        
        // Update creation content during streaming without any window closing
        // This prevents the flash of content in main chat
        setCurrentCreation(customEvent.detail);
        // Ensure window is open (should already be, but be safe)
        if (!creationWindowOpen) {
          console.log('🪟 OPENING CREATION WINDOW for creation:', customEvent.detail.type, customEvent.detail.title);
          setCreationWindowOpen(true);
        } else {
          console.log('🪟 UPDATING EXISTING CREATION WINDOW with:', customEvent.detail.type, customEvent.detail.title);
        }
      }
    });
    
    // Cleanup
    return () => {
      window.removeEventListener('open-enhanced-viewer', () => {
        setIsEnhancedViewerOpen(false);
      });
      window.removeEventListener('show-creation-sidebar', () => {});
      window.removeEventListener('stream-creation-update', () => {});
    };
  }, [creationWindowOpen, currentCreation]);


  // Function to start a new chat
  const handleNewChat = () => {
    // Set loading state
    setIsLoadingChat(true);

    // Clear active chat ID
    setActiveChatId(null);

    // Add a placeholder for the new chat
    setOpenChatIds(prev => [...prev, null]);
    
    // Dispatch event to reset the chat *interface* (not delete the data)
    // This will create a new chat session without erasing existing ones
    window.dispatchEvent(new CustomEvent('new-chat'));
    
    // Set a timeout to clear loading state
    // This gives visual feedback even if the reset is quick
    setTimeout(() => {
      setIsLoadingChat(false);
    }, 500);
  };


  // Format date string for display
  const formatChatDate = useCallback((dateString: string): string => {
    const date = new Date(dateString);
    // Always display the actual date in a simplified format
    return date.toLocaleDateString(undefined, { 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }, []);

  // Inside the App component, add new functions for bulk operations
  const toggleChatSelection = useCallback(
    (chatId: string, index: number, isShiftClick: boolean = false) => {
      setSelectedChatIds(prev => {
        const selectedSet = new Set(prev);

        if (isShiftClick && lastSelectedChatIndex !== null && bulkOperationsOpen) {
          const start = Math.min(lastSelectedChatIndex, index);
          const end = Math.max(lastSelectedChatIndex, index);
          const shouldSelect = !selectedSet.has(chatId);

          for (let i = start; i <= end; i++) {
            const id = chatHistory[i]?.id;
            if (!id) continue;
            if (shouldSelect) {
              selectedSet.add(id);
            } else {
              selectedSet.delete(id);
            }
          }
        } else {
          if (selectedSet.has(chatId)) {
            selectedSet.delete(chatId);
          } else {
            selectedSet.add(chatId);
          }
          setLastSelectedChatIndex(index);
        }

        return Array.from(selectedSet);
      });
    },
    [lastSelectedChatIndex, bulkOperationsOpen, chatHistory]
  );

  // Function to handle edit input changes
  const handleEditInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditingChatTitle(e.target.value);
  }, []);

  // Function to start editing a chat title
  const handleEditChatTitle = useCallback((chatId: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering chat selection
    setEditingChatId(chatId);
    setEditingChatTitle(currentTitle);
  }, []);

  // Function to save the edited chat title
  const handleSaveChatTitle = useCallback(async (chatId: string) => {
    if (!editingChatTitle.trim()) {
      // Don't allow empty titles
      setEditingChatTitle('New Chat');
    }
    
    setIsUpdatingTitle(true);
    
    try {
      // Update the chat title using chatManager
      const success = await chatManager.updateChatMetadata(chatId, { title: editingChatTitle.trim() });
      
      if (success) {
        console.log(`Successfully updated chat title to: ${editingChatTitle}`);
      } else {
        console.error('Failed to update chat title');
      }
    } catch (error) {
      console.error('Error updating chat title:', error);
    } finally {
      // Reset editing state
      setIsUpdatingTitle(false);
      setEditingChatId(null);
    }
  }, [editingChatTitle]);

  // Function to handle edit input key press
  const handleEditInputKeyPress = useCallback((chatId: string, e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveChatTitle(chatId);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditingChatId(null);
      setEditingChatTitle('');
    }
  }, [handleSaveChatTitle]);

  // Function to delete a chat
  const handleDeleteChat = useCallback(async (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering chat selection
    
    // Open the delete confirmation modal instead of using window.confirm
    setChatToDelete(chatId);
    setDeleteModalOpen(true);
  }, []);
  
  // Function that actually performs the deletion after confirmation
  const confirmDeleteChat = async () => {
    if (!chatToDelete) return;
    
    setIsDeleting(true);
    
    // Set loading state if deleting the active chat
    if (activeChatId === chatToDelete) {
      setIsLoadingChat(true);
      // Notify the Chat component that the active chat is being deleted
      window.dispatchEvent(new CustomEvent('delete-active-chat'));
    }
    
    const success = await chatManager.deleteChat(chatToDelete);

    if (success) {
      // If the deleted chat was active, create a new chat
      if (activeChatId === chatToDelete) {
        handleNewChat();
      }
      // Remove from open chat list
      setOpenChatIds(prev => prev.filter(id => id !== chatToDelete));
    } else {
      alert('Failed to delete chat. Please try again.');
      setIsLoadingChat(false);
    }
    
    // Close the modal and reset state
    setDeleteModalOpen(false);
    setChatToDelete(null);
    setIsDeleting(false);
  };

  // Function to load a chat
  const handleLoadChat = useCallback((chatId: string) => {
    // Don't do anything if we're already loading this chat
    if (loadingChatIds[chatId]) return;
    
    // Set the specific chat as loading (instead of a global loading state)
    setLoadingChatIds(prev => ({ ...prev, [chatId]: true }));
    
    // Set the active chat ID
    setActiveChatId(chatId);

    // Ensure this chat is in the list of open chats
    setOpenChatIds(prev => (prev.includes(chatId) ? prev : [...prev, chatId]));
    
    // Dispatch an event to load this chat
    window.dispatchEvent(new CustomEvent('load-chat', {
      detail: { chatId }
    }));
    
    // Listen for when loading completes
    const handleLoadComplete = () => {
      setLoadingChatIds(prev => ({ ...prev, [chatId]: false }));
      // Remove this one-time listener after use
      window.removeEventListener('chat-load-complete', handleLoadComplete);
    };
    
    // Add a listener for the load-complete event
    window.addEventListener('chat-load-complete', handleLoadComplete, { once: true });
    
    // Set a timeout to clear loading state in case we never get the completion event
    setTimeout(() => {
      setLoadingChatIds(prev => ({ ...prev, [chatId]: false }));
    }, 3000);
  }, [loadingChatIds]);

  // Load the last active chat for this tab on mount
  useEffect(() => {
    const openChats = localStorage.getItem(openChatsKey);
    if (openChats) {
      try {
        const parsed = JSON.parse(openChats) as (string | null)[];
        setOpenChatIds(parsed);
      } catch {
        // ignore
      }
    }

    const savedId = localStorage.getItem(activeChatKey);
    if (savedId && chatManager.getChatById(savedId)) {
      handleLoadChat(savedId);
    }
  }, [handleLoadChat, activeChatKey, openChatsKey]);

  // Persist the active chat ID for this tab
  useEffect(() => {
    if (activeChatId) {
      localStorage.setItem(activeChatKey, activeChatId);
    } else {
      localStorage.removeItem(activeChatKey);
    }
  }, [activeChatId, activeChatKey]);

  // Persist the list of open chats for this tab
  useEffect(() => {
    localStorage.setItem(openChatsKey, JSON.stringify(openChatIds));
  }, [openChatIds, openChatsKey]);

  // Clean up stored chat ID when the tab unloads
  useEffect(() => {
    const handleUnload = () => {
      localStorage.removeItem(activeChatKey);
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [activeChatKey]);

  // Memoize the ChatHistoryItem component to prevent unnecessary re-renders
  const ChatHistoryItem = useCallback(({ chat, index }: { chat: ChatHistoryItem; index: number }) => {
    const isEditing = editingChatId === chat.id;
    const isLoading = loadingChatIds[chat.id] || false;
    const isActive = activeChatId === chat.id;
    const isSelected = selectedChatIds.includes(chat.id);
    
    return (
      <li key={chat.id}>
        <div
          className={`chat-history-item ${isActive ? 'active' : ''} ${isLoading ? 'loading' : ''} ${isSelected ? 'selected' : ''}`}
          onClick={(e) => {
            if (bulkOperationsOpen) {
              toggleChatSelection(chat.id, index, e.shiftKey);
            } else if (!isLoading) {
              handleLoadChat(chat.id);
            }
          }}
        >
          {bulkOperationsOpen && (
            <div className="chat-selection-checkbox">
              <input 
                type="checkbox" 
                checked={isSelected}
                onChange={(e) => {
                  e.stopPropagation();
                  toggleChatSelection(chat.id, index, (e.nativeEvent as MouseEvent).shiftKey);
                }}
              />
            </div>
          )}
            
          {isLoading ? (
            <div className="chat-loading-indicator">
              <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M12 6v2"></path>
              </svg>
            </div>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
          )}
          <div className="chat-item-details">
            {isEditing ? (
              <input
                type="text"
                value={editingChatTitle}
                onChange={handleEditInputChange}
                onKeyDown={(e) => handleEditInputKeyPress(chat.id, e)}
                onBlur={() => handleSaveChatTitle(chat.id)}
                autoFocus
                className="chat-item-title-input"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="chat-item-title">{chat.title}</span>
            )}
            <span className="chat-item-date">{formatChatDate(chat.updated_at)}</span>
          </div>
          {!bulkOperationsOpen && (
            <div className="chat-item-actions">
              {!isUpdatingTitle && (
                <button 
                  className="chat-item-edit"
                  onClick={(e) => handleEditChatTitle(chat.id, chat.title, e)}
                  title="Rename chat"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                  </svg>
                </button>
              )}
              <button 
                className="chat-item-delete"
                onClick={(e) => handleDeleteChat(chat.id, e)}
                title="Delete chat"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18"></path>
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                </svg>
              </button>
            </div>
          )}
        </div>
      </li>
    );
  }, [
    activeChatId, 
    bulkOperationsOpen, 
    editingChatId, 
    editingChatTitle, 
    isUpdatingTitle, 
    loadingChatIds, 
    selectedChatIds,
    handleEditInputChange,
    handleEditInputKeyPress,
    handleLoadChat,
    handleSaveChatTitle,
    handleDeleteChat,
    handleEditChatTitle,
    toggleChatSelection,
    formatChatDate
  ]);

  // Memoize the chat list so it only re-renders when chatHistory changes
  const chatHistoryList = useMemo(() => {
    return chatHistory.length === 0 ? (
      <li className="empty-history-message">
        <p className="sidebar-text">No chat history yet</p>
      </li>
    ) : (
      chatHistory.map((chat, idx) => (
        <ChatHistoryItem key={chat.id} chat={chat} index={idx} />
      ))
    );
  }, [chatHistory, ChatHistoryItem]);

  // Keyboard shortcuts for bulk operations
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!bulkOperationsOpen) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        e.stopPropagation();
        const allIds = chatHistory.map(c => c.id);
        setSelectedChatIds(allIds);
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (selectedChatIds.length > 0) {
          setSelectedChatIds([]);
        } else {
          setBulkOperationsOpen(false);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [bulkOperationsOpen, chatHistory, selectedChatIds.length]);

  // Reset last selected index when bulk operations panel closes or chat history changes
  useEffect(() => {
    if (!bulkOperationsOpen) {
      setLastSelectedChatIndex(null);
    }
  }, [bulkOperationsOpen, chatHistory]);

  const handleBulkDelete = async () => {
    if (selectedChatIds.length === 0) return;
    
    // Open the bulk delete modal instead of using window.confirm
    setBulkDeleteModalOpen(true);
  };
  
  // Function that actually performs the bulk deletion after confirmation
  const confirmBulkDelete = async () => {
    if (selectedChatIds.length === 0) return;
    
    setIsDeleting(true);
    
    try {
      // Check if active chat is included in the chats to delete
      const isActiveChatIncluded = activeChatId && selectedChatIds.includes(activeChatId);
      
      // If deleting the active chat, show loading and notify the Chat component
      if (isActiveChatIncluded) {
        setIsLoadingChat(true);
        window.dispatchEvent(new CustomEvent('delete-active-chat'));
      }
      
      const result = await chatManager.bulkDeleteChats(selectedChatIds);
      
      // Replace alert with a more subtle notification if needed
      console.log(`Successfully deleted ${result.stats.deleted_from_history} chats`);
      
      // Clear selection
      setSelectedChatIds([]);
      setBulkOperationsOpen(false);
      
      // If we deleted the active chat, create a new one
      if (isActiveChatIncluded) {
        handleNewChat();
      }
    } catch (error) {
      console.error('Failed to bulk delete chats:', error);
      alert('Failed to delete chats. Please try again.');
      
      // Clear loading state in case of error
      if (activeChatId && selectedChatIds.includes(activeChatId)) {
        setIsLoadingChat(false);
      }
    } finally {
      setBulkDeleteModalOpen(false);
      setIsDeleting(false);
    }
  };

  const handleExportChats = async () => {
    try {
      await chatManager.exportChatHistory();
    } catch (error) {
      console.error('Failed to export chat history:', error);
      alert('Failed to export chat history. Please try again.');
    }
  };

  const handleImportChats = async () => {
    if (!importFile) return;

    setIsImporting(true);
    setImportResult(null);
    
    try {
      const reader = new FileReader();
      
      reader.onload = async (e) => {
        try {
          const content = e.target?.result as string;
          const data = JSON.parse(content);
          
          if (data && typeof data === 'object') {
            await chatManager.importChatHistory(data, importMode);
            setImportResult({
              success: true,
              message: `Successfully imported ${Object.keys(data.history || {}).length} chats.`,
              chatsImported: Object.keys(data.history || {}).length
            });
            
            // Close dialog after successful import with a short delay
            setTimeout(() => {
              setImportDialogOpen(false);
              setImportFile(null);
              setImportResult(null);
            }, 2000);
          } else {
            throw new Error('Invalid file format');
          }
        } catch (err) {
          setImportResult({
            success: false,
            message: `Error importing chats: ${err instanceof Error ? err.message : 'Unknown error'}`
          });
        }
      };
      
      reader.onerror = () => {
        setImportResult({
          success: false,
          message: 'Error reading file'
        });
      };
      
      reader.readAsText(importFile);
    } catch (err) {
      setImportResult({
        success: false,
        message: `Error importing chats: ${err instanceof Error ? err.message : 'Unknown error'}`
      });
    } finally {
      setIsImporting(false);
    }
  };

  // Add a function to handle opening the task system
  const handleOpenTaskSystem = () => {
    setIsTaskSystemOpen(true);
  };
  
  // Add a function to handle closing the task system
  const handleCloseTaskSystem = () => {
    setIsTaskSystemOpen(false);
  };

  // Add creation modal handlers
  const handleAddCreation = () => {
    if (!newCreationTitle.trim() || !newCreationContent.trim()) {
      return;
    }

    // Parse external dependencies for React components
    let externalDependencies: Record<string, string> | undefined;
    if (newCreationType === 'react' && newCreationExternalDeps.trim()) {
      try {
        externalDependencies = JSON.parse(newCreationExternalDeps.trim());
      } catch {
        alert('Invalid JSON format for external dependencies. Please check your syntax.');
        return;
      }
    }

    const newCreation: Creation = {
      type: newCreationType,
      content: newCreationContent.trim(),
      title: newCreationTitle.trim(),
      language: newCreationType === 'code' ? newCreationLanguage : undefined,
      externalDependencies: externalDependencies,
    };

    // Add the creation using the creation manager
    creationManager.addCreation(newCreation);
    
    // Close modal and reset form
    setAddCreationModalOpen(false);
    resetAddCreationForm();
  };

  const resetAddCreationForm = () => {
    setNewCreationType('code');
    setNewCreationTitle('');
    setNewCreationContent('');
    setNewCreationLanguage('javascript');
    setNewCreationExternalDeps('');
  };

  const cancelAddCreation = useCallback(() => {
    setAddCreationModalOpen(false);
    resetAddCreationForm();
  }, []);

  const cancelRenameCreation = useCallback(() => {
    setRenameCreationModalOpen(false);
    setCreationToRename(null);
  }, []);

  const cancelEditCreation = useCallback(() => {
    setEditCreationModalOpen(false);
    setCreationToEdit(null);
  }, []);

  // Auto-focus the title input when add creation modal opens
  useEffect(() => {
    if (addCreationModalOpen) {
      setTimeout(() => {
        const titleInput = document.getElementById('creation-title-input');
        if (titleInput) {
          titleInput.focus();
        }
      }, 100);
    }
  }, [addCreationModalOpen]);

  // Close modals on escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (addCreationModalOpen) {
          cancelAddCreation();
        } else if (renameCreationModalOpen) {
          cancelRenameCreation();
        } else if (editCreationModalOpen) {
          cancelEditCreation();
        }
      }
    };
    
    if (addCreationModalOpen || renameCreationModalOpen || editCreationModalOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [addCreationModalOpen, cancelAddCreation, cancelRenameCreation, renameCreationModalOpen, editCreationModalOpen, cancelEditCreation]);

  // Close modals on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (addCreationModalOpen && addCreationModalRef.current && !addCreationModalRef.current.contains(event.target as Node)) {
        cancelAddCreation();
      }
      if (renameCreationModalOpen && renameCreationModalRef.current && !renameCreationModalRef.current.contains(event.target as Node)) {
        cancelRenameCreation();
      }
      if (editCreationModalOpen && editCreationModalRef.current && !editCreationModalRef.current.contains(event.target as Node)) {
        cancelEditCreation();
      }
    };
    
    if (addCreationModalOpen || renameCreationModalOpen || editCreationModalOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [addCreationModalOpen, cancelAddCreation, cancelRenameCreation, renameCreationModalOpen, editCreationModalOpen, cancelEditCreation]); // Functions are stable so don't need to be dependencies

  // Auto-focus the title input when rename modal opens
  useEffect(() => {
    if (renameCreationModalOpen) {
      setTimeout(() => {
        const titleInput = document.getElementById('rename-creation-title-input') as HTMLInputElement;
        if (titleInput) {
          titleInput.focus();
          titleInput.select();
        }
      }, 100);
    }
  }, [renameCreationModalOpen]);

  useEffect(() => {
    if (editCreationModalOpen) {
      setTimeout(() => {
        const textarea = document.getElementById('edit-creation-content-textarea') as HTMLTextAreaElement;
        if (textarea) {
          textarea.focus();
        }
      }, 100);
    }
  }, [editCreationModalOpen]);

  // Handle keyboard events for add creation modal
  const handleAddCreationKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      cancelAddCreation();
    } else if (e.key === 'Enter' && e.ctrlKey) {
      // Ctrl+Enter to submit
      handleAddCreation();
    }
  };

  // Rename creation modal handlers
  const handleOpenRenameModal = (creation: Creation) => {
    setCreationToRename(creation);
    // Set the rename input to the displayed title (what user sees in gallery)
    const displayedTitle = creation.title || `${creation.type.charAt(0).toUpperCase() + creation.type.slice(1)} Creation`;
    setRenameCreationTitle(displayedTitle);
    setRenameCreationModalOpen(true);
  };

  const handleRenameCreation = () => {
    if (!creationToRename?.id || renameCreationTitle.trim() === '') return;
    
    // Use the creationManager to rename the creation
    const success = creationManager.renameCreation(creationToRename.id, renameCreationTitle.trim());
    
    if (success) {
      // Close the modal
      setRenameCreationModalOpen(false);
      setCreationToRename(null);
    }
  };

  // Edit creation modal handlers
  const handleOpenEditModal = (creation: Creation) => {
    setCreationToEdit(creation);
    setEditCreationContent(creation.content);
    setEditCreationLanguage(creation.language || '');
    setEditCreationModalOpen(true);
  };

  const handleSaveEditedCreation = () => {
    if (!creationToEdit?.id) return;

    const updates: Partial<Creation> = { content: editCreationContent };
    if (creationToEdit.type === 'code') {
      updates.language = editCreationLanguage;
    }

    const success = creationManager.updateCreation(creationToEdit.id, updates);

    if (success) {
      setEditCreationModalOpen(false);
      setCreationToEdit(null);
    }
  };

  const handleEditCreationKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      cancelEditCreation();
    } else if (e.key === 'Enter' && e.ctrlKey) {
      handleSaveEditedCreation();
    }
  };

  // Handle keyboard events for rename modal
  const handleRenameCreationKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      cancelRenameCreation();
    } else if (e.key === 'Enter') {
      handleRenameCreation();
    }
  };

  return (
    <div className={`min-h-screen bg-primary text-white app-container ${isFocusMode ? 'focus-mode' : ''}`}>
      {/* Left Sidebar */}
      <LeftSidebar>
        <div className="sidebar-section">
          <h3 className="sidebar-heading">Quick Navigation</h3>
          <ul className="sidebar-nav">
            {/* Gallery Button - now triggers the enhanced viewer */}
            <li>
              <button
                className="sidebar-link sidebar-button"
                onClick={() => setIsEnhancedViewerOpen(true)}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <circle cx="8.5" cy="8.5" r="1.5"></circle>
                  <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
                <span>Gallery</span>
              </button>
            </li>
            <li>
              <button
                className="sidebar-link sidebar-button"
                onClick={() => setSearchModalOpen(true)}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"></circle>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                </svg>
                <span>Search</span>
              </button>
            </li>
            <li>
              <button 
                className="sidebar-link sidebar-button"
                onClick={() => setIsSettingsOpen(true)}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"></circle>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                </svg>
                <span>Settings</span>
              </button>
            </li>
          </ul>
        </div>
        
        {/* Chat History Section */}
        <div className="sidebar-section">
          <div className="sidebar-heading-container">
            <h3 className="sidebar-heading">Chat History</h3>
            {chatHistory.length > 0 && (
              <div className="sidebar-actions">
                <button 
                  className="sidebar-action-button"
                  onClick={() => setBulkOperationsOpen(!bulkOperationsOpen)}
                  title="Chat Management"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="1"></circle>
                    <circle cx="19" cy="12" r="1"></circle>
                    <circle cx="5" cy="12" r="1"></circle>
                  </svg>
                </button>
              </div>
            )}
          </div>
          
          {bulkOperationsOpen && (
            <div className="bulk-operations-panel">
              <div className="bulk-operations-buttons">
                <button
                  className="bulk-op-button"
                  onClick={handleExportChats}
                  title="Export chat history as a JSON file"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                  <span>Export</span>
                </button>
                <button 
                  className="bulk-op-button"
                  onClick={() => setImportDialogOpen(true)}
                  title="Import chat history from a JSON file"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  <span>Import</span>
                </button>
              {selectedChatIds.length > 0 && (
                  <button 
                    className="bulk-op-button delete-button"
                    onClick={handleBulkDelete}
                    title={`Delete ${selectedChatIds.length} selected chats`}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18"></path>
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                    </svg>
                    <span>Delete {selectedChatIds.length} selected</span>
                  </button>
                )}
              </div>
              <div className="selection-help">
                <span>Click to select • Shift+Click range • Ctrl+A to select all • Esc to cancel</span>
              </div>
              {selectedChatIds.length > 0 && (
                <button
                  className="clear-selection-button"
                  onClick={() => setSelectedChatIds([])}
                >
                  Clear Selection
                </button>
              )}
            </div>
          )}
          
          <ul className="sidebar-nav chat-history-list">
            {chatHistoryList}
          </ul>
          <div className="chat-history-actions">
            <button 
              className={`sidebar-link sidebar-button new-chat-button ${isLoadingChat && !activeChatId ? 'loading' : ''}`}
              onClick={handleNewChat}
              disabled={isLoadingChat}
            >
              {isLoadingChat && !activeChatId ? (
                <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M12 6v2"></path>
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              )}
              <span>New Chat</span>
            </button>
          </div>
        </div>
        
        <div className="sidebar-section">
          <h3 className="sidebar-heading">Running Tasks</h3>
          <ul className="sidebar-nav chat-history-list">
            <li className="empty-history-message">
              <p className="sidebar-text">No tasks running</p>
            </li>
          </ul>
          <div className="chat-history-actions">
            <button 
              className="sidebar-link sidebar-button new-chat-button"
              onClick={handleOpenTaskSystem}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              <span>New Task</span>
            </button>
          </div>
        </div>
      </LeftSidebar>

      {openChatIds.map(id => (
        <div key={id ?? 'new'} style={{ display: id === activeChatId ? 'block' : 'none' }}>
          <Chat initialChatId={id} isActive={id === activeChatId} />
        </div>
      ))}
      {isFocusMode && (
        <button
          className="focus-mode-floating"
          onClick={toggleFocusMode}
          title="Exit Focus Mode (Alt+F)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 14 10 14 10 20"></polyline>
            <polyline points="20 10 14 10 14 4"></polyline>
            <line x1="14" y1="10" x2="21" y2="3"></line>
            <line x1="3" y1="21" x2="10" y2="14"></line>
          </svg>
        </button>
      )}
      <HtmlPreview />
      
      {/* Enhanced Creation Viewer */}
      <EnhancedCreationViewer 
        isOpen={isEnhancedViewerOpen} 
        onClose={() => {
          // Close any open creation modals when gallery closes
          if (addCreationModalOpen) {
            setAddCreationModalOpen(false);
            resetAddCreationForm();
          }
          if (renameCreationModalOpen) {
            setRenameCreationModalOpen(false);
            setCreationToRename(null);
          }
          if (editCreationModalOpen) {
            setEditCreationModalOpen(false);
            setCreationToEdit(null);
          }
          
          // Close the enhanced viewer
          setIsEnhancedViewerOpen(false);
        }}
        onOpenAddModal={() => setAddCreationModalOpen(true)}
        onOpenRenameModal={handleOpenRenameModal}
        onOpenEditModal={handleOpenEditModal}
      />
      
      {/* Creation Window */}
      {creationWindowOpen && (
        <CreationWindow 
          creation={currentCreation}
          onClose={() => {
            setCreationWindowOpen(false);
            setCurrentCreation(null);
          }}
        />
      )}

      {/* Import Dialog */}
      {importDialogOpen && (
        <div className="modal-overlay">
          <div className="modal-container">
            <div className="modal-header">
              <h3>Import Chat History</h3>
              <button
                className="sidebar-action-button"
                onClick={() => {
                  setImportDialogOpen(false);
                  setImportFile(null);
                  setImportResult(null);
                }}
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="modal-content">
              <div className="import-file-select">
                <label htmlFor="import-file">Select a chat history JSON file:</label>
                <input
                  id="import-file"
                  type="file"
                  accept=".json"
                  onChange={(e) => {
                    setImportFile(e.target.files?.[0] || null);
                    setImportResult(null);
                  }}
                />
              </div>
              
              <div className="import-options">
                <h4>Import Options</h4>
                <div className="radio-option">
                  <input
                    type="radio"
                    id="merge"
                    name="import-mode"
                    checked={importMode === 'merge'}
                    onChange={() => setImportMode('merge')}
                  />
                  <label htmlFor="merge">
                    <strong>Merge</strong> - Add imported chats to your existing history
                  </label>
                </div>
                <div className="radio-option">
                  <input
                    type="radio"
                    id="replace"
                    name="import-mode"
                    checked={importMode === 'replace'}
                    onChange={() => setImportMode('replace')}
                  />
                  <label htmlFor="replace">
                    <strong>Replace</strong> - Replace your existing history with imported chats
                  </label>
                </div>
              </div>
              
              {importResult && (
                <div className={`import-result ${importResult.success ? 'success' : 'error'}`}
                     style={{
                       marginTop: '20px',
                       padding: '10px',
                       borderRadius: '4px',
                       backgroundColor: importResult.success ? 'rgba(34, 197, 94, 0.1)' : 'rgba(220, 38, 38, 0.1)',
                       color: importResult.success ? 'rgba(34, 197, 94, 0.9)' : 'rgba(220, 38, 38, 0.9)',
                     }}>
                  {importResult.message}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button
                className="modal-button cancel-button"
                onClick={() => {
                  setImportDialogOpen(false);
                  setImportFile(null);
                  setImportResult(null);
                }}
              >
                Cancel
              </button>
              <button
                className="modal-button import-button"
                disabled={!importFile || isImporting}
                onClick={handleImportChats}
              >
                {isImporting ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal for single chat */}
      <DeleteChatModal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={confirmDeleteChat}
        title="Delete Chat"
        message="Are you sure you want to delete this chat? This action cannot be undone."
        isProcessing={isDeleting}
      />
      
      {/* Delete confirmation modal for bulk chat deletion */}
      <DeleteChatModal
        isOpen={bulkDeleteModalOpen}
        onClose={() => setBulkDeleteModalOpen(false)}
        onConfirm={confirmBulkDelete}
        title="Delete Multiple Chats"
        message={`Are you sure you want to delete ${selectedChatIds.length} chats? This action cannot be undone.`}
        isProcessing={isDeleting}
      />

      {/* Rename Creation Modal - Only show when gallery is open */}
      {renameCreationModalOpen && isEnhancedViewerOpen && (
        <div className="modal-overlay animate-fade-in">
          <div ref={renameCreationModalRef} className="modal-container rename-modal animate-fade-in">
            <div className="modal-header">
              <h3>Rename Creation</h3>
              <button 
                className="close-button" 
                onClick={cancelRenameCreation}
                aria-label="Close dialog"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div className="modal-content">
              <label className="form-label" htmlFor="rename-creation-title-input">
                Creation Title
              </label>
              <input
                id="rename-creation-title-input"
                type="text"
                value={renameCreationTitle}
                onChange={(e) => setRenameCreationTitle(e.target.value)}
                onKeyDown={handleRenameCreationKeyDown}
                className="form-input"
                placeholder="Enter new name"
              />
            </div>
            <div className="modal-footer">
              <button 
                className="modal-button cancel-button" 
                onClick={cancelRenameCreation}
              >
                Cancel
              </button>
              <button 
                className="modal-button confirm-button" 
                onClick={handleRenameCreation}
                disabled={renameCreationTitle.trim() === ''}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Creation Modal - Enhanced with code editor */}
      {editCreationModalOpen && isEnhancedViewerOpen && (
        <div className="modal-overlay animate-fade-in">
          <div ref={editCreationModalRef} className="modal-container edit-modal animate-fade-in" onKeyDown={handleEditCreationKeyDown}>
            <div className="modal-header">
              <h3>Edit Creation - {creationToEdit?.title || `${creationToEdit?.type?.charAt(0).toUpperCase()}${creationToEdit?.type?.slice(1)} Creation`}</h3>
              <button
                className="close-button"
                onClick={cancelEditCreation}
                aria-label="Close dialog"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div className="modal-content">
              {creationToEdit?.type === 'code' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="edit-creation-language-select">
                    Programming Language
                  </label>
                  <select
                    id="edit-creation-language-select"
                    value={editCreationLanguage}
                    onChange={(e) => setEditCreationLanguage(e.target.value)}
                    className="form-select"
                  >
                    <option value="javascript">JavaScript</option>
                    <option value="typescript">TypeScript</option>
                    <option value="python">Python</option>
                    <option value="java">Java</option>
                    <option value="cpp">C++</option>
                    <option value="c">C</option>
                    <option value="csharp">C#</option>
                    <option value="php">PHP</option>
                    <option value="ruby">Ruby</option>
                    <option value="go">Go</option>
                    <option value="rust">Rust</option>
                    <option value="swift">Swift</option>
                    <option value="kotlin">Kotlin</option>
                    <option value="html">HTML</option>
                    <option value="css">CSS</option>
                    <option value="sql">SQL</option>
                    <option value="bash">Bash</option>
                    <option value="json">JSON</option>
                    <option value="xml">XML</option>
                    <option value="yaml">YAML</option>
                  </select>
                </div>
              )}
              <div className="form-group">
                <label className="form-label">
                  Content
                </label>
                <div className="code-editor-container">
                  <div className="code-editor-header">
                    <div className="code-editor-info">
                      <span className="language-badge">
                        {creationToEdit?.type === 'code' ? editCreationLanguage || 'plaintext' : creationToEdit?.type || 'text'}
                      </span>
                      <span>{editCreationContent.split('\n').length} lines</span>
                    </div>
                    <div className="code-editor-controls">
                      <button
                        type="button"
                        onClick={() => setEditModalTheme(editModalTheme === 'dark' ? 'light' : 'dark')}
                        title={`Switch to ${editModalTheme === 'dark' ? 'light' : 'dark'} theme`}
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px' }}
                      >
                        {editModalTheme === 'dark' ? '☀️' : '🌙'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditModalShowLineNumbers(!editModalShowLineNumbers)}
                        title="Toggle line numbers"
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px', fontSize: '12px' }}
                      >
                        #
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditModalFontSize(Math.max(10, editModalFontSize - 1))}
                        title="Decrease font size"
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px' }}
                        disabled={editModalFontSize <= 10}
                      >
                        A-
                      </button>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{editModalFontSize}px</span>
                      <button
                        type="button"
                        onClick={() => setEditModalFontSize(Math.min(24, editModalFontSize + 1))}
                        title="Increase font size"
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px' }}
                        disabled={editModalFontSize >= 24}
                      >
                        A+
                      </button>
                    </div>
                  </div>
                  <AceEditor
                    mode={getAceMode(creationToEdit?.type || 'code', editCreationLanguage)}
                    theme={editModalTheme === 'dark' ? 'monokai' : 'github'}
                    value={editCreationContent}
                    onChange={setEditCreationContent}
                    name="edit-creation-ace-editor"
                    editorProps={{ $blockScrolling: true }}
                    width="100%"
                    height="100%"
                    fontSize={editModalFontSize}
                    showPrintMargin={false}
                    showGutter={editModalShowLineNumbers}
                    highlightActiveLine={true}
                    setOptions={{
                      enableBasicAutocompletion: true,
                      enableLiveAutocompletion: true,
                      enableSnippets: true,
                      showLineNumbers: editModalShowLineNumbers,
                      tabSize: 2,
                      useSoftTabs: true,
                      wrap: true,
                      fontFamily: 'SF Mono, Monaco, Cascadia Code, Roboto Mono, Consolas, Courier New, monospace'
                    }}
                    style={{
                      borderRadius: '4px',
                      border: `1px solid var(--border-color)`
                    }}
                  />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="modal-button cancel-button" onClick={cancelEditCreation}>
                Cancel
              </button>
              <button className="modal-button confirm-button" onClick={handleSaveEditedCreation}>
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Creation Modal - Only show when gallery is open */}
      {addCreationModalOpen && isEnhancedViewerOpen && (
        <div className="modal-overlay animate-fade-in">
          <div ref={addCreationModalRef} className="modal-container add-creation-modal animate-fade-in">
            <div className="modal-header">
              <h3>Add New Creation</h3>
              <button 
                className="close-button" 
                onClick={cancelAddCreation}
                aria-label="Close dialog"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div className="modal-content">
              <div className="form-group">
                <label className="form-label" htmlFor="creation-type-select">
                  Creation Type
                </label>
                <select
                  id="creation-type-select"
                  value={newCreationType}
                  onChange={(e) => setNewCreationType(e.target.value as CreationType)}
                  className="form-select"
                >
                  <option value="code">Code</option>
                  <option value="html">HTML</option>
                  <option value="markdown">Markdown</option>
                  <option value="svg">SVG</option>
                  <option value="mermaid">Mermaid Diagram</option>
                  <option value="react">React Component</option>
                  <option value="placeholder">Placeholder</option>
                </select>
              </div>
              
              {newCreationType === 'code' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="creation-language-select">
                    Programming Language
                  </label>
                  <select
                    id="creation-language-select"
                    value={newCreationLanguage}
                    onChange={(e) => setNewCreationLanguage(e.target.value)}
                    className="form-select"
                  >
                    <option value="javascript">JavaScript</option>
                    <option value="typescript">TypeScript</option>
                    <option value="python">Python</option>
                    <option value="java">Java</option>
                    <option value="cpp">C++</option>
                    <option value="c">C</option>
                    <option value="csharp">C#</option>
                    <option value="php">PHP</option>
                    <option value="ruby">Ruby</option>
                    <option value="go">Go</option>
                    <option value="rust">Rust</option>
                    <option value="swift">Swift</option>
                    <option value="kotlin">Kotlin</option>
                    <option value="html">HTML</option>
                    <option value="css">CSS</option>
                    <option value="sql">SQL</option>
                    <option value="bash">Bash</option>
                    <option value="json">JSON</option>
                    <option value="xml">XML</option>
                    <option value="yaml">YAML</option>
                  </select>
                </div>
              )}

              {newCreationType === 'react' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="creation-external-deps-textarea">
                    External Dependencies (Optional)
                  </label>
                  <textarea
                    id="creation-external-deps-textarea"
                    value={newCreationExternalDeps}
                    onChange={(e) => setNewCreationExternalDeps(e.target.value)}
                    className="form-textarea"
                    placeholder='{"package-name": "version", "lodash": "^4.17.21"}'
                    rows={4}
                  />
                  <small className="form-help-text">
                    Enter external dependencies as JSON (package name to version mapping). Example: {JSON.stringify({"lodash": "^4.17.21", "axios": "^1.0.0"})}
                  </small>
                </div>
              )}
              
              <div className="form-group">
                <label className="form-label" htmlFor="creation-title-input">
                  Title
                </label>
                <input
                  id="creation-title-input"
                  type="text"
                  value={newCreationTitle}
                  onChange={(e) => setNewCreationTitle(e.target.value)}
                  onKeyDown={handleAddCreationKeyDown}
                  className="form-input"
                  placeholder="Enter creation title"
                />
              </div>
              
              <div className="form-group">
                <label className="form-label" htmlFor="creation-content-textarea">
                  Content
                </label>
                <textarea
                  id="creation-content-textarea"
                  value={newCreationContent}
                  onChange={(e) => setNewCreationContent(e.target.value)}
                  onKeyDown={handleAddCreationKeyDown}
                  className="form-textarea"
                  placeholder="Enter your creation content here..."
                  rows={12}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button 
                className="modal-button cancel-button" 
                onClick={cancelAddCreation}
              >
                Cancel
              </button>
              <button 
                className="modal-button confirm-button" 
                onClick={handleAddCreation}
                disabled={!newCreationTitle.trim() || !newCreationContent.trim()}
              >
                Add Creation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Task System component */}
      <TaskSystem
        isOpen={isTaskSystemOpen}
        onClose={handleCloseTaskSystem}
      />
      <ChatSearchModal isOpen={searchModalOpen} onClose={() => setSearchModalOpen(false)} />
      
      {/* Add Settings Window component */}
      <SettingsWindow
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}

export default App;
