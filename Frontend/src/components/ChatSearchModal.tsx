import React, { useState, useEffect, useRef } from 'react';
import chatManager, { ChatSearchResult } from '../utils/chatManager';
import '../styles/modal.css';

interface ChatSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const ChatSearchModal: React.FC<ChatSearchModalProps> = ({ isOpen, onClose }) => {
  const [query, setQuery] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [tags, setTags] = useState('');
  const [results, setResults] = useState<ChatSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKey);
    }
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSearch = async () => {
    setSearching(true);
    const tagList = tags
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0);
    const res = await chatManager.searchMessages(query, start, end, tagList);
    setResults(res);
    setSearching(false);
  };

  return (
    <div className="modal-overlay animate-fade-in">
      <div ref={modalRef} className="modal-container animate-fade-in" style={{maxWidth:'600px'}}>
        <div className="modal-header">
          <h3>Search Chats</h3>
          <button className="modal-button cancel-button" onClick={onClose}>Close</button>
        </div>
        <div className="modal-content">
          <div style={{display:'flex', flexDirection:'column', gap:'8px'}}>
            <input type="text" placeholder="Search text" value={query} onChange={e=>setQuery(e.target.value)} />
            <div style={{display:'flex', gap:'8px'}}>
              <input type="date" value={start} onChange={e=>setStart(e.target.value)} />
              <input type="date" value={end} onChange={e=>setEnd(e.target.value)} />
            </div>
            <input type="text" placeholder="Tags comma separated" value={tags} onChange={e=>setTags(e.target.value)} />
            <button className="modal-button confirm-button" onClick={handleSearch} disabled={searching}>Search</button>
          </div>
          <div style={{maxHeight:'300px', overflowY:'auto', marginTop:'1rem'}}>
            {results.map((r, i) => (
              <div key={i} style={{padding:'6px 0', borderBottom:'1px solid var(--border-color)'}}>
                <div style={{fontSize:'12px', color:'var(--text-color-secondary)'}}>{r.timestamp?.slice(0,10)} • {r.chat_title}</div>
                <div style={{whiteSpace:'pre-wrap'}}>{r.content.slice(0,200)}</div>
              </div>
            ))}
            {results.length === 0 && !searching && <p>No results</p>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatSearchModal;
