// status: complete

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiUrl } from '../../config/api';
import logger from '../../utils/core/logger';
import { usePendingOps } from '../ui/usePendingOps';

export type FileBrowserNodeType = 'file' | 'directory';

export interface FileBrowserNode {
  name: string;
  path: string;
  type: FileBrowserNodeType;
  modified: string;
  size?: number;
  item_count?: number;
  children?: FileBrowserNode[];
}

interface LiveFileBrowserState {
  tree: FileBrowserNode | null;
  selectedPath: string;
  expanded: Set<string>;
}

const findNodeByPath = (node: FileBrowserNode | null, path: string): FileBrowserNode | null => {
  if (!node) return null;
  if (node.path === path) return node;
  if (node.type === 'directory' && node.children) {
    for (const child of node.children) {
      const match = findNodeByPath(child, path);
      if (match) return match;
    }
  }
  return null;
};

const ensureParentsExpanded = (path: string, expanded: Set<string>) => {
  if (!path) {
    expanded.add('');
    return;
  }
  const segments = path.split('/');
  let current = '';
  segments.forEach((segment) => {
    current = current ? `${current}/${segment}` : segment;
    expanded.add(current);
  });
};

const updateTreeNode = (
  tree: FileBrowserNode | null,
  targetPath: string,
  updater: (node: FileBrowserNode) => FileBrowserNode | null
): FileBrowserNode | null => {
  if (!tree) return null;

  if (tree.path === targetPath) {
    return updater(tree);
  }

  if (tree.type === 'directory' && tree.children) {
    const updatedChildren = tree.children
      .map(child => updateTreeNode(child, targetPath, updater))
      .filter((child): child is FileBrowserNode => child !== null);

    return {
      ...tree,
      children: updatedChildren,
      item_count: tree.type === 'directory' ? updatedChildren.length : tree.item_count
    };
  }

  return tree;
};

const addNodeToTree = (
  tree: FileBrowserNode | null,
  parentPath: string,
  newNode: FileBrowserNode
): FileBrowserNode | null => {
  if (!tree) return null;

  if (tree.path === parentPath && tree.type === 'directory') {
    const children = tree.children || [];
    const updatedChildren = [...children, newNode].sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return {
      ...tree,
      children: updatedChildren,
      item_count: updatedChildren.length
    };
  }

  if (tree.type === 'directory' && tree.children) {
    const updatedChildren = tree.children.map(child =>
      addNodeToTree(child, parentPath, newNode)
    ).filter((child): child is FileBrowserNode => child !== null);

    return {
      ...tree,
      children: updatedChildren
    };
  }

  return tree;
};

const removeNodeFromTree = (
  tree: FileBrowserNode | null,
  targetPath: string
): FileBrowserNode | null => {
  if (!tree) return null;

  if (tree.path === targetPath) {
    return null; 
  }

  if (tree.type === 'directory' && tree.children) {
    const updatedChildren = tree.children
      .map(child => removeNodeFromTree(child, targetPath))
      .filter((child): child is FileBrowserNode => child !== null);

    return {
      ...tree,
      children: updatedChildren,
      item_count: updatedChildren.length
    };
  }

  return tree;
};

interface FilesystemChangeDetail {
  action: 'created' | 'deleted' | 'modified' | 'moved';
  path: string;
  previousPath: string | null;
  isDirectory: boolean;
}

