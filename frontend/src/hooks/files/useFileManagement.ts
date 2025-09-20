// status: complete

import { useState, useRef, useEffect, useMemo } from 'react';
import { BrowserStorage, AttachedFile } from '../../utils/storage/BrowserStorage';
import logger from '../../utils/core/logger';
import {
  TEMP_FILE_PREFIX,
  FILE_STATES,
  CHAT_READY_STATES,
  isProcessingFile,
  isReadyFile,
  findFileByDirectId,
  findFileByTempId,
  findFallbackProcessingFile,
  updateFileAtIndex
} from './FileStateUtils';
import { performTempFileCleanup, handleFileUpload, handleRemoveFile as removeFile, handleClearAllFiles as clearAllFiles } from './FileOperations';
import { providerConfig, isFileSizeValid, formatFileLimit, getDefaultProvider } from '../../config/providers';

export const useFileManagement = (isAppInitialized: boolean) => {
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [uploadAbortController, setUploadAbortController] = useState<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initializeAttachedFiles = () => {
    const savedFiles = BrowserStorage.getAttachedFiles();
    if (savedFiles.length > 0) {
      logger.info('[App.useEffect] Restored attached files from localStorage:', savedFiles.length);
      setAttachedFiles(savedFiles);
    }
  };

  useEffect(() => {
    if (isAppInitialized) {
      BrowserStorage.setAttachedFiles(attachedFiles);
    }
  }, [attachedFiles, isAppInitialized]);

  useEffect(() => {
    if (!isAppInitialized) return;

    providerConfig.initialize().catch(error => {
      logger.warn('[FILE_MANAGEMENT] Failed to initialize provider config:', error);
    });

    const handleFileStateUpdate = (event: CustomEvent) => {
      const { file_id, api_state, provider, temp_id } = event.detail;
      logger.info(`[App] Received SSE file state update: ${file_id} (temp:${temp_id}) -> ${api_state}`);
      
      setAttachedFiles(prev => {
        let updatedFiles = prev;
        let matchFound = false;
        let updateInfo = '';

        const directMatch = findFileByDirectId(prev, file_id);
        if (directMatch) {
          const { file, index } = directMatch;
          const oldState = file.api_state;
          if (oldState === api_state) {
            logger.debug(`[INDIVIDUAL] Skipping duplicate: ${file.name} already in ${api_state}`);
            return prev;
          }

          updatedFiles = updateFileAtIndex(prev, index, {
            api_state,
            provider: provider || file.provider
          });
          updateInfo = `ID match: ${file.name} ${oldState} -> ${api_state}`;
          matchFound = true;
        }

        if (!matchFound && temp_id) {
          const tempMatch = findFileByTempId(prev, temp_id);
          if (tempMatch) {
            const { file, index } = tempMatch;
            const oldState = file.api_state;
            updatedFiles = updateFileAtIndex(prev, index, {
              id: file_id,
              api_state,
              provider: provider || file.provider
            });
            updateInfo = `temp_id match: ${file.name} ${oldState} -> ${api_state} (temp:${temp_id} -> real:${file_id})`;
            matchFound = true;
          }
        }

        if (!matchFound) {
          const fallbackMatch = findFallbackProcessingFile(prev);
          if (fallbackMatch) {
            const { file, index } = fallbackMatch;
            const oldState = file.api_state;
            updatedFiles = updateFileAtIndex(prev, index, {
              id: file_id,
              api_state,
              provider: provider || file.provider
            });
            updateInfo = `fallback match: ${file.name} ${oldState} -> ${api_state}`;
            matchFound = true;
          }
        }

        if (matchFound) {
          logger.info(`[INDIVIDUAL] ${updateInfo} - clean UI update`);

          setTimeout(() => performTempFileCleanup(setAttachedFiles, 'SSE_UPDATE'), 0);

          return updatedFiles;
        } else {
          logger.warn(`[INDIVIDUAL] No match found for ${file_id} (temp:${temp_id}) - skipping`);
          return prev;
        }
      });
    };

    window.addEventListener('fileStateUpdate', handleFileStateUpdate as EventListener);
    
    const handleRemoveFilesFromBar = (ev: Event) => {
      const e = ev as CustomEvent;
      const ids: string[] = (e.detail && e.detail.file_ids) || [];
      if (!Array.isArray(ids) || ids.length === 0) return;
      logger.info(`[BAR] Removing ${ids.length} files from upload bar due to attach-to-message:`, ids);
      setAttachedFiles(prev => prev.filter(f => !ids.includes(f.id)));
    };
    window.addEventListener('removeFilesFromBar', handleRemoveFilesFromBar as EventListener);
    
    return () => {
      window.removeEventListener('fileStateUpdate', handleFileStateUpdate as EventListener);
      window.removeEventListener('removeFilesFromBar', handleRemoveFilesFromBar as EventListener);
    };
  }, [isAppInitialized]);

  const handleFileUploadLocal = async (files: FileList, optimisticFiles?: AttachedFile[]) => {
    return handleFileUpload(
      files,
      optimisticFiles,
      attachedFiles,
      setUploadAbortController,
      setAttachedFiles
    );
  };

  const handleAddFileClick = () => {
    logger.info('Add file button clicked - opening file picker');
    fileInputRef.current?.click();
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      handleFileSelectionImmediate(files);
      event.target.value = '';
    }
  };

  const handleFileSelectionImmediate = async (files: FileList) => {
    try {
      logger.info('[MULTI-FILE] Selected', files.length, 'files for parallel processing:', Array.from(files).map(f => f.name));

      const filesArray = Array.from(files);
      const validFiles: File[] = [];
      const optimisticFiles: AttachedFile[] = [];

      for (const file of filesArray) {
        const isValid = isFileSizeValid(file.size);
        const fileId = `${TEMP_FILE_PREFIX}${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        if (isValid) {
          validFiles.push(file);
          optimisticFiles.push({
            id: fileId,
            name: file.name,
            size: file.size,
            type: file.type,
            api_state: FILE_STATES.LOCAL,
            provider: undefined
          });
          logger.info(`[FILE_VALIDATION] File ${file.name} (${file.size} bytes) is valid for upload`);
        } else {
          const defaultProvider = getDefaultProvider();
          const limitText = formatFileLimit(defaultProvider);
          optimisticFiles.push({
            id: fileId,
            name: file.name,
            size: file.size,
            type: file.type,
            api_state: FILE_STATES.SIZE_ERROR,
            provider: undefined
          });
          logger.warn(`[FILE_VALIDATION] File ${file.name} (${file.size} bytes) exceeds ${limitText} limit for ${defaultProvider} provider`);
        }
      }

      logger.info('[MULTI-FILE] Adding optimistic files to UI:', optimisticFiles.length,
        optimisticFiles.map(f => ({ name: f.name, api_state: f.api_state })));
      setAttachedFiles(prev => [...prev, ...optimisticFiles]);

      if (validFiles.length > 0) {
        const validOptimisticFiles = optimisticFiles.filter(f => f.api_state === FILE_STATES.LOCAL);
        handleFileUploadLocal(validFiles as any as FileList, validOptimisticFiles);
        logger.info(`[FILE_VALIDATION] Uploading ${validFiles.length} valid files, ${optimisticFiles.length - validFiles.length} rejected for size`);
      } else {
        logger.info('[FILE_VALIDATION] No valid files to upload - all files exceed size limits');
      }

    } catch (error) {
      logger.error('Error handling immediate file selection:', error);
    }
  };

  const handleRemoveFile = async (fileId: string) => {
    return removeFile(fileId, attachedFiles, setAttachedFiles);
  };

  const clearAttachedFiles = () => {
    setAttachedFiles([]);
    BrowserStorage.clearAttachedFiles();
  };

  const handleClearAllFiles = async () => {
    return clearAllFiles(
      attachedFiles,
      uploadAbortController,
      setUploadAbortController,
      clearAttachedFiles,
      setAttachedFiles
    );
  };

  const hasUnreadyFiles = useMemo(() => {
    const result = attachedFiles.some(file =>
      !file.api_state || !CHAT_READY_STATES.includes(file.api_state as any)
    );

    if (attachedFiles.length > 0) {
      const readyCount = attachedFiles.filter(isReadyFile).length;
      const processingCount = attachedFiles.filter(isProcessingFile).length;
      
      if (processingCount > 0) {
        logger.debug(`[COLLECTIVE-STATE] ${readyCount}/${attachedFiles.length} files ready, ${processingCount} still processing - SEND DISABLED`);
      } else if (readyCount === attachedFiles.length) {
        logger.debug(`[COLLECTIVE-STATE] All ${attachedFiles.length} files ready - SEND ENABLED`);
      }
    }
    
    return result;
  }, [attachedFiles]);

  return {
    attachedFiles,
    fileInputRef,
    hasUnreadyFiles,
    setAttachedFiles,
    initializeAttachedFiles,
    handleAddFileClick,
    handleFileSelect,
    handleFileSelectionImmediate,
    handleRemoveFile,
    clearAttachedFiles,
    handleClearAllFiles
  };
};
