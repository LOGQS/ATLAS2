import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { apiUrl } from '../config/api';
import logger from '../utils/core/logger';
import { filePreloader } from '../utils/filePreloader';

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

interface EditorDocument {
  filePath: string;
  content: string;
  originalContent: string;
  language: string;
  isBinary: boolean;
}

interface FileHistory {
  path: string;
  versions: Array<{ content: string; timestamp: number }>;
  originalContent: string;
}

interface CreatingNode {
  type: 'file' | 'folder';
  parentPath: string;
  depth: number;
}

interface EditorPane {
  activeTabPath: string | undefined;
  currentDocument: EditorDocument | undefined;
}

type SplitMode = 'none' | 'horizontal' | 'vertical';
type PaneId = 'primary' | 'secondary';

type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

interface DiffChunk {
  startLine: number;
  endLine: number;
  type: 'added' | 'removed' | 'modified';
}

interface DiffData {
  toolCallId: string;
  filePath: string;
  chunks: DiffChunk[];
  before: string;
  after: string;
}

interface Checkpoint {
  id: string;
  timestamp: string;
  operation: string;
  tool: string;
  filePath: string;
  changes: Array<{
    id: string;
    diff: string;
    linesAdded: number;
    linesRemoved: number;
  }>;
  callId?: string;
}

interface Plan {
  description: string;
  steps: Array<{
    id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    result?: string;
  }>;
}

interface CoderState {
  chatId?: string;
  workspacePath: string;
  workspaceName: string;
  hasWorkspace: boolean;
  fileTree: FileNode | null;
  expandedFolders: Set<string>;
  selectedFile: string | undefined;
  multiSelectedFiles: Set<string>; // Multi-select support
  lastSelectedIndex: number | null; // For shift-click range selection
  currentDocument: EditorDocument | undefined;
  openTabs: string[]; // Array of file paths that are open in tabs
  activeTabPath: string | undefined; // Currently active tab's file path
  tabDocuments: Record<string, EditorDocument>; // Cache of loaded documents
  unsavedFiles: Set<string>;
  fileHistory: Record<string, FileHistory>;
  isLoading: boolean;
  error: string;
  activeTab: 'files' | 'search';
  searchQuery: string;
  showTerminal: boolean;
  terminalHeight: number;
  sidebarWidth: number;
  creatingNode: CreatingNode | null;
  // Split editor support
  splitMode: SplitMode;
  activePaneId: PaneId;
  panes: {
    primary: EditorPane;
    secondary: EditorPane;
  };
  // Git integration
  isGitRepo: boolean;
  gitStatus: Record<string, GitFileStatus>;
  // Diff tracking for inline overlays
  pendingDiffs: Map<string, DiffData>;
  appliedChanges: Set<string>;
  // Checkpoint system
  checkpoints: Checkpoint[];
  // Plan tracking
  currentPlan: Plan | null;
  // Activity panel state
  activityPanelTab: 'activity' | 'plan' | 'checkpoints' | 'context' | 'timeline';
}

const findNodeByPath = (root: FileNode | null, targetPath: string): FileNode | null => {
  if (!root) {
    return null;
  }
  if (root.path === targetPath) {
    return root;
  }
  if (!root.children) {
    return null;
  }
  for (const child of root.children) {
    const found = findNodeByPath(child, targetPath);
    if (found) {
      return found;
    }
  }
  return null;
};

const collectDirectoryPaths = (node: FileNode | null, acc: Set<string> = new Set<string>()): Set<string> => {
  if (!node) {
    return acc;
  }
  if (node.type === 'directory') {
    acc.add(node.path || '');
    if (node.children) {
      for (const child of node.children) {
        collectDirectoryPaths(child, acc);
      }
    }
  }
  return acc;
};

interface CoderActions {
  setWorkspace: (path: string) => Promise<void>;
  loadFileTree: () => Promise<void>;
  loadDeeper: (folderPath: string, currentDepth: number) => Promise<void>;
  toggleFolder: (path: string) => void;
  selectFile: (path: string) => Promise<void>;
  selectNode: (path: string) => void;
  toggleMultiSelect: (path: string) => void;
  clearMultiSelect: () => void;
  selectRange: (fromPath: string, toPath: string) => void;
  openTab: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  switchToTab: (path: string) => void;
  reorderTabs: (newOrder: string[]) => void;
  updateFileContent: (content: string) => void;
  saveFile: () => Promise<void>;
  resetFile: () => Promise<void>;
  revertToSaved: (filePath: string) => Promise<void>;
  saveSnapshot: (filePath: string, content: string) => Promise<void>;
  createFile: (parentPath: string, name: string) => Promise<void>;
  createFolder: (parentPath: string, name: string) => Promise<void>;
  deleteNode: (path: string, isDirectory: boolean) => Promise<void>;
  deleteMultipleNodes: (paths: string[]) => Promise<void>;
  renameNode: (oldPath: string, newName: string) => Promise<void>;
  setActiveTab: (tab: 'files' | 'search') => void;
  setSearchQuery: (query: string) => void;
  toggleTerminal: () => void;
  setTerminalHeight: (height: number) => void;
  setSidebarWidth: (width: number) => void;
  setError: (error: string) => void;
  startCreatingFile: () => void;
  startCreatingFolder: () => void;
  cancelCreating: () => void;
  finishCreating: (name: string) => Promise<void>;
  // Split editor actions
  splitEditorHorizontal: () => void;
  splitEditorVertical: () => void;
  closeSplit: () => void;
  switchPane: (paneId: PaneId) => void;
  openTabInPane: (path: string, paneId: PaneId) => Promise<void>;
  // Diff management
  addPendingDiff: (toolCallId: string, diff: DiffData) => void;
  acceptDiff: (toolCallId: string) => void;
  rejectDiff: (toolCallId: string) => void;
  acceptAllDiffs: () => void;
  rejectAllDiffs: () => void;
  // Checkpoint management
  addCheckpoint: (data: Omit<Checkpoint, 'id' | 'timestamp'>) => void;
  revertToCheckpoint: (checkpointId: string) => Promise<void>;
  // Plan management
  updatePlan: (plan: Plan | null) => void;
  updateStepStatus: (stepId: string, status: 'pending' | 'in_progress' | 'completed' | 'failed', result?: string) => void;
  // Activity panel
  setActivityPanelTab: (tab: 'activity' | 'plan' | 'checkpoints' | 'context' | 'timeline') => void;
}

const CoderContext = createContext<(CoderState & CoderActions) | undefined>(undefined);

export const useCoderContext = () => {
  const context = useContext(CoderContext);
  if (!context) {
    throw new Error('useCoderContext must be used within CoderProvider');
  }
  return context;
};

