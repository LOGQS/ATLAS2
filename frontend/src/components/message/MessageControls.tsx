import React, { useState, useCallback, useRef } from 'react';
import '../../styles/message/MessageControls.css';
import logger from '../../utils/core/logger';

interface MessageControlsProps {
  messageId: string;
  messageContent: string;
  messageRole: 'user' | 'assistant';
  isVisible: boolean;
  onCopy?: (content: string) => void;
  onTTSToggle?: (messageId: string, enabled: boolean) => void;
  onRetry?: (messageId: string) => void;
  onEdit?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  isTTSEnabled?: boolean;
  isTTSPlaying?: boolean;
  isTTSSupported?: boolean;
}

const MessageControls: React.FC<MessageControlsProps> = ({
  messageId,
  messageContent,
  messageRole,
  isVisible,
  onCopy,
  onTTSToggle,
  onRetry,
  onEdit,
  onDelete,
  isTTSEnabled = false,
  isTTSPlaying = false,
  isTTSSupported = true
}) => {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(messageContent);
      onCopy?.(messageContent);
      setCopyStatus('copied');
      
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      
      timeoutRef.current = setTimeout(() => {
        setCopyStatus('idle');
      }, 1500);
    } catch (error) {
      console.error('Failed to copy message:', error);
    }
  }, [messageContent, onCopy]);

  const handleTTSToggle = useCallback(() => {
    if (isTTSEnabled && isTTSPlaying) {
      onTTSToggle?.(messageId, false);
    } else {
      onTTSToggle?.(messageId, true);
    }
  }, [messageId, isTTSEnabled, isTTSPlaying, onTTSToggle]);

  const handleRetry = useCallback(() => {
    onRetry?.(messageId);
  }, [messageId, onRetry]);

  const handleEdit = useCallback(() => {
    onEdit?.(messageId);
  }, [messageId, onEdit]);

  const handleDelete = useCallback(() => {
    logger.info(`[MessageControls] Delete clicked for messageId: ${messageId}, role: ${messageRole}`);
    onDelete?.(messageId);
  }, [messageId, onDelete, messageRole]);

  return (
    <div className={`message-controls ${isVisible ? 'visible' : 'hidden'}`}>
      <div className="message-controls-left">
        <button
          className={`message-control-btn message-copy-btn ${copyStatus === 'copied' ? 'copied' : ''}`}
          onClick={handleCopy}
          title="Copy message"
          aria-label="Copy message"
        >
          {copyStatus === 'copied' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="20,6 9,17 4,12"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5,15H4a2,2 0,0 1,-2,-2V4A2,2 0,0 1,4,2H15a2,2 0,0 1,2,2v1"/>
            </svg>
          )}
        </button>

        <button
          className={`message-control-btn message-tts-btn ${isTTSEnabled ? 'enabled' : ''} ${isTTSPlaying ? 'playing' : ''}`}
          onClick={handleTTSToggle}
          disabled={!isTTSSupported}
          title={
            !isTTSSupported 
              ? 'Text-to-speech not supported in this browser'
              : (isTTSEnabled && isTTSPlaying ? 'Stop TTS' : 'Start TTS')
          }
          aria-label={
            !isTTSSupported
              ? 'Text-to-speech not supported in this browser' 
              : (isTTSEnabled && isTTSPlaying ? 'Stop text to speech' : 'Start text to speech')
          }
        >
          {isTTSPlaying ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="6" y="4" width="4" height="16"/>
              <rect x="14" y="4" width="4" height="16"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/>
              <path d="M19.07,4.93a10,10 0,0 1,0,14.14M15.54,8.46a5,5 0,0 1,0,7.07"/>
            </svg>
          )}
        </button>
      </div>

      <div className="message-controls-right">
        <button
          className="message-control-btn message-retry-btn"
          onClick={handleRetry}
          title="Retry message"
          aria-label="Retry message"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23,4 23,10 17,10"/>
            <path d="M20.49,15a9,9 0,1 1-2.12-9.36L23,10"/>
          </svg>
        </button>

        <button
          className="message-control-btn message-edit-btn"
          onClick={handleEdit}
          title="Edit message"
          aria-label="Edit message"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11,4H4A2,2 0,0 0,2,6V20a2,2 0,0 0,2,2H16a2,2 0,0 0,2-2V13"/>
            <path d="M18.5,2.5a2.121,2.121 0,0 1,3,3L12,15l-4,1L9,12Z"/>
          </svg>
        </button>

        <button
          className="message-control-btn message-delete-btn"
          onClick={handleDelete}
          title="Delete message"
          aria-label="Delete message"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3,6 5,6 21,6"/>
            <path d="M19,6v14a2,2 0,0 1-2,2H7a2,2 0,0 1-2-2V6M8,6V4a2,2 0,0 1,2-2h4a2,2 0,0 1,2,2v2"/>
          </svg>
        </button>
      </div>
    </div>
  );
};

export default MessageControls;