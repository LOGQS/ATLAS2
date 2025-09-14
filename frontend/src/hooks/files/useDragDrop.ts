// status: complete

import { useState } from 'react';
import logger from '../../utils/core/logger';

interface UseDragDropOptions {
  onFilesDropped: (files: FileList) => void;
  disabled?: boolean;
}

export const useDragDrop = ({ onFilesDropped, disabled = false }: UseDragDropOptions) => {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (disabled || !e.dataTransfer.types.includes('Files')) {
      return;
    }
    
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (disabled) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    
    if (disabled) return;
    
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      logger.info('[DRAG_DROP] Dropped', files.length, 'files:', Array.from(files).map(f => f.name));
      onFilesDropped(files);
    }
  };

  const dragHandlers = {
    onDragOver: handleDragOver,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop
  };

  return {
    isDragOver,
    dragHandlers
  };
};