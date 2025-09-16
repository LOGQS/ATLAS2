// status: complete

import { useState, useCallback, useEffect, useRef } from 'react';
import { apiUrl } from '../../config/api';
import logger from '../../utils/core/logger';
import type { Message } from '../../types/messages';
import { versionSwitchLoadingManager } from '../../utils/versioning/versionSwitchLoadingManager';
import { sendButtonStateManager, reloadNotifier, liveStore } from '../../utils/chat/LiveStore';
import { chatHistoryCache } from '../../utils/chat/ChatHistoryCache';

const OPERATIONS = {
  DELETE: 'delete' as const,
  RETRY: 'retry' as const,
  EDIT: 'edit' as const
};

const API_ENDPOINTS = {
  VERSIONS: '/api/messages/{messageId}/versions',
  VERSIONING_NOTIFY: '/api/db/versioning/notify',
  CHAT_STREAM: '/api/chat/stream'
} as const;

interface VersionInfo {
  version_number: number;
  chat_version_id: string;
  operation: string;
  created_at: string;
}

interface UseVersioningProps {
  chatId?: string;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  onChatSwitch?: (chatId: string) => Promise<void>;
  onSendMessage?: (content: string, skipHistory?: boolean) => Promise<void>;
  isStreaming?: boolean;
  setIsMessageBeingSent?: React.Dispatch<React.SetStateAction<boolean>>;
}

