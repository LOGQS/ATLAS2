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
import { apiUrl } from './config/api';
import { MAX_CONCURRENT_STREAMS, DEBUG_TOOLS_CONFIG } from './config/chat';
import { BrowserStorage } from './utils/storage/BrowserStorage';
import { liveStore, sendButtonStateManager } from './utils/chat/LiveStore';
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


type SendMessageOptions = {
  message: string;
  attachments?: AttachedFile[];
  clearInput?: boolean;
  clearAttachments?: boolean;
  source?: 'manual' | 'voice';
};


function App() {
  const [message, setMessage] = useState('');
  const [hasMessageBeenSent, setHasMessageBeenSent] = useState(false);
  const [centerFading, setCenterFading] = useState(false);
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [activeChatId, setActiveChatId] = useState<string>('none');
  const [pendingFirstMessages, setPendingFirstMessages] = useState<Map<string, string>>(new Map());
  const [isAppInitialized, setIsAppInitialized] = useState(false);
  const [forceRender, setForceRender] = useState(0);
  const [sendDisabledFlag, setSendDisabledFlag] = useState(false);
  const [sendingByChat, setSendingByChat] = useState<Map<string, boolean>>(new Map());
  const [isStopRequestInFlight, setIsStopRequestInFlight] = useState(false);

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

  const loadChatsFromDatabase = useCallback(async (options?: { expectedToken?: number }) => {
    try {
      logger.info('[App.loadChatsFromDatabase] Loading chats from database');
      const response = await fetch(apiUrl('/api/db/chats'));
      const data = await response.json();

      if (options?.expectedToken && options.expectedToken !== chatSwitchTokenRef.current) {
        return;
      }

      if (response.ok) {
        logger.info('[App.loadChatsFromDatabase] Successfully loaded chats:', data.chats.length);
        const chatsFromDb = data.chats.map((chat: any) => ({
          id: chat.id,
          name: chat.name,
          isActive: chat.isActive,
          state: chat.state || 'static',
          last_active: chat.last_active
        }));

        const settings = BrowserStorage.getUISettings();
        if (settings.chatOrder && settings.chatOrder.length > 0) {
          const orderedChats: ChatItem[] = [];
          const chatMap = new Map<string, ChatItem>(chatsFromDb.map((chat: ChatItem) => [chat.id, chat]));

          settings.chatOrder.forEach(chatId => {
            if (chatMap.has(chatId)) {
              const chat = chatMap.get(chatId);
              if (chat) {
                orderedChats.push(chat);
                chatMap.delete(chatId);
              }
            }
          });

          chatMap.forEach((chat) => {
            orderedChats.push(chat);
          });

          setChats(orderedChats);
        } else {
          setChats(chatsFromDb);
        }
      } else {
        logger.error('[App.loadChatsFromDatabase] Failed to load chats:', data.error);
      }
    } catch (error) {
      logger.error('[App.loadChatsFromDatabase] Failed to load chats:', error);
    }
  }, []);

  const { handleBulkDelete, handleBulkExport, handleBulkImport } = useBulkOperations({
    setChats,
    setPendingFirstMessages,
    handleNewChat: () => handleNewChat(),
    loadChatsFromDatabase
  });

  useEffect(() => {
    if (isAppInitialized) return;

    const initializeApp = async () => {
      logger.info('[App.useEffect] Initializing app');
      liveStore.start();
      await loadChatsFromDatabase();
      await loadActiveChat();

      initializeAttachedFiles();

      setIsAppInitialized(true);
    };
    initializeApp();
  }, [isAppInitialized, initializeAttachedFiles, loadChatsFromDatabase]);

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
      const chatName = trimmedMessage.split(' ').slice(0, 4).join(' ');

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

      setPendingFirstMessages(prev => new Map(prev).set(chatId, JSON.stringify({ message: trimmedMessage, files: filesToSend })));

      setTimeout(() => bottomInputRef.current?.focus(), 100);

      void (async () => {
        logger.info('Creating new chat in DB:', { chatId, chatName });
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
            await fetch(apiUrl(`/api/db/chat/${chatId}/name`), {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ name: chatName })
            });
          } catch (error) {
            logger.warn('Failed to set chat name:', error);
          }

          await syncActiveChat(chatId);
        } catch (error) {
          logger.error('Failed to create chat:', error);
        }
      })();
      return true;
    }

    if (activeChatId === 'none' || !chatRef.current) {
      logger.warn('Attempted to send message but no active chat or invalid ref:', { activeChatId, hasRef: !!chatRef.current, source });
      return false;
    }

    setIsMessageBeingSent(true);
    logger.info('Sending message to active chat:', activeChatId, { source, length: trimmedMessage.length });

    chatRef.current.handleNewMessage(trimmedMessage, filesToSend);

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

  const handleChatSelect = useCallback(async (chatId: string) => {
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
        
        if (data.cascade_deleted && data.deleted_chats && activeChatId !== 'none') {
          shouldReturnToMainScreen = data.deleted_chats.includes(activeChatId);
          if (shouldReturnToMainScreen) {
            logger.info(`[CASCADE_DELETE] Current active chat ${activeChatId} was cascade deleted, returning to main screen`);
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
  const atConcurrencyLimit = activeStreamCount >= MAX_CONCURRENT_STREAMS;
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

  const handleFirstMessageSent = useCallback((chatId: string) => {
    logger.info('First message sent for chat:', chatId);
    setPendingFirstMessages(prev => {
      const newMap = new Map(prev);
      newMap.delete(chatId);
      return newMap;
    });
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
    <div className="app">
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
      />

      {/* TEMPORARY_DEBUG_TRIGGERLOG - debugging component */}
      {DEBUG_TOOLS_CONFIG.showTriggerLog && <TriggerLog activeChatId={activeChatId} />}

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
              onActiveStateChange={handleActiveStateChange}
              onBusyStateChange={handleBusyStateChange}
              setIsMessageBeingSent={setIsMessageBeingSent}
              isSendInProgress={isSendInProgressForActive}
              onChatSwitch={handleChatSwitch}
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
        { id: 'coder', className: 'coder-modal', render: (isOpen: boolean) => <CoderWindow isOpen={isOpen} chatId={activeChatId !== 'none' ? activeChatId : undefined} /> },
      ].map(modal => (
        <ModalWindow
          key={modal.id}
          isOpen={activeModal === modal.id}
          onClose={handleCloseModal}
          className={modal.className}
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



