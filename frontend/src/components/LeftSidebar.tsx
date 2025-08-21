// status: complete

import React, { useState, useCallback} from 'react';
import '../styles/LeftSidebar.css';
import { BrowserStorage } from '../utils/BrowserStorage';
import logger from '../utils/logger';
import { DeleteModal } from './ModalWindow';

interface Chat {
  id: string;
  name: string;
  isActive: boolean;
  state?: 'thinking' | 'responding' | 'static';
}

interface LeftSidebarProps {
  chats?: Chat[];
  activeChat?: string;
  onChatSelect?: (chatId: string) => void;
  onNewChat?: () => void;
  onDeleteChat?: (chatId: string) => void;
  onEditChat?: (chatId: string, newName: string) => void;
  onBulkDelete?: (chatIds: string[]) => void;
  onBulkExport?: (chatIds: string[]) => void;
  onBulkImport?: (files: FileList) => void;
  onChatsReload?: () => void;
}

const LeftSidebar: React.FC<LeftSidebarProps> = ({
  chats = [],
  activeChat,
  onChatSelect,
  onNewChat,
  onDeleteChat,
  onEditChat,
  onBulkDelete,
  onBulkExport,
  onBulkImport,
  onChatsReload
}) => {
  const [isToggled, setIsToggled] = useState(() => {
    const settings = BrowserStorage.getUISettings();
    return settings.leftSidebarToggled;
  });
  const [isHovering, setIsHovering] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  const handleToggle = () => {
    const newToggleState = !isToggled;
    logger.info('Toggling left sidebar:', newToggleState);
    setIsToggled(newToggleState);
    BrowserStorage.updateUISetting('leftSidebarToggled', newToggleState);
  };

  const handleEditStart = (chatId: string, currentName: string) => {
    logger.info('Starting edit for chat:', chatId);
    setEditingChatId(chatId);
    setEditName(currentName);
  };

  const handleEditSave = (chatId: string) => {
    if (editName.trim() && onEditChat) {
      logger.info('Saving edit for chat:', chatId, editName);
      onEditChat(chatId, editName.trim());
    }
    setEditingChatId(null);
    setEditName('');
  };

  const handleEditCancel = () => {
    logger.info('Cancelling edit');
    setEditingChatId(null);
    setEditName('');
  };

  const handleDeleteStart = (chatId: string) => {
    logger.info('Starting delete for chat:', chatId);
    setDeletingChatId(chatId);
  };

  const handleDeleteConfirm = (chatId: string) => {
    logger.info('Delete confirmed for chat:', chatId);
    if (onDeleteChat) {
      logger.info('Calling onDeleteChat function');
      onDeleteChat(chatId);
    } else {
      logger.error('onDeleteChat function not provided');
    }
    setDeletingChatId(null);
  };

  const handleDeleteCancel = () => {
    logger.info('Cancelling delete');
    setDeletingChatId(null);
  };

  const toggleSelectionMode = () => {
    setSelectionMode(!selectionMode);
    if (selectionMode) {
      setSelectedChats(new Set());
      setLastSelectedIndex(null);
    }
  };

  const handleChatSelection = (chatId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    
    const chatIndex = chats.findIndex(chat => chat.id === chatId);
    
    if (event.ctrlKey || event.metaKey) {
      const newSelected = new Set(selectedChats);
      if (newSelected.has(chatId)) {
        newSelected.delete(chatId);
      } else {
        newSelected.add(chatId);
      }
      setSelectedChats(newSelected);
      setLastSelectedIndex(chatIndex);
    } else if (event.shiftKey && lastSelectedIndex !== null) {
      const newSelected = new Set(selectedChats);
      const start = Math.min(lastSelectedIndex, chatIndex);
      const end = Math.max(lastSelectedIndex, chatIndex);
      
      for (let i = start; i <= end; i++) {
        if (chats[i]) {
          newSelected.add(chats[i].id);
        }
      }
      setSelectedChats(newSelected);
    } else {
      setSelectedChats(new Set([chatId]));
      setLastSelectedIndex(chatIndex);
    }
  };

  const selectAllChats = useCallback(() => {
    setSelectedChats(new Set(chats.map(chat => chat.id)));
  }, [chats]);

  const clearSelection = () => {
    setSelectedChats(new Set());
    setLastSelectedIndex(null);
  };

  const handleBulkExport = () => {
    if (onBulkExport && selectedChats.size > 0) {
      onBulkExport(Array.from(selectedChats));
    }
  };

  const handleBulkImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && onBulkImport) {
      onBulkImport(files);
      event.target.value = '';
    }
  };

  const handleBulkDelete = () => {
    if (onBulkDelete && selectedChats.size > 0) {
      onBulkDelete(Array.from(selectedChats));
      setSelectedChats(new Set());
    }
  };

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!selectionMode) return;
      
      if (event.key === 'Escape') {
        if (selectedChats.size > 0) {
          clearSelection();
        } else {
          setSelectionMode(false);
        }
        event.preventDefault();
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
        selectAllChats();
        event.preventDefault();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectionMode, selectedChats.size, selectAllChats]);

  const shouldBeVisible = isToggled || (!isToggled && isHovering);

  return (
    <>
      <div 
        className={`left-sidebar ${shouldBeVisible ? 'open' : ''}`}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        <div className="sidebar-content">
          <div className="sidebar-header">
            <div className="sidebar-header-top">
              <h3>Quick Navigation</h3>
              <div className="sidebar-toggle-container">
                <button 
                  className={`sidebar-toggle ${isToggled ? 'active' : ''}`}
                  onClick={handleToggle}
                >
                  <div className="toggle-slider"></div>
                </button>
              </div>
            </div>
          </div>
          <div className="sidebar-items">
            <div className="sidebar-item">
              <div className="sidebar-icon gallery-icon"></div>
              Gallery
            </div>
            <div className="sidebar-item">
              <div className="sidebar-icon search-icon"></div>
              Search
            </div>
            <div className="sidebar-item">
              <div className="sidebar-icon settings-icon"></div>
              Settings
            </div>
            <div className="chat-history-section">
              <div className="chat-history-header">
                <div className="chat-history-header-top">
                  <div className="chat-history-title">
                    <div className="sidebar-icon chat-history-icon"></div>
                    <h3>Chat History</h3>
                  </div>
                  <button 
                    className={`selection-menu-btn ${selectionMode ? 'active' : ''}`}
                    onClick={toggleSelectionMode}
                    title="Selection Mode"
                  >
                    <div className="three-dots-icon"></div>
                  </button>
                </div>
                {selectionMode && (
                  <div className="selection-controls">
                    <button 
                      className="selection-btn clear-btn" 
                      onClick={clearSelection}
                      title="Clear Selection"
                      disabled={selectedChats.size === 0}
                    >
                      <div className="clear-icon"></div>
                    </button>
                    <button 
                      className="selection-btn select-all-btn" 
                      onClick={selectAllChats}
                      title="Select All"
                    >
                      <div className="select-all-icon"></div>
                    </button>
                    <label className="selection-btn import-btn" title="Import Chats">
                      <div className="import-icon">📥</div>
                      <input 
                        type="file" 
                        multiple 
                        accept=".json"
                        onChange={handleBulkImport}
                        style={{ display: 'none' }}
                      />
                    </label>
                    <button 
                      className="selection-btn export-btn" 
                      onClick={handleBulkExport}
                      title="Export Selected"
                      disabled={selectedChats.size === 0}
                    >
                      <div className="export-icon">📤</div>
                    </button>
                    <button 
                      className="selection-btn delete-btn" 
                      onClick={handleBulkDelete}
                      title={`Delete ${selectedChats.size} selected`}
                      disabled={selectedChats.size === 0}
                    >
                      <div className="delete-icon"></div>
                    </button>
                  </div>
                )}
              </div>
              <div className="chat-history-content">
                {chats.length === 0 ? (
                  <p className="no-history">No chat history yet</p>
                ) : (
                  chats.map((chat) => (
                    <div
                      key={chat.id}
                      className={`chat-item ${
                        selectionMode 
                          ? selectedChats.has(chat.id) ? 'selected' : ''
                          : chat.id === activeChat ? 'active' : ''
                      }`}
                      onClick={selectionMode 
                        ? (e) => handleChatSelection(chat.id, e)
                        : () => editingChatId !== chat.id && onChatSelect?.(chat.id)
                      }
                    >
                      {editingChatId === chat.id ? (
                        <div className="chat-edit-container">
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyPress={(e) => {
                              if (e.key === 'Enter') handleEditSave(chat.id);
                              if (e.key === 'Escape') handleEditCancel();
                            }}
                            onBlur={() => handleEditSave(chat.id)}
                            className="chat-edit-input"
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      ) : (
                        <>
                          {selectionMode && (
                            <div className="chat-selection">
                              <input
                                type="checkbox"
                                checked={selectedChats.has(chat.id)}
                                onChange={() => {}}
                                onClick={(e) => handleChatSelection(chat.id, e)}
                              />
                            </div>
                          )}
                          <span className="chat-name">{chat.name}</span>
                          {chat.state && chat.state !== 'static' && (
                            <span className={`chat-state-indicator ${chat.state}`}></span>
                          )}
                          {!selectionMode && (
                            <div className="chat-actions">
                              <button 
                                className="chat-action-btn edit-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleEditStart(chat.id, chat.name);
                                }}
                              >
                                <div className="edit-icon"></div>
                              </button>
                              <button 
                                className="chat-action-btn delete-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteStart(chat.id);
                                }}
                              >
                                <div className="delete-icon"></div>
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
              <button className="new-chat-button" onClick={onNewChat}>
                <span className="plus-icon">+</span>
                New Chat
              </button>
            </div>
          </div>
        </div>
        
        <DeleteModal
          isOpen={!!deletingChatId}
          onConfirm={() => deletingChatId && handleDeleteConfirm(deletingChatId)}
          onCancel={handleDeleteCancel}
        />
      </div>
      {!isToggled && (
        <div 
          className="sidebar-hover-zone left"
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
        />
      )}
    </>
  );
};

export default LeftSidebar;