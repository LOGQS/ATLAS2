import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { performanceTracker } from '../../utils/core/performanceTracker';
import { BrowserStorage, MessageGenerationStats } from '../../utils/storage/BrowserStorage';
import '../../styles/message/MessageInfoOverlay.css';

interface MessageInfoOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  messageId: string;
  messageClientId?: string;
  chatId?: string;
  messageContent: string;
  timestamp?: string;
  provider?: string;
  model?: string;
  routerDecision?: {
    route: string;
    available_routes: any[];
    selected_model: string | null;
  } | null;
  isAssistant: boolean;
}

const formatTimestamp = (timestamp?: string): string | null => {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
};

const roundNumber = (value: number, fractionDigits: number = 2): string => {
  return value.toFixed(fractionDigits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

const MessageInfoOverlay: React.FC<MessageInfoOverlayProps> = ({
  isOpen,
  onClose,
  messageId,
  messageClientId,
  chatId,
  messageContent,
  timestamp,
  provider,
  model,
  routerDecision,
  isAssistant,
}) => {
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const [storedStats, setStoredStats] = useState<MessageGenerationStats | null>(null);

  const loadStoredStats = useCallback(() => {
    if (!chatId) {
      return null;
    }
    const candidateKeys = [messageId, messageClientId].filter(Boolean) as string[];

    for (const key of candidateKeys) {
      const record = BrowserStorage.getMessageStats(chatId, key);
      if (record) {
        return record;
      }
    }
    return null;
  }, [chatId, messageId, messageClientId]);

  const refreshStoredStats = useCallback(() => {
    const next = loadStoredStats();
    setStoredStats(prev => {
      if (!prev && !next) {
        return prev;
      }
      if (
        prev &&
        next &&
        prev.messageId === next.messageId &&
        prev.totalTimeMs === next.totalTimeMs &&
        prev.streamingTimeMs === next.streamingTimeMs &&
        prev.firstTokenMs === next.firstTokenMs &&
        prev.recordedAt === next.recordedAt &&
        prev.source === next.source
      ) {
        return prev;
      }
      return next;
    });
  }, [loadStoredStats]);

  useEffect(() => {
    refreshStoredStats();
  }, [refreshStoredStats]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    refreshStoredStats();
  }, [isOpen, refreshStoredStats]);

  useEffect(() => {
    if (!isOpen || !chatId || typeof window === 'undefined') {
      return;
    }

    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        chatId?: string;
        key?: string | null;
        messageId?: string | null;
      } | undefined;
      if (!detail || detail.chatId !== chatId) {
        return;
      }

      const watchedKeys = new Set([messageId, messageClientId].filter(Boolean) as string[]);
      if (detail.key && !watchedKeys.has(detail.key) && detail.messageId && !watchedKeys.has(detail.messageId)) {
        return;
      }

      refreshStoredStats();
    };

    window.addEventListener('messageStatsUpdated', handleUpdate as EventListener);
    return () => {
      window.removeEventListener('messageStatsUpdated', handleUpdate as EventListener);
    };
  }, [isOpen, chatId, messageId, messageClientId, refreshStoredStats]);

  const trackerMetrics = useMemo(() => {
    if (!isOpen) return null;
    const candidateKeys = [messageClientId, chatId, messageId].filter(Boolean) as string[];
    for (const key of candidateKeys) {
      const metrics = performanceTracker.getMetrics(key);
      if (metrics) {
        return metrics;
      }
    }
    return null;
  }, [isOpen, messageClientId, messageId, chatId]);

  const trackerFirstStream = trackerMetrics?.timestamps?.[performanceTracker.MARKS.FIRST_STREAM_EVENT];
  const trackerResponding = trackerMetrics?.timestamps?.[performanceTracker.MARKS.STREAM_RESPONDING];
  const trackerComplete = trackerMetrics?.timestamps?.[performanceTracker.MARKS.STREAM_COMPLETE];

  let trackerStreamingMs: number | null = null;
  if (typeof trackerComplete === 'number') {
    const startPoint = typeof trackerResponding === 'number'
      ? trackerResponding
      : (typeof trackerFirstStream === 'number' ? trackerFirstStream : null);
    if (typeof startPoint === 'number') {
      const diff = trackerComplete - startPoint;
      trackerStreamingMs = diff >= 0 ? diff : null;
    }
  }

  if (!isOpen || !isAssistant) {
    return null;
  }

  const resolvePhaseDurationMs = (phaseName: string): number | null => {
    const storedValue = storedStats?.phaseDurations?.[phaseName];
    if (typeof storedValue === 'number' && !Number.isNaN(storedValue)) {
      return storedValue;
    }

    const trackerPhase = trackerMetrics?.phases?.find(phase => phase.name === phaseName);
    if (trackerPhase && typeof trackerPhase.duration === 'number' && !Number.isNaN(trackerPhase.duration)) {
      return trackerPhase.duration;
    }

    return null;
  };

  const marksSource = storedStats?.performanceMarks ?? trackerMetrics?.timestamps;
  const markValue = (mark: string): number | null => {
    if (!marksSource) {
      return null;
    }
    const value = marksSource[mark];
    return typeof value === 'number' && !Number.isNaN(value) ? value : null;
  };

  const streamingPhaseMs = resolvePhaseDurationMs('Streaming');
  const trackerTotalTime = trackerMetrics && Number.isFinite(trackerMetrics.totalTime)
    ? trackerMetrics.totalTime
    : null;
  const totalTimeMs = storedStats?.totalTimeMs ?? trackerTotalTime;


  let streamingTimeMs = storedStats?.streamingTimeMs
    ?? (typeof streamingPhaseMs === 'number' ? streamingPhaseMs : null)
    ?? trackerStreamingMs;

  if (streamingTimeMs == null) {
    const complete = markValue(performanceTracker.MARKS.STREAM_COMPLETE);
    const responding = markValue(performanceTracker.MARKS.STREAM_RESPONDING);
    const firstStream = markValue(performanceTracker.MARKS.FIRST_STREAM_EVENT);
    const startPoint = responding ?? firstStream;
    if (complete != null && startPoint != null) {
      const duration = complete - startPoint;
      streamingTimeMs = duration >= 0 ? duration : null;
    }
  }



  const apiResponseMs = resolvePhaseDurationMs('API Response Time')
    ?? (() => {
      const start = markValue(performanceTracker.MARKS.API_CALL_START);
      const firstToken = markValue(performanceTracker.MARKS.FIRST_STREAM_EVENT);
      if (start != null && firstToken != null) {
        const diff = firstToken - start;
        return diff >= 0 ? diff : null;
      }
      return null;
    })();

  const durationSeconds = totalTimeMs != null ? totalTimeMs / 1000 : null;
  const streamingSeconds = streamingTimeMs != null ? streamingTimeMs / 1000 : null;
  const apiResponseSeconds = apiResponseMs != null ? apiResponseMs / 1000 : null;

  const estimatedTokens = Math.max(1, Math.ceil(messageContent.trim().length / 4));
  const characterCount = messageContent.length;
  const wordCount = messageContent.trim() ? messageContent.trim().split(/\s+/).length : 0;

  const tokensPerSecondStream = streamingSeconds && streamingSeconds > 0
    ? estimatedTokens / streamingSeconds
    : null;

  const tokensPerSecondOverall = durationSeconds && durationSeconds > 0
    ? estimatedTokens / durationSeconds
    : null;

  const displayedModel = model || routerDecision?.selected_model || null;
  const displayedRoute = routerDecision?.route || null;
  const formattedTimestamp = formatTimestamp(storedStats?.messageTimestamp ?? timestamp);

  const overlayContent = (
    <div className="message-info-overlay-root" role="dialog" aria-modal="true" aria-labelledby={`message-info-${messageId}`}>
      <div className="message-info-overlay-backdrop" onClick={onClose} />
      <div className="message-info-overlay" role="document">
        <header className="message-info-header">
          <h2 id={`message-info-${messageId}`}>Response details</h2>
          <button type="button" className="message-info-close" onClick={onClose} aria-label="Close message details">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </header>

        <section className="message-info-section">
          <h3>Generation</h3>
          <dl>
            {displayedModel && (
              <div className="message-info-row">
                <dt>Model</dt>
                <dd>{displayedModel}</dd>
              </div>
            )}
            {provider && (
              <div className="message-info-row">
                <dt>Provider</dt>
                <dd>{provider}</dd>
              </div>
            )}
            {displayedRoute && (
              <div className="message-info-row">
                <dt>Route</dt>
                <dd>{displayedRoute}</dd>
              </div>
            )}
            <div className="message-info-row">
              <dt>API response time</dt>
              <dd>{apiResponseSeconds !== null ? roundNumber(apiResponseSeconds, 2) + 's' : 'N/A'}</dd>
            </div>
            {streamingSeconds !== null && (
              <div className="message-info-row">
                <dt>Streaming time</dt>
                <dd>{roundNumber(streamingSeconds, 2)}s</dd>
              </div>
            )}
            {durationSeconds !== null && (
              <div className="message-info-row">
                <dt>Total generation time</dt>
                <dd>{roundNumber(durationSeconds, 2)}s</dd>
              </div>
            )}
            {tokensPerSecondStream !== null && (
              <div className="message-info-row">
                <dt>~Tokens/sec (stream)</dt>
                <dd>{roundNumber(tokensPerSecondStream, 2)}</dd>
              </div>
            )}
            {tokensPerSecondOverall !== null && (
              <div className="message-info-row">
                <dt>~Tokens/sec (overall)</dt>
                <dd>{roundNumber(tokensPerSecondOverall, 2)}</dd>
              </div>
            )}
          </dl>
        </section>

        <section className="message-info-section">
          <h3>Content</h3>
          <dl>
            {formattedTimestamp && (
              <div className="message-info-row">
                <dt>Timestamp</dt>
                <dd>{formattedTimestamp}</dd>
              </div>
            )}
            <div className="message-info-row">
              <dt>Characters</dt>
              <dd>{characterCount}</dd>
            </div>
            <div className="message-info-row">
              <dt>Words</dt>
              <dd>{wordCount}</dd>
            </div>
            <div className="message-info-row">
              <dt>~Tokens</dt>
              <dd>{estimatedTokens}</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );

  return ReactDOM.createPortal(overlayContent, document.body);
};

export default MessageInfoOverlay;
