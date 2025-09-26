import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BrowserStorage,
  DEFAULT_SOURCE_PREFERENCES,
  SourceInclusionState,
  SourcePane,
  SourcePreferences
} from '../../utils/storage/BrowserStorage';
import {
  SOURCE_COLLECTIONS,
  SOURCE_TAGS,
  SourceCollections,
  SourceNode,
  SourceStateSnapshot,
  SourceStatistics,
  SourceTagCategory,
  SourceTagDefinition,
  SourceVisualState,
  TAG_MAP,
  buildSourceIndices,
  buildStateMap,
  buildStatistics,
  flattenNodes
} from '../../constants/sources';

type PreferencesUpdater = SourcePreferences | ((prev: SourcePreferences) => SourcePreferences);

interface FilteredResult {
  tree: SourceNode[];
  flat: SourceNode[];
  searchExpansions: Set<string>;
}

export interface SourceManagerSnapshot {
  collections: SourceCollections;
  activePane: SourcePane;
  setActivePane: (pane: SourcePane) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  selectedTagIds: string[];
  toggleTag: (tagId: string) => void;
  clearFilters: () => void;
  filteredTree: SourceNode[];
  filteredFlat: SourceNode[];
  selectedNode: SourceNode | null;
  selectNode: (nodeId: string | null) => void;
  isExpanded: (nodeId: string) => boolean;
  toggleExpansion: (nodeId: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  stateMap: Map<string, SourceStateSnapshot>;
  getNodeState: (nodeId: string) => SourceStateSnapshot | undefined;
  toggleInclusion: (node: SourceNode) => void;
  setNodeInclusion: (nodeId: string, state?: SourceInclusionState) => void;
  statistics: SourceStatistics;
  breadcrumbsFor: (nodeId: string | null) => SourceNode[];
  tagsByCategory: Map<SourceTagCategory, SourceTagDefinition[]>;
}

const SOURCE_INDICES = buildSourceIndices(SOURCE_COLLECTIONS);

const TAGS_BY_CATEGORY = SOURCE_TAGS.reduce<Map<SourceTagCategory, SourceTagDefinition[]>>(
  (acc, tag) => {
    const existing = acc.get(tag.category) ?? [];
    acc.set(tag.category, [...existing, tag]);
    return acc;
  },
  new Map()
);

const normalisePreferences = (prefs: SourcePreferences): SourcePreferences => ({
  ...DEFAULT_SOURCE_PREFERENCES,
  ...prefs,
  expandedNodes: {
    ...DEFAULT_SOURCE_PREFERENCES.expandedNodes,
    ...(prefs.expandedNodes ?? {})
  },
  selectedNodeIds: {
    ...DEFAULT_SOURCE_PREFERENCES.selectedNodeIds,
    ...(prefs.selectedNodeIds ?? {})
  },
  selectedTagIds: Array.isArray(prefs.selectedTagIds) ? prefs.selectedTagIds : [],
  inclusionOverrides: prefs.inclusionOverrides ?? {}
});

const matchesSearch = (node: SourceNode, query: string): boolean => {
  if (!query) return true;
  const lower = query.toLowerCase();
  return (
    node.name.toLowerCase().includes(lower) ||
    (node.description?.toLowerCase().includes(lower) ?? false) ||
    node.tagIds.some(tagId => TAG_MAP.get(tagId)?.label.toLowerCase().includes(lower))
  );
};

const matchesTags = (node: SourceNode, selectedTags: string[]): boolean => {
  if (selectedTags.length === 0) return true;
  return selectedTags.every(tag => node.tagIds.includes(tag));
};

const filterNodes = (
  nodes: SourceNode[],
  query: string,
  selectedTags: string[]
): SourceNode[] => {
  if (!query && selectedTags.length === 0) {
    return nodes;
  }

  const filtered: SourceNode[] = [];

  nodes.forEach(node => {
    const children = node.children ? filterNodes(node.children, query, selectedTags) : [];
    const matches = matchesSearch(node, query) && matchesTags(node, selectedTags);

    if (matches || children.length > 0) {
      filtered.push({
        ...node,
        children
      });
    }
  });

  return filtered;
};

const computeSearchExpansions = (
  filteredTree: SourceNode[],
  searchQuery: string
): Set<string> => {
  const expansions = new Set<string>();

  if (!searchQuery.trim()) {
    return expansions;
  }

  const findMatchingNodes = (nodes: SourceNode[], path: SourceNode[] = []): void => {
    nodes.forEach(node => {
      const currentPath = [...path, node];

      if (matchesSearch(node, searchQuery)) {
        // Add all ancestors in the path to expansions
        path.forEach(ancestor => {
          if (ancestor.children && ancestor.children.length > 0) {
            expansions.add(ancestor.id);
          }
        });
      }

      if (node.children && node.children.length > 0) {
        findMatchingNodes(node.children, currentPath);
      }
    });
  };

  findMatchingNodes(filteredTree);
  return expansions;
};

const computeFiltered = (
  collections: SourceCollections,
  pane: SourcePane,
  query: string,
  selectedTags: string[]
): FilteredResult => {
  const tree = filterNodes(collections[pane], query, selectedTags);
  const flat = flattenNodes(tree);
  const searchExpansions = computeSearchExpansions(tree, query);
  return { tree, flat, searchExpansions };
};

export const useSourceManager = (): SourceManagerSnapshot => {
  const [preferences, setPreferences] = useState<SourcePreferences>(() =>
    normalisePreferences(BrowserStorage.getSourcePreferences())
  );

  useEffect(() => {
    BrowserStorage.setSourcePreferences(preferences);
  }, [preferences]);

  const updatePreferences = useCallback((updater: PreferencesUpdater) => {
    setPreferences(prev => {
      const next = typeof updater === 'function' ? (updater as (p: SourcePreferences) => SourcePreferences)(prev) : updater;
      return normalisePreferences(next);
    });
  }, []);

  const { activePane, searchQuery, selectedTagIds } = preferences;

  const filtered = useMemo(
    () => computeFiltered(SOURCE_COLLECTIONS, activePane, searchQuery.trim(), selectedTagIds),
    [activePane, searchQuery, selectedTagIds]
  );

  const stateMap = useMemo(
    () => buildStateMap(SOURCE_COLLECTIONS, preferences.inclusionOverrides),
    [preferences.inclusionOverrides]
  );

  const statistics = useMemo(
    () => buildStatistics(SOURCE_COLLECTIONS, preferences.inclusionOverrides, stateMap),
    [stateMap, preferences.inclusionOverrides]
  );

  useEffect(() => {
    if (filtered.flat.length === 0) {
      if (preferences.selectedNodeIds[activePane]) {
        updatePreferences(prev => ({
          ...prev,
          selectedNodeIds: {
            ...prev.selectedNodeIds,
            [activePane]: null
          }
        }));
      }
      return;
    }

    const current = preferences.selectedNodeIds[activePane];
    const isPresent = current ? filtered.flat.some(node => node.id === current) : false;
    if (!isPresent) {
      const fallbackId = filtered.flat[0]?.id ?? null;
      updatePreferences(prev => ({
        ...prev,
        selectedNodeIds: {
          ...prev.selectedNodeIds,
          [activePane]: fallbackId
        }
      }));
    }
  }, [filtered.flat, activePane, preferences.selectedNodeIds, updatePreferences]);

  const selectedNodeId = preferences.selectedNodeIds[activePane];
  const selectedNode = selectedNodeId ? SOURCE_INDICES.index.get(selectedNodeId) ?? null : null;

  const expandedSet = useMemo(() => new Set(preferences.expandedNodes[activePane] ?? []), [preferences.expandedNodes, activePane]);

  const isExpanded = useCallback(
    (nodeId: string) => {
      const normallyExpanded = expandedSet.has(nodeId);
      const searchExpanded = filtered.searchExpansions.has(nodeId);
      return normallyExpanded || searchExpanded;
    },
    [expandedSet, filtered.searchExpansions]
  );

  const toggleExpansion = useCallback(
    (nodeId: string) => {
      updatePreferences(prev => {
        const paneKey = activePane;
        const paneExpanded = new Set(prev.expandedNodes[paneKey] ?? []);
        if (paneExpanded.has(nodeId)) {
          paneExpanded.delete(nodeId);
        } else {
          paneExpanded.add(nodeId);
        }
        return {
          ...prev,
          expandedNodes: {
            ...prev.expandedNodes,
            [paneKey]: Array.from(paneExpanded)
          }
        };
      });
    },
    [activePane, updatePreferences]
  );

  const expandAll = useCallback(() => {
    updatePreferences(prev => ({
      ...prev,
      expandedNodes: {
        ...prev.expandedNodes,
        [activePane]: [...SOURCE_INDICES.nodesByPane[activePane]]
      }
    }));
  }, [activePane, updatePreferences]);

  const collapseAll = useCallback(() => {
    updatePreferences(prev => ({
      ...prev,
      expandedNodes: {
        ...prev.expandedNodes,
        [activePane]: []
      }
    }));
  }, [activePane, updatePreferences]);

  const setActivePane = useCallback(
    (pane: SourcePane) => {
      updatePreferences(prev => ({
        ...prev,
        activePane: pane
      }));
    },
    [updatePreferences]
  );

  const setSearchQuery = useCallback(
    (query: string) => {
      updatePreferences(prev => ({
        ...prev,
        searchQuery: query
      }));
    },
    [updatePreferences]
  );

  const toggleTag = useCallback(
    (tagId: string) => {
      updatePreferences(prev => {
        const exists = prev.selectedTagIds.includes(tagId);
        const nextTags = exists
          ? prev.selectedTagIds.filter(id => id !== tagId)
          : [...prev.selectedTagIds, tagId];
        return {
          ...prev,
          selectedTagIds: nextTags
        };
      });
    },
    [updatePreferences]
  );

  const clearFilters = useCallback(() => {
    updatePreferences(prev => ({
      ...prev,
      selectedTagIds: []
    }));
  }, [updatePreferences]);

  const selectNode = useCallback(
    (nodeId: string | null) => {
      updatePreferences(prev => ({
        ...prev,
        selectedNodeIds: {
          ...prev.selectedNodeIds,
          [activePane]: nodeId
        }
      }));
    },
    [activePane, updatePreferences]
  );

  const setNodeInclusion = useCallback(
    (nodeId: string, state?: SourceInclusionState) => {
      updatePreferences(prev => {
        const overrides = { ...prev.inclusionOverrides };
        if (state) {
          overrides[nodeId] = state;
        } else {
          delete overrides[nodeId];
        }
        return {
          ...prev,
          inclusionOverrides: overrides
        };
      });
    },
    [updatePreferences]
  );

  const toggleInclusion = useCallback(
    (node: SourceNode) => {
      const snapshot = stateMap.get(node.id);
      const explicit = preferences.inclusionOverrides[node.id];
      let nextState: SourceInclusionState | undefined;

      if (!snapshot) {
        nextState = 'excluded';
      } else if (snapshot.visualState === 'excluded') {
        if (explicit === 'excluded') {
          nextState = undefined;
        } else {
          nextState = 'included';
        }
      } else if (snapshot.visualState === 'partial') {
        nextState = 'excluded';
      } else {
        if (explicit === 'included') {
          nextState = undefined;
        } else {
          nextState = 'excluded';
        }
      }

      setNodeInclusion(node.id, nextState);
    },
    [preferences.inclusionOverrides, setNodeInclusion, stateMap]
  );

  const getNodeState = useCallback(
    (nodeId: string) => stateMap.get(nodeId),
    [stateMap]
  );

  const breadcrumbsFor = useCallback(
    (nodeId: string | null) => {
      if (!nodeId) return [];
      const crumbs: SourceNode[] = [];
      let current: string | null | undefined = nodeId;
      while (current) {
        const node = SOURCE_INDICES.index.get(current);
        if (!node) break;
        crumbs.unshift(node);
        current = SOURCE_INDICES.parentMap.get(current) ?? null;
      }
      return crumbs;
    },
    []
  );

  return {
    collections: SOURCE_COLLECTIONS,
    activePane,
    setActivePane,
    searchQuery,
    setSearchQuery,
    selectedTagIds,
    toggleTag,
    clearFilters,
    filteredTree: filtered.tree,
    filteredFlat: filtered.flat,
    selectedNode,
    selectNode,
    isExpanded,
    toggleExpansion,
    expandAll,
    collapseAll,
    stateMap,
    getNodeState,
    toggleInclusion,
    setNodeInclusion,
    statistics,
    breadcrumbsFor,
    tagsByCategory: TAGS_BY_CATEGORY
  };
};

export const getTagDefinition = (tagId: string): SourceTagDefinition | undefined => TAG_MAP.get(tagId);

export const getVisualStateColor = (state: SourceVisualState): string => {
  switch (state) {
    case 'included':
      return '#6cc6ff';
    case 'excluded':
      return '#ff829a';
    default:
      return '#f5c96a';
  }
};
