import React, { useState } from 'react';
import '../styles/sections/GalleryWindow.css';

interface MediaItem {
  id: number;
  name: string;
  type: 'image' | 'video' | 'document';
  thumbnail?: string;
  size: string;
  date: string;
}

const GalleryWindow: React.FC = () => {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [filterType, setFilterType] = useState<'all' | 'image' | 'video' | 'document'>('all');
  
  // Mock data
  const mediaItems: MediaItem[] = [
    { id: 1, name: 'screenshot-1.png', type: 'image', size: '1.2 MB', date: '2024-01-15' },
    { id: 2, name: 'project-demo.mp4', type: 'video', size: '15.8 MB', date: '2024-01-14' },
    { id: 3, name: 'report.pdf', type: 'document', size: '2.4 MB', date: '2024-01-13' },
    { id: 4, name: 'design-mockup.png', type: 'image', size: '3.1 MB', date: '2024-01-12' },
    { id: 5, name: 'presentation.pptx', type: 'document', size: '8.7 MB', date: '2024-01-11' },
    { id: 6, name: 'tutorial-video.mp4', type: 'video', size: '22.3 MB', date: '2024-01-10' },
  ];

  const filteredItems = filterType === 'all' 
    ? mediaItems 
    : mediaItems.filter(item => item.type === filterType);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'image': return '<�';
      case 'video': return '<�';
      case 'document': return '=�';
      default: return '=�';
    }
  };

  return (
    <div className="section-content">
      <div className="section-header">
        <h4>Media Gallery</h4>
        <div className="header-actions">
          <div className="filter-tabs">
            <button 
              className={`filter-tab ${filterType === 'all' ? 'active' : ''}`}
              onClick={() => setFilterType('all')}
            >
              All
            </button>
            <button 
              className={`filter-tab ${filterType === 'image' ? 'active' : ''}`}
              onClick={() => setFilterType('image')}
            >
              Images
            </button>
            <button 
              className={`filter-tab ${filterType === 'video' ? 'active' : ''}`}
              onClick={() => setFilterType('video')}
            >
              Videos
            </button>
            <button 
              className={`filter-tab ${filterType === 'document' ? 'active' : ''}`}
              onClick={() => setFilterType('document')}
            >
              Docs
            </button>
          </div>
          <div className="view-controls">
            <button 
              className={`view-toggle ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
            >
              �
            </button>
            <button 
              className={`view-toggle ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
            >
              0
            </button>
          </div>
        </div>
      </div>
      <div className="section-body">
        {filteredItems.length > 0 ? (
          <div className={`media-container ${viewMode}`}>
            {filteredItems.map(item => (
              <div key={item.id} className="media-item">
                <div className="media-thumbnail">
                  <div className="media-icon">{getTypeIcon(item.type)}</div>
                  {item.type === 'image' && <div className="image-preview"></div>}
                </div>
                <div className="media-info">
                  <div className="media-name">{item.name}</div>
                  <div className="media-meta">
                    <span className="media-size">{item.size}</span>
                    <span className="media-date">{item.date}</span>
                  </div>
                </div>
                <div className="media-actions">
                  <button className="action-btn small">View</button>
                  <button className="action-btn small">"""</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon gallery-icon"></div>
            <p>No {filterType === 'all' ? 'media files' : `${filterType}s`} found</p>
            <button className="section-button primary">Upload Files</button>
          </div>
        )}
      </div>
    </div>
  );
};

export default GalleryWindow;