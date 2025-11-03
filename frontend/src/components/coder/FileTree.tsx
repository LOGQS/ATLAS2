import React, { useMemo, useCallback, ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import AutoSizer from 'react-virtualized-auto-sizer';
import { List } from 'react-window';
import { useCoderContext } from '../../contexts/CoderContext';
import { apiUrl } from '../../config/api';
import { PhosphorIcon } from '../ui/PhosphorIcons';
import { getFileIcon } from '../ui/Icons';

const NODE_PADDING_LEFT = 8;
const ITEM_HEIGHT = 28; // Fixed height for each tree item

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  modified: string;
  size?: number;
  children?: FileNode[];
  item_count?: number;
  canLoadDeeper?: boolean; // True if folder is at max depth but has more content
}

interface FlattenedItem {
  node: FileNode;
  depth: number;
  index: number;
}

type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

interface RowItemData {
  chatId?: string;
  flattenedItems: FlattenedItem[];
  expandedFolders: Set<string>;
  selectedFile: string | undefined;
  activeTabPath: string | undefined;
  unsavedFiles: Set<string>;
  renamingPath: string | null;
  renameValue: string;
  multiSelectedFiles: Set<string>;
  isGitRepo: boolean;
  gitStatus: Record<string, GitFileStatus>;
  toggleMultiSelect: (path: string) => void;
  clearMultiSelect: () => void;
  toggleFolder: (path: string) => void;
  loadDeeper: (folderPath: string, currentDepth: number) => Promise<void>;
  selectNode: (path: string) => void;
  selectFile: (path: string) => Promise<void>;
  handleRenameKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleRenameBlur: () => void;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  setRenameValue: React.Dispatch<React.SetStateAction<string>>;
}

type ListRowProps = RowItemData & {
  index: number;
  style: React.CSSProperties;
  ariaAttributes?: Record<string, unknown>;
};

interface NodeButtonProps {
  depth: number;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}

function NodeButton({ depth, icon, onClick, className, children }: NodeButtonProps) {
  return (
    <button
      className={`flex items-center gap-1.5 w-full pr-2 border-2 border-transparent text-sm py-0.5 ${className || ''}`}
      style={{ paddingLeft: `${6 + depth * NODE_PADDING_LEFT}px` }}
      onClick={(e) => onClick?.(e)}
    >
      <div className="shrink-0" style={{ transform: 'scale(1.2)' }}>
        {icon}
      </div>
      <div className="truncate w-full text-left">{children}</div>
    </button>
  );
}

interface ContextMenuItemProps {
  onSelect?: () => void;
  children: ReactNode;
}

function ContextMenuItem({ onSelect, children }: ContextMenuItemProps) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className="flex items-center gap-2 px-2 py-1.5 outline-0 text-sm cursor-pointer text-bolt-elements-item-contentDefault hover:text-bolt-elements-item-contentActive hover:bg-bolt-elements-item-backgroundActive rounded-md"
    >
      <span className="shrink-0 w-4 h-4"></span>
      <span>{children}</span>
    </ContextMenu.Item>
  );
}

interface FileContextMenuProps {
  fullPath: string;
  isFolder: boolean;
  chatId?: string;
  children: ReactNode;
}

