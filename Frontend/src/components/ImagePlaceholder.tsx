import React from 'react';
import '../styles/CreationIndicator.css';

const ImagePlaceholder: React.FC = () => (
  <div className="creation-indicator-box placeholder-image">
    <div className="creation-indicator-icon">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
        <path d="M4 3a2 2 0 00-2 2v14a2 2 0 002 2h16a2 2 0 002-2V5a2 2 0 00-2-2H4zm0 2h16v14H4V5zm3 4a2 2 0 11-.001 3.999A2 2 0 017 9zm10 8H7l3.5-4.5 2.5 3 3.5-4.5L21 17z" />
      </svg>
    </div>
    <div className="streaming-wave" />
  </div>
);

export default ImagePlaceholder;
