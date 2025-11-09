import React from 'react';
import { useWebContext } from '../../contexts/WebContext';
import { Icons } from '../ui/Icons';

export const ResearcherView: React.FC = () => {
  const { searchResults, metaSummary, relatedTopics, agentStatus } = useWebContext();

  return (
    <main className="web-researcher-view">
      <div className="web-researcher-view__results">
        <div className="web-researcher-view__results-header">
          <div className="flex items-center gap-3">
            <p className="text-gray-400 text-sm font-medium">ATLAS2 Agent Search Results</p>
          </div>
          <div className="flex items-center gap-2">
            <button className="web-btn web-btn--secondary">
              <Icons.Pause className="w-4 h-4" />
              <span>Pause</span>
            </button>
            <button className="web-btn web-btn--danger">
              <Icons.X className="w-4 h-4" />
              <span>Stop</span>
            </button>
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
