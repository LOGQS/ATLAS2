// status: complete

import { useCallback, useRef, useState } from 'react';
import logger from '../../utils/core/logger';

export interface PendingOperation<TData, TResult = any> {
  id: string;
  type: string;
  data: TData;
  timestamp: number;
  promise: Promise<TResult>;
  rollback: () => void;
}

export interface PendingState {
  pendingOperations: Map<string, PendingOperation<any>>;
  errors: Map<string, { message: string; timestamp: number; operation: PendingOperation<any> }>;
}

export interface UsePendingOpsOptions {
  onSuccess?: (operationId: string, result: any) => void;
  onError?: (operationId: string, error: Error, operation: PendingOperation<any>) => void;
  errorTimeout?: number; 
  maxRetries?: number;
}

export const usePendingOps = (options: UsePendingOpsOptions = {}) => {
  const { onSuccess, onError, errorTimeout = 5000, maxRetries = 0 } = options;

  const [pendingState, setPendingState] = useState<PendingState>({
    pendingOperations: new Map(),
    errors: new Map()
  });

  const retryCountRef = useRef<Map<string, number>>(new Map());

  const generateOperationId = useCallback(() => {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }, []);

  const clearError = useCallback((operationId: string) => {
    setPendingState(prev => {
      const newErrors = new Map(prev.errors);
      newErrors.delete(operationId);
      return {
        ...prev,
        errors: newErrors
      };
    });
  }, []);

  const execute = useCallback(async <TData, TResult = any>(
    type: string,
    data: TData,
    applyChange: () => void,
    rollback: () => void,
    promise: Promise<TResult>,
    operationId?: string
  ): Promise<{ success: boolean; result?: TResult; error?: Error }> => {
    const id = operationId || generateOperationId();

    try {
      applyChange();
    } catch (error) {
      logger.error(`[PendingOps] Failed to apply update for ${type}:`, error);
      return { success: false, error: error as Error };
    }

    const operation: PendingOperation<TData, TResult> = {
      id,
      type,
      data,
      timestamp: Date.now(),
      promise,
      rollback
    };

    setPendingState(prev => {
      const newPending = new Map(prev.pendingOperations);
      newPending.set(id, operation);
      const newErrors = new Map(prev.errors);
      newErrors.delete(id); 
      return {
        ...prev,
        pendingOperations: newPending,
        errors: newErrors
      };
    });

    try {
      logger.info(`[PendingOps] Starting ${type} operation ${id}`);
      const result = await promise;

      setPendingState(prev => {
        const newPending = new Map(prev.pendingOperations);
        newPending.delete(id);
        return {
          ...prev,
          pendingOperations: newPending
        };
      });

      retryCountRef.current.delete(id);
      onSuccess?.(id, result);
      logger.info(`[PendingOps] Successfully completed ${type} operation ${id}`);
      return { success: true, result };

    } catch (error) {
      const err = error as Error;
      logger.error(`[PendingOps] Failed ${type} operation ${id}:`, error);

      const currentRetries = retryCountRef.current.get(id) || 0;
      const canRetry = currentRetries < maxRetries;

      if (canRetry) {
        retryCountRef.current.set(id, currentRetries + 1);
        logger.info(`[PendingOps] Retrying ${type} operation ${id} (attempt ${currentRetries + 1}/${maxRetries}`);

        setTimeout(() => {
          execute(type, data, () => {}, rollback, promise, id);
        }, Math.pow(2, currentRetries) * 1000); 
      } else {
        try {
          rollback();
        } catch (rollbackError) {
          logger.error(`[PendingOps] Failed to rollback ${type} operation ${id}:`, rollbackError);
        }

        setPendingState(prev => {
          const newPending = new Map(prev.pendingOperations);
          newPending.delete(id);
          const newErrors = new Map(prev.errors);
          newErrors.set(id, { message: err.message, timestamp: Date.now(), operation });

          return {
            pendingOperations: newPending,
            errors: newErrors
          };
        });

        retryCountRef.current.delete(id);
        onError?.(id, err, operation);

        if (errorTimeout > 0) {
          setTimeout(() => clearError(id), errorTimeout);
        }
      }

      return { success: false, error: err };
    }
  }, [generateOperationId, onSuccess, onError, maxRetries, errorTimeout, clearError]);

  const retry = useCallback(async (operationId: string): Promise<boolean> => {
    const error = pendingState.errors.get(operationId);
    if (!error) {
      logger.warn(`[PendingOps] No error found for operation ${operationId}`);
      return false;
    }

    const { operation } = error;
    logger.info(`[PendingOps] Manually retrying ${operation.type} operation ${operationId}`);

    clearError(operationId);
    const result = await execute(
      operation.type,
      operation.data,
      () => {}, 
      operation.rollback,
      operation.promise,
      operationId
    );

    return result.success;
  }, [pendingState.errors, clearError, execute]);

  const isPending = useCallback((operationId?: string): boolean => {
    if (operationId) {
      return pendingState.pendingOperations.has(operationId);
    }
    return pendingState.pendingOperations.size > 0;
  }, [pendingState.pendingOperations]);

  const hasError = useCallback((operationId?: string): boolean => {
    if (operationId) {
      return pendingState.errors.has(operationId);
    }
    return pendingState.errors.size > 0;
  }, [pendingState.errors]);

  const getError = useCallback((operationId: string) => {
    return pendingState.errors.get(operationId);
  }, [pendingState.errors]);

  const getPendingOperations = useCallback((type?: string) => {
    const operations = Array.from(pendingState.pendingOperations.values());
    return type ? operations.filter(op => op.type === type) : operations;
  }, [pendingState.pendingOperations]);

  const getErrors = useCallback((type?: string) => {
    const errors = Array.from(pendingState.errors.values());
    return type ? errors.filter(error => error.operation.type === type) : errors;
  }, [pendingState.errors]);

  return {
    execute,
    retry,
    clearError,
    isPending,
    hasError,
    getError,
    getPendingOperations,
    getErrors,
    pendingCount: pendingState.pendingOperations.size,
    errorCount: pendingState.errors.size
  };
};