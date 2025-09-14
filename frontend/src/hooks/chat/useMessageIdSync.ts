import { useEffect } from 'react';
import type { Message } from '../../types/messages';
import logger from '../../utils/core/logger';

interface UseMessageIdSyncProps {
  chatId?: string;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

export const useMessageIdSync = ({ chatId, setMessages }: UseMessageIdSyncProps) => {
  useEffect(() => {
    if (!chatId) return;
    const processedKeys = new Set<string>();

    const handleMessageIdsUpdate = (ev: Event) => {
      const event = ev as CustomEvent;

      if (!event.detail || typeof event.detail !== 'object') {
        logger.warn('[MessageIdSync] Received malformed event without detail');
        return;
      }

      const { chatId: eventChatId, userMessageId, assistantMessageId } = event.detail;

      if (eventChatId !== chatId) return;

      if (!userMessageId && !assistantMessageId) {
        logger.warn(`[MessageIdSync] Received event for ${chatId} with no message IDs`);
        return;
      }

      const key = `${chatId}:${userMessageId || 'none'}:${assistantMessageId || 'none'}`;
      if (processedKeys.has(key)) return;
      processedKeys.add(key);

      logger.info(`[MessageIdSync] Received IDs for ${chatId}: user=${userMessageId}, assistant=${assistantMessageId}`);

      setMessages(prev => {
        const updated = [...prev];
        let userReplaced = false;
        let assistantReplaced = false;

        for (let i = updated.length - 1; i >= 0; i--) {
          const m = updated[i];
          const isTemp = m.id.startsWith('temp_');

          if (!userReplaced && userMessageId && m.role === 'user' && isTemp) {
            logger.info(`[MessageIdSync] Promoting temp user ${m.id} -> ${userMessageId}`);
            updated[i] = { ...m, id: userMessageId };
            userReplaced = true;
          }

          if (!assistantReplaced && assistantMessageId && m.role === 'assistant' && isTemp) {
            logger.info(`[MessageIdSync] Promoting temp assistant ${m.id} -> ${assistantMessageId}`);
            updated[i] = { ...m, id: assistantMessageId };
            assistantReplaced = true;
          }

          if (userReplaced && (assistantReplaced || !assistantMessageId)) {
            break;
          }
        }

        if (assistantMessageId && !assistantReplaced) {
          const created: Message = {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            thoughts: '',
            timestamp: new Date().toISOString()
          };
          logger.info(`[MessageIdSync] Inserting assistant placeholder ${created.id} for chat ${chatId}`);
          updated.push(created);
        }

        return updated;
      });
    };

    window.addEventListener('messageIdsUpdate', handleMessageIdsUpdate as EventListener);
    return () => {
      window.removeEventListener('messageIdsUpdate', handleMessageIdsUpdate as EventListener);
      processedKeys.clear();
    };
  }, [chatId, setMessages]);
};
