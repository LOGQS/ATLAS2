import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import logger from '../utils/core/logger';
import { apiUrl } from '../config/api';

type WebMode = 'researcher' | 'controller';
type ProfileStatus = 'unknown' | 'missing' | 'ready' | 'setting_up';
export type SessionStatus = 'idle' | 'initializing' | 'ready' | 'profile_missing' | 'error' | 'closed';

interface ProfileInfo {
  name: string;
  path: string;
  file_count: number;
  valid: boolean;
  is_default: boolean;
}

interface BrowserViewportState {
  width: number;
  height: number;
}

type BrowserCommandPayload =
  | { type: 'navigate'; url: string }
  | { type: 'reload' }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'scroll'; deltaX: number; deltaY: number }
  | { type: 'key'; key?: string; text?: string }
  | { type: 'type'; text: string };

interface WebState {
  chatId?: string;
  mode: WebMode;
  currentUrl: string;
  searchQuery: string;
  isLoading: boolean;
  error: string;
  sessionId?: string;
  sessionStatus: SessionStatus;
  viewerUrl?: string;
  viewerReady: boolean;
  viewport: BrowserViewportState;
  activeProfile?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isPageLoading: boolean;
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
  initializeSession: () => Promise<void>;
  setViewerReady: (ready: boolean) => void;
  sendBrowserCommand: (command: BrowserCommandPayload) => Promise<void>;
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
    sessionId: undefined,
    sessionStatus: 'idle',
    viewerUrl: undefined,
    viewerReady: false,
    viewport: { width: 1366, height: 820 },
    activeProfile: undefined,
    canGoBack: false,
    canGoForward: false,
    isPageLoading: false,
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

  useEffect(() => {
    const handleSessionStatus = (event: Event) => {
      const detail = (event as CustomEvent<any>).detail || {};
      logger.info('[WEB_CTX][SESSION_STATUS] Received session update', detail);
      setState(prev => {
        const sessionId = detail.session_id ?? prev.sessionId;
        const status = (detail.status ?? prev.sessionStatus) as SessionStatus;
        const nextViewerUrl =
          sessionId && status === 'ready'
            ? apiUrl(`/api/web/session/${sessionId}/stream?ts=${detail.updated_at ?? Date.now()}`)
            : undefined;

        return {
          ...prev,
          sessionId,
          sessionStatus: status,
          viewerUrl: nextViewerUrl ?? (status === 'ready' ? prev.viewerUrl : undefined),
          viewerReady: status === 'ready' ? prev.viewerReady : false,
          viewport: detail.viewer?.viewport ?? prev.viewport,
          currentUrl: detail.current_url ?? prev.currentUrl,
          pageTitle: detail.page_title ?? prev.pageTitle,
          activeProfile: detail.profile_name ?? prev.activeProfile,
          canGoBack: detail.can_go_back ?? prev.canGoBack,
          canGoForward: detail.can_go_forward ?? prev.canGoForward,
          isPageLoading: detail.is_loading ?? prev.isPageLoading,
        };
      });
    };

    window.addEventListener('webSessionStatus', handleSessionStatus as EventListener);
    return () => window.removeEventListener('webSessionStatus', handleSessionStatus as EventListener);
  }, []);

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

  const initializeSession = useCallback(async () => {
    logger.info('[WEB_CTX][SESSION] Initializing shared browser session', {
      chatId,
      profile: state.activeProfile,
    });
    setState(prev => {
      if (prev.sessionStatus === 'initializing') {
        return prev;
      }
      return {
        ...prev,
        sessionStatus: prev.sessionStatus === 'ready' ? prev.sessionStatus : 'initializing',
        viewerReady: false,
        viewerUrl: prev.viewerUrl,
      };
    });

    try {
      const response = await fetch(apiUrl('/api/web/session'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId,
          profileName: state.activeProfile,
        }),
      });

      const snapshot = await response.json();
      logger.info('[WEB_CTX][SESSION] Session snapshot received', snapshot);
      setState(prev => {
        const sessionId = snapshot.session_id ?? prev.sessionId;
        return {
          ...prev,
          sessionId,
          sessionStatus: (snapshot.status ?? 'error') as SessionStatus,
          viewerUrl:
            sessionId && snapshot.status === 'ready'
              ? apiUrl(`/api/web/session/${sessionId}/stream?ts=${Date.now()}`)
              : prev.viewerUrl,
          viewport: snapshot.viewer?.viewport ?? prev.viewport,
          activeProfile: snapshot.profile_name ?? prev.activeProfile,
          error: snapshot.status === 'error' ? snapshot.last_error || prev.error : prev.error,
          viewerReady: snapshot.status === 'ready' ? prev.viewerReady : false,
        };
      });
    } catch (error) {
      logger.error('[WEB_CTX] Failed to initialize session', error);
      setState(prev => ({
        ...prev,
        sessionStatus: 'error',
        error: 'Failed to initialize browser session',
        viewerUrl: undefined,
        viewerReady: false,
      }));
    }
  }, [chatId, state.activeProfile]);

  const setViewerReady = useCallback((ready: boolean) => {
    logger.info('[WEB_CTX][SESSION] Viewer readiness changed', { ready });
    setState(prev => ({ ...prev, viewerReady: ready }));
  }, []);

  const sendBrowserCommand = useCallback(async (command: BrowserCommandPayload) => {
    if (!state.sessionId) {
      logger.warn('[WEB_CTX] No session available for browser command');
      return;
    }

    try {
      const response = await fetch(apiUrl(`/api/web/session/${state.sessionId}/command`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Command failed with status ${response.status}`);
      }
      logger.info('[WEB_CTX][SESSION] Browser command dispatched', command);
    } catch (error) {
      logger.error('[WEB_CTX] Failed to dispatch browser command', error);
      setState(prev => ({
        ...prev,
        error: 'Failed to control embedded browser',
      }));
    }
  }, [state.sessionId]);

  const checkProfileStatus = useCallback(async () => {
    try {
      logger.info('[PROFILE_CHECK] Fetching profile status from API...');
      const response = await fetch(apiUrl('/api/web/profile/status'));
      const data = await response.json();

      logger.info('[PROFILE_CHECK] API Response:', data);

      if (data.exists) {
        logger.info('[PROFILE_CHECK] Profile EXISTS, setting status to READY');
        setProfileStatus('ready');
      } else {
        logger.info('[PROFILE_CHECK] Profile MISSING, setting status to MISSING');
        setProfileStatus('missing');
      }

      logger.info('[WEB_CTX] Profile status checked:', data);
    } catch (error) {
      logger.error('[PROFILE_CHECK] Error checking profile status:', error);
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
    initializeSession,
    setViewerReady,
    sendBrowserCommand,
    checkProfileStatus,
    loadProfiles,
    launchProfileSetup,
    deleteProfile,
  };

  return <WebContext.Provider value={value}>{children}</WebContext.Provider>;
};
