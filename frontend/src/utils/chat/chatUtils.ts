import logger from '../core/logger';
import type { Message } from '../../types/messages';

export const isOptimisticMessage = (message: Message): boolean => {
  return message.id.startsWith('temp_') || !!message.clientId;
};

export const reconcileMessages = (
  currentMessages: Message[], 
  serverHistory: Message[], 
  chatId: string,
  forceReplace: boolean = false
): Message[] => {
  if (currentMessages.length === 0) {
    if (serverHistory.length > 0) {
      logger.info(`[ChatUtils] Loaded ${serverHistory.length} messages for ${chatId} from DB`);
    }
    return serverHistory;
  }

  if (serverHistory.length === 0) {
    const hasOptimistic = currentMessages.some(isOptimisticMessage);
    
    if (hasOptimistic) {
      logger.info(`[ChatUtils] Empty DB for ${chatId} - preserving ${currentMessages.length} optimistic messages`);
      return currentMessages;
    } else {
      logger.info(`[ChatUtils] Empty DB for ${chatId} - clearing ${currentMessages.length} processed messages`);
      return [];
    }
  }

  if (forceReplace) {
    logger.info(`[ChatUtils] Force replacing ${currentMessages.length} local messages with ${serverHistory.length} DB messages for ${chatId}`);

    // Preserve optimistic messages if server has no history yet
    if (serverHistory.length === 0) {
      const optimisticMessages = currentMessages.filter(isOptimisticMessage);
      if (optimisticMessages.length > 0) {
        logger.info(`[ChatUtils] Server empty - preserving ${optimisticMessages.length} optimistic messages`);
        return optimisticMessages;
      }
    }

    return serverHistory;
  }

  logger.info(`[ChatUtils] Reconciling ${serverHistory.length} DB messages with ${currentMessages.length} local messages for ${chatId}`);

  const byClient = new Map(currentMessages.filter(m => m.clientId).map(m => [m.clientId!, m]));
  const merged = [...currentMessages];

  // Track which clientIds were successfully matched from server
  const matchedClientIds = new Set<string>();

  for (const srv of serverHistory) {
    if (srv.clientId && byClient.has(srv.clientId)) {
      const local = byClient.get(srv.clientId)!;
      const localIndex = merged.findIndex(m => m === local);
      if (localIndex !== -1) {
        merged[localIndex] = { ...merged[localIndex], ...srv };
        matchedClientIds.add(srv.clientId);
      }
    } else {
      const existingIndex = merged.findIndex(m => m.id === srv.id);
      if (existingIndex !== -1) {
        merged[existingIndex] = { ...merged[existingIndex], ...srv };
      } else {
        merged.push(srv);
      }
    }
  }

  // Only remove temp messages that were successfully matched with server
  const filtered = merged.filter(m => {
    if (!m.id.startsWith('temp_')) {
      return true;
    }
    const wasMatched = m.clientId && matchedClientIds.has(m.clientId);
    if (!wasMatched) {
      logger.debug(`[ChatUtils] Keeping unmatched temp: ${m.id}`);
    }
    return !wasMatched;
  });

  logger.info(`[ChatUtils] Reconciliation complete - final count: ${filtered.length}`);
  return filtered;
};

export const handleNewChatScenario = (
  currentMessages: Message[], 
  chatId: string
): Message[] => {
  const hasUnprocessedMessages = currentMessages.some(isOptimisticMessage);
  
  if (currentMessages.length > 0 && hasUnprocessedMessages) {
    logger.info(`[ChatUtils] New chat ${chatId} - preserving ${currentMessages.length} unprocessed optimistic messages`);
    return currentMessages; 
  } else if (currentMessages.length > 0) {
    logger.info(`[ChatUtils] New chat ${chatId} - clearing ${currentMessages.length} processed messages`);
    return [];
  }
  logger.info(`[ChatUtils] New chat ${chatId} - no messages to preserve`);
  return [];
};
