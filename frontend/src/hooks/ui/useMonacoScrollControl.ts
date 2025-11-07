import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import * as Monaco from 'monaco-editor';
import logger from '../../utils/core/logger';

const SCROLL_CONFIG = {
  REJOIN_ZONE_PERCENTAGE: 0.55,
  USER_INTERACTION_TIMEOUT_MS: 100,
  SCROLLBAR_WIDTH: 20,
  BOTTOM_THRESHOLD: 1,
  DISABLE_DELTA: {
    FACTOR: 0.01,
    MIN: 2,
    MAX: 36
  },
  REJOIN_VELOCITY: {
    FACTOR: 0.001,
    MIN: 0.2,
    MAX: 1.5
  },
  REJOIN_DELTA: {
    FACTOR: 0.05,
    MIN: 8,
    MAX: 48
  }
} as const;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export interface ExternalInteractionOptions {
  direction?: 'up' | 'down';
  disableAutoScroll?: boolean;
  reason?: string;
}

export interface MonacoScrollControlActions {
  shouldAutoScroll: () => boolean;
  onStreamStart: () => void;
  onStreamEnd: () => void;
  forceScrollToBottom: () => void;
  notifyExternalInteraction: (options?: ExternalInteractionOptions) => void;
  isStreaming: boolean;
  isAutoScrollEnabled: boolean;
}

interface UseMonacoScrollControlOptions {
  chatId?: string;
  streamingState: 'thinking' | 'responding' | 'static';
  editor: Monaco.editor.IStandaloneCodeEditor | null;
}

/**
 * Monaco Editor-specific scroll control that uses Monaco's API instead of DOM scrollTop.
 * Keeps all the user interaction detection logic but translates to Monaco operations.
 */
