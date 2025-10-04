import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../config/api';
import '../styles/sections/SearchWindow.css';

interface MessageMatch {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  snippet: string;
}

interface ChatResult {
  id: string;
  name: string;
  type: 'chat';
  matchingMessages?: MessageMatch[];
}

interface FileResult {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
}

interface SearchResults {
  chats: ChatResult[];
  files: FileResult[];
  sources: any[];
}

const SearchWindow: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResults>({
    chats: [],
    files: [],
    sources: []
  });
  const [isSearching, setIsSearching] = useState(false);
  const [expandedChats, setExpandedChats] = useState<Set<string>>(new Set());
  const [allChats, setAllChats] = useState<ChatResult[]>([]);
  const [allFiles, setAllFiles] = useState<FileResult[]>([]);

  useEffect(() => {
    const fetchChats = async () => {
      try {
        const response = await fetch(apiUrl('/api/db/chats'));
        if (response.ok) {
          const data = await response.json();
          setAllChats(data.chats.map((chat: any) => ({
            id: chat.id,
            name: chat.name,
            type: 'chat' as const
          })));
        }
      } catch (error) {
        console.error('Failed to fetch chats:', error);
      }
    };

    fetchChats();
  }, []);

  useEffect(() => {
    const fetchFiles = async () => {
      try {
        const response = await fetch(apiUrl('/api/file-browser/tree'));
        if (response.ok) {
          const data = await response.json();
          const files: FileResult[] = [];

          if (!data.success || !data.root) {
            console.error('Invalid file tree response:', data);
            return;
          }

          const extractFiles = (node: any) => {
            if (node.type === 'file') {
              files.push({
                path: node.path,
                name: node.name,
                type: 'file',
                size: node.size,
                modified: node.modified
              });
            } else if (node.type === 'directory') {
              if (node.path) {
                files.push({
                  path: node.path,
                  name: node.name,
                  type: 'directory',
                  modified: node.modified
                });
              }

              if (node.children) {
                node.children.forEach((child: any) => extractFiles(child));
              }
            }
          };

          extractFiles(data.root);
          setAllFiles(files);
        }
      } catch (error) {
        console.error('Failed to fetch files:', error);
      }
    };

    fetchFiles();
  }, []);

  const performSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults({ chats: [], files: [], sources: [] });
      setExpandedChats(new Set());
      return;
    }

    setIsSearching(true);
    const lowerQuery = query.toLowerCase().trim();

    const chatNameMatches = allChats.filter(chat =>
      chat.name.toLowerCase().includes(lowerQuery) ||
      chat.id.toLowerCase().includes(lowerQuery)
    );

    const chatSearchPromises = allChats.map(async (chat) => {
      try {
        const response = await fetch(apiUrl(`/api/db/chat/${chat.id}`));
        if (response.ok) {
          const data = await response.json();
          const messages = data.history || [];

          const matchingMessages: MessageMatch[] = messages
            .filter((msg: any) =>
              msg.content && msg.content.toLowerCase().includes(lowerQuery)
            )
            .map((msg: any) => {
              const contentLower = msg.content.toLowerCase();
              const queryIndex = contentLower.indexOf(lowerQuery);
              const start = Math.max(0, queryIndex - 50);
              const end = Math.min(msg.content.length, queryIndex + lowerQuery.length + 50);
              let snippet = msg.content.substring(start, end);

              if (start > 0) snippet = '...' + snippet;
              if (end < msg.content.length) snippet = snippet + '...';

              return {
                id: msg.id,
                role: msg.role,
                content: msg.content,
                snippet
              };
            }); 

          if (matchingMessages.length > 0) {
            return {
              id: chat.id,
              name: chat.name,
              type: 'chat' as const,
              matchingMessages
            };
          }
        }
      } catch (error) {
        console.error(`Failed to fetch messages for chat ${chat.id}:`, error);
      }
      return null;
    });

    const chatWithMessagesResults = (await Promise.all(chatSearchPromises)).filter(
      (result) => result !== null
    ) as ChatResult[];

    const chatIdSet = new Set<string>();
    const combinedChatResults: ChatResult[] = [];

    chatNameMatches.forEach(chat => {
      chatIdSet.add(chat.id);
      const messageMatch = chatWithMessagesResults.find(c => c && c.id === chat.id);
      if (messageMatch) {
        combinedChatResults.push(messageMatch);
      } else {
        combinedChatResults.push(chat);
      }
    });

    chatWithMessagesResults.forEach(chat => {
      if (chat && !chatIdSet.has(chat.id)) {
        combinedChatResults.push(chat);
      }
    });


    const fileResults = allFiles.filter(file =>
      file.name.toLowerCase().includes(lowerQuery) ||
      file.path.toLowerCase().includes(lowerQuery)
    );

    setSearchResults({
      chats: combinedChatResults,
      files: fileResults,
      sources: []
    });

    setIsSearching(false);
  }, [allChats, allFiles]);

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      performSearch(searchQuery);
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [searchQuery, performSearch]);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      performSearch(searchQuery);
    }
  };

  const toggleChatExpand = (chatId: string) => {
    setExpandedChats(prev => {
      const next = new Set(prev);
      if (next.has(chatId)) {
        next.delete(chatId);
      } else {
        next.add(chatId);
      }
      return next;
    });
  };

  const handleChatClick = (chatId: string) => {
    if ((window as any).handleChatSwitch) {
      (window as any).handleChatSwitch(chatId);
    }
  };

  const handleFileClick = (filePath: string) => {
    console.log('Open file:', filePath);
  };

  const totalResults = searchResults.chats.length + searchResults.files.length + searchResults.sources.length;
  const hasResults = totalResults > 0;

  return (
    <div className="section-content search-window-content">
      <div className="section-header search-window-header">
        <h4>Search</h4>
        <p className="search-subtitle">Find chats, files, and sources across your workspace</p>
      </div>
      <div className="section-body">
        <div className="search-input-container">
          <div className="search-icon-wrapper">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <circle cx="11" cy="11" r="8" strokeWidth="2"/>
              <path d="m21 21-4.35-4.35" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyPress}
            className="search-input"
            placeholder="Search chats, files, and sources..."
            autoFocus
          />
          {searchQuery && (
            <button
              className="search-clear-btn"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path d="M18 6L6 18M6 6l12 12" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>

        {hasResults && (
          <div className="search-results">
            <div className="results-summary">
              <span className="results-count">
                {totalResults} result{totalResults !== 1 ? 's' : ''} found
              </span>
            </div>

            {/* Chat History Results */}
            {searchResults.chats.length > 0 && (
              <div className="results-category">
                <div className="category-header">
                  <div className="category-icon chat-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeWidth="2"/>
                    </svg>
                  </div>
                  <h5 className="category-title">Chat History</h5>
                  <span className="category-count">{searchResults.chats.length}</span>
                </div>
                <div className="category-results">
                  {searchResults.chats.map(chat => {
                    const isExpanded = expandedChats.has(chat.id);
                    const hasMessages = chat.matchingMessages && chat.matchingMessages.length > 0;

                    return (
                      <div key={chat.id} className="chat-result-wrapper">
                        <div className="search-result-item chat-result">
                          <div className="result-icon">💬</div>
                          <div
                            className="result-content"
                            onClick={() => handleChatClick(chat.id)}
                          >
                            <div className="result-title">{chat.name}</div>
                            <div className="result-meta">
                              <span className="result-type">Chat</span>
                              {hasMessages && (
                                <span className="message-count">
                                  {chat.matchingMessages!.length} matching message{chat.matchingMessages!.length !== 1 ? 's' : ''}
                                </span>
                              )}
                            </div>
                          </div>
                          {hasMessages && (
                            <button
                              className={`expand-btn ${isExpanded ? 'expanded' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleChatExpand(chat.id);
                              }}
                              aria-label={isExpanded ? 'Collapse messages' : 'Expand messages'}
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                <path d="M6 9l6 6 6-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </button>
                          )}
                          <div
                            className="result-arrow"
                            onClick={() => handleChatClick(chat.id)}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                              <path d="M9 18l6-6-6-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </div>
                        </div>

                        {/* Expandable Messages */}
                        {hasMessages && isExpanded && (
                          <div className="matching-messages">
                            {chat.matchingMessages!.map((msg, idx) => (
                              <div key={msg.id} className="message-match">
                                <div className="message-role">
                                  {msg.role === 'user' ? (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" strokeWidth="2"/>
                                      <circle cx="12" cy="7" r="4" strokeWidth="2"/>
                                    </svg>
                                  ) : (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                      <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth="2"/>
                                      <path d="M9 9h6M9 15h6" strokeWidth="2" strokeLinecap="round"/>
                                    </svg>
                                  )}
                                  <span>{msg.role === 'user' ? 'You' : 'Assistant'}</span>
                                </div>
                                <div className="message-snippet">{msg.snippet}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Workspace Files Results */}
            {searchResults.files.length > 0 && (
              <div className="results-category">
                <div className="category-header">
                  <div className="category-icon file-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" strokeWidth="2"/>
                      <polyline points="13 2 13 9 20 9" strokeWidth="2"/>
                    </svg>
                  </div>
                  <h5 className="category-title">Workspace Files</h5>
                  <span className="category-count">{searchResults.files.length}</span>
                </div>
                <div className="category-results">
                  {searchResults.files.slice(0, 20).map(file => (
                    <div
                      key={file.path}
                      className="search-result-item"
                      onClick={() => handleFileClick(file.path)}
                    >
                      <div className="result-icon">
                        {file.type === 'directory' ? '📁' : '📄'}
                      </div>
                      <div className="result-content">
                        <div className="result-title">{file.name}</div>
                        <div className="result-meta">
                          <span className="result-type">
                            {file.type === 'directory' ? 'Folder' : 'File'}
                          </span>
                          <span className="result-path">{file.path || '/'}</span>
                        </div>
                      </div>
                      <div className="result-arrow">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <path d="M9 18l6-6-6-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>
                    </div>
                  ))}
                  {searchResults.files.length > 20 && (
                    <div className="results-overflow">
                      +{searchResults.files.length - 20} more files
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Sources Results (Placeholder) */}
            <div className="results-category">
              <div className="category-header">
                <div className="category-icon source-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path d="M12 2L2 7l10 5 10-5-10-5z" strokeWidth="2"/>
                    <path d="M2 17l10 5 10-5M2 12l10 5 10-5" strokeWidth="2"/>
                  </svg>
                </div>
                <h5 className="category-title">Sources</h5>
                <span className="category-count">0</span>
              </div>
              <div className="category-placeholder">
                <p>Source search coming soon...</p>
              </div>
            </div>
          </div>
        )}

        {searchQuery && !hasResults && !isSearching && (
          <div className="empty-results">
            <div className="empty-icon">🔍</div>
            <h4>No results found</h4>
            <p>Try using different keywords or check your spelling</p>
          </div>
        )}

        {!searchQuery && (
          <div className="search-welcome">
            <div className="welcome-icon">✨</div>
            <h4>Search Everything</h4>
            <p>Search across chat history, workspace files, and sources</p>
            <div className="search-tips">
              <h5>Quick Tips</h5>
              <ul>
                <li>Use keywords from chat names or messages</li>
                <li>Search for file names or folder paths</li>
                <li>Results update as you type</li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchWindow;