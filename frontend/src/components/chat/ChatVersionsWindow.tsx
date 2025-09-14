import React, { useState, useCallback, useEffect } from 'react';
import '../../styles/chat/ChatVersionsWindow.css';
import { apiUrl } from '../../config/api';
import logger from '../../utils/core/logger';
import TreeVisualization from '../visualization/TreeVisualization';
import VersionNodeComponent from '../versioning/VersionNode';
import {
  WindowWithChatSwitch,
  VersionNode,
  VersionTreeResponse,
  ViewMode
} from '../versioning/VersioningHelpers';

interface ChatVersionsWindowProps {
  isOpen: boolean;
  onClose: () => void;
  chatId?: string;
}

const LoadingState: React.FC<{ message: string }> = ({ message }) => (
  <div className="versions-loading">
    <div className="versions-loading-spinner"></div>
    <p>{message}</p>
  </div>
);

const ErrorState: React.FC<{ error: string; title: string; onRetry: () => void }> = ({ error, title, onRetry }) => (
  <div className="versions-error">
    <div className="versions-error-icon">⚠️</div>
    <h3>{title}</h3>
    <p>{error}</p>
    <button className="versions-retry-button" onClick={onRetry}>
      Retry
    </button>
  </div>
);

const EmptyState: React.FC<{ title: string; message: string; iconType: 'list' | 'tree' }> = ({ title, message, iconType }) => (
  <div className="versions-empty">
    <div className={`placeholder-icon ${iconType}-icon`}></div>
    <h3>{title}</h3>
    <p>{message}</p>
  </div>
);

