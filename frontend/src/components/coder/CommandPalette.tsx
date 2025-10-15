import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useCoderContext } from '../../contexts/CoderContext';
import { PhosphorIcon } from '../ui/PhosphorIcons';
import { Icons } from '../ui/Icons';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Command {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactElement;
  action: () => void | Promise<void>;
  category: 'file' | 'editor' | 'view' | 'terminal' | 'workspace';
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose }) => {
  const {
    saveFile,
    resetFile,
    closeTab,
    activeTabPath,
    toggleTerminal,
    showTerminal,
    loadFileTree,
    unsavedFiles,
    currentDocument,
  } = useCoderContext();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  const allCommands = useMemo<Command[]>(() => [
    {
      id: 'file.save',
      label: 'Save File',
      description: currentDocument ? `Save ${currentDocument.filePath}` : 'Save current file',
      icon: <Icons.Save className="w-4 h-4" />,
      action: async () => {
        if (currentDocument && unsavedFiles.has(currentDocument.filePath)) {
          await saveFile();
          onClose();
        }
      },
      category: 'file',
    },
    {
      id: 'file.saveAll',
      label: 'Save All Files',
      description: `Save ${unsavedFiles.size} unsaved file(s)`,
      icon: <Icons.Save className="w-4 h-4" />,
      action: async () => {
        await saveFile();
        onClose();
      },
      category: 'file',
    },
    {
      id: 'file.revert',
      label: 'Discard Changes',
      description: 'Revert file to last saved version',
      icon: <Icons.Discard className="w-4 h-4" />,
      action: async () => {
        await resetFile();
        onClose();
      },
      category: 'file',
    },
    {
      id: 'file.close',
      label: 'Close File',
      description: activeTabPath ? `Close ${activeTabPath}` : 'Close current file',
      icon: <Icons.Close className="w-4 h-4" />,
      action: () => {
        if (activeTabPath) {
          closeTab(activeTabPath);
          onClose();
        }
      },
      category: 'file',
    },
    {
      id: 'file.refresh',
      label: 'Refresh File Tree',
      description: 'Reload the file explorer',
      icon: <Icons.Refresh className="w-4 h-4" />,
      action: async () => {
        await loadFileTree();
        onClose();
      },
      category: 'file',
    },

    {
      id: 'terminal.toggle',
      label: showTerminal ? 'Hide Terminal' : 'Show Terminal',
      description: 'Toggle terminal panel',
      icon: <Icons.Terminal className="w-4 h-4" />,
      action: () => {
        toggleTerminal();
        onClose();
      },
      category: 'terminal',
    },

    {
      id: 'view.commandPalette',
      label: 'Command Palette',
      description: 'Show all commands',
      icon: <PhosphorIcon.Terminal className="w-4 h-4" />,
      action: () => {
      },
      category: 'view',
    },

    {
      id: 'editor.foldAll',
      label: 'Fold All',
      description: 'Collapse all code regions',
      icon: <Icons.ChevronDown className="w-4 h-4" />,
      action: () => {
        onClose();
      },
      category: 'editor',
    },
    {
      id: 'editor.unfoldAll',
      label: 'Unfold All',
      description: 'Expand all code regions',
      icon: <Icons.ChevronDown className="w-4 h-4" style={{ transform: 'rotate(180deg)' }} />,
      action: () => {
        onClose();
      },
      category: 'editor',
    },
  ], [
    currentDocument,
    unsavedFiles,
    activeTabPath,
    showTerminal,
    saveFile,
    resetFile,
    closeTab,
    toggleTerminal,
    loadFileTree,
    onClose,
  ]);

  const filteredCommands = useMemo(() => {
    if (!query.trim()) {
      return allCommands;
    }

    const lowerQuery = query.toLowerCase();
    return allCommands.filter(cmd => {
      const labelMatch = cmd.label.toLowerCase().includes(lowerQuery);
      const descMatch = cmd.description?.toLowerCase().includes(lowerQuery);
      const categoryMatch = cmd.category.toLowerCase().includes(lowerQuery);
      return labelMatch || descMatch || categoryMatch;
    });
  }, [query, allCommands]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCommands]);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  const handleExecuteCommand = useCallback(async (command: Command) => {
    try {
      await command.action();
    } catch (error) {
      console.error('[CommandPalette] Error executing command:', error);
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, filteredCommands.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        handleExecuteCommand(filteredCommands[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [filteredCommands, selectedIndex, handleExecuteCommand, onClose]);

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'file':
        return 'text-blue-400';
      case 'editor':
        return 'text-green-400';
      case 'view':
        return 'text-purple-400';
      case 'terminal':
        return 'text-yellow-400';
      case 'workspace':
        return 'text-orange-400';
      default:
        return 'text-gray-400';
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[999] flex items-start justify-center pt-[15vh] bg-black/50"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: -20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: -20 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          className="w-full max-w-2xl mx-4 bg-bolt-elements-background-depth-1 rounded-lg shadow-2xl overflow-hidden border border-bolt-elements-borderColor"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Search Input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-bolt-elements-borderColor">
            <PhosphorIcon.Terminal className="w-5 h-5 text-bolt-elements-textTertiary" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a command or search..."
              className="flex-1 bg-transparent outline-none text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary"
            />
            <div className="flex items-center gap-2 text-xs text-bolt-elements-textTertiary">
              <span className="px-1.5 py-0.5 bg-bolt-elements-background-depth-3 rounded">↑↓</span>
              <span className="px-1.5 py-0.5 bg-bolt-elements-background-depth-3 rounded">Enter</span>
              <span className="px-1.5 py-0.5 bg-bolt-elements-background-depth-3 rounded">Esc</span>
            </div>
          </div>

          {/* Commands List */}
          <div className="max-h-[60vh] overflow-y-auto modern-scrollbar">
            {filteredCommands.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-bolt-elements-textTertiary">
                <PhosphorIcon.MagnifyingGlass className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No commands found</p>
              </div>
            ) : (
              filteredCommands.map((command, index) => {
                const isSelected = index === selectedIndex;

                return (
                  <div
                    key={command.id}
                    ref={isSelected ? selectedRef : null}
                    className={`
                      flex items-center gap-3 px-4 py-3 cursor-pointer border-l-2 transition-all duration-150
                      ${isSelected
                        ? 'bg-blue-500/20 border-blue-500 text-bolt-elements-textPrimary'
                        : 'border-transparent text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundActive hover:text-bolt-elements-textPrimary'
                      }
                    `}
                    onClick={() => handleExecuteCommand(command)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <div className="shrink-0">
                      {command.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {command.label}
                      </div>
                      {command.description && (
                        <div className="text-xs text-bolt-elements-textTertiary truncate">
                          {command.description}
                        </div>
                      )}
                    </div>
                    <div className={`text-xs font-mono uppercase ${getCategoryColor(command.category)}`}>
                      {command.category}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
