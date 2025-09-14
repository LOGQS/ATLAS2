import React from 'react';
import SearchWindow from './SearchWindow';
import GalleryWindow from './GalleryWindow';
import SettingsWindow from './SettingsWindow';
import '../styles/sections/KnowledgeSection.css';

interface KnowledgeSectionProps {
  activeSubsection: string;
  onSubsectionChange: (subsection: string) => void;
}

const KnowledgeSection: React.FC<KnowledgeSectionProps> = ({ 
  activeSubsection, 
  onSubsectionChange 
}) => {
  const renderActiveSubsection = () => {
    switch (activeSubsection) {
      case 'search':
        return <SearchWindow />;
      case 'gallery':
        return <GalleryWindow />;
      case 'settings':
        return <SettingsWindow />;
      case 'profiles':
        return (
          <div className="section-content">
            <div className="section-header">
              <h4>Profiles Management</h4>
            </div>
            <div className="section-body">
              <div className="empty-state">
                <div className="empty-state-icon profile-large"></div>
                <p>No profiles configured yet</p>
                <button className="section-button primary">Create Profile</button>
              </div>
            </div>
          </div>
        );
      case 'files':
        return (
          <div className="section-content">
            <div className="section-header">
              <h4>File Management</h4>
              <div className="header-actions">
                <button className="section-button secondary">Upload</button>
              </div>
            </div>
            <div className="section-body">
              <div className="file-list">
                <div className="file-item">
                  <div className="sidebar-icon document-icon"></div>
                  <div className="file-info">
                    <span className="file-name">example-doc.pdf</span>
                    <span className="file-size">2.4 MB</span>
                  </div>
                  <div className="file-actions">
                    <button className="action-btn">⋯</button>
                  </div>
                </div>
                <div className="file-item">
                  <div className="sidebar-icon document-icon"></div>
                  <div className="file-info">
                    <span className="file-name">notes.txt</span>
                    <span className="file-size">15 KB</span>
                  </div>
                  <div className="file-actions">
                    <button className="action-btn">⋯</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      case 'folders':
        return (
          <div className="section-content">
            <div className="section-header">
              <h4>Folder Organization</h4>
              <div className="header-actions">
                <button className="section-button secondary">New Folder</button>
              </div>
            </div>
            <div className="section-body">
              <div className="folder-tree">
                <div className="folder-item">
                  <div className="sidebar-icon folder-icon"></div>
                  <span className="folder-name">Documents</span>
                  <div className="folder-actions">
                    <button className="action-btn">⋯</button>
                  </div>
                </div>
                <div className="folder-item nested">
                  <div className="sidebar-icon folder-icon"></div>
                  <span className="folder-name">Research</span>
                </div>
                <div className="folder-item">
                  <div className="sidebar-icon folder-icon"></div>
                  <span className="folder-name">Projects</span>
                  <div className="folder-actions">
                    <button className="action-btn">⋯</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      case 'web':
        return (
          <div className="section-content">
            <div className="section-header">
              <h4>Web Resources</h4>
              <div className="header-actions">
                <button className="section-button secondary">Add URL</button>
              </div>
            </div>
            <div className="section-body">
              <div className="web-resources">
                <div className="web-item">
                  <div className="sidebar-icon globe-icon"></div>
                  <div className="web-info">
                    <span className="web-title">Documentation Hub</span>
                    <span className="web-url">docs.example.com</span>
                  </div>
                  <div className="web-actions">
                    <button className="action-btn">⋯</button>
                  </div>
                </div>
                <div className="web-item">
                  <div className="sidebar-icon globe-icon"></div>
                  <div className="web-info">
                    <span className="web-title">API Reference</span>
                    <span className="web-url">api.service.com</span>
                  </div>
                  <div className="web-actions">
                    <button className="action-btn">⋯</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      default:
        return (
          <div className="section-content">
            <div className="section-header">
              <h4>Knowledge Management</h4>
            </div>
            <div className="section-body">
              <p>Select a category from the sidebar to get started.</p>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="knowledge-section">
      {renderActiveSubsection()}
    </div>
  );
};

export default KnowledgeSection;