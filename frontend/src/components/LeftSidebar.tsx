// status: complete

import React, { useState} from 'react';
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
}

const LeftSidebar: React.FC<LeftSidebarProps> = ({
  chats = [],
  activeChat,
  onChatSelect,
  onNewChat,
  onDeleteChat,
  onEditChat
}) => {
  const [isToggled, setIsToggled] = useState(() => {
    const settings = BrowserStorage.getUISettings();
    return settings.leftSidebarToggled;
  });
  const [isHovering, setIsHovering] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);

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
                <div className="chat-history-title">
                  <div className="sidebar-icon chat-history-icon"></div>
                  <h3>Chat History</h3>
                </div>
                <button className="refresh-button">↻</button>
              </div>
              <div className="chat-history-content">
                {chats.length === 0 ? (
                  <p className="no-history">No chat history yet</p>
                ) : (
                  chats.map((chat) => (
                    <div
                      key={chat.id}
                      className={`chat-item ${chat.id === activeChat ? 'active' : ''}`}
                      onClick={() => editingChatId !== chat.id && onChatSelect?.(chat.id)}
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
                          <span className="chat-name">{chat.name}</span>
                          {chat.state && chat.state !== 'static' && (
                            <span className={`chat-state-indicator ${chat.state}`}>
                              {chat.state === 'thinking' ? '🤔' : '✍️'}
                            </span>
                          )}
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