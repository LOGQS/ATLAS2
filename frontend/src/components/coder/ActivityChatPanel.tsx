import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Icons } from '../ui/Icons';
import { ExecutionActivityFeed } from './ExecutionActivityFeed';
import { PlanViewer } from './PlanViewer';
import { PlanOverlay } from './PlanOverlay';
import { CheckpointTimeline } from './CheckpointTimeline';
import { ContextPanel } from './ContextPanel';
import { TimelinePanel } from './TimelinePanel';
import {
  LearningModeToggle,
  ConstraintsPanel,
  LearnedPatternsSection,
  MemoryProposalBar
} from './MockFeatureSections';
import type { DomainExecution } from '../../types/messages';
import type { CoderStreamSegment } from '../../utils/chat/LiveStore';
import useScrollControl from '../../hooks/ui/useScrollControl';
import logger from '../../utils/core/logger';
import '../../styles/coder/ActivityChatPanel.css';

interface ActivityChatPanelProps {
  chatId?: string;
  currentPlan?: any;
  checkpoints?: any[];
  pendingDiffsCount?: number;
  onAcceptAllDiffs?: () => void;
  onRejectAllDiffs?: () => void;
  domainExecution?: DomainExecution | null;
  isProcessing?: boolean;
  autoAcceptEnabled?: boolean;
  coderStream?: CoderStreamSegment[];
}

