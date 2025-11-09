import React, { useState, useEffect } from 'react';
import { WebProvider, useWebContext } from '../contexts/WebContext';
import { WorkspaceLoadingOverlay } from '../components/coder/WorkspaceLoadingOverlay';
import { ResearcherView } from '../components/web/ResearcherView';
import { ControllerView } from '../components/web/ControllerView';
import { WebActivityPanel } from '../components/web/WebActivityPanel';
import { Icons } from '../components/ui/Icons';
import '../styles/sections/WebWindow.css';
import logger from '../utils/core/logger';

interface WebWindowProps {
  isOpen?: boolean;
  chatId?: string;
  fullscreen?: boolean;
  onBackToChat?: () => void;
}

const WebWindowContent: React.FC<{ fullscreen?: boolean; onBackToChat?: () => void }> = ({
  fullscreen = false,
  onBackToChat
}) => {
  const { mode, searchQuery, currentUrl, setSearchQuery, setCurrentUrl } = useWebContext();
  const [isReady, setIsReady] = useState(false);
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    // Show loading only if initialization takes longer than 200ms
    const loadingTimer = setTimeout(() => {
      if (!isReady) {
        setShowLoading(true);
      }
    }, 200);

    // Mark as ready immediately on mount
    const readyTimer = setTimeout(() => {
      setIsReady(true);
      setShowLoading(false);
      logger.info('[WEB_WINDOW] Initialization complete');
    }, 0);

    return () => {
      clearTimeout(loadingTimer);
      clearTimeout(readyTimer);
    };
  }, [isReady]);

  const omnibarValue = mode === 'researcher' ? searchQuery : currentUrl;
  const omnibarPlaceholder = mode === 'researcher'
    ? 'Enter search query or URL...'
    : 'Enter URL, search query, or command...';

  const handleOmnibarChange = (value: string) => {
    if (mode === 'researcher') {
      setSearchQuery(value);
    } else {
      setCurrentUrl(value);
    }
  };

  // Show loading overlay if not ready and past the threshold
  if (!isReady && showLoading) {
    return (
      <div className={`web-window ${fullscreen ? 'web-window--fullscreen' : ''}`}>
        <WorkspaceLoadingOverlay
          isVisible={true}
          theme="web"
          text="Initializing web agent..."
        />
      </div>
    );
  }

  // Hide completely if not ready and under threshold (prevents flash)
  if (!isReady) {
    return null;
  }

  return (
    <div className={`web-window ${fullscreen ? 'web-window--fullscreen' : ''}`}>
      {/* Header */}
      <header className="web-window__header">
        <div className="flex gap-3 items-center">
          {onBackToChat && (
            <button onClick={onBackToChat} className="web-window__back-btn">
              <Icons.ChevronLeft className="w-5 h-5" />
            </button>
          )}
          <div className="web-window__logo">
            <div className="web-window__logo-icon">
              <Icons.Globe className="w-6 h-6 text-cyan-400" />
            </div>
            <div className="hidden sm:block">
              <h1 className="text-white text-base font-medium">ATLAS2</h1>
              <p className="text-cyan-400/70 text-sm">Web Research</p>
            </div>
          </div>
        </div>

        {/* Omnibar */}
        <div className="web-window__omnibar-container">
          <div className="web-window__omnibar">
            <div className="web-window__omnibar-icon">
              <Icons.Sparkles className="w-5 h-5" />
            </div>
            <input
              type="text"
              className="web-window__omnibar-input"
              placeholder={omnibarPlaceholder}
              value={omnibarValue}
              onChange={(e) => handleOmnibarChange(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-green-400 animate-pulse"></div>
            <p className="text-green-400 text-sm font-medium hidden md:block">Active</p>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="web-window__content">
        <div className="web-window__main">
          {mode === 'researcher' ? <ResearcherView /> : <ControllerView />}
        </div>

        {/* Activity Panel */}
        <WebActivityPanel />
      </div>
    </div>
  );
};

const WebWindow: React.FC<WebWindowProps> = ({
  isOpen = true,
  chatId,
  fullscreen = true,
  onBackToChat
}) => {
  if (!isOpen) return null;

  return (
    <WebProvider chatId={chatId}>
      <WebWindowContent fullscreen={fullscreen} onBackToChat={onBackToChat} />
    </WebProvider>
  );
};

export default WebWindow;
