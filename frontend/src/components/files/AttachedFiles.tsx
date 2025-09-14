// status: complete

import React, { useState, useMemo } from 'react';
import { BrowserStorage, AttachedFile } from '../../utils/storage/BrowserStorage';
import logger from '../../utils/core/logger';
import '../../styles/files/AttachedFiles.css';

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
      return 'var(--loading-color, #3498db)';
    case 'uploaded':
      return '#ffa500'; 
    case 'ready':
      return 'var(--success-color, #27ae60)'; 
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
    case 'local':
      return 'uploading to API'; 
    case 'processing_md':
      return 'processing';
    case 'uploading':
      return 'uploading';
    case 'uploaded':
      return 'uploaded';
    case 'processing':
      return 'processing';
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
  
  React.useEffect(() => {
    if (files.length === 0) {
      logger.info(`[AttachedFiles] No files attached`);
      return;
    }
    
    const readyCount = files.filter(f => f.api_state === 'ready').length;
    const processingCount = files.filter(f => ['local', 'processing_md', 'uploading', 'uploaded', 'processing'].includes(f.api_state || '')).length;
    const errorCount = files.filter(f => f.api_state === 'error').length;
    
    if (processingCount > 0) {
      logger.info(`[COLLECTIVE-UI] ${readyCount}/${files.length} ready, ${processingCount} processing:`, 
        files.map(f => ({ name: f.name, state: f.api_state })));
    } else if (readyCount === files.length) {
      logger.info(`[COLLECTIVE-UI] ALL ${files.length} files ready for sending:`, 
        files.map(f => ({ name: f.name, state: f.api_state })));
    } else {
      logger.info(`[COLLECTIVE-UI] File states: ready=${readyCount}, processing=${processingCount}, error=${errorCount}`, 
        files.map(f => ({ name: f.name, state: f.api_state })));
    }
  }, [files]);

  const statusInfo = useMemo(() => {
    if (files.length === 0) return null;
    
    const readyCount = files.filter(f => f.api_state === 'ready').length;
    const processingCount = files.filter(f => ['local', 'processing_md', 'uploading', 'uploaded', 'processing'].includes(f.api_state || '')).length;
    const errorCount = files.filter(f => f.api_state === 'error').length;
    
    if (processingCount > 0) {
      return <span className="file-status processing"> • {readyCount}/{files.length} ready ({processingCount} processing)</span>;
    } else if (errorCount > 0) {
      return <span className="file-status error"> • {errorCount} failed</span>;
    } else if (readyCount === files.length && files.length > 0) {
      return <span className="file-status ready"> • all ready for sending</span>;
    }
    return null;
  }, [files]);

  const fileList = useMemo(() => files.map((file, index) => {
    const localProcessingStates = ['processing_md']; 
    const serverProcessingStates = ['local', 'uploading', 'uploaded', 'processing'];
    const readyStates = ['ready'];
    const errorStates = ['error'];
    
    const showBlueSpinner = file.api_state ? serverProcessingStates.includes(file.api_state) : false;
    const showOrangeSpinner = !showBlueSpinner && (file.api_state ? localProcessingStates.includes(file.api_state) : true);
    const showSpinner = showOrangeSpinner || showBlueSpinner;
    
    if (file.api_state && !showSpinner && !readyStates.includes(file.api_state)) {
      logger.warn(`[INDIVIDUAL-SPINNER] File ${file.name} in state ${file.api_state} but no spinner showing`);
    }
    
    const isDimmed = !file.api_state || (!readyStates.includes(file.api_state) && !errorStates.includes(file.api_state));
    
    if (file.api_state) {
      logger.debug(`[INDIVIDUAL-FILE] ${file.name}: ${file.api_state} | Spinner: ${showSpinner ? (showBlueSpinner ? 'blue' : 'orange') : 'none'} | Dimmed: ${isDimmed}`);
    }
            
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
  }), [files, onRemoveFile]);

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
          {statusInfo}
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
          {fileList}
        </div>
      </div>
    </div>
  );
};

export default AttachedFiles;