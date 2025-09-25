import React, { useEffect, useMemo, useState } from 'react';
import '../styles/sections/FilesWindow.css';
import { FileBrowserNode, FileBrowserNodeType, useLiveFileBrowser } from '../hooks/files/useLiveFileBrowser';

interface FilesWindowProps {
  isOpen: boolean;
}

const formatBytes = (bytes?: number): string => {
  if (bytes === undefined || bytes === null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[exponent]}`;
};

const formatTimestamp = (isoString?: string): string => {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
};

const normaliseName = (node: FileBrowserNode): string => {
  if (!node.path) return 'Workspace';
  return node.name;
};

const buildBreadcrumbs = (path: string): { label: string; path: string }[] => {
  if (!path) return [{ label: 'Workspace', path: '' }];
  const parts = path.split('/');
  const crumbs: { label: string; path: string }[] = [{ label: 'Workspace', path: '' }];
  parts.reduce((acc, part) => {
    const next = acc ? `${acc}/${part}` : part;
    crumbs.push({ label: part, path: next });
    return next;
  }, '');
  return crumbs;
};

const FilesWindow: React.FC<FilesWindowProps> = ({ isOpen }) => {
  const {
    root,
    loading,
    error,
    clearError,
    selectedPath,
    selectedNode,
    expanded,
    toggleExpand,
    selectPath,
    refresh,
    createNode,
    renameNode,
    deleteNode,
    pendingOperations
  } = useLiveFileBrowser(isOpen);

  const [pendingCreation, setPendingCreation] = useState<FileBrowserNodeType | null>(null);
  const [creationName, setCreationName] = useState('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<FileBrowserNode | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setPendingCreation(null);
      setCreationName('');
      setRenamingPath(null);
      setRenameValue('');
      setDeleteTarget(null);
    }
  }, [isOpen]);

  const currentDirectory = selectedNode && selectedNode.type === 'directory' ? selectedNode : root;
  const directoryPath = currentDirectory?.path || '';
  const items = useMemo(() => {
    if (!currentDirectory || currentDirectory.type !== 'directory') return [] as FileBrowserNode[];
    return currentDirectory.children ?? [];
  }, [currentDirectory]);

  const breadcrumbs = buildBreadcrumbs(directoryPath);

  const handleStartCreate = (type: FileBrowserNodeType) => {
    setPendingCreation(type);
    setCreationName('');
    setRenamingPath(null);
  };

  const handleCreateSubmit = async () => {
    if (!pendingCreation) return;
    const trimmed = creationName.trim();
    if (!trimmed) return;

    const previousCreationType = pendingCreation;
    const previousCreationName = creationName;

    setPendingCreation(null);
    setCreationName('');

    const result = await createNode(directoryPath, trimmed, previousCreationType);
    if (!result.success) {
      setPendingCreation(previousCreationType);
      setCreationName(previousCreationName);
    }
  };

  const handleRenameSubmit = async () => {
    if (!renamingPath) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;

    const previousRenamingPath = renamingPath;
    const previousRenameValue = renameValue;

    setRenamingPath(null);
    setRenameValue('');

    const result = await renameNode(previousRenamingPath, trimmed);
    if (!result.success) {
      setRenamingPath(previousRenamingPath);
      setRenameValue(previousRenameValue);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;

    const previousDeleteTarget = deleteTarget;

    setDeleteTarget(null);

    const result = await deleteNode(previousDeleteTarget.path);
    if (!result.success) {
      setDeleteTarget(previousDeleteTarget);
    }
  };

  const renderTree = (node: FileBrowserNode, depth = 0) => {
    if (node.type !== 'directory') return null;
    const isRoot = node.path === '';
    const isExpanded = isRoot ? true : expanded.has(node.path);
    const children = (node.children || []).filter(child => child.type === 'directory');
    const key = node.path || 'root';
    const displayName = normaliseName(node);

    return (
      <div key={key} className="files-tree-node" style={{ paddingLeft: `${depth * 16}px` }}>
        <div
          className={`files-tree-row ${selectedPath === node.path ? 'active' : ''}`}
          onClick={() => selectPath(node.path)}
        >
          <button
            className={`files-tree-toggle ${children.length > 0 ? '' : 'empty'} ${isExpanded ? 'open' : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              if (!isRoot && children.length > 0) {
                toggleExpand(node.path);
              }
            }}
            aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
            disabled={isRoot || children.length === 0}
          />
          <span className="files-tree-label">{displayName}</span>
        </div>
        {isExpanded && children.length > 0 && (
          <div className="files-tree-children">
            {children.map(child => renderTree(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const creationPlaceholder = pendingCreation === 'directory' ? 'New folder name…' : 'New file name…';

  return (
    <div className="files-window">
      <div className="files-header">
        <div>
          <h2>Workspace Files</h2>
          <p>Manage everything stored in <span className="files-highlight">data/files</span>.</p>
        </div>
        <div className="files-actions">
          <button
            className="files-action-btn"
            onClick={() => handleStartCreate('directory')}
          >
            <span className="icon">📁</span>
            New Folder
          </button>
          <button
            className="files-action-btn"
            onClick={() => handleStartCreate('file')}
          >
            <span className="icon">📄</span>
            New File
          </button>
          <button
            className="files-action-btn subtle"
            onClick={refresh}
            disabled={loading}
          >
            <span className="icon">↻</span>
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="files-banner error">
          <span>{error}</span>
          <button onClick={clearError} aria-label="Dismiss error">×</button>
        </div>
      )}

      <div className="files-body">
        <div className="files-tree">
          {root ? renderTree(root) : (
            <div className="files-empty-tree">Workspace initialising…</div>
          )}
        </div>

        <div className="files-content">
          <div className="files-breadcrumbs">
            {breadcrumbs.map((crumb, index) => (
              <React.Fragment key={crumb.path || 'root'}>
                {index > 0 && <span className="separator">›</span>}
                <button
                  className={`crumb ${crumb.path === directoryPath ? 'current' : ''}`}
                  onClick={() => selectPath(crumb.path)}
                >
                  {crumb.label}
                </button>
              </React.Fragment>
            ))}
          </div>

          <div className="files-table">
            <div className="files-table-header">
              <div className="col name">Name</div>
              <div className="col type">Type</div>
              <div className="col size">Size</div>
              <div className="col modified">Modified</div>
              <div className="col actions" aria-hidden="true"></div>
            </div>
            <div className="files-table-body">
              {pendingCreation && (
                <div className="files-row creating">
                  <div className="col name">
                    <input
                      value={creationName}
                      placeholder={creationPlaceholder}
                      autoFocus
                      onChange={(e) => setCreationName(e.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          handleCreateSubmit();
                        } else if (event.key === 'Escape') {
                          setPendingCreation(null);
                          setCreationName('');
                        }
                      }}
                    />
                  </div>
                  <div className="col type">{pendingCreation === 'directory' ? 'Folder' : 'File'}</div>
                  <div className="col size">—</div>
                  <div className="col modified">—</div>
                  <div className="col actions">
                    <button className="primary" onClick={handleCreateSubmit}>Create</button>
                    <button onClick={() => { setPendingCreation(null); setCreationName(''); }}>Cancel</button>
                  </div>
                </div>
              )}

              {items.length === 0 && !pendingCreation && (
                <div className="files-empty">
                  {loading ? (
                    <div className="files-loading">
                      <span className="spinner" />
                      <span>Loading…</span>
                    </div>
                  ) : (
                    <div>
                      <h4>This folder is empty</h4>
                      <p>Create files or folders to get started.</p>
                    </div>
                  )}
                </div>
              )}

              {items.map((item) => {
                const isRenaming = renamingPath === item.path;
                const hasPendingOperation = pendingOperations.some(op =>
                  op.data.path === item.path ||
                  (op.type === 'create' && op.data.parentPath === directoryPath && op.data.name === item.name)
                );
                return (
                  <div key={item.path} className={`files-row ${isRenaming ? 'editing' : ''} ${hasPendingOperation ? 'pending-operation' : ''}`}>
                    <div className="col name" onClick={() => item.type === 'directory' && selectPath(item.path)}>
                      <div className={`cell-content ${item.type}`}>
                        {isRenaming ? (
                          <input
                            value={renameValue}
                            autoFocus
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                handleRenameSubmit();
                              } else if (event.key === 'Escape') {
                                setRenamingPath(null);
                              }
                            }}
                          />
                        ) : (
                          <>
                            <span className="icon">{item.type === 'directory' ? '📁' : '📄'}</span>
                            <span>{item.name}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="col type">{item.type === 'directory' ? 'Folder' : 'File'}</div>
                    <div className="col size">{item.type === 'directory' ? `${item.item_count ?? 0} item${(item.item_count ?? 0) === 1 ? '' : 's'}` : formatBytes(item.size)}</div>
                    <div className="col modified">{formatTimestamp(item.modified)}</div>
                    <div className="col actions">
                      {isRenaming ? (
                        <>
                          <button className="primary" onClick={handleRenameSubmit}>Save</button>
                          <button onClick={() => setRenamingPath(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => { setRenamingPath(item.path); setRenameValue(item.name); setPendingCreation(null); }}>Rename</button>
                          <button className="destructive" onClick={() => setDeleteTarget(item)}>Delete</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {deleteTarget && (
        <div className="files-delete-confirmation">
          <div className="card">
            <h4>Delete “{deleteTarget.name}”?</h4>
            <p>This will permanently remove the {deleteTarget.type === 'directory' ? 'folder and its contents' : 'file'}.</p>
            <div className="actions">
              <button className="destructive" onClick={handleDeleteConfirm}>Delete</button>
              <button onClick={() => setDeleteTarget(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FilesWindow;
