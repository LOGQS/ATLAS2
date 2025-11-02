import React from 'react';

interface SendButtonProps {
  onClick: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  isButtonHeld: boolean;
  isRecording: boolean;
  isSoundDetected: boolean;
  isActiveChatStreaming: boolean;
  hasUnreadyFiles: boolean;
  message: string;
  isVoiceChatMode: boolean;
  isMicMuted: boolean;
  isSendDisabled: boolean;
  isStopRequestInFlight: boolean;
  activeStreamCount: number;
  atConcurrencyLimit: boolean;
  maxConcurrentStreams: number;
  isProcessingSegment?: boolean;
  isSendingVoiceMessage?: boolean;
  isAwaitingResponse?: boolean;
}

const SendButton: React.FC<SendButtonProps> = ({
  onClick,
  onHoldStart,
  onHoldEnd,
  isButtonHeld,
  isRecording,
  isSoundDetected,
  isActiveChatStreaming,
  hasUnreadyFiles,
  message,
  isVoiceChatMode,
  isMicMuted,
  isSendDisabled,
  isStopRequestInFlight,
  activeStreamCount,
  atConcurrencyLimit,
  maxConcurrentStreams,
  isProcessingSegment = false,
  isSendingVoiceMessage = false,
  isAwaitingResponse = false
}) => {
  let voiceState: 'idle' | 'listening' | 'processing' | 'sending' | 'waiting' = 'idle';
  if (isVoiceChatMode) {
    if (isSendingVoiceMessage) {
      voiceState = 'sending';
    } else if (isAwaitingResponse) {
      voiceState = 'waiting';
    } else if (isProcessingSegment) {
      voiceState = 'processing';
    } else if (isRecording && isSoundDetected) {
      voiceState = 'listening';
    } else {
      voiceState = 'idle';
    }
  }

  const buttonClassName = [
    'send-button',
    (isSendDisabled && !isActiveChatStreaming) ? 'loading' : '',
    isButtonHeld ? 'held' : '',
    isRecording ? 'recording' : '',
    isVoiceChatMode ? 'voice-chat-mode' : '',
    isVoiceChatMode && isMicMuted ? 'mic-muted' : '',
    isVoiceChatMode ? `voice-state-${voiceState}` : ''
  ].filter(Boolean).join(' ');

  const hasMessage = message.trim().length > 0;

  let buttonTitle: string;
  if (isVoiceChatMode) {
    buttonTitle = isMicMuted
      ? 'Voice chat active (mic muted)\nClick to disable'
      : 'Voice chat active\nClick to disable';
  } else if (isActiveChatStreaming) {
    buttonTitle = isStopRequestInFlight ? 'Stop request in progress...' : 'Click to stop current response';
  } else if (hasUnreadyFiles) {
    buttonTitle = 'Waiting for files to finish processing...';
  } else if (atConcurrencyLimit) {
    buttonTitle = `Concurrent limit reached (${activeStreamCount}/${maxConcurrentStreams})`;
  } else if (hasMessage) {
    buttonTitle = 'Send message';
  } else {
    buttonTitle = 'Hold to record\nClick for voice chat';
  }

  return (
    <div
      className="send-button-wrapper"
      onMouseDown={onHoldStart}
      onMouseUp={onHoldEnd}
      onMouseLeave={onHoldEnd}
      onTouchStart={onHoldStart}
      onTouchEnd={onHoldEnd}
    >
      <button
        onClick={onClick}
        className={buttonClassName}
        title={buttonTitle}
      >
        {isButtonHeld ? (
          <div
            className={`hold-animation-circle ${isRecording ? 'recording' : ''} ${isSoundDetected ? 'sound-detected' : 'silent'}`}
            style={{
              animationPlayState: isSoundDetected ? 'running' : 'paused'
            }}
          />
        ) : (isActiveChatStreaming && !isVoiceChatMode) ? (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="4" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="2" fill="none"/>
          </svg>
        ) : hasUnreadyFiles ? (
          <span style={{ fontSize: '12px', opacity: 0.7 }}>📎</span>
        ) : hasMessage ? (
          '→'
        ) : (
          <div className={`voice-icon-container ${isVoiceChatMode ? 'voice-active' : ''} ${isMicMuted ? 'muted' : ''} ${isVoiceChatMode ? `state-${voiceState}` : ''}`}>
            <svg className="voice-bars-svg" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="4" y="8" width="2.5" height="8" rx="1" fill="currentColor" opacity="0.5" className="voice-bar bar-1"/>
              <rect x="8" y="5" width="2.5" height="14" rx="1" fill="currentColor" opacity="0.9" className="voice-bar bar-2"/>
              <rect x="12" y="3" width="2.5" height="18" rx="1" fill="currentColor" className="voice-bar bar-main"/>
              <rect x="16" y="7" width="2.5" height="10" rx="1" fill="currentColor" opacity="0.7" className="voice-bar bar-3"/>
              <rect x="20" y="10" width="2" height="4" rx="1" fill="currentColor" opacity="0.4" className="voice-bar bar-4"/>
            </svg>
            {isVoiceChatMode && <div className={`voice-mode-ring ${voiceState}`} />}
            {isVoiceChatMode && <div className={`voice-state-bg ${voiceState}`} />}
          </div>
        )}
      </button>
    </div>
  );
};

export default SendButton;