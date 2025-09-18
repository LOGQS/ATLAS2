import React, { RefObject } from 'react';

interface MessageInputAreaProps {
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  message: string;
  onMessageChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onAddFileClick: () => void;
  isDragOver?: boolean;
  isVoiceChatMode?: boolean;
  isActiveChatStreaming?: boolean;
  dragHandlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

const MessageInputArea: React.FC<MessageInputAreaProps> = ({
  inputRef,
  message,
  onMessageChange,
  onKeyDown,
  onAddFileClick,
  isDragOver = false,
  isVoiceChatMode = false,
  isActiveChatStreaming = false,
  dragHandlers
}) => {
  return (
    <div
      className={`input-wrapper ${isDragOver ? 'drag-over' : ''} ${
        isVoiceChatMode && !message.trim() && !isActiveChatStreaming ? 'voice-chat-mode' : ''
      }`}
      {...dragHandlers}
    >
      <button
        className="add-file-button-inline"
        title="Add File"
        onClick={onAddFileClick}
      >
        +
      </button>
      <textarea
        ref={inputRef}
        value={message}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="message-input with-file-button"
        placeholder=""
        rows={1}
      />
    </div>
  );
};

export default MessageInputArea;