interface CoderProviderProps {
  chatId?: string;
  children: React.ReactNode;
  onWorkspaceReady?: () => void;
}

export const CoderProvider: React.FC<CoderProviderProps> = ({ chatId, children, onWorkspaceReady }) => {
  const [state, setState] = useState<CoderState>({
    chatId,
    workspacePath: '',
    workspaceName: '',
    hasWorkspace: false,
    fileTree: null,
    expandedFolders: new Set(),
    selectedFile: undefined,
    multiSelectedFiles: new Set(),
    lastSelectedIndex: null,
    currentDocument: undefined,
    openTabs: [],
    activeTabPath: undefined,
    tabDocuments: {},
    unsavedFiles: new Set(),
    fileHistory: {},
    isLoading: false,
    error: '',
    activeTab: 'files',
    searchQuery: '',
    showTerminal: false,
    terminalHeight: 300,
    sidebarWidth: 280,
    creatingNode: null,
    // Split editor state
    splitMode: 'none',
    activePaneId: 'primary',
    panes: {
      primary: {
        activeTabPath: undefined,
        currentDocument: undefined,
      },
      secondary: {
        activeTabPath: undefined,
        currentDocument: undefined,
      },
    },
    // Git integration state
    isGitRepo: false,
    gitStatus: {},
    // Diff tracking state
    pendingDiffs: new Map(),
    appliedChanges: new Set(),
    // Checkpoint system state
    checkpoints: [],
    // Plan tracking state
    currentPlan: null,
    // Activity panel state
    activityPanelTab: 'activity',
  });
  const stateRef = React.useRef(state);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const activeFileRequestRef = React.useRef<{ path: string; controller: AbortController } | null>(null);

  const setError = useCallback((error: string) => {
    setState(prev => ({ ...prev, error }));
  }, []);

  const loadFileTree = useCallback(async () => {
    if (!chatId) return;
    logger.info('[CODER_CTX] loadFileTree start', { chatId });
    setState(prev => ({ ...prev, isLoading: true, error: '' }));
    try {
      const treePromise = fetch(apiUrl(`/api/coder-workspace/tree?chat_id=${chatId}`));
      const gitStatusPromise = fetch(apiUrl(`/api/coder-git/status?chat_id=${chatId}`))
        .then(res => res.json())
        .catch(err => {
          logger.warn('[CODER] Failed to load git status:', err);
          return null;
        });

      const treeResponse = await treePromise;
      const treeData = await treeResponse.json();

      if (!treeData.success || !treeData.root) {
        await gitStatusPromise;
        setState(prev => ({ ...prev, error: treeData.error || 'Failed to load file tree', isLoading: false }));
        return;
      }

      const rootNode: FileNode = treeData.root;
      const directoryPaths = collectDirectoryPaths(rootNode, new Set<string>());
      const rootPath = rootNode.path || '';

      const applyTreeUpdate = (prev: CoderState, overrides: Partial<CoderState>) => {
        const nextExpanded = new Set<string>();

        prev.expandedFolders.forEach(path => {
          if (directoryPaths.has(path)) {
            nextExpanded.add(path);
          }
        });
        nextExpanded.add(rootPath);

        return {
          ...prev,
          fileTree: rootNode,
          expandedFolders: nextExpanded,
          isLoading: false,
          ...overrides,
        };
      };

      const gitData = await gitStatusPromise;
      const gitOverrides: Partial<CoderState> = gitData?.success
        ? {
            isGitRepo: gitData.is_git_repo,
            gitStatus: gitData.status || {},
          }
        : {
            isGitRepo: false,
            gitStatus: {},
          };

      setState(prev => applyTreeUpdate(prev, gitOverrides));
      logger.info('[CODER_CTX] loadFileTree success', { hasGit: !!gitData?.success, isGitRepo: !!gitData?.is_git_repo });
    } catch (err) {
      logger.error('[CODER] Failed to load file tree:', err);
      setState(prev => ({ ...prev, error: 'Failed to load file tree', isLoading: false }));
    }
  }, [chatId]);

  const setWorkspace = useCallback(async (path: string) => {
    if (!chatId || !path.trim()) return;
    logger.info('[CODER_CTX] setWorkspace start', { chatId, path });
    // Check if we're switching to a different workspace
    setState(prev => {
      const isDifferentWorkspace = prev.workspacePath && prev.workspacePath !== path.trim();

      // If switching workspaces, immediately clear old workspace state to prevent flash of old content
      if (isDifferentWorkspace) {
        return {
          ...prev,
          isLoading: true,
          error: '',
          currentDocument: undefined,
          selectedFile: undefined,
          fileTree: null,
          openTabs: [],
          activeTabPath: undefined,
          tabDocuments: {},
          unsavedFiles: new Set(),
          fileHistory: {},
          expandedFolders: new Set(),
        };
      }

      // Same workspace or first time, just set loading
      return { ...prev, isLoading: true, error: '' };
    });

    try {
      const response = await fetch(apiUrl('/api/coder-workspace/set'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, workspace_path: path.trim() })
      });

      const data = await response.json();

      if (data.success) {
        logger.info('[CODER_CTX] setWorkspace success', { workspace_path: data.workspace_path });
        setState(prev => ({
          ...prev,
          workspacePath: data.workspace_path,
          workspaceName: data.workspace_name,
          hasWorkspace: true,
        }));
        await loadFileTree();

        // Notify the worker that workspace has been selected so it can continue
        if (chatId) {
          try {
            const response = await fetch(apiUrl(`/api/chats/${chatId}/workspace_selected`), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });

            let result: any = null;
            let parseError: unknown = null;
            try {
              result = await response.json();
            } catch (error) {
              parseError = error;
            }

            if (parseError) {
              logger.debug('[CODER_CTX] workspace_selected response was not JSON', parseError);
            }

            const workerInactive = response.status === 400 && result?.error === 'Chat worker is not active';

            if (response.ok && result?.success) {
              logger.info('[CODER_CTX] Successfully notified worker of workspace selection');
            } else if (workerInactive) {
              logger.info('[CODER_CTX] Worker inactive; skipping workspace notification');
            } else {
              logger.warn('[CODER_CTX] Failed to notify worker', { status: response.status, error: result?.error });
            }
          } catch (notifyError) {
            logger.error('[CODER_CTX] Failed to notify worker of workspace selection:', notifyError);
          }
        }

        // Signal that workspace is fully loaded and ready
        if (onWorkspaceReady) {
          logger.info('[CODER_CTX] Calling onWorkspaceReady callback');
          onWorkspaceReady();
        }
      } else {
        logger.warn('[CODER_CTX] setWorkspace failed', { error: data.error });
        setState(prev => ({ ...prev, error: data.error || 'Failed to set workspace', isLoading: false }));
      }
    } catch (err) {
      logger.error('[CODER] Failed to set workspace:', err);
      setState(prev => ({ ...prev, error: 'Failed to set workspace', isLoading: false }));
    }
  }, [chatId, loadFileTree, onWorkspaceReady]);

  const toggleFolder = useCallback((path: string) => {
    setState(prev => {
      const next = new Set(prev.expandedFolders);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { ...prev, expandedFolders: next };
    });
  }, []);

  const loadDeeper = useCallback(async (folderPath: string, currentDepth: number) => {
    if (!chatId) return;

    logger.info('[CODER_CTX] loadDeeper start', { chatId, folderPath, currentDepth });
    setState(prev => ({ ...prev, isLoading: true, error: '' }));

    try {
      const response = await fetch(
        apiUrl(`/api/coder-workspace/tree/load-deeper?chat_id=${chatId}&path=${encodeURIComponent(folderPath)}&current_depth=${currentDepth}`)
      );
      const data = await response.json();

      if (!data.success || !data.children) {
        setState(prev => ({ ...prev, error: data.error || 'Failed to load deeper content', isLoading: false }));
        return;
      }

      // Find the target folder in the tree and update its children
      const updateNodeChildren = (node: FileNode): FileNode => {
        if (node.path === folderPath) {
          // This is the folder to update
          return {
            ...node,
            children: data.children,
            item_count: data.children.length,
            canLoadDeeper: false, // Remove the canLoadDeeper flag after loading
          };
        }

        if (node.children) {
          return {
            ...node,
            children: node.children.map(updateNodeChildren),
          };
        }

        return node;
      };

      setState(prev => {
        if (!prev.fileTree) return { ...prev, isLoading: false };

        const updatedTree = updateNodeChildren(prev.fileTree);

        // Ensure the folder is expanded
        const nextExpanded = new Set(prev.expandedFolders);
        nextExpanded.add(folderPath);

        return {
          ...prev,
          fileTree: updatedTree,
          expandedFolders: nextExpanded,
          isLoading: false,
        };
      });

      logger.info('[CODER_CTX] loadDeeper success', { folderPath, childrenCount: data.children.length });
    } catch (err) {
      logger.error('[CODER] Failed to load deeper content:', err);
      setState(prev => ({ ...prev, error: 'Failed to load deeper content', isLoading: false }));
    }
  }, [chatId]);

  const openTab = useCallback(async (filePath: string) => {
    if (!chatId) return;

    const snapshot = stateRef.current;
    const existingDoc = snapshot.tabDocuments[filePath];
    const tabAlreadyOpen = snapshot.openTabs.includes(filePath);

    if (tabAlreadyOpen && existingDoc) {
      setState(prev => ({
        ...prev,
        activeTabPath: filePath,
        currentDocument: existingDoc,
        selectedFile: filePath,
      }));
      return;
    }

    const cached = filePreloader.getCached(filePath);
    if (cached) {
      const cachedDoc: EditorDocument = {
        filePath,
        content: cached.content,
        originalContent: cached.content,
        language: cached.language,
        isBinary: false,
      };

      filePreloader.primeCache(filePath, cached.content, cached.language);

      setState(prev => {
        const nextOpenTabs = prev.openTabs.includes(filePath)
          ? prev.openTabs
          : [...prev.openTabs, filePath];

        const previousHistory = prev.fileHistory[filePath];
        const historyEntry = previousHistory
          ? {
              ...previousHistory,
              versions:
                previousHistory.versions && previousHistory.versions.length > 0
                  ? [...previousHistory.versions]
                  : [{ content: cached.content, timestamp: Date.now() }],
              originalContent: previousHistory.originalContent ?? cached.content,
            }
          : {
              path: filePath,
              versions: [{ content: cached.content, timestamp: Date.now() }],
              originalContent: cached.content,
            };

        return {
          ...prev,
          openTabs: nextOpenTabs,
          activeTabPath: filePath,
          tabDocuments: {
            ...prev.tabDocuments,
            [filePath]: cachedDoc,
          },
          selectedFile: filePath,
          currentDocument: cachedDoc,
          isLoading: false,
          error: '',
          fileHistory: {
            ...prev.fileHistory,
            [filePath]: historyEntry,
          },
        };
      });
    } else {
      setState(prev => ({
        ...prev,
        isLoading: true,
        error: '',
        selectedFile: filePath,
      }));
    }

    const controller = new AbortController();
    const previousRequest = activeFileRequestRef.current;
    if (previousRequest) {
      previousRequest.controller.abort();
    }
    activeFileRequestRef.current = { path: filePath, controller };

    try {
      const response = await fetch(
        apiUrl(`/api/coder-workspace/file?chat_id=${chatId}&path=${encodeURIComponent(filePath)}`),
        { signal: controller.signal }
      );
      const data = await response.json();

      if (data.success) {
        const doc: EditorDocument = {
          filePath,
          content: data.content,
          originalContent: data.content,
          language: data.language,
          isBinary: false,
        };

        filePreloader.primeCache(filePath, data.content, data.language);

        setState(prev => {
          if (activeFileRequestRef.current && activeFileRequestRef.current.path !== filePath) {
            return prev;
          }

          const nextOpenTabs = prev.openTabs.includes(filePath)
            ? prev.openTabs
            : [...prev.openTabs, filePath];

          const existingHistory = prev.fileHistory[filePath];
          const timestamp = Date.now();
          const previousVersions = existingHistory?.versions ?? [];
          const lastVersion = previousVersions[0];
          const versions =
            lastVersion && lastVersion.content === data.content
              ? previousVersions
              : [{ content: data.content, timestamp }, ...previousVersions];

          return {
            ...prev,
            openTabs: nextOpenTabs,
            activeTabPath: filePath,
            tabDocuments: {
              ...prev.tabDocuments,
              [filePath]: doc,
            },
            selectedFile: filePath,
            currentDocument: doc,
            isLoading: false,
            error: '',
            fileHistory: {
              ...prev.fileHistory,
              [filePath]: {
                path: filePath,
                versions,
                originalContent: data.content,
              },
            },
          };
        });

        // Preload related files for better IntelliSense
        if (!activeFileRequestRef.current || activeFileRequestRef.current.path === filePath) {
          filePreloader.preloadRelatedFiles(
            filePath,
            data.content,
            data.language,
            stateRef.current.workspacePath,
            chatId,
            apiUrl
          ).catch(err => logger.warn('[CODER] Failed to preload related files:', err));
        }
      } else {
        setState(prev => {
          if (activeFileRequestRef.current && activeFileRequestRef.current.path !== filePath) {
            return prev;
          }
          return { ...prev, error: data.error || 'Failed to load file', isLoading: false };
        });
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      logger.error('[CODER] Failed to load file:', err);
      setState(prev => {
        if (activeFileRequestRef.current && activeFileRequestRef.current.path !== filePath) {
          return prev;
        }
        return { ...prev, error: 'Failed to load file', isLoading: false };
      });
    } finally {
      if (activeFileRequestRef.current && activeFileRequestRef.current.path === filePath) {
        activeFileRequestRef.current = null;
      }
    }
  }, [chatId]);

  const closeTab = useCallback((filePath: string) => {
    setState(prev => {
      const tabIndex = prev.openTabs.indexOf(filePath);
      if (tabIndex === -1) return prev; // Tab not found

      // Check if file has unsaved changes (for logging only)
      const hasUnsaved = prev.unsavedFiles.has(filePath);
      if (hasUnsaved) {
        logger.info('[CODER] Closing tab with unsaved changes, discarding:', filePath);
      }

      const newOpenTabs = prev.openTabs.filter(path => path !== filePath);

      // Determine which tab to switch to
      let newActiveTabPath = prev.activeTabPath;
      let newCurrentDocument = prev.currentDocument;

      if (prev.activeTabPath === filePath) {
        // Closing the active tab, need to switch to another
        if (newOpenTabs.length === 0) {
          // No tabs left
          newActiveTabPath = undefined;
          newCurrentDocument = undefined;
        } else if (tabIndex > 0) {
          // Switch to previous tab
          newActiveTabPath = newOpenTabs[tabIndex - 1];
          newCurrentDocument = prev.tabDocuments[newActiveTabPath];
        } else {
          // Switch to next tab (now at index 0)
          newActiveTabPath = newOpenTabs[0];
          newCurrentDocument = prev.tabDocuments[newActiveTabPath];
        }
      }

      // Clean up tab document cache
      const newTabDocuments = { ...prev.tabDocuments };
      delete newTabDocuments[filePath];

      // Clean up unsaved files
      const newUnsavedFiles = new Set(prev.unsavedFiles);
      newUnsavedFiles.delete(filePath);

      return {
        ...prev,
        openTabs: newOpenTabs,
        activeTabPath: newActiveTabPath,
        currentDocument: newCurrentDocument,
        selectedFile: newActiveTabPath,
        tabDocuments: newTabDocuments,
        unsavedFiles: newUnsavedFiles,
      };
    });
  }, []);

  const switchToTab = useCallback((filePath: string) => {
    setState(prev => {
      if (!prev.openTabs.includes(filePath)) return prev;

      return {
        ...prev,
        activeTabPath: filePath,
        currentDocument: prev.tabDocuments[filePath],
        selectedFile: filePath,
      };
    });
  }, []);

  const reorderTabs = useCallback((newOrder: string[]) => {
    setState(prev => {
      // Validate that all tabs in newOrder exist in openTabs
      const allTabsValid = newOrder.every(path => prev.openTabs.includes(path));
      if (!allTabsValid || newOrder.length !== prev.openTabs.length) {
        logger.warn('[CODER] Invalid tab reorder attempted');
        return prev;
      }

      return {
        ...prev,
        openTabs: newOrder,
      };
    });
  }, []);

  const selectFile = useCallback(async (filePath: string) => {
    // Redirect to openTab for tab-based navigation
    await openTab(filePath);
  }, [openTab]);

  const selectNode = useCallback((path: string) => {
    // Just update selectedFile without opening a tab
    // This is useful for selecting folders
    setState(prev => ({ ...prev, selectedFile: path, multiSelectedFiles: new Set() }));
  }, []);

  const toggleMultiSelect = useCallback((path: string) => {
    setState(prev => {
      const newMultiSelected = new Set(prev.multiSelectedFiles);
      if (newMultiSelected.has(path)) {
        newMultiSelected.delete(path);
      } else {
        newMultiSelected.add(path);
      }
      return { ...prev, multiSelectedFiles: newMultiSelected, selectedFile: path };
    });
  }, []);

  const clearMultiSelect = useCallback(() => {
    setState(prev => ({ ...prev, multiSelectedFiles: new Set() }));
  }, []);

  const selectRange = useCallback((fromPath: string, toPath: string) => {
    // This is a simplified implementation
    // In a full implementation, you'd traverse the file tree to get all paths between fromPath and toPath
    setState(prev => {
      const newMultiSelected = new Set(prev.multiSelectedFiles);
      newMultiSelected.add(fromPath);
      newMultiSelected.add(toPath);
      return { ...prev, multiSelectedFiles: newMultiSelected };
    });
  }, []);

  const deleteMultipleNodes = useCallback(async (paths: string[]) => {
    if (!chatId || paths.length === 0) return;

    setState(prev => ({ ...prev, isLoading: true, error: '' }));
    try {
      let hadError = false;
      const currentTree = state.fileTree;

      for (const path of paths) {
        const node = findNodeByPath(currentTree, path);
        const isDirectory = node?.type === 'directory';

        const response = await fetch(apiUrl('/api/coder-workspace/delete'), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, path, is_directory: isDirectory })
        });

        if (!response.ok) {
          hadError = true;
          logger.warn(`[CODER] Failed to delete ${path}: HTTP ${response.status}`);
          continue;
        }

        const result = await response.json();
        if (!result.success) {
          hadError = true;
          logger.warn(`[CODER] Failed to delete ${path}: ${result.error}`);
        }
      }

      setState(prev => ({ ...prev, multiSelectedFiles: new Set() }));
      await loadFileTree();

      if (hadError) {
        setState(prev => ({ ...prev, error: 'Some items could not be deleted' }));
      }
    } catch (err) {
      logger.error('[CODER] Failed to delete multiple nodes:', err);
      setState(prev => ({ ...prev, error: 'Failed to delete files', isLoading: false }));
    }
  }, [chatId, loadFileTree, state.fileTree]);

  const saveSnapshot = useCallback(async (filePath: string, content: string) => {
    if (!chatId || !state.workspacePath) return;

    try {
      const response = await fetch(apiUrl('/api/coder-workspace/file/snapshot'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          path: filePath,
          content
        })
      });

      const data = await response.json();
      if (!data.success) {
        logger.warn('[CODER] Failed to save snapshot:', data.error);
      }
    } catch (err) {
      logger.error('[CODER] Failed to save snapshot:', err);
    }
  }, [chatId, state.workspacePath]);

  const updateFileContent = useCallback((content: string) => {
    setState(prev => {
      if (!prev.currentDocument) return prev;

      const updatedDoc = { ...prev.currentDocument, content };
      const isUnsaved = content !== prev.currentDocument.originalContent;

      const newUnsavedFiles = new Set(prev.unsavedFiles);
        if (isUnsaved) {
          newUnsavedFiles.add(prev.currentDocument.filePath);
        } else {
          newUnsavedFiles.delete(prev.currentDocument.filePath);
        }

        const history = prev.fileHistory[prev.currentDocument.filePath];
        let updatedHistoryMap = prev.fileHistory;
        if (history) {
          const lastEntry = history.versions[history.versions.length - 1];
          if (!lastEntry || lastEntry.content !== content) {
            const updatedHistory: FileHistory = {
              ...history,
              versions: [...history.versions, { content, timestamp: Date.now() }],
            };
            updatedHistoryMap = {
              ...prev.fileHistory,
              [prev.currentDocument.filePath]: updatedHistory,
            };
          }
        }

        // Update tab documents cache
        const newTabDocuments = { ...prev.tabDocuments };
        if (prev.currentDocument.filePath in newTabDocuments) {
          newTabDocuments[prev.currentDocument.filePath] = updatedDoc;
        }

        return {
          ...prev,
          currentDocument: updatedDoc,
          tabDocuments: newTabDocuments,
          unsavedFiles: newUnsavedFiles,
          fileHistory: updatedHistoryMap,
        };
      });
    }, []);

  const saveFile = useCallback(async () => {
    const currentDoc = stateRef.current.currentDocument;
    if (!chatId || !currentDoc) return;

    const { filePath, content } = currentDoc;
    setState(prev => ({ ...prev, isLoading: true, error: '' }));

    try {
      const response = await fetch(apiUrl('/api/coder-workspace/file'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, path: filePath, content })
      });

      const data = await response.json();

      if (data.success) {
        setState(prev => {
          const newUnsavedFiles = new Set(prev.unsavedFiles);
          newUnsavedFiles.delete(filePath);

          const updatedDoc = prev.currentDocument ? {
            ...prev.currentDocument,
            originalContent: content,
          } : undefined;

          // Update tab documents cache
          const newTabDocuments = { ...prev.tabDocuments };
          if (updatedDoc && filePath in newTabDocuments) {
            newTabDocuments[filePath] = updatedDoc;
          }

          return {
            ...prev,
            currentDocument: updatedDoc,
            tabDocuments: newTabDocuments,
            unsavedFiles: newUnsavedFiles,
            isLoading: false,
          };
        });
        logger.info('[CODER] File saved:', filePath);
      } else {
        setState(prev => ({ ...prev, error: data.error || 'Failed to save file', isLoading: false }));
      }
    } catch (err) {
      logger.error('[CODER] Failed to save file:', err);
      setState(prev => ({ ...prev, error: 'Failed to save file', isLoading: false }));
    }
  }, [chatId]);

  const createFile = useCallback(async (parentPath: string, name: string) => {
    if (!chatId) return;

    setState(prev => ({ ...prev, isLoading: true, error: '' }));
    try {
      const response = await fetch(apiUrl('/api/coder-workspace/create-file'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, parent_path: parentPath, name })
      });

      const data = await response.json();
      if (data.success) {
        await loadFileTree();
      } else {
        setState(prev => ({ ...prev, error: data.error, isLoading: false }));
      }
    } catch (err) {
      logger.error('[CODER] Failed to create file:', err);
      setState(prev => ({ ...prev, error: 'Failed to create file', isLoading: false }));
    }
  }, [chatId, loadFileTree]);

  const createFolder = useCallback(async (parentPath: string, name: string) => {
    if (!chatId) return;

    setState(prev => ({ ...prev, isLoading: true, error: '' }));
    try {
      const response = await fetch(apiUrl('/api/coder-workspace/create-folder'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, parent_path: parentPath, name })
      });

      const data = await response.json();
      if (data.success) {
        await loadFileTree();
      } else {
        setState(prev => ({ ...prev, error: data.error, isLoading: false }));
      }
    } catch (err) {
      logger.error('[CODER] Failed to create folder:', err);
      setState(prev => ({ ...prev, error: 'Failed to create folder', isLoading: false }));
    }
  }, [chatId, loadFileTree]);

  const deleteNode = useCallback(async (path: string, isDirectory: boolean) => {
    if (!chatId) return;

    setState(prev => ({ ...prev, isLoading: true, error: '' }));
    try {
      const response = await fetch(apiUrl('/api/coder-workspace/delete'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, path, is_directory: isDirectory })
      });

      const data = await response.json();
      if (data.success) {
        // Close file if it's the selected one
        if (state.selectedFile === path) {
          setState(prev => ({ ...prev, selectedFile: undefined, currentDocument: undefined }));
        }
        await loadFileTree();
      } else {
        setState(prev => ({ ...prev, error: data.error, isLoading: false }));
      }
    } catch (err) {
      logger.error('[CODER] Failed to delete:', err);
      setState(prev => ({ ...prev, error: 'Failed to delete', isLoading: false }));
    }
  }, [chatId, loadFileTree, state.selectedFile]);

  const renameNode = useCallback(async (oldPath: string, newName: string) => {
    if (!chatId) return;

    setState(prev => ({ ...prev, isLoading: true, error: '' }));
    try {
      const response = await fetch(apiUrl('/api/coder-workspace/rename'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, old_path: oldPath, new_name: newName })
      });

      const data = await response.json();
      if (data.success) {
        await loadFileTree();
      } else {
        setState(prev => ({ ...prev, error: data.error, isLoading: false }));
      }
    } catch (err) {
      logger.error('[CODER] Failed to rename:', err);
      setState(prev => ({ ...prev, error: 'Failed to rename', isLoading: false }));
    }
  }, [chatId, loadFileTree]);

  const revertToSaved = useCallback(async (filePath: string) => {
    if (!chatId) return;

    setState(prev => ({ ...prev, isLoading: true, error: '' }));
    try {
      const response = await fetch(apiUrl('/api/coder-workspace/file/revert'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          path: filePath,
          revert_to_saved: true
        })
      });

      const data = await response.json();
      if (data.success && data.content !== null) {
        // Update the document with reverted content
        setState(prev => {
          const newUnsavedFiles = new Set(prev.unsavedFiles);
          newUnsavedFiles.delete(filePath);

          const revertedDoc: EditorDocument = {
            filePath,
            content: data.content,
            originalContent: data.content,
            language: prev.tabDocuments[filePath]?.language || 'plaintext',
            isBinary: false,
          };

          const newTabDocuments = { ...prev.tabDocuments };
          if (filePath in newTabDocuments) {
            newTabDocuments[filePath] = revertedDoc;
          }

          const newCurrentDocument = prev.activeTabPath === filePath ? revertedDoc : prev.currentDocument;

          return {
            ...prev,
            currentDocument: newCurrentDocument,
            tabDocuments: newTabDocuments,
            unsavedFiles: newUnsavedFiles,
            isLoading: false,
          };
        });
        logger.info('[CODER] Reverted to saved version:', filePath);
      } else {
        setState(prev => ({ ...prev, error: data.error || 'No saved version found', isLoading: false }));
      }
    } catch (err) {
      logger.error('[CODER] Failed to revert to saved:', err);
      setState(prev => ({ ...prev, error: 'Failed to revert to saved version', isLoading: false }));
    }
  }, [chatId]);

  const resetFile = useCallback(async () => {
    const currentDoc = stateRef.current.currentDocument;
    if (!currentDoc) return;

    await revertToSaved(currentDoc.filePath);
  }, [revertToSaved]); 

  const startCreatingFile = useCallback(() => {
    setState(prev => {
      const { selectedFile, fileTree } = prev;
      let parentPath = '';
      let depth = 0;

      if (selectedFile && fileTree) {
        const selectedNode = findNodeByPath(fileTree, selectedFile);

        if (selectedNode) {
          if (selectedNode.type === 'directory') {
            // Create inside the selected folder
            parentPath = selectedNode.path;
            depth = (selectedNode.path.match(/\//g) || []).length + 1;

            // Expand the folder if it's not expanded
            if (!prev.expandedFolders.has(selectedNode.path)) {
              const newExpanded = new Set(prev.expandedFolders);
              newExpanded.add(selectedNode.path);
              return {
                ...prev,
                expandedFolders: newExpanded,
                creatingNode: {
                  type: 'file',
                  parentPath,
                  depth,
                },
              };
            }
          } else {
            // Create in the file's parent directory
            const parts = selectedNode.path.split('/');
            parts.pop(); // Remove filename
            parentPath = parts.join('/');
            depth = parts.length;
          }
        }
      }

      return {
        ...prev,
        creatingNode: {
          type: 'file',
          parentPath,
          depth,
        },
      };
    });
  }, []);

  const startCreatingFolder = useCallback(() => {
    setState(prev => {
      const { selectedFile, fileTree } = prev;
      let parentPath = '';
      let depth = 0;

      if (selectedFile && fileTree) {
        const selectedNode = findNodeByPath(fileTree, selectedFile);

        if (selectedNode) {
          if (selectedNode.type === 'directory') {
            // Create inside the selected folder
            parentPath = selectedNode.path;
            depth = (selectedNode.path.match(/\//g) || []).length + 1;

            // Expand the folder if it's not expanded
            if (!prev.expandedFolders.has(selectedNode.path)) {
              const newExpanded = new Set(prev.expandedFolders);
              newExpanded.add(selectedNode.path);
              return {
                ...prev,
                expandedFolders: newExpanded,
                creatingNode: {
                  type: 'folder',
                  parentPath,
                  depth,
                },
              };
            }
          } else {
            // Create in the file's parent directory
            const parts = selectedNode.path.split('/');
            parts.pop(); // Remove filename
            parentPath = parts.join('/');
            depth = parts.length;
          }
        }
      }

      return {
        ...prev,
        creatingNode: {
          type: 'folder',
          parentPath,
          depth,
        },
      };
    });
  }, []);

  const cancelCreating = useCallback(() => {
    setState(prev => ({
      ...prev,
      creatingNode: null,
    }));
  }, []);

  const finishCreating = useCallback(async (name: string) => {
    if (!state.creatingNode || !name.trim()) {
      setState(prev => ({ ...prev, creatingNode: null }));
      return;
    }

    const { type, parentPath } = state.creatingNode;

    // Clear creating state immediately
    setState(prev => ({ ...prev, creatingNode: null }));

    // Create the file or folder
    if (type === 'file') {
      await createFile(parentPath, name.trim());
    } else {
      await createFolder(parentPath, name.trim());
    }
  }, [state.creatingNode, createFile, createFolder]);

  // Split editor actions
  const splitEditorHorizontal = useCallback(() => {
    setState(prev => {
      if (prev.splitMode !== 'none') return prev; // Already split

      // Copy current editor state to primary pane, secondary starts empty
      return {
        ...prev,
        splitMode: 'horizontal',
        activePaneId: 'primary',
        panes: {
          primary: {
            activeTabPath: prev.activeTabPath,
            currentDocument: prev.currentDocument,
          },
          secondary: {
            activeTabPath: undefined,
            currentDocument: undefined,
          },
        },
      };
    });
  }, []);

  const splitEditorVertical = useCallback(() => {
    setState(prev => {
      if (prev.splitMode !== 'none') return prev; // Already split

      // Copy current editor state to primary pane, secondary starts empty
      return {
        ...prev,
        splitMode: 'vertical',
        activePaneId: 'primary',
        panes: {
          primary: {
            activeTabPath: prev.activeTabPath,
            currentDocument: prev.currentDocument,
          },
          secondary: {
            activeTabPath: undefined,
            currentDocument: undefined,
          },
        },
      };
    });
  }, []);

  const closeSplit = useCallback(() => {
    setState(prev => {
      if (prev.splitMode === 'none') return prev; // Not split

      // Restore state from active pane
      const activePane = prev.panes[prev.activePaneId];

      return {
        ...prev,
        splitMode: 'none',
        activePaneId: 'primary',
        activeTabPath: activePane.activeTabPath,
        currentDocument: activePane.currentDocument,
        panes: {
          primary: {
            activeTabPath: activePane.activeTabPath,
            currentDocument: activePane.currentDocument,
          },
          secondary: {
            activeTabPath: undefined,
            currentDocument: undefined,
          },
        },
      };
    });
  }, []);

  const switchPane = useCallback((paneId: PaneId) => {
    setState(prev => {
      if (prev.splitMode === 'none') return prev; // Not split

      const targetPane = prev.panes[paneId];

      return {
        ...prev,
        activePaneId: paneId,
        activeTabPath: targetPane.activeTabPath,
        currentDocument: targetPane.currentDocument,
      };
    });
  }, []);

  const openTabInPane = useCallback(async (filePath: string, paneId: PaneId) => {
    if (!chatId) return;

    // If document is already loaded in tabDocuments, use it
    setState(prev => {
      if (prev.tabDocuments[filePath]) {
        const doc = prev.tabDocuments[filePath];
        return {
          ...prev,
          activePaneId: paneId,
          activeTabPath: filePath,
          currentDocument: doc,
          selectedFile: filePath,
          panes: {
            ...prev.panes,
            [paneId]: {
              activeTabPath: filePath,
              currentDocument: doc,
            },
          },
        };
      }
      return { ...prev, isLoading: true, error: '' };
    });

    // If already loaded, we're done
    if (state.tabDocuments[filePath]) {
      return;
    }

    // Load the file
    try {
      const response = await fetch(apiUrl(`/api/coder-workspace/file?chat_id=${chatId}&path=${encodeURIComponent(filePath)}`));
      const data = await response.json();

      if (data.success) {
        const doc: EditorDocument = {
          filePath,
          content: data.content,
          originalContent: data.content,
          language: data.language,
          isBinary: false,
        };

        setState(prev => {
          // Add to openTabs if not already there
          const newOpenTabs = prev.openTabs.includes(filePath)
            ? prev.openTabs
            : [...prev.openTabs, filePath];

          return {
            ...prev,
            openTabs: newOpenTabs,
            activePaneId: paneId,
            activeTabPath: filePath,
            tabDocuments: {
              ...prev.tabDocuments,
              [filePath]: doc,
            },
            selectedFile: filePath,
            currentDocument: doc,
            isLoading: false,
            panes: {
              ...prev.panes,
              [paneId]: {
                activeTabPath: filePath,
                currentDocument: doc,
              },
            },
            fileHistory: {
              ...prev.fileHistory,
              [filePath]: {
                path: filePath,
                versions: [{ content: data.content, timestamp: Date.now() }],
                originalContent: data.content,
              },
            },
          };
        });

        // Preload related files
        filePreloader.preloadRelatedFiles(
          filePath,
          data.content,
          data.language,
          state.workspacePath,
          chatId,
          apiUrl
        ).catch(err => logger.warn('[CODER] Failed to preload related files:', err));
      } else {
        setState(prev => ({ ...prev, error: data.error || 'Failed to load file', isLoading: false }));
      }
    } catch (err) {
      logger.error('[CODER] Failed to load file:', err);
      setState(prev => ({ ...prev, error: 'Failed to load file', isLoading: false }));
    }
  }, [chatId, state.tabDocuments, state.workspacePath]);

  // Diff management functions
  const addPendingDiff = useCallback((toolCallId: string, diff: DiffData) => {
    setState(prev => {
      const newPendingDiffs = new Map(prev.pendingDiffs);
      newPendingDiffs.set(toolCallId, diff);
      return { ...prev, pendingDiffs: newPendingDiffs };
    });
    logger.info('[CODER] Added pending diff:', toolCallId);
  }, []);

  const acceptDiff = useCallback((toolCallId: string) => {
    setState(prev => {
      const newPendingDiffs = new Map(prev.pendingDiffs);
      newPendingDiffs.delete(toolCallId);
      const newAppliedChanges = new Set(prev.appliedChanges);
      newAppliedChanges.add(toolCallId);
      return {
        ...prev,
        pendingDiffs: newPendingDiffs,
        appliedChanges: newAppliedChanges,
      };
    });
    logger.info('[CODER] Accepted diff:', toolCallId);
  }, []);

  const rejectDiff = useCallback(async (toolCallId: string) => {
    const diff = state.pendingDiffs.get(toolCallId);
    if (!diff || !chatId) return;

    // Revert the file content to before state
    try {
      const response = await fetch(apiUrl('/api/coder-workspace/file'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          path: diff.filePath,
          content: diff.before,
        }),
      });

      const data = await response.json();
      if (data.success) {
        // Update the document if it's open
        setState(prev => {
          const newPendingDiffs = new Map(prev.pendingDiffs);
          newPendingDiffs.delete(toolCallId);

          if (prev.tabDocuments[diff.filePath]) {
            const updatedDoc = {
              ...prev.tabDocuments[diff.filePath],
              content: diff.before,
              originalContent: diff.before,
            };
            return {
              ...prev,
              pendingDiffs: newPendingDiffs,
              tabDocuments: {
                ...prev.tabDocuments,
                [diff.filePath]: updatedDoc,
              },
              currentDocument: prev.activeTabPath === diff.filePath ? updatedDoc : prev.currentDocument,
            };
          }

          return { ...prev, pendingDiffs: newPendingDiffs };
        });
        logger.info('[CODER] Rejected diff:', toolCallId);
      }
    } catch (err) {
      logger.error('[CODER] Failed to reject diff:', err);
    }
  }, [chatId, state.pendingDiffs]);

  const acceptAllDiffs = useCallback(() => {
    setState(prev => {
      const newAppliedChanges = new Set(prev.appliedChanges);
      prev.pendingDiffs.forEach((_, toolCallId) => {
        newAppliedChanges.add(toolCallId);
      });
      return {
        ...prev,
        pendingDiffs: new Map(),
        appliedChanges: newAppliedChanges,
      };
    });
    logger.info('[CODER] Accepted all diffs');
  }, []);

  const rejectAllDiffs = useCallback(async () => {
    const diffsToReject = Array.from(state.pendingDiffs.entries());
    for (const [toolCallId] of diffsToReject) {
      await rejectDiff(toolCallId);
    }
    logger.info('[CODER] Rejected all diffs');
  }, [state.pendingDiffs, rejectDiff]);

  // Checkpoint management functions
  const addCheckpoint = useCallback((data: Omit<Checkpoint, 'id' | 'timestamp'>) => {
    const checkpoint: Checkpoint = {
      ...data,
      id: `checkpoint_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
    };
    setState(prev => ({
      ...prev,
      checkpoints: [...prev.checkpoints, checkpoint],
    }));
    logger.info('[CODER] Added checkpoint:', checkpoint.id);
  }, []);

  const revertToCheckpoint = useCallback(async (checkpointId: string) => {
    // This would revert files to the state at the checkpoint
    // Implementation depends on how we store checkpoint data
    logger.info('[CODER] Reverting to checkpoint:', checkpointId);
    // TODO: Implement full checkpoint revert logic
  }, []);

  // Plan management functions
  const updatePlan = useCallback((plan: Plan | null) => {
    setState(prev => ({ ...prev, currentPlan: plan }));
    logger.info('[CODER] Updated plan:', plan?.description);
  }, []);

  const updateStepStatus = useCallback((
    stepId: string,
    status: 'pending' | 'in_progress' | 'completed' | 'failed',
    result?: string
  ) => {
    setState(prev => {
      if (!prev.currentPlan) return prev;

      const updatedSteps = prev.currentPlan.steps.map(step =>
        step.id === stepId ? { ...step, status, result } : step
      );

      return {
        ...prev,
        currentPlan: {
          ...prev.currentPlan,
          steps: updatedSteps,
        },
      };
    });
    logger.info('[CODER] Updated step status:', stepId, status);
  }, []);

  // Activity panel management
  const setActivityPanelTab = useCallback((tab: 'activity' | 'plan' | 'checkpoints' | 'context' | 'timeline') => {
    setState(prev => ({ ...prev, activityPanelTab: tab }));
  }, []);

  // Listen for file changes from coder agent
  useEffect(() => {
    if (!chatId) return;

    let refreshDebounceTimer: NodeJS.Timeout | null = null;

    const scheduleFileTreeRefresh = () => {
      // Debounce file tree refresh to avoid excessive API calls
      if (refreshDebounceTimer) {
        clearTimeout(refreshDebounceTimer);
      }

      refreshDebounceTimer = setTimeout(() => {
        logger.info('[CODER_CTX] Refreshing file tree after coder agent file operations');
        loadFileTree();
        refreshDebounceTimer = null;
      }, 500); // 500ms debounce
    };

    const handleCoderFileChange = (event: CustomEvent) => {
      const detail = event.detail;

      // Only handle events for this chat's workspace
      if (detail.chatId !== chatId) {
        return;
      }

      const filePath = detail.filePath;
      const operation = detail.operation;
      const newContent = detail.content;

      logger.info(`[CODER_CTX] File change detected: ${operation} -> ${filePath}`);

      // Always refresh file tree for any file operation
      scheduleFileTreeRefresh();

      setState(prev => {
        // Handle file move/rename
        if (operation === 'move' && detail.previousPath) {
          const oldPath = detail.previousPath;
          const newPath = filePath;

          // Update open tabs
          const updatedTabs = prev.openTabs.map(tab => tab === oldPath ? newPath : tab);
          const updatedTabDocs = { ...prev.tabDocuments };

          if (updatedTabDocs[oldPath]) {
            updatedTabDocs[newPath] = {
              ...updatedTabDocs[oldPath],
              filePath: newPath,
            };
            delete updatedTabDocs[oldPath];
          }

          // Update active tab and current document if needed
          const newActiveTabPath = prev.activeTabPath === oldPath ? newPath : prev.activeTabPath;
          const newCurrentDocument = prev.activeTabPath === oldPath && updatedTabDocs[newPath]
            ? updatedTabDocs[newPath]
            : prev.currentDocument;

          logger.info(`[CODER_CTX] File moved: ${oldPath} -> ${newPath}`);

          return {
            ...prev,
            openTabs: updatedTabs,
            tabDocuments: updatedTabDocs,
            activeTabPath: newActiveTabPath,
            currentDocument: newCurrentDocument,
          };
        }

        // Handle file write/edit - update content if file is open
        if ((operation === 'write' || operation === 'edit') && newContent !== null) {
          const isFileOpen = prev.openTabs.includes(filePath);

          if (!isFileOpen) {
            // File not open in editor, just refresh file tree (already scheduled above)
            return prev;
          }

          const existingDoc = prev.tabDocuments[filePath];
          if (!existingDoc) {
            return prev;
          }

          // Check if user has unsaved changes
          const hasUnsavedChanges = prev.unsavedFiles.has(filePath);

          if (hasUnsavedChanges) {
            // Don't overwrite user's unsaved changes, but log it
            logger.warn(`[CODER_CTX] File ${filePath} was modified by coder agent, but user has unsaved changes`);
            return prev;
          }

          // Update the document with new content from coder agent
          const updatedDoc: EditorDocument = {
            ...existingDoc,
            content: newContent,
            originalContent: newContent,
          };

          const updatedTabDocs = {
            ...prev.tabDocuments,
            [filePath]: updatedDoc,
          };

          // Update current document if it's the active one
          const newCurrentDocument = prev.activeTabPath === filePath
            ? updatedDoc
            : prev.currentDocument;

          logger.info(`[CODER_CTX] Updated file content live: ${filePath} (${newContent.length} chars)`);

          return {
            ...prev,
            tabDocuments: updatedTabDocs,
            currentDocument: newCurrentDocument,
          };
        }

        return prev;
      });
    };

    window.addEventListener('coderFileChange', handleCoderFileChange as EventListener);
    logger.info('[CODER_CTX] Listening for coder file changes');

    return () => {
      if (refreshDebounceTimer) {
        clearTimeout(refreshDebounceTimer);
      }
      window.removeEventListener('coderFileChange', handleCoderFileChange as EventListener);
      logger.info('[CODER_CTX] Stopped listening for coder file changes');
    };
  }, [chatId, loadFileTree]);

  // Load workspace on mount
  useEffect(() => {
    if (chatId) {
      (async () => {
        try {
          const response = await fetch(apiUrl(`/api/coder-workspace/get?chat_id=${chatId}`));
          const data = await response.json();

          if (data.success && data.workspace_path) {
            setState(prev => ({
              ...prev,
              workspacePath: data.workspace_path,
              workspaceName: data.workspace_name || data.workspace_path,
              hasWorkspace: true,
            }));
            await loadFileTree();

            // Signal that workspace is fully loaded and ready
            if (onWorkspaceReady) {
              logger.info('[CODER_CTX] Workspace loaded on mount, calling onWorkspaceReady callback');
              onWorkspaceReady();
            }
          }
        } catch (err) {
          logger.error('[CODER] Failed to load workspace:', err);
        }
      })();
    }
  }, [chatId, loadFileTree, onWorkspaceReady]);

  const value: CoderState & CoderActions = {
    ...state,
    setWorkspace,
    loadFileTree,
    loadDeeper,
    toggleFolder,
    selectFile,
    selectNode,
    toggleMultiSelect,
    clearMultiSelect,
    selectRange,
    openTab,
    closeTab,
    switchToTab,
    reorderTabs,
    updateFileContent,
    saveFile,
    resetFile,
    revertToSaved,
    saveSnapshot,
    createFile,
    createFolder,
    deleteNode,
    deleteMultipleNodes,
    renameNode,
    setActiveTab: (tab) => setState(prev => ({ ...prev, activeTab: tab })),
    setSearchQuery: (query) => setState(prev => ({ ...prev, searchQuery: query })),
    toggleTerminal: () => setState(prev => ({ ...prev, showTerminal: !prev.showTerminal })),
    setTerminalHeight: (height) => setState(prev => ({ ...prev, terminalHeight: height })),
    setSidebarWidth: (width) => setState(prev => ({ ...prev, sidebarWidth: width })),
    setError,
    startCreatingFile,
    startCreatingFolder,
    cancelCreating,
    finishCreating,
    // Split editor actions
    splitEditorHorizontal,
    splitEditorVertical,
    closeSplit,
    switchPane,
    openTabInPane,
    // Diff management actions
    addPendingDiff,
    acceptDiff,
    rejectDiff,
    acceptAllDiffs,
    rejectAllDiffs,
    // Checkpoint actions
    addCheckpoint,
    revertToCheckpoint,
    // Plan actions
    updatePlan,
    updateStepStatus,
    // Activity panel actions
    setActivityPanelTab,
  };

  return <CoderContext.Provider value={value}>{children}</CoderContext.Provider>;
};
