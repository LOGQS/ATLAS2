import React, { createContext, useContext, useState, useCallback } from 'react';
import logger from '../utils/core/logger';
import { apiUrl } from '../config/api';

type WebMode = 'researcher' | 'controller';
type ProfileStatus = 'unknown' | 'missing' | 'ready' | 'setting_up';

interface ProfileInfo {
  name: string;
  path: string;
  file_count: number;
  valid: boolean;
  is_default: boolean;
}

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
  // Browser profile state
  profileStatus: ProfileStatus;
  profiles: ProfileInfo[];
  showProfileSetup: boolean;
  showBrowserSettings: boolean;
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
  // Profile management
  setProfileStatus: (status: ProfileStatus) => void;
  setProfiles: (profiles: ProfileInfo[]) => void;
  setShowProfileSetup: (show: boolean) => void;
  setShowBrowserSettings: (show: boolean) => void;
  checkProfileStatus: () => Promise<void>;
  loadProfiles: () => Promise<void>;
  launchProfileSetup: () => Promise<void>;
  deleteProfile: (profileName: string) => Promise<boolean>;
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
    profileStatus: 'unknown',
    profiles: [],
    showProfileSetup: false,
    showBrowserSettings: false,
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

  // Profile management actions
  const setProfileStatus = useCallback((status: ProfileStatus) => {
    setState(prev => ({ ...prev, profileStatus: status }));
    logger.info('[WEB_CTX] Profile status changed:', status);
  }, []);

  const setProfiles = useCallback((profiles: ProfileInfo[]) => {
    setState(prev => ({ ...prev, profiles }));
  }, []);

  const setShowProfileSetup = useCallback((show: boolean) => {
    setState(prev => ({ ...prev, showProfileSetup: show }));
  }, []);

  const setShowBrowserSettings = useCallback((show: boolean) => {
    setState(prev => ({ ...prev, showBrowserSettings: show }));
  }, []);

  const checkProfileStatus = useCallback(async () => {
    try {
      const response = await fetch(apiUrl('/api/web/profile/status'));
      const data = await response.json();

      if (data.exists) {
        setProfileStatus('ready');
      } else {
        setProfileStatus('missing');
      }

      logger.info('[WEB_CTX] Profile status checked:', data);
    } catch (error) {
      logger.error('[WEB_CTX] Error checking profile status:', error);
      setError('Failed to check browser profile status');
    }
  }, [setProfileStatus, setError]);

  const loadProfiles = useCallback(async () => {
    try {
      const response = await fetch(apiUrl('/api/web/profiles'));
      const data = await response.json();

      setProfiles(data.profiles || []);
      logger.info('[WEB_CTX] Loaded profiles:', data.profiles);
    } catch (error) {
      logger.error('[WEB_CTX] Error loading profiles:', error);
      setError('Failed to load browser profiles');
    }
  }, [setProfiles, setError]);

  const launchProfileSetup = useCallback(async () => {
    try {
      setProfileStatus('setting_up');

      const response = await fetch(apiUrl('/api/web/profile/setup'), {
        method: 'POST',
      });

      const data = await response.json();

      if (data.success) {
        logger.info('[WEB_CTX] Profile setup launched successfully');
        // Profile status will be updated after user completes setup
      } else {
        setError(data.error || 'Failed to launch profile setup');
        setProfileStatus('missing');
      }
    } catch (error) {
      logger.error('[WEB_CTX] Error launching profile setup:', error);
      setError('Failed to launch profile setup');
      setProfileStatus('missing');
    }
  }, [setProfileStatus, setError]);

  const deleteProfile = useCallback(async (profileName: string): Promise<boolean> => {
    try {
      const response = await fetch(apiUrl(`/api/web/profiles/${encodeURIComponent(profileName)}`), {
        method: 'DELETE',
      });

      const data = await response.json();

      if (data.success) {
        logger.info('[WEB_CTX] Profile deleted:', profileName);
        // Reload profiles list
        await loadProfiles();
        return true;
      } else {
        setError(data.error || 'Failed to delete profile');
        return false;
      }
    } catch (error) {
      logger.error('[WEB_CTX] Error deleting profile:', error);
      setError('Failed to delete profile');
      return false;
    }
  }, [loadProfiles, setError]);

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
    setProfileStatus,
    setProfiles,
    setShowProfileSetup,
    setShowBrowserSettings,
    checkProfileStatus,
    loadProfiles,
    launchProfileSetup,
    deleteProfile,
  };

  return <WebContext.Provider value={value}>{children}</WebContext.Provider>;
};
