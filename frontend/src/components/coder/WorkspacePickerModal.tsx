import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { apiUrl } from '../../config/api';
import { Icons, getProjectTypeIcon } from '../ui/Icons';
import logger from '../../utils/core/logger';
import '../../styles/components/WorkspacePickerModal.css';

interface WorkspaceHistoryItem {
  path: string;
  name: string;
  type: string;
  fileCount: number;
  lastOpened: string;
  accessCount: number;
  metadata?: Record<string, any>;
}

interface WorkspaceSettings {
  environment: string;
  agentMode: string;
  initGit: boolean;
  autoInstallDeps: boolean;
}

interface WorkspacePickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onWorkspaceSelected: (path: string) => void;
  chatId?: string;
}

export const WorkspacePickerModal: React.FC<WorkspacePickerModalProps> = ({
  isOpen,
  onClose,
  onWorkspaceSelected,
  chatId,
}) => {
  const [workspaceHistory, setWorkspaceHistory] = useState<WorkspaceHistoryItem[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState('');
  const [error, setError] = useState('');
  const [isPickingFolder, setIsPickingFolder] = useState(false);

  // New workspace creation state
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceParent, setNewWorkspaceParent] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Workspace settings
  const [settings, setSettings] = useState<WorkspaceSettings>({
    environment: 'Auto-detect',
    agentMode: 'Full Autonomy',
    initGit: false,
    autoInstallDeps: false,
  });

  // Load workspace history
  useEffect(() => {
    if (isOpen) {
      loadWorkspaceHistory();
    }
  }, [isOpen]);

  const loadWorkspaceHistory = async () => {
    try {
      const response = await fetch(apiUrl('/api/coder-workspace/history?limit=10'));
      const data = await response.json();

      if (data.success) {
        setWorkspaceHistory(data.history);
        logger.info('[WORKSPACE_PICKER] Loaded workspace history', { count: data.history.length });
      } else {
        logger.error('[WORKSPACE_PICKER] Failed to load history:', data.error);
      }
    } catch (err) {
      logger.error('[WORKSPACE_PICKER] Failed to load workspace history:', err);
    }
  };

  const handleDeleteHistoryItem = async (path: string, e: React.MouseEvent) => {
    e.stopPropagation();

    try {
      const response = await fetch(apiUrl('/api/coder-workspace/history'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_path: path }),
      });

      const data = await response.json();

      if (data.success) {
        setWorkspaceHistory(prev => prev.filter(item => item.path !== path));
        if (selectedWorkspace === path) {
          setSelectedWorkspace(null);
        }
        logger.info('[WORKSPACE_PICKER] Removed from history:', path);
      }
    } catch (err) {
      logger.error('[WORKSPACE_PICKER] Failed to delete history item:', err);
    }
  };

  const handleQuickStart = async () => {
    if (!chatId) {
      setError('Chat ID is required for quick start');
      return;
    }

    try {
      setError('');

      const response = await fetch(apiUrl('/api/coder-workspace/quick-start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId }),
      });

      const data = await response.json();

      if (data.success && data.workspace_path) {
        onWorkspaceSelected(data.workspace_path);
        onClose();
      } else {
        setError(data.error || 'Failed to create quick start workspace');
      }
    } catch (err) {
      logger.error('[WORKSPACE_PICKER] Failed to create quick start workspace:', err);
      setError('Failed to create quick start workspace');
    }
  };

  const handleOpenFolderPicker = async () => {
    try {
      setError('');
      setIsPickingFolder(true);

      const response = await fetch(apiUrl('/api/folder-picker/select'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();

      if (data.success && data.path) {
        setManualPath(data.path);
        setSelectedWorkspace(null); // Clear history selection when manually picking
        logger.info('[WORKSPACE_PICKER] Folder selected:', data.path);
      } else {
        // User cancelled - this is normal, don't show error
        logger.info('[WORKSPACE_PICKER] Folder selection cancelled');
      }
    } catch (err) {
      // Only show error for actual failures, not user cancellation
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (!errorMsg.includes('400')) {
        logger.error('[WORKSPACE_PICKER] Failed to open folder picker:', err);
        setError('Failed to open folder picker');
      } else {
        logger.info('[WORKSPACE_PICKER] User cancelled folder selection');
      }
    } finally {
      setIsPickingFolder(false);
    }
  };

  const handleSelectParentDirectory = async () => {
    try {
      setError('');
      setIsPickingFolder(true);

      const response = await fetch(apiUrl('/api/folder-picker/select'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();

      if (data.success && data.path) {
        setNewWorkspaceParent(data.path);
        logger.info('[WORKSPACE_PICKER] Parent directory selected:', data.path);
      } else {
        logger.info('[WORKSPACE_PICKER] Parent selection cancelled');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (!errorMsg.includes('400')) {
        logger.error('[WORKSPACE_PICKER] Failed to select parent directory:', err);
        setError('Failed to select parent directory');
      } else {
        logger.info('[WORKSPACE_PICKER] User cancelled parent selection');
      }
    } finally {
      setIsPickingFolder(false);
    }
  };

  const handleCreateNewWorkspace = async () => {
    if (!newWorkspaceName.trim()) {
      setError('Please enter a workspace name');
      return;
    }

    if (!newWorkspaceParent.trim()) {
      setError('Please select a parent directory');
      return;
    }

    try {
      setError('');
      setIsCreating(true);

      // Create the new workspace folder
      const createResponse = await fetch(apiUrl('/api/coder-workspace/create-new-workspace'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parent_path: newWorkspaceParent,
          workspace_name: newWorkspaceName.trim(),
        }),
      });

      const createData = await createResponse.json();

      if (createData.success && createData.workspace_path) {
        logger.info('[WORKSPACE_PICKER] Created new workspace:', createData.workspace_path);

        // Now set it as the workspace for this chat (if chat_id exists)
        if (chatId) {
          await saveWorkspaceSettings(createData.workspace_path);
        }

        // Select the newly created workspace
        onWorkspaceSelected(createData.workspace_path);
        onClose();
      } else {
        setError(createData.error || 'Failed to create workspace');
      }
    } catch (err) {
      logger.error('[WORKSPACE_PICKER] Failed to create new workspace:', err);
      setError('Failed to create new workspace');
    } finally {
      setIsCreating(false);
    }
  };

  const handleStartCreatingNew = () => {
    setIsCreatingNew(true);
    setNewWorkspaceName('');
    setNewWorkspaceParent('');
    setError('');
  };

  const handleCancelCreating = () => {
    setIsCreatingNew(false);
    setNewWorkspaceName('');
    setNewWorkspaceParent('');
    setError('');
  };

  const handleValidateAndOpen = async (path: string) => {
    try {
      setError('');

      const response = await fetch(apiUrl('/api/coder-workspace/validate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });

      const data = await response.json();

      if (data.success && data.valid) {
        // Save settings if path is provided
        if (selectedWorkspace || manualPath) {
          await saveWorkspaceSettings(path);
        }
        onWorkspaceSelected(path);
        onClose();
      } else {
        setError(data.reason || 'Invalid workspace path');
      }
    } catch (err) {
      logger.error('[WORKSPACE_PICKER] Failed to validate path:', err);
      setError('Failed to validate workspace path');
    }
  };

  const saveWorkspaceSettings = async (workspacePath: string) => {
    try {
      await fetch(apiUrl('/api/coder-workspace/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_path: workspacePath,
          settings: settings,
        }),
      });
    } catch (err) {
      logger.error('[WORKSPACE_PICKER] Failed to save settings:', err);
    }
  };

  const handleOpenWorkspace = () => {
    const pathToOpen = selectedWorkspace || manualPath;
    if (pathToOpen) {
      handleValidateAndOpen(pathToOpen);
    }
  };

  const formatRelativeTime = (timestamp: string): string => {
    const now = new Date();
    const then = new Date(timestamp);
    const diffMs = now.getTime() - then.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return then.toLocaleDateString();
  };

  if (!isOpen) return null;

  return (
    <div className="workspace-modal-backdrop" onClick={onClose}>
      <motion.div
        className="workspace-modal"
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="workspace-modal-header">
          <div className="workspace-modal-title-group">
            <Icons.FolderOpen className="workspace-modal-icon" />
            <h2 className="workspace-modal-title">Select Coding Workspace</h2>
          </div>
          <button className="workspace-modal-close" onClick={onClose}>
            <Icons.Close className="w-5 h-5" />
          </button>
        </div>

        {/* Error Banner */}
        <AnimatePresence>
          {error && (
            <motion.div
              className="workspace-error-banner"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
            >
              <Icons.Close className="w-4 h-4 text-red-400" />
              <span>{error}</span>
              <button onClick={() => setError('')} className="workspace-error-close">
                <Icons.Close className="w-3 h-3" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Modal Body - ALL SECTIONS VISIBLE */}
        <div className="workspace-modal-body">
          {/* Recent Workspaces Section */}
          <div className="workspace-section">
            <div className="workspace-section-title">Recent Workspaces</div>
            {workspaceHistory.length === 0 ? (
              <div className="workspace-empty-hint">
                <Icons.History className="w-8 h-8 opacity-50 mb-2" />
                <p className="text-sm text-bolt-elements-textTertiary">No recent workspaces</p>
              </div>
            ) : (
              <div className="workspace-list">
                {workspaceHistory.map((item) => {
                  const ProjectIcon = getProjectTypeIcon(item.type);
                  const isSelected = selectedWorkspace === item.path;

                  return (
                    <motion.div
                      key={item.path}
                      className={`workspace-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => {
                        setSelectedWorkspace(item.path);
                        setManualPath(''); // Clear manual path when selecting from history
                      }}
                      whileHover={{ x: 4 }}
                      transition={{ duration: 0.15 }}
                    >
                      <div className="workspace-item-icon">
                        <ProjectIcon className="w-5 h-5" />
                      </div>
                      <div className="workspace-item-info">
                        <div className="workspace-item-name">{item.name}</div>
                        <div className="workspace-item-path">{item.path}</div>
                        <div className="workspace-item-stats">
                          <span className="workspace-stat">
                            <Icons.File className="w-3 h-3" />
                            {item.fileCount} files
                          </span>
                          <span className="workspace-stat">{item.type}</span>
                          <span className="workspace-stat">
                            <Icons.Clock className="w-3 h-3" />
                            {formatRelativeTime(item.lastOpened)}
                          </span>
                        </div>
                      </div>
                      <button
                        className="workspace-item-delete"
                        onClick={(e) => handleDeleteHistoryItem(item.path, e)}
                        title="Remove from history"
                      >
                        <Icons.Delete className="w-4 h-4" />
                      </button>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Create New Workspace Section */}
          <div className="workspace-section">
            <div className="workspace-section-title">Create New Workspace</div>

            {!isCreatingNew ? (
              <div className="workspace-options-grid">
                <div className="workspace-option-card" onClick={handleQuickStart}>
                  <div className="workspace-option-icon">
                    <Icons.Zap className="w-8 h-8" />
                  </div>
                  <div className="workspace-option-title">Quick Start</div>
                  <div className="workspace-option-desc">Temporary workspace</div>
                </div>
                <div className="workspace-option-card" onClick={handleStartCreatingNew}>
                  <div className="workspace-option-icon">
                    <Icons.NewFolder className="w-8 h-8" />
                  </div>
                  <div className="workspace-option-title">New Folder</div>
                  <div className="workspace-option-desc">Create new workspace</div>
                </div>
              </div>
            ) : (
              <div className="workspace-creation-form">
                <div className="workspace-form-group">
                  <label className="workspace-form-label">Workspace Name</label>
                  <input
                    type="text"
                    className="workspace-form-input"
                    placeholder="e.g., my-project"
                    value={newWorkspaceName}
                    onChange={(e) => setNewWorkspaceName(e.target.value)}
                    autoFocus
                  />
                </div>

                <div className="workspace-form-group">
                  <label className="workspace-form-label">Parent Directory</label>
                  <div className="workspace-form-input-group">
                    <input
                      type="text"
                      className="workspace-form-input"
                      placeholder="Select where to create the workspace..."
                      value={newWorkspaceParent}
                      readOnly
                    />
                    <button
                      className="workspace-form-browse-btn"
                      onClick={handleSelectParentDirectory}
                      disabled={isPickingFolder}
                    >
                      <Icons.FolderOpen className="w-4 h-4" />
                      {isPickingFolder ? 'Selecting...' : 'Browse'}
                    </button>
                  </div>
                </div>

                {newWorkspaceName && newWorkspaceParent && (
                  <div className="workspace-form-preview">
                    <Icons.Info className="w-4 h-4 text-blue-400" />
                    <div>
                      <div className="text-xs text-bolt-elements-textSecondary">Will be created at:</div>
                      <div className="text-sm font-mono text-bolt-elements-textPrimary">
                        {newWorkspaceParent}/{newWorkspaceName}
                      </div>
                    </div>
                  </div>
                )}

                <div className="workspace-form-actions">
                  <button
                    className="workspace-btn workspace-btn-cancel"
                    onClick={handleCancelCreating}
                    disabled={isCreating}
                  >
                    Cancel
                  </button>
                  <button
                    className="workspace-btn workspace-btn-primary"
                    onClick={handleCreateNewWorkspace}
                    disabled={!newWorkspaceName.trim() || !newWorkspaceParent.trim() || isCreating}
                  >
                    {isCreating ? (
                      <>
                        <div className="spinner" style={{ width: '16px', height: '16px', borderWidth: '2px' }}></div>
                        Creating...
                      </>
                    ) : (
                      <>
                        <Icons.NewFolder className="w-4 h-4" />
                        Create Workspace
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Open Existing Folder Section */}
          <div className="workspace-section">
            <div className="workspace-section-title">Open Existing Folder</div>
            <div className="workspace-folder-selector">
              {isPickingFolder ? (
                <div className="workspace-folder-loading">
                  <div className="spinner" style={{ width: '32px', height: '32px' }}></div>
                  <div className="workspace-folder-loading-text">Waiting for folder selection...</div>
                </div>
              ) : (
                <>
                  <div className="workspace-folder-input-group">
                    <input
                      type="text"
                      className="workspace-folder-input"
                      placeholder="Enter or paste folder path..."
                      value={manualPath}
                      onChange={(e) => {
                        setManualPath(e.target.value);
                        setSelectedWorkspace(null); // Clear history selection
                      }}
                    />
                    <button
                      className="workspace-folder-browse-btn"
                      onClick={handleOpenFolderPicker}
                      title="Browse for folder"
                    >
                      <Icons.FolderOpen className="w-5 h-5" />
                      Browse
                    </button>
                  </div>
                  {manualPath && (
                    <div className="workspace-folder-hint">
                      <Icons.Info className="w-4 h-4 text-blue-400" />
                      <span>Path ready to open: {manualPath}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Workspace Settings Section */}
          <div className="workspace-section">
            <div className="workspace-section-title">Workspace Settings</div>
            <div className="workspace-settings-grid">
              <div className="workspace-setting-group">
                <label className="workspace-setting-label">Environment</label>
                <select
                  className="workspace-setting-select"
                  value={settings.environment}
                  onChange={(e) => setSettings({ ...settings, environment: e.target.value })}
                >
                  <option>Auto-detect</option>
                  <option>Node.js</option>
                  <option>Python</option>
                  <option>Go</option>
                  <option>Rust</option>
                  <option>Mixed</option>
                </select>
              </div>
              <div className="workspace-setting-group">
                <label className="workspace-setting-label">Agent Mode</label>
                <select
                  className="workspace-setting-select"
                  value={settings.agentMode}
                  onChange={(e) => setSettings({ ...settings, agentMode: e.target.value })}
                >
                  <option>Full Autonomy</option>
                  <option>Guided</option>
                  <option>Review Required</option>
                </select>
              </div>
              <label className="workspace-checkbox-group">
                <input
                  type="checkbox"
                  checked={settings.initGit}
                  onChange={(e) => setSettings({ ...settings, initGit: e.target.checked })}
                />
                <span>Initialize Git repository</span>
              </label>
              <label className="workspace-checkbox-group">
                <input
                  type="checkbox"
                  checked={settings.autoInstallDeps}
                  onChange={(e) => setSettings({ ...settings, autoInstallDeps: e.target.checked })}
                />
                <span>Auto-install dependencies</span>
              </label>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="workspace-modal-footer">
          <button className="workspace-btn workspace-btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="workspace-btn workspace-btn-primary"
            onClick={handleOpenWorkspace}
            disabled={!selectedWorkspace && !manualPath}
          >
            <Icons.FolderOpen className="w-4 h-4" />
            Open Workspace
          </button>
        </div>
      </motion.div>
    </div>
  );
};
