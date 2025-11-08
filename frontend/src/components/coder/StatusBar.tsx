import React from 'react';
import { Icons } from '../ui/Icons';
import '../../styles/coder/StatusBar.css';

interface StatusBarProps {
  workspace?: string;
  gitBranch?: string;
  isGitRepo?: boolean;
  fileCount?: number;
  unsavedCount?: number;
  modelName?: string;
  errorCount?: number;
  warningCount?: number;
  onWorkspaceClick?: () => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  workspace,
  gitBranch,
  isGitRepo,
  fileCount = 0,
  unsavedCount = 0,
  modelName,
  errorCount = 0,
  warningCount = 0,
  onWorkspaceClick,
}) => {
  return (
    <div className="status-bar">
      <div className="status-bar__left">
        {workspace && (
          <button
            className="status-bar__item status-bar__item--clickable"
            onClick={onWorkspaceClick}
            title="Click to view workspace settings"
          >
            <Icons.FolderOpen className="w-3.5 h-3.5" />
            <span>{workspace}</span>
          </button>
        )}

        {isGitRepo && gitBranch && (
          <div className="status-bar__item" title={`Git branch: ${gitBranch}`}>
            <Icons.GitBranch className="w-3.5 h-3.5" />
            <span>{gitBranch}</span>
          </div>
        )}
      </div>

      <div className="status-bar__center">
        {unsavedCount > 0 && (
          <div className="status-bar__item" title={`${unsavedCount} unsaved file(s)`}>
            <Icons.Circle className="w-2 h-2 fill-yellow-400 text-yellow-400" />
            <span>{unsavedCount} unsaved</span>
          </div>
        )}
      </div>

      <div className="status-bar__right">
        {modelName && (
          <div className="status-bar__item" title="AI Model">
            <Icons.Zap className="w-3.5 h-3.5" />
            <span>{modelName}</span>
          </div>
        )}

        {errorCount > 0 && (
          <div className="status-bar__item status-bar__error" title={`${errorCount} error(s)`}>
            <Icons.Close className="w-3.5 h-3.5" />
            <span>{errorCount}</span>
          </div>
        )}

        {warningCount > 0 && (
          <div className="status-bar__item status-bar__warning" title={`${warningCount} warning(s)`}>
            <Icons.Info className="w-3.5 h-3.5" />
            <span>{warningCount}</span>
          </div>
        )}
      </div>
    </div>
  );
};
