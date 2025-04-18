import { useEffect, useState } from 'react';
import { Sandpack } from '@codesandbox/sandpack-react';

const ReactPlayground = () => {
  const [componentCode, setComponentCode] = useState<string>('');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [externalDependencies, setExternalDependencies] = useState<Record<string, string>>({});
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    try {
      // Get the storage key from URL query parameter
      const params = new URLSearchParams(window.location.search);
      const storageKey = params.get('key');
      
      if (storageKey) {
        // Retrieve the code from session storage
        const storedCode = sessionStorage.getItem(storageKey);
        
        // Retrieve external dependencies if they exist
        const storedDependencies = sessionStorage.getItem(`${storageKey}_deps`);
        
        if (storedCode) {
          // Set component code
          setComponentCode(storedCode);
          
          // Parse and set external dependencies if available
          if (storedDependencies) {
            try {
              const dependencies = JSON.parse(storedDependencies);
              setExternalDependencies(dependencies);
            } catch (depError) {
              console.error('Error parsing dependencies:', depError);
            }
          }
          
          // Optional: Remove the item from storage after retrieving it
          // sessionStorage.removeItem(storageKey);
          // if (storedDependencies) sessionStorage.removeItem(`${storageKey}_deps`);
        } else {
          setError('Could not find component code in storage. The session might have expired or the key is invalid.');
        }
      } else {
        setError('No storage key provided in URL.');
      }
      
      // Check user preference for theme
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      setTheme(prefersDark ? 'dark' : 'light');
      
      // Set page title
      document.title = 'React Component Viewer';
    } catch (e) {
      setError(`Error initializing: ${e instanceof Error ? e.message : String(e)}`);
      console.error('Initialization error:', e);
    } finally {
      setIsLoading(false);
      
      // Use a small delay to ensure states are settled before rendering Sandpack
      setTimeout(() => {
        setIsReady(true);
      }, 100);
    }
  }, []);

  if (isLoading) {
    return (
      <div className="loading-container">
        <p>Loading component...</p>
      </div>
    );
  }

  if (error || !componentCode) {
    return (
      <div className="error-container">
        <h2>{error || 'No Component Code Provided'}</h2>
        <p>Please specify a valid React component via the 'code' query parameter.</p>
      </div>
    );
  }

  // Only render Sandpack when we're ready to prevent initialization errors
  if (!isReady) {
    return (
      <div className="loading-container">
        <p>Preparing sandbox environment...</p>
      </div>
    );
  }

  // Calculate the default dependencies once to prevent re-renders
  const dependencies = {
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "d3": "^7.8.5", 
    "recharts": "^2.5.0",
    "prop-types": "^15.8.1",
    "lodash": "^4.17.21",
    ...externalDependencies
  };

  return (
    <div className="react-playground">
      <style>{`
        body, html {
          margin: 0;
          padding: 0;
          height: 100%;
          width: 100%;
          overflow: hidden;
          background-color: ${theme === 'dark' ? '#1e1e1e' : '#ffffff'};
        }
        .react-playground {
          height: 100vh;
          width: 100vw;
        }
        .sp-wrapper {
          height: 100% !important;
          border: none !important;
        }
        .sp-layout {
          height: 100% !important;
        }
        .sp-preview-container {
          overflow: auto !important;
        }
        .sp-preview {
          height: 100% !important;
        }
        .error-container, .loading-container {
          padding: 20px;
          max-width: 600px;
          margin: 40px auto;
          background-color: ${theme === 'dark' ? '#2d2d2d' : '#f5f5f5'};
          border-radius: 8px;
          color: ${theme === 'dark' ? '#e0e0e0' : '#333'};
        }
        .error-container h2 {
          color: ${theme === 'dark' ? '#ff6b6b' : '#d32f2f'};
        }
      `}</style>
      <Sandpack
        key={`sandpack-${Date.now()}`} // Use a unique key to force re-mounting on changes
        template="react-ts"
        theme={theme}
        options={{
          showNavigator: false,
          showTabs: false,
          editorHeight: 0,
          showLineNumbers: false,
          wrapContent: true,
          showInlineErrors: true,
          showRefreshButton: false,
          showConsole: false,
          showConsoleButton: false,
          editorWidthPercentage: 0, // Hide editor completely
          classes: {
            'sp-wrapper': 'custom-wrapper',
            'sp-layout': 'custom-layout'
          }
        }}
        files={{
          "/App.tsx": componentCode,
          "/index.tsx": {
            code: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

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

try {
  root.render(<App />);
  console.log('Component rendered successfully');
} catch (error) {
  console.error('Failed to render component:', error);
  
  // Display error in the UI
  const errorDiv = document.createElement('div');
  errorDiv.style.padding = '20px';
  errorDiv.style.margin = '20px';
  errorDiv.style.backgroundColor = '#ffebee';
  errorDiv.style.border = '1px solid #ffcdd2';
  errorDiv.style.borderRadius = '4px';
  errorDiv.style.color = '#b71c1c';
  errorDiv.innerHTML = \`<h3>Error Rendering Component</h3><pre>\${error instanceof Error ? error.message : String(error)}</pre>\`;
  
  if (rootElement) {
    rootElement.innerHTML = '';
    rootElement.appendChild(errorDiv);
  }
}
`,
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
          dependencies
        }}
      />
    </div>
  );
};

export default ReactPlayground; 