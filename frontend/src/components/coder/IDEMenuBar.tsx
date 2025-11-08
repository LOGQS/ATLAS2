import React, { useState, useRef, useEffect } from 'react';
import { Icons } from '../ui/Icons';
import '../../styles/coder/IDEMenuBar.css';

interface MenuItemAction {
  label: string;
  action: () => void;
  shortcut?: string;
  disabled?: boolean;
  divider?: boolean;
}

interface MenuDropdownProps {
  label: string;
  items: MenuItemAction[];
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}

const MenuDropdown: React.FC<MenuDropdownProps> = ({ label, items, isOpen, onToggle, onClose }) => {
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  return (
    <div className="ide-menu-bar__dropdown" ref={dropdownRef}>
      <button
        className={`ide-menu-bar__menu-button ${isOpen ? 'ide-menu-bar__menu-button--active' : ''}`}
        onClick={onToggle}
      >
        {label}
      </button>
      {isOpen && (
        <div className="ide-menu-bar__dropdown-content">
          {items.map((item, index) => (
            item.divider ? (
              <div key={`divider-${index}`} className="ide-menu-bar__menu-divider" />
            ) : (
              <button
                key={index}
                className={`ide-menu-bar__menu-item ${item.disabled ? 'ide-menu-bar__menu-item--disabled' : ''}`}
                onClick={() => {
                  if (!item.disabled) {
                    item.action();
                    onClose();
                  }
                }}
                disabled={item.disabled}
              >
                <span className="ide-menu-bar__menu-item-label">{item.label}</span>
                {item.shortcut && (
                  <span className="ide-menu-bar__menu-item-shortcut">{item.shortcut}</span>
                )}
              </button>
            )
          ))}
        </div>
      )}
    </div>
  );
};

interface IDEMenuBarProps {
  onBackToChat: () => void;
  workspace?: string;
  onOpenWorkspace: () => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onSave?: () => void;
  onSaveAll?: () => void;
  onToggleExplorer?: () => void;
  onToggleTerminal?: () => void;
  onToggleActivityPanel?: () => void;
}

export const IDEMenuBar: React.FC<IDEMenuBarProps> = ({
  onBackToChat,
  workspace,
  onOpenWorkspace,
  onNewFile,
  onNewFolder,
  onSave,
  onSaveAll,
  onToggleExplorer,
  onToggleTerminal,
  onToggleActivityPanel,
}) => {
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const handleMenuToggle = (menuName: string) => {
    setOpenMenu(openMenu === menuName ? null : menuName);
  };

  const closeAllMenus = () => {
    setOpenMenu(null);
  };

  const fileMenuItems: MenuItemAction[] = [
    {
      label: 'Open Workspace...',
      action: onOpenWorkspace,
      shortcut: 'Ctrl+K Ctrl+O',
    },
    {
      label: 'Recent Workspaces',
      action: () => console.log('Recent workspaces'),
      disabled: true,
    },
    {
      label: 'Close Workspace',
      action: () => console.log('Close workspace'),
      disabled: !workspace,
    },
    { label: '', action: () => {}, divider: true },
    {
      label: 'New File',
      action: onNewFile || (() => console.log('New file')),
      shortcut: 'Ctrl+N',
      disabled: !onNewFile,
    },
    {
      label: 'New Folder',
      action: onNewFolder || (() => console.log('New folder')),
      disabled: !onNewFolder,
    },
    { label: '', action: () => {}, divider: true },
    {
      label: 'Save',
      action: onSave || (() => console.log('Save')),
      shortcut: 'Ctrl+S',
      disabled: !onSave,
    },
    {
      label: 'Save All',
      action: onSaveAll || (() => console.log('Save all')),
      shortcut: 'Ctrl+K S',
      disabled: !onSaveAll,
    },
  ];

  const editMenuItems: MenuItemAction[] = [
    {
      label: 'Undo',
      action: () => document.execCommand('undo'),
      shortcut: 'Ctrl+Z',
    },
    {
      label: 'Redo',
      action: () => document.execCommand('redo'),
      shortcut: 'Ctrl+Y',
    },
    { label: '', action: () => {}, divider: true },
    {
      label: 'Find',
      action: () => console.log('Find'),
      shortcut: 'Ctrl+F',
      disabled: true,
    },
    {
      label: 'Replace',
      action: () => console.log('Replace'),
      shortcut: 'Ctrl+H',
      disabled: true,
    },
  ];

  const viewMenuItems: MenuItemAction[] = [
    {
      label: 'Toggle Explorer',
      action: onToggleExplorer || (() => console.log('Toggle explorer')),
      shortcut: 'Ctrl+B',
      disabled: !onToggleExplorer,
    },
    {
      label: 'Toggle Terminal',
      action: onToggleTerminal || (() => console.log('Toggle terminal')),
      shortcut: 'Ctrl+`',
      disabled: !onToggleTerminal,
    },
    {
      label: 'Toggle Activity Panel',
      action: onToggleActivityPanel || (() => console.log('Toggle activity panel')),
      disabled: !onToggleActivityPanel,
    },
  ];

  const runMenuItems: MenuItemAction[] = [
    {
      label: 'Run Task',
      action: () => console.log('Run task'),
      disabled: true,
    },
    {
      label: 'Stop',
      action: () => console.log('Stop'),
      disabled: true,
    },
  ];

  const helpMenuItems: MenuItemAction[] = [
    {
      label: 'Documentation',
      action: () => window.open('https://docs.claude.com', '_blank'),
    },
    {
      label: 'Keyboard Shortcuts',
      action: () => console.log('Keyboard shortcuts'),
      disabled: true,
    },
  ];

  return (
    <div className="ide-menu-bar">
      <div className="ide-menu-bar__left">
        <button
          className="ide-menu-bar__back-button"
          onClick={onBackToChat}
          title="Back to Chat"
        >
          <Icons.ChevronLeft className="w-4 h-4" />
          <span>Back</span>
        </button>

        <div className="ide-menu-bar__separator" />

        <MenuDropdown
          label="File"
          items={fileMenuItems}
          isOpen={openMenu === 'file'}
          onToggle={() => handleMenuToggle('file')}
          onClose={closeAllMenus}
        />
        <MenuDropdown
          label="Edit"
          items={editMenuItems}
          isOpen={openMenu === 'edit'}
          onToggle={() => handleMenuToggle('edit')}
          onClose={closeAllMenus}
        />
        <MenuDropdown
          label="View"
          items={viewMenuItems}
          isOpen={openMenu === 'view'}
          onToggle={() => handleMenuToggle('view')}
          onClose={closeAllMenus}
        />
        <MenuDropdown
          label="Run"
          items={runMenuItems}
          isOpen={openMenu === 'run'}
          onToggle={() => handleMenuToggle('run')}
          onClose={closeAllMenus}
        />
        <MenuDropdown
          label="Help"
          items={helpMenuItems}
          isOpen={openMenu === 'help'}
          onToggle={() => handleMenuToggle('help')}
          onClose={closeAllMenus}
        />
      </div>

      <div className="ide-menu-bar__right">
        {workspace && (
          <div className="ide-menu-bar__workspace-indicator">
            <Icons.FolderOpen className="w-4 h-4" />
            <span>{workspace}</span>
          </div>
        )}
      </div>
    </div>
  );
};
