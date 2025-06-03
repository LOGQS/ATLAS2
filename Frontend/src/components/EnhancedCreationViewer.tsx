import React, { useState, useEffect, useRef, useCallback } from 'react';
import CreationContent from './CreationContent';
import { Creation } from '../utils/creationsHelper';
import creationManager, { CreationEvent } from '../utils/creationManager';

interface EnhancedCreationViewerProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenAddModal: () => void;
  onOpenRenameModal: (creation: Creation) => void;
}

/**
 * Enhanced Creation Viewer with tabs and improved UX
 */
const EnhancedCreationViewer: React.FC<EnhancedCreationViewerProps> = ({
  isOpen,
  onClose,
  onOpenAddModal,
  onOpenRenameModal
}) => {
  const [allCreations, setAllCreations] = useState<Creation[]>([]);
  const [currentCreation, setCurrentCreation] = useState<Creation | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'recent' | 'html' | 'code' | 'other'>('all');
  const [filterText, setFilterText] = useState('');
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedCreations, setSelectedCreations] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const [animationState, setAnimationState] = useState<'entering' | 'entered' | 'exiting' | 'exited'>(
    isOpen ? 'entering' : 'exited'
  );


  // Handle viewer close with animation
  const handleClose = useCallback(() => {
    if (animationState === 'entered') {
      setAnimationState('exiting');
      setTimeout(() => {
        setAnimationState('exited');
        onClose();
      }, 300); // Match CSS transition duration
    }
  }, [animationState, onClose]);

  // Handle outside clicks to close the viewer
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // Don't close if clicking on a modal overlay or modal container
      const target = event.target as Element;
      if (target.closest('.modal-overlay') || target.closest('.modal-container')) {
        return;
      }
      
      // Only close if clicking outside the viewer container
      if (viewerRef.current && !viewerRef.current.contains(event.target as Node)) {
        handleClose();
      }
    };

    if (isOpen && animationState === 'entered') {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, animationState, handleClose]);

  // Helper to check if creations array has changed in a meaningful way
  const haveCreationsChanged = (newCreations: Creation[], oldCreations: Creation[]): boolean => {
    // Quick length check
    if (newCreations.length !== oldCreations.length) return true;
    
    // Compare creation IDs and their order (most important information)
    // This avoids deep comparison of all creation content which could be expensive
    const newIds = newCreations.map(c => c.id);
    const oldIds = oldCreations.map(c => c.id);
    
    // Check if the arrays are the same
    if (newIds.some((id, index) => id !== oldIds[index])) return true;
    
    // Check if any creation's title has changed
    for (let i = 0; i < newCreations.length; i++) {
      if (newCreations[i].title !== oldCreations[i].title) return true;
    }
    
    return false;
  };

  // Subscribe to creation updates
  useEffect(() => {
    const updateCreations = () => {
      const creations = creationManager.getCreations();
      console.log(`[EnhancedCreationViewer] Loaded ${creations.length} creations from CreationManager`);
      
      // Avoid unnecessary state updates by checking if creations changed
      if (haveCreationsChanged(creations, allCreations)) {
        setAllCreations(creations);
        
        // If no current creation is selected, select the most recent one
        if (!currentCreation && creations.length > 0) {
          setCurrentCreation(creations[0]);
        }
      }
    };

    // Initial load
    updateCreations();

    // Subscribe to changes - only actual changes to the data should trigger updates
    const unsubscribe = creationManager.subscribe((event: CreationEvent, creation: Creation | null) => {
      // Only update on real changes to avoid loops
      if (['add', 'remove', 'update', 'clear'].includes(event)) {
        updateCreations();
      } else if (event === 'view' && creation && creation.id !== currentCreation?.id) {
        // Only update if viewing a different creation than the current one
        updateCreations();
      }
    });

    return () => {
      unsubscribe();
    };
  }, [currentCreation, allCreations]); // Include currentCreation in dependencies

  // Handle animation state changes when isOpen changes
  useEffect(() => {
    if (isOpen && animationState === 'exited') {
      // If opening, refresh creations from manager without triggering saves
      const creations = creationManager.getCreations();
      
      // Only update if the creations have actually changed
      if (haveCreationsChanged(creations, allCreations)) {
        setAllCreations(creations);
      }
      
      // Only set current creation if none is selected and creations exist
      if (!currentCreation && creations.length > 0) {
        setCurrentCreation(creations[0]);
      }
      
      // Start animation
      setAnimationState('entering');
      setTimeout(() => {
        setAnimationState('entered');
      }, 300); // Match CSS transition duration
    } else if (!isOpen && animationState === 'entered') {
      setAnimationState('exiting');
      setTimeout(() => {
        setAnimationState('exited');
      }, 300); // Match CSS transition duration
    }
  }, [isOpen, animationState, currentCreation, allCreations]); // Include currentCreation in dependencies

  // Listen for external close requests (e.g., when opening HTML viewer)
  useEffect(() => {
    const handleCloseViewer = () => {
      handleClose();
    };

    window.addEventListener('close-enhanced-viewer', handleCloseViewer);
    
    return () => {
      window.removeEventListener('close-enhanced-viewer', handleCloseViewer);
    };
  }, [handleClose]);

  // Filter creations based on active tab and filter text
  const filteredCreations = allCreations.filter(creation => {
    // Filter by tab
    if (activeTab === 'all') {
      // No type filtering for 'all' tab
    } else if (activeTab === 'recent') {
      // Get recent creations (using view history)
      const recentCreationIds = creationManager.getViewHistory();
      if (!recentCreationIds.includes(creation.id || '')) {
        return false;
      }
    } else if (activeTab === 'html') {
      if (creation.type !== 'html') {
        return false;
      }
    } else if (activeTab === 'code') {
      if (creation.type !== 'code') {
        return false;
      }
    } else if (activeTab === 'other') {
      if (creation.type === 'html' || creation.type === 'code') {
        return false;
      }
    }

    // Filter by text
    if (filterText.trim() !== '') {
      const searchTerms = filterText.toLowerCase().split(' ');
      const creationText = [
        creation.title || '',
        creation.type || '',
        creation.language || '',
        creation.content.slice(0, 500) // Limit content search to improve performance
      ].join(' ').toLowerCase();

      return searchTerms.every(term => creationText.includes(term));
    }

    return true;
  });

  // Toggle selection mode
  const toggleSelectMode = useCallback(() => {
    setIsSelectMode(prev => !prev);
    setSelectedCreations(new Set());
    setLastSelectedIndex(null);
  }, []);

  // Keyboard shortcuts for selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      
      // Only handle these shortcuts when in select mode
      if (isSelectMode) {
        // Ctrl/Cmd + A: Select all
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
          e.preventDefault();
          e.stopPropagation();
          const allIds = new Set(filteredCreations.map(c => c.id).filter(Boolean) as string[]);
          setSelectedCreations(allIds);
          return; // Important: return early to prevent other handlers
        }
        
        // Escape: Deselect all or exit select mode
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (selectedCreations.size > 0) {
            setSelectedCreations(new Set());
          } else {
            toggleSelectMode();
          }
          return; // Important: return early to prevent other handlers
        }
      }
    };
    
    // Use capture phase to intercept before other handlers
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, isSelectMode, filteredCreations, selectedCreations.size, toggleSelectMode]);

  // Handle selection of a creation
  const handleSelectCreation = (creation: Creation) => {
    // If switching between creations, add a small delay for cleanup
    if (currentCreation && currentCreation.id !== creation.id) {
      // Clear the current creation temporarily
      setCurrentCreation(null);
      
      // Set a small timeout to allow for DOM cleanup
      setTimeout(() => {
        setCurrentCreation(creation);
        
        // Add to view history
        if (creation.id) {
          creationManager.viewCreation(creation.id);
        }
      }, 50);
    } else {
      setCurrentCreation(creation);
      
      // Add to view history
      if (creation.id) {
        creationManager.viewCreation(creation.id);
      }
    }
  };

  // Handle renaming of a creation
  const handleRenameCreation = (e: React.MouseEvent, creation: Creation) => {
    e.stopPropagation();
    if (!creation.id) return;
    
    // Use the prop to open the rename modal at App level
    onOpenRenameModal(creation);
  };
  
  // Handle deletion of a creation
  const handleDeleteCreation = (e: React.MouseEvent, creation: Creation) => {
    e.stopPropagation();
    if (!creation.id) return;
    
    // Use the creationManager to remove the creation
    const removed = creationManager.removeCreation(creation.id);
    if (removed) {
      // If the deleted creation was the current one, select a new one
      if (currentCreation?.id === creation.id) {
        const creations = creationManager.getCreations();
        if (creations.length > 0) {
          setCurrentCreation(creations[0]);
        } else {
          setCurrentCreation(null);
        }
      }
    }
  };

  // Toggle creation selection with shift-click support
  const toggleCreationSelection = (creationId: string, index: number, isShiftClick: boolean = false) => {
    const newSelected = new Set(selectedCreations);
    
    if (isShiftClick && lastSelectedIndex !== null && isSelectMode) {
      // Shift-click: toggle range based on the clicked item's current state
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      
      // Determine if we should select or deselect based on the clicked item
      const shouldSelect = !newSelected.has(creationId);
      
      // Apply the same action (select or deselect) to all items in the range
      for (let i = start; i <= end; i++) {
        const creation = filteredCreations[i];
        if (creation?.id) {
          if (shouldSelect) {
            newSelected.add(creation.id);
          } else {
            newSelected.delete(creation.id);
          }
        }
      }
    } else {
      // Regular click: toggle single selection
      if (newSelected.has(creationId)) {
        newSelected.delete(creationId);
      } else {
        newSelected.add(creationId);
      }
      setLastSelectedIndex(index);
    }
    
    setSelectedCreations(newSelected);
  };

  // Delete selected creations
  const handleDeleteSelected = () => {
    if (selectedCreations.size === 0) return;
    
    const count = selectedCreations.size;
    const confirmMessage = count === 1 
      ? 'Are you sure you want to delete this creation?' 
      : `Are you sure you want to delete ${count} creations?`;
    
    if (confirm(confirmMessage)) {
      // Delete each selected creation
      selectedCreations.forEach(creationId => {
        creationManager.removeCreation(creationId);
      });
      
      // If current creation was deleted, select a new one
      if (currentCreation?.id && selectedCreations.has(currentCreation.id)) {
        const creations = creationManager.getCreations();
        if (creations.length > 0) {
          setCurrentCreation(creations[0]);
        } else {
          setCurrentCreation(null);
        }
      }
      
      // Exit select mode
      setIsSelectMode(false);
      setSelectedCreations(new Set());
    }
  };

  // Clear all creations
  const handleClearAll = async () => {
    const creations = creationManager.getCreations();
    if (creations.length === 0) {
      alert('No creations to clear');
      return;
    }
    
    const confirmMessage = `Are you sure you want to delete ALL ${creations.length} creations? This action cannot be undone.`;
    
    if (confirm(confirmMessage)) {
      // Clear all creations
      await creationManager.clearAllCreations();
      setCurrentCreation(null);
      setSelectedCreations(new Set());
      setIsSelectMode(false);
    }
  };

  // If viewer is not open and exited state, don't render
  if (animationState === 'exited' && !isOpen) {
    return null;
  }

  // Component for rendering creation list items
  const CreationListItem: React.FC<{ creation: Creation; index: number }> = ({ creation, index }) => {
    const isActive = currentCreation?.id === creation.id;
    const isSelected = creation.id ? selectedCreations.has(creation.id) : false;
    
    const handleClick = (e: React.MouseEvent) => {
      if (isSelectMode && creation.id) {
        toggleCreationSelection(creation.id, index, e.shiftKey);
      } else {
        handleSelectCreation(creation);
      }
    };
    
    return (
      <div 
        className={`creation-list-item ${isActive ? 'active' : ''} ${isSelectMode ? 'select-mode' : ''} ${isSelected ? 'selected' : ''}`}
        onClick={handleClick}
      >
        {isSelectMode && (
          <div className="creation-item-checkbox">
            <input 
              type="checkbox" 
              checked={isSelected}
              onChange={() => {}} // Handled by parent click
              onClick={(e) => e.stopPropagation()} // Prevent double toggle
            />
          </div>
        )}
        <div className="creation-item-icon">
          {creation.type === 'code' && (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6"></polyline>
              <polyline points="8 6 2 12 8 18"></polyline>
            </svg>
          )}
          
          {creation.type === 'html' && (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
            </svg>
          )}
          
          {creation.type === 'markdown' && (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
            </svg>
          )}
          
          {creation.type === 'svg' && (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
              <line x1="3.27" y1="6.96" x2="12" y2="12.01"></line>
              <line x1="12" y1="12.01" x2="20.73" y2="6.96"></line>
              <line x1="12" y1="22.08" x2="12" y2="12"></line>
            </svg>
          )}
          
          {(creation.type !== 'code' && creation.type !== 'html' && creation.type !== 'markdown' && creation.type !== 'svg') && (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            </svg>
          )}
        </div>
        
        <div className="creation-item-content">
          <div className="creation-item-title">
            {creation.title || `${creation.type.charAt(0).toUpperCase() + creation.type.slice(1)} Creation`}
          </div>
          <div className="creation-item-subtitle">
            {creation.type === 'code' ? creation.language || 'code' : creation.type}
          </div>
        </div>
        
        {!isSelectMode && (
          <div className="creation-item-actions">
            <button 
              className="creation-item-rename" 
              onClick={(e) => handleRenameCreation(e, creation)}
              title="Rename creation"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
              </svg>
            </button>
            <button 
              className="creation-item-delete" 
              onClick={(e) => handleDeleteCreation(e, creation)}
              title="Delete creation"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div 
      className={`enhanced-creation-viewer ${animationState}`}
      aria-hidden={!isOpen}
    >

      

      <div 
        ref={viewerRef}
        className="enhanced-creation-viewer-container"
      >
        <div className="enhanced-creation-viewer-header">
          <h2>Creations Gallery</h2>
          <button 
            className="close-button" 
            onClick={handleClose}
            aria-label="Close gallery"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        
        <div className="enhanced-creation-viewer-body">
          <div className="creation-sidebar">
            <div className="creation-sidebar-header">
              <div className="creation-tabs">
                <button 
                  className={`creation-tab ${activeTab === 'all' ? 'active' : ''}`}
                  onClick={() => setActiveTab('all')}
                >
                  All
                </button>
                <button 
                  className={`creation-tab ${activeTab === 'recent' ? 'active' : ''}`}
                  onClick={() => setActiveTab('recent')}
                >
                  Recent
                </button>
                <button 
                  className={`creation-tab ${activeTab === 'html' ? 'active' : ''}`}
                  onClick={() => setActiveTab('html')}
                >
                  HTML
                </button>
                <button 
                  className={`creation-tab ${activeTab === 'code' ? 'active' : ''}`}
                  onClick={() => setActiveTab('code')}
                >
                  Code
                </button>
                <button 
                  className={`creation-tab ${activeTab === 'other' ? 'active' : ''}`}
                  onClick={() => setActiveTab('other')}
                >
                  Other
                </button>
              </div>
              
              <div className="creation-actions-toolbar">
                {!isSelectMode ? (
                  <>
                    <button 
                      className="toolbar-button select-button"
                      onClick={toggleSelectMode}
                      title="Select multiple creations (hold Shift to select range)"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 11 12 14 22 4"></polyline>
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                      </svg>
                      <span>Select</span>
                    </button>
                    <button 
                      className="toolbar-button clear-all-button"
                      onClick={handleClearAll}
                      title="Delete all creations"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        <line x1="10" y1="11" x2="10" y2="17"></line>
                        <line x1="14" y1="11" x2="14" y2="17"></line>
                      </svg>
                      <span>Clear All</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button 
                      className="toolbar-button cancel-button"
                      onClick={toggleSelectMode}
                      title="Cancel selection"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                      <span>Cancel</span>
                    </button>
                    <button 
                      className="toolbar-button delete-selected-button"
                      onClick={handleDeleteSelected}
                      disabled={selectedCreations.size === 0}
                      title={`Delete ${selectedCreations.size} selected creation${selectedCreations.size !== 1 ? 's' : ''}`}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                      </svg>
                      <span>Delete Selected ({selectedCreations.size})</span>
                    </button>
                  </>
                )}
              </div>
              
              {isSelectMode && (
                <div className="selection-help">
                  <span>Click to select • Shift+Click to select range • Ctrl+A to select all • Esc to cancel</span>
                </div>
              )}
              
              <div className="creation-search">
                <input
                  type="text"
                  placeholder="Search creations..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="creation-search-input"
                />
                <button 
                  className="creation-search-clear"
                  onClick={() => setFilterText('')}
                  style={{ visibility: filterText ? 'visible' : 'hidden' }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
                <button 
                  className="add-creation-button" 
                  onClick={onOpenAddModal}
                  title="Add new creation manually"
                  aria-label="Add new creation"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
              </div>
            </div>
            
            <div className="creation-list">
              {filteredCreations.length > 0 ? (
                filteredCreations.map((creation, index) => (
                  <CreationListItem key={creation.id || index} creation={creation} index={index} />
                ))
              ) : (
                <div className="empty-creations-message">
                  {filterText 
                    ? "No creations matching your search" 
                    : activeTab !== 'all' 
                      ? `No ${activeTab} creations found` 
                      : "No creations available"}
                </div>
              )}
            </div>
          </div>
          
          <div className="creation-content-view">
            {currentCreation ? (
              <CreationContent 
                creation={currentCreation} 
                viewMode="window"
                showToolbar={true}
              />
            ) : (
              <div className="no-creation-selected">
                <div className="no-creation-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <polyline points="21 15 16 10 5 21"></polyline>
                  </svg>
                </div>
                <h3>No Creation Selected</h3>
                <p>Select a creation from the list to view it here</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default EnhancedCreationViewer; 