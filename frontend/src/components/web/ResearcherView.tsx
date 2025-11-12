import React, { useState, useRef } from 'react';
import { useWebContext } from '../../contexts/WebContext';
import { Icons } from '../ui/Icons';
import { apiUrl } from '../../config/api';
import logger from '../../utils/core/logger';

export const ResearcherView: React.FC = () => {
  const { searchResults, metaSummary, relatedTopics, agentStatus, chatId, addSearchResult } = useWebContext();
  const [searchInput, setSearchInput] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSearch = async () => {
    const query = searchInput.trim();
    if (!query) return;

    setIsSearching(true);
    logger.info('[RESEARCHER_VIEW] Initiating search:', query);

    try {
      const response = await fetch(apiUrl('/api/web/search'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          chat_id: chatId || 'default',
          results_per_query: 10,
        }),
      });

      const data = await response.json();

      if (data.success && data.results) {
        logger.info('[RESEARCHER_VIEW] Search completed:', data.count, 'results');

        // Map backend results to frontend SearchResult format
        data.results.forEach((result: any) => {
          addSearchResult({
            id: `result_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            url: result.url,
            title: result.title,
            description: result.snippet || '',
            favicon: result.favicon,
          });
        });

        setSearchInput('');
      } else {
        logger.error('[RESEARCHER_VIEW] Search failed:', data.error);
      }
    } catch (error) {
      logger.error('[RESEARCHER_VIEW] Search error:', error);
    } finally {
      setIsSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  return (
    <main className="web-researcher-view">
      {/* Search Input Bar */}
      <div className="web-researcher-view__search-bar">
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 bg-gray-800 rounded-lg px-4 py-2.5 border border-gray-600">
            <Icons.Search className="w-5 h-5 text-gray-400" />
            <input
              ref={inputRef}
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter search query and press Enter..."
              className="flex-1 bg-transparent text-sm text-gray-200 outline-none placeholder:text-gray-500"
              disabled={isSearching || agentStatus === 'researching'}
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={!searchInput.trim() || isSearching || agentStatus === 'researching'}
            className="px-4 py-2.5 bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg transition-colors flex items-center gap-2"
          >
            {isSearching || agentStatus === 'researching' ? (
              <>
                <Icons.RotateCw className="w-4 h-4 animate-spin" />
                <span>Searching...</span>
              </>
            ) : (
              <>
                <Icons.Search className="w-4 h-4" />
                <span>Search</span>
              </>
            )}
          </button>
        </div>
      </div>

      <div className="web-researcher-view__results">
        <div className="web-researcher-view__results-header">
          <div className="flex items-center gap-3">
            <p className="text-gray-400 text-sm font-medium">ATLAS2 Agent Search Results</p>
          </div>
        </div>

        <div className="web-researcher-view__results-list">
          {searchResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-400">
              <Icons.Search className="w-12 h-12 mb-4 opacity-50" />
              <p className="text-sm">
                {agentStatus === 'researching' ? 'Searching for results...' : 'No search results yet'}
              </p>
            </div>
          ) : (
            searchResults.map((result) => (
              <div key={result.id} className="web-search-result">
                <div className="flex items-center gap-3 mb-2">
                  {result.favicon && (
                    <img src={result.favicon} alt="" className="w-4 h-4" />
                  )}
                  <a href={result.url} className="text-cyan-400 text-sm hover:underline" target="_blank" rel="noopener noreferrer">
                    {new URL(result.url).hostname}
                  </a>
                </div>
                <h3 className="text-lg font-medium text-white mb-2">{result.title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{result.description}</p>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="web-researcher-view__context">
        <h3 className="text-white text-lg font-bold mb-4">Contextual Research Panel</h3>

        <div className="web-context-panel">
          <div className="mb-6">
            <h4 className="text-base font-semibold mb-2 text-white">Meta Summary</h4>
            {metaSummary ? (
              <p className="text-sm text-gray-400 leading-relaxed">{metaSummary}</p>
            ) : (
              <p className="text-sm text-gray-500 italic">Summary will appear here as results are synthesized...</p>
            )}
          </div>

          <div>
            <h4 className="text-base font-semibold mb-3 text-white">Related Topics</h4>
            {relatedTopics.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {relatedTopics.map((topic, index) => (
                  <span key={index} className="web-topic-tag">
                    {topic}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500 italic">Related topics will appear here...</p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
};
