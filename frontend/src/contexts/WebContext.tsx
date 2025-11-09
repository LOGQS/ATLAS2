import React, { createContext, useContext, useState, useCallback } from 'react';
import logger from '../utils/core/logger';

type WebMode = 'researcher' | 'controller';

interface WebState {
  chatId?: string;
  mode: WebMode;
  currentUrl: string;
  searchQuery: string;
  isLoading: boolean;
  error: string;
  // Researcher mode state
  searchResults: SearchResult[];
  metaSummary: string;
  relatedTopics: string[];
  // Controller mode state
  pageContent: string;
  pageTitle: string;
  // Activity timeline
  activities: Activity[];
  agentStatus: 'idle' | 'researching' | 'navigating' | 'analyzing';
}

interface SearchResult {
  id: string;
  url: string;
  title: string;
  description: string;
  favicon?: string;
}

interface Activity {
  id: string;
  type: 'checkpoint' | 'search' | 'navigation' | 'analysis';
  icon: string;
  title: string;
  description?: string;
  timestamp: string;
  color: string;
}

interface WebActions {
  setMode: (mode: WebMode) => void;
  setSearchQuery: (query: string) => void;
  setCurrentUrl: (url: string) => void;
  addSearchResult: (result: SearchResult) => void;
  setMetaSummary: (summary: string) => void;
  setRelatedTopics: (topics: string[]) => void;
  setPageContent: (content: string, title: string) => void;
  addActivity: (activity: Omit<Activity, 'id' | 'timestamp'>) => void;
  setAgentStatus: (status: WebState['agentStatus']) => void;
  setError: (error: string) => void;
  clearError: () => void;
}

const WebContext = createContext<(WebState & WebActions) | undefined>(undefined);

export const useWebContext = () => {
  const context = useContext(WebContext);
  if (!context) {
    throw new Error('useWebContext must be used within WebProvider');
  }
  return context;
};

interface WebProviderProps {
  chatId?: string;
  children: React.ReactNode;
}

export const WebProvider: React.FC<WebProviderProps> = ({ chatId, children }) => {
  const [state, setState] = useState<WebState>({
    chatId,
    mode: 'researcher',
    currentUrl: '',
    searchQuery: '',
    isLoading: false,
    error: '',
    searchResults: [],
    metaSummary: '',
    relatedTopics: [],
    pageContent: '',
    pageTitle: '',
    activities: [],
    agentStatus: 'idle',
  });

  const setMode = useCallback((mode: WebMode) => {
    setState(prev => ({ ...prev, mode }));
    logger.info('[WEB_CTX] Mode changed:', mode);
  }, []);

  const setSearchQuery = useCallback((query: string) => {
    setState(prev => ({ ...prev, searchQuery: query }));
  }, []);

  const setCurrentUrl = useCallback((url: string) => {
    setState(prev => ({ ...prev, currentUrl: url }));
  }, []);

  const addSearchResult = useCallback((result: SearchResult) => {
    setState(prev => ({
      ...prev,
      searchResults: [...prev.searchResults, result],
    }));
  }, []);

  const setMetaSummary = useCallback((summary: string) => {
    setState(prev => ({ ...prev, metaSummary: summary }));
  }, []);

  const setRelatedTopics = useCallback((topics: string[]) => {
    setState(prev => ({ ...prev, relatedTopics: topics }));
  }, []);

  const setPageContent = useCallback((content: string, title: string) => {
    setState(prev => ({ ...prev, pageContent: content, pageTitle: title }));
  }, []);

  const addActivity = useCallback((activity: Omit<Activity, 'id' | 'timestamp'>) => {
    const newActivity: Activity = {
      ...activity,
      id: `activity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setState(prev => ({
      ...prev,
      activities: [...prev.activities, newActivity],
    }));
    logger.info('[WEB_CTX] Activity added:', newActivity);
  }, []);

  const setAgentStatus = useCallback((status: WebState['agentStatus']) => {
    setState(prev => ({ ...prev, agentStatus: status }));
  }, []);

  const setError = useCallback((error: string) => {
    setState(prev => ({ ...prev, error, isLoading: false }));
  }, []);

  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: '' }));
  }, []);

  const value: WebState & WebActions = {
    ...state,
    setMode,
    setSearchQuery,
    setCurrentUrl,
    addSearchResult,
    setMetaSummary,
    setRelatedTopics,
    setPageContent,
    addActivity,
    setAgentStatus,
    setError,
    clearError,
  };

  return <WebContext.Provider value={value}>{children}</WebContext.Provider>;
};
