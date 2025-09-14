import React, { useState, useMemo } from 'react';
import { VersionNode as VersionNodeType, TREE_CONFIG, getVersionType, formatDate } from './VersioningHelpers';

interface VersionNodeProps {
  node: VersionNodeType;
  depth: number;
  collapsed: Set<string>;
  toggleCollapsed: (nodeId: string) => void;
  handleVersionSwitch: (versionId: string) => Promise<void>;
  handleVersionRename: (versionId: string, currentName: string) => Promise<void>;
  handleVersionDelete: (versionId: string) => Promise<void>;
}

const VersionNode: React.FC<VersionNodeProps> = ({
  node,
  depth,
  collapsed,
  toggleCollapsed,
  handleVersionSwitch,
  handleVersionRename,
  handleVersionDelete
}) => {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const isActive = node.is_active;
  const [showActions, setShowActions] = useState(false);
  const versionType = getVersionType(node.name);

  const nodeStyle = useMemo(() => ({
    paddingLeft: `${depth * TREE_CONFIG.INDENT_SIZE + TREE_CONFIG.BASE_PADDING}px`,
    borderLeftColor: versionType.color
  }), [depth, versionType.color]);

  return (
    <div className="version-node">
      <div
        className={`version-item ${isActive ? 'active' : ''}`}
        style={nodeStyle}
        onMouseEnter={() => setShowActions(true)}
        onMouseLeave={() => setShowActions(false)}
      >
        {hasChildren && (
          <button
            className={`collapse-toggle ${isCollapsed ? 'collapsed' : ''}`}
            onClick={() => toggleCollapsed(node.id)}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            aria-expanded={!isCollapsed}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6,9 12,15 18,9"></polyline>
            </svg>
          </button>
        )}

        <div
          className="version-info"
          onClick={() => handleVersionSwitch(node.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleVersionSwitch(node.id);
            }
          }}
          style={{ cursor: 'pointer' }}
          tabIndex={0}
          role="button"
          aria-label={`Switch to version ${node.name}, created ${formatDate(node.created_at)}`}
        >
          <div className="version-header">
            <span className="version-icon">{versionType.icon}</span>
            <span className="version-name">{node.name}</span>
            {isActive && <span className="active-badge">CURRENT</span>}
          </div>
          <div className="version-details">
            <span className="version-type">
              {node.isversion ? 'Version' : 'Main Chat'}
            </span>
            <span className="version-separator">•</span>
            <span className="version-time">
              {formatDate(node.created_at)}
            </span>
            {depth > 0 && (
              <>
                <span className="version-separator">•</span>
                <span className="version-depth">Level {depth}</span>
              </>
            )}
          </div>
        </div>

        {showActions && node.isversion && (
          <div className="version-actions">
            <button
              className="version-action-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleVersionRename(node.id, node.name);
              }}
              title="Rename version"
              aria-label={`Rename version ${node.name}`}
            >
              ✏️
            </button>
            <button
              className="version-action-btn delete"
              onClick={(e) => {
                e.stopPropagation();
                handleVersionDelete(node.id);
              }}
              title="Delete version"
              aria-label={`Delete version ${node.name}`}
            >
              🗑️
            </button>
          </div>
        )}
      </div>

      {hasChildren && !isCollapsed && (
        <div className="version-children">
          {node.children.map((child) => (
            <VersionNode
              key={child.id}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              toggleCollapsed={toggleCollapsed}
              handleVersionSwitch={handleVersionSwitch}
              handleVersionRename={handleVersionRename}
              handleVersionDelete={handleVersionDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default VersionNode;