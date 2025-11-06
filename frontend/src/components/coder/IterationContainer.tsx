import React, { useState, useCallback, useEffect } from 'react';
import { Icons } from '../ui/Icons';
import '../../styles/coder/IterationContainer.css';

interface IterationContainerProps {
  iterationNumber: number;
  isCurrentIteration: boolean;
  status: 'streaming' | 'waiting_user' | 'executing' | 'completed';
  summary?: string;
  children: React.ReactNode;
}

export const IterationContainer: React.FC<IterationContainerProps> = ({
  iterationNumber,
  isCurrentIteration,
  status,
  summary,
  children,
}) => {
  // Current iteration starts expanded, but all iterations can be toggled
  const [isExpanded, setIsExpanded] = useState(isCurrentIteration);

  // Auto-expand current iteration, auto-collapse when it stops being current
  useEffect(() => {
    setIsExpanded(isCurrentIteration);
  }, [isCurrentIteration]);

  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);

  const getStatusIcon = () => {
    switch (status) {
      case 'streaming':
        return <Icons.Activity className="w-4 h-4 text-blue-400 animate-spin" />;
      case 'waiting_user':
        return <Icons.Clock className="w-4 h-4 text-amber-400" />;
      case 'executing':
        return <Icons.Activity className="w-4 h-4 text-sky-400 animate-spin" />;
      case 'completed':
        return <Icons.Check className="w-4 h-4 text-green-400" />;
      default:
        return <Icons.Activity className="w-4 h-4 text-gray-400" />;
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'streaming':
        return 'Streaming';
      case 'waiting_user':
        return 'Awaiting decision';
      case 'executing':
        return 'Executing tools';
      case 'completed':
        return 'Completed';
      default:
        return '';
    }
  };

  // All iterations can be collapsed/expanded, including current one
  return (
    <div className={`iteration-container ${isCurrentIteration ? 'iteration-container--current' : ''}`}>
      <div
        className="iteration-container__header iteration-container__header--clickable"
        onClick={toggleExpanded}
      >
        <div className="iteration-container__header-left">
          {getStatusIcon()}
          <span className="iteration-container__title">
            Iteration {iterationNumber}
            {isCurrentIteration && <span className="iteration-container__badge">Current</span>}
          </span>
          {!isExpanded && summary && (
            <span className="iteration-container__summary">{summary}</span>
          )}
        </div>
        <div className="iteration-container__header-right">
          {status !== 'completed' && (
            <span className="iteration-container__status">{getStatusText()}</span>
          )}
          <Icons.ChevronRight
            className={`iteration-container__chevron ${isExpanded ? 'iteration-container__chevron--expanded' : ''}`}
          />
        </div>
      </div>

      <div className={`iteration-container__content ${!isExpanded ? 'iteration-container__content--collapsed' : ''}`}>
        {children}
      </div>
    </div>
  );
};
