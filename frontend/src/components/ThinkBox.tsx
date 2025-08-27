// status: complete
import React, { useState, useEffect, useRef, useCallback } from 'react';
import MessageRenderer from './MessageRenderer';
import '../styles/MessageRenderer.css';
import logger from '../utils/logger';
import useScrollControl from '../hooks/useScrollControl';

interface ThinkBoxProps {
  thoughts: string;
  isStreaming?: boolean;
  isVisible?: boolean;
  chatId?: string;
}

const ThinkBox: React.FC<ThinkBoxProps> = ({ 
  thoughts, 
  isStreaming = false, 
  isVisible = true,
  chatId 
}) => {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [displayedThoughts, setDisplayedThoughts] = useState('');
  const thoughtsEndRef = useRef<HTMLDivElement>(null);
  const thinkBoxContentRef = useRef<HTMLElement>(null);
  
  const thinkBoxScrollControl = useScrollControl({
    chatId: `thinkbox-${chatId}`,
    streamingState: isStreaming ? 'thinking' : 'static',
    containerRef: thinkBoxContentRef,
    scrollType: 'thinkbox'
  });


  const scrollToBottom = useCallback(() => {
    if (!thinkBoxScrollControl.shouldAutoScroll()) {
      return;
    }
    
    requestAnimationFrame(() => {
      thoughtsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      logger.debug(`[SCROLL] ThinkBox internal scroll for ${chatId}`);
    });
  }, [thinkBoxScrollControl, chatId]);

  useEffect(() => {
    if (isStreaming && thoughts) {
      setDisplayedThoughts(thoughts);
      setTimeout(scrollToBottom, 0);
    } else if (!isStreaming) {
      setDisplayedThoughts(thoughts);
    }
  }, [thoughts, isStreaming, scrollToBottom]);

  useEffect(() => {
    if (isStreaming) {
      setIsCollapsed(false);
      logger.debug(`[THINKBOX] Expanding ThinkBox for ${chatId} (streaming started)`);
      
      setTimeout(() => {
        const thinkBoxElement = thoughtsEndRef.current;
        const chatContainer = thinkBoxElement?.closest('.chat-messages')?.querySelector('.messages-container');
        if (chatContainer) {
          chatContainer.scrollTop = 0;
          logger.info(`[SCROLL] ThinkBox triggered scroll to top for chat: ${chatId || 'unknown'}`);
        }
      }, 100);
    } else if (!isStreaming && thoughts) {
      const timer = setTimeout(() => {
        setIsCollapsed(true);
        logger.debug(`[THINKBOX] Collapsing ThinkBox for ${chatId} (streaming ended)`);
      }, 1000);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isStreaming]); 

  useEffect(() => {
    const thinkBoxContent = thoughtsEndRef.current?.closest('.think-box-content');
    if (thinkBoxContent && thinkBoxContentRef.current !== thinkBoxContent) {
      thinkBoxContentRef.current = thinkBoxContent as HTMLElement;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thoughtsEndRef.current]); 

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
    logger.debug(`[THINKBOX] Manual toggle collapse for ${chatId}: ${!isCollapsed}`);
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