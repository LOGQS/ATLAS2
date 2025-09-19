import React from 'react';

interface VoiceChatMuteButtonProps {
  isMicMuted: boolean;
  onToggle: () => void;
}

const VoiceChatMuteButton: React.FC<VoiceChatMuteButtonProps> = ({ isMicMuted, onToggle }) => {
  const title = isMicMuted ? 'Resume microphone detection' : 'Pause microphone detection';

  return (
    <button
      type="button"
      className={`voice-chat-mute-button ${isMicMuted ? 'muted' : 'listening'}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      title={title}
      aria-pressed={isMicMuted}
      aria-label={title}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="presentation"
      >
        <path
          d="M12 3C13.1046 3 14 3.89543 14 5V12C14 13.1046 13.1046 14 12 14C10.8954 14 10 13.1046 10 12V5C10 3.89543 10.8954 3 12 3Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={isMicMuted ? 'rgba(255, 255, 255, 0.12)' : 'none'}
        />
        <path
          d="M7 11C7 13.7614 9.23858 16 12 16C14.7614 16 17 13.7614 17 11"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line
          x1="12"
          y1="16"
          x2="12"
          y2="20"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line
          x1="9"
          y1="20"
          x2="15"
          y2="20"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        {isMicMuted && (
          <line
            x1="6"
            y1="6"
            x2="18"
            y2="18"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        )}
      </svg>
    </button>
  );
};

export default VoiceChatMuteButton;
