// status: complete

import React, { useState, useEffect, useLayoutEffect, useRef, forwardRef, useImperativeHandle, useCallback, useMemo } from 'react';
import UserMessage from '../message/UserMessage';
import UserMessageFiles from '../files/UserMessageFiles';
import ThinkBox from './ThinkBox';
import MessageRenderer from '../message/MessageRenderer';
import MessageWrapper from '../message/MessageWrapper';
import { liveStore } from '../../utils/chat/LiveStore';
import { versionSwitchLoadingManager } from '../../utils/versioning/versionSwitchLoadingManager';
import logger from '../../utils/core/logger';
import { performanceTracker } from '../../utils/core/performanceTracker';
import { apiUrl } from '../../config/api';
import { computeIsScrollable, MessageDuplicateChecker } from '../../utils/chat/chatHelpers';
import useScrollControl from '../../hooks/ui/useScrollControl';
import { useVersioning } from '../../hooks/versioning/useVersioning';
import { useTTS } from '../../hooks/ui/useTTS';
import { useMessageIdSync } from '../../hooks/chat/useMessageIdSync';
import { useEditModal } from '../../hooks/ui/useEditModal';
import { useChatHistory } from '../../hooks/chat/useChatHistory';
import '../../styles/chat/Chat.css';
import '../../styles/chat/ThinkBox.css';
import '../../styles/message/MessageRenderer.css';
import type { AttachedFile, Message } from '../../types/messages';

const DUPLICATE_WINDOW_MS = 1000;
const SKELETON_READY_DELAY_MS = 120;
const LOAD_HISTORY_DEBOUNCE_MS = 50;
const RECONCILE_AFTER_STREAM_DELAY_MS = 100;

interface ChatProps {
  chatId?: string;
  onMessageSent?: (message: string) => void;
  onChatStateChange?: (chatId: string, state: 'thinking' | 'responding' | 'static') => void;
  onFirstMessageSent?: (chatId: string) => void;
  onActiveStateChange?: (chatId: string, isReallyActive: boolean) => void;
  onBusyStateChange?: () => void;
  setIsMessageBeingSent?: React.Dispatch<React.SetStateAction<boolean>>;
  onChatSwitch?: (newChatId: string) => Promise<void>;
  isActive?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
  firstMessage?: string;
}

