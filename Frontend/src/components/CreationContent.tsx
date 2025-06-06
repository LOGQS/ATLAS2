import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import { Creation } from '../utils/creationsHelper';
import { showHtmlPreview } from '../utils/htmlPreview';
import { Sandpack } from '@codesandbox/sandpack-react';

// Try to load Mermaid if available - same as in CreationViewer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mermaid: any = null;
try {
  // Import mermaid asynchronously but handle initialization synchronously
  import('mermaid').then(m => {
    mermaid = m.default;
    
    // Make sure we only initialize once
    if (!window.mermaidInitialized) {
      mermaid.initialize({
        startOnLoad: false,  // we'll handle rendering ourselves
        theme: document.body.classList.contains('light-theme') ? 'neutral' : 'dark',
        securityLevel: 'loose', // Allow more functionality
        logLevel: 'error',
        fontFamily: 'var(--font-sans)',
        flowchart: {
          useMaxWidth: true,
          htmlLabels: true,
          curve: 'basis'
        }
      });
      window.mermaidInitialized = true;
    }
  }).catch(e => {
    console.warn('Mermaid could not be loaded:', e);
  });
} catch (e) {
  console.warn('Mermaid import error:', e);
}

// Add mermaid initialization flag to Window interface
declare global {
  interface Window {
    mermaidInitialized?: boolean;
    tailwind?: {
      config: object;
    };
  }
}

interface CreationContentProps {
  creation: Creation;
  viewMode?: 'inline' | 'window' | 'fullscreen' | 'react-preview';
  showToolbar?: boolean;
}

// Type definition for the SyntaxHighlighter style objects
type PrismStyleType = typeof vscDarkPlus;

// Interface for React component log data
interface ReactComponentLogData {
  creationId?: string;
  timestamp: string;
  original: string;
  processed: string;
  componentNames: string[];
  defaultExport?: string;
}

// Function to log React component processing details to backend
const logReactComponentProcessing = async (logData: ReactComponentLogData) => {
  try {
    const response = await fetch('/api/debug/log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'react_component_processing',
        data: logData
      })
    });
    
    if (!response.ok) {
      console.warn('Failed to log React component processing:', response.status);
    }
  } catch (error) {
    console.warn('Error logging React component processing:', error);
  }
};

/**
 * CreationContent component - Renders different creation types with specialized viewers
 */
