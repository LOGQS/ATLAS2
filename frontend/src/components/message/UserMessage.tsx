// status: complete

import React from 'react';
import MessageRenderer from './MessageRenderer';
import '../../styles/message/MessageRenderer.css';

interface UserMessageProps {
  content: string;
  isFirstMessage?: boolean;
  isStatic?: boolean;
}

const UserMessage: React.FC<UserMessageProps> = ({ 
  content, 
  isFirstMessage = false,
  isStatic = true
}) => {
  return (
    <div className={`user-message ${isFirstMessage ? 'first-message' : ''}`}>
      <div className="user-message-bubble">
        <MessageRenderer content={content} />
      </div>
    </div>
  );
};

export default UserMessage;