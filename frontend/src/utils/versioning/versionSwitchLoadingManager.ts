import logger from '../core/logger';

const VERSION_CHAT_PREFIX = 'version_' as const;

type LoadingState = {
  isLoading: boolean;
  operation: 'edit' | 'delete' | 'retry' | null;
  targetChatId: string | null;
};

type Listener = (state: LoadingState) => void;

class VersionSwitchLoadingManager {
  private state: LoadingState = {
    isLoading: false,
    operation: null,
    targetChatId: null
  };
  
  private listeners = new Map<string, Set<Listener>>();
  
  startLoading(operation: 'edit' | 'delete' | 'retry', targetChatId: string) {
    this.state = {
      isLoading: true,
      operation,
      targetChatId
    };
    
    this.notifyAll();
  }
  
  endLoading() {
    if (this.state.isLoading) {
      this.state = {
        isLoading: false,
        operation: null,
        targetChatId: null
      };
      
      this.notifyAll();
    }
  }
  
  isLoadingForChat(chatId: string): boolean {
    if (!this.state.isLoading || !this.state.targetChatId) {
      return false;
    }
    
    if (this.state.targetChatId === chatId) {
      return true;
    }
    
    if (!this.state.targetChatId.startsWith(VERSION_CHAT_PREFIX) && chatId.startsWith(VERSION_CHAT_PREFIX)) {
      return true;
    }

    if (this.state.targetChatId.startsWith(VERSION_CHAT_PREFIX) && chatId.startsWith(VERSION_CHAT_PREFIX)) {
      return true;
    }
    
    return false;
  }
  
  getState(): LoadingState {
    return { ...this.state };
  }
  
  subscribe(chatId: string, listener: Listener): () => void {
    if (!this.listeners.has(chatId)) {
      this.listeners.set(chatId, new Set());
    }

    const chatListeners = this.listeners.get(chatId);
    if (chatListeners) {
      chatListeners.add(listener);
    }
    
    listener(this.getState());
    
    return () => {
      const listeners = this.listeners.get(chatId);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.listeners.delete(chatId);
        }
      }
    };
  }
  
  private notifyAll() {
    const state = this.getState();
    
    this.listeners.forEach((listeners, chatId) => {
      listeners.forEach(listener => {
        try {
          listener(state);
        } catch (error) {
          logger.error(`Error notifying version loading listener:`, error);
        }
      });
    });
  }
}

export const versionSwitchLoadingManager = new VersionSwitchLoadingManager();