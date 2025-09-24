import { useState, useCallback, useRef, useEffect, RefObject } from 'react';
import logger from '../../utils/core/logger';

const SCROLL_CONFIG = {
  USER_SCROLL_TIMEOUT_MS: 150,
  THROTTLE_WINDOW_MS: 16,
  PROGRAMMATIC_SCROLL_TIMEOUT: {
    STREAMING: 800,
    STATIC: 1200
  },
  SCROLL_FACTORS: {
    VIEWPORT_BASE: 800,
    VIEWPORT_MIN: 0.7,
    HEIGHT_FACTOR: 0.002,
    VELOCITY_MULTIPLIER: 2,
    VELOCITY_MAX: 2.5,
    DELTA_FACTOR: 0.0005
  },
  THRESHOLDS: {
    AT_BOTTOM_MIN: 15,
    AT_BOTTOM_MAX: 100,
    REJOIN_TOLERANCE: 300, 
    REJOIN_MIN_VELOCITY: 0.5, 
    LARGE_CONTENT: 50000,
    SCROLL_DELTA_BASE: { thinkbox: 1, chat: 2 } as const,
    ADAPTIVE_MAX: { normal: 35, large: 50 },
    SCROLLBAR_WIDTH: 20,
    MIN_SCROLL_DOWN_DELTA: 10 
  }
} as const;

interface ScrollControlActions {
  shouldAutoScroll: () => boolean;
  onStreamStart: () => void;
  resetToAutoScroll: () => void;
  notifyProgrammaticScroll: () => void;
}

interface UseScrollControlOptions {
  chatId?: string; 
  streamingState: 'thinking' | 'responding' | 'static'; 
  containerRef: RefObject<HTMLElement | null>; 
  scrollType?: 'chat' | 'thinkbox'; 
}

