// status: complete
import React, { useState, useEffect, useRef } from 'react';
import MessageRenderer from '../message/MessageRenderer';
import '../../styles/message/MessageRenderer.css';
import logger from '../../utils/core/logger';
import useScrollControl, { type ScrollControlActions } from '../../hooks/ui/useScrollControl';

interface ThinkBoxProps {
  thoughts: string;
  isStreaming?: boolean;
  isVisible?: boolean;
  chatId?: string;
  messageId?: string;
  chatScrollControl?: ScrollControlActions;
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
  const thinkBoxContentRef = useRef<HTMLDivElement | null>(null);
  const hasExpandedForCurrentStream = useRef<boolean>(false);
  
  const thinkBoxScrollControl = useScrollControl({
    chatId: `thinkbox-${chatId}-${messageId}`,
    streamingState: isStreaming ? 'thinking' : 'static',
    containerRef: thinkBoxContentRef,
    scrollType: 'thinkbox',
    isIsolated: true
  });


  useEffect(() => {
    if (isStreaming && thoughts) {
      setDisplayedThoughts(thoughts);
      logger.info(`[THINKBOX] Updated thoughts for ${chatId}, streaming: ${isStreaming}`);
      if (thinkBoxScrollControl.shouldAutoScroll()) {
        thinkBoxScrollControl.forceScrollToBottom();
      }
    } else if (!isStreaming) {
      setDisplayedThoughts(thoughts);
    }
  }, [thoughts, isStreaming, chatId, thinkBoxScrollControl]);

  useEffect(() => {
    if (isStreaming && !hasExpandedForCurrentStream.current) {
      hasExpandedForCurrentStream.current = true;
      setIsCollapsed(false);
      logger.info(`[THINKBOX] Expanding ThinkBox for ${chatId} (streaming started)`);
      try {
        window.dispatchEvent(new CustomEvent('chatContentResized', { detail: { chatId, messageId, source: 'thinkbox', collapsed: false } }));
      } catch {}

      thinkBoxScrollControl.onStreamStart();

      logger.info(`[THINKBOX] Auto-scroll started for thinkbox-${chatId}`);
    } else if (!isStreaming && thoughts) {
      hasExpandedForCurrentStream.current = false;

      thinkBoxScrollControl.onStreamEnd();
      logger.info(`[THINKBOX] Auto-scroll ended for thinkbox-${chatId}`);

      const timer = setTimeout(() => {
        setIsCollapsed(true);
        logger.info(`[THINKBOX] Collapsing ThinkBox for ${chatId} (streaming ended)`);
        try {
          window.dispatchEvent(new CustomEvent('chatContentResized', { detail: { chatId, messageId, source: 'thinkbox', collapsed: true } }));
        } catch {}
      }, 1000);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isStreaming, thinkBoxScrollControl]); 

  const toggleCollapse = () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    logger.info(`[THINKBOX] Manual toggle collapse for ${chatId}: ${next ? 'collapsed' : 'expanded'}`);
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
      
      <div className={`think-box-content ${isCollapsed ? 'collapsed' : ''}`} ref={thinkBoxContentRef}>
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
