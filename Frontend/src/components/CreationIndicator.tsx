import { FC } from 'react';
import { Creation } from '../utils/creationsHelper';
import { getCreationIcon } from '../utils/creationIcons';
import '../styles/CreationIndicator.css';

interface CreationIndicatorProps {
  creation: Creation;
  onClick?: (creation: Creation) => void;
  isStreaming?: boolean;
  className?: string;
}

const CreationIndicator: FC<CreationIndicatorProps> = ({ 
  creation, 
  onClick, 
  isStreaming = false, 
  className = '' 
}) => {
  const handleClick = () => {
    if (onClick) {
      onClick(creation);
    }
  };

  return (
    <div 
      className={`creation-indicator-box ${isStreaming ? 'streaming' : ''} ${className}`}
      onClick={handleClick}
      title={creation.title || `${creation.type} creation`}
    >
      <div className="creation-indicator-icon">
        {getCreationIcon(creation.type)}
      </div>
      <span className="creation-indicator-type">
        {creation.type.charAt(0).toUpperCase() + creation.type.slice(1)}
      </span>
      {isStreaming && <div className="streaming-wave"></div>}
    </div>
  );
};

export default CreationIndicator; 