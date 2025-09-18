import React, { useState, useCallback } from 'react';
import '../../styles/files/EmbeddedFileViewer.css';

interface FileData {
  id?: string;
  name: string;
  type?: string;
  size?: number;
  content?: any;
  url?: string;
  metadata?: Record<string, any>;
}

interface EmbeddedFileViewerProps {
  file: FileData;
  subrenderer?: React.ComponentType<{ file: FileData; embedded?: boolean }>;
  onExpand?: (file: FileData) => void;
  maxHeight?: number | string;
  showControls?: boolean;
  className?: string;
}

const EmbeddedFileViewer: React.FC<EmbeddedFileViewerProps> = ({
  file,
  subrenderer: SubRenderer,
  onExpand,
  maxHeight = 400,
  showControls = true,
  className = ''
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoading] = useState(false);

  const getFileIcon = (fileName: string): string => {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';

    if (['pdf'].includes(ext)) return '📄';
    if (['doc', 'docx'].includes(ext)) return '📝';
    if (['xls', 'xlsx'].includes(ext)) return '📊';
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return '🖼️';
    if (['mp3', 'wav', 'flac'].includes(ext)) return '🎵';
    if (['mp4', 'avi', 'mov', 'webm'].includes(ext)) return '🎬';
    if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
    if (['js', 'jsx', 'ts', 'tsx', 'html', 'css'].includes(ext)) return '💻';
    if (['py', 'java', 'cpp', 'c', 'cs'].includes(ext)) return '⚙️';
    if (['txt', 'md', 'rtf'].includes(ext)) return '📝';

    return '📎';
  };

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return '';
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleExpand = useCallback(() => {
    if (onExpand) {
      onExpand(file);
    }
  }, [file, onExpand]);

  const toggleCollapse = useCallback(() => {
    setIsCollapsed(prev => !prev);
  }, []);

  return (
    <div className={`embedded-file-viewer ${className} ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="embedded-file-viewer-header">
        <div className="embedded-file-viewer-info">
          <span className="file-icon">{getFileIcon(file.name)}</span>
          <span className="file-name" title={file.name}>
            {file.name.length > 40 ? `${file.name.substring(0, 40)}...` : file.name}
          </span>
          {file.size && (
            <span className="file-size">{formatFileSize(file.size)}</span>
          )}
        </div>

        {showControls && (
          <div className="embedded-file-viewer-controls">
            <button
              className="viewer-control-btn collapse-btn"
              onClick={toggleCollapse}
              title={isCollapsed ? "Show preview" : "Hide preview"}
              aria-label={isCollapsed ? "Show preview" : "Hide preview"}
            >
              <span className={`collapse-icon ${isCollapsed ? 'collapsed' : ''}`}>▼</span>
            </button>
            {onExpand && (
              <button
                className="viewer-control-btn expand-btn"
                onClick={handleExpand}
                title="Open in full viewer"
                aria-label="Open in full viewer"
              >
                <span className="expand-icon">⤢</span>
              </button>
            )}
          </div>
        )}
      </div>

      {!isCollapsed && (
        <div
          className="embedded-file-viewer-content"
          style={{ maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight }}
        >
          {isLoading && (
            <div className="embedded-loading-state">
              <div className="loading-spinner"></div>
              <span>Loading preview...</span>
            </div>
          )}

          {!isLoading && SubRenderer ? (
            <div className="embedded-subrenderer-container">
              <SubRenderer file={file} embedded={true} />
            </div>
          ) : !isLoading ? (
            <div className="embedded-file-viewer-placeholder" onClick={handleExpand}>
              <div className="placeholder-content">
                <div className="placeholder-icon">{getFileIcon(file.name)}</div>
                <div className="placeholder-text">
                  <p className="file-name-display">{file.name}</p>
                  {file.size && (
                    <p className="file-size-display">{formatFileSize(file.size)}</p>
                  )}
                  {onExpand && (
                    <p className="click-to-open">Click to open</p>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default EmbeddedFileViewer;