const Chat = React.memo(forwardRef<any, ChatProps>(({ 
  chatId, 
  onMessageSent, 
  onChatStateChange, 
  onFirstMessageSent, 
  onActiveStateChange, 
  onBusyStateChange,
  setIsMessageBeingSent,
  onChatSwitch,
  isActive = true, 
  firstMessage
}, ref) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [firstMessageSent, setFirstMessageSent] = useState(false);

  const [liveOverlay, setLiveOverlay] = useState({
    contentBuf: '',
    thoughtsBuf: '',
    state: 'static' as 'thinking' | 'responding' | 'static'
  });
  const [persistingAfterStream, setPersistingAfterStream] = useState(false);
  const [wasStreaming, setWasStreaming] = useState(false);

  const [needsBottomAnchor, setNeedsBottomAnchor] = useState(false);
  const [notLoadingSettled, setNotLoadingSettled] = useState(false);
  const [skeletonReady, setSkeletonReady] = useState(false);

  const [versionSwitchLoading, setVersionSwitchLoading] = useState(false);

  const mountCountRef = useRef(0);
  useEffect(() => {
    mountCountRef.current++;
    const mountCount = mountCountRef.current;
    logger.info(`[COMPONENT_LIFECYCLE] Chat component mount #${mountCount} for chatId: ${chatId}`);

    // Mark component mounted for performance tracking
    if (chatId) {
      performanceTracker.mark(performanceTracker.MARKS.COMPONENT_MOUNTED, chatId);
    }

    if (mountCount > 1) {
      logger.info(`[DOUBLE_MOUNT] Chat component mounted ${mountCount} times for chatId: ${chatId}`);
    }

    return () => {
      logger.info(`[COMPONENT_LIFECYCLE] Chat component unmount #${mountCount} for chatId: ${chatId}`);
    };
  }, [chatId]);

  useEffect(() => {
    logger.info(`[MESSAGE_STATE] Chat ${chatId} messages changed - count: ${messages.length}, IDs: ${messages.map(m => `${m.id}(${m.role})`).join(', ')}`);
  }, [messages, chatId]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(true);
  const duplicateCheckerRef = useRef<MessageDuplicateChecker>(new MessageDuplicateChecker(DUPLICATE_WINDOW_MS));

  const isDuplicateMessage = useCallback((content: string): boolean => {
    const isDuplicate = duplicateCheckerRef.current.isDuplicate(chatId, content);
    if (isDuplicate) {
      logger.debug(`[Chat] Duplicate message blocked: "${content.substring(0, 50)}..."`);
    }
    return isDuplicate;
  }, [chatId]);
  
  const scrollControl = useScrollControl({ 
    chatId, 
    streamingState: liveOverlay.state,
    containerRef: messagesContainerRef,
    scrollType: 'chat'
  });

  const { isLoading, loadHistory } = useChatHistory({ chatId, setMessages, messages });

  const sendMessageRef = useRef<((content: string, attachedFiles?: AttachedFile[]) => Promise<void>) | undefined>(undefined);
  
  const messageOperations = useVersioning({
    messages,
    setMessages,
    chatId,
    isStreaming: liveOverlay.state !== 'static',
    setIsMessageBeingSent,
    onChatSwitch,
    onSendMessage: async (content: string) => {
      if (sendMessageRef.current) {
        await sendMessageRef.current(content);
      }
    }
  });

  const lastPreloadedChatIdRef = useRef<string | undefined>(undefined);
  const lastPreloadedCountRef = useRef<number>(0);
  const { preloadAllVersions } = messageOperations;
  useEffect(() => {
    if (!chatId || messages.length === 0) return;
    const chatChanged = lastPreloadedChatIdRef.current !== chatId;
    const countChanged = lastPreloadedCountRef.current !== messages.length;
    if (!chatChanged && !countChanged) return;

    lastPreloadedChatIdRef.current = chatId;
    lastPreloadedCountRef.current = messages.length;
    preloadAllVersions();
  }, [chatId, messages.length, preloadAllVersions]);

  useEffect(() => {
    (window as any).messageVersionsCache = messageOperations.messageVersions;
    
    return () => {
      delete (window as any).messageVersionsCache;
    };
  }, [messageOperations.messageVersions]);

  useEffect(() => {
    if (!chatId) return;
    
    logger.info(`[LOADING_CONTINUITY] Chat ${chatId} subscribing to version switch loading state`);
    
    const unsubscribe = versionSwitchLoadingManager.subscribe(chatId, (state) => {
      const shouldShowLoading = versionSwitchLoadingManager.isLoadingForChat(chatId);
      logger.info(`[LOADING_CONTINUITY] Chat ${chatId} version switch loading state:`, {
        isLoading: state.isLoading,
        operation: state.operation,
        targetChatId: state.targetChatId,
        shouldShowLoading
      });
      setVersionSwitchLoading(shouldShowLoading);
    });
    
    return () => {
      logger.info(`[LOADING_CONTINUITY] Chat ${chatId} unsubscribing from version switch loading state`);
      unsubscribe();
    };
  }, [chatId]);
  
  const isOperationLoading = versionSwitchLoading || messageOperations.isOperationLoading;
  
  logger.info(`[LOADING_CONTINUITY] Chat ${chatId} loading states:`, {
    versionSwitchLoading,
    localOperationLoading: messageOperations.isOperationLoading,
    finalIsOperationLoading: isOperationLoading
  });

  const lastAssistantFromMessages = useMemo(() => {
    return [...messages].reverse().find(m => m.role === 'assistant');
  }, [messages]);

  const forceBottomDuringStreaming = useMemo(() => {
    return liveOverlay.state !== 'static' && isLoading && !lastAssistantFromMessages;
  }, [liveOverlay.state, isLoading, lastAssistantFromMessages]);

  useEffect(() => {
    if (!isLoading) {
      const id = requestAnimationFrame(() => setNotLoadingSettled(true));
      return () => cancelAnimationFrame(id);
    } else {
      setNotLoadingSettled(false);
    }
  }, [isLoading]);

  const canRenderOverlay = useMemo(() => {
    return (liveOverlay.state !== 'static' || persistingAfterStream) && !lastAssistantFromMessages && notLoadingSettled;
  }, [liveOverlay.state, persistingAfterStream, lastAssistantFromMessages, notLoadingSettled]);

  useEffect(() => {
    if (isLoading || isOperationLoading) {
      const t = setTimeout(() => setSkeletonReady(true), SKELETON_READY_DELAY_MS);
      return () => clearTimeout(t);
    }
    setSkeletonReady(false);
  }, [isLoading, isOperationLoading]);

  const shouldShowSkeleton = useMemo(() => {
    return skeletonReady
      && (isLoading || isOperationLoading)
      && liveOverlay.state === 'static'
      && !persistingAfterStream
      && messages.length === 0;
  }, [skeletonReady, isLoading, isOperationLoading, liveOverlay.state, persistingAfterStream, messages.length]);

  const editAttachmentTracker = useRef(new Map<string, { original: Set<string>, added: Set<string> }>());

  const { isMessageBeingEdited, handleMessageEdit, handleEditSave, handleEditCancel } = useEditModal({ messages, messageOperations, onEditComplete: async (messageId, _content, success) => {
    if (!success) return;
    const track = editAttachmentTracker.current.get(messageId);
    if (!track) return;
    const toUnlink: string[] = Array.from(track.added);
    if (toUnlink.length === 0) { editAttachmentTracker.current.delete(messageId); return; }
    for (const fid of toUnlink) {
      try {
        await fetch(apiUrl(`/api/db/messages/${messageId}/files/${fid}`), { method: 'DELETE' });
      } catch {}
    }
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, attachedFiles: (m.attachedFiles || []).filter(f => !track.added.has(f.id)) } : m));
    editAttachmentTracker.current.delete(messageId);
  }});

  const { ttsState, handleTTSToggle, isSupported: isTTSSupported } = useTTS({ messages, chatId });

  useMessageIdSync({ chatId, setMessages });


  const scrollToBottom = useCallback(() => {
    if (!scrollControl.shouldAutoScroll()) {
      return;
    }
    
    const container = messagesEndRef.current?.parentElement;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [scrollControl]);


  useEffect(() => {
    if (!chatId) return;
    
    return liveStore.subscribe(chatId, (_id, snap) => {
      setLiveOverlay({
        contentBuf: snap.contentBuf,
        thoughtsBuf: snap.thoughtsBuf,
        state: snap.state
      });
      
      
      if (onChatStateChange) {
        onChatStateChange(_id, snap.state);
      }
    });
  }, [chatId, onChatStateChange, loadHistory]);

  const loadHistoryTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previousChatIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!chatId) return;
    try {
      logger.info(`[CHAT_SWITCH] Immediate loadHistory(forceReplace: true) for ${chatId}`);
      loadHistory({ forceReplace: true, silent: false }).catch(() => {});
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  useEffect(() => {
    if (chatId && chatId !== previousChatIdRef.current) {
      logger.info(`[CHAT_SWITCH] ===== CHAT COMPONENT RECEIVED NEW CHATID =====`);
      logger.info(`[CHAT_SWITCH] Previous chatId: ${previousChatIdRef.current}, New chatId: ${chatId}`);
      logger.info(`[CHAT_SWITCH] Current messages count: ${messages.length}`);
      logger.info(`[CHAT_SWITCH] isLoading: ${isLoading}, isOperationLoading: ${isOperationLoading}`);

      if (previousChatIdRef.current) {
        logger.info(`[CHAT_SWITCH] Clearing state for fast switch`);
        setMessages([]);
        setLiveOverlay({ contentBuf: '', thoughtsBuf: '', state: 'static' });
        setFirstMessageSent(false);
        setPersistingAfterStream(false);
        setWasStreaming(false);
      }

      previousChatIdRef.current = chatId;

      if (loadHistoryTimeoutRef.current) {
        clearTimeout(loadHistoryTimeoutRef.current);
        logger.info(`[DOUBLE_MOUNT] Cancelled pending loadHistory call due to rapid remount`);
      }

      loadHistoryTimeoutRef.current = setTimeout(() => {
        logger.info(`[CHAT_SWITCH] Calling loadHistory() after debounce`);
        loadHistory().then(() => {
          logger.info(`[CHAT_SWITCH] loadHistory() completed for ${chatId}`);
        }).catch((error) => {
          logger.error(`[CHAT_SWITCH] loadHistory() failed for ${chatId}:`, error);
        });
      }, LOAD_HISTORY_DEBOUNCE_MS);
    }

    return () => {
      if (loadHistoryTimeoutRef.current) {
        clearTimeout(loadHistoryTimeoutRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);


  useEffect(() => {
    logger.debug(`[FirstMessage] Effect triggered - chatId: ${chatId}, isActive: ${isActive}, firstMessage: ${!!firstMessage}, firstMessageSent: ${firstMessageSent}, isOperationLoading: ${isOperationLoading}`);

    if (chatId && isActive && firstMessage && firstMessage.trim() && !firstMessageSent && !isOperationLoading) {
      logger.debug(`[Chat] Sending first message for new chat ${chatId}`);

      performanceTracker.mark(performanceTracker.MARKS.FIRST_MESSAGE_CHECK, chatId);

      try {
        const parsed = JSON.parse(firstMessage);
        if (parsed.message && typeof parsed.message === 'string') {
          handleNewMessage(parsed.message, parsed.files || []);
        } else {
          handleNewMessage(firstMessage);
        }
      } catch {
        handleNewMessage(firstMessage);
      }

      setFirstMessageSent(true);
      if (onFirstMessageSent) {
        onFirstMessageSent(chatId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isActive, firstMessage, firstMessageSent, isOperationLoading]);


  useEffect(() => {
    const container = messagesEndRef.current?.parentElement;
    if (container && messagesContainerRef.current !== container) {
      messagesContainerRef.current = container;
    }
  }, []);

  useLayoutEffect(() => {
    const container = messagesEndRef.current?.parentElement as HTMLElement | null;
    if (!container) return;

    const isScrollable = computeIsScrollable(container);
    setNeedsBottomAnchor(isScrollable);

    if (isScrollable && messages.length > 0) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages.length]);

  useEffect(() => {
    const container = messagesEndRef.current?.parentElement as HTMLElement | null;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      setNeedsBottomAnchor(computeIsScrollable(container));
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [chatId]);

  useEffect(() => {
    const handler = () => {
      const container = messagesEndRef.current?.parentElement as HTMLElement | null;
      setNeedsBottomAnchor(computeIsScrollable(container || null));
    };
    window.addEventListener('chatContentResized', handler as any);
    return () => {
      window.removeEventListener('chatContentResized', handler as any);
    };
  }, [chatId]);

  useEffect(() => {
    setNeedsBottomAnchor(false);
  }, [chatId]);

  useEffect(() => {
    if (liveOverlay.state === 'responding') {
      scrollToBottom();
    }
  }, [liveOverlay.contentBuf, liveOverlay.state, scrollToBottom]);

  useEffect(() => {
    if (liveOverlay.state === 'static') {
      scrollToBottom();
    }
  }, [messages, scrollToBottom, liveOverlay.state]);

  const rendered = useMemo(() => {
    const out = [...messages];
    
    logger.info(`[RENDER_COMPUTE] Computing rendered messages for ${chatId}:`);
    logger.info(`[RENDER_COMPUTE] - Base messages: ${messages.length} (${messages.map(m => `${m.id}(${m.role})`).join(', ')})`);
    logger.info(`[RENDER_COMPUTE] - Live overlay: content=${liveOverlay.contentBuf.length}chars, thoughts=${liveOverlay.thoughtsBuf.length}chars, state=${liveOverlay.state}`);
    
    const lastIdx = [...out].reverse().findIndex(m => m.role === 'assistant');
    
    if (liveOverlay.contentBuf || liveOverlay.thoughtsBuf) {
      if (lastIdx !== -1) {
        const idx = out.length - 1 - lastIdx;
        const m = out[idx];
        const originalContent = m.content;
        const originalThoughts = m.thoughts || '';
        
        out[idx] = {
          ...m,
          content: m.content + liveOverlay.contentBuf,
          thoughts: (m.thoughts || '') + liveOverlay.thoughtsBuf
        };
        
        logger.info(`[RENDER_COMPUTE] - Applied live overlay to existing message ${m.id}:`);
        logger.info(`[RENDER_COMPUTE]   - Content: "${originalContent}" + "${liveOverlay.contentBuf}" = "${out[idx].content}"`);
        logger.info(`[RENDER_COMPUTE]   - Thoughts: "${originalThoughts}" + "${liveOverlay.thoughtsBuf}" = "${out[idx].thoughts}"`);
      } else {
        logger.info(`[CLEAN_STREAMING] Live content available but no existing assistant message - live overlay will handle display`);
        logger.info(`[CLEAN_STREAMING] Live content: ${liveOverlay.contentBuf.length}chars content, ${liveOverlay.thoughtsBuf.length}chars thoughts`);
        logger.info(`[CLEAN_STREAMING] ThinkBox component will display streaming content directly without virtual messages`);
      }
    }
    
    logger.info(`[RENDER_COMPUTE] Final rendered: ${out.length} messages (${out.map(m => `${m.id}(${m.role})`).join(', ')})`);
    
    return out;
  }, [messages, chatId, liveOverlay.contentBuf, liveOverlay.thoughtsBuf, liveOverlay.state]);
  
  useEffect(() => {
    const isCurrentlyStreaming = liveOverlay.state !== 'static';
    
    if (isCurrentlyStreaming && !wasStreaming) {
      logger.info(`[STREAM_STATE] Streaming started for ${chatId} - state: ${liveOverlay.state}`);
      setWasStreaming(true);
    } else if (!isCurrentlyStreaming && wasStreaming) {
      logger.info(`[STREAM_STATE] ===== STREAMING COMPLETED FOR ${chatId} =====`);
      logger.info(`[FINAL_STATE] Final live overlay state:`);
      logger.info(`[FINAL_STATE] - State: ${liveOverlay.state}`);
      logger.info(`[FINAL_STATE] - Content buffer: ${liveOverlay.contentBuf.length}chars`);
      logger.info(`[FINAL_STATE] - Thoughts buffer: ${liveOverlay.thoughtsBuf.length}chars`);
      
      logger.info(`[FINAL_STATE] Final messages state:`);
      logger.info(`[FINAL_STATE] - Message count: ${messages.length}`);
      logger.info(`[FINAL_STATE] - Message IDs: ${messages.map(m => m.id).join(', ')}`);
      logger.info(`[FINAL_STATE] - Message preview: ${messages.map(m => `${m.id}: "${m.content.substring(0, 30)}..."`).join(' | ')}`);
      
      logger.info(`[FINAL_STATE] Final operation states:`);
      logger.info(`[FINAL_STATE] - isDeleting: ${messageOperations.isDeleting}`);
      logger.info(`[FINAL_STATE] - isRetrying: ${messageOperations.isRetrying}`);
      logger.info(`[FINAL_STATE] - isEditing: ${messageOperations.isEditing}`);
      logger.info(`[FINAL_STATE] - isLoading: ${isLoading}`);
      logger.info(`[FINAL_STATE] - isOperationLoading: ${isOperationLoading}`);
      
      setWasStreaming(false);

      const lastAssistantMessage = [...rendered].reverse().find(m => m.role === 'assistant');
      const needPersistFetch = !lastAssistantMessage;
      if (needPersistFetch) {
        try {
          logger.info(`[RECONCILE_AFTER_STREAM] No assistant message present; silently reloading history for ${chatId}`);
          setPersistingAfterStream(true);
          setTimeout(() => {
            loadHistory({ forceReplace: true, silent: true })
              .then(() => {
                logger.info(`[RECONCILE_AFTER_STREAM] Silent history reload completed for ${chatId}`);
                setPersistingAfterStream(false);
              })
              .catch((e) => {
                logger.warn(`[RECONCILE_AFTER_STREAM] Silent reload failed for ${chatId}:`, e);
                setPersistingAfterStream(false);
              });
          }, RECONCILE_AFTER_STREAM_DELAY_MS);
        } catch (e) {
          logger.warn(`[RECONCILE_AFTER_STREAM] Error scheduling silent history reload for ${chatId}:`, e);
          setPersistingAfterStream(false);
        }
      }
      
      if (setIsMessageBeingSent && !messageOperations.isDeleting && !messageOperations.isRetrying && !messageOperations.isEditing) {
        logger.info(`[FINAL_STATE] Re-enabling send button for ${chatId}`);
        setIsMessageBeingSent(false);
      } else {
        logger.info(`[FINAL_STATE] NOT re-enabling send button - operations still active`);
      }
      
      logger.info(`[STREAM_STATE] ===== FINAL STATE VERIFICATION COMPLETED =====`);
    }
  }, [liveOverlay.state, setIsMessageBeingSent, messageOperations.isDeleting, messageOperations.isRetrying, messageOperations.isEditing, wasStreaming, chatId, liveOverlay.contentBuf.length, liveOverlay.thoughtsBuf.length, messages, isLoading, isOperationLoading, loadHistory, rendered]);


  useEffect(() => {
    if (onActiveStateChange && chatId) {
      onActiveStateChange(chatId, isActive);
    }
  }, [chatId, isActive, onActiveStateChange]);

  useEffect(() => {
    setPersistingAfterStream(false);
  }, [chatId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (onBusyStateChange && chatId) {
      onBusyStateChange();
    }
  }, [liveOverlay.state, onBusyStateChange, chatId]);

  const handleMessageCopy = useCallback((content: string) => {
    logger.debug('[Chat] Message copied to clipboard');
  }, []);

  const handleMessageRetry = useCallback(async (messageId: string) => {
    try {
      logger.debug(`[Chat] Retrying message ${messageId}`);
      const success = await messageOperations.retryMessage(messageId);
      
      if (success) {
        logger.debug(`[Chat] Successfully initiated retry for message ${messageId}`);
      } else {
        logger.error(`[Chat] Failed to retry message ${messageId}`);
      }
    } catch (error) {
      logger.error('[Chat] Error retrying message:', error);
    }
  }, [messageOperations]);

  const handleMessageDelete = useCallback(async (messageId: string) => {
    try {
      logger.info(`[Chat] Deleting message ${messageId} and all messages after it`);
      const success = await messageOperations.deleteMessage(messageId);
      
      if (success) {
        logger.debug(`[Chat] Successfully deleted message ${messageId} and subsequent messages`);
      } else {
        logger.error(`[Chat] Failed to delete message ${messageId}`);
      }
    } catch (error) {
      logger.error('[Chat] Error deleting message:', error);
    }
  }, [messageOperations]);


  const handleNewMessage = useCallback(async (content: string, attachedFiles?: AttachedFile[]) => {
    if (!chatId || !isActive) {
      logger.debug(`[Chat] Cannot send message - chatId: ${chatId}, isActive: ${isActive}`);
      return;
    }
    if (liveOverlay.state !== 'static') {
      logger.debug(`[Chat] Cannot send message while streaming (state: ${liveOverlay.state})`);
      return;
    }
    
    if (isDuplicateMessage(content)) {
      logger.debug(`[Chat] Duplicate message blocked for chat ${chatId}`);
      return;
    }

    if (setIsMessageBeingSent) {
      setIsMessageBeingSent(true);
    }

    if (liveOverlay.contentBuf || liveOverlay.thoughtsBuf) {
      setMessages(prev => {
        const updated = [...prev];
        const lastAssistantIdx = [...updated].reverse().findIndex(m => m.role === 'assistant');
        
        if (lastAssistantIdx !== -1) {
          const idx = updated.length - 1 - lastAssistantIdx;
          const msg = updated[idx];
          updated[idx] = {
            ...msg,
            content: msg.content + liveOverlay.contentBuf,
            thoughts: (msg.thoughts || '') + liveOverlay.thoughtsBuf
          };
        }
        return updated;
      });
    }

    setLiveOverlay({ contentBuf: '', thoughtsBuf: '', state: 'static' });
    liveStore.reset(chatId);

    const cid = crypto.randomUUID();

    performanceTracker.linkClientId(cid, chatId);

    const userMsg: Message = {
      id: `temp_${Date.now()}_user`,
      clientId: cid,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      attachedFiles: attachedFiles || []
    };
    const assistantPlaceholder: Message = {
      id: `temp_${Date.now()}_assistant`,
      clientId: cid + ':assistant',
      role: 'assistant',
      content: '',
      thoughts: '',
      timestamp: new Date().toISOString()
    };
    setMessages(prev => [...prev, userMsg, assistantPlaceholder]);

    try {
      logger.debug(`[Chat] Sending message to ${chatId}: "${content.substring(0, 50)}..."`);

      performanceTracker.mark(performanceTracker.MARKS.API_CALL_START, cid);

      const fetchPromise = fetch(apiUrl('/api/chat/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          chat_id: chatId,
          include_reasoning: true,
          client_id: cid,
          attached_file_ids: attachedFiles ? attachedFiles.map(f => f.id) : []
        })
      });

      performanceTracker.mark(performanceTracker.MARKS.API_CALL_SENT, cid);

      const response = await fetchPromise;

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      logger.debug(`[Chat] Message sent successfully for ${chatId}`);
      onMessageSent?.(content);
    } catch (error) {
      logger.error(`[Chat] Failed to send message to ${chatId}:`, error);
    }
  }, [chatId, isActive, liveOverlay, onMessageSent, isDuplicateMessage, setIsMessageBeingSent]);

  useEffect(() => {
    sendMessageRef.current = handleNewMessage;
  }, [handleNewMessage]);

  useImperativeHandle(ref, () => ({
    handleNewMessage,
    isBusy: () => liveOverlay.state !== 'static'
  }));

  const unlinkFileFromMessage = useCallback(async (messageId: string, fileId: string): Promise<void> => {
    try {
      const response = await fetch(apiUrl(`/api/db/messages/${messageId}/files/${fileId}`), {
        method: 'DELETE',
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({} as any));
        throw new Error(errorData.error || 'Failed to unlink file from message');
      }
      setMessages(prev => prev.map(m => {
        if (m.id !== messageId) return m;
        return { ...m, attachedFiles: (m.attachedFiles || []).filter(f => f.id !== fileId) };
      }));
      logger.info(`Unlinked file ${fileId} from message ${messageId}`);
    } catch (error) {
      logger.error('Failed to unlink file from message:', error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }, []);

  const handleAddFilesToMessage = useCallback(async (messageId: string, fileIds: string[]) => {
    try {
      const response = await fetch(apiUrl(`/api/db/messages/${messageId}/files/link`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_ids: fileIds })
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({} as any));
        throw new Error(err.error || 'Failed to link files');
      }
      const data = await response.json();
      const updated = (data.attached_files || []).map((f: any) => ({
        id: f.id,
        name: f.name || f.original_name,
        size: f.size || f.file_size,
        type: f.type || f.file_type,
        api_state: f.api_state,
        provider: f.provider
      }));
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, attachedFiles: updated } : m));
      window.dispatchEvent(new CustomEvent('removeFilesFromBar', { detail: { file_ids: fileIds } }));
      const track = editAttachmentTracker.current.get(messageId);
      if (track) {
        for (const fid of fileIds) { if (!track.original.has(fid)) track.added.add(fid); }
      }
    } catch (e) {
      logger.error('Failed to attach files to message:', e);
    }
  }, []);

  const lastAssistantMessage = useMemo(() => {
    return [...rendered].reverse().find(m => m.role === 'assistant');
  }, [rendered]);

  const renderMessage = useCallback((message: Message, originalIndex: number) => {
    const isStatic = liveOverlay.state === 'static';
    const messageTtsState = ttsState[message.id] || { enabled: false, playing: false };

    if (message.role === 'user') {
      const isFirstMessage = originalIndex === 0;
      const canAttachToThisMessage = !String(message.id).startsWith('temp_');
      return (
        <MessageWrapper
          key={message.clientId ?? String(message.id)}
          messageId={message.id}
          messageRole={message.role}
          messageContent={message.content}
          attachedFiles={message.attachedFiles}
          isStatic={true}
          isEditing={isMessageBeingEdited(message.id)}
          onCopy={handleMessageCopy}
          onTTSToggle={handleTTSToggle}
          onRetry={handleMessageRetry}
          onEdit={(id: string) => {
            const orig = new Set((message.attachedFiles || []).map(f => f.id));
            editAttachmentTracker.current.set(id, { original: orig, added: new Set() });
            handleMessageEdit(id);
          }}
          onEditSave={handleEditSave}
          onEditCancel={handleEditCancel}
          onAddFilesToMessage={canAttachToThisMessage ? (fileIds: string[]) => handleAddFilesToMessage(message.id, fileIds) : undefined}
          onDeleteFile={(fileId: string) => unlinkFileFromMessage(message.id, fileId)}
          onDelete={handleMessageDelete}
          onVersionSwitch={messageOperations.switchToVersion}
          hasVersions={messageOperations.hasVersions(message.id)}
          currentChatId={chatId}
          isTTSEnabled={messageTtsState.enabled}
          isTTSPlaying={messageTtsState.playing}
          isTTSSupported={isTTSSupported}
          className="user-message-wrapper"
        >
          {message.attachedFiles && message.attachedFiles.length > 0 && (
            <UserMessageFiles 
              files={message.attachedFiles} 
              onFileDelete={(fileId) => unlinkFileFromMessage(message.id, fileId)}
              isStatic={isStatic}
              chatId={chatId}
              messageId={message.id}
              chatScrollControl={scrollControl}
            />
          )}
          <div className="user-message-content">
            <UserMessage 
              content={message.content}
              isFirstMessage={isFirstMessage}
              isStatic={isStatic}
            />
          </div>
        </MessageWrapper>
      );
    }

    const isLastAssistantMessage = message.id === lastAssistantMessage?.id;
    const showCursor = isLastAssistantMessage && liveOverlay.state === 'responding';
    const assistantMessageIsStatic = (isStatic || !isLastAssistantMessage) && !(isLastAssistantMessage && !message.content.trim());

    const canAttachToThisMessage = !String(message.id).startsWith('temp_');
    return (
      <MessageWrapper
        key={message.clientId ?? String(message.id)}
        messageId={message.id}
        messageRole={message.role}
        messageContent={message.content}
        attachedFiles={message.attachedFiles}
        isStatic={assistantMessageIsStatic}
        isEditing={isMessageBeingEdited(message.id)}
        onCopy={handleMessageCopy}
        onTTSToggle={handleTTSToggle}
        onRetry={handleMessageRetry}
        onEdit={(id: string) => {
          const orig = new Set((message.attachedFiles || []).map(f => f.id));
          editAttachmentTracker.current.set(id, { original: orig, added: new Set() });
          handleMessageEdit(id);
        }}
        onEditSave={handleEditSave}
        onEditCancel={handleEditCancel}
        onAddFilesToMessage={canAttachToThisMessage ? (fileIds: string[]) => handleAddFilesToMessage(message.id, fileIds) : undefined}
        onDeleteFile={(fileId: string) => unlinkFileFromMessage(message.id, fileId)}
        onDelete={handleMessageDelete}
        onVersionSwitch={messageOperations.switchToVersion}
        hasVersions={messageOperations.hasVersions(message.id)}
        currentChatId={chatId}
        isTTSEnabled={messageTtsState.enabled}
        isTTSPlaying={messageTtsState.playing}
        isTTSSupported={isTTSSupported}
        className="assistant-message"
      >
        {message.thoughts && (
          <ThinkBox 
            key={`thinkbox-${message.clientId ?? String(message.id)}`}
            thoughts={message.thoughts}
            isStreaming={isLastAssistantMessage && liveOverlay.state === 'thinking'}
            isVisible={true}
            chatId={chatId}
            messageId={message.id}
            chatScrollControl={scrollControl}
          />
        )}
        
        <div className="response-content">
          <MessageRenderer 
            content={message.content} 
            showCursor={showCursor}
          />
        </div>
      </MessageWrapper>
    );
  }, [liveOverlay.state, ttsState, lastAssistantMessage?.id, isMessageBeingEdited, handleMessageCopy, handleTTSToggle, handleMessageRetry, handleMessageEdit, handleEditSave, handleEditCancel, handleMessageDelete, isTTSSupported, chatId, scrollControl, unlinkFileFromMessage, handleAddFilesToMessage, messageOperations]);

  const messageIndexMap = useMemo(() => {
    return new Map(messages.map((msg, idx) => [msg.id, idx]));
  }, [messages]);

  return (
    <>
      <div className="chat-messages">
        <div className="messages-container">
          {(needsBottomAnchor || (forceBottomDuringStreaming && canRenderOverlay)) && (
            <div className="spacer" style={{flex: '1 0 auto'}}></div>
          )}
          {useMemo(() => {
            if (shouldShowSkeleton) {
              logger.info(`[CHAT_RENDER] Rendering skeleton for ${chatId} - isLoading: ${isLoading}, isOperationLoading: ${isOperationLoading}`);
              return (
                <div className="messages-skeleton">
                  <div className="msg-skel" />
                  <div className="msg-skel" />
                </div>
              );
            }
            
            logger.info(`[CHAT_RENDER] Rendering ${rendered.length} messages for ${chatId}`);
            logger.info(`[CHAT_RENDER] About to render message IDs: ${rendered.map(m => m.id).join(', ')}`);
            logger.info(`[CHAT_RENDER] Message preview: ${rendered.map(m => `${m.id}: "${m.content.substring(0, 30)}..."`).join(' | ')}`);

            const renderedComponents = rendered.map((message) => {
              const originalIndex = messageIndexMap.get(message.id) ?? -1;
              logger.info(`[CHAT_RENDER] Rendering component for ${message.id} (${message.role}) - content: "${message.content.substring(0, 50)}..."`);
              return renderMessage(message, originalIndex);
            });
            
            logger.info(`[CHAT_RENDER] Final render output: ${renderedComponents.length} React components for ${chatId}`);
            return renderedComponents;
          }, [shouldShowSkeleton, isLoading, isOperationLoading, rendered, chatId, messageIndexMap, renderMessage])}

          {canRenderOverlay && (
            <div className="assistant-message">
              {liveOverlay.thoughtsBuf.length > 0 && (
                <ThinkBox 
                  key={`thinkbox-live-${chatId}`}
                  thoughts={liveOverlay.thoughtsBuf}
                  isStreaming={liveOverlay.state === 'thinking'}
                  isVisible={true}
                  chatId={chatId}
                  messageId={`live_assistant_${chatId}`}
                  chatScrollControl={scrollControl}
                />
              )}
              <div className="response-content">
                <MessageRenderer 
                  content={liveOverlay.contentBuf}
                  showCursor={liveOverlay.state === 'responding'}
                />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>
      
    </>
  );
}));

Chat.displayName = 'Chat';

export default Chat;
