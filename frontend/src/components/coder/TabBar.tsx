import React, { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useCoderContext } from '../../contexts/CoderContext';
import { Icons } from '../ui/Icons';
import '../../styles/coder/TabBar.css';

interface SortableTabProps {
  filePath: string;
  isActive: boolean;
  isUnsaved: boolean;
  fileName: string;
  onTabClick: (filePath: string) => void;
  onCloseTab: (e: React.MouseEvent, filePath: string) => void;
  onMouseDown: (e: React.MouseEvent, filePath: string) => void;
}

function SortableTab({
  filePath,
  isActive,
  isUnsaved,
  fileName,
  onTabClick,
  onCloseTab,
  onMouseDown,
}: SortableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: filePath });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const getFileIcon = (filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'tsx':
      case 'jsx':
        return <Icons.React className="w-3.5 h-3.5 text-blue-400" />;
      case 'ts':
      case 'js':
        return <Icons.JavaScript className="w-3.5 h-3.5 text-yellow-400" />;
      case 'py':
        return <Icons.Python className="w-3.5 h-3.5 text-blue-500" />;
      case 'css':
      case 'scss':
        return <Icons.File className="w-3.5 h-3.5 text-purple-400" />;
      case 'json':
        return <Icons.File className="w-3.5 h-3.5 text-green-400" />;
      case 'md':
        return <Icons.File className="w-3.5 h-3.5 text-gray-400" />;
      default:
        return <Icons.File className="w-3.5 h-3.5 text-gray-500" />;
    }
  };

  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      {...attributes}
      data-tab-path={filePath}
      className={`tab ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
      onClick={() => onTabClick(filePath)}
      onMouseDown={(e) => onMouseDown(e, filePath)}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.08, ease: 'easeOut' }}
    >
      <div className="tab-icon" {...listeners}>
        {getFileIcon(fileName)}
      </div>
      <span className="tab-label">{fileName}</span>
      <div className="tab-actions">
        {isUnsaved && (
          <div className="tab-unsaved-indicator" title="Unsaved changes">
            <div className="tab-unsaved-dot" />
          </div>
        )}
        <button
          className="tab-close"
          onClick={(e) => onCloseTab(e, filePath)}
          title="Close (Ctrl+W)"
        >
          <Icons.Close className="w-3 h-3" />
        </button>
      </div>
    </motion.div>
  );
}

export const TabBar: React.FC = () => {
  const { openTabs, activeTabPath, unsavedFiles, closeTab, switchToTab, reorderTabs } = useCoderContext();
  const tabBarRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Auto-scroll to active tab when it changes
  useEffect(() => {
    if (activeTabPath && tabBarRef.current) {
      const activeTabElement = tabBarRef.current.querySelector(`[data-tab-path="${activeTabPath}"]`);
      if (activeTabElement) {
        activeTabElement.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
      }
    }
  }, [activeTabPath]);

  const getFileName = (filePath: string) => {
    return filePath.split(/[/\\]/).pop() || filePath;
  };

  const handleCloseTab = (e: React.MouseEvent, filePath: string) => {
    e.stopPropagation();
    closeTab(filePath);
  };

  const handleTabClick = (filePath: string) => {
    switchToTab(filePath);
  };

  // Handle middle-click to close
  const handleMouseDown = (e: React.MouseEvent, filePath: string) => {
    if (e.button === 1) {
      // Middle mouse button
      e.preventDefault();
      closeTab(filePath);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = openTabs.indexOf(active.id as string);
      const newIndex = openTabs.indexOf(over.id as string);

      const newOrder = arrayMove(openTabs, oldIndex, newIndex);
      reorderTabs(newOrder);
    }
  };

  if (openTabs.length === 0) {
    return null;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div className="tab-bar" ref={tabBarRef}>
        <SortableContext items={openTabs} strategy={horizontalListSortingStrategy}>
          <AnimatePresence initial={false}>
            {openTabs.map((filePath) => {
              const isActive = filePath === activeTabPath;
              const isUnsaved = unsavedFiles.has(filePath);
              const fileName = getFileName(filePath);

              return (
                <SortableTab
                  key={filePath}
                  filePath={filePath}
                  isActive={isActive}
                  isUnsaved={isUnsaved}
                  fileName={fileName}
                  onTabClick={handleTabClick}
                  onCloseTab={handleCloseTab}
                  onMouseDown={handleMouseDown}
                />
              );
            })}
          </AnimatePresence>
        </SortableContext>
      </div>
    </DndContext>
  );
};
