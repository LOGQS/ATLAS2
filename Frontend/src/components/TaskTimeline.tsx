import React from 'react';

interface TaskStep {
  id: string;
  title: string;
  status: 'planned' | 'in-progress' | 'completed' | 'error';
}

interface TaskTimelineProps {
  steps: TaskStep[];
  currentStepIndex: number;
  onStepChange: (index: number) => void;
}

const TaskTimeline: React.FC<TaskTimelineProps> = ({
  steps,
  currentStepIndex,
  onStepChange
}) => {
  // Safety check
  if (!steps || steps.length === 0) {
    return null;
  }

  return (
    <div className="task-timeline-component">
      <h4 className="timeline-heading">Timeline Progress</h4>
      
      <div className="task-timeline-slider-container">
        <input 
          type="range" 
          min="0" 
          max={steps.length - 1} 
          value={currentStepIndex} 
          onChange={(e) => onStepChange(parseInt(e.target.value))}
          className="task-timeline-slider"
          aria-label="Timeline Progress"
        />
        
        <div className="task-timeline-markers">
          {steps.map((step, index) => (
            <div 
              key={`marker-${step.id}`} 
              className={`task-timeline-marker ${step.status} ${index === currentStepIndex ? 'active' : ''}`}
              style={{ left: `${(index / (steps.length - 1)) * 100}%` }}
              onClick={() => onStepChange(index)}
              title={step.title}
            >
              <div className="marker-tooltip">{step.title}</div>
            </div>
          ))}
        </div>
      </div>
      
      <div className="timeline-controls">
        <button 
          className="timeline-nav-button"
          onClick={() => onStepChange(Math.max(0, currentStepIndex - 1))}
          disabled={currentStepIndex === 0}
        >
          Previous
        </button>
        <span className="timeline-step-indicator">
          Step {currentStepIndex + 1} of {steps.length}
        </span>
        <button 
          className="timeline-nav-button"
          onClick={() => onStepChange(Math.min(steps.length - 1, currentStepIndex + 1))}
          disabled={currentStepIndex === steps.length - 1}
        >
          Next
        </button>
      </div>
    </div>
  );
};

export default TaskTimeline; 