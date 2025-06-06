import React, { FC, useState, useEffect, useRef, useCallback, JSX } from 'react';
import {
  PdfLoader,
  PdfHighlighter,
  Popup,
  IHighlight,
  NewHighlight,
  ViewportHighlight
} from 'react-pdf-highlighter';
import 'react-pdf-highlighter/dist/style.css';
import '../styles/pdf-viewer.css';

// Extend IHighlight to include our custom properties
interface ExtendedHighlight extends IHighlight {
  color?: string;
  timestamp?: string;
}

interface PDFViewerProps {
  url: string;
  onClose: () => void;
}

interface MemoizedPdfHighlighterProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfDocument: any;
  zoomLevel: number;
  highlighterEnabled: boolean;
  handleSelectionFinished: (position: IHighlight["position"], content: IHighlight["content"], hideTip: () => void) => null;
  renderHighlight: (
    highlight: ViewportHighlight,
    index: number,
    setTip: (highlight: ViewportHighlight, callback: (highlight: ViewportHighlight) => JSX.Element) => void,
    hideTip: () => void
  ) => JSX.Element;
  highlights: ExtendedHighlight[];
  currentPage: number;
  totalPages: number;
  setCurrentPage: (page: number) => void;
  setPageInputValue: (value: string) => void;
  scrollTimeoutRef: React.RefObject<number | null>;
}