export const useLiveFileBrowser = (isOpen: boolean) => {
  const [baseState, setBaseState] = useState<LiveFileBrowserState>({
    tree: null,
    selectedPath: '',
    expanded: new Set([''])
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(false);
  const baseStateRef = useRef(baseState);
  baseStateRef.current = baseState;

  const pendingOps = usePendingOps({
    onError: (operationId, error, operation) => {
      logger.error(`[LiveFileBrowser] Operation ${operation.type} failed:`, error);
      setError(`${operation.type} failed: ${error.message}`);
    },
    onSuccess: (operationId, result) => {
      if (result?.shouldRefresh) {
        fetchTree();
      }
    },
    errorTimeout: 8000,
    maxRetries: 1
  });

  const fetchTree = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(apiUrl('/api/file-browser/tree'));
      const data = await response.json();
      if (!response.ok || data?.success === false) {
        const message = data?.error || `Failed to load workspace (status ${response.status})`;
        throw new Error(message);
      }

      const root = data.root as FileBrowserNode;
      setBaseState(prev => {
        const newExpanded = new Set(prev.expanded);
        ensureParentsExpanded(prev.selectedPath, newExpanded);
        if (!newExpanded.has('')) {
          newExpanded.add('');
        }

        let newSelectedPath = prev.selectedPath;
        if (newSelectedPath && !findNodeByPath(root, newSelectedPath)) {
          newSelectedPath = '';
        }

        return {
          tree: root,
          selectedPath: newSelectedPath,
          expanded: newExpanded
        };
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load workspace files';
      logger.error('[LiveFileBrowser] Failed to fetch tree', err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    fetchTree();
  }, [isOpen, fetchTree]);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<FilesystemChangeDetail>;
      const detail = custom.detail;
      if (!mountedRef.current) return;
      if (isOpen) {
        fetchTree();
      }

      if (detail?.action === 'moved' && detail.previousPath) {
        const previousPath = detail.previousPath;
        const nextPath = detail.path || '';
        setBaseState(prev => ({
          ...prev,
          expanded: ((oldExpanded) => {
            const next = new Set(oldExpanded);
            if (next.has(previousPath)) {
              next.delete(previousPath);
              ensureParentsExpanded(nextPath, next);
            }
            return next;
          })(prev.expanded)
        }));
      }
    };

    window.addEventListener('filesystemChange', handler as EventListener);
    return () => window.removeEventListener('filesystemChange', handler as EventListener);
  }, [fetchTree, isOpen]);

  const toggleExpand = useCallback((path: string) => {
    setBaseState(prev => {
      const next = new Set(prev.expanded);
      if (next.has(path)) {
        next.delete(path);
      } else {
        ensureParentsExpanded(path, next);
      }
      return { ...prev, expanded: next };
    });
  }, []);

  const selectPath = useCallback((path: string) => {
    setBaseState(prev => {
      const next = new Set(prev.expanded);
      ensureParentsExpanded(path, next);
      return {
        ...prev,
        selectedPath: path,
        expanded: next
      };
    });
  }, []);

  const createNode = useCallback(async (parentPath: string, name: string, type: FileBrowserNodeType, content?: string) => {
    const newPath = parentPath ? `${parentPath}/${name}` : name;
    const newNode: FileBrowserNode = {
      name,
      path: newPath,
      type,
      modified: new Date().toISOString(),
      size: type === 'file' ? (content?.length || 0) : undefined,
      item_count: type === 'directory' ? 0 : undefined,
      children: type === 'directory' ? [] : undefined
    };

    const applyChange = () => {
      setBaseState(prev => ({
        ...prev,
        tree: addNodeToTree(prev.tree, parentPath, newNode),
        expanded: ((oldExpanded) => {
          const next = new Set(oldExpanded);
          ensureParentsExpanded(parentPath, next);
          return next;
        })(prev.expanded)
      }));
    };

    const rollback = () => {
      setBaseState(prev => ({
        ...prev,
        tree: removeNodeFromTree(prev.tree, newPath)
      }));
    };

    const serverRequest = async () => {
      const body: Record<string, unknown> = { parent_path: parentPath, name, type };
      if (type === 'file') {
        body.content = content ?? '';
      }

      const response = await fetch(apiUrl('/api/file-browser/nodes'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        const message = data?.error || `Create failed (status ${response.status})`;
        throw new Error(message);
      }

      return data;
    };

    return pendingOps.execute(
      'create',
      { parentPath, name, type, content },
      applyChange,
      rollback,
      serverRequest()
    );
  }, [pendingOps]);

  const renameNode = useCallback(async (path: string, newName: string) => {
    const node = findNodeByPath(baseState.tree, path);
    if (!node) {
      throw new Error('Node not found');
    }

    const pathParts = path.split('/');
    const newPath = pathParts.length > 1
      ? pathParts.slice(0, -1).concat([newName]).join('/')
      : newName;

    const updatedNode = { ...node, name: newName, path: newPath };
    const originalNode = { ...node };

    const applyChange = () => {
      setBaseState(prev => {
        let newTree = updateTreeNode(prev.tree, path, () => updatedNode);

        let newSelectedPath = prev.selectedPath;
        if (prev.selectedPath === path) {
          newSelectedPath = newPath;
        } else if (prev.selectedPath.startsWith(`${path}/`)) {
          const suffix = prev.selectedPath.slice(path.length + 1);
          newSelectedPath = `${newPath}/${suffix}`;
        }

        const newExpanded = new Set(prev.expanded);
        if (newExpanded.has(path)) {
          newExpanded.delete(path);
          ensureParentsExpanded(newPath, newExpanded);
        }
        const descendants = Array.from(newExpanded).filter(key => key.startsWith(`${path}/`));
        descendants.forEach(key => {
          newExpanded.delete(key);
          const suffix = key.slice(path.length + 1);
          if (suffix) {
            ensureParentsExpanded(`${newPath}/${suffix}`, newExpanded);
          } else {
            ensureParentsExpanded(newPath, newExpanded);
          }
        });

        return {
          tree: newTree,
          selectedPath: newSelectedPath,
          expanded: newExpanded
        };
      });
    };

    const rollback = () => {
      setBaseState(prev => ({
        ...prev,
        tree: updateTreeNode(prev.tree, newPath, () => originalNode),
        selectedPath: prev.selectedPath === newPath ? path : prev.selectedPath
      }));
    };

    const serverRequest = async () => {
      const response = await fetch(apiUrl('/api/file-browser/nodes'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, new_name: newName })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        const message = data?.error || `Rename failed (status ${response.status})`;
        throw new Error(message);
      }

      return data;
    };

    return pendingOps.execute(
      'rename',
      { path, newName },
      applyChange,
      rollback,
      serverRequest()
    );
  }, [baseState.tree, pendingOps]);

  const deleteNode = useCallback(async (path: string) => {
    const node = findNodeByPath(baseState.tree, path);
    if (!node) {
      throw new Error('Node not found');
    }

    const originalTree = baseState.tree;

    const applyChange = () => {
      setBaseState(prev => ({
        ...prev,
        tree: removeNodeFromTree(prev.tree, path),
        selectedPath: prev.selectedPath.startsWith(path) ? '' : prev.selectedPath
      }));
    };

    const rollback = () => {
      setBaseState(prev => ({
        ...prev,
        tree: originalTree
      }));
    };

    const serverRequest = async () => {
      const response = await fetch(apiUrl('/api/file-browser/nodes'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        const message = data?.error || `Delete failed (status ${response.status})`;
        throw new Error(message);
      }

      return data;
    };

    return pendingOps.execute(
      'delete',
      { path },
      applyChange,
      rollback,
      serverRequest()
    );
  }, [baseState.tree, pendingOps]);

  const selectedNode = useMemo(() =>
    findNodeByPath(baseState.tree, baseState.selectedPath) || baseState.tree,
    [baseState.tree, baseState.selectedPath]
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    root: baseState.tree,
    loading,
    error,
    clearError,
    selectedPath: baseState.selectedPath,
    selectedNode,
    expanded: baseState.expanded,
    toggleExpand,
    selectPath,
    refresh: fetchTree,
    createNode,
    renameNode,
    deleteNode,
    isPending: pendingOps.isPending,
    hasError: pendingOps.hasError,
    getError: pendingOps.getError,
    retry: pendingOps.retry,
    pendingOperations: pendingOps.getPendingOperations(),
    errors: pendingOps.getErrors()
  };
};