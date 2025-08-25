// status: complete

import React from 'react';
import MessageRenderer from './MessageRenderer';
import UserMessageFiles from './UserMessageFiles';
import '../styles/MessageRenderer.css';

interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type?: string;
  api_state?: string;
  provider?: string;
}

interface UserMessageProps {
  content: string;
  isFirstMessage?: boolean;
  attachedFiles?: AttachedFile[];
}

const UserMessage: React.FC<UserMessageProps> = ({ 
  content, 
  isFirstMessage = false,
  attachedFiles
}) => {
  return (
    <div className={`user-message ${isFirstMessage ? 'first-message' : ''}`}>
      <div className="user-message-bubble">
        {attachedFiles && attachedFiles.length > 0 && (
          <UserMessageFiles files={attachedFiles} />
        )}
        <MessageRenderer content={content} />
      </div>
    </div>
  );
};

export default UserMessage;