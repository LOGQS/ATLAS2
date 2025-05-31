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
    if (creation.type === 'mermaid' && mermaidRef.current) {
      // Set a unique id for the mermaid div to avoid rendering conflicts
      const id = `mermaid-diagram-${Date.now()}`;
      mermaidRef.current.id = id;
      
      // Add the content to the div
      mermaidRef.current.textContent = creation.content;
      
      // Check if mermaid is loaded
      if (mermaid) {
        try {
          // Small delay to ensure the DOM is ready
          setTimeout(() => {
            mermaid.init(undefined, mermaidRef.current);
          }, 100);
        } catch (e) {
          console.error('Error rendering mermaid diagram:', e);
          // Fallback in case of error - show the code
          mermaidRef.current.className = 'mermaid-error';
          mermaidRef.current.innerHTML = `
            <div class="error-message">Error rendering diagram</div>
            <pre><code>${creation.content}</code></pre>
          `;
        }
      } else {
        // If mermaid isn't loaded yet, retry when it becomes available
        const checkInterval = setInterval(() => {
          if (mermaid && mermaidRef.current) {
            clearInterval(checkInterval);
            try {
              mermaid.init(undefined, mermaidRef.current);
            } catch (e) {
              console.error('Error in delayed mermaid rendering:', e);
              // Fallback
              if (mermaidRef.current) {
                mermaidRef.current.className = 'mermaid-error';
                mermaidRef.current.innerHTML = `
                  <div class="error-message">Error rendering diagram</div>
                  <pre><code>${creation.content}</code></pre>
                `;
              }
            }
          }
        }, 300);
        
        // Clear interval if component unmounts
        return () => clearInterval(checkInterval);
      }
    }
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
        );
      }
      
      case 'markdown': {
        return (
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
          <div className="html-content">
            <div className="html-preview-frame">
              <iframe
                srcDoc={htmlWithTailwind}
                title="HTML Preview"
                sandbox="allow-scripts"
                className="html-preview-iframe"
              />
            </div>
          </div>
        );
      }
      
      case 'svg': {
        return (
          <div 
            className="svg-container"
            dangerouslySetInnerHTML={{ __html: creation.content }}
          />
        );
      }
      
      case 'mermaid': {
        return (
          <div className="mermaid-container">
            <div ref={mermaidRef} className="mermaid">
              {/* Content is set in useEffect */}
            </div>
          </div>
        );
      }
      
      case 'react': {
        // Use Sandpack for rendering React components
        // Hide view toggle buttons if we're in react-preview mode
        const showViewToggle = viewMode !== 'react-preview';

        return (
          <div className={`react-component-container sandpack-${sandpackView}-view`} ref={sandpackRef}>
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
        );
      }
      
      default: {
        return null;
      }
    }
  };

  return (
    <div className={`creation-content-container ${creation.type}-viewer ${viewMode} ${viewMode === 'react-preview' ? 'react-preview' : ''}`}>
      {renderToolbar()}
      <div className="creation-content-main">
        {renderContent()}
      </div>
    </div>
  );
};

export default CreationContent;