export const ActivityChatPanel: React.FC<ActivityChatPanelProps> = ({
  chatId,
  currentPlan,
  checkpoints = [],
  pendingDiffsCount = 0,
  onAcceptAllDiffs,
  onRejectAllDiffs,
  domainExecution,
  isProcessing = false,
  autoAcceptEnabled = false,
  coderStream = [],
}) => {
  const [activeTab, setActiveTab] = useState<'activity' | 'plan' | 'checkpoints' | 'context' | 'timeline' | 'learn' | 'constraints' | 'patterns'>('activity');
  const [message, setMessage] = useState('');
  const [showScrollButton, setShowScrollButton] = useState(false);
  const activityFeedRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);

  // Determine streaming state based on isProcessing and active stream segments
  const streamingState: 'thinking' | 'responding' | 'static' = useMemo(() => {
    if (!isProcessing) return 'static';
    // If we have any streaming segments, we're responding
    const hasStreamingSegments = coderStream.some(seg => seg.status === 'streaming');
    return hasStreamingSegments ? 'responding' : 'thinking';
  }, [isProcessing, coderStream]);

  const scrollControl = useScrollControl({
    chatId: `activity-chat-${chatId}`,
    streamingState,
    containerRef: activityFeedRef,
    scrollType: 'activity-chat'
  });

  const { isStreaming: scrollControlStreaming, isAutoScrollEnabled: scrollControlEnabled } = scrollControl;

  const handleSendMessage = async () => {
    if (!message.trim() || !chatId) return;

    // Send message to backend chat API
    try {
      logger.info('[ACTIVITY_CHAT] Sending message from IDE', { chatId, message: message.trim() });

      // TODO: Integrate with actual chat API to send additional user instructions
      // This would trigger a new execution cycle with the user's message
      // const response = await fetch(apiUrl('/api/chat/message'), {
      //   method: 'POST',
      //   body: JSON.stringify({ chat_id: chatId, message: message.trim() })
      // });

      setMessage('');
    } catch (error) {
      logger.error('[ACTIVITY_CHAT] Failed to send message', error);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleAttachment = () => {
    // TODO: Implement file attachment
    logger.info('[ACTIVITY_CHAT] Attachment clicked');
  };

  const handleScrollToBottom = useCallback(() => {
    scrollControl.forceScrollToBottom();
  }, [scrollControl]);

  // Show/hide scroll button based on autoscroll state
  useEffect(() => {
    if (activeTab === 'activity' && scrollControlStreaming) {
      setShowScrollButton(!scrollControlEnabled);
    } else {
      setShowScrollButton(false);
    }
  }, [activeTab, scrollControlStreaming, scrollControlEnabled]);

  return (
    <div className="activity-chat-panel">
      {/* Tab Navigation */}
      <div className="activity-chat-panel__tabs">
        <button
          className={`activity-chat-panel__tab ${activeTab === 'activity' ? 'activity-chat-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('activity')}
        >
          <Icons.Activity className="w-4 h-4" />
          <span>Activity & Chat</span>
        </button>
        <button
          className={`activity-chat-panel__tab ${activeTab === 'plan' ? 'activity-chat-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('plan')}
        >
          <Icons.List className="w-4 h-4" />
          <span>Plan</span>
        </button>
        <button
          className={`activity-chat-panel__tab ${activeTab === 'checkpoints' ? 'activity-chat-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('checkpoints')}
        >
          <Icons.History className="w-4 h-4" />
          <span>Checkpoints</span>
        </button>
        <button
          className={`activity-chat-panel__tab ${activeTab === 'context' ? 'activity-chat-panel__tab--active' : ''} activity-chat-panel__tab--disabled`}
          onClick={() => setActiveTab('context')}
          title="Coming Soon"
        >
          <Icons.FileCode className="w-4 h-4" />
          <span>Context</span>
        </button>
        <button
          className={`activity-chat-panel__tab ${activeTab === 'timeline' ? 'activity-chat-panel__tab--active' : ''} activity-chat-panel__tab--disabled`}
          onClick={() => setActiveTab('timeline')}
          title="Coming Soon"
        >
          <Icons.Clock className="w-4 h-4" />
          <span>Timeline</span>
        </button>
      </div>

      {/* Memory Proposal Bar - Mock Feature */}
      <MemoryProposalBar visible={false} />

      {/* Tab Content */}
      <div className="activity-chat-panel__content">
        {activeTab === 'activity' && (
          <>
            <div className="activity-chat-panel__feed" ref={activityFeedRef}>
              {/* Bulk Diff Actions */}
              {pendingDiffsCount > 0 && (
                <div className="activity-chat-panel__diff-actions">
                  <div className="activity-chat-panel__diff-count">
                    <Icons.Edit className="w-4 h-4" />
                    <span>{pendingDiffsCount} pending change{pendingDiffsCount !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="activity-chat-panel__diff-buttons">
                    <button
                      className="activity-chat-panel__diff-button activity-chat-panel__diff-button--accept"
                      onClick={onAcceptAllDiffs}
                      title="Accept all pending changes"
                    >
                      <Icons.Check className="w-4 h-4" />
                      <span>Accept All</span>
                    </button>
                    <button
                      className="activity-chat-panel__diff-button activity-chat-panel__diff-button--reject"
                      onClick={onRejectAllDiffs}
                      title="Reject all pending changes"
                    >
                      <Icons.Close className="w-4 h-4" />
                      <span>Reject All</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Execution Activity Feed - Real-time execution display */}
              <ExecutionActivityFeed
                domainExecution={domainExecution ?? null}
                isProcessing={isProcessing}
                chatId={chatId}
                autoAcceptEnabled={autoAcceptEnabled}
                coderStream={coderStream}
              />
            </div>

            {/* Persistent Plan Overlay - Shows current plan without blocking chat */}
            <PlanOverlay plan={domainExecution?.plan} />
          </>
        )}

        {activeTab === 'plan' && (
          <div className="activity-chat-panel__tab-content-wrapper">
            <PlanViewer plan={currentPlan} />
          </div>
        )}

        {activeTab === 'checkpoints' && (
          <div className="activity-chat-panel__tab-content-wrapper">
            <CheckpointTimeline checkpoints={checkpoints} />
          </div>
        )}

        {activeTab === 'context' && (
          <div className="activity-chat-panel__tab-content-wrapper">
            <ContextPanel />
          </div>
        )}

        {activeTab === 'timeline' && (
          <div className="activity-chat-panel__tab-content-wrapper">
            <TimelinePanel />
          </div>
        )}

        {activeTab === 'learn' && (
          <div className="activity-chat-panel__tab-content-wrapper">
            <LearningModeToggle />
            <div style={{ padding: '16px', color: 'rgba(212, 212, 212, 0.6)', fontSize: '14px' }}>
              Learning mode will provide detailed explanations for each code change and execution step.
            </div>
          </div>
        )}

        {activeTab === 'constraints' && (
          <div className="activity-chat-panel__tab-content-wrapper">
            <ConstraintsPanel />
          </div>
        )}

        {activeTab === 'patterns' && (
          <div className="activity-chat-panel__tab-content-wrapper">
            <LearnedPatternsSection />
          </div>
        )}
      </div>

      {/* Message Input - Only shown in activity tab */}
      {activeTab === 'activity' && (
        <div className="activity-chat-panel__input">
          <div className="activity-chat-panel__input-wrapper">
            <button
              className="activity-chat-panel__input-button activity-chat-panel__attach-button"
              onClick={handleAttachment}
              title="Attach file"
            >
              <Icons.Paperclip className="w-4 h-4" />
            </button>
            <textarea
              ref={messageInputRef}
              className="activity-chat-panel__message-textarea"
              placeholder="Send a message..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <button
              className={`activity-chat-panel__input-button activity-chat-panel__send-button ${!message.trim() ? 'activity-chat-panel__send-button--disabled' : ''}`}
              onClick={handleSendMessage}
              disabled={!message.trim()}
              title="Send message (Enter)"
            >
              <Icons.Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Scroll to bottom button */}
      {showScrollButton && (
        <button
          className="activity-chat-panel__scroll-button"
          onClick={handleScrollToBottom}
          aria-label="Scroll to bottom"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M10 3L10 14M10 14L6 10M10 14L14 10"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M4 17L16 17"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
};
