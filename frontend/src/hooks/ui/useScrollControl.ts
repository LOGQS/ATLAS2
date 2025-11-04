import { useState, useCallback, useRef, useEffect, RefObject, useMemo } from 'react';
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

export interface ScrollControlActions {
  shouldAutoScroll: () => boolean;
  onStreamStart: () => void;
  onStreamEnd: () => void;
  forceScrollToBottom: () => void;
  notifyExternalInteraction: (options?: ExternalInteractionOptions) => void;
  isStreaming: boolean;
  isAutoScrollEnabled: boolean;
}

interface UseScrollControlOptions {
  chatId?: string;
  streamingState: 'thinking' | 'responding' | 'static';
  containerRef: RefObject<HTMLElement | null>;
  scrollType?: 'chat' | 'thinkbox';
  isIsolated?: boolean;
}

export function useScrollControl({
  chatId,
  streamingState,
  containerRef,
  scrollType = 'chat',
  isIsolated = false
}: UseScrollControlOptions): ScrollControlActions {
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
      scrollType,
      autoScrollEnabled: autoScrollEnabledRef.current,
      isStreaming: isStreamingRef.current,
      userInteracting: userInteractingRef.current,
      streamingState,
      ...details
    };

    const message = `[SCROLL_${scrollType.toUpperCase()}] ${JSON.stringify(payload)}`;
    if (level === 'debug') {
      logger.debug(message);
    } else {
      logger.info(message);
    }
  }, [chatId, scrollType, streamingState]);

  const isAtBottom = useCallback((container: HTMLElement): boolean => {
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    return distanceFromBottom <= SCROLL_CONFIG.BOTTOM_THRESHOLD;
  }, []);

  const maintainBottomLock = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      if (isStreamingRef.current && autoScrollEnabledRef.current) {
        rafIdRef.current = requestAnimationFrame(maintainBottomLock);
      }
      return;
    }

    const shouldLock = isStreamingRef.current && autoScrollEnabledRef.current && !userInteractingRef.current;
    if (shouldLock) {
      const atBottom = isAtBottom(container);
      if (!atBottom) {
        container.scrollTop = Number.MAX_SAFE_INTEGER;
        logState('LOCK_ENFORCED', {
          scrollHeight: container.scrollHeight,
          scrollTop: container.scrollTop
        }, 'debug');
      }
    }

    if (isStreamingRef.current && autoScrollEnabledRef.current) {
      rafIdRef.current = requestAnimationFrame(maintainBottomLock);
    } else {
      rafIdRef.current = null;
    }
  }, [containerRef, isAtBottom, logState]);

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
    if (isIsolated) {
      event.stopPropagation();
    }

    if (!event.isTrusted) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    startUserInteraction();

    if (event.deltaY < 0 && isStreamingRef.current && autoScrollEnabledRef.current) {
      updateAutoScrollEnabled(false);
      logState('DISABLED_BY_WHEEL_UP', { deltaY: event.deltaY });
    } else if (event.deltaY > 0 && !autoScrollEnabledRef.current && isStreamingRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = container;
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
  }, [containerRef, startUserInteraction, maintainBottomLock, logState, updateAutoScrollEnabled, isIsolated]);

  const handleTouchStart = useCallback((event: TouchEvent) => {
    if (isIsolated) {
      event.stopPropagation();
    }

    if (!event.isTrusted) {
      return;
    }
    startUserInteraction();
    lastScrollTopRef.current = containerRef.current?.scrollTop || 0;
  }, [containerRef, startUserInteraction, isIsolated]);

  const handleTouchMove = useCallback((event: TouchEvent) => {
    if (isIsolated) {
      event.stopPropagation();
    }

    if (!event.isTrusted) {
      return;
    }
    startUserInteraction();
  }, [startUserInteraction, isIsolated]);

  const handleMouseDown = useCallback((event: MouseEvent) => {
    if (isIsolated) {
      event.stopPropagation();
    }

    if (!event.isTrusted) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const isScrollbarClick = clickX > container.clientWidth - SCROLL_CONFIG.SCROLLBAR_WIDTH;

    if (isScrollbarClick) {
      startUserInteraction();
      logState('SCROLLBAR_DRAG_START', { clientX: event.clientX }, 'debug');
    }
  }, [containerRef, startUserInteraction, logState, isIsolated]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = container;
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

    if (userInteractingRef.current && scrollDelta < -disableDeltaThreshold && isStreamingRef.current && autoScrollEnabledRef.current) {
      updateAutoScrollEnabled(false);
      logState('DISABLED_BY_SCROLL_UP', {
        scrollDelta,
        velocity: scrollVelocityRef.current,
        disableDeltaThreshold
      });
    } else if (userInteractingRef.current && !autoScrollEnabledRef.current && isStreamingRef.current) {
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
            gentleDownwardNudge,
            rejoinVelocityThreshold,
            rejoinDeltaThreshold,
            nearBottomThreshold
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
  }, [containerRef, maintainBottomLock, logState, updateAutoScrollEnabled]);

  const onStreamStart = useCallback(() => {
    if (isStreamingRef.current) {
      return;
    }

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
    if (!isStreamingRef.current) {
      return;
    }

    logState('STREAM_END');
    updateIsStreaming(false);

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, [logState, updateIsStreaming]);

  const forceScrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      logState('FORCED_TO_BOTTOM_SKIPPED', { reason: 'no-container' }, 'debug');
      return;
    }

    userInteractingRef.current = false;
    container.scrollTop = Number.MAX_SAFE_INTEGER;
    updateAutoScrollEnabled(true);
    logState('FORCED_TO_BOTTOM');

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }
    if (isStreamingRef.current) {
      rafIdRef.current = requestAnimationFrame(maintainBottomLock);
    }
  }, [containerRef, maintainBottomLock, logState, updateAutoScrollEnabled]);

  const notifyExternalInteraction = useCallback((options?: ExternalInteractionOptions) => {
    const { direction, disableAutoScroll = false, reason } = options ?? {};
    startUserInteraction();

    const shouldDisable = disableAutoScroll || direction === 'up';
    if (shouldDisable && isStreamingRef.current && autoScrollEnabledRef.current) {
      updateAutoScrollEnabled(false);
      logState('DISABLED_BY_EXTERNAL_INTERACTION', {
        direction,
        reason
      });
      return;
    }

    logState('EXTERNAL_INTERACTION', {
      direction,
      reason,
      disableAutoScroll
    }, 'debug');
  }, [startUserInteraction, updateAutoScrollEnabled, logState]);

  const shouldAutoScroll = useCallback((): boolean => {
    const result = isStreamingRef.current && autoScrollEnabledRef.current;
    logState('SHOULD_AUTO_SCROLL_CHECK', {
      result,
      userInteracting: userInteractingRef.current
    }, 'debug');
    return result;
  }, [logState]);

  useEffect(() => {
    let rafId: number | null = null;
    let active = true;
    let attachedContainer: HTMLElement | null = null;

    const attachListeners = () => {
      if (!active) {
        return;
      }

      const container = containerRef.current;
      if (!container) {
        rafId = requestAnimationFrame(attachListeners);
        return;
      }

      attachedContainer = container;
      container.addEventListener('wheel', handleWheel, { passive: true });
      container.addEventListener('scroll', handleScroll, { passive: true });
      container.addEventListener('touchstart', handleTouchStart, { passive: true });
      container.addEventListener('touchmove', handleTouchMove, { passive: true });
      container.addEventListener('mousedown', handleMouseDown, { passive: true });

      logState('LISTENERS_ATTACHED');
    };

    attachListeners();

    return () => {
      active = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      if (attachedContainer) {
        attachedContainer.removeEventListener('wheel', handleWheel);
        attachedContainer.removeEventListener('scroll', handleScroll);
        attachedContainer.removeEventListener('touchstart', handleTouchStart);
        attachedContainer.removeEventListener('touchmove', handleTouchMove);
        attachedContainer.removeEventListener('mousedown', handleMouseDown);
        logState('LISTENERS_REMOVED');
      }
    };
  }, [containerRef, handleWheel, handleScroll, handleTouchStart, handleTouchMove, handleMouseDown, logState]);

  useEffect(() => {
    if (streamingState !== 'static' && !isStreamingRef.current) {
      onStreamStart();
    } else if (streamingState === 'static' && isStreamingRef.current) {
      onStreamEnd();
    }
  }, [streamingState, onStreamStart, onStreamEnd]);

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

export default useScrollControl;
