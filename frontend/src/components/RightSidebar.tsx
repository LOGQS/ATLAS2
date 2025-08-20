import React, { useState } from 'react';
import '../styles/RightSidebar.css';

const RightSidebar: React.FC = () => {
  const [isToggled, setIsToggled] = useState(false);
  const [isHovering, setIsHovering] = useState(false);

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
              <h3>Settings</h3>
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
            <div className="sidebar-item">Profile</div>
            <div className="sidebar-item">Preferences</div>
            <div className="sidebar-item">Theme</div>
            <div className="sidebar-item">Help</div>
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