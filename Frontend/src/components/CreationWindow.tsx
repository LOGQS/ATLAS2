import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Creation } from '../utils/creationsHelper';
import CreationContent from './CreationContent';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface CreationWindowProps {
  creation: Creation | null;
  onClose: () => void;
}

// Interface for streaming event detail
interface StreamToCreationEvent {
  content: string;
  creationId: string;
}

const CreationWindow: React.FC<CreationWindowProps> = ({ creation, onClose }) => {
  const [animationState, setAnimationState] = useState<'entering' | 'visible' | 'exiting'>('entering');
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
  
  // Add state to track streamed content
  const [streamedContent, setStreamedContent] = useState<string>('');
  const isStreamingRef = useRef(false);
  
  // Add state and refs for code view auto-scroll
  const codeViewRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScrollCode, setShouldAutoScrollCode] = useState(true);
  const userInteractedWithCodeScrollRef = useRef(false);
  const isProgrammaticCodeScrollRef = useRef(false);

  // Add state to track view transition animation
  const [isViewTransitioning, setIsViewTransitioning] = useState(false);

  // Function to scroll code view to bottom
  const scrollToCodeBottom = useCallback((smooth = false) => {
    setTimeout(() => {
      const codeViewArea = codeViewRef.current;
      if (codeViewArea && viewMode === 'code') {
        const preElement = codeViewArea.querySelector('pre'); // SyntaxHighlighter often uses a <pre> tag for scrolling
        const targetElement = preElement || codeViewArea; // Fallback to codeViewArea if <pre> not found

        console.log(
          'CreationWindow: scrollToCodeBottom attempting scroll. Target:',
          preElement ? 'pre' : 'div.creation-code-view',
          'ScrollHeight:', targetElement.scrollHeight,
          'ClientHeight:', targetElement.clientHeight,
          'Current scrollTop:', targetElement.scrollTop,
          'Smooth:', smooth
        );

        isProgrammaticCodeScrollRef.current = true;
        
        if (smooth) {
          targetElement.scrollTo({ top: targetElement.scrollHeight, behavior: 'smooth' });
        } else {
          // Immediate scroll to prevent jumping during streaming
          targetElement.scrollTop = targetElement.scrollHeight;
        }
        
        console.log('CreationWindow: scrollToCodeBottom completed, scrollTop:', targetElement.scrollTop);

      } else {
        console.log(
          'CreationWindow: scrollToCodeBottom - Conditions NOT MET or ref unavailable. HasRef:',
          !!codeViewArea,
          'ViewMode:',
          viewMode
        );
      }
    }, 75); // Slightly increased timeout for rendering, can be adjusted
  }, [viewMode]);

  // Handle animation states when creation changes
  useEffect(() => {
    if (creation) {
      setAnimationState('entering');
      // Small delay to trigger animation
      setTimeout(() => {
        setAnimationState('visible');
      }, 10);
      
      // Reset streamed content when creation changes
      setStreamedContent(creation.content);
      isStreamingRef.current = false;
    } else {
      setAnimationState('exiting');
    }
  }, [creation]);

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isStreamingRef.current) {
          // Prevent closing during streaming
          e.preventDefault();
          e.stopPropagation();
          showStreamingCloseWarning();
          return;
        }
        else {
          onClose();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);
  
  // Add function to show streaming close warning
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

  // Handle creation window updates
  useEffect(() => {
    if (creation) {
      // Reset streamed content when creation changes (unless streaming is active)
      if (!isStreamingRef.current) {
        // Only reset streamed content if the creation content is different
        // This prevents losing streamed content when auto-opening after streaming completes
        if (creation.content && creation.content !== streamedContent) {
          // If creation has content and it's different from streamed content,
          // use the creation's content as the new streamed content
          setStreamedContent(creation.content);
        } else if (!creation.content && streamedContent) {
          // If creation has no content but we have streamed content, keep the streamed content
          // This happens during the transition from streaming to completed state
          console.log('CreationWindow: Preserving streamed content during transition');
        } else if (!creation.content && !streamedContent) {
          // Both are empty, ensure we start fresh
          setStreamedContent('');
        }
      }
    }
  }, [creation?.id, creation?.type, creation?.title, streamedContent.length, viewMode, creation, streamedContent]);
  
  // Listen for streaming events
  useEffect(() => {
    // Handle incoming streaming content
    const handleStreamToCreation = (event: CustomEvent<StreamToCreationEvent>) => {
      const { content: newContent, creationId } = event.detail;
      
      // Only apply if this is for our current creation
      if (creation && creation.id === creationId) {
        isStreamingRef.current = true;
        setStreamedContent(prev => prev + newContent);
        
        // Automatically switch to code view during streaming
        setViewMode('code');

        // Removed direct scroll call from here

      }
    };
    
    // Switch to code view
    const handleSwitchToCode = (event: CustomEvent<{creationId: string}>) => {
      if (creation && creation.id === event.detail.creationId) {
        // Add animation when switching to code view
        if (viewMode !== 'code') {
          setIsViewTransitioning(true);
          setTimeout(() => {
            setViewMode('code');
            setTimeout(() => {
              setIsViewTransitioning(false);
            }, 300); // Match transition duration
          }, 150); // Half of transition time for crossfade effect
        }
      }
    };
    
    // Switch to preview mode
    const handleSwitchToPreview = (event: CustomEvent<{creationId: string}>) => {
      if (creation && creation.id === event.detail.creationId) {
        // Add animation when switching to preview
        if (viewMode !== 'preview') {
          setIsViewTransitioning(true);
          setTimeout(() => {
            setViewMode('preview');
            setTimeout(() => {
              setIsViewTransitioning(false);
            }, 300); // Match transition duration
          }, 150); // Half of transition time for crossfade effect
        }
        isStreamingRef.current = false;
      }
    };
    
    // Handle closing creation window
    const handleCloseCreationWindow = () => {
      // Don't close if streaming is in progress
      if (isStreamingRef.current) {
        showStreamingCloseWarning();
        return;
      }
      
      // Begin exit animation
      setAnimationState('exiting');
      
      // Allow animation to complete before actual closure
      setTimeout(() => {
        onClose();
      }, 300);
    };

    // Handle switching between creations with animation
    const handleSwitchCreation = (event: CustomEvent<Creation>) => {
      const newCreation = event.detail;
      
      // Don't do anything if streaming is in progress
      if (isStreamingRef.current) {
        showStreamingCloseWarning();
        return;
      }
      
      // Don't do anything if we're trying to switch to the same creation
      if (creation && creation.id === newCreation.id) {
        return;
      }
      
      // Begin exit animation
      setAnimationState('exiting');
      
      // Allow animation to complete before switching to the new creation
      setTimeout(() => {
        // Close current creation and show the new one
        onClose();
        
        // Use a small delay to ensure DOM is updated before showing the new creation
        setTimeout(() => {
          // Dispatch event to show the new creation
          const showEvent = new CustomEvent('show-creation-sidebar', {
            detail: newCreation
          });
          window.dispatchEvent(showEvent);
        }, 50);
      }, 300);
    };
    
    // Add event listeners
    window.addEventListener('stream-to-creation', handleStreamToCreation as EventListener);
    window.addEventListener('switch-creation-code', handleSwitchToCode as EventListener);
    window.addEventListener('switch-creation-preview', handleSwitchToPreview as EventListener);
    window.addEventListener('close-creation-window', handleCloseCreationWindow);
    window.addEventListener('switch-creation', handleSwitchCreation as EventListener);
    
    // Clean up
    return () => {
      window.removeEventListener('stream-to-creation', handleStreamToCreation as EventListener);
      window.removeEventListener('switch-creation-code', handleSwitchToCode as EventListener);
      window.removeEventListener('switch-creation-preview', handleSwitchToPreview as EventListener);
      window.removeEventListener('close-creation-window', handleCloseCreationWindow);
      window.removeEventListener('switch-creation', handleSwitchCreation as EventListener);
    };
  }, [creation, viewMode, onClose, streamedContent, shouldAutoScrollCode, scrollToCodeBottom]);

  // New useEffect for handling auto-scroll on content/mode changes
  useEffect(() => {

    if (
      viewMode === 'code' &&
      isStreamingRef.current && // Ensure streaming is active
      shouldAutoScrollCode &&
      !userInteractedWithCodeScrollRef.current
    ) {
      console.log('CreationWindow: Conditions MET for auto-scroll. Maintaining bottom position immediately.');
      // Directly maintain scroll position during streaming to prevent jumping
      const codeViewArea = codeViewRef.current;
      if (codeViewArea) {
        const preElement = codeViewArea.querySelector('pre');
        const targetElement = preElement || codeViewArea;
        isProgrammaticCodeScrollRef.current = true;
        targetElement.scrollTop = targetElement.scrollHeight;
      }
    } else {
      const reason = [];
      if (viewMode !== 'code') reason.push('viewMode is not code');
      if (!isStreamingRef.current) reason.push('isStreamingRef is false');
      if (!shouldAutoScrollCode) reason.push('shouldAutoScrollCode is false');
      if (userInteractedWithCodeScrollRef.current) reason.push('user has interacted with scroll');
      console.log('CreationWindow: Conditions NOT MET for auto-scroll. Reasons:', reason.join('; ') || 'None, but still not scrolling');
    }
  }, [streamedContent, viewMode, shouldAutoScrollCode, scrollToCodeBottom]);

  // Scroll handler for code view
  useEffect(() => {
    const codeViewArea = codeViewRef.current;
    // Determine the actual scrollable element, likely the <pre> tag or the container itself
    const scrollableElement = codeViewArea?.querySelector('pre') || codeViewArea;

    if (!scrollableElement || viewMode !== 'code') {
      // If no scrollable element or not in code view, do nothing and clean up if listener was attached previously
      return;
    }
    
    console.log('CreationWindow: Attaching scroll listener to:', scrollableElement.tagName);

    const handleCodeScroll = () => {
      if (isProgrammaticCodeScrollRef.current) {
        console.log('CreationWindow: handleCodeScroll - IGNORING programmatic scroll');
        isProgrammaticCodeScrollRef.current = false;
        return;
      }

      const { scrollTop, scrollHeight, clientHeight } = scrollableElement;
      const isAtBottom = scrollHeight - scrollTop - clientHeight <= 1.5; // Using 1.5px threshold for safety
      
      console.log('CreationWindow: handleCodeScroll - USER SCROLL detected. AtBottom:', isAtBottom, 'scrollTop:', scrollTop, 'scrollHeight:', scrollHeight, 'clientHeight:', clientHeight);

      if (isAtBottom) {
        if (!shouldAutoScrollCode) {
          console.log('CreationWindow: User scrolled to code bottom, ENABLING auto-scroll.');
          setShouldAutoScrollCode(true);
          userInteractedWithCodeScrollRef.current = false;
          // Give smooth scroll feedback when user manually returns to bottom
          if (!isStreamingRef.current) {
            setTimeout(() => scrollToCodeBottom(true), 50);
          }
        }
      } else { // User scrolled up, not at the bottom
        if (shouldAutoScrollCode) {
          console.log('CreationWindow: User scrolled up in code, DISABLING auto-scroll.');
          setShouldAutoScrollCode(false);
          userInteractedWithCodeScrollRef.current = true;
        } else if (!userInteractedWithCodeScrollRef.current) {
          // If auto-scroll is already off, and user scrolls further, ensure interaction is marked.
          console.log('CreationWindow: User scroll while auto-scroll already off, ensuring interaction is marked.');
          userInteractedWithCodeScrollRef.current = true;
        }
      }
    };

    scrollableElement.addEventListener('scroll', handleCodeScroll);
    return () => {
      console.log('CreationWindow: Removing scroll listener from:', scrollableElement.tagName);
      scrollableElement.removeEventListener('scroll', handleCodeScroll);
    };
  }, [viewMode, shouldAutoScrollCode, scrollToCodeBottom]); // Dependencies should correctly re-attach listener if viewMode or element changes

  // Custom view mode change handler with animation
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
    onClose();
  };

  if (!creation) return null;

  // Determine the appropriate language for code highlighting
  const getLanguageForHighlighting = () => {
    if (creation.type === 'code' && creation.language) {
      return creation.language;
    }
    
    // Default languages based on creation type
    switch (creation.type) {
      case 'html': return 'html';
      case 'markdown': return 'markdown';
      case 'svg': return 'markup';
      case 'mermaid': return 'text';
      case 'react': return 'jsx';
      default: return 'text';
    }
  };
  
  // Determine what content to display - prioritize actual content over streaming state
  const displayContent = (() => {
    // If we're actively streaming, use the streamed content
    if (isStreamingRef.current && streamedContent) {
      return streamedContent;
    }
    
    // If not streaming, prefer creation.content if it exists, otherwise fall back to streamedContent
    // This handles the case where auto-opening happens with complete creation content
    if (creation.content) {
      return creation.content;
    }
    
    // Fall back to streamed content if creation has no content (transition state)
    if (streamedContent) {
      return streamedContent;
    }
    
    // Final fallback to creation content (even if empty)
    return creation.content || '';
  })();

  return (
    <div 
      className={`creation-window ${animationState}`}
      ref={containerRef}
      data-creation-id={creation.id || `creation-${Date.now()}`}
    >
      <div className="creation-window-header">
        <div className="creation-type-badge">
          <span>{creation.type.charAt(0).toUpperCase() + creation.type.slice(1)}</span>
        </div>
        <h3 className="creation-title">
          {creation.title || `Untitled ${creation.type.charAt(0).toUpperCase() + creation.type.slice(1)}`}
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
          onClick={handleClose}
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
              creation={{...creation, content: displayContent}} 
              viewMode={creation.type === 'react' ? 'react-preview' : 'window'} 
              showToolbar={true} 
            />
          </div>
        ) : (
          <div className="view-container code-container">
            <div className="creation-code-view" ref={codeViewRef}>
              <SyntaxHighlighter
                style={vscDarkPlus}
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