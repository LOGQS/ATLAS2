import React, { useState, useEffect, useRef } from 'react';
import chatManager, { ChatSearchResult } from '../utils/chatManager';
import '../styles/settings-window.css';

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

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Handle click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    
    if (isOpen) {
      setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside);
      }, 100);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSearch = async () => {
    if (!query.trim() && !start && !end && !tags.trim()) return;
    
    setSearching(true);
    const tagList = tags
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0);
    const res = await chatManager.searchMessages(query.trim(), start, end, tagList);
    setResults(res);
    setSearching(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !searching) {
      handleSearch();
    }
  };

  const clearForm = () => {
    setQuery('');
    setStart('');
    setEnd('');
    setTags('');
    setResults([]);
  };

  return (
    <div className="settings-overlay">
      <div ref={modalRef} className="settings-window" style={{ maxWidth: '700px', maxHeight: '80vh', width: '90%' }}>
        <div className="settings-header">
          <h2>Search Chats</h2>
          <button className="settings-close-button" onClick={onClose}>
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        
        <div className="settings-content" style={{ overflowX: 'hidden' }}>
          <div className="general-section">
            <h3>Search Parameters</h3>
            <p className="settings-description">
              Search through your chat history by content, date range, or tags. Leave fields empty to search all content.
            </p>
            
            <div className="settings-group">
              <h4>Content & Tags</h4>
              
              <div className="setting-item">
                <label className="setting-label-block">
                  <span>Search Text</span>
                  <input
                    type="text"
                    className="setting-select"
                    placeholder="Enter keywords to search for..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    style={{ fontSize: '14px', padding: '10px 12px', width: '100%', boxSizing: 'border-box' }}
                  />
                </label>
                <span className="setting-description">Search for specific words or phrases in your messages</span>
              </div>
              
              <div className="setting-item">
                <label className="setting-label-block">
                  <span>Tags</span>
                  <input
                    type="text"
                    className="setting-select"
                    placeholder="tag1, tag2, tag3..."
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    onKeyDown={handleKeyDown}
                    style={{ fontSize: '14px', padding: '10px 12px', width: '100%', boxSizing: 'border-box' }}
                  />
                </label>
                <span className="setting-description">Search by comma-separated tags</span>
              </div>
            </div>
            
            <div className="settings-group">
              <h4>Date Range</h4>
              
              <div className="setting-item">
                <div style={{ display: 'flex', gap: '12px', alignItems: 'end', width: '100%' }}>
                  <label className="setting-label-block" style={{ flex: 1, minWidth: 0 }}>
                    <span>From Date</span>
                    <input
                      type="date"
                      className="setting-select"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                      style={{ fontSize: '14px', padding: '10px 12px', width: '100%', boxSizing: 'border-box' }}
                    />
                  </label>
                  <label className="setting-label-block" style={{ flex: 1, minWidth: 0 }}>
                    <span>To Date</span>
                    <input
                      type="date"
                      className="setting-select"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                      style={{ fontSize: '14px', padding: '10px 12px', width: '100%', boxSizing: 'border-box' }}
                    />
                  </label>
                </div>
                <span className="setting-description">Optionally filter by date range</span>
              </div>
            </div>
            
            <div className="new-profile-form" style={{ gap: '12px', paddingTop: '16px', flexWrap: 'wrap' }}>
              <button 
                className="new-profile-button"
                onClick={handleSearch}
                disabled={searching || (!query.trim() && !start && !end && !tags.trim())}
                style={{ flex: '1', minWidth: '120px', maxWidth: '200px' }}
              >
                {searching ? (
                  <>
                    <svg className="button-spinner" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 11-6.219-8.56"/>
                    </svg>
                    <span>Searching...</span>
                  </>
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8"></circle>
                      <path d="m21 21-4.35-4.35"></path>
                    </svg>
                    <span>Search</span>
                  </>
                )}
              </button>
              <button 
                className="setting-select"
                onClick={clearForm}
                style={{ 
                  flex: '1', 
                  minWidth: '100px',
                  maxWidth: '150px',
                  padding: '10px 16px',
                  backgroundColor: 'var(--secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: '500',
                  transition: 'all 0.2s',
                  boxSizing: 'border-box'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
                  e.currentTarget.style.color = 'var(--text-primary)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--secondary)';
                  e.currentTarget.style.color = 'var(--text-secondary)';
                }}
              >
                Clear
              </button>
            </div>
            
            {(results.length > 0 || searching) && (
              <div className="settings-group" style={{ marginTop: '24px' }}>
                <h4>Search Results {results.length > 0 && `(${results.length})`}</h4>
                
                <div className="profile-files-list" style={{ maxHeight: '300px', backgroundColor: 'var(--primary)', width: '100%', boxSizing: 'border-box' }}>
                  <div className="profile-files" style={{ maxHeight: '280px', width: '100%' }}>
                    {searching ? (
                      <div style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center', 
                        padding: '24px',
                        color: 'var(--text-secondary)' 
                      }}>
                        <svg className="button-spinner" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px' }}>
                          <path d="M21 12a9 9 0 11-6.219-8.56"/>
                        </svg>
                        Searching...
                      </div>
                    ) : results.length > 0 ? (
                      results.map((result, index) => (
                        <div key={index} className="profile-file-item" style={{ 
                          flexDirection: 'column', 
                          alignItems: 'flex-start', 
                          padding: '12px',
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                          width: '100%',
                          boxSizing: 'border-box'
                        }}>
                          <div style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            justifyContent: 'space-between',
                            width: '100%',
                            marginBottom: '8px',
                            minWidth: 0
                          }}>
                            <div style={{ 
                              fontSize: '12px', 
                              color: 'var(--text-secondary)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              minWidth: 0,
                              flex: 1
                            }}>
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                                <circle cx="12" cy="10" r="3"></circle>
                              </svg>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{result.chat_title || 'Untitled Chat'}</span>
                              {result.role && (
                                <>
                                  <span style={{ flexShrink: 0 }}>•</span>
                                  <span style={{ 
                                    color: result.role === 'user' ? 'var(--accent)' : 'var(--text-secondary)',
                                    fontWeight: '500',
                                    textTransform: 'capitalize',
                                    flexShrink: 0
                                  }}>
                                    {result.role}
                                  </span>
                                </>
                              )}
                            </div>
                            {result.timestamp && (
                              <span style={{ 
                                fontSize: '11px', 
                                color: 'var(--text-secondary)',
                                flexShrink: 0,
                                marginLeft: '8px'
                              }}>
                                {new Date(result.timestamp).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                          <div style={{ 
                            color: 'var(--text-primary)',
                            fontSize: '13px',
                            lineHeight: '1.4',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            width: '100%',
                            overflowWrap: 'break-word'
                          }}>
                            {result.content.length > 200 ? 
                              `${result.content.slice(0, 200)}...` : 
                              result.content
                            }
                          </div>
                        </div>
                      ))
                    ) : (
                      <div style={{ 
                        display: 'flex', 
                        flexDirection: 'column',
                        alignItems: 'center', 
                        justifyContent: 'center', 
                        padding: '24px',
                        color: 'var(--text-secondary)',
                        textAlign: 'center'
                      }}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '12px', opacity: 0.5 }}>
                          <circle cx="11" cy="11" r="8"></circle>
                          <path d="m21 21-4.35-4.35"></path>
                        </svg>
                        <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '4px' }}>No results found</div>
                        <div style={{ fontSize: '12px' }}>Try different keywords or adjust your search parameters</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatSearchModal;
