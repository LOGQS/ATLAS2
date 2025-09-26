import React, { useMemo } from 'react';
import '../styles/sections/SourcesWindow.css';
import { SourceNode, SourceTagCategory } from '../constants/sources';
import {
  SourceManagerSnapshot,
  getTagDefinition,
  getVisualStateColor,
  useSourceManager
} from '../hooks/sources/useSourceManager';
import { SourceVisualState } from '../constants/sources';

const paneOptions: { id: SourceManagerSnapshot['activePane']; icon: string; label: string }[] = [
  { id: 'web', icon: '🌐', label: 'Web Sources' },
  { id: 'local', icon: '💾', label: 'Local Sources' }
];

const categoryLabels: Record<SourceTagCategory, string> = {
  modality: 'Modalities',
  format: 'Formats',
  type: 'Source Types',
  structure: 'Structures'
};

interface TagChipProps {
  tagId: string;
  interactive?: boolean;
  active?: boolean;
  condensed?: boolean;
  onClick?: () => void;
}

const TagChip: React.FC<TagChipProps> = ({ tagId, interactive, active, condensed, onClick }) => {
  const definition = getTagDefinition(tagId);
  if (!definition) return null;
  const className = [
    'source-tag-chip',
    interactive ? 'interactive' : '',
    active ? 'active' : '',
    condensed ? 'condensed' : ''
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <span className="chip-content" style={{ backgroundColor: definition.background, color: definition.accent }}>
      <span className="chip-icon">{definition.icon}</span>
      {!condensed && <span className="chip-label">{definition.label}</span>}
    </span>
  );

  if (interactive) {
    return (
      <button type="button" className={className} onClick={onClick} title={definition.description}>
        {content}
      </button>
    );
  }

  return (
    <div className={className} title={definition.description}>
      {content}
    </div>
  );
};

interface SourceTreeNodeProps {
  node: SourceNode;
  depth: number;
  manager: SourceManagerSnapshot;
  selectedId: string | null;
}

