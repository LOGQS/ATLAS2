import React, { useState } from 'react';
import '../styles/sections/SettingsWindow.css';

const SettingsWindow: React.FC = () => {
  const [theme, setTheme] = useState('dark');
  const [autoSave, setAutoSave] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [language, setLanguage] = useState('en');
  const [storageLimit] = useState(80);

  return (
    <div className="section-content">
      <div className="section-header">
        <h4>Settings</h4>
      </div>
      <div className="section-body settings-body">
        <div className="settings-group">
          <h5>Appearance</h5>
          <div className="setting-item">
            <div className="setting-label">
              <span>Theme</span>
              <span className="setting-description">Choose your preferred theme</span>
            </div>
            <select 
              value={theme} 
              onChange={(e) => setTheme(e.target.value)}
              className="setting-select"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="auto">Auto</option>
            </select>
          </div>
          <div className="setting-item">
            <div className="setting-label">
              <span>Language</span>
              <span className="setting-description">Select interface language</span>
            </div>
            <select 
              value={language} 
              onChange={(e) => setLanguage(e.target.value)}
              className="setting-select"
            >
              <option value="en">English</option>
              <option value="de">Deutsch</option>
            </select>
          </div>
        </div>

        <div className="settings-group">
          <h5>Behavior</h5>
          <div className="setting-item">
            <div className="setting-label">
              <span>Auto-save</span>
              <span className="setting-description">Automatically save changes</span>
            </div>
            <div className="setting-toggle">
              <button 
                className={`toggle-switch ${autoSave ? 'active' : ''}`}
                onClick={() => setAutoSave(!autoSave)}
              >
                <div className="toggle-slider"></div>
              </button>
            </div>
          </div>
          <div className="setting-item">
            <div className="setting-label">
              <span>Notifications</span>
              <span className="setting-description">Show system notifications</span>
            </div>
            <div className="setting-toggle">
              <button 
                className={`toggle-switch ${notifications ? 'active' : ''}`}
                onClick={() => setNotifications(!notifications)}
              >
                <div className="toggle-slider"></div>
              </button>
            </div>
          </div>
        </div>

        <div className="settings-group">
          <h5>Storage</h5>
          <div className="setting-item">
            <div className="setting-label">
              <span>Storage Usage</span>
              <span className="setting-description">{storageLimit}% of 1GB used</span>
            </div>
            <div className="storage-bar">
              <div 
                className="storage-fill"
                style={{ width: `${storageLimit}%` }}
              ></div>
            </div>
          </div>
          <div className="setting-item">
            <button className="section-button secondary">Clear Cache</button>
            <button className="section-button secondary">Export Data</button>
          </div>
        </div>

        <div className="settings-group">
          <h5>Advanced</h5>
          <div className="setting-item">
            <button className="section-button danger">Reset All Settings</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsWindow;