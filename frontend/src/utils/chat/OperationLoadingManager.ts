// status: complete
import logger from '../core/logger';

class OperationLoadingManager {
  private operationStates: Map<string, {
    isDeleting: boolean;
    isRetrying: boolean;
    isEditing: boolean;
    operationStartTime: number;
  }> = new Map();

  private listeners: Map<string, Set<(state: any) => void>> = new Map();

  setOperationState(chatId: string, state: {
    isDeleting?: boolean;
    isRetrying?: boolean;
    isEditing?: boolean;
  }) {
    const currentState = this.operationStates.get(chatId) || {
      isDeleting: false,
      isRetrying: false,
      isEditing: false,
      operationStartTime: Date.now()
    };

    const newState = {
      isDeleting: state.isDeleting !== undefined ? state.isDeleting : currentState.isDeleting,
      isRetrying: state.isRetrying !== undefined ? state.isRetrying : currentState.isRetrying,
      isEditing: state.isEditing !== undefined ? state.isEditing : currentState.isEditing,
      operationStartTime: (state.isDeleting || state.isRetrying || state.isEditing) ? Date.now() : currentState.operationStartTime
    };

    this.operationStates.set(chatId, newState);

    logger.info(`[OPERATION_LOADING] Setting operation state for ${chatId}:`, {
      isDeleting: newState.isDeleting,
      isRetrying: newState.isRetrying,
      isEditing: newState.isEditing
    });

    this.notifyListeners(chatId, newState);
  }

  getOperationState(chatId: string) {
    const state = this.operationStates.get(chatId) || {
      isDeleting: false,
      isRetrying: false,
      isEditing: false,
      operationStartTime: 0
    };

    return {
      ...state,
      isOperationLoading: state.isDeleting || state.isRetrying || state.isEditing
    };
  }

  clearOperationState(chatId: string) {
    logger.info(`[OPERATION_LOADING] Clearing operation state for ${chatId}`);
    this.operationStates.delete(chatId);
    this.notifyListeners(chatId, {
      isDeleting: false,
      isRetrying: false,
      isEditing: false,
      isOperationLoading: false
    });
  }

  subscribe(chatId: string, callback: (state: any) => void) {
    if (!this.listeners.has(chatId)) {
      this.listeners.set(chatId, new Set());
    }
    this.listeners.get(chatId)!.add(callback);

    callback(this.getOperationState(chatId));

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

  private notifyListeners(chatId: string, state: any) {
    const listeners = this.listeners.get(chatId);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback({
            ...state,
            isOperationLoading: state.isDeleting || state.isRetrying || state.isEditing
          });
        } catch (err) {
          logger.error(`[OPERATION_LOADING] Error in listener for ${chatId}:`, err);
        }
      });
    }
  }
}

export const operationLoadingManager = new OperationLoadingManager();