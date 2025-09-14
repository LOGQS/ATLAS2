import logger from '../core/logger';
import type { Message } from '../../types/messages';

const getContentPreview = (content: string | undefined): string => {
  return `${content?.substring(0, 20)}...`;
};

const formatMessageShort = (message: Message): string => {
  return `${message.id}(${message.role}): "${getContentPreview(message.content)}"`;
};

const formatMessageDetailed = (message: Message): string => {
  return `${message.id}(${message.role}) clientId=${message.clientId} content="${getContentPreview(message.content)}"`;
};

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
    logger.info(`[MESSAGE_RECONCILE_DEBUG] === FORCE REPLACE MODE - CLEAN APPROACH ===`);
    logger.info(`[MESSAGE_RECONCILE_DEBUG] Server messages: ${serverHistory.map(formatMessageShort).join(', ')}`);
    logger.info(`[MESSAGE_RECONCILE_DEBUG] === FORCE REPLACE COMPLETED ===`);
    return serverHistory;
  }

  logger.info(`[ChatUtils] Reconciling ${serverHistory.length} DB messages with ${currentMessages.length} local messages for ${chatId}`);
  logger.info(`[MESSAGE_RECONCILE_DEBUG] === RECONCILIATION DEBUG - CLEAN APPROACH (NO VIRTUAL MESSAGES) ===`);
  
  logger.info(`[MESSAGE_RECONCILE_DEBUG] Current local messages:`);
  currentMessages.forEach((curr, i) => {
    logger.info(`[MESSAGE_RECONCILE_DEBUG] Local[${i}]: ${formatMessageDetailed(curr)}`);
  });
  
  logger.info(`[MESSAGE_RECONCILE_DEBUG] Server messages from database:`);
  serverHistory.forEach((srv, i) => {
    logger.info(`[MESSAGE_RECONCILE_DEBUG] Server[${i}]: ${formatMessageDetailed(srv)}`);
  });
  
  const byClient = new Map(currentMessages.filter(m => m.clientId).map(m => [m.clientId!, m]));
  const merged = [...currentMessages];

  logger.info(`[MESSAGE_RECONCILE_DEBUG] ClientId map has ${byClient.size} entries: ${Array.from(byClient.keys()).join(', ')}`);

  for (const srv of serverHistory) {
    logger.info(`[MESSAGE_RECONCILE_DEBUG] Processing server message: ${srv.id}(${srv.role}) clientId=${srv.clientId}`);
    
    if (srv.clientId && byClient.has(srv.clientId)) {
      const local = byClient.get(srv.clientId)!;
      const localIndex = merged.findIndex(m => m === local);
      if (localIndex !== -1) {
        logger.info(`[MESSAGE_RECONCILE_DEBUG] MATCHED by clientId: ${srv.clientId} - updating local message at index ${localIndex}`);
        merged[localIndex] = { ...merged[localIndex], ...srv };
      }
    } else {
      const existingIndex = merged.findIndex(m => m.id === srv.id);
      if (existingIndex !== -1) {
        logger.info(`[MESSAGE_RECONCILE_DEBUG] MATCHED by ID: ${srv.id} - updating existing message at index ${existingIndex}`);
        merged[existingIndex] = { ...merged[existingIndex], ...srv };
      } else {
        logger.info(`[MESSAGE_RECONCILE_DEBUG] NEW MESSAGE: Adding ${srv.id}(${srv.role}) to merged array`);
        merged.push(srv);
      }
    }
  }
  
  if (serverHistory.length > 0) {
    const before = merged.length;
    const filtered = merged.filter(m => !m.id.startsWith('temp_'));
    if (filtered.length !== before) {
      logger.info(`[MESSAGE_RECONCILE_DEBUG] Removed ${before - filtered.length} temporary messages after syncing with DB`);
    }
    return filtered;
  }

  logger.info(`[MESSAGE_RECONCILE_DEBUG] Final reconciled messages:`);
  merged.forEach((msg, i) => {
    logger.info(`[MESSAGE_RECONCILE_DEBUG] Final[${i}]: ${formatMessageDetailed(msg)}`);
  });
  
  logger.info(`[ChatUtils] Reconciliation complete - final count: ${merged.length}`);
  logger.info(`[MESSAGE_RECONCILE_DEBUG] === RECONCILIATION COMPLETED (CLEAN APPROACH) ===`);
  return merged;
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
