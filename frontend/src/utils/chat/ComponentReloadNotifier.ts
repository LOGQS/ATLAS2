// status: complete
import logger from '../core/logger';

class ComponentReloadNotifier {
  private reloadCallbacks: Map<string, () => void> = new Map();

  register(chatId: string, reloadFn: () => void) {
    logger.info(`[RELOAD_NOTIFIER] Registering reload callback for ${chatId}`);
    this.reloadCallbacks.set(chatId, reloadFn);
  }

  unregister(chatId: string) {
    logger.info(`[RELOAD_NOTIFIER] Unregistering reload callback for ${chatId}`);
    this.reloadCallbacks.delete(chatId);
  }

  notifyReload(chatId: string) {
    logger.info(`[RELOAD_NOTIFIER] Notifying reload for ${chatId}`);
    const reloadFn = this.reloadCallbacks.get(chatId);
    if (reloadFn) {
      logger.info(`[RELOAD_NOTIFIER] Executing reload callback for ${chatId}`);
      reloadFn();
    } else {
      logger.warn(`[RELOAD_NOTIFIER] No reload callback registered for ${chatId}`);
    }
  }
}

export const reloadNotifier = new ComponentReloadNotifier();