import React, { useState, useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { WebProvider, useWebContext } from '../contexts/WebContext';
import { WorkspaceLoadingOverlay } from '../components/coder/WorkspaceLoadingOverlay';
import { ResearcherView } from '../components/web/ResearcherView';
import { ControllerView } from '../components/web/ControllerView';
import { WebActivityPanel } from '../components/web/WebActivityPanel';
import { ProfileSetupView } from '../components/web/ProfileSetupView';
import { BrowserSettingsOverlay } from '../components/web/BrowserSettingsOverlay';
import { Icons } from '../components/ui/Icons';
import '../styles/sections/WebWindow.css';
import logger from '../utils/core/logger';

interface WebWindowProps {
  isOpen?: boolean;
  chatId?: string;
  fullscreen?: boolean;
  onBackToChat?: () => void;
  profileStatus?: any;
  userRequest?: string;
}

const WebWindowContent: React.FC<{
  fullscreen?: boolean;
  onBackToChat?: () => void;
  profileStatusFromSSE?: any;
  userRequest?: string;
}> = ({
  fullscreen = false,
  onBackToChat,
  profileStatusFromSSE,
  userRequest
}) => {
  const {
    mode,
    searchQuery,
    currentUrl,
    profileStatus,
    showProfileSetup,
    showBrowserSettings,
    checkProfileStatus,
    setProfileStatus,
    setShowProfileSetup,
    setShowBrowserSettings
  } = useWebContext();
  const [isReady, setIsReady] = useState(false);
  const [showLoading, setShowLoading] = useState(false);

  // Check profile status on mount
  useEffect(() => {
    const initProfile = async () => {
      // If profile status was provided via SSE, use it
      if (profileStatusFromSSE) {
        logger.info('[WEB_WINDOW] Profile status from SSE:', profileStatusFromSSE);

        if (profileStatusFromSSE.exists) {
          setProfileStatus('ready');
        } else {
          setProfileStatus('missing');
          setShowProfileSetup(true);
        }
      } else {
        // Otherwise, check via API
        logger.info('[WEB_WINDOW] Checking profile status via API');
        await checkProfileStatus();
      }
    };

    initProfile();
  }, [profileStatusFromSSE, checkProfileStatus, setProfileStatus, setShowProfileSetup]);

  // Show setup view if profile is missing
  useEffect(() => {
    if (profileStatus === 'missing' && !showProfileSetup) {
      setShowProfileSetup(true);
    }
  }, [profileStatus, showProfileSetup, setShowProfileSetup]);

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

  // Truncate user request if it's too long (max 200 characters for display)
  const MAX_DISPLAY_LENGTH = 200;
  let displayText = userRequest || (mode === 'researcher' ? searchQuery : currentUrl) || 'No active request';

  if (displayText && displayText.length > MAX_DISPLAY_LENGTH) {
    displayText = displayText.substring(0, MAX_DISPLAY_LENGTH) + '...';
  }

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

  // If profile setup is needed, show setup view
  if (showProfileSetup) {
    return (
      <div className={`web-window ${fullscreen ? 'web-window--fullscreen' : ''}`}>
        <ProfileSetupView />
        {showBrowserSettings && <BrowserSettingsOverlay />}
      </div>
    );
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

        {/* Display Bar - Shows user's original request */}
        <div className="web-window__omnibar-container">
          <div className="web-window__omnibar">
            <div className="web-window__omnibar-icon">
              <Icons.Sparkles className="w-5 h-5" />
            </div>
            <div className="web-window__omnibar-display">
              {displayText}
            </div>
          </div>
        </div>

        <button
          onClick={() => setShowBrowserSettings(true)}
          className="web-window__settings-btn"
          title="Browser Settings"
        >
          <Icons.Settings className="w-5 h-5" />
        </button>
      </header>

      {/* Main Content Area */}
      <div className="web-window__content">
        <PanelGroup direction="horizontal">
          {/* Main Content Panel */}
          <Panel
            id="web-main-content"
            order={1}
            defaultSize={70}
            minSize={40}
          >
            <div className="web-window__main">
              {mode === 'researcher' ? <ResearcherView /> : <ControllerView />}
            </div>
          </Panel>

          {/* Resize Handle */}
          <PanelResizeHandle className="web-window__resize-handle" />

          {/* Activity Panel */}
          <Panel
            id="web-activity-panel"
            order={2}
            defaultSize={30}
            minSize={20}
            maxSize={50}
          >
            <WebActivityPanel />
          </Panel>
        </PanelGroup>
      </div>

      {/* Browser Settings Overlay */}
      {showBrowserSettings && <BrowserSettingsOverlay />}
    </div>
  );
};

const WebWindow: React.FC<WebWindowProps> = ({
  isOpen = true,
  chatId,
  fullscreen = true,
  onBackToChat,
  profileStatus,
  userRequest
}) => {
  if (!isOpen) return null;

  return (
    <WebProvider chatId={chatId}>
      <WebWindowContent
        fullscreen={fullscreen}
        onBackToChat={onBackToChat}
        profileStatusFromSSE={profileStatus}
        userRequest={userRequest}
      />
    </WebProvider>
  );
};

export default WebWindow;
