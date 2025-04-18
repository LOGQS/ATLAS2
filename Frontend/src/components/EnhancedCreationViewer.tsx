import React, { useState, useEffect, useRef, useCallback } from 'react';
import CreationContent from './CreationContent';
import { Creation } from '../utils/creationsHelper';
import creationManager, { CreationEvent } from '../utils/creationManager';

interface EnhancedCreationViewerProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Enhanced Creation Viewer with tabs and improved UX
 */
const EnhancedCreationViewer: React.FC<EnhancedCreationViewerProps> = ({
  isOpen,
  onClose
}) => {
  const [allCreations, setAllCreations] = useState<Creation[]>([]);
  const [currentCreation, setCurrentCreation] = useState<Creation | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'recent' | 'html' | 'code' | 'other'>('all');
  const [filterText, setFilterText] = useState('');
  const viewerRef = useRef<HTMLDivElement>(null);
  const [animationState, setAnimationState] = useState<'entering' | 'entered' | 'exiting' | 'exited'>(
    isOpen ? 'entering' : 'exited'
  );

  // For toast notifications
  const [toast, setToast] = useState<{message: string, visible: boolean}>({
    message: '',
    visible: false
  });

  // For rename modal
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [creationToRename, setCreationToRename] = useState<Creation | null>(null);
  const [newTitleInput, setNewTitleInput] = useState('');
  const newTitleInputRef = useRef<HTMLInputElement>(null);

  // Function to show toast notification
  const showToast = (message: string) => {
    setToast({ message, visible: true });
    
    // Hide toast after 3 seconds
    setTimeout(() => {
      setToast(prev => ({ ...prev, visible: false }));
    }, 3000);
  };

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
      // If there's a modal open, don't close the gallery
      if (renameModalVisible) {
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
  }, [isOpen, animationState, handleClose, renameModalVisible]);

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
    const unsubscribe = creationManager.subscribe((event: CreationEvent, creation: Creation) => {
      // Only update on real changes to avoid loops
      if (['add', 'remove', 'update'].includes(event)) {
        updateCreations();
      } else if (event === 'view' && creation.id !== currentCreation?.id) {
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
    
    // Set the creation to rename and open the modal
    setCreationToRename(creation);
    setNewTitleInput(creation.title || '');
    setRenameModalVisible(true);
    
    // Focus the input field after the modal is visible
    setTimeout(() => {
      if (newTitleInputRef.current) {
        newTitleInputRef.current.focus();
        newTitleInputRef.current.select();
      }
    }, 100);
  };
  
  // Handle the actual rename operation when confirmed
  const confirmRename = () => {
    if (!creationToRename?.id || newTitleInput.trim() === '') return;
    
    // Use the creationManager to rename the creation
    const success = creationManager.renameCreation(creationToRename.id, newTitleInput.trim());
    
    if (success) {
      // Force update the current creation if it was the renamed one
      if (currentCreation?.id === creationToRename.id) {
        setCurrentCreation({
          ...currentCreation,
          title: newTitleInput.trim()
        });
      }
      
      // Force update creations list
      setAllCreations(creationManager.getCreations());
      
      // Show toast notification
      showToast(`Renamed to "${newTitleInput.trim()}"`);
    }
    
    // Close the modal
    setRenameModalVisible(false);
    setCreationToRename(null);
  };
  
  // Handle cancel rename
  const cancelRename = () => {
    setRenameModalVisible(false);
    setCreationToRename(null);
  };
  
  // Handle keyboard events in the rename modal
  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
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

  // If viewer is not open and exited state, don't render
  if (animationState === 'exited' && !isOpen) {
    return null;
  }

  // Component for rendering creation list items
  const CreationListItem: React.FC<{ creation: Creation }> = ({ creation }) => {
    const isActive = currentCreation?.id === creation.id;
    
    return (
      <div 
        className={`creation-list-item ${isActive ? 'active' : ''}`}
        onClick={() => handleSelectCreation(creation)}
      >
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
      </div>
    );
  };

  return (
    <div 
      className={`enhanced-creation-viewer ${animationState}`}
      aria-hidden={!isOpen}
    >
      {/* Toast notification */}
      {toast.visible && (
        <div className="copy-toast">
          {toast.message}
        </div>
      )}
      
      {/* Rename Modal */}
      {renameModalVisible && (
        <div 
          className="modal-overlay"
          onClick={(e) => e.stopPropagation()}
        >
          <div 
            className="modal-container rename-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Rename Creation</h3>
              <button 
                className="close-button" 
                onClick={cancelRename}
                aria-label="Close dialog"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div className="modal-content">
              <label className="rename-label" htmlFor="creation-title-input">
                Creation Title
              </label>
              <input
                id="creation-title-input"
                ref={newTitleInputRef}
                type="text"
                value={newTitleInput}
                onChange={(e) => setNewTitleInput(e.target.value)}
                onKeyDown={handleRenameKeyDown}
                className="rename-input"
                placeholder="Enter new name"
              />
            </div>
            <div className="modal-footer">
              <button 
                className="modal-button cancel-button" 
                onClick={cancelRename}
              >
                Cancel
              </button>
              <button 
                className="modal-button confirm-button" 
                onClick={confirmRename}
                disabled={newTitleInput.trim() === ''}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}
      
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
              </div>
            </div>
            
            <div className="creation-list">
              {filteredCreations.length > 0 ? (
                filteredCreations.map((creation, index) => (
                  <CreationListItem key={creation.id || index} creation={creation} />
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