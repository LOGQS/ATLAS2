import { FC } from 'react';
import { Creation } from '../utils/creationsHelper';
import CreationIndicator from './CreationIndicator';

interface CreationIndicatorsProps {
  creations: Creation[];
  onCreationClick?: (creation: Creation) => void;
  isStreaming?: boolean;
  className?: string;
}

const CreationIndicators: FC<CreationIndicatorsProps> = ({ 
  creations, 
  onCreationClick, 
  isStreaming = false, 
  className = '' 
}) => {
  if (!creations || creations.length === 0) {
    return null;
  }

  return (
    <div className={`creation-indicators ${isStreaming ? 'streaming-creation-container' : ''} ${className}`}>
      {creations.map((creation, index) => (
        <CreationIndicator
          key={creation.id || `creation-indicator-${index}`}
          creation={creation}
          onClick={onCreationClick}
          isStreaming={isStreaming}
        />
      ))}
    </div>
  );
};

export default CreationIndicators; 