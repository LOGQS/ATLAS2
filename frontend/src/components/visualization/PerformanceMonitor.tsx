import React, { useState, useEffect } from 'react';
import '../../styles/visualization/PerformanceMonitor.css';
import { performanceTracker } from '../../utils/core/performanceTracker';
import type { PerformanceMetrics } from '../../utils/core/performanceTracker';
import ModalWindow from '../ui/ModalWindow';

interface PerformanceMonitorProps {
  activeChatId: string;
}

const PerformanceMonitor: React.FC<PerformanceMonitorProps> = ({ activeChatId }) => {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [allMetrics, setAllMetrics] = useState<PerformanceMetrics[]>([]);

  useEffect(() => {
    const unsubscribe = performanceTracker.subscribe((newMetrics) => {
      setMetrics(newMetrics);

      setAllMetrics(performanceTracker.getAllMetrics());
    });

    return unsubscribe;
  }, []);

  const handleWidgetClick = () => {
    setIsModalOpen(true);
    setAllMetrics(performanceTracker.getAllMetrics());
  };

  const handleModalClose = () => {
    setIsModalOpen(false);
    setShowHistory(false);
  };

  const handleHistoryToggle = () => {
    setShowHistory(!showHistory);
    if (!showHistory) {
      setAllMetrics(performanceTracker.getAllMetrics());
    }
  };

  const formatTime = (ms: number): string => {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const getPhaseColor = (phaseName: string): string => {
    const colors: { [key: string]: string } = {
      'Input Processing': '#3498db',     // Blue
      'Chat Creation': '#9b59b6',        // Purple
      'Component Mount': '#e74c3c',      // Red
      'API Response Time': '#f39c12',    // Orange
      'Streaming': '#27ae60',            // Green
      'Streaming (ongoing)': '#16a085',  // Teal
    };
    return colors[phaseName] || '#7f8c8d';
  };

  const renderTimeline = (m: PerformanceMetrics) => {
    const maxTime = m.totalTime;
    let currentPosition = 0;

    return (
      <div className="perf-timeline">
        {m.phases.map((phase, idx) => {
          const width = (phase.duration / maxTime) * 100;
          const left = currentPosition;
          currentPosition += width;

          return (
            <div
              key={idx}
              className="perf-timeline-segment"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: getPhaseColor(phase.name),
              }}
              title={`${phase.name}: ${formatTime(phase.duration)} (${phase.percentage.toFixed(1)}%)`}
            >
              <span className="perf-timeline-label">
                {phase.duration > 50 ? formatTime(phase.duration) : ''}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  const renderMetricsDetails = (m: PerformanceMetrics) => (
    <div className="perf-details">
      <div className="perf-summary">
        <div className="perf-total-time">
          Total: <strong>{formatTime(m.totalTime)}</strong>
        </div>
        <div className="perf-chat-info">
          Chat: {m.chatId.substring(0, 8)}...
        </div>
      </div>

      {renderTimeline(m)}

      <div className="perf-phases">
        {m.phases.map((phase, idx) => (
          <div key={idx} className="perf-phase">
            <span
              className="perf-phase-indicator"
              style={{ backgroundColor: getPhaseColor(phase.name) }}
            />
            <span className="perf-phase-name">{phase.name}</span>
            <span className="perf-phase-time">{formatTime(phase.duration)}</span>
            <span className="perf-phase-percent">{phase.percentage.toFixed(1)}%</span>
          </div>
        ))}
      </div>

      <div className="perf-timestamps">
        <div className="perf-timestamps-title">Timestamps:</div>
        {Object.entries(m.timestamps).map(([mark, time]) => (
          <div key={mark} className="perf-timestamp">
            <span className="perf-timestamp-mark">{mark}:</span>
            <span className="perf-timestamp-time">+{formatTime(time)}</span>
          </div>
        ))}
      </div>
    </div>
  );

  const currentMetrics = metrics && metrics.chatId === activeChatId ? metrics : null;

  return (
    <>
      <div className="perf-monitor-widget" onClick={handleWidgetClick}>
        <span className="perf-monitor-icon">⚡</span>
        {currentMetrics && (
          <span className="perf-monitor-time">
            {formatTime(currentMetrics.totalTime)}
          </span>
        )}
        {currentMetrics && (
          <div className="perf-monitor-mini-timeline">
            {renderTimeline(currentMetrics)}
          </div>
        )}
      </div>

      <ModalWindow
        isOpen={isModalOpen}
        onClose={handleModalClose}
        className="perf-monitor-modal"
      >
        <div className="perf-modal-header">
          <h2>Performance Monitor</h2>
          <button
            className="perf-history-toggle"
            onClick={handleHistoryToggle}
            title={showHistory ? "Show current" : "Show history"}
          >
            {showHistory ? "📈" : "📊"}
          </button>
        </div>

        <div className="perf-modal-content">
          {showHistory ? (
            <div className="perf-history">
              <div className="perf-history-title">Recent Messages</div>
              {allMetrics.length === 0 ? (
                <div className="perf-no-data">No performance data yet</div>
              ) : (
                allMetrics.slice(-5).reverse().map((m, idx) => (
                  <div key={idx} className="perf-history-item">
                    <div className="perf-history-header">
                      Message {allMetrics.length - idx}
                    </div>
                    {renderMetricsDetails(m)}
                  </div>
                ))
              )}
            </div>
          ) : currentMetrics ? (
            renderMetricsDetails(currentMetrics)
          ) : (
            <div className="perf-no-data">
              No active message being tracked
            </div>
          )}
        </div>
      </ModalWindow>
    </>
  );
};

export type { PerformanceMetrics };
export default PerformanceMonitor;