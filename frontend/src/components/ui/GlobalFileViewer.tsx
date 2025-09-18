import React, { useEffect, useCallback } from 'react';
import '../../styles/ui/GlobalFileViewer.css';

interface FileData {
  id?: string;
  name: string;
  type?: string;
  size?: number;
  content?: any;
  url?: string;
  metadata?: Record<string, any>;
}

interface GlobalFileViewerProps {
  isOpen: boolean;
  file?: FileData | null;
  subrenderer?: React.ComponentType<{ file: FileData; onClose?: () => void }>;
  onClose: () => void;
  title?: string;
  showHeader?: boolean;
  className?: string;
}

const GlobalFileViewer: React.FC<GlobalFileViewerProps> = ({
  isOpen,
  file,
  subrenderer: SubRenderer,
  onClose,
  title,
  showHeader = true,
  className = ''
}) => {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen || !file) return null;

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

  return (
    <div className="global-file-viewer-overlay" onClick={onClose}>
      <div
        className={`global-file-viewer ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {showHeader && (
          <div className="global-file-viewer-header">
            <div className="global-file-viewer-title">
              <span className="file-icon">{getFileIcon(file.name)}</span>
              <span className="file-name">{title || file.name}</span>
              {file.size && (
                <span className="file-size">{formatFileSize(file.size)}</span>
              )}
            </div>
            <button
              className="global-file-viewer-close"
              onClick={onClose}
              aria-label="Close viewer"
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
        )}

        <div className="global-file-viewer-content">
          {SubRenderer ? (
            <SubRenderer file={file} onClose={onClose} />
          ) : (
            <div className="global-file-viewer-placeholder">
              <div className="placeholder-icon">{getFileIcon(file.name)}</div>
              <div className="placeholder-text">
                <p className="file-name-large">{file.name}</p>
                {file.size && (
                  <p className="file-size-large">{formatFileSize(file.size)}</p>
                )}
                <p className="no-viewer-text">
                  No viewer available for this file type
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default GlobalFileViewer;