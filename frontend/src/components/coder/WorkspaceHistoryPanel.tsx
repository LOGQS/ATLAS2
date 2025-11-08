import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useCoderContext } from '../../contexts/CoderContext';
import { apiUrl } from '../../config/api';
import logger from '../../utils/core/logger';
import { Icons } from '../ui/Icons';
import '../../styles/coder/WorkspaceHistoryPanel.css';

interface FileChange {
  filePath: string;
  checkpointCount: number;
  lastCheckpoint: string;
  linesAdded?: number;
  linesRemoved?: number;
}

interface Checkpoint {
  id: number;
  content: string;
  timestamp: string;
  edit_type: string;
  content_hash: string;
  linesAdded?: number;
  linesRemoved?: number;
}

interface WorkspaceHistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WorkspaceHistoryPanel: React.FC<WorkspaceHistoryPanelProps> = ({ isOpen, onClose }) => {
  const { chatId, workspacePath, openTab } = useCoderContext();
  const [files, setFiles] = useState<FileChange[]>([]);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [fileCheckpoints, setFileCheckpoints] = useState<Record<string, Checkpoint[]>>({});
  const [loadingStats, setLoadingStats] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [totalStats, setTotalStats] = useState<{ linesAdded: number; linesRemoved: number }>({ linesAdded: 0, linesRemoved: 0 });

  useEffect(() => {
    if (isOpen && chatId) {
      loadWorkspaceChanges();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, chatId]);

  const loadWorkspaceChanges = async () => {
    if (!chatId) return;

    setIsLoading(true);
    try {
      const response = await fetch(apiUrl(`/api/coder-workspace/workspace/changes?chat_id=${chatId}`));
      const data = await response.json();

      if (data.success) {
        setFiles(data.files);

        // Set total workspace statistics if available
        if (data.totalStats) {
          setTotalStats({
            linesAdded: data.totalStats.linesAdded || 0,
            linesRemoved: data.totalStats.linesRemoved || 0
          });
        }

        // Load diff stats for all files
        await Promise.all(
          data.files.map((file: FileChange) => loadDiffStats(file.filePath))
        );
      } else {
        logger.error('[WORKSPACE_HISTORY] Failed to load changes:', data.error);
      }
    } catch (err) {
      logger.error('[WORKSPACE_HISTORY] Failed to load changes:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadDiffStats = async (filePath: string) => {
    if (!chatId) return;

    setLoadingStats(prev => new Set([...Array.from(prev), filePath]));
    try {
      const response = await fetch(
        apiUrl(`/api/coder-workspace/file/diff-stats?chat_id=${chatId}&path=${encodeURIComponent(filePath)}`)
      );
      const data = await response.json();

      if (data.success) {
        setFiles(prev => prev.map(f =>
          f.filePath === filePath
            ? { ...f, linesAdded: data.linesAdded, linesRemoved: data.linesRemoved }
            : f
        ));
      }
    } catch (err) {
      logger.error(`[WORKSPACE_HISTORY] Failed to load diff stats for ${filePath}:`, err);
    } finally {
      setLoadingStats(prev => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
    }
  };

  const loadFileCheckpoints = async (filePath: string) => {
    if (!chatId || fileCheckpoints[filePath]) return;

    try {
      const response = await fetch(
        apiUrl(`/api/coder-workspace/file/history?chat_id=${chatId}&path=${encodeURIComponent(filePath)}&limit=50&include_diff_stats=true`)
      );
      const data = await response.json();

      if (data.success) {
        setFileCheckpoints(prev => ({
          ...prev,
          [filePath]: data.history
        }));
      }
    } catch (err) {
      logger.error(`[WORKSPACE_HISTORY] Failed to load checkpoints for ${filePath}:`, err);
    }
  };

  const toggleFile = (filePath: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
        loadFileCheckpoints(filePath);
      }
      return next;
    });
  };

  const handleOpenVersion = async (filePath: string, checkpoint: Checkpoint) => {
    // Open the file in editor with the checkpoint content
    // This will require updating CoderContext to support loading content directly
    logger.info('[WORKSPACE_HISTORY] Opening version:', filePath, checkpoint.id);
    // For now, just open the file normally
    await openTab(filePath);
    // TODO: Load checkpoint content into editor
  };

  const handleRevert = async (filePath: string, checkpoint: Checkpoint) => {
    if (!chatId || !window.confirm(`Revert ${filePath} to this version?`)) return;

    try {
      const response = await fetch(apiUrl('/api/coder-workspace/file/revert'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          path: filePath,
          snapshot_id: checkpoint.id
        })
      });

      const data = await response.json();

      if (data.success && data.content !== null) {
        // Write the reverted content to disk
        const writeResponse = await fetch(apiUrl('/api/coder-workspace/file'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            path: filePath,
            content: data.content,
            save_snapshot: true
          })
        });

        const writeData = await writeResponse.json();

