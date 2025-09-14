import React, { useState } from 'react';
import '../styles/sections/SearchWindow.css';

const SearchWindow: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    
    setIsSearching(true);
    setTimeout(() => {
      setSearchResults([
        { id: 1, title: 'Example Result 1', snippet: 'This is a sample search result...' },
        { id: 2, title: 'Example Result 2', snippet: 'Another sample result for demonstration...' }
      ]);
      setIsSearching(false);
    }, 1000);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  return (
    <div className="section-content">
      <div className="section-header">
        <h4>Search Knowledge Base</h4>
      </div>
      <div className="section-body">
        <div className="search-input-container">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyPress}
            className="search-input"
            placeholder="Search files, documents, and resources..."
          />
          <button 
            onClick={handleSearch}
            className={`search-button ${isSearching ? 'loading' : ''}`}
            disabled={isSearching}
          >
            {isSearching ? (
              <div className="loading-spinner-small"></div>
            ) : (
              '🔍'
            )}
          </button>
        </div>
        
        {searchResults.length > 0 && (
          <div className="search-results">
            <div className="results-header">
              <span className="results-count">{searchResults.length} results found</span>
            </div>
            {searchResults.map(result => (
              <div key={result.id} className="search-result-item">
                <div className="result-title">{result.title}</div>
                <div className="result-snippet">{result.snippet}</div>
                <div className="result-actions">
                  <button className="action-btn small">Open</button>
                  <button className="action-btn small">Preview</button>
                </div>
              </div>
            ))}
          </div>
        )}
        
        {searchQuery && searchResults.length === 0 && !isSearching && (
          <div className="empty-results">
            <p>No results found for &quot;{searchQuery}&quot;</p>
            <p>Try using different keywords or check your spelling.</p>
          </div>
        )}
        
        {!searchQuery && (
          <div className="search-suggestions">
            <h5>Quick Actions</h5>
            <div className="suggestion-chips">
              <button className="chip" onClick={() => setSearchQuery('documents')}>Documents</button>
              <button className="chip" onClick={() => setSearchQuery('images')}>Images</button>
              <button className="chip" onClick={() => setSearchQuery('recent')}>Recent Files</button>
              <button className="chip" onClick={() => setSearchQuery('favorites')}>Favorites</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchWindow;