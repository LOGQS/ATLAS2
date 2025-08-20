import React, { useState, useRef} from 'react';
import './styles/App.css';
import LeftSidebar from './components/LeftSidebar';
import RightSidebar from './components/RightSidebar';

function App() {
  const [message, setMessage] = useState('');
  const [hasMessageBeenSent, setHasMessageBeenSent] = useState(false);
  const [centerFading, setCenterFading] = useState(false);
  const bottomInputRef = useRef<HTMLInputElement>(null);

  const handleSend = () => {
    if (message.trim()) {
      console.log('Sending message:', message);
      setMessage('');
      
      if (!hasMessageBeenSent) {
        setCenterFading(true);
        setTimeout(() => {
          setHasMessageBeenSent(true);
          document.body.classList.add('chat-active');
          setTimeout(() => {
            bottomInputRef.current?.focus();
          }, 100);
        }, 500);
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSend();
    }
  };

  return (
    <div className="app">
      <LeftSidebar />
      <div className="main-content">
        <div className="chat-container">
          <h1 className={`title ${centerFading ? 'fading' : ''} ${hasMessageBeenSent ? 'hidden' : ''}`}>
            How can I help you?
          </h1>
          <div className={`input-container center ${centerFading ? 'fading' : ''} ${hasMessageBeenSent ? 'hidden' : ''}`}>
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyPress}
              className="message-input"
              placeholder=""
            />
            <button onClick={handleSend} className="send-button">
              →
            </button>
          </div>
        </div>
        
        {hasMessageBeenSent && (
          <div className="bottom-input-container">
            <input
              ref={bottomInputRef}
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyPress}
              className="message-input"
              placeholder=""
            />
            <button onClick={handleSend} className="send-button">
              →
            </button>
          </div>
        )}
      </div>
      <RightSidebar />
    </div>
  );
}

export default App;
