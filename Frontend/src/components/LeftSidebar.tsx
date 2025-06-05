import React, { useState, useEffect, useRef } from 'react';

type SidebarMode = 'hover' | 'toggle';

interface LeftSidebarProps {
  children?: React.ReactNode;
}

// Local storage key for sidebar mode
const SIDEBAR_MODE_KEY = 'atlas_sidebar_mode';

// Function to get saved mode from localStorage
const getSavedMode = (): SidebarMode => {
  try {
    const savedMode = localStorage.getItem(SIDEBAR_MODE_KEY);
    return (savedMode === 'toggle' ? 'toggle' : 'hover') as SidebarMode;
  } catch {
    // Return default mode if localStorage not available
    return 'hover';
  }
};

// Function to save mode to localStorage
const saveMode = (mode: SidebarMode): void => {
  try {
    localStorage.setItem(SIDEBAR_MODE_KEY, mode);
  } catch (e) {
    console.error('Failed to save sidebar mode to localStorage:', e);
  }
};

const LeftSidebar: React.FC<LeftSidebarProps> = ({ children }) => {
  // State for the sidebar
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<SidebarMode>(getSavedMode());
  const sidebarRef = useRef<HTMLDivElement>(null);
  const triggerAreaRef = useRef<HTMLDivElement>(null);
  const leaveTimeoutRef = useRef<number | null>(null);
  
  // Save mode to localStorage when it changes
  useEffect(() => {
    saveMode(mode);
  }, [mode]);
  
  // Toggle the mode between 'hover' and 'toggle'
  const toggleMode = () => {
    setMode(prevMode => {
      const newMode = prevMode === 'hover' ? 'toggle' : 'hover';
      
      // If switching from toggle to hover mode and sidebar is open, close it
      if (prevMode === 'toggle' && isOpen) {
        setIsOpen(false);
      }
      
      return newMode;
    });
  };
  
  // Toggle the sidebar open/closed (only used in toggle mode)
  const toggleSidebar = () => {
    if (mode === 'toggle') {
      setIsOpen(prevIsOpen => !prevIsOpen);
    }
  };
  
  // Handle mouse enter for hover mode
  const handleMouseEnter = () => {
    if (mode === 'hover') {
      // Clear any pending close timeout
      if (leaveTimeoutRef.current) {
        clearTimeout(leaveTimeoutRef.current);
        leaveTimeoutRef.current = null;
      }
      setIsOpen(true);
    }
  };
  
  // Handle mouse leave for hover mode
  const handleMouseLeave = () => {
    if (mode === 'hover') {
      // Add a small delay before closing to prevent accidental closure
      // when the user briefly moves out of the sidebar
      const timeout = setTimeout(() => {
        setIsOpen(false);
      }, 300);
      
      // Store the timeout ID in a ref for cleanup
      leaveTimeoutRef.current = timeout as unknown as number;
    }
  };
  
  // Effect to handle clicks outside to close the sidebar in toggle mode
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // Only close on outside click for hover mode
      if (
        mode === 'hover' && 
        isOpen && 
        sidebarRef.current && 
        triggerAreaRef.current && 
        !sidebarRef.current.contains(event.target as Node) && 
        !triggerAreaRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    
    // Add click handler to close sidebar when clicking outside
    document.addEventListener('mousedown', handleClickOutside);
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, mode]);
  
  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (leaveTimeoutRef.current) {
        clearTimeout(leaveTimeoutRef.current);
      }
    };
  }, []);
  
  return (
    <>
      {/* Trigger area - visible when sidebar is closed */}
      <div 
        ref={triggerAreaRef}
        className={`left-sidebar-trigger ${isOpen ? 'hidden' : ''}`}
        onMouseEnter={handleMouseEnter}
        onClick={toggleSidebar}
      >
        <div className="left-sidebar-trigger-indicator"></div>
      </div>
      
      {/* The sidebar itself */}
      <div 
        ref={sidebarRef}
        className={`left-sidebar ${isOpen ? 'open' : ''}`}
        onMouseLeave={handleMouseLeave}
      >
        <div className="left-sidebar-content">
          {/* Mode toggle button */}
          <div className="left-sidebar-header">
            <button 
              className={`mode-toggle-button ${mode === 'toggle' ? 'toggle-mode-active' : ''}`}
              onClick={toggleMode}
              title={mode === 'hover' ? 'Switch to Toggle Mode (Pin sidebar)' : 'Switch to Hover Mode (Unpin sidebar)'}
            >
              {mode === 'hover' ? (
                // Icon for Hover mode (Unpinned) - Unlock icon
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 9.9-1"></path> 
                </svg>
              ) : (
                // Icon for Toggle mode (Pinned) - Lock icon
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
              )}
            </button>
          </div>
          
          {/* Sidebar content */}
          <div className="left-sidebar-main">
            {children || (
              <div className="left-sidebar-placeholder">
                <p>Sidebar Content</p>
                <p>Add components as children to the LeftSidebar component</p>
              </div>
            )}
          </div>
        </div>
        
        {/* Close button (for toggle mode) */}
        {mode === 'toggle' && (
          <button 
            className="left-sidebar-close" 
            onClick={() => setIsOpen(false)}
            title="Close sidebar"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        )}
      </div>
    </>
  );
};

export default LeftSidebar; 