        if (writeData.success) {
          // Create a checkpoint of the reverted state (AFTER writing)
          // This ensures the latest checkpoint reflects the current state
          await fetch(apiUrl('/api/coder-workspace/file/snapshot'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              path: filePath,
              content: data.content
            })
          });

          logger.info('[WORKSPACE_HISTORY] Reverted file:', filePath);
          // Reload workspace changes
          await loadWorkspaceChanges();
        } else {
          logger.error('[WORKSPACE_HISTORY] Failed to write reverted content:', writeData.error);
        }
      } else {
        logger.error('[WORKSPACE_HISTORY] Failed to revert file:', data.error);
      }
    } catch (err) {
      logger.error('[WORKSPACE_HISTORY] Failed to revert file:', err);
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
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

  const getFileName = (filePath: string) => {
    return filePath.split('/').pop() || filePath;
  };

  const getFileDirectory = (filePath: string) => {
    const parts = filePath.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="workspace-history-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.div
          className="workspace-history-panel"
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="workspace-history-header">
            <div className="workspace-history-title">
              <Icons.Time className="w-5 h-5" />
              <span>Workspace History</span>
            </div>
            <button onClick={onClose} className="close-button">
              <Icons.Close className="w-5 h-5" />
            </button>
          </div>

          {/* Workspace Path */}
          {workspacePath && (
            <div className="workspace-history-path">{workspacePath}</div>
          )}

          {/* Total Workspace Statistics */}
          {(totalStats.linesAdded > 0 || totalStats.linesRemoved > 0) && (
            <div className="workspace-total-stats">
              <span className="stats-label">Total Changes:</span>
              <div className="diff-stats">
                {totalStats.linesAdded > 0 && (
                  <span className="added">+{totalStats.linesAdded}</span>
                )}
                {totalStats.linesRemoved > 0 && (
                  <span className="removed">-{totalStats.linesRemoved}</span>
                )}
              </div>
            </div>
          )}

          {/* Content */}
          <div className="workspace-history-content">
            {isLoading ? (
              <div className="loading-state">
                <div className="spinner"></div>
                <span>Loading workspace history...</span>
              </div>
            ) : files.length === 0 ? (
              <div className="empty-state">
                <Icons.Time className="w-12 h-12 opacity-30" />
                <p>No file changes yet</p>
                <small>Start editing files to see their history here</small>
              </div>
            ) : (
              <div className="file-changes-list">
                {files.map((file) => (
                  <motion.div
                    key={file.filePath}
                    className="file-change-item"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div
                      className="file-change-header"
                      onClick={() => toggleFile(file.filePath)}
                    >
                      <div className="file-change-info">
                        <div className="file-change-name">
                          <span className="chevron">
                            {expandedFiles.has(file.filePath) ? (
                              <Icons.ChevronDown className="w-4 h-4" />
                            ) : (
                              <Icons.ChevronRight className="w-4 h-4" />
                            )}
                          </span>
                          <span className="filename">{getFileName(file.filePath)}</span>
                        </div>
                        {getFileDirectory(file.filePath) && (
                          <div className="file-directory">{getFileDirectory(file.filePath)}</div>
                        )}
                      </div>
                      <div className="file-change-stats">
                        {loadingStats.has(file.filePath) ? (
                          <div className="stats-loading">
                            <div className="mini-spinner"></div>
                          </div>
                        ) : (
                          <>
                            {file.linesAdded !== undefined && file.linesRemoved !== undefined && (
                              <div className="diff-stats">
                                {file.linesAdded > 0 && (
                                  <span className="added">+{file.linesAdded}</span>
                                )}
                                {file.linesRemoved > 0 && (
                                  <span className="removed">-{file.linesRemoved}</span>
                                )}
                              </div>
                            )}
                            <div className="checkpoint-count">
                              {file.checkpointCount} checkpoint{file.checkpointCount !== 1 ? 's' : ''}
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Expanded checkpoints */}
                    <AnimatePresence>
                      {expandedFiles.has(file.filePath) && (
                        <motion.div
                          className="checkpoints-list"
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                        >
                          {fileCheckpoints[file.filePath]?.map((checkpoint, index, arr) => {
                            // Checkpoints are ordered newest first (DESC)
                            // Last item (oldest) is the initial checkpoint
                            const isInitial = index === arr.length - 1;
                            // Count from newest to oldest, excluding the initial one
                            const checkpointNumber = arr.length - index - 1;

                            const label = isInitial
                              ? 'Initial checkpoint'
                              : `Checkpoint #${checkpointNumber}`;

                            return (
                              <div key={checkpoint.id} className="checkpoint-item">
                                <div className="checkpoint-icon">
                                  {isInitial ? (
                                    <Icons.Circle className="w-3 h-3 text-blue-400" />
                                  ) : (
                                    <Icons.Save className="w-3 h-3 text-green-400" />
                                  )}
                                </div>
                                <div className="checkpoint-content">
                                  <div className="checkpoint-header-row">
                                    <div className="checkpoint-type">{label}</div>
                                    {!isInitial && (checkpoint.linesAdded !== undefined || checkpoint.linesRemoved !== undefined) && (
                                      <div className="checkpoint-diff-stats">
                                        {checkpoint.linesAdded !== undefined && checkpoint.linesAdded > 0 && (
                                          <span className="added">+{checkpoint.linesAdded}</span>
                                        )}
                                        {checkpoint.linesRemoved !== undefined && checkpoint.linesRemoved > 0 && (
                                          <span className="removed">-{checkpoint.linesRemoved}</span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                  <div className="checkpoint-time">
                                    {formatTimestamp(checkpoint.timestamp)}
                                  </div>
                                </div>
                                <div className="checkpoint-actions">
                                  <button
                                    onClick={() => handleOpenVersion(file.filePath, checkpoint)}
                                    className="action-button view-button"
                                    title="Open this version"
                                  >
                                    <Icons.Eye className="w-5 h-5" style={{ minWidth: '20px', minHeight: '20px' }} />
                                  </button>
                                  <button
                                    onClick={() => handleRevert(file.filePath, checkpoint)}
                                    className="action-button revert-button"
                                    title="Revert to this version"
                                  >
                                    <Icons.History className="w-5 h-5" style={{ minWidth: '20px', minHeight: '20px' }} />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </motion.div>
                      )}
                    </AnimatePresence>
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