const CreationContent: React.FC<CreationContentProps> = ({
  creation,
  viewMode = 'window',
  showToolbar = true
}) => {
  const mermaidRef = useRef<HTMLDivElement>(null);
  const sandpackRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [fontSize, setFontSize] = useState(14);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(100); // Zoom percentage
  const contentRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  
  // Hold-to-zoom state
  const [holdingZoom, setHoldingZoom] = useState<'in' | 'out' | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const continuousTimerRef = useRef<ReturnType<typeof window.setInterval> | null>(null);
  
  // Alt key state for disabling iframe interactions
  const [altPressed, setAltPressed] = useState(false);
  
  // View mode state for Sandpack component - set default based on viewMode
  const [sandpackView, setSandpackView] = useState<'code' | 'preview' | 'split'>(
    viewMode === 'react-preview' ? 'preview' : 'split'
  );

  // Effect to update sandpackView if viewMode changes
  useEffect(() => {
    if (viewMode === 'react-preview') {
      setSandpackView('preview');
    }
  }, [viewMode]);

  // Keyboard shortcuts for zoom
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Only handle if Ctrl/Cmd is pressed
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '+' || e.key === '=') {
          e.preventDefault();
          zoomIn();
        } else if (e.key === '-') {
          e.preventDefault();
          zoomOut();
        } else if (e.key === '0') {
          e.preventDefault();
          resetZoom();
        }
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => {
      window.removeEventListener('keydown', handleKeyPress);
    };
  }, []);

  // Alt key detection using mouse events (more reliable with iframes)
  useEffect(() => {
    const handleMouseEvent = (e: MouseEvent) => {
      const isAltPressed = e.altKey;
      setAltPressed(isAltPressed); // Always update, don't check if different
    };

    const handleKeyEvent = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        setAltPressed(e.type === 'keydown');
      }
    };

    const handleWindowBlur = () => {
      setAltPressed(false);
    };

    const handleFocus = () => {
      setAltPressed(false);
    };

    // Use mouse events to detect Alt key state (works even when iframe has focus)
    document.addEventListener('mousemove', handleMouseEvent, true);
    document.addEventListener('mousedown', handleMouseEvent, true);
    document.addEventListener('mouseup', handleMouseEvent, true);
    document.addEventListener('wheel', handleMouseEvent, true);
    
    // Keep keyboard listeners as backup
    document.addEventListener('keydown', handleKeyEvent, true);
    document.addEventListener('keyup', handleKeyEvent, true);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('mousemove', handleMouseEvent, true);
      document.removeEventListener('mousedown', handleMouseEvent, true);
      document.removeEventListener('mouseup', handleMouseEvent, true);
      document.removeEventListener('wheel', handleMouseEvent, true);
      document.removeEventListener('keydown', handleKeyEvent, true);
      document.removeEventListener('keyup', handleKeyEvent, true);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleFocus);
    };
  }, []); // Remove dependency on altPressed to prevent re-binding

  // Alt + scroll wheel zoom
  useEffect(() => {
    if (!contentRef.current) return;

    const container = contentRef.current;

    const handleWheel = (e: WheelEvent) => {
      // Only handle if Alt key is pressed
      if (e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        
        // Determine zoom direction based on wheel delta
        if (e.deltaY < 0) {
          // Scrolling up - zoom in
          if (zoomLevel < 1000) {
            zoomIn();
          }
        } else if (e.deltaY > 0) {
          // Scrolling down - zoom out
          if (zoomLevel > 10) {
            zoomOut();
          }
        }
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [zoomLevel]);


  // Listen for messages from the React component iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'REACT_COMPONENT_LOG' && creation.type === 'react') {
        // Log the data to the backend
        logReactComponentProcessing({
          creationId: creation.id,
          timestamp: new Date().toISOString(),
          ...event.data.payload
        });
      }
      else if (event.data?.type === 'REACT_COMPONENT_ERROR' && creation.type === 'react') {
        // Log render errors to the backend
        fetch('/api/debug/log', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'react_component_error',
            data: {
              creationId: creation.id,
              timestamp: new Date().toISOString(),
              ...event.data.payload
            }
          })
        }).catch(err => console.warn('Failed to log render error:', err));
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [creation]);

  // Render Mermaid content when it becomes visible
  useEffect(() => {
    // Capture the ref value at the beginning of the effect
    const mermaidElement = mermaidRef.current;
    
    if (creation.type === 'mermaid' && mermaidElement) {
      // Clear any existing content first
      mermaidElement.innerHTML = '';
      mermaidElement.removeAttribute('data-processed');
      mermaidElement.className = 'mermaid';
      
      // Set a unique id for the mermaid div to avoid rendering conflicts
      const id = `mermaid-diagram-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      mermaidElement.id = id;
      
      // Function to render the diagram
      const renderDiagram = async () => {
        if (!mermaidElement || !mermaid) return;
        
        try {
          // Clear the element completely
          mermaidElement.innerHTML = '';
          mermaidElement.textContent = creation.content;
          
          // Use mermaid.run() for more reliable rendering
          await mermaid.run({
            querySelector: `#${id}`,
            suppressErrors: false
          });
          
          // Verify the diagram was rendered (should have SVG content)
          if (mermaidElement && !mermaidElement.querySelector('svg')) {
            throw new Error('Mermaid diagram did not render properly');
          }
          
          // Fix SVG sizing to display full diagram
          const svg = mermaidElement.querySelector('svg');
          if (svg) {
            // Remove any width/height attributes that might be constraining it
            svg.removeAttribute('width');
            svg.removeAttribute('height');
            svg.removeAttribute('style');
            
            // Set the SVG to fill its container
            svg.style.width = '100%';
            svg.style.height = '100%';
            svg.style.maxWidth = '100%';
            svg.style.maxHeight = '100%';
            svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            
            // Get the viewBox to understand the actual content size
            const viewBox = svg.getAttribute('viewBox');
            if (viewBox) {
              const [, , vbWidth, vbHeight] = viewBox.split(' ').map(Number);
              
              // Get container dimensions
              const container = mermaidElement.parentElement;
              if (container && vbWidth && vbHeight) {
                const containerRect = container.getBoundingClientRect();
                const containerWidth = containerRect.width - 80; // Account for padding
                const containerHeight = containerRect.height - 80;
                
                // Calculate aspect ratios
                const svgAspect = vbWidth / vbHeight;
                const containerAspect = containerWidth / containerHeight;
                
                // Detect if this is a journey diagram
                const isJourneyDiagram = creation.content.toLowerCase().includes('journey');
                
                if (isJourneyDiagram || svgAspect > 2.5) {
                  // For wide diagrams like journey, maximize width usage
                  mermaidElement.style.width = '100%';
                  mermaidElement.style.height = 'auto';
                  mermaidElement.style.minHeight = '200px';
                  
                  // Set a specific height based on aspect ratio
                  const targetHeight = containerWidth / svgAspect;
                  if (targetHeight < containerHeight) {
                    mermaidElement.style.height = `${targetHeight}px`;
                  } else {
                    mermaidElement.style.height = `${containerHeight}px`;
                    mermaidElement.style.width = `${containerHeight * svgAspect}px`;
                  }
                } else {
                  // For regular diagrams
                  if (svgAspect > containerAspect) {
                    // Diagram is wider - fit to width
                    mermaidElement.style.width = '100%';
                    mermaidElement.style.height = 'auto';
                  } else {
                    // Diagram is taller - fit to height
                    mermaidElement.style.height = '100%';
                    mermaidElement.style.width = 'auto';
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error('Error rendering mermaid diagram:', e);
          // Fallback in case of error - show the code
          if (mermaidElement) {
            mermaidElement.className = 'mermaid-error';
            mermaidElement.innerHTML = `
              <div class="error-message">Error rendering diagram</div>
              <pre><code>${creation.content}</code></pre>
            `;
          }
        }
      };
      
      // Check if mermaid is loaded
      if (mermaid && mermaid.run) {
        // Add a small delay to ensure DOM is ready and previous renders are cleaned up
        const timeoutId = setTimeout(() => {
          renderDiagram();
        }, 150);
        
        return () => clearTimeout(timeoutId);
      } else {
        // If mermaid isn't loaded yet, retry when it becomes available
        let attempts = 0;
        const maxAttempts = 20; // 6 seconds max wait
        
        const checkInterval = setInterval(() => {
          attempts++;
          
          if (mermaid && mermaid.run && mermaidElement) {
            clearInterval(checkInterval);
            renderDiagram();
          } else if (attempts >= maxAttempts) {
            clearInterval(checkInterval);
            // Show error after timeout
            if (mermaidElement) {
              mermaidElement.className = 'mermaid-error';
              mermaidElement.innerHTML = `
                <div class="error-message">Mermaid library failed to load</div>
                <pre><code>${creation.content}</code></pre>
              `;
            }
          }
        }, 300);
        
        // Clear interval if component unmounts
        return () => clearInterval(checkInterval);
      }
    }
    
    // Cleanup function to clear mermaid content when switching away
    return () => {
      // Use the captured ref value in the cleanup function
      if (mermaidElement) {
        mermaidElement.innerHTML = '';
        mermaidElement.removeAttribute('data-processed');
      }
    };
  }, [creation]);

  // Handle copy content to clipboard
  const copyContent = () => {
    navigator.clipboard.writeText(creation.content);
    
    // Show toast notification
    const toast = document.createElement('div');
    toast.className = 'copy-toast';
    toast.textContent = 'Copied to clipboard!';
    document.body.appendChild(toast);
    
    // Remove toast after animation
    setTimeout(() => {
      document.body.removeChild(toast);
    }, 2000);
  };

  // Download content as file
  const downloadContent = () => {
    // Helper to generate a safe filename from the title
    const generateSafeFilename = (title: string) => {
      return title
        .replace(/[^a-z0-9]/gi, '-') // Replace non-alphanumeric chars with hyphens
        .replace(/-+/g, '-')         // Replace multiple hyphens with single hyphen
        .replace(/^-|-$/g, '')       // Remove leading/trailing hyphens
        .toLowerCase() || 'untitled'; // Default if empty
    };

    // Get base filename from creation title or type
    const baseFilename = creation.title 
      ? generateSafeFilename(creation.title)
      : `${creation.type}-creation-${Date.now().toString().slice(-6)}`;
    
    // Determine appropriate extension based on type and language
    let extension = 'txt'; // Default fallback
    
    switch (creation.type) {
      case 'code':
        // Map language to appropriate extension
        if (creation.language) {
          const lang = creation.language.toLowerCase();
          // Extensive mapping of languages to extensions
          const langExtMap: Record<string, string> = {
            'typescript': 'ts',
            'tsx': 'tsx',
            'ts': 'ts',
            'javascript': 'js',
            'jsx': 'jsx',
            'js': 'js',
            'python': 'py',
            'py': 'py',
            'ruby': 'rb',
            'rb': 'rb',
            'java': 'java',
            'c#': 'cs',
            'csharp': 'cs',
            'cs': 'cs',
            'cpp': 'cpp',
            'c++': 'cpp',
            'c': 'c',
            'go': 'go',
            'golang': 'go',
            'rust': 'rs',
            'rs': 'rs',
            'php': 'php',
            'swift': 'swift',
            'kotlin': 'kt',
            'scala': 'scala',
            'haskell': 'hs',
            'hs': 'hs',
            'bash': 'sh',
            'shell': 'sh',
            'sh': 'sh',
            'sql': 'sql',
            'r': 'r',
            'perl': 'pl',
            'pl': 'pl',
            'dart': 'dart',
            'lua': 'lua',
            'groovy': 'groovy',
            'elixir': 'ex',
            'erlang': 'erl',
            'clojure': 'clj',
            'julia': 'jl',
            'lisp': 'lisp',
            'css': 'css',
            'scss': 'scss',
            'sass': 'sass',
            'less': 'less',
            'html': 'html',
            'xml': 'xml',
            'yaml': 'yml',
            'yml': 'yml',
            'json': 'json',
            'dockerfile': 'dockerfile',
            'makefile': 'makefile',
            'nginx': 'conf',
            'conf': 'conf',
            'powershell': 'ps1',
            'ps1': 'ps1',
            'terraform': 'tf',
            'latex': 'tex',
          };
          
          extension = langExtMap[lang] || lang; // Use the mapping or the language itself as fallback
        }
        break;
      case 'html':
        extension = 'html';
        break;
      case 'markdown':
        extension = 'md';
        break;
      case 'svg':
        extension = 'svg';
        break;
      case 'mermaid':
        extension = 'mmd';
        break;
      case 'react':
        extension = 'tsx'; // Default to TSX for React components
        break;
    }
    
    const filename = `${baseFilename}.${extension}`;
    
    // Create blob and trigger download
    const blob = new Blob([creation.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    // Show feedback toast
    const toast = document.createElement('div');
    toast.className = 'copy-toast';
    toast.textContent = `Downloaded as ${filename}`;
    document.body.appendChild(toast);
    setTimeout(() => {
      document.body.removeChild(toast);
    }, 2000);
  };
  
  // Font size controls
  const decreaseFontSize = () => {
    if (fontSize > 10) {
      setFontSize(prevSize => prevSize - 2);
    }
  };

  const increaseFontSize = () => {
    if (fontSize < 24) {
      setFontSize(prevSize => prevSize + 2);
    }
  };

  // Theme toggle
  const toggleTheme = () => {
    setTheme(prevTheme => prevTheme === 'dark' ? 'light' : 'dark');
  };

  // Line numbers toggle
  const toggleLineNumbers = () => {
    setShowLineNumbers(prev => !prev);
  };

  // Center-based zoom with pan offset
  const getZoomTransform = () => {
    const scale = zoomLevel / 100;
    if (isPanEnabled && (panOffset.x !== 0 || panOffset.y !== 0)) {
      return `translate(${panOffset.x}px, ${panOffset.y}px) scale(${scale})`;
    }
    return `scale(${scale})`;
  };

  // Check if panning is enabled (always enabled now)
  const isPanEnabled = true;

  // Zoom controls
  const zoomIn = () => {
    setZoomLevel(prev => Math.min(prev + 10, 1000)); // Max 1000%
  };

  const zoomOut = () => {
    setZoomLevel(prev => Math.max(prev - 10, 10)); // Min 10%
  };

  const resetZoom = () => {
    setZoomLevel(100);
    setPanOffset({ x: 0, y: 0 });
  };

  // Hold-to-zoom functionality
  const clearZoomTimers = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (continuousTimerRef.current) {
      clearInterval(continuousTimerRef.current);
      continuousTimerRef.current = null;
    }
  };

  const startContinuousZoom = (direction: 'in' | 'out') => {
    let interval = 100; // Initial interval (ms)
    let accelerationTime = 0;
    
    const zoom = () => {
      if (direction === 'in') {
        setZoomLevel(prev => Math.min(prev + 10, 1000));
      } else {
        setZoomLevel(prev => Math.max(prev - 10, 10));
      }
      
      accelerationTime += interval;
      
      // Accelerate after 1 second
      if (accelerationTime >= 1000 && interval > 50) {
        interval = 50;
        clearInterval(continuousTimerRef.current!);
        continuousTimerRef.current = setInterval(zoom, interval) as unknown as number;
      }
    };
    
    continuousTimerRef.current = setInterval(zoom, interval) as unknown as number;
  };

  const handleZoomMouseDown = (direction: 'in' | 'out') => {
    // Check if button should be disabled
    if ((direction === 'out' && zoomLevel <= 10) || (direction === 'in' && zoomLevel >= 1000)) {
      return;
    }
    
    setHoldingZoom(direction);
    
    // Start hold timer (300ms delay before continuous zoom)
    holdTimerRef.current = setTimeout(() => {
      startContinuousZoom(direction);
    }, 300) as unknown as number;
  };

  const handleZoomMouseUp = () => {
    // If we were just starting to hold, execute single zoom
    if (holdTimerRef.current && !continuousTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      if (holdingZoom === 'in') {
        zoomIn();
      } else if (holdingZoom === 'out') {
        zoomOut();
      }
    }
    
    clearZoomTimers();
    setHoldingZoom(null);
  };

  const handleZoomMouseLeave = () => {
    clearZoomTimers();
    setHoldingZoom(null);
  };

  // Don't automatically reset pan offset when zoom changes
  // Pan offset should only reset when explicitly clicking the reset button

  // Cleanup zoom timers on unmount and window blur
  useEffect(() => {
    const handleWindowBlur = () => {
      clearZoomTimers();
      setHoldingZoom(null);
    };

    window.addEventListener('blur', handleWindowBlur);
    
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      clearZoomTimers();
    };
  }, []);

  // Middle mouse button panning functionality
  useEffect(() => {
    if (!contentRef.current) return;

    const container = contentRef.current;

    const handleMouseDown = (e: MouseEvent) => {
      // Handle middle mouse button for panning (works with or without Alt key)
      if (e.button === 1 && isPanEnabled) {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
        setDragStart({ x: e.clientX, y: e.clientY });
        // Cursor will be handled by CSS class
        
        // Prevent context menu and other default behaviors
        document.body.style.userSelect = 'none';
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !isPanEnabled) return;

      e.preventDefault();
      const deltaX = e.clientX - dragStart.x;
      const deltaY = e.clientY - dragStart.y;

      // Update pan offset directly without bounds checking
      setPanOffset(prev => ({
        x: prev.x + deltaX,
        y: prev.y + deltaY
      }));

      // Update drag start for next movement
      setDragStart({ x: e.clientX, y: e.clientY });
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 1) {
        setIsDragging(false);
        document.body.style.userSelect = '';
      }
    };

    const handleMouseLeave = () => {
      setIsDragging(false);
      document.body.style.userSelect = '';
    };

    // Add event listeners
    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('mouseleave', handleMouseLeave);

    // Set initial cursor style and overflow behavior
    container.style.cursor = 'default';
    
    // Find zoom-wrapper and control overflow based on pan state
    const zoomWrapper = container.querySelector('.zoom-wrapper') as HTMLElement;
    if (zoomWrapper && creation.type !== 'code') {
      // For non-code types, disable scrolling when panning is enabled
      zoomWrapper.style.overflow = isPanEnabled ? 'hidden' : 'auto';
    }

    // Cleanup
    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      container.removeEventListener('mouseleave', handleMouseLeave);
      container.style.cursor = 'default';
    };
  }, [isDragging, dragStart, isPanEnabled, creation.type, zoomLevel, panOffset, altPressed]);

  // Function to render toolbar with controls
  const renderToolbar = () => {
    if (!showToolbar) return null;
    
    return (
      <div className="creation-content-toolbar">
        <div className="toolbar-controls">
          <div className="toolbar-control-group">
            <span className="toolbar-label">Theme:</span>
            <button 
              onClick={toggleTheme} 
              className="toolbar-button theme-toggle"
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5"></circle>
                  <line x1="12" y1="1" x2="12" y2="3"></line>
                  <line x1="12" y1="21" x2="12" y2="23"></line>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                  <line x1="1" y1="12" x2="3" y2="12"></line>
                  <line x1="21" y1="12" x2="23" y2="12"></line>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
                </svg>
              )}
              <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
          </div>
          
          <div className="toolbar-control-group">
            <span className="toolbar-label">Font Size:</span>
            <div className="font-size-controls">
              <button 
                onClick={decreaseFontSize} 
                className="toolbar-button font-size-button"
                disabled={fontSize <= 10}
                title="Decrease font size"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
              <span className="font-size-value">{fontSize}px</span>
              <button 
                onClick={increaseFontSize} 
                className="toolbar-button font-size-button"
                disabled={fontSize >= 24}
                title="Increase font size"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
            </div>
          </div>
          
          {(creation.type === 'code') && (
            <div className="toolbar-control-group">
              <label className="toolbar-checkbox-label">
                <input
                  type="checkbox"
                  checked={showLineNumbers}
                  onChange={toggleLineNumbers}
                  className="toolbar-checkbox"
                />
                Line Numbers
              </label>
            </div>
          )}
        </div>
        
        <div className="toolbar-actions">
          <button 
            onClick={copyContent} 
            className="toolbar-button"
            title="Copy to clipboard"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span>Copy</span>
          </button>
          
          <button 
            onClick={downloadContent} 
            className="toolbar-button"
            title="Download file"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span>Download</span>
          </button>
          
          {creation.type === 'html' && (
            <button 
              onClick={() => {
                // First dispatch an event to close the enhanced viewer
                window.dispatchEvent(new CustomEvent('close-enhanced-viewer'));
                
                // Add a small delay before showing the HTML preview to ensure smooth transition
                setTimeout(() => {
                  // Then open the HTML viewer
                  showHtmlPreview(creation.content);
                }, 100);
              }} 
              className="toolbar-button view-html-button"
              title="Open in HTML viewer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
              <span>Open in Viewer</span>
            </button>
          )}
        </div>
      </div>
    );
  };
  
  // Sandpack error handling for React components
  useEffect(() => {
    if (creation.type !== 'react') return;
    
    // Listen for error events from the preview
    const handleError = (event: ErrorEvent) => {
      // Only capture errors from the Sandpack iframe
      if (sandpackRef.current && event.target instanceof HTMLElement && 
          sandpackRef.current.contains(event.target)) {
        // Log error to backend for debugging
        fetch('/api/debug/log', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'react_component_error',
            data: {
              creationId: creation.id,
              timestamp: new Date().toISOString(),
              error: event.message,
              stack: event.error?.stack || '',
              filename: event.filename,
              lineno: event.lineno,
              colno: event.colno
            }
          })
        }).catch(err => console.warn('Failed to log render error:', err));
      }
    };
    
    window.addEventListener('error', handleError);
    
    return () => {
      window.removeEventListener('error', handleError);
    };
  }, [creation.id, creation.type]);

  // Function to render content based on type
  const renderContent = () => {
    switch (creation.type) {
      case 'code': {
        return (
          <div 
            className="zoom-wrapper" 
            style={{
              transform: getZoomTransform(),
              width: '100%',
              height: '100%'
            }}>
            <div className="code-content" style={{ fontSize: `${fontSize}px` }}>
              <SyntaxHighlighter
                style={theme === 'dark' ? vscDarkPlus as PrismStyleType : vs as PrismStyleType}
                language={creation.language || 'javascript'}
                showLineNumbers={showLineNumbers}
                wrapLines
              >
                {creation.content}
              </SyntaxHighlighter>
            </div>
          </div>
        );
      }
      
      case 'markdown': {
        return (
          <div 
            className="zoom-wrapper" 
            style={{
              transform: getZoomTransform(),
              width: '100%',
              height: '100%'
            }}>
            <div className="markdown-content">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  const language = match ? match[1] : '';
                  const codeContent = String(children).replace(/\n$/, '');
                  
                  // We don't spread props to SyntaxHighlighter to avoid type compatibility issues
                  // between ReactMarkdown's props and SyntaxHighlighter's props
                  
                  return match ? (
                    <div className="code-block-container">
                      <SyntaxHighlighter
                        style={vscDarkPlus as PrismStyleType}
                        language={language}
                      >
                        {codeContent}
                      </SyntaxHighlighter>
                    </div>
                  ) : (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                }
              }}
            >
              {creation.content}
            </ReactMarkdown>
            </div>
          </div>
        );
      }
      
      case 'html': {
        const htmlWithTailwind = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- Tailwind CSS CDN for styling support -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            primary: "#1a1a1a",
            secondary: "#2a2a2a",
            accent: "#4f46e5",
          }
        }
      }
    }
  </script>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
      margin: 0;
      padding: 20px;
      line-height: 1.5;
    }
    * { box-sizing: border-box; }
  </style>
