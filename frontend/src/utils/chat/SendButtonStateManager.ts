// status: complete
import logger from '../core/logger';

class SendButtonStateManager {
  private sendButtonStates: Map<string, boolean> = new Map();
  private listeners: Map<string, Set<(isDisabled: boolean) => void>> = new Map();
  private parentChildRelations: Map<string, string> = new Map(); 

  setSendButtonDisabled(chatId: string, isDisabled: boolean) {
    this.sendButtonStates.set(chatId, isDisabled);
    logger.info(`[SEND_BUTTON_STATE] Setting send button state for ${chatId}: ${isDisabled ? 'disabled' : 'enabled'}`);
    this.notifyListeners(chatId, isDisabled);
  }

  registerParentChild(childChatId: string, parentChatId: string) {
    this.parentChildRelations.set(childChatId, parentChatId);
    logger.info(`[SEND_BUTTON_STATE] Registered parent-child relation: ${childChatId} -> ${parentChatId}`);
  }

  clearParentChild(childChatId: string) {
    const parent = this.parentChildRelations.get(childChatId);
    if (parent) {
      this.parentChildRelations.delete(childChatId);
      logger.info(`[SEND_BUTTON_STATE] Cleared parent-child relation for ${childChatId}`);
    }
  }

  getSendButtonDisabled(chatId: string): boolean {
    const directState = this.sendButtonStates.get(chatId);
    if (directState !== undefined) {
      return directState;
    }

    const parentChatId = this.parentChildRelations.get(chatId);
    if (parentChatId) {
      const parentState = this.sendButtonStates.get(parentChatId);
      if (parentState !== undefined) {
        logger.info(`[SEND_BUTTON_STATE] Child ${chatId} inheriting state from parent ${parentChatId}: ${parentState ? 'disabled' : 'enabled'}`);
        return parentState;
      }
    }

    let hasDisabledChild = false;
    this.parentChildRelations.forEach((parent, child) => {
      if (parent === chatId) {
        const childState = this.sendButtonStates.get(child);
        if (childState) {
          logger.info(`[SEND_BUTTON_STATE] Parent ${chatId} has disabled child ${child}`);
          hasDisabledChild = true;
        }
      }
    });
    if (hasDisabledChild) return true;

    return false;
  }

  subscribe(chatId: string, callback: (isDisabled: boolean) => void) {
    if (!this.listeners.has(chatId)) {
      this.listeners.set(chatId, new Set());
    }
    this.listeners.get(chatId)!.add(callback);

    callback(this.getSendButtonDisabled(chatId));

    return () => {
      const set = this.listeners.get(chatId);
      if (set) {
        set.delete(callback);
        if (set.size === 0) {
          this.listeners.delete(chatId);
        }
      }
    };
  }

  clearSendButtonState(chatId: string) {
    this.sendButtonStates.delete(chatId);
    logger.info(`[SEND_BUTTON_STATE] Cleared send button state for ${chatId}`);
    this.notifyListeners(chatId, false);
  }

  private notifyListeners(chatId: string, isDisabled: boolean) {
    const listeners = this.listeners.get(chatId);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(isDisabled);
        } catch (err) {
          logger.error(`[SEND_BUTTON_STATE] Error in listener for ${chatId}:`, err);
        }
      });
    }
  }
}

export const sendButtonStateManager = new SendButtonStateManager();