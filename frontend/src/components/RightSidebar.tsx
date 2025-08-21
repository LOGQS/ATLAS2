// status: complete

import React, { useState} from 'react';
import '../styles/RightSidebar.css';
import { BrowserStorage } from '../utils/BrowserStorage';
import logger from '../utils/logger';

const RightSidebar: React.FC = () => {
  const [isToggled, setIsToggled] = useState(() => {
    const settings = BrowserStorage.getUISettings();
    return settings.rightSidebarToggled;
  });
  const [isHovering, setIsHovering] = useState(false);

  const handleToggle = () => {
    const newToggleState = !isToggled;
    logger.info('Toggling right sidebar:', newToggleState);
    setIsToggled(newToggleState);
    BrowserStorage.updateUISetting('rightSidebarToggled', newToggleState);
  };

  const shouldBeVisible = isToggled || (!isToggled && isHovering);

  return (
    <>
      <div 
        className={`right-sidebar ${shouldBeVisible ? 'open' : ''}`}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        <div className="sidebar-content">
          <div className="sidebar-header">
            <div className="sidebar-header-top">
              <h3>Customizations</h3>
              <div className="sidebar-toggle-container">
                <button 
                  className={`sidebar-toggle ${isToggled ? 'active' : ''}`}
                  onClick={handleToggle}
                >
                  <div className="toggle-slider"></div>
                </button>
              </div>
            </div>
          </div>
          <div className="sidebar-items">
            <div className="chat-history-section">
              <div className="chat-history-header">
                <div className="chat-history-title">
                  <div className="sidebar-icon knowledge-icon"></div>
                  <h3>Knowledge Management</h3>
                </div>
              </div>
              <div className="chat-history-content">
                <div className="sidebar-item">
                  <div className="sidebar-icon profile-icon"></div>
                  Profiles
                </div>
                <div className="sidebar-item">
                  <div className="sidebar-icon document-icon"></div>
                  Files
                </div>
                <div className="sidebar-item">
                  <div className="sidebar-icon folder-icon"></div>
                  Folders
                </div>
                <div className="sidebar-item">
                  <div className="sidebar-icon globe-icon"></div>
                  Web
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {!isToggled && (
        <div 
          className="sidebar-hover-zone right"
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
        />
      )}
    </>
  );
};

export default RightSidebar;