export const useVersioning = ({
  chatId,
  messages,
  setMessages,
  onChatSwitch,
  onSendMessage,
  isStreaming = false,
  setIsMessageBeingSent
}: UseVersioningProps) => {
  const [messageVersions, setMessageVersions] = useState<Map<string, VersionInfo[]>>(new Map());
  const versionsRef = useRef<Map<string, VersionInfo[]>>(new Map());
  useEffect(() => { versionsRef.current = messageVersions; }, [messageVersions]);
  const [currentOperation, setCurrentOperation] = useState<string | null>(null);
  const [operationInProgressMap, setOperationInProgressMap] = useState<{[messageId: string]: boolean}>({});
  const abortControllerRef = useRef<AbortController | null>(null);


  const loadMessageVersions = useCallback(async (messageId: string, forceRefresh: boolean = false): Promise<VersionInfo[]> => {
    if (!forceRefresh) {
      const cached = versionsRef.current.get(messageId);
      if (cached && cached.length > 0) {
        logger.debug(`[Versioning] Using cached versions for ${messageId}`);
        return cached;
      }
    }

    try {
      const response = await fetch(apiUrl(API_ENDPOINTS.VERSIONS.replace('{messageId}', messageId)));
      if (response.ok) {
        const data = await response.json();
        const versions = (data.versions || []) as VersionInfo[];
        const prev = versionsRef.current.get(messageId) || [];
        const same = prev.length === versions.length && prev.every((p, i) => p.version_number === versions[i]?.version_number && p.chat_version_id === versions[i]?.chat_version_id && p.operation === versions[i]?.operation);
        if (!same) {
          const newMap = new Map(versionsRef.current);
          newMap.set(messageId, versions);
          versionsRef.current = newMap;
          setMessageVersions(newMap);
        }
        logger.debug(`[Versioning] Loaded ${versions.length} versions for ${messageId}`);
        return versions;
      }
    } catch (error) {
      logger.debug(`No versions found for message ${messageId}`);
    }
    return [];
  }, []);

  const parsePosition = useCallback((id: string): { base: string; pos: number } | null => {
    if (!id || id.indexOf('_') === -1) return null;
    const parts = id.split('_');
    const last = parts.pop();
    if (!last) return null;
    const pos = parseInt(last, 10);
    if (Number.isNaN(pos)) return null;
    const base = parts.join('_');
    return { base, pos };
  }, []);

  const hasVersions = useCallback((messageId: string): boolean => {
    const versions = messageVersions.get(messageId);
    if (versions && versions.length > 1) return true;

    const msg = messages.find(m => m.id === messageId);
    if (msg && msg.role === 'assistant') {
      const parsed = parsePosition(messageId);
      if (parsed && parsed.pos > 1) {
        const prevUserId = `${parsed.base}_${parsed.pos - 1}`;
        const prevVersions = messageVersions.get(prevUserId);
        if (prevVersions && prevVersions.length > 1) return true;
      }
    }
    return false;
  }, [messageVersions, messages, parsePosition]);

  const preloadAllVersions = useCallback(async () => {
    if (!messages || messages.length === 0) return;
    
    logger.debug(`[Versioning] Preloading versions for ${messages.length} messages`);
    
    const promises = messages.map(msg => loadMessageVersions(msg.id));
    await Promise.all(promises);
  }, [messages, loadMessageVersions]);

  const invalidateCache = useCallback((messageId?: string) => {
    if (messageId) {
      const newMap = new Map(versionsRef.current);
      newMap.delete(messageId);
      versionsRef.current = newMap;
      setMessageVersions(newMap);
      logger.debug(`[Versioning] Invalidated cache for ${messageId}`);
    } else {
      versionsRef.current = new Map();
      setMessageVersions(new Map());
      logger.debug(`[Versioning] Invalidated all version cache`);
    }
  }, []);

  const setupOperation = useCallback((operation: 'edit' | 'retry' | 'delete', messageId: string) => {
    if (!chatId) return;
    chatHistoryCache.markDirty(chatId);
    setCurrentOperation(`${operation}:${messageId}`);
    setOperationInProgressMap(prev => ({ ...prev, [messageId]: true }));
    versionSwitchLoadingManager.startLoading(operation, chatId);
    sendButtonStateManager.setSendButtonDisabled(chatId, true);
    abortControllerRef.current = new AbortController();
  }, [chatId]);

  const cleanupOperation = useCallback((messageId: string) => {
    setCurrentOperation(null);
    setOperationInProgressMap(prev => {
      const newMap = { ...prev };
      delete newMap[messageId];
      return newMap;
    });
    abortControllerRef.current = null;
  }, []);

  const handleOperationError = useCallback((error: any, operation: string, originalMessages: Message[], messageId: string) => {
    logger.error(`Operation ${operation} failed:`, error);
    setMessages(originalMessages);
    versionSwitchLoadingManager.endLoading();
    sendButtonStateManager.clearSendButtonState(chatId!);
    if (chatId) {
      reloadNotifier.notifyReload(chatId);
    }
  }, [chatId, setMessages]);

  const getOperationType = useCallback((operation: string | null): { isDeleting: boolean; isRetrying: boolean; isEditing: boolean } => {
    if (!operation) return { isDeleting: false, isRetrying: false, isEditing: false };

    return {
      isDeleting: operation.startsWith(`${OPERATIONS.DELETE}:`),
      isRetrying: operation.startsWith(`${OPERATIONS.RETRY}:`),
      isEditing: operation.startsWith(`${OPERATIONS.EDIT}:`)
    };
  }, []);

  const executeOperation = useCallback(async (
    operation: 'edit' | 'retry' | 'delete',
    messageId: string,
    newContent?: string
  ): Promise<boolean> => {
    if (!chatId || currentOperation) {
      logger.warn('Operation already in progress or missing chatId');
      return false;
    }

    setupOperation(operation, messageId);

    const originalMessages = [...messages];
    if (operation === 'delete') {
      const targetIndex = messages.findIndex(m => m.id === messageId);
      if (targetIndex >= 0) {
        setMessages(messages.slice(0, targetIndex));
      }
    } else if (operation === 'edit' && newContent) {
      const targetIndex = messages.findIndex(m => m.id === messageId);
      if (targetIndex >= 0) {
        const updatedMessages = [...messages];
        updatedMessages[targetIndex] = { ...updatedMessages[targetIndex], content: newContent };
        if (messages[targetIndex].role === 'user') {
          setMessages(updatedMessages.slice(0, targetIndex + 1));
        } else {
          setMessages(updatedMessages);
        }
      }
    }

    try {
      const response = await fetch(apiUrl(API_ENDPOINTS.VERSIONING_NOTIFY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation_type: operation,
          message_id: messageId,
          chat_id: chatId,
          new_content: newContent
        }),
        signal: abortControllerRef.current?.signal
      });

      if (!response.ok) {
        throw new Error(`Version creation failed: ${response.status}`);
      }

      const result = await response.json();
      
      if (!result.success || !result.version_chat_id) {
        throw new Error('Invalid version response');
      }

      sendButtonStateManager.setSendButtonDisabled(chatId, true);
      sendButtonStateManager.setSendButtonDisabled(result.version_chat_id, true);
      liveStore.registerVersionStream(result.version_chat_id, chatId);

      if (onChatSwitch) {
        await onChatSwitch(result.version_chat_id);
      }

      invalidateCache(messageId);

      versionSwitchLoadingManager.endLoading();
      
      if (result.needs_streaming && result.stream_message) {
        try {
          const payload: any = {
            message: result.stream_message,
            chat_id: result.version_chat_id,
            include_reasoning: true
          };
          if (operation === 'edit' && result.target_message_id) {
            payload.is_edit_regeneration = true;
            payload.existing_message_id = result.target_message_id;
          }
          if (operation === 'retry') {
            payload.is_retry = true;
          }
          if (Array.isArray(result.attached_file_ids) && result.attached_file_ids.length > 0) {
            payload.attached_file_ids = result.attached_file_ids;
          }

          await fetch(apiUrl(API_ENDPOINTS.CHAT_STREAM), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
        } catch (streamErr) {
          logger.error('[Versioning] Failed to initiate streaming for version chat:', streamErr);
        }
      } else {
        sendButtonStateManager.setSendButtonDisabled(chatId, false);
        sendButtonStateManager.setSendButtonDisabled(result.version_chat_id, false);
        sendButtonStateManager.clearParentChild(result.version_chat_id);
      }

      return true;

    } catch (error) {
      handleOperationError(error, operation, originalMessages, messageId);
      return false;

    } finally {
      cleanupOperation(messageId);
    }
  }, [chatId, currentOperation, messages, setMessages, onChatSwitch, invalidateCache, setupOperation, cleanupOperation, handleOperationError]);

  const handleDelete = useCallback(async (messageId: string): Promise<boolean> => {
    return executeOperation('delete', messageId);
  }, [executeOperation]);

  const handleRetry = useCallback(async (messageId: string): Promise<boolean> => {
    return executeOperation('retry', messageId);
  }, [executeOperation]);

  const handleEdit = useCallback(async (messageId: string, newContent: string): Promise<boolean> => {
    if (!newContent || !newContent.trim()) {
      logger.warn('[Versioning] Cannot edit message with empty content');
      return false;
    }
    return executeOperation('edit', messageId, newContent);
  }, [executeOperation]);

  const switchToVersion = useCallback(async (versionChatId: string) => {
    if (!onChatSwitch || versionChatId === chatId) return;
    
    versionSwitchLoadingManager.startLoading('edit', versionChatId);
    await onChatSwitch(versionChatId);
    versionSwitchLoadingManager.endLoading();
  }, [chatId, onChatSwitch]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    handleDelete,
    handleRetry,
    handleEdit,
    
    deleteMessage: handleDelete,
    retryMessage: handleRetry,
    editMessage: handleEdit,
    
    loadMessageVersions,
    hasVersions,
    switchToVersion,
    messageVersions,
    preloadAllVersions,
    invalidateCache,
    
    operationInProgress: operationInProgressMap,
    isOperationLoading: currentOperation !== null,
    
    ...getOperationType(currentOperation)
  };
};