function FileContextMenu({ fullPath, isFolder, chatId, children }: FileContextMenuProps) {
  const { createFile, createFolder, deleteNode, renameNode } = useCoderContext();

  const handleCreateFile = async () => {
    const fileName = prompt('Enter file name:');
    if (!fileName) return;
    await createFile(fullPath, fileName);
  };

  const handleCreateFolder = async () => {
    const folderName = prompt('Enter folder name:');
    if (!folderName) return;
    await createFolder(fullPath, folderName);
  };

  const handleDelete = async () => {
    const confirmMsg = `Are you sure you want to delete ${isFolder ? 'folder' : 'file'}?`;
    if (!window.confirm(confirmMsg)) return;
    await deleteNode(fullPath, isFolder);
  };

  const handleRename = async () => {
    const currentName = fullPath.split('/').pop() || '';
    const newName = prompt(`Rename to:`, currentName);
    if (!newName || newName === currentName) return;
    await renameNode(fullPath, newName);
  };

  const handleRevealInExplorer = async () => {
    if (!chatId) {
      console.error('No chatId available for revealing file in explorer');
      return;
    }

    try {
      const response = await fetch(apiUrl('/api/coder-workspace/reveal-in-explorer'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          file_path: fullPath,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `Failed to reveal file in explorer: ${response.status} ${response.statusText} - ${errorText}`
        );
        return;
      }

      const data = await response.json();
      if (!data.success) {
        console.error('Failed to reveal file in explorer:', data.error);
      }
    } catch (error) {
      console.error('Error revealing file in explorer:', error);
    }
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="border border-bolt-elements-borderColor rounded-md bg-bolt-elements-background-depth-1 w-56 p-1"
          style={{ zIndex: 9999 }}
        >
          {isFolder && (
            <>
              <ContextMenuItem onSelect={handleCreateFile}>
                <div className="flex items-center gap-2">
                  <PhosphorIcon.FilePlus className="w-4 h-4" />
                  New File
                </div>
              </ContextMenuItem>
              <ContextMenuItem onSelect={handleCreateFolder}>
                <div className="flex items-center gap-2">
                  <PhosphorIcon.FolderPlus className="w-4 h-4" />
                  New Folder
                </div>
              </ContextMenuItem>
              <div className="h-px bg-bolt-elements-borderColor my-1" />
            </>
          )}
          <ContextMenuItem onSelect={handleRename}>
            <div className="flex items-center gap-2">
              Rename
            </div>
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleRevealInExplorer}>
            <div className="flex items-center gap-2">
              <PhosphorIcon.FolderOpen className="w-4 h-4" />
              Reveal in File Explorer
            </div>
          </ContextMenuItem>
          <div className="h-px bg-bolt-elements-borderColor my-1" />
          <ContextMenuItem onSelect={handleDelete}>
            <div className="flex items-center gap-2 text-red-500">
              <PhosphorIcon.Trash className="w-4 h-4" />
              Delete {isFolder ? 'Folder' : 'File'}
            </div>
          </ContextMenuItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * Flatten the file tree into a linear list of visible items
 * based on which folders are expanded
 */
function flattenTree(
  node: FileNode | null,
  expandedFolders: Set<string>,
  depth: number = 0,
  result: FlattenedItem[] = [],
  isRoot: boolean = true
): FlattenedItem[] {
  if (!node) return result;

  if (!isRoot) {
    result.push({ node, depth, index: result.length });
  }

  if (node.type === 'directory' && node.children) {
    const nextDepth = isRoot ? depth : depth + 1;
    if (isRoot || expandedFolders.has(node.path)) {
      node.children.forEach(child => {
        flattenTree(child, expandedFolders, nextDepth, result, false);
      });
    }
  }

  return result;
}

export const FileTree: React.FC = () => {
  const {
    chatId,
    fileTree,
    expandedFolders,
    selectedFile,
    activeTabPath,
    unsavedFiles,
    creatingNode,
    multiSelectedFiles,
    isGitRepo,
    gitStatus,
    toggleFolder,
    loadDeeper,
    selectFile,
    selectNode,
    toggleMultiSelect,
    clearMultiSelect,
    deleteMultipleNodes,
    cancelCreating,
    finishCreating,
    deleteNode,
    renameNode,
  } = useCoderContext();

  const [newItemName, setNewItemName] = React.useState('');
  const [renamingPath, setRenamingPath] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const renameInputRef = React.useRef<HTMLInputElement>(null);

  // Focus input when creating starts and reset name when creating ends
  React.useEffect(() => {
    if (creatingNode) {
      setNewItemName('');
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [creatingNode]);

  // Focus rename input when renaming starts
  React.useEffect(() => {
    if (renamingPath) {
      setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 50);
    }
  }, [renamingPath]);


  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishCreating(newItemName);
      setNewItemName('');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelCreating();
      setNewItemName('');
    }
  }, [newItemName, finishCreating, cancelCreating]);

  const handleBlur = useCallback(() => {
    // Only cancel if there's no name - if user clicked outside with a name, create it
    if (newItemName.trim()) {
      finishCreating(newItemName);
    } else {
      cancelCreating();
    }
    setNewItemName('');
  }, [newItemName, finishCreating, cancelCreating]);

  const handleDeleteSelected = useCallback(() => {
    if (!fileTree) return;

    // Check if we're deleting multiple files
    if (multiSelectedFiles.size > 0) {
      const confirmMsg = `Are you sure you want to delete ${multiSelectedFiles.size} selected items?`;
      if (window.confirm(confirmMsg)) {
        deleteMultipleNodes(Array.from(multiSelectedFiles));
      }
      return;
    }

    // Single file deletion
    if (!selectedFile) return;

    const findNode = (node: FileNode, path: string): FileNode | null => {
      if (node.path === path) return node;
      if (node.children) {
        for (const child of node.children) {
          const found = findNode(child, path);
          if (found) return found;
        }
      }
      return null;
    };

    const node = findNode(fileTree, selectedFile);
    if (!node) return;

    const confirmMsg = `Are you sure you want to delete ${node.type === 'directory' ? 'folder' : 'file'} "${node.name}"?`;
    if (window.confirm(confirmMsg)) {
      deleteNode(selectedFile, node.type === 'directory');
    }
  }, [selectedFile, fileTree, multiSelectedFiles, deleteNode, deleteMultipleNodes]);

  const handleRenameSelected = useCallback(() => {
    if (!selectedFile || !fileTree) return;

    const findNode = (node: FileNode, path: string): FileNode | null => {
      if (node.path === path) return node;
      if (node.children) {
        for (const child of node.children) {
          const found = findNode(child, path);
          if (found) return found;
        }
      }
      return null;
    };

    const node = findNode(fileTree, selectedFile);
    if (!node) return;

    setRenamingPath(selectedFile);
    setRenameValue(node.name);
  }, [selectedFile, fileTree]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (renamingPath && renameValue.trim()) {
        renameNode(renamingPath, renameValue.trim());
      }
      setRenamingPath(null);
      setRenameValue('');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setRenamingPath(null);
      setRenameValue('');
    }
  }, [renamingPath, renameValue, renameNode]);

  const handleRenameBlur = useCallback(() => {
    if (renamingPath && renameValue.trim()) {
      renameNode(renamingPath, renameValue.trim());
    }
    setRenamingPath(null);
    setRenameValue('');
  }, [renamingPath, renameValue, renameNode]);

  // Keyboard shortcuts: Delete and F2 (must be after callback definitions)
  React.useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Only handle if not in an input
      if (e.target instanceof HTMLInputElement) return;

      if (e.key === 'Delete' && selectedFile) {
        e.preventDefault();
        handleDeleteSelected();
      } else if (e.key === 'F2' && selectedFile) {
        e.preventDefault();
        handleRenameSelected();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile]);

  const filterNode = useCallback((node: FileNode, query: string): FileNode | null => {
    if (!query) return node;

    const lowerQuery = query.toLowerCase();
    const matches = node.name.toLowerCase().includes(lowerQuery);

    if (node.type === 'directory' && node.children) {
      const filteredChildren = node.children
        .map(child => filterNode(child, query))
        .filter((child): child is FileNode => child !== null);

      if (filteredChildren.length > 0 || matches) {
        return { ...node, children: filteredChildren, item_count: filteredChildren.length };
      }
    }

    return matches ? node : null;
  }, []);

  const filteredTree = useMemo(() => {
    return fileTree;
  }, [fileTree]);

  // Flatten the tree into a linear list for virtualization
  const flattenedItems = useMemo(() => {
    return flattenTree(filteredTree, expandedFolders);
  }, [filteredTree, expandedFolders]);

  const listData = useMemo<RowItemData>(() => ({
    chatId,
    flattenedItems,
    expandedFolders,
    selectedFile,
    activeTabPath,
    unsavedFiles,
    renamingPath,
    renameValue,
    multiSelectedFiles,
    isGitRepo,
    gitStatus,
    toggleMultiSelect,
    clearMultiSelect,
    toggleFolder,
    loadDeeper,
    selectNode,
    selectFile,
    handleRenameKeyDown,
    handleRenameBlur,
    renameInputRef,
    setRenameValue,
  }), [
    chatId,
    flattenedItems,
    expandedFolders,
    selectedFile,
    activeTabPath,
    unsavedFiles,
    renamingPath,
    renameValue,
    multiSelectedFiles,
    isGitRepo,
    gitStatus,
    toggleMultiSelect,
    clearMultiSelect,
    toggleFolder,
    loadDeeper,
    selectNode,
    selectFile,
    handleRenameKeyDown,
    handleRenameBlur,
    renameInputRef,
    setRenameValue,
  ]);

  const Row = useCallback((props: ListRowProps) => {
    const {
      index,
      style,
      ariaAttributes,
      chatId,
      flattenedItems,
      expandedFolders,
      selectedFile,
      activeTabPath,
      unsavedFiles,
      renamingPath,
      renameValue,
      multiSelectedFiles,
      isGitRepo,
      gitStatus,
      toggleMultiSelect,
      clearMultiSelect,
      toggleFolder,
      loadDeeper,
      selectNode,
      selectFile,
      handleRenameKeyDown,
      handleRenameBlur,
      renameInputRef,
      setRenameValue,
    } = props;

    const item = flattenedItems[index];
    if (!item) return null;

    const { node, depth } = item;
    const isExpanded = expandedFolders.has(node.path);
    const isSoftSelected = selectedFile === node.path;
    const isActiveTab = activeTabPath === node.path;
    const isUnsaved = unsavedFiles.has(node.path);
    const isRenaming = renamingPath === node.path;
    const isMultiSelected = multiSelectedFiles.has(node.path);

    const gitFileStatus = isGitRepo && gitStatus[node.path] ? gitStatus[node.path] : null;
    const getGitStatusColor = (status: string | null) => {
      switch (status) {
        case 'modified': return 'text-orange-500';
        case 'added': return 'text-green-500';
        case 'deleted': return 'text-red-500';
        case 'untracked': return 'text-blue-400';
        case 'renamed': return 'text-purple-500';
        default: return '';
      }
    };
    const getGitStatusIndicator = (status: string | null) => {
      switch (status) {
        case 'modified': return 'M';
        case 'added': return 'A';
        case 'deleted': return 'D';
        case 'untracked': return 'U';
        case 'renamed': return 'R';
        default: return '';
      }
    };

    if (node.type === 'directory') {
      return (
        <div style={style} {...ariaAttributes}>
          <FileContextMenu fullPath={node.path} isFolder chatId={chatId}>
            <div>
              <NodeButton
                depth={depth}
                icon={
                  <div className="flex items-center gap-1" style={{ transform: 'scale(0.98)' }}>
                    {isExpanded ? (
                      <PhosphorIcon.CaretDown className="w-4 h-4" />
                    ) : (
                      <PhosphorIcon.CaretRight className="w-4 h-4" />
                    )}
                    {isExpanded ? (
                      <PhosphorIcon.FolderOpen className="w-4 h-4 text-yellow-500" />
                    ) : (
                      <PhosphorIcon.Folder className="w-4 h-4 text-yellow-500" />
                    )}
                  </div>
                }
                className={`group ${
                  isMultiSelected
                    ? 'bg-blue-500/30 text-bolt-elements-item-contentActive'
                    : isSoftSelected && !isRenaming
                    ? 'bg-bolt-elements-item-backgroundActive text-bolt-elements-item-contentActive'
                    : 'bg-transparent text-bolt-elements-item-contentDefault hover:text-bolt-elements-item-contentActive hover:bg-bolt-elements-item-backgroundActive'
                }`}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    toggleMultiSelect(node.path);
                  } else if (e.shiftKey) {
                    e.preventDefault();
                    toggleMultiSelect(node.path);
                  } else {
                    clearMultiSelect();
                    toggleFolder(node.path);
                    selectNode(node.path);
                  }
                }}
              >
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    onBlur={handleRenameBlur}
                    className="flex-1 bg-transparent outline-none text-bolt-elements-textPrimary border-b border-bolt-elements-focus-ring"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div className="flex items-center w-full">
                    <div className="flex-1 truncate pr-2">{node.name}</div>
                    {node.canLoadDeeper && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          loadDeeper(node.path, depth);
                        }}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover ml-auto"
                        title="Load deeper content"
                      >
                        Load Deeper
                      </button>
                    )}
                    {!node.canLoadDeeper && node.item_count !== undefined && node.item_count > 0 && (
                      <span className="text-xs text-bolt-elements-textTertiary ml-auto">
                        {node.item_count}
                      </span>
                    )}
                  </div>
                )}
              </NodeButton>
            </div>
          </FileContextMenu>
        </div>
      );
    }

    const FileIconComponent = getFileIcon(node.name);
    return (
      <div style={style} {...ariaAttributes}>
        <FileContextMenu fullPath={node.path} isFolder={false} chatId={chatId}>
          <div>
            <NodeButton
              depth={depth}
              icon={
                <div style={{ transform: 'scale(0.98)' }}>
                  <FileIconComponent className="w-4 h-4" />
                </div>
              }
              className={`group ${
                isMultiSelected
                  ? 'bg-blue-500/30 text-bolt-elements-item-contentActive'
                  : isActiveTab && !isRenaming
                  ? 'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent'
                  : isSoftSelected && !isRenaming
                  ? 'bg-bolt-elements-item-backgroundActive text-bolt-elements-item-contentActive'
                  : 'bg-transparent hover:bg-bolt-elements-item-backgroundActive text-bolt-elements-item-contentDefault'
              }`}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  e.preventDefault();
                  toggleMultiSelect(node.path);
                } else if (e.shiftKey) {
                  e.preventDefault();
                  toggleMultiSelect(node.path);
                } else {
                  clearMultiSelect();
                  selectFile(node.path);
                }
              }}
            >
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={handleRenameBlur}
                  className="flex-1 bg-transparent outline-none text-bolt-elements-textPrimary border-b border-bolt-elements-focus-ring"
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div
                  className={`flex items-center ${
                    !isActiveTab && !isSoftSelected ? 'group-hover:text-bolt-elements-item-contentActive' : ''
                  }`}
                >
                  <div className="flex-1 truncate pr-2">{node.name}</div>
                  <div className="flex items-center gap-1">
                    {gitFileStatus && (
                      <span className={`text-[10px] font-bold ${getGitStatusColor(gitFileStatus)}`} title={`Git: ${gitFileStatus}`}>
                        {getGitStatusIndicator(gitFileStatus)}
                      </span>
                    )}
                    {isUnsaved && (
                      <span style={{ transform: 'scale(0.68)' }}>
                        <PhosphorIcon.Circle className="shrink-0 text-orange-500 w-4 h-4" />
                      </span>
                    )}
                  </div>
                </div>
              )}
            </NodeButton>
          </div>
        </FileContextMenu>
      </div>
    );
  }, []);

  if (!filteredTree) {
    return (
      <div className="text-sm overflow-y-auto modern-scrollbar">
        <div className="flex items-center justify-center py-8 text-bolt-elements-textTertiary">
          No files
        </div>
      </div>
    );
  }

  return (
    <div className="text-sm h-full flex flex-col">
      {/* Inline creation input */}
      {creatingNode && (
        <div
          className="flex items-center gap-1.5 w-full pr-2 border-2 border-transparent text-sm py-0.5 bg-bolt-elements-item-backgroundActive"
          style={{ paddingLeft: `${6}px` }}
        >
          <div className="shrink-0" style={{ transform: 'scale(1.2)' }}>
            {creatingNode.type === 'file' ? (
              <PhosphorIcon.File className="w-4 h-4" />
            ) : (
              <PhosphorIcon.Folder className="w-4 h-4 text-yellow-500" />
            )}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={newItemName}
            onChange={(e) => setNewItemName(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={creatingNode.type === 'file' ? 'filename.ext' : 'foldername'}
            className="
              flex-1 bg-transparent outline-none
              text-bolt-elements-textPrimary
              placeholder:text-bolt-elements-textTertiary
              border-b border-bolt-elements-focus-ring
            "
          />
        </div>
      )}

      {/* Virtualized list */}
      <div className="flex-1 modern-scrollbar">
        <AutoSizer>
          {({ height, width }: { height: number; width: number }) => (
            <div style={{ height, width }}>
              <List
                rowCount={flattenedItems.length}
                rowHeight={ITEM_HEIGHT}
                rowComponent={Row}
                rowProps={listData as any}
                overscanCount={10}
              />
            </div>
          )}
        </AutoSizer>
      </div>
    </div>
  );
};
