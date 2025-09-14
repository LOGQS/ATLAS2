// status: complete

import React, { useState, useCallback} from 'react';
import '../../styles/layout/LeftSidebar.css';
import { BrowserStorage } from '../../utils/storage/BrowserStorage';
import logger from '../../utils/core/logger';
import { DeleteModal } from '../ui/ModalWindow';
import TriggerLog from '../visualization/TriggerLog'; // TEMPORARY_DEBUG_TRIGGERLOG

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
  onChatReorder?: (reorderedChats: Chat[]) => void;
  onOpenModal?: (modalType: string) => void;
  // TEMPORARY_DEBUG_TRIGGERLOG - props for debugging MessageVersionSwitcher
  triggerLogProps?: {
    activeChatId: string;
  };
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
  onChatReorder,
  onOpenModal,
  triggerLogProps
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
  const [draggedItem, setDraggedItem] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<{index: number; position: 'before' | 'after'} | null>(null);
  const [lastDropPosition, setLastDropPosition] = useState<{index: number; position: 'before' | 'after'} | null>(null);

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

  const handleDragStart = (e: React.DragEvent, chatId: string) => {
    if (selectionMode) {
      e.preventDefault();
      return;
    }
    setDraggedItem(chatId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', chatId);
  };

  const handleDragOver = (e: React.DragEvent, chatId: string) => {
    if (selectionMode || !draggedItem) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const chatIndex = chats.findIndex(chat => chat.id === chatId);
    if (chatIndex === -1) return;
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseY = e.clientY;
    
    const topZone = rect.top + (rect.height*3);
    const bottomZone = rect.bottom - (rect.height*3);
    
    let newPosition: {index: number; position: 'before' | 'after'} | null = null;
    
    if (mouseY <= topZone) {
      newPosition = { index: chatIndex, position: 'before' };
    } else if (mouseY >= bottomZone) {
      newPosition = { index: chatIndex, position: 'after' };
    } else {
      newPosition = lastDropPosition;
    }
    
    if (newPosition && 
        (!dropPosition || 
         dropPosition.index !== newPosition.index || 
         dropPosition.position !== newPosition.position)) {
      setDropPosition(newPosition);
      setLastDropPosition(newPosition);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (selectionMode) return;
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropPosition(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    if (selectionMode || !draggedItem || !dropPosition) return;
    e.preventDefault();
    
    const draggedIndex = chats.findIndex(chat => chat.id === draggedItem);
    if (draggedIndex === -1) {
      setDraggedItem(null);
      setDropPosition(null);
      return;
    }

    const reorderedChats = [...chats];
    const [draggedChat] = reorderedChats.splice(draggedIndex, 1);
    
    let insertIndex = dropPosition.index;
    if (dropPosition.position === 'after') {
      insertIndex += 1;
    }
    
    if (draggedIndex < insertIndex) {
      insertIndex -= 1;
    }
    
    reorderedChats.splice(insertIndex, 0, draggedChat);

    const chatOrder = reorderedChats.map(chat => chat.id);
    BrowserStorage.updateUISetting('chatOrder', chatOrder);
    
    if (onChatReorder) {
      onChatReorder(reorderedChats);
    }

    setDraggedItem(null);
    setDropPosition(null);
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
    setDropPosition(null);
    setLastDropPosition(null);
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
            <div className="sidebar-item" onClick={() => onOpenModal?.('gallery')}>
              <div className="sidebar-icon gallery-icon"></div>
              Gallery
            </div>
            <div className="sidebar-item" onClick={() => onOpenModal?.('search')}>
              <div className="sidebar-icon search-icon"></div>
              Search
            </div>
            <div className="sidebar-item" onClick={() => onOpenModal?.('settings')}>
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
                  chats.map((chat, index) => (
                    <React.Fragment key={chat.id}>
                      {dropPosition?.index === index && dropPosition.position === 'before' && (
                        <div className="drop-indicator" />
                      )}
                      
                      <div
                        className={`chat-item ${
                          selectionMode 
                            ? selectedChats.has(chat.id) ? 'selected' : ''
                            : chat.isActive ? 'active' : ''
                        } ${
                          draggedItem === chat.id ? 'dragging' : ''
                        }`}
                        draggable={!selectionMode && editingChatId !== chat.id}
                        onDragStart={(e) => handleDragStart(e, chat.id)}
                        onDragOver={(e) => handleDragOver(e, chat.id)}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        onDragEnd={handleDragEnd}
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
                            onKeyDown={(e) => {
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
                          {chat.id !== activeChat && chat.state !== 'static' && (
                            <span className={`chat-state-indicator ${chat.state}`} key={chat.state} />
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
                      
                      {dropPosition?.index === index && dropPosition.position === 'after' && (
                        <div className="drop-indicator" />
                      )}
                    </React.Fragment>
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
        
        {/* TEMPORARY_DEBUG_TRIGGERLOG - debugging component */}
        {triggerLogProps && (
          <TriggerLog activeChatId={triggerLogProps.activeChatId} />
        )}
        
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