</head>
<body class="dark">
${creation.content}
</body>
</html>`;
        
        return (
          <div className="zoom-wrapper" style={{
            transform: getZoomTransform(),
            transformOrigin: '0 0',
            width: '100%',
            height: '100%'
          }}>
            <div className="html-content">
              <div className="html-preview-frame">
                <iframe
                  srcDoc={htmlWithTailwind}
                  title="HTML Preview"
                  sandbox="allow-scripts"
                  className="html-preview-iframe"
                />
                {altPressed && <div className="alt-overlay"></div>}
              </div>
            </div>
          </div>
        );
      }
      
      case 'svg': {
        return (
          <div className="zoom-wrapper" style={{
            transform: getZoomTransform(),
            transformOrigin: '0 0',
            width: '100%',
            height: '100%'
          }}>
            <div 
              className="svg-container"
              dangerouslySetInnerHTML={{ __html: creation.content }}
            />
          </div>
        );
      }
      
      case 'mermaid': {
        return (
          <div className="zoom-wrapper" style={{
            transform: getZoomTransform(),
            transformOrigin: '0 0',
            width: '100%',
            height: '100%'
          }}>
            <div className="mermaid-container">
              <div 
                ref={mermaidRef} 
                className="mermaid"
              >
                {/* Content is set in useEffect */}
              </div>
            </div>
          </div>
        );
      }
      
      case 'react': {
        // Use Sandpack for rendering React components
        // Hide view toggle buttons if we're in react-preview mode
        const showViewToggle = viewMode !== 'react-preview';

        return (
          <div className="zoom-wrapper" style={{
            transform: getZoomTransform(),
            transformOrigin: '0 0',
            width: '100%',
            height: '100%'
          }}>
            <div className={`react-component-container sandpack-${sandpackView}-view`} ref={sandpackRef}>
            {altPressed && <div className="alt-overlay"></div>}
            <div className="sandpack-actions">
              {showViewToggle && (
                <div className="view-toggle-buttons">
                  <button onClick={() => setSandpackView('code')}>
                    Code
                  </button>
                  <button onClick={() => setSandpackView('preview')}>
                    Preview
                  </button>
                  <button onClick={() => setSandpackView('split')}>
                    Split
                  </button>
                </div>
              )}
              <div className="action-buttons">
                <button
                  onClick={() => {
                    try {
                      // Generate a unique key for session storage
                      const storageKey = `react-playground-code-${Date.now()}`;
                      
                      // Make sure the code is properly formatted to prevent editor range errors
                      const cleanContent = creation.content.trim();
                      
                      // Store the code in session storage
                      sessionStorage.setItem(storageKey, cleanContent);
                      
                      // If there are external dependencies, store them as well
                      if (creation.externalDependencies) {
                        sessionStorage.setItem(
                          `${storageKey}_deps`, 
                          JSON.stringify(creation.externalDependencies)
                        );
                      }
                      
                      // Use a small timeout to ensure storage is complete before opening the window
                      setTimeout(() => {
                        // Open the playground tab, passing only the key
                        window.open(`/react-playground?key=${storageKey}`, '_blank');
                      }, 50);
                    } catch (error) {
                      console.error("Error storing component code in sessionStorage:", error);
                      // Handle potential storage errors (e.g., quota exceeded)
                      alert("Could not open component in new window due to storage error.");
                    }
                  }}
                  className="open-browser-button toolbar-button"
                  title="Open in browser window"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                    <polyline points="15 3 21 3 21 9"></polyline>
                    <line x1="10" y1="14" x2="21" y2="3"></line>
                  </svg>
                  <span>View In Browser</span>
                </button>
              </div>
            </div>
            <Sandpack
              template="react-ts"
              theme={theme === 'dark' ? 'dark' : 'light'}
              options={{
                showNavigator: false,
                showTabs: true,
                editorHeight: '100%',
                classes: {
                  'sp-wrapper': 'custom-wrapper',
                  'sp-layout': 'custom-layout',
                  'sp-tab-button': 'custom-tab'
                },
                showConsole: true,
                showConsoleButton: false,
                showLineNumbers: showLineNumbers,
                wrapContent: true,
                showInlineErrors: true,
                showRefreshButton: true,
                resizablePanels: sandpackView === 'split'
              }}
              files={{
                "/App.tsx": creation.content,
                "/index.tsx": {
                  code: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// Ensure Tailwind CSS is loaded - inject script if not already present
if (!document.querySelector('script[src*="tailwindcss.com"]')) {
  const script = document.createElement('script');
  script.src = 'https://cdn.tailwindcss.com';
  script.onload = () => {
    // Configure Tailwind after it loads
    if (window.tailwind) {
      window.tailwind.config = {
        darkMode: 'class',
        theme: {
          extend: {
            colors: {
              primary: "#1a1a1a",
              secondary: "#2a2a2a",
              accent: "#4f46e5",
            }
          }
        }
      };
    }
  };
  document.head.appendChild(script);
}

// Add global error handler to catch and log errors
window.addEventListener('error', (event) => {
  console.error('React Component Error:', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  });
});

// Mount the component
const rootElement = document.getElementById('root');
const root = createRoot(rootElement);

console.log('Rendering component from App.tsx...');
try {
  root.render(<App />);
  console.log('Component rendered successfully');
} catch (error) {
  console.error('Failed to render component:', error);
}
`,
                  hidden: false
                },
                "/styles.css": {
                  code: `/* Tailwind CSS - Using Play CDN for better Sandpack compatibility */
@import url('https://cdn.tailwindcss.com');

/* Custom CSS */
body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
}

/* Ensure Tailwind config is applied */
:root {
  --tw-color-primary: #1a1a1a;
  --tw-color-secondary: #2a2a2a;
  --tw-color-accent: #4f46e5;
}`,
                  hidden: true
                },
                "/public/index.html": {
                  code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>React Component</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            primary: "#1a1a1a",
            secondary: "#2a2a2a",
            accent: "#4f46e5",
          }
        }
      }
    }
  </script>
