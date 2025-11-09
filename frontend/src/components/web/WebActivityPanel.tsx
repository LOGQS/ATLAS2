import React from 'react';
import { useWebContext } from '../../contexts/WebContext';
import { Icons } from '../ui/Icons';

export const WebActivityPanel: React.FC = () => {
  const { activities, agentStatus } = useWebContext();

  const getStatusColor = () => {
    switch (agentStatus) {
      case 'researching':
        return 'text-green-400';
      case 'navigating':
        return 'text-cyan-400';
      case 'analyzing':
        return 'text-purple-400';
      default:
        return 'text-gray-400';
    }
  };

  const getStatusText = () => {
    switch (agentStatus) {
      case 'researching':
        return 'Researching';
      case 'navigating':
        return 'Navigating';
      case 'analyzing':
        return 'Analyzing';
      default:
        return 'Idle';
    }
  };

  const getActivityIcon = (type: string, iconName: string) => {
    // Map icon names to Icons components
    const iconMap: Record<string, any> = {
      'check_circle': Icons.CheckCircle,
      'search': Icons.Search,
      'link': Icons.Link,
      'hub': Icons.Network,
    };

    const IconComponent = iconMap[iconName] || Icons.Circle;
    return <IconComponent className="w-5 h-5" />;
  };

  return (
    <aside className="web-activity-panel">
      <div className="web-activity-panel__header">
        <h3 className="web-activity-panel__title">Activity Timeline</h3>
      </div>

      <div className="web-activity-panel__timeline">
        {activities.length === 0 ? (
          <div className="web-activity-panel__empty">
            <p className="text-gray-400 text-sm">No activities yet</p>
          </div>
        ) : (
          <div className="space-y-6">
            {activities.map((activity) => (
              <div key={activity.id} className="flex items-start gap-4">
                <div className={`flex-shrink-0 mt-1 ${activity.color}`}>
                  {getActivityIcon(activity.type, activity.icon)}
                </div>
                <div className="flex-1">
                  <p className="text-white text-sm font-medium">{activity.title}</p>
                  {activity.description && (
                    <p className="text-gray-400 text-sm mt-1">{activity.description}</p>
                  )}
                  <p className="text-gray-600 text-xs mt-1">{activity.timestamp}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="web-activity-panel__footer">
        <div className="flex items-center gap-2 mb-4">
          <div className={`w-2.5 h-2.5 rounded-full ${agentStatus === 'idle' ? 'bg-gray-400' : 'bg-green-400 animate-pulse'}`}></div>
          <p className={`text-sm font-medium ${getStatusColor()}`}>
            Agent Status: {getStatusText()}
          </p>
        </div>

        <div className="relative">
          <input
            type="text"
            className="web-activity-panel__input"
            placeholder="Chat with your research agent..."
          />
          <div className="absolute inset-y-0 right-2 flex items-center gap-1">
            <button className="p-2 rounded-lg text-white/70 hover:bg-white/10 hover:text-white transition-colors">
              <Icons.Send className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
};
