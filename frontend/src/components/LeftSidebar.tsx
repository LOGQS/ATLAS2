import React, { useState } from 'react';
import '../styles/LeftSidebar.css';

const LeftSidebar: React.FC = () => {
  const [isToggled, setIsToggled] = useState(true);
  const [isHovering, setIsHovering] = useState(false);

  const shouldBeVisible = isToggled || (!isToggled && isHovering);

  return (
    <>
      <div 
        className={`left-sidebar ${shouldBeVisible ? 'open' : ''}`}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        <div className="sidebar-content">
          <div className="sidebar-header">
            <div className="sidebar-header-top">
              <h3>Quick Navigation</h3>
              <div className="sidebar-toggle-container">
                <button 
                  className={`sidebar-toggle ${isToggled ? 'active' : ''}`}
                  onClick={() => setIsToggled(!isToggled)}
                >
                  <div className="toggle-slider"></div>
                </button>
              </div>
            </div>
          </div>
          <div className="sidebar-items">
            <div className="sidebar-item">
              <div className="sidebar-icon gallery-icon"></div>
              Gallery
            </div>
            <div className="sidebar-item">
              <div className="sidebar-icon search-icon"></div>
              Search
            </div>
            <div className="sidebar-item">
              <div className="sidebar-icon settings-icon"></div>
              Settings
            </div>
            <div className="chat-history-section">
              <div className="chat-history-header">
                <h3>Chat History</h3>
                <button className="refresh-button">↻</button>
              </div>
              <div className="chat-history-content">
                <p className="no-history">No chat history yet</p>
              </div>
              <button className="new-chat-button">
                <span className="plus-icon">+</span>
                New Chat
              </button>
            </div>
          </div>
        </div>
      </div>
      {!isToggled && (
        <div 
          className="sidebar-hover-zone left"
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
        />
      )}
    </>
  );
};

export default LeftSidebar;