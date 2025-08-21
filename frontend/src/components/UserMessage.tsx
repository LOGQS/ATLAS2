// status: complete

import React from 'react';

interface UserMessageProps {
  content: string;
  isFirstMessage?: boolean;
}

const UserMessage: React.FC<UserMessageProps> = ({ 
  content, 
  isFirstMessage = false
}) => {
  return (
    <div className={`user-message ${isFirstMessage ? 'first-message' : ''}`}>
      <div className="user-message-bubble">
        {content}
      </div>
    </div>
  );
};

export default UserMessage;