import React, { useEffect, useState, useRef } from 'react';
import { useWebContext } from '../../contexts/WebContext';
import { BrowserViewport } from './BrowserViewport';
import { Icons } from '../ui/Icons';
import logger from '../../utils/core/logger';

export const ControllerView: React.FC = () => {
  const {
    sessionId,
    viewerUrl,
    viewport,
    sessionStatus,
    profileStatus,
    initializeSession,
    currentUrl,
    sendBrowserCommand,
    canGoBack,
    canGoForward,
    isPageLoading,
  } = useWebContext();

  const [urlInput, setUrlInput] = useState('');
  const [isNavigating, setIsNavigating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // CRITICAL: Only initialize session if profile is ready
    // Don't interfere with profile setup process
    if (!sessionId && profileStatus === 'ready') {
      void initializeSession();
    }
  }, [sessionId, profileStatus, initializeSession]);

  const handleNavigate = async () => {
    const url = urlInput.trim();
    if (!url || !sessionId) return;

    setIsNavigating(true);
    logger.info('[CONTROLLER_VIEW] Navigating to:', url);

    try {
      // Add protocol if missing
      const fullUrl = url.match(/^https?:\/\//i) ? url : `https://${url}`;
      await sendBrowserCommand({
        type: 'navigate',
        url: fullUrl,
      });
      setUrlInput('');
    } catch (error) {
      logger.error('[CONTROLLER_VIEW] Navigation failed:', error);
    } finally {
      setIsNavigating(false);
    }
  };

  const handleRefresh = async () => {
    if (!sessionId) return;

    setIsNavigating(true);
    logger.info('[CONTROLLER_VIEW] Refreshing page');

    try {
      await sendBrowserCommand({
        type: 'reload',
      });
    } catch (error) {
      logger.error('[CONTROLLER_VIEW] Refresh failed:', error);
    } finally {
      setIsNavigating(false);
    }
  };

  const handleBack = async () => {
    if (!sessionId || !canGoBack) return;

    setIsNavigating(true);
    logger.info('[CONTROLLER_VIEW] Going back');

    try {
      await sendBrowserCommand({
        type: 'back',
      });
    } catch (error) {
      logger.error('[CONTROLLER_VIEW] Back navigation failed:', error);
    } finally {
      setIsNavigating(false);
    }
  };

  const handleForward = async () => {
    if (!sessionId || !canGoForward) return;

    setIsNavigating(true);
    logger.info('[CONTROLLER_VIEW] Going forward');

    try {
      await sendBrowserCommand({
        type: 'forward',
      });
    } catch (error) {
      logger.error('[CONTROLLER_VIEW] Forward navigation failed:', error);
    } finally {
      setIsNavigating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleNavigate();
    }
  };

  const isReady = sessionStatus === 'ready' && sessionId;

  return (
    <main className="web-controller-view">
      {/* Browser Navigation Controls */}
      <div className="web-controller-view__controls">
        <div className="flex items-center gap-2">
          <button
            className="web-controller-view__nav-btn"
            onClick={handleBack}
            disabled={!isReady || !canGoBack || isNavigating}
            title="Go back"
          >
            <Icons.ChevronLeft className="w-4 h-4" />
          </button>
          <button
            className="web-controller-view__nav-btn"
            onClick={handleForward}
            disabled={!isReady || !canGoForward || isNavigating}
            title="Go forward"
          >
            <Icons.ChevronRight className="w-4 h-4" />
          </button>
          <button
            className="web-controller-view__nav-btn"
            onClick={handleRefresh}
            disabled={!isReady || isNavigating}
            title="Refresh"
          >
            <Icons.RotateCw className={`w-4 h-4 ${isNavigating ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="web-controller-view__url-bar">
          <input
            ref={inputRef}
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={currentUrl || 'Enter URL and press Enter...'}
            className="w-full bg-transparent text-sm text-gray-300 outline-none placeholder:text-gray-500"
            disabled={!isReady || isNavigating}
          />
        </div>

        <button
          onClick={handleNavigate}
          disabled={!urlInput.trim() || !isReady || isNavigating}
          className="web-controller-view__go-btn"
          title="Navigate"
        >
          {isNavigating ? (
            <Icons.RotateCw className="w-4 h-4 animate-spin" />
          ) : (
            <Icons.ChevronRight className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Interactive Browser Viewport */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <BrowserViewport
          sessionId={sessionId}
          viewerUrl={viewerUrl}
          viewport={viewport}
          sessionStatus={sessionStatus}
        />
        {isPageLoading && (
          <div className="web-controller-view__loading-overlay">
            <div className="web-controller-view__loading-spinner">
              <div className="spinner-ring"></div>
            </div>
            <span className="web-controller-view__loading-text">Loading...</span>
          </div>
        )}
      </div>
    </main>
  );
};
