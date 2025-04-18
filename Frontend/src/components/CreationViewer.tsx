import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import { Creation, ShowCreationEvent } from '../utils/creationsHelper';
import { showHtmlPreview } from '../utils/htmlPreview';

// Try to load Mermaid if available
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mermaid: any = null;
try {
  // Dynamic import for Mermaid - we don't need type declarations
  // since we're handling it dynamically
  import('mermaid').then(m => {
    mermaid = m.default;
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      securityLevel: 'strict',
      logLevel: 'error',
    });
  }).catch(e => {
    console.warn('Mermaid could not be loaded:', e);
  });
} catch (e) {
  console.warn('Mermaid import error:', e);
}

const CreationViewer: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [currentCreation, setCurrentCreation] = useState<Creation | null>(null);
  const [renderedContent, setRenderedContent] = useState<string | React.ReactNode>('');
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const mermaidRef = useRef<HTMLDivElement>(null);

  // Animation state
  const [animationState, setAnimationState] = useState<'entering' | 'visible' | 'exiting'>('entering');

  useEffect(() => {
    // Listen for the custom event to show a creation
    const handleShowCreation = (event: ShowCreationEvent) => {
      const creation = event.detail;
      setCurrentCreation(creation);
      setVisible(true);
      setAnimationState('entering');
      
      // Start entry animation
      setTimeout(() => {
        setAnimationState('visible');
      }, 10);
    };

    window.addEventListener('show-creation', handleShowCreation);
    return () => {
      window.removeEventListener('show-creation', handleShowCreation);
    };
  }, []);

  // Handle rendering of Mermaid content when it becomes visible
  useEffect(() => {
    if (visible && currentCreation?.type === 'mermaid' && mermaidRef.current && mermaid) {
      try {
        mermaid.contentLoaded();
      } catch (e) {
        console.error('Error rendering mermaid diagram:', e);
      }
    }
  }, [visible, currentCreation]);

  // Handle special rendering for different creation types
  useEffect(() => {
    if (!currentCreation) return;

    switch (currentCreation.type) {
      case 'code': {
        setRenderedContent(
          <SyntaxHighlighter
            // Type mismatch is a known issue with this library
            style={vscDarkPlus}
            language={currentCreation.language || 'javascript'}
            showLineNumbers
          >
            {currentCreation.content}
          </SyntaxHighlighter>
        );
        break;
      }
        
      case 'markdown': {
        setRenderedContent(
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '');
                const language = match ? match[1] : '';
                const codeContent = String(children).replace(/\n$/, '');
                
                return match ? (
                  <div className="code-block-container">
                    <SyntaxHighlighter
                      // Type mismatch is a known issue with this library
                      // @ts-expect-error - Style type mismatch in SyntaxHighlighter
                      style={vscDarkPlus}
                      language={language}
                      {...props}
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
            {currentCreation.content}
          </ReactMarkdown>
        );
        break;
      }
        
      case 'html': {
        // For HTML, use a different approach
        // We'll render a preview in the CreationViewer first
        // and provide a button to open in the HTML preview
        setRenderedContent(
          <div className="html-preview-container">
            <div className="html-preview-info">
              <p>HTML content preview. Click "Open in Viewer" for an interactive view.</p>
              <button 
                className="html-preview-button"
                onClick={() => {
                  // Close this viewer first
                  handleClose();
                  
                  // Add a small delay before showing the HTML preview to ensure smooth transition
                  setTimeout(() => {
                    // Then open the HTML viewer
                    showHtmlPreview(currentCreation.content);
                  }, 100);
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
                Open in Viewer
              </button>
            </div>
            <div className="html-preview-frame">
              <iframe 
                srcDoc={currentCreation.content}
                title="HTML Preview"
                sandbox="allow-scripts"
                className="html-preview-iframe"
              />
            </div>
          </div>
        );
        break;
      }
        
      case 'svg': {
        // For SVG content, render it directly
        setRenderedContent(
          <div 
            className="svg-container"
            dangerouslySetInnerHTML={{ __html: currentCreation.content }}
          />
        );
        break;
      }
        
      case 'mermaid': {
        // For Mermaid diagrams
        setRenderedContent(
          <div className="mermaid-container">
            <div ref={mermaidRef} className="mermaid">
              {currentCreation.content}
            </div>
          </div>
        );
        break;
      }
        
      case 'react': {
        // For React components, use iframe sandbox approach
        try {
          setRenderedContent(
            <div className="react-component-container">
              <div className="react-component-header">
                <h4>React Component Preview</h4>
                <div className="react-component-warning-note">
                  Note: This is a static preview rendering.
                </div>
              </div>
              <div className="react-component-sandbox">
                <iframe
                  srcDoc={`
                    <!DOCTYPE html>
                    <html>
                      <head>
                        <meta charset="UTF-8" />
                        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                        <title>React Component Preview</title>
                        <!-- Load scripts in specific order -->
                        <script src="https://unpkg.com/react@17/umd/react.production.min.js" crossorigin></script>
                        <script src="https://unpkg.com/react-dom@17/umd/react-dom.production.min.js" crossorigin></script>
                        <script src="https://unpkg.com/styled-components@5.3.5/dist/styled-components.min.js" crossorigin></script>
                        <script src="https://unpkg.com/babel-standalone@6.26.0/babel.min.js" crossorigin></script>
                        <style>
                          body { 
                            margin: 0; 
                            padding: 0;
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                            background: white;
                            overflow: auto;
                          }
                          #root {
                            display: flex;
                            justify-content: center;
                            width: 100%;
                            height: 100%;
                            min-height: 400px;
                            padding: 20px;
                            box-sizing: border-box;
                            background-color: #fff;
                          }
                          .error-container {
                            color: #e53935;
                            padding: 20px;
                            border: 1px solid #ffcdd2;
                            border-radius: 4px;
                            background-color: #ffebee;
                            margin: 20px;
                            width: 100%;
                          }
                          .loading {
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            width: 100%;
                            height: 100%;
                            min-height: 400px;
                            font-family: sans-serif;
                            color: #555;
                          }
                          /* Debug info */
                          .debug-info {
                            position: fixed;
                            bottom: 0;
                            left: 0;
                            right: 0;
                            background: #f8f9fa;
                            border-top: 1px solid #ddd;
                            padding: 8px;
                            font-size: 12px;
                            color: #666;
                            z-index: 1000;
                            max-height: 100px;
                            overflow-y: auto;
                          }
                        </style>
                      </head>
                      <body>
                        <!-- Initial loading state -->
                        <div id="root">
                          <div class="loading">Loading React component...</div>
                        </div>
                        
                        <!-- Debug info container -->
                        <div id="debug-info" class="debug-info" style="display: none;"></div>
                        
                        <script>
                          // Debug logging helper
                          function debugLog(msg) {
                            const debug = document.getElementById('debug-info');
                            if (debug) {
                              const time = new Date().toLocaleTimeString();
                              debug.innerHTML += \`[\${time}] \${msg}<br>\`;
                              debug.style.display = 'block';
                            }
                            console.log(msg);
                          }
                          
                          // Show error in UI
                          function showError(errorMsg) {
                            document.getElementById('root').innerHTML = \`
                              <div class="error-container">
                                <h3>Error Rendering Component</h3>
                                <p>\${errorMsg}</p>
                              </div>
                            \`;
                            debugLog("Error: " + errorMsg);
                          }
                          
                          // Log loading state
                          debugLog("Scripts loaded, waiting for Babel.");
                        </script>
                        
                        <script type="text/babel">
                          // Wait a moment to ensure Babel is ready
                          setTimeout(() => {
                            try {
                              debugLog("Babel ready, processing component code");
                              
                              ${currentCreation.content}
                              
                              // Ensure the component is defined
                              if (typeof TwoDDecoderTransformer !== 'function') {
                                throw new Error("Component TwoDDecoderTransformer is not defined or not a function");
                              }
                              
                              debugLog("Component defined, attempting to render");
                              
                              // Render the component
                              ReactDOM.render(
                                React.createElement(TwoDDecoderTransformer),
                                document.getElementById('root'),
                                () => debugLog("ReactDOM.render callback called")
                              );
                            } catch (error) {
                              showError(error.toString());
                            }
                          }, 500); // Give a small delay for everything to initialize
                        </script>
                      </body>
                    </html>
                  `}
                  title="React Component Preview"
                  sandbox="allow-scripts allow-popups"
                  className="react-component-iframe"
                />
              </div>
            </div>
          );
        } catch (error) {
          console.error('Error rendering React component:', error);
          setRenderedContent(
            <div className="react-component-error">
              <h4>Error Rendering Component</h4>
              <p>{String(error)}</p>
              <pre>{currentCreation.content}</pre>
            </div>
          );
        }
        break;
      }
        
      case 'placeholder': {
        // For placeholder images
        const dimensions = currentCreation.title?.split('x') || ['300', '200'];
        const width = parseInt(dimensions[0], 10) || 300;
        const height = parseInt(dimensions[1], 10) || 200;
        
        setRenderedContent(
          <div 
            className="placeholder-image"
            style={{ width: `${width}px`, height: `${height}px` }}
          >
            <div className="placeholder-text">{width} x {height}</div>
          </div>
        );
        break;
      }
        
      default: {
        setRenderedContent(<div>Unsupported creation type</div>);
      }
    }
  }, [currentCreation]);

  const handleClose = () => {
    // Start exit animation
    setAnimationState('exiting');
    
    // Wait for animation to complete before hiding
    setTimeout(() => {
      setVisible(false);
      setCurrentCreation(null);
    }, 300);
  };

  // Key event handler for escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && visible) {
        handleClose();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible]);

  // If not visible, don't render anything
  if (!visible) return null;

  return (
    <div
      className={`creation-viewer-overlay ${animationState}`}
      onClick={(e) => {
        // Only close if clicking the overlay itself, not the content
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
    >
      <div 
        ref={containerRef}
        className={`creation-viewer-container ${animationState}`}
      >
        <div className="creation-viewer-header">
          <div className="creation-viewer-title">
            <h3>
              {/* If title is missing or empty, use a default based on type */}
              {currentCreation?.title || (currentCreation ? currentCreation.type.charAt(0).toUpperCase() + currentCreation.type.slice(1) : 'Creation')}
            </h3>
            {currentCreation?.language && (
              <span className="creation-language">{currentCreation.language}</span>
            )}
          </div>
          <div className="creation-viewer-controls">
            <button
              className="creation-viewer-button"
              onClick={() => {
                if (currentCreation) {
                  navigator.clipboard.writeText(currentCreation.content);
                  // Show feedback
                  const feedbackEl = document.createElement('div');
                  feedbackEl.className = 'copy-feedback';
                  feedbackEl.textContent = 'Copied!';
                  containerRef.current?.appendChild(feedbackEl);
                  
                  // Remove feedback after animation
                  setTimeout(() => {
                    if (containerRef.current?.contains(feedbackEl)) {
                      containerRef.current.removeChild(feedbackEl);
                    }
                  }, 1500);
                }
              }}
              aria-label="Copy to clipboard"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>Copy</span>
            </button>
            <button
              className="creation-viewer-button close-button"
              onClick={handleClose}
              aria-label="Close viewer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div ref={contentRef} className="creation-viewer-content">
          {renderedContent}
        </div>
      </div>
    </div>
  );
};

export default CreationViewer; 