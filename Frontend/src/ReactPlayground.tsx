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
    "tailwindcss": "^3.4.0",
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
import './styles.css';

// Ensure Tailwind CSS is loaded - inject script if not already present
if (!document.querySelector('script[src*="tailwindcss.com"]')) {
  const script = document.createElement('script');
  script.src = 'https://cdn.tailwindcss.com';
  script.onload = () => {
    // Configure Tailwind after it loads
    if ((window as any).tailwind) {
      (window as any).tailwind.config = {
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

// Dynamic import with error handling for both default and named exports
const mountComponent = async () => {
  try {
    const rootElement = document.getElementById('root');
    const root = createRoot(rootElement);
    
    console.log('Loading component from App.tsx...');
    
    // Dynamic import to handle both default and named exports
    const appModule = await import('./App');
    
    // Try to get the component - check for default export first, then named exports
    let AppComponent;
    if (appModule.default) {
      AppComponent = appModule.default;
      console.log('Using default export from App.tsx');
    } else if (appModule.App) {
      AppComponent = appModule.App;
      console.log('Using named export "App" from App.tsx');
    } else {
      // Get the first exported component if no default or App export
      const exportKeys = Object.keys(appModule).filter(key => key !== 'default');
      if (exportKeys.length > 0) {
        AppComponent = appModule[exportKeys[0]];
        console.log('Using first named export "' + exportKeys[0] + '" from App.tsx');
      } else {
        throw new Error('No valid React component found in App.tsx - no default export or named exports detected');
      }
    }
    
    // Validate that we have a valid React component
    if (typeof AppComponent !== 'function' && typeof AppComponent !== 'object') {
      throw new Error('Exported component is not a valid React component: ' + typeof AppComponent);
    }
    
    console.log('Rendering component...');
    root.render(React.createElement(AppComponent));
    console.log('Component rendered successfully');
    
  } catch (error) {
    console.error('Failed to load or render component:', error);
    
    // Display error in the UI
    const rootElement = document.getElementById('root');
    const root = createRoot(rootElement);
    const errorDiv = React.createElement('div', {
      style: {
        padding: '20px',
        margin: '20px',
        backgroundColor: '#fee2e2',
        border: '1px solid #fca5a5',
        borderRadius: '8px',
        color: '#dc2626',
        fontFamily: 'monospace'
      }
    }, [
      React.createElement('h3', { key: 'title' }, 'Component Error'),
      React.createElement('p', { key: 'message' }, 'Failed to render React component: ' + (error instanceof Error ? error.message : String(error))),
      React.createElement('p', { key: 'help' }, 'Make sure your component has a default export or is exported as a named export.')
    ]);
    
    root.render(errorDiv);
  }
};

// Start the mounting process
mountComponent();
`,
            hidden: true
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
          dependencies
        }}
      />
    </div>
  );
};

export default ReactPlayground; 