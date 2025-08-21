// status: complete
import React, { useState, useEffect, useRef } from 'react';

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


  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      thoughtsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  };

  useEffect(() => {
    if (isStreaming && thoughts) {
      setDisplayedThoughts(thoughts);
      setTimeout(scrollToBottom, 0);
    } else if (!isStreaming) {
      setDisplayedThoughts(thoughts);
    }
  }, [thoughts, isStreaming]);

  useEffect(() => {
    if (isStreaming && thoughts) {
      setIsCollapsed(false);
      setTimeout(() => {
        const thinkBoxElement = thoughtsEndRef.current;
        const chatContainer = thinkBoxElement?.closest('.chat-messages')?.querySelector('.messages-container');
        if (chatContainer) {
          chatContainer.scrollTop = 0;
          console.log(`[SCROLL] ThinkBox triggered scroll for chat: ${chatId || 'unknown'}`);
        }
      }, 100);
    } else if (!isStreaming && thoughts) {
      const timer = setTimeout(() => {
        setIsCollapsed(true);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [chatId, isStreaming, thoughts]);

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
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
          {displayedThoughts}
          <span className={`cursor ${!isStreaming ? 'hidden' : ''}`}>|</span>
          <div ref={thoughtsEndRef} />
        </div>
      </div>
    </div>
  );
};

export default ThinkBox;