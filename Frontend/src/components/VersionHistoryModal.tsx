import React, { useState, useEffect } from 'react';

interface FileAttachment {
  file_id: string;
  file_type: 'image' | 'video' | 'audio' | 'document';
  mime_type: string;
  filename: string;
  original_name: string;
  uploading?: boolean;
  upload_progress?: number;
  local_url?: string;
  upload_error?: string;
  processing?: boolean;
  needs_processing?: boolean;
  size?: number;
  is_large_file?: boolean;
  state?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: FileAttachment[];
  isHistory?: boolean;
  reasoning?: string;
  timestamp?: string;
  tags?: string[];
}

interface Version {
  timestamp: string;
  messages: ChatMessage[];
  action: 'edit' | 'delete' | 'refresh' | 'restore';
  index: number;
  name?: string;
}

interface VersionHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  chatId: string;
  onRestore: () => void;
}

const VersionHistoryModal: React.FC<VersionHistoryModalProps> = ({ 
  isOpen, 
  onClose, 
  chatId, 
  onRestore 
}) => {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [editingVersionIndex, setEditingVersionIndex] = useState<number | null>(null);
  const [editingVersionName, setEditingVersionName] = useState('');

  // Handle click outside modal to close
  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const fetchVersions = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/chats/${chatId}/versions`);
      const data = await res.json();
      if (res.ok) {
        setVersions(data.versions || []);
      }
    } catch (e) {
      console.error('Failed to fetch versions:', e);
    }
    setLoading(false);
  }, [chatId]);

  useEffect(() => {
    if (isOpen && chatId) {
      fetchVersions();
    }
  }, [isOpen, chatId, fetchVersions]);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleEscKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscKey);
      return () => {
        document.removeEventListener('keydown', handleEscKey);
      };
    }
  }, [isOpen, onClose]);

  const handleRestore = async (versionIndex: number) => {
    if (!window.confirm('Restore to this version? This will replace your current chat history.')) {
      return;
    }
    
    try {
      setLoading(true);
      const res = await fetch(`/api/chats/${chatId}/versions/${versionIndex}/restore`, {
        method: 'POST'
      });
      const data = await res.json();
      
      if (res.ok) {
        // Close modal first, then reload from backend to ensure fresh data
        onClose();
        onRestore(); // This will trigger reloadChatFromBackend in Chat.tsx
        console.log(`Successfully restored to version ${versionIndex}`);
      } else {
        console.error('Restore failed:', data.error);
        alert(`Failed to restore version: ${data.error || 'Unknown error'}`);
      }
    } catch (e) {
      console.error('Restore request failed:', e);
      alert('Failed to restore version. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleEditVersionName = (versionIndex: number) => {
    const version = versions[versionIndex];
    setEditingVersionIndex(versionIndex);
    setEditingVersionName(version.name || `${version.action} at ${new Date(version.timestamp).toLocaleString()}`);
  };

  const handleSaveVersionName = async () => {
    if (editingVersionIndex === null || !editingVersionName.trim()) return;
    
    try {
      const res = await fetch(`/api/chats/${chatId}/versions/${editingVersionIndex}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editingVersionName.trim() })
      });
      
      if (res.ok) {
        setVersions(prev => prev.map((v, i) => 
          i === editingVersionIndex ? { ...v, name: editingVersionName.trim() } : v
        ));
        setEditingVersionIndex(null);
        setEditingVersionName('');
        console.log('Version name updated successfully');
      } else {
        const errorData = await res.json();
        alert(`Failed to update version name: ${errorData.error || 'Unknown error'}`);
      }
    } catch (e) {
      console.error('Error updating version name:', e);
      alert('Failed to update version name. Please check your connection and try again.');
    }
  };

  const handleCancelEdit = () => {
    setEditingVersionIndex(null);
    setEditingVersionName('');
  };

  const handleDeleteVersion = async (versionIndex: number) => {
    const version = versions[versionIndex];
    const versionName = version.name || `${version.action} version`;
    
    if (!window.confirm(`Delete "${versionName}"? This action cannot be undone.`)) {
      return;
    }
    
    try {
      const res = await fetch(`/api/chats/${chatId}/versions/${versionIndex}`, {
        method: 'DELETE'
      });
      
      if (res.ok) {
        const data = await res.json();
        setVersions(prev => prev.filter((_, i) => i !== versionIndex));
        console.log(`Version deleted successfully. ${data.remaining_versions} versions remaining.`);
        
        // If we deleted the selected version, clear selection
        if (selectedVersion === versionIndex) {
          setSelectedVersion(null);
        } else if (selectedVersion !== null && selectedVersion > versionIndex) {
          // Adjust selected version index if we deleted a version before it
          setSelectedVersion(selectedVersion - 1);
        }
        
        // If no versions left, close modal and trigger parent refresh
        if (data.remaining_versions === 0) {
          onClose();
          onRestore(); // This will trigger checkVersionsExist in Chat.tsx
        }
      } else {
        const errorData = await res.json();
        alert(`Failed to delete version: ${errorData.error || 'Unknown error'}`);
      }
    } catch (e) {
      console.error('Error deleting version:', e);
      alert('Failed to delete version. Please check your connection and try again.');
    }
  };

  const getActionIcon = (action: string) => {
    switch (action) {
      case 'edit':
        return (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" />
            <path fillRule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" />
          </svg>
        );
      case 'delete':
        return (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        );
      case 'refresh':
        return (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
          </svg>
        );
      case 'restore':
        return (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M15.707 4.293a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-5-5a1 1 0 011.414-1.414L10 8.586l4.293-4.293a1 1 0 011.414 0zm0 6a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-5-5a1 1 0 111.414-1.414L10 14.586l4.293-4.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        );
      default:
        return null;
    }
  };

  const getActionColor = (action: string) => {
    switch (action) {
      case 'edit': return 'text-blue-400';
      case 'delete': return 'text-red-400';
      case 'refresh': return 'text-green-400';
      case 'restore': return 'text-purple-400';
      default: return 'text-gray-400';
    }
  };

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  if (!isOpen) return null;

  return (
    <div className="version-history-overlay" onClick={handleOverlayClick}>
      <div className="version-history-modal">
        <div className="version-history-header">
          <div className="version-history-title">
            <svg className="w-6 h-6 text-purple-400" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
            </svg>
            <h2>Version History</h2>
          </div>
          <button 
            className="version-history-close"
            onClick={onClose}
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
        
        <div className="version-history-content">
          {loading ? (
            <div className="version-history-loading">
              <div className="loading-spinner"></div>
              <span>Loading version history...</span>
            </div>
          ) : versions.length === 0 ? (
            <div className="version-history-empty">
              <svg fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              <p>No version history available</p>
              <span className="text-sm">Make edits, deletions, or refreshes to create restore points</span>
            </div>
          ) : (
            <div className="version-history-list">
              {versions.map((version, index) => (
                <div 
                  key={index}
                  className={`version-item ${selectedVersion === index ? 'selected' : ''}`}
                  onClick={() => setSelectedVersion(selectedVersion === index ? null : index)}
                >
                  <div className="version-item-header">
                    <div className="version-action">
                      <div className={`version-action-icon ${getActionColor(version.action)}`}>
                        {getActionIcon(version.action)}
                      </div>
                      {editingVersionIndex === index ? (
                        <input
                          type="text"
                          value={editingVersionName}
                          onChange={(e) => setEditingVersionName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleSaveVersionName();
                            } else if (e.key === 'Escape') {
                              handleCancelEdit();
                            }
                          }}
                          className="version-name-input"
                          autoFocus
                        />
                      ) : (
                        <span className="version-action-text">
                          {version.name || `${version.action.charAt(0).toUpperCase() + version.action.slice(1)}`}
                        </span>
                      )}
                    </div>
                    <div className="version-item-controls">
                      {editingVersionIndex === index ? (
                        <div className="version-edit-controls">
                          <button 
                            onClick={handleSaveVersionName}
                            className="version-save-btn"
                            title="Save"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M9 16.17L5.53 12.7c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41l4.18 4.18c.39.39 1.02.39 1.41 0L20.29 7.71c.39-.39.39-1.02 0-1.41-.39-.39-1.02-.39-1.41 0L9 16.17z"/>
                            </svg>
                          </button>
                          <button 
                            onClick={handleCancelEdit}
                            className="version-cancel-btn"
                            title="Cancel"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M18.3 5.71c-.39-.39-1.02-.39-1.41 0L12 10.59 7.11 5.7c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41L10.59 12 5.7 16.89c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0L12 13.41l4.89 4.89c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L13.41 12l4.89-4.89c.38-.38.38-1.02 0-1.4z"/>
                            </svg>
                          </button>
                        </div>
                      ) : (
                        <div className="version-management-controls">
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEditVersionName(index);
                            }}
                            className="version-edit-name-btn"
                            title="Edit name"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M14.06 9.02l.92.92L5.92 19H5v-.92l9.06-9.06M17.66 3c-.25 0-.51.1-.7.29l-1.83 1.83 3.75 3.75 1.83-1.83c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.2-.2-.45-.29-.71-.29zm-3.6 3.19L3 17.25V21h3.75L17.81 9.94l-3.75-3.75z"/>
                            </svg>
                          </button>
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteVersion(index);
                            }}
                            className="version-delete-btn"
                            title="Delete version"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z"/>
                            </svg>
                          </button>
                        </div>
                      )}
                      <div className="version-timestamp">
                        {formatTimestamp(version.timestamp)}
                      </div>
                    </div>
                  </div>
                  
                  <div className="version-item-details">
                    <span className="version-messages-count">
                      {version.messages.length} messages
                    </span>
                    <span className="version-index">
                      @ index {version.index}
                    </span>
                  </div>
                  
                  {selectedVersion === index && (
                    <div className="version-item-actions">
                      <button 
                        className="version-restore-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRestore(index);
                        }}
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M15.707 4.293a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-5-5a1 1 0 011.414-1.414L10 8.586l4.293-4.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                        Restore to this point
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default VersionHistoryModal;