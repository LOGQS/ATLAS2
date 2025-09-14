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
    LARGE_CONTENT: 50000,
    SCROLL_DELTA_BASE: { thinkbox: 1, chat: 2 } as const,
    ADAPTIVE_MAX: { normal: 35, large: 50 },
    SCROLLBAR_WIDTH: 20
  }
} as const;

interface ScrollControlActions {
  shouldAutoScroll: () => boolean;
  onStreamStart: () => void;
  resetToAutoScroll: () => void;
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
  const contentChangeTimeout = useRef<NodeJS.Timeout | undefined>(undefined);

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
    
    const viewportFactor = Math.max(clientHeight / SCROLL_CONFIG.SCROLL_FACTORS.VIEWPORT_BASE, SCROLL_CONFIG.SCROLL_FACTORS.VIEWPORT_MIN); 
    
    const now = Date.now();
    const timeDelta = Math.max(now - lastScrollTime.current, 16);
    const scrollSpeed = Math.abs(scrollTop - lastScrollTop.current) / timeDelta;
    const velocityFactor = Math.min(1 + scrollSpeed * SCROLL_CONFIG.SCROLL_FACTORS.VELOCITY_MULTIPLIER, SCROLL_CONFIG.SCROLL_FACTORS.VELOCITY_MAX); 
    
    const baseAtBottomThreshold = scrollHeight * SCROLL_CONFIG.SCROLL_FACTORS.HEIGHT_FACTOR * viewportFactor * velocityFactor;
    const atBottomThreshold = Math.min(Math.max(baseAtBottomThreshold, SCROLL_CONFIG.THRESHOLDS.AT_BOTTOM_MIN), SCROLL_CONFIG.THRESHOLDS.AT_BOTTOM_MAX);
    const isAtBottom = Math.abs(scrollTop + clientHeight - scrollHeight) < atBottomThreshold;
    
    const scrolledUp = scrollTop < lastScrollTop.current;
    const scrollDelta = Math.abs(scrollTop - lastScrollTop.current);

    const baseMinDelta = scrollType === 'thinkbox' ? 1 : 2;
    const adaptiveMaxDelta = scrollHeight > 50000 ? 50 : 35;
    const minScrollDelta = Math.min(Math.max(scrollHeight * 0.0005, baseMinDelta), adaptiveMaxDelta);
    
    logger.debug(`[SCROLL-RELATIVE] ${scrollType}-${chatId || 'unknown'}: scrollHeight=${scrollHeight}px, viewport=${clientHeight}px, speed=${scrollSpeed.toFixed(3)}px/ms, velocity×${velocityFactor.toFixed(1)}, atBottom=${atBottomThreshold.toFixed(1)}px, minDelta=${minScrollDelta.toFixed(1)}px`);
    
    if (scrollDelta < minScrollDelta) {
      return;
    }

    if (scrolledUp && streamingState !== 'static' && scrollDown && isUserInitiated) {
      logger.info(`[SCROLL] User scrolled up during streaming (${scrollType}-${chatId || 'unknown'}), disabling auto-scroll`);
      setScrollDown(false);
      userDisabledAutoScroll.current = true;
    }
    else if (isAtBottom && !scrollDown && isUserScrolling && isUserInitiated) {
      logger.info(`[SCROLL] User manually scrolled to bottom (${scrollType}-${chatId || 'unknown'}), enabling auto-scroll`);
      setScrollDown(true);
      userDisabledAutoScroll.current = false;
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
      if (programmaticScrolling.current) return false;
      
      const now = Date.now();
      if (now - lastScrollTime.current > 16) {
        lastScrollTime.current = now;
        return true; 
      }
      return false; 
    });

    const handleWheel = createScrollHandler('Mouse wheel');

    const handleMouseDown = createScrollHandler('Scrollbar drag started', (event, container) => {
      const rect = container.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const isScrollbarClick = clickX > container.clientWidth - SCROLL_CONFIG.THRESHOLDS.SCROLLBAR_WIDTH;
      
      if (isScrollbarClick) {
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
      return scrollKeys.includes(event.key);
    });

    const handleTouchStart = createScrollHandler('touch scroll started');

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
    
    if (scrollType === 'thinkbox') {
      programmaticScrolling.current = true;
      if (contentChangeTimeout.current) {
        clearTimeout(contentChangeTimeout.current);
      }
      contentChangeTimeout.current = setTimeout(() => {
        programmaticScrolling.current = false;
      }, streamingState === 'static' ? SCROLL_CONFIG.PROGRAMMATIC_SCROLL_TIMEOUT.STATIC : SCROLL_CONFIG.PROGRAMMATIC_SCROLL_TIMEOUT.STREAMING); 
    }
  }, [streamingState, onStreamStart, scrollType]);

  useEffect(() => {
    logger.info(`[SCROLL] Initializing scroll control for ${scrollType}-${chatId || 'unknown'} with scrollDown = true`);
    setScrollDown(true);
    setIsUserScrolling(false);
    userDisabledAutoScroll.current = false;
    
    return () => {
      if (userScrollTimeout.current) {
        clearTimeout(userScrollTimeout.current);
      }
      if (contentChangeTimeout.current) {
        clearTimeout(contentChangeTimeout.current);
      }
    };
  }, [chatId, scrollType]);

  return {
    shouldAutoScroll,
    onStreamStart,
    resetToAutoScroll
  };
}

export default useScrollControl;