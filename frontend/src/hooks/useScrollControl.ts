import { useState, useCallback, useRef, useEffect, RefObject } from 'react';
import logger from '../utils/logger';

interface ScrollControlActions {
  shouldAutoScroll: () => boolean;
  onStreamStart: () => void;
  resetToAutoScroll: () => void;
}

interface UseScrollControlOptions {
  chatId?: string;
  streamingState?: 'thinking' | 'responding' | 'static';
  containerRef?: RefObject<HTMLElement | null>;
  scrollType?: 'chat' | 'thinkbox';
}

export function useScrollControl({ 
  chatId, 
  streamingState, 
  containerRef,
  scrollType = 'chat'
}: UseScrollControlOptions = {}): ScrollControlActions {
  const [scrollDown, setScrollDown] = useState(true);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
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
    }, 150);
  }, []);

  const checkScrollPosition = useCallback((container: HTMLElement, isUserInitiated: boolean = false) => {
    if (!container || !isUserInitiated) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const isAtBottom = Math.abs(scrollTop + clientHeight - scrollHeight) < 3;
    const scrolledUp = scrollTop < lastScrollTop.current;
    const scrollDelta = Math.abs(scrollTop - lastScrollTop.current);

    const minScrollDelta = scrollType === 'thinkbox' ? 1 : 3;
    if (scrollDelta < minScrollDelta) {
      return;
    }

    if (scrolledUp && streamingState !== 'static' && scrollDown && isUserInitiated) {
      logger.info(`[SCROLL] User scrolled up during streaming (${scrollType}-${chatId}), disabling auto-scroll`);
      setScrollDown(false);
    }
    else if (isAtBottom && !scrollDown && isUserScrolling && isUserInitiated) {
      logger.info(`[SCROLL] User manually scrolled to bottom (${scrollType}-${chatId}), enabling auto-scroll`);
      setScrollDown(true);
    }

    lastScrollTop.current = scrollTop;
  }, [chatId, streamingState, scrollDown, isUserScrolling, scrollType]);

  useEffect(() => {
    const container = containerRef?.current;
    if (!container) return;

    const handleScroll = (event: Event) => {
      if (event.isTrusted && !programmaticScrolling.current) {
        const now = Date.now();
        if (now - lastScrollTime.current > 16) { 
          handleUserScroll();
          
          if (scrollType === 'thinkbox' && streamingState !== 'static' && scrollDown) {
            const { scrollTop } = container;
            const scrolledUp = scrollTop < lastScrollTop.current;
            
            if (scrolledUp) {
              logger.info(`[SCROLL] ThinkBox scroll up during streaming (${chatId}), immediately disabling auto-scroll`);
              setScrollDown(false);
            }
          }
          
          checkScrollPosition(container, true);
          lastScrollTime.current = now;
          logger.debug(`[SCROLL] User scroll detected in ${scrollType} for ${chatId}`);
        }
      }
    };

    const handleWheel = (event: WheelEvent) => {
      if (event.isTrusted) {
        handleUserScroll();
        
        if (scrollType === 'thinkbox' && event.deltaY < 0 && streamingState !== 'static' && scrollDown) {
          logger.info(`[SCROLL] ThinkBox wheel up during streaming (${chatId}), immediately disabling auto-scroll`);
          setScrollDown(false);
        }
        
        checkScrollPosition(container, true); 
        logger.debug(`[SCROLL] Mouse wheel detected in ${scrollType} for ${chatId}`);
      }
    };

    const handleMouseDown = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const isScrollbarClick = clickX > container.clientWidth - 20;
      
      if (isScrollbarClick && event.isTrusted) {
        isScrollbarDragging.current = true;
        handleUserScroll();
        
        if (scrollType === 'thinkbox' && streamingState !== 'static' && scrollDown) {
          logger.info(`[SCROLL] ThinkBox scrollbar drag during streaming (${chatId}), immediately disabling auto-scroll`);
          setScrollDown(false);
        }
        
        logger.debug(`[SCROLL] Scrollbar drag started in ${scrollType} for ${chatId}`);
      }
    };

    const handleMouseUp = () => {
      if (isScrollbarDragging.current) {
        isScrollbarDragging.current = false;
        checkScrollPosition(container, true);
        logger.debug(`[SCROLL] Scrollbar drag ended in ${scrollType} for ${chatId}`);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((container.contains(event.target as Node) || event.target === container) && event.isTrusted) {
        const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
        if (scrollKeys.includes(event.key)) {
          handleUserScroll();
          checkScrollPosition(container, true);
          logger.debug(`[SCROLL] ${scrollType} keyboard scroll (${event.key}) for ${chatId}`);
        }
      }
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.isTrusted) {
        handleUserScroll();
        checkScrollPosition(container, true);
        logger.debug(`[SCROLL] ${scrollType} touch scroll started for ${chatId}`);
      }
    };

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
  }, [containerRef, handleUserScroll, checkScrollPosition, chatId, scrollType, streamingState, scrollDown]);

  const onStreamStart = useCallback(() => {
    if (streamingState !== 'static') {
      logger.info(`[SCROLL] Stream started for ${scrollType}-${chatId}, resetting scroll state to true`);
      setScrollDown(true);
      setIsUserScrolling(false);
    }
  }, [chatId, streamingState, scrollType]);

  const shouldAutoScroll = useCallback((): boolean => {
    if (streamingState === 'static') {
      logger.debug(`[SCROLL] Auto-scroll disabled for ${scrollType}-${chatId} (not streaming)`);
      return false;
    }

    if (!scrollDown) {
      logger.debug(`[SCROLL] Auto-scroll suppressed for ${scrollType}-${chatId} (scrollDown = false)`);
      return false;
    }

    logger.debug(`[SCROLL] Auto-scroll allowed for ${scrollType}-${chatId} (streaming + scrollDown = true)`);
    return true;
  }, [scrollDown, chatId, scrollType, streamingState]);

  const resetToAutoScroll = useCallback(() => {
    logger.info(`[SCROLL] Force resetting scroll state to auto-scroll for ${scrollType}-${chatId}`);
    setScrollDown(true);
    setIsUserScrolling(false);
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
      }, streamingState === 'static' ? 1200 : 800); 
    }
  }, [streamingState, onStreamStart, scrollType]);

  useEffect(() => {
    logger.info(`[SCROLL] Initializing scroll control for ${scrollType}-${chatId} with scrollDown = true`);
    setScrollDown(true);
    setIsUserScrolling(false);
    
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