const SourceTreeNode: React.FC<SourceTreeNodeProps> = ({ node, depth, manager, selectedId }) => {
  const hasChildren = (node.children?.length ?? 0) > 0;
  const expanded = hasChildren ? manager.isExpanded(node.id) : false;
  const snapshot = manager.getNodeState(node.id);
  const visualState: SourceVisualState = snapshot?.visualState ?? 'included';
  const inclusionColor = getVisualStateColor(visualState);
  const displayedTags = useMemo(() => node.tagIds.slice(0, 3), [node.tagIds]);
  const overflowCount = node.tagIds.length - displayedTags.length;
  const isSelected = selectedId === node.id;

  return (
    <div className="sources-tree-node" style={{ paddingLeft: `${depth * 16}px` }}>
      <div
        className={`sources-tree-row ${isSelected ? 'selected' : ''}`}
        onClick={() => manager.selectNode(node.id)}
      >
        <div className="sources-tree-main">
          {hasChildren && (
            <button
              type="button"
              className={`sources-tree-expander ${expanded ? 'open' : ''}`}
              onClick={(event) => {
                event.stopPropagation();
                manager.toggleExpansion(node.id);
              }}
              aria-label={expanded ? 'Collapse source group' : 'Expand source group'}
            />
          )}
          <button
            type="button"
            className={`sources-inclusion-toggle ${visualState}`}
            style={{ borderColor: inclusionColor }}
            onClick={(event) => {
              event.stopPropagation();
              manager.toggleInclusion(node);
            }}
            title={
              visualState === 'excluded'
                ? 'Excluded from knowledge graph'
                : visualState === 'partial'
                  ? 'Partially included via overrides'
                  : 'Included in knowledge graph'
            }
          >
            <span className="toggle-indicator" style={{ background: inclusionColor }} />
          </button>
          <div className="sources-node-avatar" aria-hidden="true">
            {node.icon}
          </div>
          <div className="sources-node-text">
            <div className="sources-node-title">{node.name}</div>
            {node.metadata?.status && (
              <div className={`sources-node-status ${node.metadata.status}`}>
                {node.metadata.status === 'connected' && 'Connected'}
                {node.metadata.status === 'syncing' && 'Syncing'}
                {node.metadata.status === 'stale' && 'Needs refresh'}
                {node.metadata.status === 'disconnected' && 'Disconnected'}
              </div>
            )}
          </div>
        </div>
        <div className="sources-node-tags">
          {displayedTags.map(tagId => (
            <TagChip key={tagId} tagId={tagId} condensed />
          ))}
          {overflowCount > 0 && <span className="sources-node-tag-overflow">+{overflowCount}</span>}
        </div>
      </div>
      {hasChildren && expanded && (
        <div className="sources-tree-children">
          {node.children!.map(child => (
            <SourceTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              manager={manager}
              selectedId={selectedId}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const formatTimestamp = (value?: string): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const formatCount = (count?: number): string => {
  if (typeof count !== 'number') return '—';
  return count.toLocaleString();
};

const SourcesWindow: React.FC = () => {
  const manager = useSourceManager();
  const { activePane, selectedTagIds, searchQuery, statistics, selectedNode } = manager;

  const breadcrumbs = manager.breadcrumbsFor(selectedNode?.id ?? null);
  const snapshot = selectedNode ? manager.getNodeState(selectedNode.id) : undefined;
  const explicitState = snapshot?.explicitState;
  const effectiveState = snapshot?.effectiveState ?? 'included';

  const metadataEntries = useMemo(
    () => {
      if (!selectedNode) return [] as { label: string; value: string | React.ReactNode; tone?: string }[];
      const meta = selectedNode.metadata ?? {};
      return [
        {
          label: 'Status',
          value:
            meta.status === 'connected'
              ? 'Connected'
              : meta.status === 'syncing'
                ? 'Syncing'
                : meta.status === 'stale'
                  ? 'Needs refresh'
                  : meta.status === 'disconnected'
                    ? 'Disconnected'
                    : '—',
          tone: meta.status
        },
        {
          label: selectedNode.origin === 'web' ? 'Source URL' : 'Local Path',
          value:
            selectedNode.origin === 'web' && selectedNode.link ? (
              <a
                href={selectedNode.link}
                target="_blank"
                rel="noreferrer"
                className="sources-detail-link"
              >
                {selectedNode.link}
              </a>
            ) : selectedNode.origin === 'local' && selectedNode.path ? (
              <code>{selectedNode.path}</code>
            ) : (
              '—'
            )
        },
        {
          label: 'Last synced',
          value: formatTimestamp(meta.lastSynced)
        },
        {
          label: 'Last indexed',
          value: formatTimestamp(meta.lastIndexed)
        },
        {
          label: 'Item count',
          value: formatCount(meta.itemCount)
        },
        {
          label: 'Data size',
          value: meta.size ?? '—'
        },
        {
          label: 'Provider',
          value: meta.provider ?? '—'
        },
        {
          label: 'Location',
          value: meta.locationLabel ?? '—'
        },
        {
          label: 'Link depth',
          value: meta.linkDepth ?? '—'
        }
      ];
    },
    [selectedNode]
  );

  const filterActive = selectedTagIds.length > 0 || Boolean(searchQuery.trim());

  return (
    <div className="sources-window">
      <aside className="sources-pane-rail">
        {paneOptions.map(option => (
          <button
            key={option.id}
            type="button"
            className={`sources-pane-button ${activePane === option.id ? 'active' : ''}`}
            data-label={option.label}
            onClick={() => manager.setActivePane(option.id)}
            aria-pressed={activePane === option.id}
          >
            <span>{option.icon}</span>
          </button>
        ))}
      </aside>
      <div className="sources-main">
        <header className="sources-header">
          <div>
            <h2>Knowledge Sources</h2>
            <p>
              Curate and orchestrate your knowledge graph across web-connected feeds and on-device assets.
            </p>
          </div>
          <div className="sources-summary">
            <div className="summary-card">
              <span className="summary-label">Total</span>
              <span className="summary-value">{statistics.total}</span>
            </div>
            <div className="summary-card">
              <span className="summary-label">Included</span>
              <span className="summary-value accent">{statistics.included}</span>
            </div>
            <div className="summary-card">
              <span className="summary-label">Excluded</span>
              <span className="summary-value warning">{statistics.excluded}</span>
            </div>
            <div className="summary-card">
              <span className="summary-label">Overrides</span>
              <span className="summary-value subtle">{statistics.overrides}</span>
            </div>
          </div>
        </header>

        <div className="sources-controls">
          <div className="sources-search-field">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              placeholder={
                activePane === 'web'
                  ? 'Search documentation portals, feeds, and media…'
                  : 'Search folders, files, and knowledge drops…'
              }
              value={searchQuery}
              onChange={(event) => manager.setSearchQuery(event.target.value)}
            />
            <button
              type="button"
              className="search-clear"
              onClick={() => manager.setSearchQuery('')}
              aria-label="Clear search"
              style={{ visibility: searchQuery ? 'visible' : 'hidden' }}
            >
              ✕
            </button>
          </div>
          <button
            type="button"
            className="sources-clear-filters"
            onClick={manager.clearFilters}
            style={{ visibility: filterActive ? 'visible' : 'hidden' }}
          >
            Clear filters
          </button>
        </div>

        <div className="sources-tag-filters">
          {Array.from(manager.tagsByCategory.entries()).map(([category, tags]) => (
            <div key={category} className="tag-category-block">
              <div className="tag-category-label">{categoryLabels[category]}</div>
              <div className="tag-category-chips">
                {tags.map(tag => (
                  <TagChip
                    key={tag.id}
                    tagId={tag.id}
                    interactive
                    active={selectedTagIds.includes(tag.id)}
                    onClick={() => manager.toggleTag(tag.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="sources-body">
          <section className="sources-tree-panel">
            <div className="panel-header">
              <div>
                <h3>{activePane === 'web' ? 'Web hierarchy' : 'Local hierarchy'}</h3>
                <p>{activePane === 'web' ? 'Organise domains, feeds, and knowledge portals.' : 'Control folders, files, and research drops.'}</p>
              </div>
              <div className="panel-actions">
                <button type="button" onClick={manager.expandAll}>
                  Expand all
                </button>
                <button type="button" onClick={manager.collapseAll}>
                  Collapse all
                </button>
              </div>
            </div>
            <div className="sources-tree-scroll">
              {manager.filteredTree.length === 0 ? (
                <div className="sources-empty-state">
                  <h4>No sources match your filters</h4>
                  <p>Adjust search or tag filters to reveal more content.</p>
                </div>
              ) : (
                manager.filteredTree.map(node => (
                  <SourceTreeNode
                    key={node.id}
                    node={node}
                    depth={0}
                    manager={manager}
                    selectedId={manager.selectedNode?.id ?? null}
                  />
                ))
              )}
            </div>
          </section>

          <section className="sources-detail-panel">
            {selectedNode ? (
              <div className="sources-detail-card">
                <div className="sources-detail-top">
                  <div className="detail-pill" data-pane={selectedNode.origin}>
                    {selectedNode.origin === 'web' ? 'Web source' : 'Local source'}
                  </div>
                  <div className={`detail-state-pill ${effectiveState}`}>
                    {effectiveState === 'excluded' ? 'Excluded' : 'Included'}
                  </div>
                </div>
                <div className="sources-breadcrumbs">
                  {breadcrumbs.map((crumb, index) => (
                    <React.Fragment key={crumb.id}>
                      {index > 0 && <span className="breadcrumb-separator">/</span>}
                      <span className={`breadcrumb-item ${index === breadcrumbs.length - 1 ? 'active' : ''}`}>
                        {crumb.name}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
                <h3 className="sources-detail-title">{selectedNode.name}</h3>
                {selectedNode.description && (
                  <p className="sources-detail-description">{selectedNode.description}</p>
                )}

                <div className="sources-detail-actions">
                  <button
                    type="button"
                    className={`detail-action ${effectiveState === 'included' ? 'active' : ''}`}
                    onClick={() => manager.setNodeInclusion(selectedNode.id, 'included')}
                  >
                    Include
                  </button>
                  <button
                    type="button"
                    className={`detail-action ${effectiveState === 'excluded' ? 'danger' : ''}`}
                    onClick={() => manager.setNodeInclusion(selectedNode.id, 'excluded')}
                  >
                    Exclude
                  </button>
                  <button
                    type="button"
                    className="detail-action subtle"
                    onClick={() => manager.setNodeInclusion(selectedNode.id, undefined)}
                    disabled={!explicitState}
                  >
                    Clear override
                  </button>
                </div>

                <div className="sources-detail-tags">
                  {selectedNode.tagIds.map(tagId => (
                    <TagChip key={tagId} tagId={tagId} />
                  ))}
                </div>

                <div className="sources-detail-grid">
                  {metadataEntries.map(entry => (
                    <div key={entry.label} className={`detail-grid-item ${entry.tone ?? ''}`}>
                      <span className="detail-label">{entry.label}</span>
                      <span className="detail-value">{entry.value}</span>
                    </div>
                  ))}
                </div>

                {selectedNode.children && selectedNode.children.length > 0 && (
                  <div className="sources-detail-children">
                    <div className="detail-children-header">
                      <h4>Direct children</h4>
                      <span>{selectedNode.children.length}</span>
                    </div>
                    <ul>
                      {selectedNode.children.map(child => (
                        <li key={child.id}>
                          <span className="child-icon">{child.icon}</span>
                          <div>
                            <div className="child-name">{child.name}</div>
                            {child.description && <div className="child-description">{child.description}</div>}
                          </div>
                          <div className="child-tags">
                            {child.tagIds.slice(0, 2).map(tagId => (
                              <TagChip key={tagId} tagId={tagId} condensed />
                            ))}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="sources-empty-detail">
                <div className="empty-emoji" aria-hidden="true">🧭</div>
                <h3>Select a source to inspect its capabilities</h3>
                <p>
                  Choose a node from the hierarchy to review metadata, modalities, and inclusion overrides.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default SourcesWindow;
