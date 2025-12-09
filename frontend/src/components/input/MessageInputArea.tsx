import React, { RefObject, ReactNode } from 'react';

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
  /** Optional element to render inside the input wrapper (right side) */
  inlineRight?: ReactNode;
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
  dragHandlers,
  inlineRight
}) => {
  return (
    <div
      className={`input-wrapper ${isDragOver ? 'drag-over' : ''} ${
        isVoiceChatMode && !message.trim() ? 'voice-chat-mode' : ''
      } ${inlineRight ? 'has-inline-right' : ''}`}
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
        className={`message-input with-file-button ${inlineRight ? 'with-inline-right' : ''}`}
        placeholder=""
        rows={1}
      />
      {inlineRight && (
        <div className="input-inline-right">
          {inlineRight}
        </div>
      )}
    </div>
  );
};

export default MessageInputArea;