</head>
<body>
  <div id="root"></div>
</body>
</html>`,
                  hidden: true
                },
                "/sandbox.config.json": {
                  hidden: true,
                  code: JSON.stringify({
                    infiniteLoopProtection: true,
                    hardReloadOnChange: false,
                    view: "preview"
                  }, null, 2)
                }
              }}
              customSetup={{
                dependencies: {
                  "react": "^18.0.0",
                  "react-dom": "^18.0.0",
                  "tailwindcss": "^3.4.0",
                  "d3": "^7.8.5", 
                  "recharts": "^2.5.0",
                  "prop-types": "^15.8.1",
                  "lodash": "^4.17.21",
                  // Include any external dependencies specified in the creation
                  ...(creation.externalDependencies || {})
                }
              }}
            />
            </div>
          </div>
        );
      }
      
      default: {
        return null;
      }
    }
  };

  // Render zoom controls overlay
  const renderZoomControls = () => {
    // Don't show zoom controls in inline mode only
    if (viewMode === 'inline') return null;
    
    return (
      <div className="zoom-controls-overlay">
        <button 
          className={`zoom-button zoom-out ${holdingZoom === 'out' ? 'holding' : ''}`}
          onMouseDown={() => handleZoomMouseDown('out')}
          onMouseUp={handleZoomMouseUp}
          onMouseLeave={handleZoomMouseLeave}
          onTouchStart={() => handleZoomMouseDown('out')}
          onTouchEnd={handleZoomMouseUp}
          disabled={zoomLevel <= 10}
          title="Zoom out (click or hold)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
            <line x1="8" y1="11" x2="14" y2="11"></line>
          </svg>
        </button>
        
        <button 
          className={`zoom-button zoom-reset ${zoomLevel === 100 && panOffset.x === 0 && panOffset.y === 0 ? 'hidden' : ''}`}
          onClick={resetZoom}
          title="Reset zoom and position"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7"></path>
            <path d="M14 4h6v6"></path>
            <path d="M20 4L10 14"></path>
          </svg>
        </button>
        
        <span className="zoom-level">{zoomLevel}%</span>
        
        <button 
          className={`zoom-button zoom-in ${holdingZoom === 'in' ? 'holding' : ''}`}
          onMouseDown={() => handleZoomMouseDown('in')}
          onMouseUp={handleZoomMouseUp}
          onMouseLeave={handleZoomMouseLeave}
          onTouchStart={() => handleZoomMouseDown('in')}
          onTouchEnd={handleZoomMouseUp}
          disabled={zoomLevel >= 1000}
          title="Zoom in (click or hold)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
            <line x1="11" y1="8" x2="11" y2="14"></line>
            <line x1="8" y1="11" x2="14" y2="11"></line>
          </svg>
        </button>
      </div>
    );
  };

  return (
    <div className={`creation-content-container ${creation.type}-viewer ${viewMode} ${viewMode === 'react-preview' ? 'react-preview' : ''}`}>
      {renderToolbar()}
      <div 
        className={`creation-content-main ${isDragging ? 'panning' : ''}`}
        ref={contentRef}
      >
        {renderContent()}
      </div>
      {renderZoomControls()}
    </div>
  );
};

export default CreationContent;