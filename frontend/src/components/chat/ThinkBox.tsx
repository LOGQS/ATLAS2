// status: complete
import React, { useState, useEffect, useRef, useCallback } from 'react';
import MessageRenderer from '../message/MessageRenderer';
import '../../styles/message/MessageRenderer.css';
import logger from '../../utils/core/logger';
import useScrollControl from '../../hooks/ui/useScrollControl';

interface ThinkBoxProps {
  thoughts: string;
  isStreaming?: boolean;
  isVisible?: boolean;
  chatId?: string;
  messageId?: string;
  chatScrollControl?: {
    shouldAutoScroll: () => boolean;
    onStreamStart: () => void;
    resetToAutoScroll: () => void;
    notifyProgrammaticScroll: () => void;
  };
}

const ThinkBox: React.FC<ThinkBoxProps> = ({ 
  thoughts, 
  isStreaming = false, 
  isVisible = true,
  chatId,
  messageId,
  chatScrollControl
}) => {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [displayedThoughts, setDisplayedThoughts] = useState('');
  const thoughtsEndRef = useRef<HTMLDivElement>(null);
  const thinkBoxContentRef = useRef<HTMLElement>(null);
  const hasExpandedForCurrentStream = useRef<boolean>(false);
  
  const thinkBoxScrollControl = useScrollControl({
    chatId: `thinkbox-${chatId}-${messageId}`,
    streamingState: isStreaming ? 'thinking' : 'static',
    containerRef: thinkBoxContentRef,
    scrollType: 'thinkbox'
  });


  const scrollToBottom = useCallback(() => {
    if (!thinkBoxScrollControl.shouldAutoScroll()) {
      return;
    }

    if (chatScrollControl && !chatScrollControl.shouldAutoScroll()) {
      return;
    }

    requestAnimationFrame(() => {
      if (thoughtsEndRef.current) {
        thinkBoxScrollControl.notifyProgrammaticScroll();
        thoughtsEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }, [thinkBoxScrollControl, chatScrollControl]);

  useEffect(() => {
    if (isStreaming && thoughts) {
      setDisplayedThoughts(thoughts);
      if (thinkBoxScrollControl.shouldAutoScroll()) {
        setTimeout(scrollToBottom, 0);
      }
    } else if (!isStreaming) {
      setDisplayedThoughts(thoughts);
    }
  }, [thoughts, isStreaming, scrollToBottom, thinkBoxScrollControl]);

  useEffect(() => {
    if (isStreaming && !hasExpandedForCurrentStream.current) {
      hasExpandedForCurrentStream.current = true;
      setIsCollapsed(false);
      logger.debug(`[THINKBOX] Expanding ThinkBox for ${chatId} (streaming started)`);
      try {
        window.dispatchEvent(new CustomEvent('chatContentResized', { detail: { chatId, messageId, source: 'thinkbox', collapsed: false } }));
      } catch {}
      
      setTimeout(() => {
        if (chatScrollControl?.shouldAutoScroll()) {
          const thinkBoxElement = thoughtsEndRef.current;
          const chatContainer = thinkBoxElement?.closest('.chat-messages')?.querySelector('.messages-container');
          if (chatContainer) {
            chatScrollControl.notifyProgrammaticScroll();
            chatContainer.scrollTop = chatContainer.scrollHeight;
            logger.info(`[SCROLL] ThinkBox triggered scroll to bottom for chat: ${chatId || 'unknown'}`);
          }
        } else {
          logger.debug(`[SCROLL] ThinkBox scroll to bottom suppressed for ${chatId} (auto-scroll disabled)`);
        }
      }, 100);
    } else if (!isStreaming && thoughts) {
      hasExpandedForCurrentStream.current = false;
      const timer = setTimeout(() => {
        setIsCollapsed(true);
        logger.debug(`[THINKBOX] Collapsing ThinkBox for ${chatId} (streaming ended)`);
        try {
          window.dispatchEvent(new CustomEvent('chatContentResized', { detail: { chatId, messageId, source: 'thinkbox', collapsed: true } }));
        } catch {}
      }, 1000);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isStreaming, chatScrollControl]); 

  useEffect(() => {
    const thinkBoxContent = thoughtsEndRef.current?.closest('.think-box-content');
    if (thinkBoxContent && thinkBoxContentRef.current !== thinkBoxContent) {
      thinkBoxContentRef.current = thinkBoxContent as HTMLElement;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thoughtsEndRef.current]); 

  const toggleCollapse = () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    logger.debug(`[THINKBOX] Manual toggle collapse for ${chatId}: ${next}`);
    try {
      window.dispatchEvent(new CustomEvent('chatContentResized', { detail: { chatId, messageId, source: 'thinkbox', collapsed: next } }));
    } catch {}
  };

  if (!isVisible || (!thoughts && !isStreaming)) {
    return null;
  }

  return (
    <div className="think-box">
      <div 
        className="think-box-header" 
        onClick={toggleCollapse}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            toggleCollapse();
          }
        }}
      >
        <div className="think-box-title">
          <div className="think-icon"></div>
          <span className="think-label">Thinking...</span>
          <div className={`thinking-indicator ${!isStreaming ? 'hidden' : ''}`}>
            <div className="dot"></div>
            <div className="dot"></div>
            <div className="dot"></div>
          </div>
        </div>
        <div className={`collapse-arrow ${isCollapsed ? 'collapsed' : ''}`}>
          <div className="arrow-icon"></div>
        </div>
      </div>
      
      <div className={`think-box-content ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="think-box-text">
          <MessageRenderer 
            content={displayedThoughts} 
            showCursor={isStreaming}
          />
          <div ref={thoughtsEndRef} />
        </div>
      </div>
    </div>
  );
};

export default ThinkBox;
