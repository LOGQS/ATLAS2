// status: complete

import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

// Suppress benign ResizeObserver loop errors
// This error occurs when ResizeObserver callbacks take longer than one frame
// It's a known browser timing issue that doesn't affect functionality
const suppressResizeObserverError = (event: ErrorEvent) => {
  if (
    event.message === 'ResizeObserver loop completed with undelivered notifications.' ||
    event.message === 'ResizeObserver loop limit exceeded'
  ) {
    event.stopImmediatePropagation();
    event.preventDefault();
    return true;
  }
  return false;
};

window.addEventListener('error', suppressResizeObserverError);

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
// Disable StrictMode for the coding workspace to avoid double-mount side effects
// that interfere with persistent terminal attachments in development.
root.render(
  <App />
);