const MemoizedPdfHighlighter: FC<MemoizedPdfHighlighterProps> = React.memo(({
  pdfDocument,
  zoomLevel,
  highlighterEnabled,
  handleSelectionFinished,
  renderHighlight,
  highlights,
  currentPage,
  totalPages,
  setCurrentPage,
  setPageInputValue,
  scrollTimeoutRef
}) => {
  const onScrollChange = useCallback(() => {
    // Throttle scroll change events for better performance
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    
    scrollTimeoutRef.current = window.setTimeout(() => {
      // Get the actual scrollable container - the pdf-document-area
      const documentArea = document.querySelector('.pdf-document-area');
      const pdfViewer = document.querySelector('.PdfHighlighter');
      
      if ((documentArea || pdfViewer) && totalPages > 0) {
        // Use documentArea as the primary container for scroll calculations
        const container = documentArea || pdfViewer;
        const containerRect = container!.getBoundingClientRect();
        
        // Look for pages using multiple possible selectors to ensure compatibility
        let pages = container!.querySelectorAll('.react-pdf__Page');
        
        // If no react-pdf pages found, try other selectors
        if (pages.length === 0) {
          pages = container!.querySelectorAll('.page, [data-page-number]');
        }
        
        if (pages.length > 0) {
          let visiblePage = 1;
          let maxVisibility = 0;
          
          pages.forEach((page, index) => {
            const rect = page.getBoundingClientRect();
            
            // Get page number from data attribute or use index + 1
            const pageNum = parseInt(page.getAttribute('data-page-number') || '') || (index + 1);
            
            // Calculate visibility relative to the container, not the window
            const containerTop = containerRect.top;
            const containerBottom = containerRect.bottom;
            const containerHeight = containerRect.height;
            
            // Calculate intersection with the container viewport
            const pageTop = rect.top;
            const pageBottom = rect.bottom;
            const pageHeight = rect.height;
            
            const visibleTop = Math.max(pageTop, containerTop);
            const visibleBottom = Math.min(pageBottom, containerBottom);
            const visibleHeight = Math.max(0, visibleBottom - visibleTop);
            
            // Calculate visibility ratio relative to container
            const visibilityRatio = pageHeight > 0 ? visibleHeight / pageHeight : 0;
            
            // Also consider if the page is in the center area of the container
            const pageCenterY = (pageTop + pageBottom) / 2;
            const containerCenterY = (containerTop + containerBottom) / 2;
            const distanceFromCenter = Math.abs(pageCenterY - containerCenterY);
            const centerWeight = Math.max(0, 1 - (distanceFromCenter / (containerHeight / 2)));
            
            // Combine visibility and center proximity for better page detection
            const combinedScore = visibilityRatio * 0.8 + centerWeight * 0.2;
            
            // Consider a page "current" if it has the highest combined score and is reasonably visible
            if (combinedScore > maxVisibility && visibilityRatio > 0.1) {
              maxVisibility = combinedScore;
              visiblePage = pageNum;
            }
          });
          
          // Only update if the page actually changed and is valid
          if (visiblePage !== currentPage && visiblePage >= 1 && visiblePage <= totalPages) {
            setCurrentPage(visiblePage);
            setPageInputValue(visiblePage.toString());
          }
        }
      }
    }, 150); // Reduced throttle for more responsive updates
  }, [currentPage, totalPages, setCurrentPage, setPageInputValue, scrollTimeoutRef]);

  return (
    <div 
      className="pdf-zoom-container"
      style={{
        transform: `scale(${zoomLevel}) translate(0px, 0px)`,
      }}
    >
      <PdfHighlighter
        pdfDocument={pdfDocument}
        enableAreaSelection={() => highlighterEnabled}
        onSelectionFinished={highlighterEnabled ? handleSelectionFinished : () => null}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        highlightTransform={renderHighlight as any}
        highlights={highlights}
        onScrollChange={onScrollChange}
        scrollRef={() => {
          // Store scroll function for potential use in navigation
        }}
      />
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison function to prevent unnecessary re-renders
  return (
    prevProps.pdfDocument === nextProps.pdfDocument &&
    prevProps.zoomLevel === nextProps.zoomLevel &&
    prevProps.highlighterEnabled === nextProps.highlighterEnabled &&
    prevProps.highlights.length === nextProps.highlights.length &&
    prevProps.currentPage === nextProps.currentPage &&
    prevProps.totalPages === nextProps.totalPages &&
    prevProps.renderHighlight === nextProps.renderHighlight
  );
});

const PDFViewer: FC<PDFViewerProps> = ({ url, onClose }) => {
  const [highlights, setHighlights] = useState<ExtendedHighlight[]>([]);
  const [, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(true); // Start in fullscreen for better UX
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [selectedHighlightColor, setSelectedHighlightColor] = useState('#FFFF00');
  const [searchTerm, setSearchTerm] = useState('');
  const [highlighterEnabled, setHighlighterEnabled] = useState(true);
  const [pageInputValue, setPageInputValue] = useState('1');
  const [pdfLoadTrigger, setPdfLoadTrigger] = useState(0);
  const modalRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocumentRef = useRef<any>(null);
  const scrollTimeoutRef = useRef<number | null>(null);
  const isPanningRef = useRef(false);
  const lastPanPointRef = useRef<{ x: number; y: number } | null>(null);
  const panOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const addHighlight = useCallback((highlight: NewHighlight) => {
    const newHighlight: ExtendedHighlight = { 
      ...highlight, 
      id: String(Date.now()),
      color: selectedHighlightColor,
      timestamp: new Date().toISOString()
    } as ExtendedHighlight;
    setHighlights((prev) => [newHighlight, ...prev]);
  }, [selectedHighlightColor]);

  // Highlight color options
  const highlightColors = [
    { color: '#FFFF00', name: 'Yellow' },
    { color: '#FFB3BA', name: 'Pink' },
    { color: '#BAFFC9', name: 'Green' },
    { color: '#BAE1FF', name: 'Blue' },
    { color: '#FFFFBA', name: 'Light Yellow' },
    { color: '#E1BAFF', name: 'Purple' }
  ];

  // Navigation functions
  const goToPage = useCallback((pageNumber: number) => {
    if (pageNumber >= 1 && pageNumber <= totalPages) {
      setCurrentPage(pageNumber);
      setPageInputValue(pageNumber.toString());
      
      // Navigate to the specific page in the PDF viewer
      const documentArea = document.querySelector('.pdf-document-area');
      const pdfViewer = document.querySelector('.PdfHighlighter');
      const container = documentArea || pdfViewer;
      
      if (container) {
        // Look for the page element using the same selectors as scroll detection
        let pageElement: HTMLElement | null = null;
        
        // First try react-pdf pages
        const reactPdfPages = container.querySelectorAll('.react-pdf__Page');
        if (reactPdfPages.length > 0 && pageNumber <= reactPdfPages.length) {
          pageElement = reactPdfPages[pageNumber - 1] as HTMLElement;
        }
        
        // If not found, try data-page-number selector
        if (!pageElement) {
          pageElement = container.querySelector(`[data-page-number="${pageNumber}"]`) as HTMLElement;
        }
        
        // If still not found, try generic page selector
        if (!pageElement) {
          pageElement = container.querySelector(`.page[data-page-number="${pageNumber}"]`) as HTMLElement;
        }
        
        if (pageElement) {
          // Scroll to the page with smooth animation, accounting for zoom
          pageElement.scrollIntoView({ 
            behavior: 'smooth', 
            block: 'start' 
          });
        } else {
          // Fallback: calculate approximate scroll position based on page height
          const allPages = container.querySelectorAll('.react-pdf__Page, .page, [data-page-number]');
          if (allPages.length > 0) {
            // Calculate average page height from existing pages, accounting for zoom
            let totalHeight = 0;
            let pageCount = 0;
            allPages.forEach(page => {
              const rect = page.getBoundingClientRect();
              if (rect.height > 0) {
                // Adjust height calculation for zoom level
                totalHeight += rect.height / zoomLevel;
                pageCount++;
              }
            });
            
            const averagePageHeight = pageCount > 0 ? totalHeight / pageCount : 850;
            const scrollTop = (pageNumber - 1) * averagePageHeight * zoomLevel;
            
            container.scrollTo({
              top: scrollTop,
              behavior: 'smooth'
            });
          } else {
            // Last resort: use estimated page height with zoom adjustment
            const approximatePageHeight = 850 * zoomLevel;
            const scrollTop = (pageNumber - 1) * approximatePageHeight;
            container.scrollTo({
              top: scrollTop,
              behavior: 'smooth'
            });
          }
        }
      }
    }
  }, [totalPages, zoomLevel]);

  // Handle page input changes with validation
  const handlePageInputChange = useCallback((value: string) => {
    setPageInputValue(value);
  }, []);

  const validateAndSetPage = useCallback(() => {
    const pageNumber = parseInt(pageInputValue);
    if (!isNaN(pageNumber) && pageNumber >= 1 && pageNumber <= totalPages) {
      setCurrentPage(pageNumber);
      goToPage(pageNumber);
    } else {
      // Reset to current page if invalid
      setPageInputValue(currentPage.toString());
    }
  }, [pageInputValue, totalPages, currentPage, goToPage]);

  // Toggle highlighter
  const toggleHighlighter = useCallback(() => {
    setHighlighterEnabled(prev => !prev);
  }, []);

  const nextPage = useCallback(() => {
    goToPage(currentPage + 1);
  }, [currentPage, goToPage]);

  const previousPage = useCallback(() => {
    goToPage(currentPage - 1);
  }, [currentPage, goToPage]);

  // Zoom functions
  const zoomIn = useCallback(() => {
    setZoomLevel(prev => {
      const newZoom = Math.min(prev + 0.25, 3);
      // Update transform immediately to maintain pan offset
      const zoomContainer = document.querySelector('.pdf-zoom-container') as HTMLElement;
      if (zoomContainer) {
        zoomContainer.style.transform = `scale(${newZoom}) translate(${panOffsetRef.current.x}px, ${panOffsetRef.current.y}px)`;
      }
      return newZoom;
    });
  }, []);

  const zoomOut = useCallback(() => {
    setZoomLevel(prev => {
      const newZoom = Math.max(prev - 0.25, 0.5);
      // Update transform immediately to maintain pan offset
      const zoomContainer = document.querySelector('.pdf-zoom-container') as HTMLElement;
      if (zoomContainer) {
        zoomContainer.style.transform = `scale(${newZoom}) translate(${panOffsetRef.current.x}px, ${panOffsetRef.current.y}px)`;
      }
      return newZoom;
    });
  }, []);

  const resetZoom = useCallback(() => {
    // Reset both zoom and pan
    panOffsetRef.current = { x: 0, y: 0 };
    setZoomLevel(1);
    const zoomContainer = document.querySelector('.pdf-zoom-container') as HTMLElement;
    if (zoomContainer) {
      zoomContainer.style.transform = `scale(1) translate(0px, 0px)`;
    }
  }, []);

  // Toggle sidebar
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => !prev);
  }, []);

  // Handle panning with middle mouse button
  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button === 1) { // Middle mouse button
        event.preventDefault();
        isPanningRef.current = true;
        lastPanPointRef.current = { x: event.clientX, y: event.clientY };
        
        const documentArea = document.querySelector('.pdf-document-area') as HTMLElement;
        if (documentArea) {
          documentArea.classList.add('panning');
        }
        document.body.style.cursor = 'grabbing';
      }
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (isPanningRef.current && lastPanPointRef.current) {
        event.preventDefault();
        const deltaX = event.clientX - lastPanPointRef.current.x;
        const deltaY = event.clientY - lastPanPointRef.current.y;
        
        // Update pan offset
        panOffsetRef.current.x += deltaX;
        panOffsetRef.current.y += deltaY;
        
        // Apply transform to zoom container directly
        const zoomContainer = document.querySelector('.pdf-zoom-container') as HTMLElement;
        if (zoomContainer) {
          zoomContainer.style.transform = `scale(${zoomLevel}) translate(${panOffsetRef.current.x}px, ${panOffsetRef.current.y}px)`;
        }
        
        lastPanPointRef.current = { x: event.clientX, y: event.clientY };
      }
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (event.button === 1 || isPanningRef.current) { // Middle mouse button or any mouse up while panning
        event.preventDefault();
        isPanningRef.current = false;
        lastPanPointRef.current = null;
        
        const documentArea = document.querySelector('.pdf-document-area') as HTMLElement;
        if (documentArea) {
          documentArea.classList.remove('panning');
        }
        document.body.style.cursor = '';
      }
    };

    const handleMouseLeave = () => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
        lastPanPointRef.current = null;
        
        const documentArea = document.querySelector('.pdf-document-area') as HTMLElement;
        if (documentArea) {
          documentArea.classList.remove('panning');
        }
        document.body.style.cursor = '';
      }
    };

    const handleWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement;
      const documentArea = document.querySelector('.pdf-document-area');
      
      if (documentArea && documentArea.contains(target)) {
        // If Alt key is pressed, handle zoom
        if (event.altKey) {
          event.preventDefault();
          
          // Determine zoom direction based on wheel delta
          if (event.deltaY < 0) {
            // Scrolling up - zoom in
            zoomIn();
          } else {
            // Scrolling down - zoom out
            zoomOut();
          }
          return false;
        }
        
        // Otherwise, prevent default scrolling behavior
        event.preventDefault();
        return false;
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mouseleave', handleMouseLeave);
    document.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mouseleave', handleMouseLeave);
      document.removeEventListener('wheel', handleWheel);
      document.body.style.cursor = '';
    };
  }, [zoomLevel, zoomIn, zoomOut]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Prevent default for our handled keys
      const handledKeys = ['Escape', 'F11', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '=', '-', '0'];
      if (handledKeys.includes(event.key) || (event.key === 'f' && event.ctrlKey)) {
        
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        } else if (event.key === 'F11' || (event.key === 'f' && event.ctrlKey)) {
          event.preventDefault();
          setIsFullscreen(!isFullscreen);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          previousPage();
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          nextPage();
        } else if ((event.key === '=' || event.key === '+') && event.ctrlKey) {
          event.preventDefault();
          zoomIn();
        } else if (event.key === '-' && event.ctrlKey) {
          event.preventDefault();
          zoomOut();
        } else if (event.key === '0' && event.ctrlKey) {
          event.preventDefault();
          resetZoom();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen, onClose, previousPage, nextPage, zoomIn, zoomOut, resetZoom]);

  // Handle outside click to close
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const timeoutRef = scrollTimeoutRef.current;
    
    return () => {
      document.body.style.overflow = 'unset';
      // Cleanup scroll timeout
      if (timeoutRef) {
        clearTimeout(timeoutRef);
      }
    };
  }, []);


  // Remove unused toggleFullscreen - functionality is handled in keyboard shortcuts

  const handleLoadSuccess = useCallback(() => {
    setIsLoading(false);
    setError(null);
  }, []);

  // Handle PDF document initialization
  useEffect(() => {
    if (pdfDocumentRef.current && totalPages === 0 && pdfLoadTrigger > 0) {
      const numPages = pdfDocumentRef.current.numPages;
      if (numPages) {
        setTotalPages(numPages);
        setPageInputValue('1');
        handleLoadSuccess();
      }
    }
  }, [pdfLoadTrigger, totalPages, handleLoadSuccess]);

  // Ensure page input value stays in sync with current page
  useEffect(() => {
    // Only update if the input value doesn't match the current page
    // and the input is not currently being edited (has focus)
    const pageInput = document.querySelector('.pdf-page-input') as HTMLInputElement;
    const isInputFocused = pageInput && document.activeElement === pageInput;
    
    if (!isInputFocused && pageInputValue !== currentPage.toString()) {
      setPageInputValue(currentPage.toString());
    }
  }, [currentPage, pageInputValue]);

  const handleLoadError = useCallback((error: Error) => {
    setIsLoading(false);
    setError(error.message || 'Failed to load PDF. Please check your connection and try again.');
  }, []);

  const retryLoad = useCallback(() => {
    setIsLoading(true);
    setError(null);
  }, []);

  const renderHighlight = useCallback(
    (
      highlight: ViewportHighlight,
      index: number,
      setTip: (highlight: ViewportHighlight, callback: (highlight: ViewportHighlight) => JSX.Element) => void,
      hideTip: () => void
    ) => {
      const highlightColor = (highlight as unknown as ExtendedHighlight).color || selectedHighlightColor;
      return (
        <Popup
          key={index}
          popupContent={<div className="highlight-popup">{highlight.comment.text}</div>}
          onMouseOver={(popupContent) => setTip(highlight, () => popupContent)}
          onMouseOut={hideTip}
        >
          <div
            className="Highlight"
            data-color={highlightColor}
            style={{
              position: 'absolute',
              background: `${highlightColor}66`,
              border: `1px solid ${highlightColor}99`,
              left: highlight.position.boundingRect.left,
              top: highlight.position.boundingRect.top,
              width: highlight.position.boundingRect.width,
              height: highlight.position.boundingRect.height,
              zIndex: 3,
              pointerEvents: 'auto'
            }}
          />
        </Popup>
      );
    },
    [selectedHighlightColor]
  );

  const handleSelectionFinished = useCallback(
    (position: IHighlight["position"], content: IHighlight["content"], hideTip: () => void) => {
      const text = window.prompt('Add a note to this highlight:', '') || '';
      if (text.trim() !== '') {
        const newHighlight: NewHighlight = { 
          position, 
          content, 
          comment: { text, emoji: '' }
        };
        addHighlight(newHighlight);
      }
      if (hideTip && typeof hideTip === 'function') {
        hideTip();
      }
      return null;
    },
    [addHighlight]
  );

  if (error) {
    return (
      <div className="pdf-viewer-overlay" onClick={onClose}>
        <div 
          ref={modalRef}
          className="pdf-viewer-container pdf-error-container" 
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="close-button pdf-close" 
            onClick={onClose} 
            aria-label="Close PDF viewer"
          >
            ×
          </button>
          <div className="pdf-error-content">
            <div className="pdf-error-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="15" y1="9" x2="9" y2="15"></line>
                <line x1="9" y1="9" x2="15" y2="15"></line>
              </svg>
            </div>
            <h3 className="pdf-error-title">Failed to Load PDF</h3>
            <p className="pdf-error-message">{error}</p>
            <div className="pdf-error-actions">
              <button 
                className="pdf-retry-button" 
                onClick={retryLoad}
                aria-label="Retry loading PDF"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <polyline points="1 20 1 14 7 14"></polyline>
                  <path d="M20.49 9A9 9 0 0 0 5.64 5.64l1.27 1.27a7 7 0 0 1 11.72 11.72"></path>
                  <path d="M3.51 15a9 9 0 0 0 14.85 4.36l-1.27-1.27a7 7 0 0 1-11.72-11.72"></path>
                </svg>
                Retry
              </button>
              <button 
                className="pdf-close-button" 
                onClick={onClose}
                aria-label="Close"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`pdf-viewer-overlay enhanced ${isFullscreen ? 'fullscreen' : ''}`}>
      <div 
        ref={modalRef}
        className={`pdf-viewer-container enhanced ${isFullscreen ? 'fullscreen' : ''}`}
      >
        {/* Enhanced Toolbar */}
        <div className="pdf-enhanced-toolbar">
          <div className="pdf-toolbar-left">
            <div className="pdf-viewer-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
              </svg>
              <span>PDF Viewer</span>
            </div>
          </div>

          <div className="pdf-toolbar-center">
            {/* Page Navigation */}
            <div className="pdf-page-controls">
              <button 
                className="pdf-nav-button" 
                onClick={previousPage}
                disabled={currentPage <= 1}
                title="Previous page (← or ↑)"
                aria-label="Previous page"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
              </button>
              
              <div className="pdf-page-info">
                <input 
                  type="text" 
                  value={pageInputValue}
                  onChange={(e) => handlePageInputChange(e.target.value)}
                  onBlur={validateAndSetPage}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      validateAndSetPage();
                      e.currentTarget.blur();
                    }
                  }}
                  className="pdf-page-input"
                  placeholder="Page"
                />
                <span className="pdf-page-separator">/</span>
                <span className="pdf-total-pages">{totalPages}</span>
              </div>
              
              <button 
                className="pdf-nav-button" 
                onClick={nextPage}
                disabled={currentPage >= totalPages}
                title="Next page (→ or ↓)"
                aria-label="Next page"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
              </button>
            </div>

            {/* Zoom Controls */}
            <div className="pdf-zoom-controls">
              <button 
                className="pdf-zoom-button" 
                onClick={zoomOut}
                disabled={zoomLevel <= 0.5}
                title="Zoom out (Ctrl + - or Alt + Scroll down)"
                aria-label="Zoom out"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="M21 21l-4.35-4.35"></path>
                  <line x1="8" y1="11" x2="14" y2="11"></line>
                </svg>
              </button>
              
              <button 
                className="pdf-zoom-level" 
                onClick={resetZoom}
                title="Click to reset zoom (Ctrl + 0)"
                style={{ 
                  color: zoomLevel !== 1 ? 'var(--accent, #4f46e5)' : 'var(--text-secondary, #94a3b8)',
                  fontWeight: zoomLevel !== 1 ? '600' : 'normal'
                }}
              >
                {Math.round(zoomLevel * 100)}%
              </button>
              
              <button 
                className="pdf-zoom-button" 
                onClick={zoomIn}
                disabled={zoomLevel >= 3}
                title="Zoom in (Ctrl + + or Alt + Scroll up)"
                aria-label="Zoom in"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="M21 21l-4.35-4.35"></path>
                  <line x1="11" y1="8" x2="11" y2="14"></line>
                  <line x1="8" y1="11" x2="14" y2="11"></line>
                </svg>
              </button>
              
              <button 
                className="pdf-zoom-button" 
                onClick={resetZoom}
                title="Reset zoom (Ctrl + 0)"
                aria-label="Reset zoom"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                </svg>
              </button>
            </div>
          </div>

          <div className="pdf-toolbar-right">
            {/* Highlighter Toggle */}
            <button 
              className={`pdf-control-button ${highlighterEnabled ? 'active' : ''}`}
              onClick={toggleHighlighter}
              title={highlighterEnabled ? 'Disable highlighter' : 'Enable highlighter'}
              aria-label={highlighterEnabled ? 'Disable highlighter' : 'Enable highlighter'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 11-6 6v3h3l6-6"></path>
                <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"></path>
              </svg>
            </button>
            
            {/* Highlight Color Picker */}
            <div className="pdf-highlight-colors">
              {highlightColors.map((colorOption) => (
                <button
                  key={colorOption.color}
                  className={`pdf-color-button ${selectedHighlightColor === colorOption.color ? 'active' : ''}`}
                  style={{ backgroundColor: colorOption.color }}
                  onClick={() => setSelectedHighlightColor(colorOption.color)}
                  title={`Highlight with ${colorOption.name}`}
                  aria-label={`Select ${colorOption.name} highlight color`}
                  disabled={!highlighterEnabled}
                />
              ))}
            </div>
            
            {/* Save PDF with Highlights */}
            <button 
              className="pdf-control-button" 
              onClick={async () => {
                try {
                  // For now, create a comprehensive highlights report as a fallback
                  // TODO: Implement actual PDF manipulation with pdf-lib library
                  
                  const reportContent = `PDF Highlights Report\n` +
                    `Document: ${url.split('/').pop() || 'document.pdf'}\n` +
                    `Generated: ${new Date().toLocaleString()}\n` +
                    `Total Highlights: ${highlights.length}\n\n` +
                    `=== SUMMARY ===\n` +
                    highlights.map((highlight, index) => 
                      `${index + 1}. [Page ${highlight.position?.pageNumber || 1}] ${highlight.comment.text}\n`
                    ).join('') +
                    `\n=== DETAILED HIGHLIGHTS ===\n\n` +
                    highlights.map((highlight, index) => 
                      `Highlight #${index + 1}\n` +
                      `Page: ${highlight.position?.pageNumber || 1}\n` +
                      `Selected Text: "${highlight.content?.text || ''}"\n` +
                      `Note: ${highlight.comment.text}\n` +
                      `Color: ${highlight.color || selectedHighlightColor}\n` +
                      `Timestamp: ${new Date(highlight.timestamp || Date.now()).toLocaleString()}\n` +
                      `${'='.repeat(50)}\n\n`
                    ).join('');

                  // Create and download the report
                  const blob = new Blob([reportContent], { type: 'text/plain' });
                  const reportUrl = URL.createObjectURL(blob);
                  const link = document.createElement('a');
                  link.href = reportUrl;
                  link.download = `${url.split('/').pop()?.replace('.pdf', '') || 'document'}-highlights-report.txt`;
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                  URL.revokeObjectURL(reportUrl);

                  // Also try to save the original PDF
                  try {
                    const pdfResponse = await fetch(url);
                    const pdfBlob = await pdfResponse.blob();
                    const pdfUrl = URL.createObjectURL(pdfBlob);
                    const pdfLink = document.createElement('a');
                    pdfLink.href = pdfUrl;
                    pdfLink.download = `${url.split('/').pop() || 'document.pdf'}`;
                    document.body.appendChild(pdfLink);
                    pdfLink.click();
                    document.body.removeChild(pdfLink);
                    URL.revokeObjectURL(pdfUrl);
                    
                    console.log('Saved original PDF and highlights report. For embedded highlights in PDF, pdf-lib library integration is needed.');
                  } catch (pdfError) {
                    console.warn('Could not save original PDF:', pdfError);
                  }
                } catch (error) {
                  console.error('Error saving PDF with highlights:', error);
                }
              }}
              title="Save PDF and highlights report"
              aria-label="Save PDF and highlights report"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                <polyline points="17 21 17 13 7 13 7 21"></polyline>
                <polyline points="7 3 7 8 15 8"></polyline>
              </svg>
            </button>
            
            {/* Toggle Sidebar */}
            <button 
              className="pdf-control-button" 
              onClick={toggleSidebar}
              title={sidebarCollapsed ? 'Show highlights' : 'Hide highlights'}
              aria-label={sidebarCollapsed ? 'Show highlights sidebar' : 'Hide highlights sidebar'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="15" y1="3" x2="15" y2="21"></line>
              </svg>
            </button>
            
            {/* Close Button */}
            <button 
              className="pdf-control-button close" 
              onClick={onClose} 
              title="Close (Esc)"
              aria-label="Close PDF viewer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        {/* Main Content Area with Two-Column Layout */}
        <div className="pdf-main-content">
          {/* PDF Viewer Area */}
          <div className={`pdf-document-area ${sidebarCollapsed ? 'full-width' : ''}`}>
            <PdfLoader 
              url={url} 
              beforeLoad={
                <div className="pdf-loading">
                  <div className="pdf-loading-spinner">
                    <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"></circle>
                      <path d="M12 6v2"></path>
                    </svg>
                  </div>
                  <p className="pdf-loading-text">Loading PDF...</p>
                </div>
              }
            >
              {(pdfDocument) => {
                if (pdfDocument) {
                  // Store reference for page info but don't call setState during render
                  pdfDocumentRef.current = pdfDocument;
                  // Trigger effect to update state outside of render
                  setTimeout(() => setPdfLoadTrigger(prev => prev + 1), 0);
                  
                  return (
                    <MemoizedPdfHighlighter 
                      pdfDocument={pdfDocument}
                      zoomLevel={zoomLevel}
                      highlighterEnabled={highlighterEnabled}
                      handleSelectionFinished={handleSelectionFinished}
                      renderHighlight={renderHighlight}
                      highlights={highlights}
                      currentPage={currentPage}
                      totalPages={totalPages}
                      setCurrentPage={setCurrentPage}
                      setPageInputValue={setPageInputValue}
                      scrollTimeoutRef={scrollTimeoutRef}
                    />
                  );
                } else {
                  handleLoadError(new Error('Failed to load PDF'));
                  return null;
                }
              }}
            </PdfLoader>
          </div>

          {/* Enhanced Highlights Sidebar */}
          {!sidebarCollapsed && (
            <div className="pdf-highlights-sidebar">
              <div className="pdf-sidebar-header">
                <h3 className="pdf-sidebar-title">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m9 11 3 3L22 4"></path>
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                  </svg>
                  Highlights ({highlights.length})
                </h3>
                
                {highlights.length > 0 && (
                  <div className="pdf-sidebar-actions">
                    <input
                      type="text"
                      placeholder="Search highlights..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pdf-search-input"
                    />
                    <button
                      className="pdf-export-button"
                      title="Export highlights"
                      onClick={() => {
                        // Export highlights as JSON or text file
                        const exportData = {
                          document: url.split('/').pop() || 'document.pdf',
                          exportDate: new Date().toISOString(),
                          totalHighlights: highlights.length,
                          highlights: highlights.map((highlight, index) => ({
                            id: highlight.id,
                            index: index + 1,
                            text: highlight.comment.text,
                            selectedText: highlight.content?.text || '',
                            color: highlight.color || selectedHighlightColor,
                            page: highlight.position?.pageNumber || 1,
                            timestamp: highlight.timestamp || new Date().toISOString(),
                            position: {
                              boundingRect: highlight.position?.boundingRect,
                              rects: highlight.position?.rects
                            }
                          }))
                        };

                        // Create downloadable file
                        const dataStr = JSON.stringify(exportData, null, 2);
                        const dataBlob = new Blob([dataStr], { type: 'application/json' });
                        const url_export = URL.createObjectURL(dataBlob);
                        
                        // Create download link
                        const link = document.createElement('a');
                        link.href = url_export;
                        link.download = `pdf-highlights-${new Date().toISOString().split('T')[0]}.json`;
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        
                        // Clean up the URL object
                        URL.revokeObjectURL(url_export);
                        
                        // Also offer text format export
                        setTimeout(() => {
                          const textContent = `PDF Highlights Export\n` +
                            `Document: ${exportData.document}\n` +
                            `Export Date: ${new Date().toLocaleString()}\n` +
                            `Total Highlights: ${highlights.length}\n\n` +
                            highlights.map((highlight, index) => 
                              `Highlight #${index + 1}\n` +
                              `Page: ${highlight.position?.pageNumber || 1}\n` +
                              `Selected Text: "${highlight.content?.text || ''}"\n` +
                              `Note: ${highlight.comment.text}\n` +
                              `Color: ${highlight.color || selectedHighlightColor}\n` +
                              `---\n`
                            ).join('\n');
                          
                          const textBlob = new Blob([textContent], { type: 'text/plain' });
                          const textUrl = URL.createObjectURL(textBlob);
                          
                          const textLink = document.createElement('a');
                          textLink.href = textUrl;
                          textLink.download = `pdf-highlights-${new Date().toISOString().split('T')[0]}.txt`;
                          document.body.appendChild(textLink);
                          textLink.click();
                          document.body.removeChild(textLink);
                          
                          URL.revokeObjectURL(textUrl);
                        }, 100);
                      }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="7 10 12 15 17 10"></polyline>
                        <line x1="12" y1="15" x2="12" y2="3"></line>
                      </svg>
                    </button>
                  </div>
                )}
              </div>

              <div className="pdf-highlights-list">
                {highlights.length === 0 ? (
                  <div className="pdf-no-highlights">
                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m9 11 3 3L22 4"></path>
                      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                    </svg>
                    <p>No highlights yet</p>
                    <small>Select text in the PDF to create highlights</small>
                  </div>
                ) : (
                  highlights
                    .filter(highlight => 
                      !searchTerm || 
                      highlight.comment.text.toLowerCase().includes(searchTerm.toLowerCase())
                    )
                    .map((highlight, index) => (
                      <div key={highlight.id} className="pdf-highlight-item">
                        <div className="pdf-highlight-header">
                          <div 
                            className="pdf-highlight-color-indicator"
                            style={{ backgroundColor: highlight.color || selectedHighlightColor }}
                          />
                          <span className="pdf-highlight-index">#{index + 1}</span>
                          <div className="pdf-highlight-actions">
                            <button
                              className="pdf-highlight-edit"
                              title="Edit highlight"
                              onClick={() => {
                                const newText = window.prompt('Edit highlight:', highlight.comment.text);
                                if (newText !== null) {
                                  setHighlights(prev => 
                                    prev.map(h => 
                                      h.id === highlight.id 
                                        ? { ...h, comment: { ...h.comment, text: newText } }
                                        : h
                                    )
                                  );
                                }
                              }}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                              </svg>
                            </button>
                            <button
                              className="pdf-highlight-delete"
                              title="Delete highlight"
                              onClick={() => setHighlights(prev => prev.filter(h => h.id !== highlight.id))}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="m19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                              </svg>
                            </button>
                          </div>
                        </div>
                        
                        <div className="pdf-highlight-content">
                          <div className="pdf-highlight-text">
                            {highlight.comment.text}
                          </div>
                          {highlight.content?.text && (
                            <div className="pdf-highlighted-passage">
                              "{highlight.content.text.substring(0, 100)}{highlight.content.text.length > 100 ? '...' : ''}"
                            </div>
                          )}
                        </div>
                        
                        <div className="pdf-highlight-footer">
                          <button
                            className="pdf-jump-to-highlight"
                            onClick={() => {
                              // Jump to the highlight in the PDF viewer
                              if (highlight.position && highlight.position.boundingRect) {
                                const documentArea = document.querySelector('.pdf-document-area');
                                if (documentArea) {
                                  // Calculate the page number from the highlight position
                                  const pageNumber = highlight.position.pageNumber || 1;
                                  
                                  // First navigate to the correct page
                                  setCurrentPage(pageNumber);
                                  
                                  // Use a small delay to allow page navigation to complete
                                  setTimeout(() => {
                                    // Try to find the specific highlight element
                                    const highlightElements = documentArea.querySelectorAll('[data-highlight-id], .Highlight');
                                    let targetElement: Element | null = null;
                                    
                                    // Look for the specific highlight by comparing positions or content
                                    for (const el of highlightElements) {
                                      // Check if this element corresponds to our highlight
                                      const elementRect = el.getBoundingClientRect();
                                      const containerRect = documentArea.getBoundingClientRect();
                                      
                                      // Calculate relative position within the container, accounting for zoom
                                      const relativeTop = elementRect.top - containerRect.top + documentArea.scrollTop;
                                      
                                      // If we can match this element to our highlight, use it
                                      const boundingRect = highlight.position.boundingRect;
                                      // Account for zoom when comparing positions
                                      const zoomAdjustedThreshold = 100 * zoomLevel;
                                      if (boundingRect && 'top' in boundingRect && typeof boundingRect.top === 'number' && Math.abs(relativeTop - boundingRect.top * zoomLevel) < zoomAdjustedThreshold) {
                                        targetElement = el;
                                        break;
                                      }
                                    }
                                    
                                    if (targetElement) {
                                      targetElement.scrollIntoView({ 
                                        behavior: 'smooth', 
                                        block: 'center' 
                                      });
                                      
                                      // Add a temporary highlight effect
                                      targetElement.classList.add('highlight-flash');
                                      setTimeout(() => {
                                        targetElement?.classList.remove('highlight-flash');
                                      }, 2000);
                                    } else {
                                      // Fallback: navigate to the page and scroll to approximate position
                                      goToPage(pageNumber);
                                    }
                                  }, 300);
                                }
                              }
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M9 18l6-6-6-6"></path>
                            </svg>
                            Jump to highlight
                          </button>
                        </div>
                      </div>
                    ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PDFViewer;