const ChatVersionsWindow: React.FC<ChatVersionsWindowProps> = ({
  isOpen,
  onClose,
  chatId
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [versionTree, setVersionTree] = useState<VersionNode | null>(null);
  const [mainChatId, setMainChatId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());


  const handleAsyncError = useCallback((error: unknown, context: string, fallbackMessage: string) => {
    const errorMsg = error instanceof Error ? error.message : fallbackMessage;
    logger.error(`[ChatVersions] ${context}:`, error);
    setError(errorMsg);
  }, []);

  const handleViewToggle = useCallback((mode: ViewMode) => {
    setViewMode(mode);
  }, []);

  const toggleCollapsed = useCallback((nodeId: string) => {
    setCollapsed(prev => {
      const newCollapsed = new Set(prev);
      if (newCollapsed.has(nodeId)) {
        newCollapsed.delete(nodeId);
      } else {
        newCollapsed.add(nodeId);
      }
      return newCollapsed;
    });
  }, []);

  const loadVersionTree = useCallback(async () => {
    if (!chatId) return;

    setLoading(true);
    setError(null);

    try {
      logger.info(`[ChatVersions] Loading version tree for chat: ${chatId}`);
      const response = await fetch(apiUrl(`/api/db/chat/${chatId}/versions`));

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: VersionTreeResponse = await response.json();

      if (!data.success) {
        throw new Error('Failed to load version tree');
      }

      setVersionTree(data.version_tree);
      setMainChatId(data.main_chat_id);
      logger.debug(`[ChatVersions] Loaded version tree:`, data.version_tree);

    } catch (err) {
      handleAsyncError(err, 'Error loading version tree', 'Failed to load version tree');
    } finally {
      setLoading(false);
    }
  }, [chatId, handleAsyncError]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (isOpen && chatId) {
      loadVersionTree();
    }
  }, [isOpen, chatId, loadVersionTree]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const handleVersionSwitch = useCallback(async (versionId: string) => {
    if (versionId === chatId) return;

    try {
      const switchHandler = (window as WindowWithChatSwitch).handleChatSwitch;
      if (typeof switchHandler === 'function') {
        await switchHandler(versionId);
      } else {
        logger.error('Chat switch handler not available');
      }
    } catch (error) {
      handleAsyncError(error, 'Failed to switch version', 'Failed to switch version');
    }
  }, [chatId, handleAsyncError]);

  const handleVersionDelete = useCallback(async (versionId: string) => {
    if (!window.confirm(`Delete version "${versionId}"? This cannot be undone.`)) return;

    try {
      if (chatId && versionId === chatId && mainChatId) {
        const switchHandler = (window as WindowWithChatSwitch).handleChatSwitch;
        if (typeof switchHandler === 'function') {
          await switchHandler(mainChatId);
        }
        alert('Switched to main chat. Now you can delete this version safely.');
        return;
      }

      const response = await fetch(apiUrl(`/api/db/chat/${versionId}`), {
        method: 'DELETE'
      });

      if (response.ok) {
        loadVersionTree();
      } else {
        throw new Error('Failed to delete version');
      }
    } catch (error) {
      handleAsyncError(error, 'Failed to delete version', 'Failed to delete version');
    }
  }, [loadVersionTree, chatId, mainChatId, handleAsyncError]);

  const handleVersionRename = useCallback(async (versionId: string, currentName: string) => {
    const newName = window.prompt('Enter new name:', currentName);
    if (!newName || newName === currentName) return;

    try {
      const response = await fetch(apiUrl(`/api/db/chat/${versionId}/name`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      });

      if (response.ok) {
        loadVersionTree();
      } else {
        throw new Error('Failed to rename version');
      }
    } catch (error) {
      handleAsyncError(error, 'Failed to rename version', 'Failed to rename version');
    }
  }, [loadVersionTree, handleAsyncError]);



  if (!isOpen) return null;

  return (
    <div className="chat-versions-overlay" onClick={handleBackdropClick} role="dialog" aria-modal="true" aria-labelledby="versions-window-title">
      <div className="chat-versions-window">
        <div className="chat-versions-header">
          <div className="chat-versions-title">
            <div className="version-window-icon"></div>
            <h2 id="versions-window-title">Chat Versions</h2>
          </div>
          <div className="chat-versions-controls">
            <div className={`view-mode-toggle ${viewMode === 'tree' ? 'is-tree' : ''}`}>
              <div className="segmented-thumb" />
              <button
                className={`view-toggle-btn list ${viewMode === 'list' ? 'active' : ''}`}
                onClick={() => handleViewToggle('list')}
                title="List View"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6"/>
                  <line x1="8" y1="12" x2="21" y2="12"/>
                  <line x1="8" y1="18" x2="21" y2="18"/>
                  <line x1="3" y1="6" x2="3.01" y2="6"/>
                  <line x1="3" y1="12" x2="3.01" y2="12"/>
                  <line x1="3" y1="18" x2="3.01" y2="18"/>
                </svg>
              </button>
              <button
                className={`view-toggle-btn tree ${viewMode === 'tree' ? 'active' : ''}`}
                onClick={() => handleViewToggle('tree')}
                title="Tree View"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
                  <path d="M8 18h8l-4-4"/>
                  <path d="M8 6h8l-4 4"/>
                  <line x1="4" y1="6" x2="8" y2="6"/>
                  <line x1="4" y1="10" x2="8" y2="10"/>
                  <line x1="4" y1="14" x2="8" y2="14"/>
                  <line x1="4" y1="18" x2="8" y2="18"/>
                </svg>
              </button>
            </div>
            <button className="chat-versions-close-btn" onClick={onClose} aria-label="Close versions window">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        <div className="chat-versions-content">
          <div className={`versions-list-view ${viewMode === 'list' ? 'active' : ''}`}>
            {loading && <LoadingState message="Loading version history..." />}

            {error && (
              <ErrorState
                error={error}
                title="Error Loading Versions"
                onRetry={loadVersionTree}
              />
            )}

            {!loading && !error && versionTree && (
              <div className="versions-list">
                <VersionNodeComponent
                  node={versionTree}
                  depth={0}
                  collapsed={collapsed}
                  toggleCollapsed={toggleCollapsed}
                  handleVersionSwitch={handleVersionSwitch}
                  handleVersionRename={handleVersionRename}
                  handleVersionDelete={handleVersionDelete}
                />
              </div>
            )}

            {!loading && !error && !versionTree && (
              <EmptyState
                title="No Chat Selected"
                message="Select a chat to view its version history"
                iconType="list"
              />
            )}
          </div>
          
          <div className={`versions-tree-view ${viewMode === 'tree' ? 'active' : ''}`}>
            {loading && <LoadingState message="Loading version tree..." />}

            {error && (
              <ErrorState
                error={error}
                title="Error Loading Tree"
                onRetry={loadVersionTree}
              />
            )}

            {!loading && !error && versionTree && (
              <div className="versions-tree">
                <TreeVisualization
                  root={versionTree}
                  currentId={chatId}
                  onNodeClick={handleVersionSwitch}
                />
              </div>
            )}

            {!loading && !error && !versionTree && (
              <EmptyState
                title="No Version Tree"
                message="Select a chat to view its version tree"
                iconType="tree"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatVersionsWindow;
