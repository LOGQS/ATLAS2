import { useState, useCallback, useRef, useEffect } from 'react';
import { apiUrl } from '../../config/api';
import { liveStore, reloadNotifier } from '../../utils/chat/LiveStore';
import logger from '../../utils/core/logger';
import { reconcileMessages, handleNewChatScenario } from '../../utils/chat/chatUtils';
import { chatHistoryCache } from '../../utils/chat/ChatHistoryCache';
import type { Message } from '../../types/messages';

const CALLBACK_CHECK_DELAY_MS = 10;

interface UseChatHistoryProps {
  chatId?: string;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  messages: Message[];
}

interface LoadHistoryOptions {
  forceReplace?: boolean;
  chatId?: string;
  silent?: boolean;
}

export const useChatHistory = ({ chatId, setMessages, messages }: UseChatHistoryProps) => {
  const [isLoading, setIsLoading] = useState(true);
  const [isValidating, setIsValidating] = useState(false);

  const setMessagesRef = useRef(setMessages);
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const validationAbortControllerRef = useRef<AbortController | undefined>(undefined);
  const activeChatIdRef = useRef<string | undefined>(chatId);
  const loadRequestIdRef = useRef(0);
  const validateRequestIdRef = useRef(0);



  useEffect(() => {
    setMessagesRef.current = setMessages;
    activeChatIdRef.current = chatId;
    logger.info(`[RECONCILE] Updated setMessages ref for chatId: ${chatId}`);
  }, [setMessages, chatId]);

  const validateCache = useCallback(async (targetChatId: string) => {
    const requestId = ++validateRequestIdRef.current;

    try {
      if (validationAbortControllerRef.current) {
        validationAbortControllerRef.current.abort();
      }
      validationAbortControllerRef.current = new AbortController();
      const signal = validationAbortControllerRef.current.signal;

      const res = await fetch(apiUrl(`/api/db/chat/${targetChatId}`), { signal });
      const data: { history?: Message[]; error?: string } = await res.json();

      if (res.ok) {
        const freshMessages = data.history || [];

        if (!chatHistoryCache.validateMetadata(targetChatId, freshMessages)) {
          logger.info(`[ChatCache] Cache invalidated for ${targetChatId}, updating with fresh data`);

          if (validateRequestIdRef.current !== requestId) {
            return;
          }

          if (activeChatIdRef.current === targetChatId) {
            setMessagesRef.current(prev => {
              // Guard against race condition during rapid chat switching
              if (activeChatIdRef.current !== targetChatId) {
                return prev;
              }
              const result = reconcileMessages(prev, freshMessages, targetChatId, false);
              const currentLiveState = liveStore.get(targetChatId);
              if (currentLiveState?.state === 'static') {
                chatHistoryCache.put(targetChatId, result, 'clean-static');
              }
              return result;
            });
          } else {
            const currentLiveState = liveStore.get(targetChatId);
            if (currentLiveState?.state === 'static') {
              chatHistoryCache.put(targetChatId, freshMessages, 'clean-static');
            }
          }

          // Reconcile LiveStore with DB to clear stale streaming buffers
          const lastA = [...freshMessages].reverse().find(m => m.role === 'assistant');
          liveStore.reconcileWithDB(
            targetChatId,
            lastA?.id || null,
            lastA?.content || '',
            lastA?.thoughts || ''
          );
        } else {
          logger.info(`[ChatCache] Cache validated successfully for ${targetChatId}`);
        }
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        logger.error(`[ChatCache] Validation failed for ${targetChatId}:`, error);
      }
    } finally {
      if (validateRequestIdRef.current === requestId) {
        setIsValidating(false);
      }
    }
  }, []);

  const loadHistory = useCallback(async (options: LoadHistoryOptions = {}) => {
    const targetChatId = options.chatId || chatId;
    if (!targetChatId) return;
    const forceReplaceMessages = options.forceReplace ?? false;
    const silent = options.silent ?? false;
    const requestId = ++loadRequestIdRef.current;

    if (!forceReplaceMessages && !silent) {
      const cached = chatHistoryCache.get(targetChatId);
      if (cached) {
        logger.info(`[ChatCache] Using cached messages for ${targetChatId} (${cached.messages.length} messages)`);

        if (activeChatIdRef.current === targetChatId && loadRequestIdRef.current === requestId) {
          setMessagesRef.current(prev => {
            // Guard against race condition during rapid chat switching
            if (activeChatIdRef.current !== targetChatId) {
              return prev;
            }
            logger.info(`[ChatCache] Setting cached messages immediately`);
            return cached.messages;
          });
        }

        // Reconcile LiveStore to clear stale streaming buffers
        const lastA = [...cached.messages].reverse().find(m => m.role === 'assistant');
        liveStore.reconcileWithDB(
          targetChatId,
          lastA?.id || null,
          lastA?.content || '',
          lastA?.thoughts || ''
        );
        logger.info(`[CHAT_LOAD_DONE] DB load applied for ${targetChatId} (requestId=${requestId}, messages=${cached.messages.length})`);

        if (!silent && loadRequestIdRef.current === requestId) {
          setIsLoading(false);
          logger.info(`[CHAT_LOAD_STATE] Cached load cleared isLoading for ${targetChatId} (requestId=${requestId})`);
        } else if (silent) {
          logger.info(`[CHAT_LOAD_STATE] Cached load completed silently for ${targetChatId} (requestId=${requestId})`);
        }

        logger.info(`[CHAT_LOAD_DONE] Cached load satisfied for ${targetChatId} (requestId=${requestId})`);
        setIsValidating(true);
        validateCache(targetChatId);
        return;
      }
    }

    if (abortControllerRef.current) {
      logger.info(`[ChatHistory] Aborting previous loadHistory for ${targetChatId}`);
      abortControllerRef.current.abort();
    }

    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    if (!silent) {
      logger.info(`[CHAT_LOAD_STATE] setIsLoading(true) for ${targetChatId} (requestId=${requestId}, forceReplace=${forceReplaceMessages})`);
      setIsLoading(true);
    } else {
      logger.info(`[CHAT_LOAD_STATE] Silent load started for ${targetChatId} (requestId=${requestId}, forceReplace=${forceReplaceMessages})`);
    }
    try {
      logger.info(`[ChatHistory] === LOAD HISTORY CALLED FOR ${targetChatId} (forceReplace: ${forceReplaceMessages}) ===`);
      const res = await fetch(apiUrl(`/api/db/chat/${targetChatId}`), { signal });
      const data: { history?: Message[]; error?: string } = await res.json();
      
      if (res.ok) {
        const hist: Message[] = data.history || [];
        logger.info(`[ChatHistory] Database returned ${hist.length} messages for ${targetChatId}:`);
        hist.forEach((m, i) => {
          const contentPreview = m.content ? m.content.substring(0, 50) : '';
          logger.info(`[ChatHistory] DB[${i}]: ${m.id}(${m.role}) content="${contentPreview}..."`);
        });

        const assistantMessages = hist.filter(m => m.role === 'assistant');
        if (assistantMessages.length > 0) {
          const lastAssistant = assistantMessages[assistantMessages.length - 1];
          logger.info(
            `[ROUTER_STATE_DB_CHECK] ${targetChatId} lastAssistant=${lastAssistant.id} ` +
            `routerEnabled=${Boolean(lastAssistant.routerEnabled)} ` +
            `hasDecision=${Boolean(lastAssistant.routerDecision?.route)} ` +
            `route=${lastAssistant.routerDecision?.route ?? 'none'}`
          );

          const missingRouterMeta = assistantMessages.filter(msg => msg.routerEnabled && !msg.routerDecision?.route);
          if (missingRouterMeta.length > 0) {
            logger.warn(
              `[ROUTER_STATE_DB_CHECK] ${targetChatId} assistants with routerEnabled but missing decision: ${missingRouterMeta.map(m => m.id).join(', ')}`
            );
          }
        } else {
          logger.info(`[ROUTER_STATE_DB_CHECK] ${targetChatId} has no assistant messages in DB snapshot`);
        }
        
        if (loadRequestIdRef.current !== requestId) {
          const currentLiveState = liveStore.get(targetChatId);
          if (currentLiveState?.state === 'static') {
            chatHistoryCache.put(targetChatId, hist, 'clean-static');
          }
          return;
        }

        if (activeChatIdRef.current !== targetChatId) {
          const currentLiveState = liveStore.get(targetChatId);
          if (currentLiveState?.state === 'static') {
            chatHistoryCache.put(targetChatId, hist, 'clean-static');
          }
          return;
        }
        
        const currentSetMessages = setMessagesRef.current;
        logger.info(`[RECONCILE] setMessages function available: ${typeof currentSetMessages}, chatId: ${chatId}, targetChatId: ${targetChatId}`);
        logger.info(`[RECONCILE] Using fresh setMessages ref to prevent stale closure issues`);
        
        if (!currentSetMessages) {
          logger.error(`[RECONCILE] CRITICAL: setMessages ref is undefined! Cannot update React state.`);
          return;
        }
        
        logger.info(`[RECONCILE] ===== ABOUT TO CALL setMessages FOR ${targetChatId} =====`);
        logger.info(`[RECONCILE] Current chatId context: ${chatId}, targetChatId: ${targetChatId}`);
        logger.info(`[RECONCILE] setMessages function: ${currentSetMessages.toString().substring(0, 100)}...`);
        
        try {
          logger.info(`[RECONCILE] ===== CALLING FRESH setMessages FUNCTION VIA REF =====`);
          const callbackExecuted = { value: false };
          
          currentSetMessages(prev => {
            callbackExecuted.value = true;
            logger.info(`[RECONCILE] ===== SETMESSAGES CALLBACK STARTED =====`);

            // Guard against race condition during rapid chat switching
            if (activeChatIdRef.current !== targetChatId) {
              logger.warn(`[RECONCILE] Chat switched during callback - aborting state update`);
              return prev;
            }

            logger.info(`[MESSAGE_STATE] ChatHistory before reconciliation - prev: ${prev.length} messages: ${prev.map(m => `${m.id}(${m.role})`).join(', ')}`);
            prev.forEach((m, i) => {
              const contentPreview = m.content ? m.content.substring(0, 50) : '';
              logger.info(`[MESSAGE_STATE] PREV[${i}]: ${m.id}(${m.role}) content="${contentPreview}..."`);
            });
            const result = reconcileMessages(prev, hist, targetChatId, forceReplaceMessages);
            logger.info(`[MESSAGE_STATE] ChatHistory after reconciliation - result: ${result.length} messages: ${result.map(m => `${m.id}(${m.role})`).join(', ')}`);
            result.forEach((m, i) => {
              const contentPreview = m.content ? m.content.substring(0, 50) : '';
              logger.info(`[MESSAGE_STATE] RESULT[${i}]: ${m.id}(${m.role}) content="${contentPreview}..."`);
            });

            const currentLiveState = liveStore.get(targetChatId);
            if (currentLiveState?.state === 'static') {
              chatHistoryCache.put(targetChatId, result, 'clean-static');
              logger.info(`[ChatCache] Cached ${result.length} messages for ${targetChatId}`);
            }
            const hasChanged = prev !== result && JSON.stringify(prev) !== JSON.stringify(result);
            logger.info(`[RECONCILE] State update check - hasChanged: ${hasChanged}, prev===result: ${prev === result}`);
            logger.info(`[RECONCILE] RETURNING RESULT TO REACT STATE - ${result.length} messages for ${targetChatId}`);
            logger.info(`[RECONCILE] ===== SETMESSAGES CALLBACK COMPLETED =====`);

            return result;
          });
          
          setTimeout(() => {
            logger.info(`[RECONCILE] Callback execution check: ${callbackExecuted.value}`);
            if (!callbackExecuted.value) {
              logger.error(`[RECONCILE] CRITICAL: setMessages callback was NEVER EXECUTED - stale reference detected!`);
            }
          }, CALLBACK_CHECK_DELAY_MS);
          
          logger.info(`[RECONCILE] setMessages call completed successfully for ${targetChatId}`);
          
        } catch (error) {
          logger.error(`[RECONCILE] setMessages call failed:`, error);
        }
        
        const lastA = [...hist].reverse().find(m => m.role === 'assistant');
        liveStore.reconcileWithDB(
          targetChatId,
          lastA?.id || null,
          lastA?.content || '',
          lastA?.thoughts || ''
        );
      } else if (res.status === 404) {
        logger.debug(`[ChatHistory] Chat not found (404), handling new chat scenario`);
        if (loadRequestIdRef.current === requestId && activeChatIdRef.current === targetChatId) {
          setMessagesRef.current(prev => {
            // Guard against race condition during rapid chat switching
            if (activeChatIdRef.current !== targetChatId) {
              return prev;
            }
            return handleNewChatScenario(prev, targetChatId);
          });
        }
      } else {
        logger.error(`[ChatHistory] Failed to load history for ${targetChatId}:`, data.error);
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        logger.info(`[ChatHistory] Load history aborted for ${targetChatId}`);
      } else {
        logger.error(`[ChatHistory] Error loading history for ${targetChatId}:`, e);
      }
    } finally {
      if (loadRequestIdRef.current === requestId) {
        if (!silent) {
          logger.info(`[CHAT_LOAD_STATE] setIsLoading(false) for ${targetChatId} (requestId=${requestId})`);
          setIsLoading(false);
        } else {
          logger.info(`[CHAT_LOAD_STATE] Silent load completed for ${targetChatId} (requestId=${requestId})`);
        }
      } else {
        logger.info(`[CHAT_LOAD_STATE] Skipping completion update for ${targetChatId} (requestId=${requestId}, latest=${loadRequestIdRef.current})`);
      }
    }
  }, [chatId, validateCache]); 

  useEffect(() => {
    if (chatId) {
      logger.info(`[RELOAD_NOTIFIER] Component mounting - registering reload for ${chatId}`);
      const reloadFn = () => {
        logger.info(`[RELOAD_NOTIFIER] Reload notification received for ${chatId} - calling loadHistory(forceReplace: true)`);
        chatHistoryCache.markDirty(chatId);
        loadHistory({ forceReplace: true });
      };

      reloadNotifier.register(chatId, reloadFn);

      return () => {
        logger.info(`[RELOAD_NOTIFIER] Component unmounting - unregistering reload for ${chatId}`);
        reloadNotifier.unregister(chatId);
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }
      };
    }
  }, [chatId, loadHistory]);

  return {
    isLoading,
    isValidating,
    loadHistory
  };
};