export function useScrollControl({
  chatId,
  streamingState,
  containerRef,
  scrollType = 'chat'
}: UseScrollControlOptions): ScrollControlActions {
  const [scrollDown, setScrollDown] = useState(true);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const userDisabledAutoScroll = useRef<boolean>(false);
  const lastScrollTop = useRef<number>(0);
  const userScrollTimeout = useRef<NodeJS.Timeout | undefined>(undefined);
  const isScrollbarDragging = useRef<boolean>(false);
  const lastScrollTime = useRef<number>(0);
  const programmaticScrolling = useRef<boolean>(false);
  const programmaticScrollEndTime = useRef<number>(0);
  const lastUserInputTime = useRef<number>(0);
  const scrollVelocity = useRef<number>(0);
  const isActivelyScrollingDown = useRef<boolean>(false);
  const consecutiveDownScrolls = useRef<number>(0);

  const handleUserScroll = useCallback(() => {
    setIsUserScrolling(true);
    
    if (userScrollTimeout.current) {
      clearTimeout(userScrollTimeout.current);
    }
    
    userScrollTimeout.current = setTimeout(() => {
      setIsUserScrolling(false);
    }, SCROLL_CONFIG.USER_SCROLL_TIMEOUT_MS);
  }, []);

  const checkScrollPosition = useCallback((container: HTMLElement, isUserInitiated: boolean = false) => {
    if (!container || !isUserInitiated) return;

    const { scrollTop, scrollHeight, clientHeight } = container;

    const now = performance.now();
    const timeDelta = Math.max(now - lastScrollTime.current, 1);
    const scrollSpeed = Math.abs(scrollTop - lastScrollTop.current) / timeDelta;

    const scrolledUp = scrollTop < lastScrollTop.current;
    const scrolledDown = scrollTop > lastScrollTop.current;
    const scrollDelta = scrollTop - lastScrollTop.current;
    const scrollDeltaAbs = Math.abs(scrollDelta);

    scrollVelocity.current = scrollDelta / timeDelta;

    if (scrolledDown && scrollDelta >= SCROLL_CONFIG.THRESHOLDS.MIN_SCROLL_DOWN_DELTA) {
      consecutiveDownScrolls.current++;
      isActivelyScrollingDown.current = consecutiveDownScrolls.current >= 2;
    } else if (scrolledUp) {
      consecutiveDownScrolls.current = 0;
      isActivelyScrollingDown.current = false;
    }

    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    const isWithinRejoinTolerance = distanceFromBottom < SCROLL_CONFIG.THRESHOLDS.REJOIN_TOLERANCE;

    const baseMinDelta = scrollType === 'thinkbox' ? 1 : 2;
    const adaptiveMaxDelta = scrollHeight > 50000 ? 50 : 35;
    const minScrollDelta = Math.min(Math.max(scrollHeight * 0.0005, baseMinDelta), adaptiveMaxDelta);

    logger.debug(`[SCROLL-RELATIVE] ${scrollType}-${chatId || 'unknown'}: scrollHeight=${scrollHeight}px, viewport=${clientHeight}px, speed=${scrollSpeed.toFixed(3)}px/ms, velocity=${scrollVelocity.current.toFixed(3)}px/ms, distFromBottom=${distanceFromBottom.toFixed(0)}px, rejoinZone=${isWithinRejoinTolerance}, activeDown=${isActivelyScrollingDown.current}`);

    if (scrollDeltaAbs < minScrollDelta) {
      return;
    }

    if (scrolledUp && streamingState !== 'static' && scrollDown && isUserInitiated) {
      logger.info(`[SCROLL] User scrolled up during streaming (${scrollType}-${chatId || 'unknown'}), disabling auto-scroll`);
      setScrollDown(false);
      userDisabledAutoScroll.current = true;
    }
    else if (!scrollDown && isUserScrolling && isUserInitiated) {
      const shouldRejoin = isWithinRejoinTolerance &&
                           isActivelyScrollingDown.current &&
                           scrollVelocity.current > SCROLL_CONFIG.THRESHOLDS.REJOIN_MIN_VELOCITY;

      if (shouldRejoin) {
        logger.info(`[SCROLL] User actively scrolling down within rejoin zone (${scrollType}-${chatId || 'unknown'}), velocity=${scrollVelocity.current.toFixed(3)}px/ms, distance=${distanceFromBottom.toFixed(0)}px, enabling auto-scroll`);
        setScrollDown(true);
        userDisabledAutoScroll.current = false;
        consecutiveDownScrolls.current = 0;
        isActivelyScrollingDown.current = false;
      }
    }

    lastScrollTop.current = scrollTop;
  }, [chatId, streamingState, scrollDown, isUserScrolling, scrollType]);

  const createScrollHandler = useCallback((
    eventType: string,
    additionalLogic?: (event: any, container: HTMLElement) => boolean
  ) => {
    return (event: any) => {
      if (event.isTrusted) {
        const container = containerRef?.current;
        if (!container) return;

        const shouldContinue = additionalLogic ? additionalLogic(event, container) : true;
        if (!shouldContinue) return;

        handleUserScroll();
        
        if (scrollType === 'thinkbox' && streamingState !== 'static' && scrollDown) {
          let shouldDisable = false;
          
          if (eventType === 'scroll') {
            const { scrollTop } = container;
            const scrolledUp = scrollTop < lastScrollTop.current;
            shouldDisable = scrolledUp;
          } else if (eventType === 'wheel') {
            shouldDisable = event.deltaY < 0;
          } else if (eventType === 'mousedown') {
            const rect = container.getBoundingClientRect();
            const clickX = event.clientX - rect.left;
            shouldDisable = clickX > container.clientWidth - SCROLL_CONFIG.THRESHOLDS.SCROLLBAR_WIDTH;
          }
          
          if (shouldDisable) {
            logger.info(`[SCROLL] ThinkBox ${eventType} during streaming (${chatId || 'unknown'}), immediately disabling auto-scroll`);
            setScrollDown(false);
            userDisabledAutoScroll.current = true;
          }
        }
        
        checkScrollPosition(container, true);
        logger.debug(`[SCROLL] ${eventType} detected in ${scrollType} for ${chatId || 'unknown'}`);
      }
    };
  }, [containerRef, handleUserScroll, checkScrollPosition, chatId, scrollType, streamingState, scrollDown, lastScrollTop]);

  useEffect(() => {
    const container = containerRef?.current;
    if (!container) return;

    const handleScroll = createScrollHandler('User scroll', (event, container) => {
      const now = performance.now();

      if (programmaticScrolling.current && (now - programmaticScrollEndTime.current < 100)) {
        consecutiveDownScrolls.current = 0;
        isActivelyScrollingDown.current = false;
        return false;
      }

      const isNearUserInput = (now - lastUserInputTime.current) < 50;
      if (isNearUserInput) {
        programmaticScrolling.current = false;
      }

      lastScrollTime.current = now;
      return true;
    });

    const handleWheel = createScrollHandler('Mouse wheel', (event) => {
      lastUserInputTime.current = performance.now();
      programmaticScrolling.current = false;

      if (event.deltaY > 0) {
        consecutiveDownScrolls.current = Math.min(consecutiveDownScrolls.current + 1, 3);
        isActivelyScrollingDown.current = true;
      } else if (event.deltaY < 0) {
        consecutiveDownScrolls.current = 0;
        isActivelyScrollingDown.current = false;
      }

      return true;
    });

    const handleMouseDown = createScrollHandler('Scrollbar drag started', (event, container) => {
      const rect = container.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const isScrollbarClick = clickX > container.clientWidth - SCROLL_CONFIG.THRESHOLDS.SCROLLBAR_WIDTH;

      if (isScrollbarClick) {
        lastUserInputTime.current = performance.now();
        programmaticScrolling.current = false;
        isScrollbarDragging.current = true;
        return true;
      }
      return false;
    });

    const handleMouseUp = () => {
      if (isScrollbarDragging.current) {
        isScrollbarDragging.current = false;
        checkScrollPosition(container, true);
        logger.debug(`[SCROLL] Scrollbar drag ended in ${scrollType} for ${chatId || 'unknown'}`);
      }
    };

    const handleKeyDown = createScrollHandler('keyboard scroll', (event, container) => {
      const isValidTarget = container.contains(event.target as Node) || event.target === container;
      if (!isValidTarget) return false;

      const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
      if (scrollKeys.includes(event.key)) {
        lastUserInputTime.current = performance.now();
        programmaticScrolling.current = false;
        return true;
      }
      return false;
    });

    const handleTouchStart = createScrollHandler('touch scroll started', () => {
      lastUserInputTime.current = performance.now();
      programmaticScrolling.current = false;
      return true;
    });

    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('mousedown', handleMouseDown, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('mouseup', handleMouseUp, { passive: true });
    document.addEventListener('keydown', handleKeyDown, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerRef, handleUserScroll, checkScrollPosition, chatId, scrollType, streamingState, scrollDown, createScrollHandler]);

  const onStreamStart = useCallback(() => {
    if (streamingState !== 'static') {
      if (userDisabledAutoScroll.current) {
        logger.info(`[SCROLL] Stream started for ${scrollType}-${chatId || 'unknown'}, preserving user scroll resistance (scrollDown = false)`);
        setScrollDown(false);
      } else {
        logger.info(`[SCROLL] Stream started for ${scrollType}-${chatId || 'unknown'}, resetting scroll state to true`);
        setScrollDown(true);
      }
      setIsUserScrolling(false);
    }
  }, [chatId, streamingState, scrollType]);

  const shouldAutoScroll = useCallback((): boolean => {
    logger.debug(`[SCROLL-CHECK] shouldAutoScroll called for ${scrollType}-${chatId || 'unknown'}: streamingState=${streamingState}, scrollDown=${scrollDown}, userDisabledAutoScroll=${userDisabledAutoScroll.current}`);
    
    if (streamingState === 'static') {
      logger.debug(`[SCROLL] Auto-scroll disabled for ${scrollType}-${chatId || 'unknown'} (not streaming)`);
      return false;
    }

    if (!scrollDown) {
      logger.info(`[SCROLL] Auto-scroll suppressed for ${scrollType}-${chatId || 'unknown'} (scrollDown = false, userDisabledAutoScroll = ${userDisabledAutoScroll.current})`);
      return false;
    }

    logger.debug(`[SCROLL] Auto-scroll allowed for ${scrollType}-${chatId || 'unknown'} (streaming + scrollDown = true)`);
    return true;
  }, [scrollDown, chatId, scrollType, streamingState]);

  const resetToAutoScroll = useCallback(() => {
    logger.info(`[SCROLL] Force resetting scroll state to auto-scroll for ${scrollType}-${chatId || 'unknown'}`);
    setScrollDown(true);
    setIsUserScrolling(false);
    userDisabledAutoScroll.current = false;
  }, [chatId, scrollType]);

  useEffect(() => {
    if (streamingState !== 'static') {
      onStreamStart();
    }
  }, [streamingState, onStreamStart]);

  const notifyProgrammaticScroll = useCallback(() => {
    logger.debug(`[SCROLL] Programmatic scroll notification for ${scrollType}-${chatId || 'unknown'}`);
    programmaticScrolling.current = true;
    programmaticScrollEndTime.current = performance.now();

    consecutiveDownScrolls.current = 0;
    isActivelyScrollingDown.current = false;
    scrollVelocity.current = 0;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        programmaticScrolling.current = false;
      });
    });
  }, [chatId, scrollType]);

  useEffect(() => {
    logger.info(`[SCROLL] Initializing scroll control for ${scrollType}-${chatId || 'unknown'} with scrollDown = true`);
    setScrollDown(true);
    setIsUserScrolling(false);
    userDisabledAutoScroll.current = false;
    consecutiveDownScrolls.current = 0;
    isActivelyScrollingDown.current = false;
    scrollVelocity.current = 0;

    return () => {
      if (userScrollTimeout.current) {
        clearTimeout(userScrollTimeout.current);
      }
    };
  }, [chatId, scrollType]);

  return {
    shouldAutoScroll,
    onStreamStart,
    resetToAutoScroll,
    notifyProgrammaticScroll
  };
}

export default useScrollControl;