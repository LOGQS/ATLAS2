import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useWebContext, SessionStatus } from '../../contexts/WebContext';
import { Icons } from '../ui/Icons';
import logger from '../../utils/core/logger';

interface BrowserViewportProps {
  sessionId?: string;
  viewerUrl?: string;
  sessionStatus: SessionStatus;
  viewport: { width: number; height: number };
}

export const BrowserViewport: React.FC<BrowserViewportProps> = ({
  sessionId,
  viewerUrl,
  sessionStatus,
  viewport,
}) => {
  const { viewerReady, initializeSession, setViewerReady, sendBrowserCommand } = useWebContext();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [isPointerDown, setIsPointerDown] = useState(false);
  const [pendingClick, setPendingClick] = useState<{ x: number; y: number } | null>(null);

  const normalizedStatus = useMemo(() => sessionStatus || 'idle', [sessionStatus]);

  const translatePointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!bounds) {
      return { x: 0, y: 0 };
    }

    const relativeX = (event.clientX - bounds.left) / bounds.width;
    const relativeY = (event.clientY - bounds.top) / bounds.height;

    return {
      x: relativeX * viewport.width,
      y: relativeY * viewport.height,
    };
  }, [viewport.height, viewport.width]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!sessionId || !viewerUrl) {
      return;
    }
    event.preventDefault();
    overlayRef.current?.focus();
    setIsPointerDown(true);
    const coords = translatePointer(event);
    logger.info('[BROWSER_VIEWPORT] Pointer down', coords);
    setPendingClick(coords);
  }, [sessionId, viewerUrl, translatePointer]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isPointerDown) {
      return;
    }
    const coords = translatePointer(event);
    setPendingClick(coords);
  }, [isPointerDown, translatePointer]);

  const handlePointerUp = useCallback(async () => {
    if (!isPointerDown || !pendingClick) {
      setIsPointerDown(false);
      setPendingClick(null);
      return;
    }

    setIsPointerDown(false);
    try {
      await sendBrowserCommand({
        type: 'click',
        x: pendingClick.x,
        y: pendingClick.y,
        button: 'left',
      });
      logger.info('[BROWSER_VIEWPORT] Click sent', pendingClick);
    } catch (error) {
      logger.error('[BrowserViewport] click command failed', error);
    } finally {
      setPendingClick(null);
    }
  }, [isPointerDown, pendingClick, sendBrowserCommand]);

  const handleWheel = useCallback(async (event: React.WheelEvent<HTMLDivElement>) => {
    if (!sessionId || !viewerUrl) {
      return;
    }
    event.preventDefault();
    try {
      await sendBrowserCommand({
        type: 'scroll',
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
      logger.info('[BROWSER_VIEWPORT] Scroll event', { deltaX: event.deltaX, deltaY: event.deltaY });
    } catch (error) {
      logger.error('[BrowserViewport] scroll command failed', error);
    }
  }, [sessionId, viewerUrl, sendBrowserCommand]);

  const handleKeyDown = useCallback(async (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!sessionId || !viewerUrl) {
      return;
    }
    event.preventDefault();
    const text = event.key.length === 1 ? event.key : undefined;
    try {
      if (text) {
        await sendBrowserCommand({
          type: 'type',
          text,
        });
        logger.info('[BROWSER_VIEWPORT] Typing text', { text });
      } else {
        await sendBrowserCommand({
          type: 'key',
          key: event.key,
        });
        logger.info('[BROWSER_VIEWPORT] Key press', { key: event.key });
      }
    } catch (error) {
      logger.error('[BrowserViewport] key command failed', error);
    }
  }, [sessionId, viewerUrl, sendBrowserCommand]);

  const handleImageLoad = useCallback(() => {
    setViewerReady(true);
    logger.info('[BROWSER_VIEWPORT] Stream image loaded');
  }, [setViewerReady]);

  const handleImageError = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const target = event.target as HTMLImageElement;
    logger.error('[BROWSER_VIEWPORT] Stream image failed to load', { src: target?.src });
    setViewerReady(false);
  }, [setViewerReady]);

  const sessionNotReady = normalizedStatus !== 'ready';

  return (
    <div className="browser-viewport">
      <div className="browser-viewport__screen">
        {viewerUrl ? (
          <img
            src={viewerUrl}
            alt="Live browser view"
            className="browser-viewport__stream"
            draggable={false}
            onLoad={handleImageLoad}
            onError={handleImageError}
          />
        ) : (
          <div className="browser-viewport__placeholder">
            <Icons.Globe className="w-12 h-12 mb-3" />
            <p>No active browser session stream detected.</p>
            <button onClick={initializeSession} className="browser-viewport__retry">
              Retry Connection
            </button>
          </div>
        )}

        <div
          className="browser-viewport__overlay"
          ref={overlayRef}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => {
            setIsPointerDown(false);
            setPendingClick(null);
          }}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
        />

        {sessionNotReady && (
          <div className="browser-viewport__status">
            <div className="browser-viewport__status-card">
              <Icons.RotateCw className="w-5 h-5 animate-spin" />
              <span>Browser session: {normalizedStatus}</span>
            </div>
          </div>
        )}

        {!viewerReady && viewerUrl && !sessionNotReady && (
          <div className="browser-viewport__status">
            <div className="browser-viewport__status-card">
              <Icons.RotateCw className="w-5 h-5 animate-spin" />
              <span>Waiting for stream...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
