import React, { useState, useRef, useEffect } from 'react';
import { ShowHtmlPreviewEvent } from '../utils/htmlPreview';

const HtmlPreview: React.FC = () => {
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewContent, setPreviewContent] = useState('');
  const previewRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // Listen for the custom event to show HTML preview
    const handleShowHtmlPreview = (event: ShowHtmlPreviewEvent) => {
      const html = event.detail.html;
      const fullHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>HTML Preview</title>
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
                color: #e2e2e2;
                background-color: #1a1a1a;
                max-width: 100%;
              }
              * { box-sizing: border-box; }
              img { max-width: 100%; height: auto; }
              pre, code { 
                background-color: #2c2c2c; 
                border-radius: 3px; 
                padding: 2px 5px;
                font-family: 'SF Mono', Monaco, Menlo, Consolas, 'Liberation Mono', Courier, monospace;
                color: #e0e0e0;
              }
              a { color: #4e73ed; text-decoration: none; }
              a:hover { text-decoration: underline; color: #6a8cff; }
              button, input, select, textarea {
                font-family: inherit;
                font-size: inherit;
                background-color: #2a2a2a;
                color: #e0e0e0;
                border: 1px solid #444;
              }
              table {
                border-collapse: collapse;
                width: 100%;
                margin: 1em 0;
              }
              table, th, td {
                border: 1px solid #444;
              }
              th, td {
                padding: 8px 12px;
                text-align: left;
              }
              th {
                background-color: #2c2c2c;
                font-weight: 600;
              }
              h1, h2, h3, h4, h5, h6 {
                margin-top: 1.5em;
                margin-bottom: 0.5em;
                line-height: 1.2;
                color: #fff;
              }
              p { margin: 0.75em 0; }
              /* Dark scrollbar */
              ::-webkit-scrollbar {
                width: 10px;
                height: 10px;
              }
              ::-webkit-scrollbar-track {
                background: #1a1a1a;
              }
              ::-webkit-scrollbar-thumb {
                background: #444;
                border-radius: 4px;
              }
              ::-webkit-scrollbar-thumb:hover {
                background: #555;
              }
            </style>
          </head>
          <body class="dark">${html}</body>
        </html>
      `;
      setPreviewContent(fullHtml);
      setPreviewVisible(true);
    };

    window.addEventListener('show-html-preview', handleShowHtmlPreview);
    return () => {
      window.removeEventListener('show-html-preview', handleShowHtmlPreview);
    };
  }, []);

  const closePreview = () => {
    setPreviewVisible(false);
  };

  if (!previewVisible) return null;

  return (
    <div className="html-preview-overlay">
      <div className="html-preview-container">
        <div className="html-preview-header">
          <div className="html-preview-title">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
            </svg>
            <h3>HTML Artifact Preview</h3>
          </div>
          <div className="preview-controls">
            <div className="preview-actions">
              <button 
                onClick={() => {
                  const win = window.open('', '_blank');
                  if (win) {
                    win.document.write(previewContent);
                    win.document.close();
                  }
                }}
                className="preview-button open-button"
                title="Open in New Tab"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
                <span>Open in New Tab</span>
              </button>
              <button 
                onClick={() => {
                  if (previewRef.current) {
                    previewRef.current.src = 'about:blank';
                    setTimeout(() => {
                      if (previewRef.current) previewRef.current.srcdoc = previewContent;
                    }, 50);
                  }
                }} 
                className="preview-button refresh-button"
                title="Refresh Preview"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                  <path d="M21 3v5h-5"></path>
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
                  <path d="M3 21v-5h5"></path>
                </svg>
                <span>Refresh</span>
              </button>
            </div>
            <button 
              onClick={closePreview} 
              className="preview-button close-preview-button"
              title="Close Preview"
              aria-label="Close Preview"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18"></path>
                <path d="m6 6 12 12"></path>
              </svg>
            </button>
          </div>
        </div>
        <div className="html-preview-frame-container">
          <iframe
            ref={previewRef}
            className="html-preview-frame"
            title="HTML Preview"
            srcDoc={previewContent}
            sandbox="allow-scripts allow-popups"
          />
        </div>
        <div className="html-preview-footer">
          <div className="html-preview-status">
            <span>HTML content rendered in sandbox mode</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HtmlPreview; 