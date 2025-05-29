import { useState, useCallback, useEffect, useMemo } from 'react';
import './App.css';
import './styles/creations.css';
import './styles/enhanced-creations.css';
import './styles/left-sidebar.css';
import './styles/modal.css';
import './styles/creation-window.css';
import Chat from './components/Chat';
import HtmlPreview from './components/HtmlPreview';
import EnhancedCreationViewer from './components/EnhancedCreationViewer';
import LeftSidebar from './components/LeftSidebar';
import DeleteChatModal from './components/DeleteChatModal';
import CreationWindow from './components/CreationWindow';
import TaskSystem from './components/TaskSystem';
import { Creation } from './utils/creationsHelper';
import chatManager, { ChatHistoryItem } from './utils/chatManager';
import { streamMonitor } from './utils/streamMonitor';

interface ImportResult {
  success: boolean;
  message: string;
  chatsImported?: number;
}

function App() {
  const [isEnhancedViewerOpen, setIsEnhancedViewerOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatHistoryItem[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [isLoadingChat, setIsLoadingChat] = useState(false);
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
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
  
  // Load chat history when component mounts
  useEffect(() => {
    // Initial load
    setChatHistory(chatManager.getChats());
    
    // Initialize stream monitoring
    console.log('🔧 Initializing stream monitor...');
    streamMonitor.startMonitoring(); // Real-time push notifications via Server-Sent Events
    
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
      console.log('Chat created event received, refreshing chats');
      
      // Cast to custom event to access the chat ID
      const customEvent = event as CustomEvent<{ chatId: string }>;
      if (customEvent.detail?.chatId) {
        console.log(`Setting active chat ID to newly created chat: ${customEvent.detail.chatId}`);
        // Set the active chat ID to the newly created chat
        setActiveChatId(customEvent.detail.chatId);
      }
      
      // Refresh the chat history
      chatManager.refreshChats().catch(err => {
        console.log('Failed to refresh chat history after creation:', err);
      });
    };
    
    const handleChatUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ chatId: string }>;
      if (customEvent.detail?.chatId) {
        console.log(`Chat updated event received for ID: ${customEvent.detail.chatId}`);
        
        // If we have a chatId but no active chat selected, set this as the active chat
        if (!activeChatId) {
          console.log(`Setting active chat ID to updated chat: ${customEvent.detail.chatId}`);
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
      streamMonitor.stopMonitoring(); // Clean up stream monitor
      window.removeEventListener('chat-created', handleChatCreated);
      window.removeEventListener('chat-updated', handleChatUpdated);
      window.removeEventListener('chat-reset', handleChatReset);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Function to handle keyboard shortcut for enhanced viewer
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Alt + C to open enhanced creation viewer
    if (e.altKey && e.key === 'c') {
      setIsEnhancedViewerOpen(true);
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
  }, [isEnhancedViewerOpen, creationWindowOpen]);

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
        setCurrentCreation(customEvent.detail);
        setCreationWindowOpen(true);
      }
    });
    
    // Cleanup
    return () => {
      window.removeEventListener('open-enhanced-viewer', () => {
        setIsEnhancedViewerOpen(false);
      });
      window.removeEventListener('show-creation-sidebar', () => {});
    };
  }, []);

  // Function to start a new chat
  const handleNewChat = () => {
    // Set loading state
    setIsLoadingChat(true);
    
    // Clear active chat ID
    setActiveChatId(null);
    
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
  const toggleChatSelection = useCallback((chatId: string) => {
    setSelectedChatIds(prev => 
      prev.includes(chatId) 
        ? prev.filter(id => id !== chatId) 
        : [...prev, chatId]
    );
  }, []);

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

  // Memoize the ChatHistoryItem component to prevent unnecessary re-renders
  const ChatHistoryItem = useCallback(({ chat }: { chat: ChatHistoryItem }) => {
    const isEditing = editingChatId === chat.id;
    const isLoading = loadingChatIds[chat.id] || false;
    const isActive = activeChatId === chat.id;
    const isSelected = selectedChatIds.includes(chat.id);
    
    return (
      <li key={chat.id}>
        <div 
          className={`chat-history-item ${isActive ? 'active' : ''} ${isLoading ? 'loading' : ''} ${isSelected ? 'selected' : ''}`}
          onClick={() => {
            if (bulkOperationsOpen) {
              toggleChatSelection(chat.id);
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
                  toggleChatSelection(chat.id);
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
      chatHistory.map(chat => (
        <ChatHistoryItem key={chat.id} chat={chat} />
      ))
    );
  }, [chatHistory, ChatHistoryItem]);

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

  return (
    <div className="min-h-screen bg-primary text-white">
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
              <button className="sidebar-link sidebar-button">
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

      <Chat />
      <HtmlPreview />
      
      {/* Enhanced Creation Viewer */}
      <EnhancedCreationViewer 
        isOpen={isEnhancedViewerOpen} 
        onClose={() => setIsEnhancedViewerOpen(false)}
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

      {/* Add Task System component */}
      <TaskSystem 
        isOpen={isTaskSystemOpen}
        onClose={handleCloseTaskSystem}
      />
    </div>
  );
}

export default App;