export function useMonacoScrollControl({
  chatId,
  streamingState,
  editor
}: UseMonacoScrollControlOptions): MonacoScrollControlActions {
  const [autoScrollEnabledState, setAutoScrollEnabledState] = useState(true);
  const [isStreamingState, setIsStreamingState] = useState(false);

  const autoScrollEnabledRef = useRef(true);
  const isStreamingRef = useRef(false);
  const userInteractingRef = useRef(false);
  const userInteractionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastScrollTimeRef = useRef(0);
  const scrollVelocityRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const containerRef = useRef<HTMLElement | null>(null);

  const updateAutoScrollEnabled = useCallback((updater: boolean | ((prev: boolean) => boolean)) => {
    const previous = autoScrollEnabledRef.current;
    const next = typeof updater === 'function' ? (updater as (value: boolean) => boolean)(previous) : updater;
    autoScrollEnabledRef.current = next;
    setAutoScrollEnabledState(next);
  }, []);

  const updateIsStreaming = useCallback((updater: boolean | ((prev: boolean) => boolean)) => {
    const previous = isStreamingRef.current;
    const next = typeof updater === 'function' ? (updater as (value: boolean) => boolean)(previous) : updater;
    isStreamingRef.current = next;
    setIsStreamingState(next);
  }, []);

  const logState = useCallback((action: string, details?: Record<string, unknown>, level: 'info' | 'debug' = 'info') => {
    const payload = {
      action,
      chatId: chatId || 'unknown',
      scrollType: 'monaco-editor',
      autoScrollEnabled: autoScrollEnabledRef.current,
      isStreaming: isStreamingRef.current,
      userInteracting: userInteractingRef.current,
      streamingState,
      ...details
    };

    const message = `[SCROLL_MONACO] ${JSON.stringify(payload)}`;
    if (level === 'debug') {
      logger.debug(message);
    } else {
      logger.info(message);
    }
  }, [chatId, streamingState]);

  // Monaco-specific: Check if at bottom using Monaco's scroll API
  const isAtBottom = useCallback((): boolean => {
    if (!editor) return false;

    const scrollTop = editor.getScrollTop();
    const scrollHeight = editor.getScrollHeight();
    const layoutInfo = editor.getLayoutInfo();
    const clientHeight = layoutInfo.height;

    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    return distanceFromBottom <= SCROLL_CONFIG.BOTTOM_THRESHOLD;
  }, [editor]);

  // Monaco-specific: Scroll to bottom using Monaco's API
  const scrollToBottom = useCallback(() => {
    if (!editor) return;

    const model = editor.getModel();
    if (!model) return;

    const lineCount = model.getLineCount();

    // Reveal last line to ensure it's in view
    editor.revealLine(lineCount, Monaco.editor.ScrollType.Immediate);

    // Also set scroll to maximum to ensure we're at absolute bottom
    const scrollHeight = editor.getScrollHeight();
    const layoutInfo = editor.getLayoutInfo();
    const maxScrollTop = Math.max(0, scrollHeight - layoutInfo.height);
    editor.setScrollTop(maxScrollTop, Monaco.editor.ScrollType.Immediate);

    logState('MONACO_SCROLLED_TO_BOTTOM', {
      lineCount,
      scrollHeight,
      maxScrollTop
    }, 'debug');
  }, [editor, logState]);

  // Monaco-specific: Get current scroll metrics
  const getScrollMetrics = useCallback(() => {
    if (!editor) return null;

    const scrollTop = editor.getScrollTop();
    const scrollHeight = editor.getScrollHeight();
    const layoutInfo = editor.getLayoutInfo();
    const clientHeight = layoutInfo.height;

    return { scrollTop, scrollHeight, clientHeight };
  }, [editor]);

  // Maintain bottom lock during streaming using Monaco API
  const maintainBottomLock = useCallback(() => {
    if (!mountedRef.current || !editor) {
      return;
    }

    const shouldLock = isStreamingRef.current && autoScrollEnabledRef.current && !userInteractingRef.current;
    if (shouldLock) {
      const atBottom = isAtBottom();
      if (!atBottom) {
        scrollToBottom();
      }
    }

    if (isStreamingRef.current && autoScrollEnabledRef.current) {
      rafIdRef.current = requestAnimationFrame(maintainBottomLock);
    } else {
      rafIdRef.current = null;
    }
  }, [editor, isAtBottom, scrollToBottom]);

  const startUserInteraction = useCallback(() => {
    userInteractingRef.current = true;
    if (userInteractionTimeoutRef.current !== null) {
      clearTimeout(userInteractionTimeoutRef.current);
    }
    userInteractionTimeoutRef.current = setTimeout(() => {
      userInteractingRef.current = false;
      logState('USER_INTERACTION_ENDED', undefined, 'debug');
    }, SCROLL_CONFIG.USER_INTERACTION_TIMEOUT_MS);
  }, [logState]);

  const handleWheel = useCallback((event: WheelEvent) => {
    if (!event.isTrusted || !editor) return;

    const metrics = getScrollMetrics();
    if (!metrics) return;

    startUserInteraction();

    // Scrolling up disables auto-scroll
    if (event.deltaY < 0 && isStreamingRef.current && autoScrollEnabledRef.current) {
      updateAutoScrollEnabled(false);
      logState('DISABLED_BY_WHEEL_UP', { deltaY: event.deltaY });
    }
    // Scrolling down near bottom re-enables auto-scroll
    else if (event.deltaY > 0 && !autoScrollEnabledRef.current && isStreamingRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = metrics;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const rejoinZone = clientHeight * SCROLL_CONFIG.REJOIN_ZONE_PERCENTAGE;

      if (distanceFromBottom <= rejoinZone) {
        updateAutoScrollEnabled(true);
        logState('REJOIN_BY_WHEEL', {
          distanceFromBottom,
          rejoinZone,
          deltaY: event.deltaY
        });
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
        }
        if (isStreamingRef.current) {
          rafIdRef.current = requestAnimationFrame(maintainBottomLock);
        }
      }
    }
  }, [editor, getScrollMetrics, startUserInteraction, maintainBottomLock, logState, updateAutoScrollEnabled]);

  const handleTouchStart = useCallback(() => {
    if (!editor) return;
    startUserInteraction();
    lastScrollTopRef.current = editor.getScrollTop();
  }, [editor, startUserInteraction]);

  const handleTouchMove = useCallback(() => {
    startUserInteraction();
  }, [startUserInteraction]);

  const handleMouseDown = useCallback((event: MouseEvent) => {
    if (!event.isTrusted || !editor || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const layoutInfo = editor.getLayoutInfo();
    const isScrollbarClick = clickX > layoutInfo.width - SCROLL_CONFIG.SCROLLBAR_WIDTH;

    if (isScrollbarClick) {
      startUserInteraction();
      logState('SCROLLBAR_DRAG_START', { clientX: event.clientX }, 'debug');
    }
  }, [editor, startUserInteraction, logState]);

  // Monaco-specific: Handle scroll events from Monaco's onDidScrollChange
  const handleMonacoScroll = useCallback(() => {
    const metrics = getScrollMetrics();
    if (!metrics) return;

    const { scrollTop, scrollHeight, clientHeight } = metrics;
    const now = performance.now();
    const timeDelta = Math.max(now - lastScrollTimeRef.current, 1);

    const disableDeltaThreshold = clamp(
      clientHeight * SCROLL_CONFIG.DISABLE_DELTA.FACTOR,
      SCROLL_CONFIG.DISABLE_DELTA.MIN,
      SCROLL_CONFIG.DISABLE_DELTA.MAX
    );

    const rejoinVelocityThreshold = clamp(
      clientHeight * SCROLL_CONFIG.REJOIN_VELOCITY.FACTOR,
      SCROLL_CONFIG.REJOIN_VELOCITY.MIN,
      SCROLL_CONFIG.REJOIN_VELOCITY.MAX
    );

    const rejoinDeltaThreshold = clamp(
      clientHeight * SCROLL_CONFIG.REJOIN_DELTA.FACTOR,
      SCROLL_CONFIG.REJOIN_DELTA.MIN,
      SCROLL_CONFIG.REJOIN_DELTA.MAX
    );

    const scrollDelta = scrollTop - lastScrollTopRef.current;
    scrollVelocityRef.current = scrollDelta / timeDelta;

    // User scrolling up disables auto-scroll
    if (userInteractingRef.current && scrollDelta < -disableDeltaThreshold && isStreamingRef.current && autoScrollEnabledRef.current) {
      updateAutoScrollEnabled(false);
      logState('DISABLED_BY_SCROLL_UP', {
        scrollDelta,
        velocity: scrollVelocityRef.current,
        disableDeltaThreshold
      });
    }
    // User scrolling down near bottom re-enables auto-scroll
    else if (userInteractingRef.current && !autoScrollEnabledRef.current && isStreamingRef.current) {
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const rejoinZone = clientHeight * SCROLL_CONFIG.REJOIN_ZONE_PERCENTAGE;
      const downwardVelocity = scrollVelocityRef.current > 0 ? scrollVelocityRef.current : 0;
      const downwardDelta = scrollDelta > 0 ? scrollDelta : 0;

      if (distanceFromBottom <= rejoinZone) {
        const meetsVelocity = downwardVelocity >= rejoinVelocityThreshold;
        const meetsDelta = downwardDelta >= rejoinDeltaThreshold;
        const nearBottomThreshold = Math.max(SCROLL_CONFIG.BOTTOM_THRESHOLD, rejoinDeltaThreshold * 0.2);
        const atBottom = distanceFromBottom <= nearBottomThreshold;
        const gentleDownwardNudge = atBottom && downwardDelta >= 0;

        if (meetsVelocity || meetsDelta || gentleDownwardNudge) {
          updateAutoScrollEnabled(true);
          logState('REJOIN_BY_USER_SCROLL', {
            velocity: downwardVelocity,
            delta: downwardDelta,
            distanceFromBottom,
            rejoinZone,
            meetsVelocity,
            meetsDelta,
            gentleDownwardNudge
          });
          if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current);
          }
          if (isStreamingRef.current) {
            rafIdRef.current = requestAnimationFrame(maintainBottomLock);
          }
        }
      }
    }

    lastScrollTopRef.current = scrollTop;
    lastScrollTimeRef.current = now;
  }, [getScrollMetrics, maintainBottomLock, logState, updateAutoScrollEnabled]);

  const onStreamStart = useCallback(() => {
    if (isStreamingRef.current) return;

    logState('STREAM_START');
    updateIsStreaming(true);
    updateAutoScrollEnabled(true);
    userInteractingRef.current = false;

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(maintainBottomLock);
  }, [logState, updateIsStreaming, updateAutoScrollEnabled, maintainBottomLock]);

  const onStreamEnd = useCallback(() => {
    if (!isStreamingRef.current) return;

    logState('STREAM_END');
    updateIsStreaming(false);

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, [logState, updateIsStreaming]);

  const forceScrollToBottom = useCallback(() => {
    if (!editor) {
      logState('FORCED_TO_BOTTOM_SKIPPED', { reason: 'no-editor' }, 'debug');
      return;
    }

    userInteractingRef.current = false;
    scrollToBottom();
    updateAutoScrollEnabled(true);
    logState('FORCED_TO_BOTTOM');

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }
    if (isStreamingRef.current) {
      rafIdRef.current = requestAnimationFrame(maintainBottomLock);
    }
  }, [editor, scrollToBottom, maintainBottomLock, logState, updateAutoScrollEnabled]);

  const notifyExternalInteraction = useCallback((options?: ExternalInteractionOptions) => {
    const { direction, disableAutoScroll = false, reason } = options ?? {};
    startUserInteraction();

    const shouldDisable = disableAutoScroll || direction === 'up';
    if (shouldDisable && isStreamingRef.current && autoScrollEnabledRef.current) {
      updateAutoScrollEnabled(false);
      logState('DISABLED_BY_EXTERNAL_INTERACTION', { direction, reason });
      return;
    }

    logState('EXTERNAL_INTERACTION', { direction, reason, disableAutoScroll }, 'debug');
  }, [startUserInteraction, updateAutoScrollEnabled, logState]);

  const shouldAutoScroll = useCallback((): boolean => {
    const result = isStreamingRef.current && autoScrollEnabledRef.current;
    logState('SHOULD_AUTO_SCROLL_CHECK', {
      result,
      userInteracting: userInteractingRef.current
    }, 'debug');
    return result;
  }, [logState]);

  // Attach DOM event listeners to Monaco's container
  useEffect(() => {
    if (!editor) return;

    const container = editor.getDomNode();
    if (!container) return;

    containerRef.current = container;

    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('mousedown', handleMouseDown, { passive: true });

    logState('LISTENERS_ATTACHED');

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('mousedown', handleMouseDown);
      logState('LISTENERS_REMOVED');
    };
  }, [editor, handleWheel, handleTouchStart, handleTouchMove, handleMouseDown, logState]);

  // Attach Monaco's scroll event listener
  useEffect(() => {
    if (!editor) return;

    const disposable = editor.onDidScrollChange(() => {
      handleMonacoScroll();
    });

    logState('MONACO_SCROLL_LISTENER_ATTACHED');

    return () => {
      disposable.dispose();
      logState('MONACO_SCROLL_LISTENER_REMOVED');
    };
  }, [editor, handleMonacoScroll, logState]);

  // React to streaming state changes
  useEffect(() => {
    if (streamingState !== 'static' && !isStreamingRef.current) {
      onStreamStart();
    } else if (streamingState === 'static' && isStreamingRef.current) {
      onStreamEnd();
    }
  }, [streamingState, onStreamStart, onStreamEnd]);

  useEffect(() => {
    if (!editor) {
      logState('EDITOR_UNAVAILABLE', undefined, 'debug');
      return;
    }

    logState('EDITOR_READY', {
      autoScrollEnabled: autoScrollEnabledRef.current,
      isStreaming: isStreamingRef.current
    }, 'debug');

    if (isStreamingRef.current && autoScrollEnabledRef.current) {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      rafIdRef.current = requestAnimationFrame(() => {
        scrollToBottom();
        maintainBottomLock();
      });
    }
  }, [editor, maintainBottomLock, scrollToBottom, logState]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (userInteractionTimeoutRef.current !== null) {
        clearTimeout(userInteractionTimeoutRef.current);
        userInteractionTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    logState('INITIALIZED', {
      initialAutoScroll: autoScrollEnabledRef.current,
      initialStreaming: isStreamingRef.current
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useMemo(() => ({
    shouldAutoScroll,
    onStreamStart,
    onStreamEnd,
    forceScrollToBottom,
    notifyExternalInteraction,
    isStreaming: isStreamingState,
    isAutoScrollEnabled: autoScrollEnabledState
  }), [shouldAutoScroll, onStreamStart, onStreamEnd, forceScrollToBottom, notifyExternalInteraction, isStreamingState, autoScrollEnabledState]);
}

export default useMonacoScrollControl;
