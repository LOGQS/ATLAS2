// status: complete

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiUrl } from '../../config/api';
import logger from '../../utils/core/logger';

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

interface FilesystemChangeDetail {
  action: 'created' | 'deleted' | 'modified' | 'moved';
  path: string;
  previousPath: string | null;
  isDirectory: boolean;
}

export const useFileBrowser = (isOpen: boolean) => {
  const [tree, setTree] = useState<FileBrowserNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));

  const mountedRef = useRef(false);

  const fetchTree = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(apiUrl('/api/file-browser/tree'));
      const data = await response.json();
      if (!response.ok || data?.success === false) {
        const message = data?.error || `Failed to load workspace (status ${response.status})`;
        throw new Error(message);
      }
      const root = data.root as FileBrowserNode;
      setTree(root);
      setError(null);

      setExpanded((prev) => {
        const next = new Set(prev);
        ensureParentsExpanded(selectedPath, next);
        if (!next.has('')) {
          next.add('');
        }
        return next;
      });

      if (!selectedPath) {
        setSelectedPath('');
      } else {
        const existing = findNodeByPath(root, selectedPath);
        if (!existing) {
          setSelectedPath('');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load workspace files';
      logger.error('[FILE_BROWSER] Failed to fetch tree', err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [selectedPath]);

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
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(previousPath)) {
            next.delete(previousPath);
            ensureParentsExpanded(nextPath, next);
          }
          return next;
        });
      }
    };

    window.addEventListener('filesystemChange', handler as EventListener);
    return () => window.removeEventListener('filesystemChange', handler as EventListener);
  }, [fetchTree, isOpen]);
  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        ensureParentsExpanded(path, next);
      }
      return next;
    });
  }, []);

  const selectPath = useCallback((path: string) => {
    setSelectedPath(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      ensureParentsExpanded(path, next);
      return next;
    });
  }, []);

  const performAction = useCallback(async (request: Promise<Response>, actionLabel: string) => {
    try {
      const response = await request;
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        const message = data?.error || `${actionLabel} failed (status ${response.status})`;
        throw new Error(message);
      }
      setError(null);
      await fetchTree();
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : `${actionLabel} failed`;
      logger.error(`[FILE_BROWSER] ${actionLabel} error`, err);
      setError(message);
      throw err;
    }
  }, [fetchTree]);

  const createNode = useCallback(async (parentPath: string, name: string, type: FileBrowserNodeType, content?: string) => {
    const body: Record<string, unknown> = { parent_path: parentPath, name, type };
    if (type === 'file') {
      body.content = content ?? '';
    }
    await performAction(
      fetch(apiUrl('/api/file-browser/nodes'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }),
      'Create'
    );
    setExpanded((prev) => {
      const next = new Set(prev);
      ensureParentsExpanded(parentPath, next);
      return next;
    });
  }, [performAction]);

  const renameNode = useCallback(async (path: string, newName: string) => {
    const data = await performAction(
      fetch(apiUrl('/api/file-browser/nodes'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, new_name: newName })
      }),
      'Rename'
    );
    const updatedPath = data?.node?.path as string | undefined;
    if (updatedPath) {
      setSelectedPath((prev) => {
        if (!prev) return prev;
        if (prev === path) {
          return updatedPath;
        }
        if (prev.startsWith(`${path}/`)) {
          const suffix = prev.slice(path.length + 1);
          return suffix ? `${updatedPath}/${suffix}` : updatedPath;
        }
        return prev;
      });
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
          ensureParentsExpanded(updatedPath, next);
        }
        const descendants = Array.from(next).filter((key) => key.startsWith(`${path}/`));
        descendants.forEach((key) => {
          next.delete(key);
          const suffix = key.slice(path.length + 1);
          if (suffix) {
            ensureParentsExpanded(`${updatedPath}/${suffix}`, next);
          } else {
            ensureParentsExpanded(updatedPath, next);
          }
        });
        return next;
      });
    }
  }, [performAction]);

  const deleteNode = useCallback(async (path: string) => {
    await performAction(
      fetch(apiUrl('/api/file-browser/nodes'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      }),
      'Delete'
    );
    if (selectedPath.startsWith(path)) {
      setSelectedPath('');
    }
  }, [performAction, selectedPath]);

  const selectedNode = useMemo(() => findNodeByPath(tree, selectedPath) || tree, [tree, selectedPath]);

  const clearError = useCallback(() => setError(null), []);

  return {
    root: tree,
    loading,
    error,
    clearError,
    selectedPath,
    selectedNode,
    expanded,
    toggleExpand,
    selectPath,
    refresh: fetchTree,
    createNode,
    renameNode,
    deleteNode
  };
};
