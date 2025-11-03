// status: complete

import React, { useState, useRef, useEffect, useCallback, useMemo} from 'react';
import './styles/app/App.css';
import LeftSidebar from './components/layout/LeftSidebar';
import RightSidebar from './components/layout/RightSidebar';
import Chat from './components/chat/Chat';
import ModalWindow from './components/ui/ModalWindow';
import GlobalFileViewer from './components/ui/GlobalFileViewer';
import AttachedFiles from './components/files/AttachedFiles';
import ChatVersionsWindow from './components/chat/ChatVersionsWindow';
import ContextWindow from './components/chat/ContextWindow';
import { Icons } from './components/ui/Icons';
import SendButton from './components/input/SendButton';
import VoiceChatMuteButton from './components/input/VoiceChatMuteButton';
import MessageInputArea from './components/input/MessageInputArea';
import KnowledgeSection from './sections/KnowledgeSection';
import GalleryWindow from './sections/GalleryWindow';
import SearchWindow from './sections/SearchWindow';
import SettingsWindow from './sections/SettingsWindow';
import WorkspaceWindow from './sections/WorkspaceWindow';
import SourcesWindow from './sections/SourcesWindow';
import CoderWindow from './sections/CoderWindow';
import TriggerLog from './components/visualization/TriggerLog'; // TEMPORARY_DEBUG_TRIGGERLOG
import logger from './utils/core/logger';
import { performanceTracker } from './utils/core/performanceTracker';
import { apiUrl, fetchBackendConfig } from './config/api';
import { DEFAULT_MAX_CONCURRENT_STREAMS, DEBUG_TOOLS_CONFIG } from './config/chat';
import { BrowserStorage } from './utils/storage/BrowserStorage';
import { liveStore, sendButtonStateManager } from './utils/chat/LiveStore';
import { chatHistoryCache, type BackendStateSnapshot } from './utils/chat/ChatHistoryCache';
import { useAppState } from './hooks/app/useAppState';
import { useFileManagement } from './hooks/files/useFileManagement';
import { useDragDrop } from './hooks/files/useDragDrop';
import { useVoiceChat } from './hooks/audio/useVoiceChat';
import { useBottomInputToggle } from './hooks/ui/useBottomInputToggle';
import { useBulkOperations } from './hooks/chat/useBulkOperations';
import type { AttachedFile } from './types/messages';
// TEST_FRAMEWORK_IMPORT - Remove this line and the next to remove test framework
import TestUI from './tests/versioning/TestUI';

interface ChatItem {
  id: string;
  name: string;
  isActive: boolean;
  state?: 'thinking' | 'responding' | 'static';
  last_active?: string;
}

interface LoadChatsResult {
  ids: string[];
  backendState: BackendStateSnapshot;
}

const ALLOWED_BACKEND_STATUSES = new Set<BackendStateSnapshot['status']>([
  'unknown',
  'initializing',
  'ready',
  'degraded'
]);

const createDefaultBackendState = (): BackendStateSnapshot => ({
  status: 'unknown',
  completed: false,
  success: null,
  error: null,
  summary: null,
  resetCount: 0
});

const normalizeBackendState = (raw: any): BackendStateSnapshot => {
  if (!raw || typeof raw !== 'object') {
    return createDefaultBackendState();
  }

  const statusValue = typeof raw.status === 'string' ? raw.status : 'unknown';
  const status = ALLOWED_BACKEND_STATUSES.has(statusValue as BackendStateSnapshot['status'])
    ? (statusValue as BackendStateSnapshot['status'])
    : 'unknown';

  const success = typeof raw.success === 'boolean' ? raw.success : null;
  const completed = typeof raw.completed === 'boolean' ? raw.completed : Boolean(success);
  const error = typeof raw.error === 'string' ? raw.error : null;
  const summary = raw.summary && typeof raw.summary === 'object' ? raw.summary as Record<string, unknown> : null;
  const resetCount = typeof raw.reset_count === 'number'
    ? raw.reset_count
    : typeof raw.resetCount === 'number'
      ? raw.resetCount
      : 0;

  return {
    status,
    completed,
    success,
    error,
    summary,
    resetCount
  };
};


type SendMessageOptions = {
  message: string;
  attachments?: AttachedFile[];
  clearInput?: boolean;
  clearAttachments?: boolean;
  source?: 'manual' | 'voice';
};

const PENDING_FIRST_MESSAGES_STORAGE_KEY = 'atlas_pending_first_messages_v1';
const PENDING_CHAT_META_STORAGE_KEY = 'atlas_pending_chat_meta_v1';
const WORKSPACE_SELECTION_STORAGE_KEY = 'atlas_workspace_selection_chat_id';

interface PendingChatMeta {
  activeChatId: string | null;
  updatedAt: number;
}

type PendingFirstMessageStatus = 'pending' | 'dispatching';

type PendingDispatchSource = 'active' | 'bootstrap';

interface PendingFirstMessageRecord {
  message: string;
  files?: AttachedFile[];
  name?: string;
  status: PendingFirstMessageStatus;
  createdAt: number;
  lastAttemptAt?: number;
  bootstrapAttemptAt?: number;
  dispatchSource?: PendingDispatchSource;
}

const parsePendingFirstMessage = (raw: string): PendingFirstMessageRecord | null => {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const record: PendingFirstMessageRecord = {
      message: typeof parsed.message === 'string' ? parsed.message : '',
      files: Array.isArray(parsed.files) ? parsed.files : undefined,
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : undefined,
      status: parsed.status === 'dispatching' ? 'dispatching' : 'pending',
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
      lastAttemptAt: typeof parsed.lastAttemptAt === 'number' ? parsed.lastAttemptAt : undefined,
      bootstrapAttemptAt: typeof parsed.bootstrapAttemptAt === 'number' ? parsed.bootstrapAttemptAt : undefined,
      dispatchSource: parsed.dispatchSource === 'active' || parsed.dispatchSource === 'bootstrap' ? parsed.dispatchSource : undefined
    };
    if (!record.message.trim()) {
      return null;
    }
    return record;
  } catch (error) {
    logger.warn('[FIRST_MSG][PARSE_ERROR] Failed to parse pending message payload', { error: String(error) });
    return null;
  }
};

const serializePendingFirstMessage = (record: PendingFirstMessageRecord): string => {
  return JSON.stringify(record);
};

const derivePendingChatName = (record: PendingFirstMessageRecord, fallback: string = 'New Chat'): string => {
  if (record.name && record.name.trim()) {
    return record.name;
  }
  if (record.message && record.message.trim()) {
    const candidate = record.message.split(' ').slice(0, 4).join(' ').trim();
    if (candidate) {
      return candidate;
    }
  }
  return fallback;
};

const loadPendingFirstMessagesFromStorage = (): Map<string, string> => {
  if (typeof window === 'undefined') {
    return new Map();
  }
  try {
    const raw = window.localStorage.getItem(PENDING_FIRST_MESSAGES_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }
    const parsed = JSON.parse(raw) as Record<string, string> | null;
    if (!parsed || typeof parsed !== 'object') {
      return new Map();
    }
    return new Map(Object.entries(parsed));
  } catch (error) {
    logger.warn('[FIRST_MSG][HYDRATE_ERROR] Failed to load pending messages from storage', { error: String(error) });
    return new Map();
  }
};

const buildInitialChatsFromPending = (pending: Map<string, string>, activeChatId: string | null): ChatItem[] => {
  if (!pending.size) {
    return [];
  }

  const chats: ChatItem[] = [];
  pending.forEach((raw, chatId) => {
    const record = parsePendingFirstMessage(raw);
    if (!record) {
      return;
    }
    chats.push({
      id: chatId,
      name: derivePendingChatName(record),
      isActive: activeChatId === chatId,
      state: 'static'
    });
  });

  return chats;
};

