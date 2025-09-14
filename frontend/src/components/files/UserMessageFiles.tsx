import React, {
  useState,
  useCallback,
  useRef
} from 'react';

import logger from '../../utils/core/logger';
import { AttachedFile } from '../../utils/storage/BrowserStorage';

import '../../styles/files/UserMessageFiles.css';

interface UserMessageFilesProps {
  files: AttachedFile[];
  onFileReupload?: (file: AttachedFile) => void;
  onFileDelete?: (fileId: string) => Promise<void>;
  isStatic?: boolean;
  chatId?: string;
  messageId?: string;
  chatScrollControl?: {
    shouldAutoScroll: () => boolean;
    onStreamStart: () => void;
    resetToAutoScroll: () => void;
  };
}

const getFileIcon = (filename: string): string => {
  const extension = filename.split('.').pop()?.toLowerCase() || '';
  
  if (['pdf'].includes(extension)) return '📄';
  if (['doc', 'docx'].includes(extension)) return '📝';
  if (['xls', 'xlsx'].includes(extension)) return '📊';
  if (['ppt', 'pptx'].includes(extension)) return '📋';
  
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(extension)) return '🖼️';
  
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(extension)) return '🎵';
  
  if (['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv'].includes(extension)) return '🎬';
  
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) return '🗜️';
  
  if (['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'json'].includes(extension)) return '💻';
  if (['py', 'java', 'cpp', 'c', 'cs', 'php', 'rb', 'go', 'rs'].includes(extension)) return '⚙️';
  
  if (['txt', 'md', 'rtf'].includes(extension)) return '📝';
  
  return '📎';
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};


const isFileUnavailable = (file: AttachedFile): boolean => {
  return file.api_state === 'unavailable' || file.api_state === 'error';
};

const getRetryIcon = (): string => {
  return '🔄';
};

const UserMessageFiles: React.FC<UserMessageFilesProps> = ({ 
  files, 
  onFileReupload, 
  onFileDelete, 
  isStatic = true, 
  chatId, 
  messageId, 
  chatScrollControl 
}) => {
  const [showModal, setShowModal] = useState(false);
  const [selectedFile, setSelectedFile] = useState<AttachedFile | null>(null);
  const [deletingFiles, setDeletingFiles] = useState<Set<string>>(new Set());
  const [isCollapsed, setIsCollapsed] = useState(true);
  const filesEndRef = useRef<HTMLDivElement>(null);

  const toggleCollapse = () => {
    const wasCollapsed = isCollapsed;
    setIsCollapsed(!isCollapsed);
    
    if (wasCollapsed) {
      setTimeout(() => {
        if (chatScrollControl?.shouldAutoScroll()) {
          const filesElement = filesEndRef.current;
          const chatContainer = filesElement?.closest('.chat-messages')?.querySelector('.messages-container');
          if (chatContainer) {
            chatContainer.scrollTop = chatContainer.scrollHeight;
            logger.info(`[SCROLL] UserMessageFiles triggered scroll to bottom for chat: ${chatId || 'unknown'}`);
          }
        } else {
          logger.debug(`[SCROLL] UserMessageFiles scroll to bottom suppressed for ${chatId} (auto-scroll disabled)`);
        }
      }, 100);
    }
  };

  const handleFileClick = useCallback((file: AttachedFile) => {
    if (isFileUnavailable(file)) {
      setSelectedFile(file);
      setShowModal(true);
    }
  }, []);
  
  const handleReupload = useCallback(() => {
    if (selectedFile && onFileReupload) {
      onFileReupload(selectedFile);
    }
    setShowModal(false);
    setSelectedFile(null);
  }, [selectedFile, onFileReupload]);
  
  const handleModalClose = useCallback(() => {
    setShowModal(false);
    setSelectedFile(null);
  }, []);

  const handleDeleteFile = useCallback(async (file: AttachedFile, event: React.MouseEvent) => {
    event.stopPropagation();
    
    if (!onFileDelete) return;
    
    setDeletingFiles(prev => new Set(Array.from(prev).concat(file.id)));
    
    try {
      await onFileDelete(file.id);
    } catch (error) {
      console.error('Failed to delete file:', error);
    } finally {
      setDeletingFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(file.id);
        return newSet;
      });
    }
  }, [onFileDelete]);
  
  if (!files || files.length === 0) {
    return null;
  }

  const fileNames = files.map(file => file.name);
  const displayNames = fileNames.length > 3 
    ? `${fileNames.slice(0, 3).join(', ')} and ${fileNames.length - 3} more`
    : fileNames.join(', ');

  return (
    <div className="user-message-files">
      <div 
        className="user-message-files-header"
        onClick={toggleCollapse}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            toggleCollapse();
          }
        }}
      >
        <div className="user-message-files-title">
          <div className="user-message-files-icon">📎</div>
          <div className="user-message-files-summary">
            <span className="file-count">{files.length} file{files.length !== 1 ? 's' : ''}</span>
            <span className="file-names" title={fileNames.join('\n')}>{displayNames}</span>
          </div>
        </div>
        <div className={`user-message-files-collapse-arrow ${isCollapsed ? 'collapsed' : ''}`}>
          <div className="user-message-files-arrow-icon"></div>
        </div>
      </div>
      
      <div className={`user-message-files-content ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="user-message-files-grid">
        {files.map((file, index) => {
          const isUnavailable = isFileUnavailable(file);
          const isClickable = isUnavailable;
          const isDeleting = deletingFiles.has(file.id);
          
          return (
            <div 
              key={index} 
              className={`user-message-file-item ${isUnavailable ? 'unavailable' : ''} ${isClickable ? 'clickable' : ''} ${isDeleting ? 'deleting' : ''}`}
              onClick={() => handleFileClick(file)}
              style={{ opacity: isUnavailable ? 0.6 : 1 }}
              title={isUnavailable ? 'File no longer available - click to reupload' : file.name}
            >
              <div className="user-message-file-icon">
                {getFileIcon(file.name)}
              </div>
              
              {onFileDelete && !isUnavailable && !isDeleting && isStatic && (
                <button 
                  className="file-delete-btn"
                  onClick={(e) => handleDeleteFile(file, e)}
                  title="Delete file"
                  aria-label={`Delete ${file.name}`}
                >
                  ×
                </button>
              )}
              
              {isDeleting && (
                <div className="file-delete-loading">
                  <span className="delete-spinner">⌛</span>
                </div>
              )}
              
              {isUnavailable && isStatic && (
                <div className="file-retry-overlay">
                  <span className="retry-icon">{getRetryIcon()}</span>
                </div>
              )}
              
              <div className="user-message-file-info">
                <div className="user-message-file-name" title={file.name}>
                  {file.name.length > 20 ? `${file.name.substring(0, 20)}...` : file.name}
                </div>
                <div className="user-message-file-size">
                  {formatFileSize(file.size)}
                </div>
                {isUnavailable && (
                  <div className="file-unavailable-status">
                    File unavailable
                  </div>
                )}
              </div>
            </div>
          );
        })}
        </div>
        <div ref={filesEndRef} />
      </div>
      
      {showModal && selectedFile && (
        <div className="file-reupload-modal-overlay" onClick={handleModalClose}>
          <div className="file-reupload-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>File No Longer Available</h3>
              <button className="modal-close-btn" onClick={handleModalClose}>×</button>
            </div>
            <div className="modal-body">
              <p>
                The file <strong>{selectedFile.name}</strong> is no longer available in the chat history.
                It may have been automatically deleted from the server after 48 hours.
              </p>
              <p>Do you want to reupload this file to add it back to the history?</p>
            </div>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-secondary" onClick={handleModalClose}>
                Cancel
              </button>
              <button className="modal-btn modal-btn-primary" onClick={handleReupload}>
                Reupload File
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UserMessageFiles;