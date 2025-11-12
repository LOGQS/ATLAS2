import React, { useState, useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { WebProvider, useWebContext } from '../contexts/WebContext';
import { WorkspaceLoadingOverlay } from '../components/coder/WorkspaceLoadingOverlay';
import { ResearcherView } from '../components/web/ResearcherView';
import { ControllerView } from '../components/web/ControllerView';
import { ProfileSetupView } from '../components/web/ProfileSetupView';
import { WebActivityPanel } from '../components/web/WebActivityPanel';
import { BrowserSettingsOverlay } from '../components/web/BrowserSettingsOverlay';
import { Slider, type SliderOptions } from '../components/ui/Slider';
import { Icons } from '../components/ui/Icons';
import '../styles/sections/WebWindow.css';
import logger from '../utils/core/logger';

type WebMode = 'researcher' | 'controller';

const modeSliderOptions: SliderOptions<WebMode> = {
  left: {
    value: 'researcher',
    text: 'Research',
  },
  right: {
    value: 'controller',
    text: 'Control',
  },
};

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
    sessionStatus,
    viewerReady,
    showProfileSetup,
    showBrowserSettings,
    checkProfileStatus,
    setProfileStatus,
    setShowProfileSetup,
    setShowBrowserSettings,
    setMode,
    initializeSession
  } = useWebContext();
  const [isReady, setIsReady] = useState(false);
  const [showLoading, setShowLoading] = useState(false);

  // Check profile status IMMEDIATELY on mount via API (event-driven, instant)
  useEffect(() => {
    logger.info('[PROFILE_CHECK] ============ CHECKING PROFILE STATUS ============');

    // ALWAYS check via API immediately - don't wait for SSE
    // This is instant and event-driven
    checkProfileStatus();

  }, [checkProfileStatus]);

  // ALSO listen for SSE updates from backend (when profile is set up)
  useEffect(() => {
    if (!profileStatusFromSSE) return;

    logger.info('[PROFILE_CHECK] SSE profile update received:', profileStatusFromSSE);

    if (profileStatusFromSSE.exists) {
      logger.info('[PROFILE_CHECK] Profile exists via SSE, setting status to ready');
      setProfileStatus('ready');
    } else {
      logger.info('[PROFILE_CHECK] Profile MISSING via SSE');
      setProfileStatus('missing');
    }
  }, [profileStatusFromSSE, setProfileStatus]);

  // Show setup view if profile is missing
  useEffect(() => {
    logger.info('[PROFILE_CHECK] Setup view effect - profileStatus:', profileStatus, 'showProfileSetup:', showProfileSetup);
    if (profileStatus === 'missing' && !showProfileSetup) {
      logger.info('[PROFILE_CHECK] Profile is missing, setting showProfileSetup to TRUE');
      setShowProfileSetup(true);
    }
  }, [profileStatus, showProfileSetup, setShowProfileSetup]);

  useEffect(() => {
    logger.info('[PROFILE_CHECK] Session auto-start effect - profileStatus:', profileStatus, 'sessionStatus:', sessionStatus);
    if (profileStatus === 'ready' && sessionStatus === 'idle') {
      logger.info('[WEB_WINDOW] Auto-starting shared browser session');
      void initializeSession();
    }
  }, [profileStatus, sessionStatus, initializeSession]);

  // Initialization ready state with loading delay
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

  const MAX_DISPLAY_LENGTH = 200;
  let displayText = userRequest || (mode === 'researcher' ? searchQuery : currentUrl) || 'No active request';

  if (displayText && displayText.length > MAX_DISPLAY_LENGTH) {
    displayText = `${displayText.substring(0, MAX_DISPLAY_LENGTH)}...`;
  }

  logger.info('[PROFILE_CHECK] Render decision - showProfileSetup:', showProfileSetup, 'isReady:', isReady, 'showLoading:', showLoading, 'profileStatus:', profileStatus);

  // CRITICAL: Check profile setup FIRST - this takes priority over initialization
  // If profile setup is needed, show setup view immediately (don't wait for isReady)
  if (showProfileSetup) {
    logger.info('[PROFILE_CHECK] 🎯 RENDERING ProfileSetupView');
    return (
      <div className={`web-window ${fullscreen ? 'web-window--fullscreen' : ''}`}>
        <ProfileSetupView />
        {showBrowserSettings && <BrowserSettingsOverlay />}
      </div>
    );
  }

  // Show loading overlay if not ready and past the threshold
  if (!isReady && showLoading) {
    logger.info('[PROFILE_CHECK] 🔄 RENDERING LoadingOverlay');
    return (
      <div className={`web-window ${fullscreen ? 'web-window--fullscreen' : ''}`}>
        <WorkspaceLoadingOverlay
          isVisible={true}
          theme="web"
          text="Initializing web workspace..."
        />
      </div>
    );
  }

  // Hide completely if not ready and under threshold (prevents flash)
  if (!isReady) {
    logger.info('[PROFILE_CHECK] ⏳ RENDERING null (not ready yet)');
    return null;
  }

  logger.info('[PROFILE_CHECK] ✅ RENDERING main workspace');

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
          <Slider
            selected={mode}
            options={modeSliderOptions}
            setSelected={setMode}
          />
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

      {/* Main Content Area with Resizable Panels */}
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

      {/* Session Loading Overlay */}
      {sessionStatus !== 'ready' && (
        <WorkspaceLoadingOverlay
          isVisible={true}
          theme="web"
          text={
            sessionStatus === 'initializing'
              ? 'Launching secure browser session...'
              : 'Connecting to browser session...'
          }
        />
      )}
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
