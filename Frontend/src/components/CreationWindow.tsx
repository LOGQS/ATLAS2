import React, { useState, useEffect, useRef } from 'react';
// React already imported in the line above
import { Creation } from '../utils/creationsHelper';
import CreationContent from './CreationContent';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface CreationWindowProps {
  isOpen: boolean;
  creationToDisplay: Creation | null;
  onClose: () => void;
}

// Detail structure for new events
interface AppendContentEventDetail {
  creationId: string;
  chunk: string;
}

interface EndStreamEventDetail {
  creationId: string;
  autoClosed?: boolean;
}

const CreationWindow: React.FC<CreationWindowProps> = ({ isOpen, creationToDisplay, onClose }) => {
  const [animationState, setAnimationState] = useState<'entering' | 'visible' | 'exiting' | 'hidden'>('hidden');
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('code'); // Default to code view
  
  const [currentContentBody, setCurrentContentBody] = useState<string>('');
  const isStreamingRef = useRef(false);
  
  const [isViewTransitioning, setIsViewTransitioning] = useState(false);

  // Manage animation based on isOpen prop
  useEffect(() => {
    if (isOpen) {
      setAnimationState('entering');
      const timer = setTimeout(() => {
        setAnimationState('visible');
      }, 10); // Small delay for CSS transition
      return () => clearTimeout(timer);
    } else {
      // Only trigger exit animation if it was previously visible or entering
      if (animationState === 'visible' || animationState === 'entering') {
        setAnimationState('exiting');
        // The onClose callback from props will be called by Chat.tsx after animation
        // For direct close from CreationWindow (e.g. Esc or close button), we call it after animation.
        // This effect is for prop-driven close. Chat.tsx handles its own state.
      } else {
        // If not visible/entering, just ensure it's hidden
        setAnimationState('hidden');
      }
    }
  }, [isOpen, animationState]);


  // Update content and view mode when creationToDisplay changes
  useEffect(() => {
    if (creationToDisplay) {
      setCurrentContentBody(creationToDisplay.content || '');
      // Default to 'code' view when a new creation is displayed or content starts streaming
      setViewMode('code'); 
      isStreamingRef.current = false; // Reset streaming state for the new creation
    } else {
      setCurrentContentBody(''); // Clear content when no creation is displayed
      isStreamingRef.current = false;
    }
  }, [creationToDisplay]);


  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) { // Only act if window is open
        if (isStreamingRef.current) {
          e.preventDefault();
          e.stopPropagation();
          showStreamingCloseWarning();
          return;
        } else {
          onClose(); // Call the onClose prop
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]); // Depend on isOpen and onClose
  
  const showStreamingCloseWarning = () => {
    // Create or update a warning notification
    let warningElement = document.getElementById('streaming-close-warning');
    if (!warningElement) {
      warningElement = document.createElement('div');
      warningElement.id = 'streaming-close-warning';
      warningElement.className = 'streaming-close-warning';
      warningElement.textContent = 'Cannot close while streaming. Please wait until streaming completes.';
      document.body.appendChild(warningElement);
      
      // Remove after a few seconds
      setTimeout(() => {
        if (warningElement && warningElement.parentNode) {
          warningElement.classList.add('fade-out');
          setTimeout(() => {
            if (warningElement && warningElement.parentNode) {
              document.body.removeChild(warningElement);
            }
          }, 300);
        }
      }, 3000);
    }
  };

  // Listen for streaming events
  useEffect(() => {
  // Event Handling for new events
  useEffect(() => {
    const handleAppendContent = (event: Event) => {
      const detail = (event as CustomEvent<AppendContentEventDetail>).detail;
      if (creationToDisplay && detail.creationId === creationToDisplay.id) {
        setCurrentContentBody(prev => prev + detail.chunk);
        if (viewMode !== 'code') setViewMode('code'); // Switch to code view on new content
        isStreamingRef.current = true;
      }
    };

    const handleEndStream = (event: Event) => {
      const detail = (event as CustomEvent<EndStreamEventDetail>).detail;
      if (creationToDisplay && detail.creationId === creationToDisplay.id) {
        isStreamingRef.current = false;
        // Optionally switch to preview if not autoClosed and type supports it
        if (!detail.autoClosed && creationToDisplay.type === 'markdown' /* or other previewable types */) {
          // setViewMode('preview'); // Consider this UX carefully
        }
      }
    };

    window.addEventListener('append-creation-content', handleAppendContent);
    window.addEventListener('end-creation-stream', handleEndStream);

    return () => {
      window.removeEventListener('append-creation-content', handleAppendContent);
      window.removeEventListener('end-creation-stream', handleEndStream);
    };
  }, [creationToDisplay, viewMode]); // Rerun if creationToDisplay or viewMode changes

  const handleViewModeChange = (newMode: 'preview' | 'code') => {
    if (newMode !== viewMode) {
      setIsViewTransitioning(true);
      setTimeout(() => {
        setViewMode(newMode);
        setTimeout(() => {
          setIsViewTransitioning(false);
        }, 300); // Match transition duration
      }, 150); // Half of transition time for crossfade effect
    }
  };

  // Also modify the close button to prevent closing during streaming
  const handleClose = () => {
    if (isStreamingRef.current) {
      showStreamingCloseWarning();
      return;
    }
    // Call the onClose prop which will set isOpen to false in Chat.tsx
    // and trigger the animation via useEffect for isOpen.
    onClose(); 
  };

  // If not open or no creation, or exiting, don't render anything or render with exiting class
  if (animationState === 'hidden' || !creationToDisplay) return null;
  if (animationState === 'exiting' && !creationToDisplay) return null; // Avoid flicker if creationToDisplay is cleared before animation ends

  const currentCreation = creationToDisplay; // Use prop directly

  const getLanguageForHighlighting = () => {
    if (currentCreation.type === 'code' && currentCreation.language) {
      return currentCreation.language;
    }
    switch (currentCreation.type) {
      case 'html': return 'html';
      case 'markdown': return 'markdown';
      case 'svg': return 'markup'; // SVG is XML-like, 'markup' is often used
      case 'mermaid': return 'text'; // Mermaid code itself is plain text
      case 'react': return 'jsx';
      default: return 'text'; // Default to plain text
    }
  };
  
  const displayContent = currentContentBody;

  return (
    <div 
      className={`creation-window ${animationState}`}
      ref={containerRef}
      data-creation-id={currentCreation.id || `creation-${Date.now()}`}
    >
      <div className="creation-window-header">
        <div className="creation-type-badge">
          <span>{currentCreation.type.charAt(0).toUpperCase() + currentCreation.type.slice(1)}</span>
        </div>
        <h3 className="creation-title">
          {currentCreation.title || `Untitled ${currentCreation.type.charAt(0).toUpperCase() + currentCreation.type.slice(1)}`}
        </h3>
        
        <div className="creation-view-toggle">
          <button 
            className={`view-toggle-button ${viewMode === 'preview' ? 'active' : ''} ${isStreamingRef.current ? 'disabled' : ''}`}
            onClick={() => !isStreamingRef.current && handleViewModeChange('preview')}
            aria-label="Preview mode"
            disabled={isStreamingRef.current}
            title={isStreamingRef.current ? "View switching is disabled during streaming" : "Switch to preview mode"}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <span>Preview</span>
          </button>
          <button 
            className={`view-toggle-button ${viewMode === 'code' ? 'active' : ''} ${isStreamingRef.current ? 'disabled' : ''}`}
            onClick={() => !isStreamingRef.current && handleViewModeChange('code')}
            aria-label="Code mode"
            disabled={isStreamingRef.current}
            title={isStreamingRef.current ? "View switching is disabled during streaming" : "Switch to code mode"}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6"></polyline>
              <polyline points="8 6 2 12 8 18"></polyline>
            </svg>
            <span>Code</span>
          </button>
        </div>
        
        <button 
          className={`creation-window-close ${isStreamingRef.current ? 'streaming-disabled' : ''}`}
          onClick={handleClose} // Updated to call props.onClose (indirectly via animation)
          aria-label="Close creation window"
          title={isStreamingRef.current ? "Cannot close during streaming" : "Close window"}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div className={`creation-window-content ${isViewTransitioning ? 'view-transitioning' : ''}`}>
        {viewMode === 'preview' ? (
          <div className="view-container preview-container">
            <CreationContent 
              creation={{...currentCreation, content: displayContent}} 
              viewMode={currentCreation.type === 'react' ? 'react-preview' : 'window'} 
              showToolbar={true} 
            />
          </div>
        ) : (
          <div className="view-container code-container">
            <div className="creation-code-view">
              <SyntaxHighlighter
                style={vscDarkPlus} // Ensure vscDarkPlus is imported or defined
                language={getLanguageForHighlighting()}
                showLineNumbers={true}
                customStyle={{ margin: 0, borderRadius: '0', height: '100%', maxHeight: '100%' }}
              >
                {displayContent}
              </SyntaxHighlighter>
            </div>
          </div>
        )}
      </div>
      
      {/* Add a streaming indicator */}
      {isStreamingRef.current && (
        <div className="streaming-indicator">
          <span>Streaming content...</span>
        </div>
      )}
    </div>
  );
};

export default CreationWindow; 