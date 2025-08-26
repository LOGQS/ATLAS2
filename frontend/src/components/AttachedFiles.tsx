import React, { useState } from 'react';
import { BrowserStorage } from '../utils/BrowserStorage';
import logger from '../utils/logger';
import '../styles/AttachedFiles.css';

interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  api_state?: string;
  provider?: string;
}

interface AttachedFilesProps {
  files: AttachedFile[];
  onRemoveFile: (fileId: string) => void;
  onClearAll?: () => void;
  className?: string;
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

const getFileStateIcon = (apiState?: string): string => {
  switch (apiState) {
    case 'uploading':
    case 'processing':
    case 'api_processing':
      return '🔄';
    case 'uploaded':
      return '⬆️';
    case 'ready':
      return '✅';
    case 'error':
      return '❌';
    case 'local':
    default:
      return '📎';
  }
};

const getFileStateColor = (apiState?: string): string => {
  switch (apiState) {
    case 'uploading':
    case 'processing':
    case 'api_processing':
      return 'var(--loading-color, #3498db)';
    case 'uploaded':
      return '#ffa500'; // Orange-ish to show intermediate state
    case 'ready':
      return 'var(--success-color, #27ae60)'; // Bright green for truly ready
    case 'error':
      return 'var(--error-color, #e74c3c)';
    case 'processing_md':
      return '#ff9234';
    case 'local':
    default:
      return 'var(--text-color, #333)';
  }
};

const getDisplayStateText = (apiState?: string): string => {
  switch (apiState) {
    case 'selected':
    case 'processing_md':
      return 'processing';
    case 'uploading':
      return 'uploading';
    case 'uploaded':
      return 'uploaded';
    case 'processing':
    case 'api_processing':
      return 'verifying';
    case 'ready':
      return 'ready';
    case 'error':
      return 'error';
    default:
      return '';
  }
};

const AttachedFiles: React.FC<AttachedFilesProps> = ({ 
  files, 
  onRemoveFile, 
  onClearAll,
  className = '' 
}) => {
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const settings = BrowserStorage.getUISettings();
    return settings.attachedFilesCollapsed || false;
  });
  
  // Log when component receives files prop changes
  React.useEffect(() => {
    logger.info(`[AttachedFiles] Files prop changed: ${files.length} files`, files.map(f => ({ name: f.name, api_state: f.api_state })));
  }, [files]);
  
  if (files.length === 0) {
    return null;
  }

  const toggleCollapse = () => {
    const newCollapsedState = !isCollapsed;
    setIsCollapsed(newCollapsedState);
    BrowserStorage.updateUISetting('attachedFilesCollapsed', newCollapsedState);
  };

  return (
    <div className={`attached-files ${className}`}>
      <div 
        className="attached-files-header"
        onClick={toggleCollapse}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            toggleCollapse();
          }
        }}
      >
        <div className="attached-files-title">
          <div className="attachment-icon">📎</div>
          <span className="attached-files-count">
            {files.length} file{files.length !== 1 ? 's' : ''} attached
          </span>
        </div>
        <div className="attached-files-actions">
          {onClearAll && (
            <button
              className="clear-all-files-btn"
              onClick={(e) => {
                e.stopPropagation();
                onClearAll();
              }}
              title="Clear all files"
              aria-label="Clear all files"
            >
              🗑️
            </button>
          )}
          <div className={`collapse-arrow ${isCollapsed ? 'collapsed' : ''}`}>
            <div className="arrow-icon"></div>
          </div>
        </div>
      </div>
      
      <div className={`attached-files-content ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="attached-files-list">
          {files.map((file, index) => {
            const localProcessingStates = ['selected', 'processing_md'];
            const apiProcessingStates = ['uploading', 'uploaded', 'processing', 'api_processing'];
            const readyStates = ['ready', 'local'];
            const errorStates = ['error'];
            
            // Exclusive spinner logic: API processing takes priority over local processing
            const showBlueSpinner = file.api_state ? apiProcessingStates.includes(file.api_state) : false;
            const showOrangeSpinner = !showBlueSpinner && (file.api_state ? localProcessingStates.includes(file.api_state) : true);
            const showSpinner = showOrangeSpinner || showBlueSpinner;
            
            // Log spinner state for debugging
            logger.info(`[SPINNER] File: ${file.name}, api_state: ${file.api_state || 'undefined'}, showOrange: ${showOrangeSpinner}, showBlue: ${showBlueSpinner}, showSpinner: ${showSpinner}`);
            const isDimmed = !file.api_state || (!readyStates.includes(file.api_state) && !errorStates.includes(file.api_state));
            
            return (
              <div 
                key={index} 
                className={`attached-file-item ${isDimmed ? 'dimmed' : ''} ${showSpinner ? 'processing' : ''}`}
                style={{
                  opacity: isDimmed ? 0.6 : 1,
                  color: getFileStateColor(file.api_state)
                }}
              >
                <div className="file-icon">
                  {getFileIcon(file.name)}
                </div>
                <div className="file-info">
                  <div className="file-name" title={file.name}>
                    {file.name.length > 30 ? `${file.name.substring(0, 30)}...` : file.name}
                  </div>
                  <div className="file-size">
                    {formatFileSize(file.size)}
                  </div>
                  {file.api_state && file.api_state !== 'local' && (
                    <div className="file-state" title={`State: ${file.api_state}`}>
                      <span className="state-icon">{getFileStateIcon(file.api_state)}</span>
                      <span className="state-text">{getDisplayStateText(file.api_state)}</span>
                    </div>
                  )}
                </div>
                {showSpinner && (
                  <div className="loading-spinner">
                    <div className={`spinner ${showBlueSpinner ? 'spinner-api' : 'spinner-local'}`}></div>
                  </div>
                )}
                <button
                  className="remove-file-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveFile(file.id);
                  }}
                  title="Remove file"
                  aria-label={`Remove ${file.name}`}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default AttachedFiles;