function App() {
  const storedPendingMetaRaw = typeof window !== 'undefined'
    ? window.localStorage.getItem(PENDING_CHAT_META_STORAGE_KEY)
    : null;

  let initialPendingMeta: PendingChatMeta | null = null;
  if (storedPendingMetaRaw) {
    try {
      initialPendingMeta = JSON.parse(storedPendingMetaRaw) as PendingChatMeta;
    } catch (error) {
      logger.warn('[FIRST_MSG][META_PARSE_ERROR] Failed to parse pending chat meta from storage', { error: String(error) });
    }
  }

  const initialPendingChatId = initialPendingMeta?.activeChatId || null;

  // Cache the initial pending messages to avoid duplicate localStorage reads during initialization
  const initialPendingRef = useRef<Map<string, string> | undefined>(undefined);

  const [message, setMessage] = useState('');
  const [hasMessageBeenSent, setHasMessageBeenSent] = useState(() => Boolean(initialPendingChatId));
  const [centerFading, setCenterFading] = useState(() => Boolean(initialPendingChatId));
  const [pendingFirstMessages, setPendingFirstMessagesState] = useState<Map<string, string>>(() => {
    if (initialPendingRef.current === undefined) {
      initialPendingRef.current = loadPendingFirstMessagesFromStorage();
    }
    return initialPendingRef.current;
  });
  const [chats, setChats] = useState<ChatItem[]>(() => buildInitialChatsFromPending(initialPendingRef.current!, initialPendingChatId));
  const [activeChatId, setActiveChatId] = useState<string>(() => initialPendingChatId || 'none');
  const [isAppInitialized, setIsAppInitialized] = useState(false);
  const [forceRender, setForceRender] = useState(0);
  const [sendDisabledFlag, setSendDisabledFlag] = useState(false);
  const [sendingByChat, setSendingByChat] = useState<Map<string, boolean>>(new Map());
  const [isStopRequestInFlight, setIsStopRequestInFlight] = useState(false);
  const [maxConcurrentStreams, setMaxConcurrentStreams] = useState<number>(DEFAULT_MAX_CONCURRENT_STREAMS);
  const [workspaceSelectionChatId, setWorkspaceSelectionChatId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY);
    }
    return null;
  });

  const [globalViewerOpen, setGlobalViewerOpen] = useState(false);
  const [globalViewerFile, setGlobalViewerFile] = useState<any>(null);
  const [globalViewerSubrenderer, setGlobalViewerSubrenderer] = useState<React.ComponentType<any> | undefined>(undefined);

  const centerInputRef = useRef<HTMLTextAreaElement>(null);
  const bottomInputRef = useRef<HTMLTextAreaElement>(null);
  const chatRef = useRef<any>(null);

  const voiceTranscriptQueueRef = useRef<string[]>([]);
  const isProcessingVoiceQueueRef = useRef(false);
  const flushVoiceQueueRef = useRef<(() => void) | null>(null);
  const voiceChatActivationChatIdRef = useRef<string | null>(null);
  const awaitingAIResponseRef = useRef(false);
  const [isProcessingSegment, setIsProcessingSegment] = useState(false);
  const [isSendingVoiceMessage, setIsSendingVoiceMessage] = useState(false);

  const persistPendingFirstMessages = useCallback((map: Map<string, string>) => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      if (map.size === 0) {
        window.localStorage.removeItem(PENDING_FIRST_MESSAGES_STORAGE_KEY);
      } else {
        const serialized = JSON.stringify(Object.fromEntries(map));
        window.localStorage.setItem(PENDING_FIRST_MESSAGES_STORAGE_KEY, serialized);
      }
    } catch (error) {
      logger.warn('[FIRST_MSG][PERSIST_ERROR] Failed to persist pending messages', { error: String(error) });
    }
  }, []);

  const persistPendingChatMeta = useCallback((meta: PendingChatMeta | null) => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      if (!meta || !meta.activeChatId) {
        window.localStorage.removeItem(PENDING_CHAT_META_STORAGE_KEY);
      } else {
        window.localStorage.setItem(PENDING_CHAT_META_STORAGE_KEY, JSON.stringify(meta));
      }
    } catch (error) {
      logger.warn('[FIRST_MSG][META_PERSIST_ERROR] Failed to persist pending chat meta', { error: String(error) });
    }
  }, []);

  const getPendingChatMeta = useCallback((): PendingChatMeta | null => {
    if (typeof window === 'undefined') {
      return null;
    }

    try {
      const raw = window.localStorage.getItem(PENDING_CHAT_META_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as PendingChatMeta;
    } catch (error) {
      logger.warn('[FIRST_MSG][META_READ_ERROR] Failed to read pending chat meta', { error: String(error) });
      return null;
    }
  }, []);

  const clearPendingChatMeta = useCallback((chatId?: string | null) => {
    const meta = getPendingChatMeta();
    if (!meta) {
      persistPendingChatMeta(null);
      return;
    }

    if (!chatId || meta.activeChatId === chatId) {
      persistPendingChatMeta(null);
    }
  }, [getPendingChatMeta, persistPendingChatMeta]);

  const clearWorkspaceSelection = useCallback(() => {
    if (typeof window === 'undefined') return;
    setWorkspaceSelectionChatId(null);
    localStorage.removeItem(WORKSPACE_SELECTION_STORAGE_KEY);
  }, []);

  const setWorkspaceSelectionForChat = useCallback((chatId: string) => {
    if (typeof window === 'undefined') return;
    setWorkspaceSelectionChatId(chatId);
    localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY, chatId);
  }, []);

  const setPendingFirstMessages = useCallback<React.Dispatch<React.SetStateAction<Map<string, string>>>>((value) => {
    setPendingFirstMessagesState(prev => {
      const next = (typeof value === 'function'
        ? (value as (prevState: Map<string, string>) => Map<string, string>)(prev)
        : value) as Map<string, string>;

      persistPendingFirstMessages(next);
      return next;
    });
  }, [persistPendingFirstMessages]);

  const updatePendingFirstMessage = useCallback((chatId: string, mutator: (existing: PendingFirstMessageRecord | null) => PendingFirstMessageRecord | null) => {
    setPendingFirstMessages(prev => {
      const next = new Map(prev);
      const currentRaw = next.get(chatId) ?? null;
      const currentRecord = currentRaw ? parsePendingFirstMessage(currentRaw) : null;
      const updatedRecord = mutator(currentRecord);

      if (!updatedRecord) {
        next.delete(chatId);
      } else {
        next.set(chatId, serializePendingFirstMessage(updatedRecord));
      }

      return next;
    });
  }, [setPendingFirstMessages]);

  const ensurePendingChatBootstrap = useCallback(async (chatId: string, payload: PendingFirstMessageRecord) => {
    logger.info('[FIRST_MSG][BOOTSTRAP] Ensuring chat state for pending chat', { chatId, hasName: Boolean(payload.name) });

    try {
      const response = await fetch(apiUrl('/api/db/chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          system_prompt: null
        })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({} as any));
        if (data?.message !== 'Chat already exists') {
          logger.warn('[FIRST_MSG][BOOTSTRAP] Chat create returned error', { chatId, status: response.status, data });
        }
      }
    } catch (error) {
      logger.error('[FIRST_MSG][BOOTSTRAP] Error ensuring chat exists', { chatId, error });
    }

    if (payload.name && payload.name.trim()) {
      try {
        await fetch(apiUrl(`/api/db/chat/${chatId}/name`), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name: payload.name })
        });
      } catch (error) {
        logger.warn('[FIRST_MSG][BOOTSTRAP] Failed to apply pending chat name', { chatId, error });
      }
    }
  }, []);

  useEffect(() => {
    if (!pendingFirstMessages.size) {
      return;
    }

    pendingFirstMessages.forEach((raw, chatId) => {
      const record = parsePendingFirstMessage(raw);
      if (!record) {
        updatePendingFirstMessage(chatId, () => null);
        return;
      }

      if (record.status && record.status !== 'pending') {
        logger.debug('[FIRST_MSG][INIT_DISPATCH] Skipping dispatch - status not pending', { chatId, status: record.status, dispatchSource: record.dispatchSource });
        return;
      }

      const now = Date.now();
      const lastBootstrapAttempt = record.bootstrapAttemptAt ?? 0;
      if (now - lastBootstrapAttempt < 5000) {
        return;
      }

      const timestamp = now;
      updatePendingFirstMessage(chatId, (current) => {
        if (!current) {
          return {
            ...record,
            bootstrapAttemptAt: timestamp
          };
        }
        return {
          ...current,
          bootstrapAttemptAt: timestamp
        };
      });

      void ensurePendingChatBootstrap(chatId, {
        ...record,
        bootstrapAttemptAt: timestamp
      });
    });
  }, [ensurePendingChatBootstrap, pendingFirstMessages, updatePendingFirstMessage]);

  const enqueueVoiceTranscript = useCallback((text: string) => {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) {
      logger.warn('[VOICE_CHAT] Ignoring empty transcription result');
      return;
    }

    if (!/[A-Za-z0-9]/.test(trimmed)) {
      logger.warn('[VOICE_CHAT] Ignoring punctuation-only transcription result', { text: trimmed });
      return;
    }

    if (awaitingAIResponseRef.current) {
      logger.info('[VOICE_CHAT] Discarding transcription while awaiting AI response', { text: trimmed });
      return;
    }

    voiceTranscriptQueueRef.current.push(trimmed);
    logger.info('[VOICE_CHAT] Queued transcribed voice message', { queueLength: voiceTranscriptQueueRef.current.length });
    flushVoiceQueueRef.current?.();
  }, []);

  const handleTranscriptionComplete = useCallback((text: string, context: { source: 'manual' | 'auto' }) => {
    if (context.source === 'auto') {
      enqueueVoiceTranscript(text);
      return;
    }

    setMessage(prev => {
      const newText = prev ? `${prev} ${text}` : text;
      logger.info('[STT_TRANSCRIBE] Transcription successful, text added to input:', text);
      return newText;
    });
  }, [enqueueVoiceTranscript]);

  const {
    isBottomInputToggled,
    isBottomInputHovering,
    showToggleOutline,
    setIsBottomInputHovering,
    handleBottomInputDoubleClick,
    resetToggleOutlineTimer
  } = useBottomInputToggle();

  const isAwaitingResponseCallback = useCallback(() => {
    return awaitingAIResponseRef.current;
  }, []);

  const {
    isButtonHeld,
    wasHoldCompleted,
    isRecording,
    isSoundDetected,
    isVoiceChatMode,
    isMicMuted,
    handleButtonHoldStart,
    handleButtonHoldEnd,
    toggleMicMute,
    setMicMuted,
    setVoiceChatMode,
    restartListeningIfNeeded
  } = useVoiceChat({
    onTranscriptionComplete: handleTranscriptionComplete,
    onSpeechStart: () => {
      if (chatRef.current?.stopAllTTS) {
        logger.info('[VOICE_CHAT] User speech detected - stopping TTS playback');
        chatRef.current.stopAllTTS();
      }
    },
    onSegmentProcessing: (processing) => {
      setIsProcessingSegment(processing);
    },
    isAwaitingResponse: isAwaitingResponseCallback
  });


  const enableVoiceChatMode = useCallback((source: 'center' | 'bottom' | 'system', reason?: string) => {
    const targetChatId = activeChatId === 'none' ? null : activeChatId;

    voiceChatActivationChatIdRef.current = targetChatId;

    setVoiceChatMode(prev => {
      if (prev) {
        return prev;
      }
      const logChatId = targetChatId ?? 'pending-assignment';
      logger.info(`[VOICE_CHAT] Live voice chat enabled for chat ${logChatId} via ${source}${reason ? ` (${reason})` : ''}`);
      return true;
    });
  }, [activeChatId, setVoiceChatMode]);

  const disableVoiceChatMode = useCallback((source: 'center' | 'bottom' | 'system', reason?: string) => {
    const assignedChatId = voiceChatActivationChatIdRef.current;
    voiceChatActivationChatIdRef.current = null;

    if (isMicMuted) {
      setMicMuted(false);
    }

    setVoiceChatMode(prev => {
      if (!prev) {
        return prev;
      }
      const logChatId = assignedChatId ?? (activeChatId === 'none' ? 'pending-assignment' : activeChatId);
      logger.info(`[VOICE_CHAT] Live voice chat disabled for chat ${logChatId} via ${source}${reason ? ` (${reason})` : ''}`);
      return false;
    });
  }, [activeChatId, isMicMuted, setMicMuted, setVoiceChatMode]);

  const handleMicMuteToggle = useCallback(() => {
    toggleMicMute();
  }, [toggleMicMute]);

  const handleVoiceChatToggle = useCallback((source: 'center' | 'bottom' | 'system', reason: string = 'click') => {
    if (isVoiceChatMode) {
      disableVoiceChatMode(source, reason);
    } else {
      enableVoiceChatMode(source, reason);
    }
  }, [disableVoiceChatMode, enableVoiceChatMode, isVoiceChatMode]);

  const handleVoiceChatClick = useCallback((source: 'center' | 'bottom') => {
    handleVoiceChatToggle(source, 'click');
  }, [handleVoiceChatToggle]);

  useEffect(() => {
    if (message.trim() && isVoiceChatMode) {
      disableVoiceChatMode('system', 'user-typing');
    }
  }, [message, isVoiceChatMode, disableVoiceChatMode]);

  useEffect(() => {
    if (!isVoiceChatMode) {
      return;
    }

    const assignedChatId = voiceChatActivationChatIdRef.current;

    if (!assignedChatId) {
      if (activeChatId !== 'none') {
        voiceChatActivationChatIdRef.current = activeChatId;
        logger.info(`[VOICE_CHAT] Pending live voice chat bound to chat ${activeChatId}`);
      }
      return;
    }

    if (activeChatId === 'none') {
      disableVoiceChatMode('system', 'active-chat-cleared');
      return;
    }

    if (activeChatId !== assignedChatId) {
      disableVoiceChatMode('system', 'chat-changed');
    }
  }, [activeChatId, isVoiceChatMode, disableVoiceChatMode]);

  useEffect(() => {
    if (activeChatId === 'none') {
      return;
    }

    const assignedChatId = voiceChatActivationChatIdRef.current;
    if (assignedChatId && assignedChatId !== activeChatId) {
      setMicMuted(false);
    }
  }, [activeChatId, setMicMuted]);

  const setIsMessageBeingSent = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((value) => {
    setSendingByChat(prev => {
      const next = new Map(prev);
      if (activeChatId && activeChatId !== 'none') {
        const current = prev.get(activeChatId) ?? false;
        const final = typeof value === 'function' ? (value as (prevState: boolean) => boolean)(current) : value;
        next.set(activeChatId, final);
      }
      return next;
    });
  }, [activeChatId]);

  const { activeModal, handleOpenModal, handleCloseModal } = useAppState();
  const isCoderVisible = activeModal === 'coder';
  const {
    attachedFiles,
    fileInputRef,
    hasUnreadyFiles,
    initializeAttachedFiles,
    handleAddFileClick,
    handleFileSelect,
    handleFileSelectionImmediate,
    handleRemoveFile,
    clearAttachedFiles,
    handleClearAllFiles
  } = useFileManagement(isAppInitialized);


  const chatSwitchTokenRef = useRef(0);
  const activeChatSyncAbortRef = useRef<AbortController | null>(null);

  const loadChatsFromDatabase = useCallback(async (options?: { expectedToken?: number }): Promise<LoadChatsResult | null | void> => {
    try {
      logger.info('[App.loadChatsFromDatabase] Loading chats from database');
      const response = await fetch(apiUrl('/api/db/chats'));
      const data = await response.json();
      const backendState = normalizeBackendState((data as any)?.backendState);

      if (options?.expectedToken && options.expectedToken !== chatSwitchTokenRef.current) {
        return;
      }

      if (response.ok) {
        if (!Array.isArray(data.chats)) {
          logger.warn('[App.loadChatsFromDatabase] Unexpected payload: missing chats array');
          return null;
        }

        logger.info(`[App.loadChatsFromDatabase] Successfully loaded chats: ${data.chats.length} (backend status=${backendState.status})`);
        const chatsFromDb = data.chats.map((chat: any) => ({
          id: chat.id,
          name: chat.name,
          isActive: chat.isActive,
          state: chat.state || 'static',
          last_active: chat.last_active
        }));

        const chatMap = new Map<string, ChatItem>();
        chatsFromDb.forEach((chat: ChatItem) => {
          chatMap.set(chat.id, { ...chat });
        });

        const pendingRecords = new Map<string, PendingFirstMessageRecord>();

        pendingFirstMessages.forEach((serialized, pendingChatId) => {
          const record = parsePendingFirstMessage(serialized);
          if (!record) {
            logger.warn('[FIRST_MSG][LOAD_MERGE] Invalid pending payload encountered, clearing', { pendingChatId });
            updatePendingFirstMessage(pendingChatId, () => null);
            return;
          }
          pendingRecords.set(pendingChatId, record);
        });

        const meta = getPendingChatMeta();
        const pendingActiveChatId = meta?.activeChatId ?? null;

        pendingRecords.forEach((pendingRecord, pendingChatId) => {
          const existing = chatMap.get(pendingChatId);
          const derivedName = derivePendingChatName(pendingRecord);
          if (existing) {
            if (!existing.name || !existing.name.trim() || existing.name === 'New Chat') {
              logger.info('[FIRST_MSG][LOAD_MERGE] Overriding backend chat name with pending name', {
                pendingChatId,
                derivedName
              });
              existing.name = derivedName;
            }
          } else {
            logger.info('[FIRST_MSG][LOAD_MERGE] Injecting pending chat into sidebar', {
              pendingChatId,
              derivedName
            });
            chatMap.set(pendingChatId, {
              id: pendingChatId,
              name: derivedName,
              isActive: false,
              state: 'static'
            });
          }
        });

        const dbActiveChatId = chatsFromDb.find((chat: ChatItem) => chat.isActive)?.id || null;

        const shouldRestorePendingActiveChat =
          !options?.expectedToken &&
          pendingActiveChatId &&
          pendingFirstMessages.has(pendingActiveChatId) &&
          (activeChatId === 'none' || activeChatId === pendingActiveChatId);

        if (shouldRestorePendingActiveChat) {
          setActiveChatId(pendingActiveChatId);
          setHasMessageBeenSent(true);
          setCenterFading(true);
        }

        const nextActiveChatId = (() => {
          if (shouldRestorePendingActiveChat && pendingActiveChatId) {
            return pendingActiveChatId;
          }
          if (activeChatId !== 'none') {
            return activeChatId;
          }
          if (dbActiveChatId) {
            return dbActiveChatId;
          }
          return 'none';
        })();

        const mergedChats = Array.from(chatMap.values()).map(chat => ({
          ...chat,
          isActive: chat.id === nextActiveChatId
        }));

        const settings = BrowserStorage.getUISettings();
        if (settings.chatOrder && settings.chatOrder.length > 0) {
          const orderedChats: ChatItem[] = [];
          const orderedMap = new Map<string, ChatItem>(mergedChats.map((chat: ChatItem) => [chat.id, chat]));

          settings.chatOrder.forEach(chatId => {
            if (orderedMap.has(chatId)) {
              const chat = orderedMap.get(chatId);
              if (chat) {
                orderedChats.push(chat);
                orderedMap.delete(chatId);
              }
            }
          });

          orderedMap.forEach((chat) => {
            orderedChats.push(chat);
          });

          setChats(orderedChats);
        } else {
          setChats(mergedChats);
        }

        // Return the loaded chat IDs for validation alongside backend state context
        return {
          ids: chatsFromDb.map((chat: ChatItem) => chat.id),
          backendState
        };
      } else {
        logger.error('[App.loadChatsFromDatabase] Failed to load chats:', data.error);
        return null;
      }
    } catch (error) {
      logger.error('[App.loadChatsFromDatabase] Failed to load chats:', error);
      return null;
    }
  }, [activeChatId, getPendingChatMeta, pendingFirstMessages, setCenterFading, setHasMessageBeenSent, setActiveChatId, updatePendingFirstMessage]);

  const { handleBulkDelete, handleBulkExport, handleBulkImport } = useBulkOperations({
    setChats,
    setPendingFirstMessages,
    handleNewChat: () => handleNewChat(),
    loadChatsFromDatabase,
    clearPendingChatMeta
  });

  // Clean up pending messages that no longer have corresponding chats
  useEffect(() => {
    if (!isAppInitialized || !pendingFirstMessages.size) {
      return;
    }

    const validIds = new Set(chats.map(chat => chat.id));

    setPendingFirstMessages(prev => {
      if (!prev.size) {
        return prev;
      }

      let mutated = false;
      const next = new Map<string, string>();

      prev.forEach((value, key) => {
        if (validIds.has(key)) {
          next.set(key, value);
        } else {
          mutated = true;
        }
      });

      return mutated ? next : prev;
    });
    // Note: pendingFirstMessages excluded from deps - we use updater form and size check is just optimization
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, isAppInitialized, setPendingFirstMessages]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    if (activeChatId !== 'none') {
      document.body.classList.add('chat-active');
    } else {
      document.body.classList.remove('chat-active');
    }
  }, [activeChatId]);

  const handleFirstMessageSent = useCallback((chatId: string) => {
    logger.info('[FIRST_MSG][ACTIVE_DISPATCH] First message dispatched via component', { chatId });
    updatePendingFirstMessage(chatId, (record) => {
      if (!record) {
        return null;
      }
      return {
        ...record,
        status: 'dispatching',
        lastAttemptAt: Date.now(),
        dispatchSource: 'active'
      };
    });
  }, [updatePendingFirstMessage]);

  const handleMessageAcknowledged = useCallback((chatId: string, _message?: string) => {
    if (!chatId || chatId === 'none') {
      return;
    }
    logger.info('[FIRST_MSG][ACK] First message acknowledged by backend', { chatId });
    updatePendingFirstMessage(chatId, () => null);
    clearPendingChatMeta(chatId);
  }, [clearPendingChatMeta, updatePendingFirstMessage]);

  useEffect(() => {
    if (!isAppInitialized) {
      return;
    }
    if (!activeChatId || activeChatId === 'none') {
      return;
    }

    const raw = pendingFirstMessages.get(activeChatId);
    if (!raw) {
      return;
    }

    const record = parsePendingFirstMessage(raw);
    if (!record) {
      updatePendingFirstMessage(activeChatId, () => null);
      return;
    }

    if (record.status !== 'dispatching' || record.dispatchSource !== 'active') {
      return;
    }
    if (!chatRef.current || typeof chatRef.current.handleNewMessage !== 'function') {
      return;
    }

    const isChatBusy = chatRef.current.isBusy?.() ?? false;
    if (isChatBusy) {
      return;
    }

    if (!record.message?.trim()) {
      logger.warn('[FIRST_MSG][ACTIVE_DISPATCH] Missing content, clearing entry', { chatId: activeChatId });
      updatePendingFirstMessage(activeChatId, () => null);
      return;
    }

    const now = Date.now();
    const lastAttempt = record.lastAttemptAt ?? 0;
    if (now - lastAttempt < 750) {
      return;
    }

    logger.info('[FIRST_MSG][ACTIVE_DISPATCH] Dispatching via mounted chat component', {
      chatId: activeChatId,
      preview: record.message.slice(0, 64)
    });

    updatePendingFirstMessage(activeChatId, (current) => {
      if (!current) {
        return null;
      }
      return {
        ...current,
        status: 'dispatching',
        lastAttemptAt: now,
        dispatchSource: 'active'
      };
    });

    try {
      chatRef.current.handleNewMessage(record.message, record.files || []);
    } catch (error) {
      logger.error('[FIRST_MSG][ACTIVE_DISPATCH] Failed to dispatch via chatRef', { chatId: activeChatId, error });
      updatePendingFirstMessage(activeChatId, (current) => {
        if (!current) {
          return null;
        }
        return {
          ...current,
          status: 'pending',
          dispatchSource: undefined
        };
      });
    }
  }, [activeChatId, isAppInitialized, pendingFirstMessages, updatePendingFirstMessage]);

  useEffect(() => {
    if (isAppInitialized) return;

    const initializeApp = async () => {
      logger.info('[App.useEffect] Initializing app');
      liveStore.start();

      // Fetch backend configuration (execution mode, concurrent limits, etc.)
      const config = await fetchBackendConfig();
      setMaxConcurrentStreams(config.maxConcurrentChats);
      logger.info(`[App.useEffect] Backend config loaded: maxConcurrentChats=${config.maxConcurrentChats}, executionMode=${config.executionMode}`);

      const loadedChats = await loadChatsFromDatabase();

      // Validate cache on startup - prune any cached chats that no longer exist in backend
      if (loadedChats && Array.isArray(loadedChats.ids)) {
        const { ids, backendState } = loadedChats;
        logger.info(`[App.useEffect] Loaded ${ids.length} chats (backend status=${backendState.status}), validating cache`);
        chatHistoryCache.validateAgainstBackend(ids, { backendState, source: 'startup' });

        if (ids.length === 0) {
          if (backendState.status === 'ready') {
            logger.info('[App.useEffect] Backend reports zero chats after initialization; cache cleared if needed');
          } else {
            logger.warn(`[App.useEffect] Backend returned zero chats but status=${backendState.status}; preserved local cache as safeguard`);
          }
        }
      } else if (loadedChats === null) {
        logger.warn('[App.useEffect] Failed to load chats from backend - skipping cache validation to preserve existing cache');
      } else {
        logger.info('[App.useEffect] Skipping cache validation because chat load returned without data');
      }

      // Kick off pending first messages even if the chat isn't opened yet.
      pendingFirstMessages.forEach((raw, chatId) => {
        const record = parsePendingFirstMessage(raw);
        if (!record) {
          updatePendingFirstMessage(chatId, () => null);
          return;
        }

        if (!record.message?.trim()) {
          logger.warn('[FIRST_MSG][INIT_DISPATCH] Skipping pending entry with no content', { chatId });
          updatePendingFirstMessage(chatId, () => null);
          return;
        }

        if (record.status === 'dispatching') {
          return;
        }

        const now = Date.now();
        updatePendingFirstMessage(chatId, (current) => {
          if (!current) {
            return {
              ...record,
              status: 'dispatching',
              lastAttemptAt: now
            };
          }
        return {
          ...current,
          status: 'dispatching',
          lastAttemptAt: now,
          dispatchSource: 'bootstrap'
        };
      });

        void (async () => {
          try {
            await ensurePendingChatBootstrap(chatId, record);

            const controller = new AbortController();
            const response = await fetch(apiUrl('/api/chat/stream'), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                message: record.message,
                chat_id: chatId,
                include_reasoning: true,
                client_id: (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
                  ? crypto.randomUUID()
                  : `pending_bootstrap_${chatId}_${now}`,
                attached_file_ids: Array.isArray(record.files) ? record.files.map(file => file.id).filter(Boolean) : []
              }),
              signal: controller.signal
            });

            if (!response.ok) {
              const payload = await response.json().catch(() => ({} as any));
              logger.error('[FIRST_MSG][INIT_DISPATCH] Backend rejected pending message', {
                chatId,
                status: response.status,
                payload
              });
              updatePendingFirstMessage(chatId, (current) => {
                if (!current) {
                  return null;
                }
                return {
                  ...current,
                  status: 'pending',
                  dispatchSource: undefined
                };
              });
              return;
            }

            try { await response.body?.cancel(); } catch {}
            controller.abort();

            logger.info('[FIRST_MSG][INIT_DISPATCH] Backend dispatch acknowledged during initialization', { chatId });
            handleMessageAcknowledged(chatId, record.message);
          } catch (error) {
            logger.error('[FIRST_MSG][INIT_DISPATCH] Error dispatching pending message during initialization', { chatId, error });
            updatePendingFirstMessage(chatId, (current) => {
              if (!current) {
                return null;
              }
              return {
                ...current,
                status: 'pending',
                dispatchSource: undefined
              };
            });
          }
        })();
      });

      await loadActiveChat();

      initializeAttachedFiles();

      setIsAppInitialized(true);
    };
    initializeApp();
  }, [ensurePendingChatBootstrap, handleMessageAcknowledged, isAppInitialized, initializeAttachedFiles, loadChatsFromDatabase, pendingFirstMessages, updatePendingFirstMessage]);

  useEffect(() => {
    const unsubs = chats.map(chat =>
      liveStore.subscribeState(chat.id, (updatedChatId, nextState) => {
        setChats(prev => {
          let mutated = false;
          const nextChats = prev.map(existingChat => {
            if (existingChat.id !== updatedChatId) {
              return existingChat;
            }
            if (existingChat.state === nextState) {
              return existingChat;
            }
            mutated = true;
            return { ...existingChat, state: nextState };
          });
          return mutated ? nextChats : prev;
        });
      })
    );
    return () => unsubs.forEach(unsub => unsub && unsub());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats.map(c => c.id).join(',')]); 

  useEffect(() => {
    if (!activeChatId || activeChatId === 'none') {
      setSendDisabledFlag(false);
      return;
    }
    const unsubscribe = sendButtonStateManager.subscribe(activeChatId, (isDisabled) => {
      setSendDisabledFlag(isDisabled);
      setForceRender(v => v + 1);
    });
    return () => {
      unsubscribe();
    };
  }, [activeChatId]);

  const loadActiveChat = async () => {
    try {
      const response = await fetch(apiUrl('/api/db/active-chat'));
      const data = await response.json();
      
      if (response.ok) {
        const activeChat = data.active_chat;
        logger.info('[App.loadActiveChat] Loaded active chat from database:', activeChat);
        
        if (activeChat && activeChat !== 'none') {
          setActiveChatId(activeChat);
          logger.info(`[ActiveChatId] Set initial active chat: ${activeChat}`);
          setHasMessageBeenSent(true);
          document.body.classList.add('chat-active');
        }
      }
    } catch (error) {
      logger.error('[App.loadActiveChat] Failed to load active chat:', error);
    }
  };

        
  const syncActiveChat = useCallback(async (chatId: string, token?: number) => {
    if (token !== undefined && chatSwitchTokenRef.current !== token) {
      return;
    }

    if (activeChatSyncAbortRef.current) {
      activeChatSyncAbortRef.current.abort();
    }

    const controller = new AbortController();
    activeChatSyncAbortRef.current = controller;

    try {
      await fetch(apiUrl('/api/db/active-chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ chat_id: chatId }),
        signal: controller.signal
      });

      if (controller.signal.aborted) {
        return;
      }

      if (token !== undefined && chatSwitchTokenRef.current !== token) {
        return;
      }

      logger.info('[App.syncActiveChat] Backend sync completed for:', chatId);
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.error('[App.syncActiveChat] Failed to sync active chat:', error);
      }
    } finally {
      if (activeChatSyncAbortRef.current === controller) {
        activeChatSyncAbortRef.current = null;
      }
    }
  }, []);

  const sendMessage = useCallback(async ({
    message: rawMessage,
    attachments = [],
    clearInput = true,
    clearAttachments = true,
    source = 'manual'
  }: SendMessageOptions): Promise<boolean> => {
    const trimmedMessage = rawMessage.trim();
    if (!trimmedMessage) {
      logger.info('[SEND_DEBUG] Aborting send - empty message', { source });
      return false;
    }

    const filesToSend = [...attachments];

    if (!hasMessageBeenSent || activeChatId === 'none') {
      setIsMessageBeingSent(true);

      const chatId = `chat_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const startTs = Date.now();
      const chatName = trimmedMessage.split(' ').slice(0, 4).join(' ');
      const ts = new Date().toISOString();
      logger.info(
        `[UX_PERF][FRONT] first_message_initiated chat=${chatId} preview=${JSON.stringify(trimmedMessage.slice(0, 32))} length=${trimmedMessage.length} ts=${ts}`
      );

      performanceTracker.startTracking(chatId, chatId);
      performanceTracker.mark(performanceTracker.MARKS.CHAT_CREATED, chatId);

      setCenterFading(true);
      setHasMessageBeenSent(true);
      document.body.classList.add('chat-active');

      if (clearInput) {
        setMessage('');
      }
      if (clearAttachments) {
        clearAttachedFiles();
      }

      const newChat: ChatItem = {
        id: chatId,
        name: chatName,
        isActive: true,
        state: 'static'
      };

      setChats(prev => prev.map(chat => ({ ...chat, isActive: false })).concat([newChat]));
      setActiveChatId(chatId);
      logger.info(`[ActiveChatId] Changed to new chat: ${chatId}`);
      logger.info(`[SidebarHighlight] Set to highlight new chat: ${chatId} (${chatName})`);

      const pendingRecord: PendingFirstMessageRecord = {
        message: trimmedMessage,
        files: filesToSend,
        name: chatName,
        status: 'pending',
        createdAt: Date.now()
      };
      setPendingFirstMessages(prev => new Map(prev).set(chatId, serializePendingFirstMessage(pendingRecord)));
      persistPendingChatMeta({ activeChatId: chatId, updatedAt: Date.now() });

      setTimeout(() => bottomInputRef.current?.focus(), 100);

      void (async () => {
        logger.info('Creating new chat in DB:', { chatId, chatName });
        try {
          const before = Date.now();
          const response = await fetch(apiUrl('/api/db/chat'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              chat_id: chatId,
              system_prompt: null
            })
          });
          logger.info(`[UX_PERF][FRONT] first_chat_create ms=${Date.now() - before}`);

          if (!response.ok) {
            const data = await response.json();
            logger.error('Failed to create chat in database:', data.error);
            return;
          } else {
            const data = await response.json();
            if (data.message === 'Chat already exists') {
              logger.info('Chat already exists in database (auto-created), proceeding');
            } else {
              logger.info('Chat created successfully in DB');
            }
          }

          try {
            const renameStart = Date.now();
            await fetch(apiUrl(`/api/db/chat/${chatId}/name`), {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ name: chatName })
            });
            logger.info(`[UX_PERF][FRONT] first_chat_rename ms=${Date.now() - renameStart}`);
          } catch (error) {
            logger.warn('Failed to set chat name:', error);
          }

          await syncActiveChat(chatId);
          logger.info(`[UX_PERF][FRONT] first_chat_setup_complete chat=${chatId} total_ms=${Date.now() - startTs}`);
        } catch (error) {
          logger.error('Failed to create chat:', error);
        } finally {
          logger.info(`[UX_PERF][FRONT] first_chat_setup_finished chat=${chatId} total_ms=${Date.now() - startTs}`);
        }
      })();
      return true;
    }

    if (activeChatId === 'none' || !chatRef.current) {
      logger.warn('Attempted to send message but no active chat or invalid ref:', { activeChatId, hasRef: !!chatRef.current, source });
      return false;
    }

    setIsMessageBeingSent(true);
    const sendStart = Date.now();
    logger.info('Sending message to active chat:', activeChatId, { source, length: trimmedMessage.length });
    const ts = new Date().toISOString();
    logger.info(
      `[UX_PERF][FRONT] message_initiated chat=${activeChatId} preview=${JSON.stringify(trimmedMessage.slice(0, 32))} length=${trimmedMessage.length} ts=${ts}`
    );

    chatRef.current.handleNewMessage(trimmedMessage, filesToSend);
    logger.info(`[UX_PERF][FRONT] handleNewMessage duration_ms=${Date.now() - sendStart}`);

    if (clearInput) {
      setMessage('');
    }
    if (clearAttachments) {
      clearAttachedFiles();
    }

    setTimeout(() => bottomInputRef.current?.focus(), 0);
    return true;
  }, [
    hasMessageBeenSent,
    activeChatId,
    setIsMessageBeingSent,
    setCenterFading,
    setHasMessageBeenSent,
    setMessage,
    clearAttachedFiles,
    setChats,
    setActiveChatId,
    setPendingFirstMessages,
    persistPendingChatMeta,
    syncActiveChat,
    bottomInputRef
  ]);


  const handleSend = useCallback(async () => {
    logger.info('[SEND_DEBUG] handleSend called:', {
      messageLength: message.length,
      messageTrimmed: message.trim().length,
  
      chatRefIsBusy: chatRef.current?.isBusy?.() ?? null,
      hasUnreadyFiles,
      activeChatId
    });

    if (!message.trim()) {
      return;
    }

    await sendMessage({
      message,
      attachments: [...attachedFiles],
      clearInput: true,
      clearAttachments: true,
      source: 'manual'
    });
  }, [
    message,
    attachedFiles,
    hasUnreadyFiles,
    activeChatId,
    sendMessage
  ]);

  const handleStopStreaming = useCallback(async (source: 'center' | 'bottom' = 'center') => {
    if (activeChatId === 'none') {
      logger.warn(`[STOP_STREAM] ${source} stop requested but no active chat`);
      return;
    }

    if (isStopRequestInFlight) {
      logger.info(`[STOP_STREAM] ${source} stop already in progress for chat ${activeChatId}`);
      return;
    }

    setIsStopRequestInFlight(true);

    try {
      const response = await fetch(apiUrl(`/api/chat/${activeChatId}/stop`), {
        method: 'POST'
      });

      let payload: any = null;
      try {
        payload = await response.json();
      } catch (parseError) {
        payload = null;
      }

      if (!response.ok) {
        logger.error('[STOP_STREAM] Failed to stop streaming:', {
          chatId: activeChatId,
          status: response.status,
          payload
        });
        return;
      }

      if (payload && payload.success === false) {
        logger.info('[STOP_STREAM] Stop request acknowledged but no active stream:', payload);
      } else {
        logger.info('[STOP_STREAM] Stop request sent successfully:', {
          chatId: activeChatId,
          payload
        });
      }
    } catch (error) {
      logger.error('[STOP_STREAM] Error issuing stop request:', {
        chatId: activeChatId,
        error
      });
    } finally {
      setIsStopRequestInFlight(false);
    }
  }, [activeChatId, isStopRequestInFlight]);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isSendDisabled) {
        logger.info('Enter key pressed but send is disabled:', {
          hasUnreadyFiles,
          activeChatId
        });
        return;
      }
      logger.info('Enter key pressed on input, sending message for active chat:', activeChatId);
      handleSend();
    }
  };

  const handleChatSelect = useCallback(async (chatId: string, metadata?: { trigger?: string; reason?: string }) => {
    if (activeChatId === chatId) return;

    const switchToken = chatSwitchTokenRef.current + 1;
    chatSwitchTokenRef.current = switchToken;

    logger.info('[MANUAL_SWITCH] ===== STARTING MANUAL CHAT SWITCH =====');
    logger.info('[MANUAL_SWITCH] Switching to chat:', chatId);

    const clickedChat = chats.find(chat => chat.id === chatId);
    let targetChatId = chatId;

    if (clickedChat?.last_active && clickedChat.last_active !== chatId) {
      logger.info(`[VersionMemory] Main chat ${chatId} has remembered version: ${clickedChat.last_active}`);

      try {
        const checkResponse = await fetch(apiUrl(`/api/db/chat/${clickedChat.last_active}`));

        if (chatSwitchTokenRef.current !== switchToken) {
          return;
        }

        if (checkResponse.ok) {
          targetChatId = clickedChat.last_active;
          logger.info(`[VersionMemory] Switching to remembered version: ${targetChatId}`);
        } else {
          logger.info(`[VersionMemory] Remembered version ${clickedChat.last_active} no longer exists, using main chat`);
          targetChatId = chatId;
        }
      } catch (error) {
        if (chatSwitchTokenRef.current !== switchToken) {
          return;
        }
        logger.warn(`[VersionMemory] Error checking remembered version: ${error}, using main chat`);
        targetChatId = chatId;
      }
    }

    if (chatSwitchTokenRef.current !== switchToken) {
      return;
    }

    logger.info(`[MANUAL_SWITCH] Setting activeChatId to: ${targetChatId}`);
    setActiveChatId(targetChatId);
    logger.info(`[MANUAL_SWITCH] ActiveChatId changed to: ${targetChatId}`);
    logger.info(`[MANUAL_SWITCH] Updating sidebar highlighting`);
    setChats(prev => prev.map(chat => ({
      ...chat,
      isActive: chat.id === chatId
    })));
    logger.info(`[MANUAL_SWITCH] Sidebar highlighted: ${chatId}`);
    logger.info(`[MANUAL_SWITCH] Clearing input and message states`);
    setMessage('');
    setSendingByChat(prev => {
      const next = new Map(prev);
      next.set(targetChatId, false);
      return next;
    });

    if (!hasMessageBeenSent) {
      logger.info(`[MANUAL_SWITCH] Setting hasMessageBeenSent=true`);
      setHasMessageBeenSent(true);
      document.body.classList.add('chat-active');
    }

    if (chatSwitchTokenRef.current !== switchToken) {
      return;
    }

    logger.info(`[MANUAL_SWITCH] Syncing active chat with backend`);
    await syncActiveChat(targetChatId, switchToken);

    if (chatSwitchTokenRef.current !== switchToken) {
      return;
    }

    if (targetChatId !== chatId) {
      logger.info(`[MANUAL_SWITCH] Reloading chats for version highlighting update`);
      await loadChatsFromDatabase({ expectedToken: switchToken });
      if (chatSwitchTokenRef.current !== switchToken) {
        return;
      }
    }

    logger.info('[MANUAL_SWITCH] ===== MANUAL CHAT SWITCH COMPLETED =====');
  }, [activeChatId, hasMessageBeenSent, chats, syncActiveChat, loadChatsFromDatabase]);

  const handleWorkspaceSelected = useCallback((chatId: string, workspacePath: string) => {
    logger.info('[WORKSPACE_SELECTION] Workspace selected in chat:', { chatId, workspacePath });

    // Clear the workspace selection prompt
    clearWorkspaceSelection();

    // Open the CoderWindow
    handleOpenModal('coder');
  }, [handleOpenModal, clearWorkspaceSelection]);

  useEffect(() => {
    const handleCoderPrompt = (event: Event) => {
      const detail = (event as CustomEvent<any>).detail || {};
      const targetChatId: string | undefined = detail.chatId ?? undefined;

      if (targetChatId && targetChatId !== 'none') {
        // Switch to the chat if needed
        if (targetChatId !== activeChatId) {
          void handleChatSelect(targetChatId, { trigger: 'system', reason: 'coder-workspace-prompt' });
        }

        // Show workspace picker in chat instead of immediately opening CoderWindow
        setWorkspaceSelectionForChat(targetChatId);
      }
    };

    window.addEventListener('coderWorkspacePrompt', handleCoderPrompt as EventListener);
    return () => window.removeEventListener('coderWorkspacePrompt', handleCoderPrompt as EventListener);
  }, [activeChatId, handleChatSelect, setWorkspaceSelectionForChat]);

  useEffect(() => {
    const handleCoderOperationEvent = (event: Event) => {
      const detail = (event as CustomEvent<any>).detail || {};
      const targetChatId: string | undefined = detail.chatId ?? undefined;

      if (targetChatId && targetChatId !== 'none' && targetChatId !== activeChatId) {
        void handleChatSelect(targetChatId, { trigger: 'system', reason: 'coder-operation' });
      }

      if (!isCoderVisible) {
        handleOpenModal('coder');
      }
    };

    window.addEventListener('coderOperation', handleCoderOperationEvent as EventListener);
    return () => window.removeEventListener('coderOperation', handleCoderOperationEvent as EventListener);
  }, [activeChatId, handleChatSelect, handleOpenModal, isCoderVisible]);

  const handleChatSwitch = useCallback(async (newChatId: string) => {
    const switchToken = chatSwitchTokenRef.current + 1;
    chatSwitchTokenRef.current = switchToken;

    logger.info('[VERSION_SWITCH] ===== STARTING VERSION CHAT SWITCH =====');
    logger.info('[VERSION_SWITCH] Switching to version chat:', newChatId);

    if (activeChatId !== 'none') {
      setSendingByChat(prev => {
        const next = new Map(prev);
        next.delete(activeChatId);
        logger.info(`[VERSION_SWITCH] Cleared sending state for parent chat: ${activeChatId}`);
        return next;
      });
    }

    if (chatSwitchTokenRef.current !== switchToken) {
      return;
    }

    logger.info(`[VERSION_SWITCH] Setting activeChatId to: ${newChatId}`);
    setActiveChatId(newChatId);
    logger.info(`[VERSION_SWITCH] ActiveChatId changed to version chat: ${newChatId}`);

    if (chatSwitchTokenRef.current !== switchToken) {
      return;
    }

    logger.info(`[VERSION_SWITCH] Syncing active chat with backend`);
    await syncActiveChat(newChatId, switchToken);

    if (chatSwitchTokenRef.current !== switchToken) {
      return;
    }

    logger.info(`[VERSION_SWITCH] Reloading chats for parent highlighting update`);
    await loadChatsFromDatabase({ expectedToken: switchToken });

    if (chatSwitchTokenRef.current !== switchToken) {
      return;
    }

    logger.info('[VERSION_SWITCH] Chats reloaded');
    logger.info('[VERSION_SWITCH] ===== VERSION CHAT SWITCH COMPLETED =====');
  }, [activeChatId, syncActiveChat, loadChatsFromDatabase]);

  useEffect(() => {
    (window as any).handleChatSwitch = handleChatSwitch;

    return () => {
      delete (window as any).handleChatSwitch;
    };
  }, [handleChatSwitch]);

  
  const handleOpenGlobalViewer = useCallback((file: any, subrenderer?: React.ComponentType<any>) => {
    setGlobalViewerFile(file);
    setGlobalViewerSubrenderer(() => subrenderer);
    setGlobalViewerOpen(true);
  }, []);

  const handleCloseGlobalViewer = useCallback(() => {
    setGlobalViewerOpen(false);
    setTimeout(() => {
      setGlobalViewerFile(null);
      setGlobalViewerSubrenderer(undefined);
    }, 300);
  }, []);


  useEffect(() => {
    (window as any).openGlobalFileViewer = handleOpenGlobalViewer;
    (window as any).closeGlobalFileViewer = handleCloseGlobalViewer;

    return () => {
      delete (window as any).openGlobalFileViewer;
      delete (window as any).closeGlobalFileViewer;
    };
  }, [handleOpenGlobalViewer, handleCloseGlobalViewer]);

  const handleNewChat = () => {
    logger.info('Starting new chat');
    
    setHasMessageBeenSent(false);
    setCenterFading(false);
    setActiveChatId('none');
    persistPendingChatMeta(null);
    
    logger.info(`[ActiveChatId] Changed to: none`);
    setMessage('');
    setSendingByChat(new Map());
    setChats(prev => prev.map(chat => ({ ...chat, isActive: false })));
    logger.info(`[SidebarHighlight] Cleared all highlighting (none selected)`);
    document.body.classList.remove('chat-active');
    
    syncActiveChat('none');
  };

  const handleDeleteChat = async (chatId: string) => {
    logger.info('Deleting chat:', chatId);

    const originalChats = chats;
    const originalPendingMessages = new Map(pendingFirstMessages);

    setChats(prev => prev.filter(chat => chat.id !== chatId));
    setPendingFirstMessages(prev => {
      const newMap = new Map(prev);
      newMap.delete(chatId);
      return newMap;
    });
    
    let shouldReturnToMainScreen = activeChatId === chatId;
    
    try {
      const response = await fetch(apiUrl(`/api/db/chat/${chatId}`), {
        method: 'DELETE'
      });
      
      if (response.ok) {
        const data = await response.json();
        logger.info('Chat deleted successfully');

        // Clear cache for deleted chat
        chatHistoryCache.delete(chatId);
        clearPendingChatMeta(chatId);

        // Handle cascade deletions
        if (data.cascade_deleted && data.deleted_chats) {
          // Clear cache for all cascade-deleted chats
          data.deleted_chats.forEach((deletedId: string) => {
            chatHistoryCache.delete(deletedId);
            clearPendingChatMeta(deletedId);
          });

          if (activeChatId !== 'none') {
            shouldReturnToMainScreen = data.deleted_chats.includes(activeChatId);
            if (shouldReturnToMainScreen) {
              logger.info(`[CASCADE_DELETE] Current active chat ${activeChatId} was cascade deleted, returning to main screen`);
            }
          }
        }

        if (shouldReturnToMainScreen) {
          handleNewChat();
        }
      } else {
        const data = await response.json();
        logger.error('Failed to delete chat:', data.error);

        setChats(originalChats);
        setPendingFirstMessages(originalPendingMessages);
      }
    } catch (error) {
      logger.error('Failed to delete chat:', error);

      setChats(originalChats);
      setPendingFirstMessages(originalPendingMessages);
    }
  };

  const handleEditChat = async (chatId: string, newName: string) => {
    logger.info('Updating chat name:', chatId, newName);

    const originalChats = chats;

    setChats(prev => prev.map(chat =>
      chat.id === chatId ? { ...chat, name: newName } : chat
    ));

    try {
      const response = await fetch(apiUrl(`/api/db/chat/${chatId}/name`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: newName })
      });

      if (response.ok) {
        logger.info('Chat name updated successfully');
      } else {
        const data = await response.json();
        logger.error('Failed to update chat name:', data.error);
        setChats(originalChats);
      }
    } catch (error) {
      logger.error('Failed to update chat name:', error);
      setChats(originalChats);
    }
  };


  const activeChat = chats.find(chat => chat.id === activeChatId);
  const isActiveChatStreaming = Boolean(activeChatId !== 'none' && activeChat && (activeChat.state === 'thinking' || activeChat.state === 'responding'));
  const activeStreamCount = useMemo(() => chats.filter(c => c.state === 'thinking' || c.state === 'responding').length, [chats]);
  const atConcurrencyLimit = activeStreamCount >= maxConcurrentStreams;
  const isSendInProgressForActive = sendingByChat.get(activeChatId) === true;
  const isGlobalSendDisabled = sendDisabledFlag;
  const isSendDisabled = isActiveChatStreaming || (chatRef.current?.isBusy?.() ?? false) || hasUnreadyFiles || isSendInProgressForActive || isGlobalSendDisabled || atConcurrencyLimit;

  const flushVoiceQueue = useCallback(() => {
    if (isProcessingVoiceQueueRef.current) {
      return;
    }
    if (voiceTranscriptQueueRef.current.length === 0) {
      return;
    }
    if (isVoiceChatMode && isMicMuted) {
      logger.debug('[VOICE_CHAT] Mic muted - deferring voice message dispatch');
      return;
    }
    if (isSendDisabled) {
      logger.debug('[VOICE_CHAT] Send disabled - deferring voice message dispatch');
      return;
    }
    if (message.trim()) {
      logger.debug('[VOICE_CHAT] Message input occupied - deferring voice message dispatch');
      return;
    }

    if (awaitingAIResponseRef.current) {
      logger.debug('[VOICE_CHAT] Awaiting AI response - skipping queued transcription dispatch');
      return;
    }

    const nextMessage = voiceTranscriptQueueRef.current.shift();
    const residualTranscripts = voiceTranscriptQueueRef.current.splice(0);
    if (residualTranscripts.length > 0) {
      logger.info('[VOICE_CHAT] Clearing residual voice transcriptions queued during the pending response', { discarded: residualTranscripts.length });
    }
    if (!nextMessage) {
      voiceTranscriptQueueRef.current.push(...residualTranscripts);
      return;
    }

    const restoreQueue = () => {
      voiceTranscriptQueueRef.current = [nextMessage, ...residualTranscripts, ...voiceTranscriptQueueRef.current];
    };

    isProcessingVoiceQueueRef.current = true;
    setIsSendingVoiceMessage(true);
    awaitingAIResponseRef.current = true;
    logger.info('[VOICE_CHAT] Dispatching queued voice message', { length: nextMessage.length });

    sendMessage({
      message: nextMessage,
      attachments: [],
      clearInput: false,
      clearAttachments: false,
      source: 'voice'
    }).then((sent) => {
      if (!sent) {
        restoreQueue();
        awaitingAIResponseRef.current = false;
      }
      setIsSendingVoiceMessage(false);
    }).catch((error) => {
      logger.error('[VOICE_CHAT] Failed to send queued voice message:', error);
      restoreQueue();
      awaitingAIResponseRef.current = false;
      setIsSendingVoiceMessage(false);
    }).finally(() => {
      isProcessingVoiceQueueRef.current = false;
      if (!isSendDisabled && voiceTranscriptQueueRef.current.length > 0) {
        flushVoiceQueueRef.current?.();
      }
    });
  }, [isSendDisabled, message, isVoiceChatMode, isMicMuted, sendMessage]);
  useEffect(() => {
    flushVoiceQueueRef.current = flushVoiceQueue;
    return () => {
      flushVoiceQueueRef.current = null;
    };
  }, [flushVoiceQueue]);

  useEffect(() => {
    if (!isSendDisabled) {
      flushVoiceQueueRef.current?.();
    }
  }, [isSendDisabled]);

  useEffect(() => {
    if (!isVoiceChatMode && voiceTranscriptQueueRef.current.length > 0) {
      logger.info('[VOICE_CHAT] Clearing voice transcription queue', { discarded: voiceTranscriptQueueRef.current.length });
      voiceTranscriptQueueRef.current = [];
      isProcessingVoiceQueueRef.current = false;
    }
  }, [isVoiceChatMode]);

  useEffect(() => {
    if (isVoiceChatMode && !isMicMuted) {
      flushVoiceQueueRef.current?.();
    }
  }, [isVoiceChatMode, isMicMuted]);

  const { isDragOver, dragHandlers } = useDragDrop({
    onFilesDropped: handleFileSelectionImmediate,
    disabled: isSendDisabled
  });

  void forceRender;

  const handleActionButtonClick = useCallback((source: 'center' | 'bottom') => {
    logger.info(`[SEND_DEBUG] ${source === 'center' ? 'Center' : 'Bottom'} send button clicked:`, {
      activeChatId,
      messageLength: message.length,
      chatRefIsBusy: chatRef.current?.isBusy?.() ?? null,
      hasUnreadyFiles,
      wasHoldCompleted,
      isVoiceChatMode,
      isMicMuted,
      isStopRequestInFlight
    });

    if (wasHoldCompleted) {
      logger.info('[SEND_DEBUG] Click prevented - hold was completed');

      return;
    }

    const trimmedMessage = message.trim();

    if (trimmedMessage) {
      if (!isSendDisabled) {
        handleSend();
      }
      return;
    }

    if (isVoiceChatMode) {
      handleVoiceChatClick(source);
      return;
    }

    if (isActiveChatStreaming) {
      handleStopStreaming(source);
      return;
    }

    handleVoiceChatClick(source);
  }, [activeChatId, message, isSendDisabled, isActiveChatStreaming, hasUnreadyFiles, wasHoldCompleted, isVoiceChatMode, isMicMuted, isStopRequestInFlight, handleVoiceChatClick, handleStopStreaming, handleSend]);

  const restartListeningRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    restartListeningRef.current = restartListeningIfNeeded;
  }, [restartListeningIfNeeded]);

  const handleChatStateChange = useCallback((chatId: string, state: 'thinking' | 'responding' | 'static') => {
    logger.info('Chat state changed:', chatId, state);

    setChats(prev => prev.map(chat =>
      chat.id === chatId ? { ...chat, state } : chat
    ));

    if (state === 'thinking' || state === 'responding') {
      if (awaitingAIResponseRef.current) {
        awaitingAIResponseRef.current = false;
        logger.debug('[VOICE_CHAT] AI started responding, clearing await flag');

        setTimeout(() => {
          flushVoiceQueueRef.current?.();
          restartListeningRef.current?.();
        }, 100);
      }
    }
  }, []);

  const handleActiveStateChange = useCallback((chatId: string, isReallyActive: boolean) => {
    logger.info('Chat confirms active state:', chatId, isReallyActive);
    if (isReallyActive) {
      setActiveChatId(chatId);
    } else {
      setActiveChatId(prev => prev === chatId ? 'none' : prev);
    }
  }, []);

  const handleBusyStateChange = useCallback(() => {
    logger.info('[SEND_DEBUG] Chat busy state changed, forcing re-render');
    setForceRender(prev => prev + 1);
  }, []);



  const handleChatReorder = (reorderedChats: ChatItem[]) => {
    setChats(reorderedChats);
  };

  // TEST_FRAMEWORK_CONDITIONAL - Remove this block to remove test framework
  // Access test UI by adding ?test=versioning to the URL
  if (window.location.search.includes('test=versioning')) {
    return <TestUI />;
  }
  // END_TEST_FRAMEWORK_CONDITIONAL

  return (
    <div className={`app ${isCoderVisible ? 'coder-docked' : ''}`}>
      <LeftSidebar
        chats={chats}
        activeChat={activeChatId}
        onChatSelect={handleChatSelect}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onEditChat={handleEditChat}
        onBulkDelete={handleBulkDelete}
        onBulkExport={handleBulkExport}
        onBulkImport={handleBulkImport}
        onChatsReload={loadChatsFromDatabase}
        onChatReorder={handleChatReorder}
        onOpenModal={handleOpenModal}
        activeChatId={activeChatId}
        activeStreamCount={activeStreamCount}
        maxConcurrentStreams={maxConcurrentStreams}
      />

      {/* TEMPORARY_DEBUG_TRIGGERLOG - debugging component */}
      {DEBUG_TOOLS_CONFIG.showTriggerLog && <TriggerLog activeChatId={activeChatId} />}

      <div className="main-area">
        <div className="main-content">
        <div className="chat-container">
          <h1 className={`title ${centerFading ? 'fading' : ''} ${hasMessageBeenSent ? 'hidden' : ''}`}>
            How can I help you?
          </h1>
          <div className={`input-container center ${centerFading ? 'fading' : ''} ${hasMessageBeenSent ? 'hidden' : ''}`}>
            <div className="input-row">
              <MessageInputArea
                inputRef={centerInputRef}
                message={message}
                onMessageChange={(value) => {
                  logger.info('[INPUT_DEBUG] Center input onChange:', {
                    newValue: value,
                    oldValue: message,
                    chatRefIsBusy: chatRef.current?.isBusy?.() ?? null
                  });
                  setMessage(value);
                }}
                onKeyDown={handleKeyPress}
                onAddFileClick={handleAddFileClick}
                isDragOver={isDragOver}
                isVoiceChatMode={isVoiceChatMode}
                isActiveChatStreaming={isActiveChatStreaming}
                dragHandlers={dragHandlers}
              />
              <div className="input-actions">
                {isVoiceChatMode && (
                  <VoiceChatMuteButton
                    isMicMuted={isMicMuted}
                    onToggle={handleMicMuteToggle}
                  />
                )}
                <SendButton
                  onClick={() => handleActionButtonClick('center')}
                  onHoldStart={handleButtonHoldStart}
                  onHoldEnd={handleButtonHoldEnd}
                  isButtonHeld={isButtonHeld}
                  isRecording={isRecording}
                  isSoundDetected={isSoundDetected}
                  isActiveChatStreaming={isActiveChatStreaming}
                  hasUnreadyFiles={hasUnreadyFiles}
                  message={message}
                  isVoiceChatMode={isVoiceChatMode}
                  isMicMuted={isMicMuted}
                  isSendDisabled={isSendDisabled}
                  isStopRequestInFlight={isStopRequestInFlight}
                  activeStreamCount={activeStreamCount}
                  atConcurrencyLimit={atConcurrencyLimit}
                  maxConcurrentStreams={maxConcurrentStreams}
                  isProcessingSegment={isProcessingSegment}
                  isSendingVoiceMessage={isSendingVoiceMessage}
                  isAwaitingResponse={awaitingAIResponseRef.current}
                />
              </div>
            </div>
            
            <AttachedFiles
              files={attachedFiles}
              onRemoveFile={handleRemoveFile}
              onClearAll={handleClearAllFiles}
              className="main-screen-attached"
            />
            
            {attachedFiles.length > 0 && hasUnreadyFiles && (
              <div style={{ 
                fontSize: '12px', 
                color: 'rgba(255, 255, 255, 0.6)', 
                textAlign: 'center', 
                marginTop: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px'
              }}>
                <span>📎</span>
                <span>Files are still processing... Send will be enabled when ready</span>
              </div>
            )}
          </div>
        </div>
        
        {(hasMessageBeenSent && activeChatId !== 'none') && (
          <>
            <Chat
              key="main-chat"
              ref={chatRef}
              chatId={activeChatId}
              isActive={true}
              autoTTSActive={isVoiceChatMode}
              firstMessage={pendingFirstMessages.get(activeChatId) || ''}
              onChatStateChange={handleChatStateChange}
              onFirstMessageSent={handleFirstMessageSent}
              onMessageSent={handleMessageAcknowledged}
              onActiveStateChange={handleActiveStateChange}
              onBusyStateChange={handleBusyStateChange}
              setIsMessageBeingSent={setIsMessageBeingSent}
              isSendInProgress={isSendInProgressForActive}
              onChatSwitch={handleChatSwitch}
              showWorkspacePicker={workspaceSelectionChatId === activeChatId}
              onWorkspaceSelected={handleWorkspaceSelected}
            />
            
            <div
              className={`bottom-input-area ${(isBottomInputToggled || isBottomInputHovering) ? 'visible' : ''} ${isBottomInputToggled && showToggleOutline ? 'toggled-on' : ''}`}
              onMouseEnter={() => setIsBottomInputHovering(true)}
              onMouseLeave={() => setIsBottomInputHovering(false)}
              onDoubleClick={(e) => {
                handleBottomInputDoubleClick();
                resetToggleOutlineTimer();
              }}
            >
              <AttachedFiles
                files={attachedFiles}
                onRemoveFile={handleRemoveFile}
                onClearAll={handleClearAllFiles}
                className="chat-screen-attached"
              />

              {attachedFiles.length > 0 && hasUnreadyFiles && (
                <div style={{
                  fontSize: '11px',
                  color: 'rgba(255, 255, 255, 0.5)',
                  textAlign: 'center',
                  marginTop: '6px',
                  marginBottom: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px'
                }}>
                  <span>📎</span>
                  <span>Files processing... Send disabled until ready</span>
                </div>
              )}

              <div className="bottom-input-container">
                <MessageInputArea
                  inputRef={bottomInputRef}
                  message={message}
                  onMessageChange={(value) => {
                    logger.info('[INPUT_DEBUG] Bottom input onChange:', {
                      newValue: value,
                      oldValue: message,
                      chatRefIsBusy: chatRef.current?.isBusy?.() ?? null
                    });
                    setMessage(value);
                  }}
                  onKeyDown={handleKeyPress}
                  onAddFileClick={handleAddFileClick}
                  isDragOver={isDragOver}
                  isVoiceChatMode={isVoiceChatMode}
                  isActiveChatStreaming={isActiveChatStreaming}
                  dragHandlers={dragHandlers}
                />
                <div className="input-actions">
                  {isVoiceChatMode && (
                    <VoiceChatMuteButton
                      isMicMuted={isMicMuted}
                      onToggle={handleMicMuteToggle}
                    />
                  )}
                  <SendButton
                    onClick={() => handleActionButtonClick('bottom')}
                    onHoldStart={handleButtonHoldStart}
                    onHoldEnd={handleButtonHoldEnd}
                    isButtonHeld={isButtonHeld}
                    isRecording={isRecording}
                    isSoundDetected={isSoundDetected}
                    isActiveChatStreaming={isActiveChatStreaming}
                    hasUnreadyFiles={hasUnreadyFiles}
                    message={message}
                    isVoiceChatMode={isVoiceChatMode}
                    isMicMuted={isMicMuted}
                    isSendDisabled={isSendDisabled}
                    isStopRequestInFlight={isStopRequestInFlight}
                    activeStreamCount={activeStreamCount}
                    atConcurrencyLimit={atConcurrencyLimit}
                    maxConcurrentStreams={maxConcurrentStreams}
                    isProcessingSegment={isProcessingSegment}
                    isSendingVoiceMessage={isSendingVoiceMessage}
                    isAwaitingResponse={awaitingAIResponseRef.current}
                  />
                </div>
              </div>
            </div>

            {!isBottomInputToggled && (
              <div
                className="bottom-hover-zone"
                onMouseEnter={() => setIsBottomInputHovering(true)}
                onMouseLeave={() => setIsBottomInputHovering(false)}
              />
            )}
          </>
        )}
        </div>
        {isCoderVisible && (
          <aside className="coder-dock">
            <div className="coder-dock__header">
              <span className="coder-dock__title">Coder</span>
              <button
                className="coder-dock__close"
                onClick={handleCloseModal}
                aria-label="Close coder workspace"
              >
                <Icons.Close className="coder-dock__close-icon" />
              </button>
            </div>
            <CoderWindow
              isOpen={true}
              chatId={activeChatId !== 'none' ? activeChatId : undefined}
            />
          </aside>
        )}
      </div>
      <RightSidebar 
        onOpenModal={handleOpenModal} 
        chatId={activeChatId !== 'none' ? activeChatId : undefined}
      />
      
      {/* Modals - consolidated rendering */}
      {[
        { id: 'gallery', className: 'gallery-modal', render: () => <GalleryWindow /> },
        { id: 'search', className: 'search-modal', render: () => <SearchWindow /> },
        { id: 'settings', className: 'settings-modal', render: () => <SettingsWindow /> },
        { id: 'profiles', className: 'profiles-modal', render: () => <KnowledgeSection activeSubsection="profiles" onSubsectionChange={() => {}} /> },
        { id: 'workspace', className: 'workspace-modal', render: (isOpen: boolean) => <WorkspaceWindow isOpen={isOpen} /> },
        { id: 'sources', className: 'sources-modal', render: () => <SourcesWindow /> },
      ].map(modal => (
        <ModalWindow
          key={modal.id}
          isOpen={activeModal === modal.id}
          onClose={handleCloseModal}
          className={modal.className}
          closeOnBackdropClick={'closeOnBackdropClick' in modal ? (modal as any).closeOnBackdropClick : undefined}
        >
          {modal.render(activeModal === modal.id)}
        </ModalWindow>
      ))}

      <ChatVersionsWindow
        isOpen={activeModal === 'chat-versions'}
        onClose={handleCloseModal}
        chatId={activeChatId !== 'none' ? activeChatId : undefined}
      />

      <ContextWindow
        isOpen={activeModal === 'context'}
        onClose={handleCloseModal}
        chatId={activeChatId !== 'none' ? activeChatId : undefined}
      />
      
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileSelect}
        accept="*"
      />

      {/* Global File Viewer */}
      <GlobalFileViewer
        isOpen={globalViewerOpen}
        file={globalViewerFile}
        subrenderer={globalViewerSubrenderer}
        onClose={handleCloseGlobalViewer}
      />
    </div>
  );
}

export default App;



