import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useCoderContext } from '../../contexts/CoderContext';
import { apiUrl } from '../../config/api';
import logger from '../../utils/core/logger';
import { Icons } from '../ui/Icons';
import { DiffViewer } from './DiffViewer';
import '../../styles/coder/FileHistoryPanel.css';

interface FileSnapshot {
  id: number;
  content: string;
  timestamp: string;
  edit_type: 'checkpoint';
  content_hash: string;
}

interface FileHistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  filePath: string;
}

export const FileHistoryPanel: React.FC<FileHistoryPanelProps> = ({ isOpen, onClose, filePath }) => {
  const { chatId, currentDocument, updateFileContent } = useCoderContext();
  const [history, setHistory] = useState<FileSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => {
    if (!isOpen || !filePath || !chatId) {
      return;
    }

    if (currentDocument && currentDocument.filePath !== filePath) {
      return;
    }

    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, filePath, chatId, currentDocument?.originalContent]);

  useEffect(() => {
    if (!showDiff || selectedSnapshotId === null) return;

    const exists = history.some((snapshot) => snapshot.id === selectedSnapshotId);
    if (!exists) {
      setSelectedSnapshotId(null);
      setShowDiff(false);
    }
  }, [history, selectedSnapshotId, showDiff]);

  const selectedSnapshotIndex = selectedSnapshotId !== null
    ? history.findIndex((snapshot) => snapshot.id === selectedSnapshotId)
    : -1;

  const selectedSnapshot = selectedSnapshotIndex >= 0 ? history[selectedSnapshotIndex] : null;
  const previousSnapshot = selectedSnapshotIndex >= 0 && selectedSnapshotIndex + 1 < history.length
    ? history[selectedSnapshotIndex + 1]
    : null;

  const loadHistory = async () => {
    if (!chatId || !filePath) return;

    setIsLoading(true);
    try {
      const response = await fetch(
        apiUrl(`/api/coder-workspace/file/history?chat_id=${chatId}&path=${encodeURIComponent(filePath)}&limit=50`)
      );
      const data = await response.json();

      if (data.success) {
        setHistory(data.history);
      } else {
        logger.error('[FILE_HISTORY] Failed to load history:', data.error);
      }
    } catch (err) {
      logger.error('[FILE_HISTORY] Failed to load history:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevert = async (snapshot: FileSnapshot) => {
    if (!currentDocument) return;

    // Update the current editor content
    updateFileContent(snapshot.content);
    setSelectedSnapshotId(null);
    setShowDiff(false);
    onClose();
    logger.info('[FILE_HISTORY] Reverted to snapshot:', snapshot.id);
  };

  const handlePreview = (snapshot: FileSnapshot) => {
    setSelectedSnapshotId(snapshot.id);
    setShowDiff(true);
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);

    // Format: Dec 10, 2024 at 14:32:45
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    const timeStr = date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    return `${dateStr} at ${timeStr}`;
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="file-history-panel-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.div
          className="file-history-panel"
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="history-header">
            <div className="history-title">
              <Icons.Time className="w-5 h-5" />
              <span>File History</span>
            </div>
            <button onClick={onClose} className="close-button">
              <Icons.Close className="w-5 h-5" />
            </button>
          </div>

          {/* File Path */}
          <div className="history-file-path">{filePath}</div>

          {/* Content */}
          <div className="history-content">
            {showDiff && selectedSnapshot ? (
              <div className="diff-preview">
                <div className="diff-header">
                  <button
                    onClick={() => {
                      setShowDiff(false);
                      setSelectedSnapshotId(null);
                    }}
                    className="back-button"
                  >
                    <Icons.Back className="w-4 h-4" />
                    Back to history
                  </button>
                  <button
                    onClick={() => selectedSnapshot && handleRevert(selectedSnapshot)}
                    className="revert-button"
                  >
                    <Icons.Discard className="w-4 h-4" />
                    Revert to this version
                  </button>
                </div>
                <div className="diff-content">
                  <DiffViewer
                    original={previousSnapshot ? previousSnapshot.content : ''}
                    modified={selectedSnapshot.content}
                  />
                </div>
              </div>
            ) : isLoading ? (
              <div className="loading-state">
                <div className="spinner"></div>
                <span>Loading history...</span>
              </div>
            ) : history.length === 0 ? (
              <div className="empty-state">
                <Icons.Time className="w-12 h-12 opacity-30" />
                <p>No checkpoints yet for this file</p>
                <small>Save the file (Ctrl+S) to create your first checkpoint</small>
              </div>
            ) : (
              <div className="history-list">
                {history.map((snapshot) => (
                  <motion.div
                    key={snapshot.id}
                    className="history-item"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="history-item-icon">
                      <Icons.Save className="w-4 h-4 text-green-400" />
                    </div>
                    <div className="history-item-content">
                      <div className="history-item-type">
                        Checkpoint
                      </div>
                      <div className="history-item-time">
                        {formatTimestamp(snapshot.timestamp)}
                      </div>
                    </div>
                    <div className="history-item-actions">
                      <button
                        onClick={() => handlePreview(snapshot)}
                        className="preview-button"
                        title="Preview changes"
                      >
                        <Icons.Eye className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleRevert(snapshot)}
                        className="revert-button-small"
                        title="Revert to this version"
                      >
                        <Icons.Discard className="w-4 h-4" />
                      </button>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
