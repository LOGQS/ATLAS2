import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import logger from '../../utils/core/logger';
import { liveStore } from '../../utils/chat/LiveStore';
import type { Message } from '../../types/messages';

const TTS_CONFIG = {
  DEFAULT_RATE: 1.0,
  DEFAULT_PITCH: 1.0,
  DEFAULT_VOLUME: 0.9,
} as const;

interface TTSState {
  [messageId: string]: {
    enabled: boolean;
    playing: boolean;
  };
}

interface UseTTSProps {
  messages: Message[];
  chatId?: string;
}

export const useTTS = ({ messages, chatId }: UseTTSProps) => {
  const [ttsState, setTtsState] = useState<TTSState>({});
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const currentMessageIdRef = useRef<string | null>(null);
  const previousMessageIdsRef = useRef<Map<string, string>>(new Map());

  const isSupported = 'speechSynthesis' in window;

  useEffect(() => {
    const currentMessageIds = new Map<string, string>();
    
    messages.forEach(message => {
      if (message.clientId) {
        currentMessageIds.set(message.clientId, message.id);
      }
    });
    
    const idsToMigrate: Array<{ from: string; to: string }> = [];
    
    currentMessageIds.forEach((newId, clientId) => {
      const oldId = previousMessageIdsRef.current.get(clientId);
      
      if (oldId !== undefined && oldId !== newId && ttsState[oldId]) {
        idsToMigrate.push({ from: oldId, to: newId });
        logger.debug(`[TTS] Message ID changed: ${oldId} -> ${newId} (clientId: ${clientId})`);
      }
    });
    
    if (idsToMigrate.length > 0) {
      setTtsState(prev => {
        const newState = { ...prev };
        
        idsToMigrate.forEach(({ from, to }) => {
          newState[to] = { ...prev[from] };
          delete newState[from];
          
          if (currentMessageIdRef.current === from) {
            currentMessageIdRef.current = to;
            logger.debug(`[TTS] Updated current playing message ID: ${from} -> ${to}`);
          }
        });
        
        logger.debug(`[TTS] Migrated TTS state for ${idsToMigrate.length} messages`);
        return newState;
      });
    }
    
    previousMessageIdsRef.current = new Map(currentMessageIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const lastAssistantMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        return messages[i];
      }
    }
    return null;
  }, [messages]);

  const getCompleteMessageContent = useCallback((message: Message): string => {
    let content = message.content || '';

    if (chatId && message.role === 'assistant' && lastAssistantMessage?.id === message.id) {
      const liveState = liveStore.get(chatId);
      if (liveState && liveState.contentBuf) {
        content = content + liveState.contentBuf;
      }
    }

    return content;
  }, [lastAssistantMessage, chatId]);

  const cleanTextForTTS = useCallback((text: string): string => {
    return text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*|\*([^*]+)\*/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/```[^`]*```/g, '')
      .replace(/^#+\s*/gm, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }, []);

  const updateMessageState = useCallback((messageId: string, enabled: boolean, playing: boolean) => {
    setTtsState(prev => {
      const currentState = prev[messageId];
      if (currentState?.enabled === enabled && currentState?.playing === playing) {
        return prev;
      }
      return {
        ...prev,
        [messageId]: { enabled, playing }
      };
    });
  }, []);

  const clearTTSReferences = useCallback((messageId: string) => {
    if (currentMessageIdRef.current === messageId) {
      currentUtteranceRef.current = null;
      currentMessageIdRef.current = null;
    }
  }, []);

  const handleTTSComplete = useCallback((messageId: string, reason: 'finished' | 'interrupted' | 'error') => {
    try {
      updateMessageState(messageId, false, false);
      clearTTSReferences(messageId);

      if (reason === 'error') {
        logger.error(`[TTS] Speech ended with error for message ${messageId}`);
      } else if (reason === 'interrupted') {
        logger.debug(`[TTS] Speech interrupted for message ${messageId} (intentional)`);
      } else {
        logger.debug(`[TTS] Finished speaking message ${messageId}`);
      }
    } catch (error) {
      logger.error(`[TTS] Error during completion handling for message ${messageId}:`, error);
    }
  }, [updateMessageState, clearTTSReferences]);

  const clearAllStates = useCallback(() => {
    setTtsState(prev => {
      const hasActiveStates = Object.values(prev).some(state => state.enabled || state.playing);
      if (!hasActiveStates) {
        return prev;
      }

      const newState: TTSState = {};
      Object.keys(prev).forEach(messageId => {
        newState[messageId] = { enabled: false, playing: false };
      });
      return newState;
    });
  }, []);

  const stopAllTTS = useCallback(() => {
    if (!isSupported) return;

    if (speechSynthesis.speaking) {
      speechSynthesis.cancel();
      logger.debug('[TTS] Cancelled all speech synthesis');
    }

    currentUtteranceRef.current = null;
    currentMessageIdRef.current = null;

    clearAllStates();
  }, [isSupported, clearAllStates]);

  const startTTS = useCallback((messageId: string, text: string) => {
    if (!isSupported) {
      logger.warn('[TTS] Web Speech API not supported in this browser');
      return;
    }

    try {
      stopAllTTS();

      const cleanText = cleanTextForTTS(text);

      if (!cleanText.trim()) {
        logger.warn(`[TTS] Empty text after cleaning for message ${messageId}, skipping TTS`);
        return;
      }

    const utterance = new SpeechSynthesisUtterance(cleanText);

    utterance.rate = TTS_CONFIG.DEFAULT_RATE;
    utterance.pitch = TTS_CONFIG.DEFAULT_PITCH;
    utterance.volume = TTS_CONFIG.DEFAULT_VOLUME;

    utterance.onstart = () => {
      logger.debug(`[TTS] Started speaking message ${messageId}`);
      updateMessageState(messageId, true, true);
    };

    utterance.onend = () => {
      handleTTSComplete(messageId, 'finished');
    };

    utterance.onerror = (event) => {
      const reason = event.error === 'interrupted' ? 'interrupted' : 'error';
      handleTTSComplete(messageId, reason);
    };

    utterance.onpause = () => {
      logger.debug(`[TTS] Paused speaking message ${messageId}`);
    };

    utterance.onresume = () => {
      logger.debug(`[TTS] Resumed speaking message ${messageId}`);
    };

    currentUtteranceRef.current = utterance;
    currentMessageIdRef.current = messageId;

      speechSynthesis.speak(utterance);
      logger.debug(`[TTS] Queued speech for message ${messageId} (${cleanText.length} characters)`);
    } catch (error) {
      logger.error(`[TTS] Failed to start speech for message ${messageId}:`, error);
      updateMessageState(messageId, false, false);
      currentUtteranceRef.current = null;
      currentMessageIdRef.current = null;
    }
  }, [isSupported, stopAllTTS, cleanTextForTTS, updateMessageState, handleTTSComplete]);


  const handleTTSToggle = useCallback((messageId: string, enabled: boolean) => {
    if (!isSupported) {
      logger.warn('[TTS] Web Speech API not supported in this browser');
      return;
    }

    try {
      if (enabled) {
        const message = messages.find(m => m.id === messageId);

        if (message) {
          const completeContent = getCompleteMessageContent(message);
          startTTS(messageId, completeContent);
        } else {
          logger.error(`[TTS] Message ${messageId} not found in messages array`);

          const messageByClientId = messages.find(m => m.clientId && m.clientId.includes(messageId.toString()));
          if (messageByClientId) {
            const completeContent = getCompleteMessageContent(messageByClientId);
            startTTS(messageByClientId.id, completeContent);
          } else {
            logger.error(`[TTS] Unable to find message ${messageId} by ID or clientId`);
          }
        }
      } else {
        stopAllTTS();
      }
    } catch (error) {
      logger.error(`[TTS] Error handling TTS toggle for message ${messageId}:`, error);
      updateMessageState(messageId, false, false);
    }
  }, [getCompleteMessageContent, isSupported, messages, startTTS, stopAllTTS, updateMessageState]);

  return {
    ttsState,
    handleTTSToggle,
    isSupported
  };
};