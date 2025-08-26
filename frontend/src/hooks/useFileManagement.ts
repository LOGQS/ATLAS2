// status: complete

import { useState, useRef, useEffect, useMemo } from 'react';
import { BrowserStorage, AttachedFile } from '../utils/BrowserStorage';
import { apiUrl } from '../config/api';
import logger from '../utils/logger';

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

    const handleFileStateUpdate = (event: CustomEvent) => {
      const { file_id, api_state, provider, temp_id } = event.detail;
      logger.info(`[App] Received SSE file state update: ${file_id} (temp:${temp_id}) -> ${api_state}`);
      
      setAttachedFiles(prev => {
        let updatedFiles = prev;
        let matchFound = false;
        let updateInfo = '';
        
        for (let i = 0; i < prev.length; i++) {
          const file = prev[i];
          if (file.id === file_id) {
            const oldState = file.api_state;
            if (oldState === api_state) {
              logger.debug(`[INDIVIDUAL] Skipping duplicate: ${file.name} already in ${api_state}`);
              return prev; 
            }
            
            updatedFiles = prev.map((f, idx) => 
              idx === i ? { ...f, api_state, provider: provider || f.provider } : f
            );
            updateInfo = `ID match: ${file.name} ${oldState} -> ${api_state}`;
            matchFound = true;
            break;
          }
        }
        
        if (!matchFound && temp_id) {
          for (let i = 0; i < prev.length; i++) {
            const file = prev[i];
            if (file.id === temp_id) {
              const oldState = file.api_state;
              updatedFiles = prev.map((f, idx) => 
                idx === i ? { 
                  ...f, 
                  id: file_id,
                  api_state, 
                  provider: provider || f.provider 
                } : f
              );
              updateInfo = `temp_id match: ${file.name} ${oldState} -> ${api_state} (temp:${temp_id} -> real:${file_id})`;
              matchFound = true;
              break;
            }
          }
        }
        
        if (!matchFound) {
          const processingFiles = prev.filter(f => 
            f.id.startsWith('temp_') && 
            ['local', 'processing_md', 'uploading', 'uploaded', 'processing'].includes(f.api_state || '')
          );
          
          if (processingFiles.length > 0) {
            const fallbackFile = processingFiles[0];
            for (let i = 0; i < prev.length; i++) {
              const file = prev[i];
              if (file.id === fallbackFile.id) {
                const oldState = file.api_state;
                updatedFiles = prev.map((f, idx) => 
                  idx === i ? { 
                    ...f, 
                    id: file_id, 
                    api_state, 
                    provider: provider || f.provider 
                  } : f
                );
                updateInfo = `fallback match: ${file.name} ${oldState} -> ${api_state}`;
                matchFound = true;
                break;
              }
            }
          }
        }
        
        if (matchFound) {
          logger.info(`[INDIVIDUAL] ${updateInfo} - clean UI update`);
          return updatedFiles;
        } else {
          logger.warn(`[INDIVIDUAL] No match found for ${file_id} (temp:${temp_id}) - skipping`);
          return prev;
        }
      });
    };

    window.addEventListener('fileStateUpdate', handleFileStateUpdate as EventListener);
    
    return () => {
      window.removeEventListener('fileStateUpdate', handleFileStateUpdate as EventListener);
    };
  }, [isAppInitialized]);

  const handleFileUpload = async (files: FileList, optimisticFiles?: AttachedFile[]) => {
    try {
      logger.info('[MULTI-FILE] Starting parallel backend upload for', files.length, 'files');
      
      const formData = new FormData();
      const tempIds: string[] = [];
      
      const tempFilesToMatch = optimisticFiles || attachedFiles;
      
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        formData.append('files', file);
        
        const matchingTempFile = tempFilesToMatch.find(af => 
          af.id.startsWith('temp_') && af.name === file.name
        );
        
        if (matchingTempFile) {
          tempIds.push(matchingTempFile.id);
          logger.info(`[MULTI-FILE] Matched file ${file.name} -> temp_id: ${matchingTempFile.id}`);
        } else {
          logger.warn(`[MULTI-FILE] No temp_id found for file: ${file.name}`);
          tempIds.push(''); 
        }
      }
      

      tempIds.forEach(tempId => {
        formData.append('temp_ids', tempId);
      });
      
      logger.info(`[MULTI-FILE] Sending ${tempIds.length} temp_ids for race condition handling:`, tempIds);
      
      const abortController = new AbortController();
      setUploadAbortController(abortController);
      
      const response = await fetch(apiUrl('/api/files/upload'), {
        method: 'POST',
        body: formData,
        signal: abortController.signal
      });
      
      if (response.ok) {
        const data = await response.json();
        logger.info('[MULTI-FILE] Parallel upload completed successfully:', data.files?.length || 1, 'files processed in parallel', data.files?.map((f: { name: any; api_state: any; }) => ({ name: f.name, api_state: f.api_state })));
        
        setTimeout(() => {
          setAttachedFiles(prev => {
            const tempFiles = prev.filter(f => f.id.startsWith('temp_'));
            if (tempFiles.length > 0) {
              logger.info('[App] Cleaning up remaining temp files after SSE processing:', tempFiles.length);
              return prev.filter(f => !f.id.startsWith('temp_'));
            }
            logger.info('[App] No temp files to clean up - SSE handled all upgrades successfully');
            return prev;
          });
        }, 100); 
        
        if (data.errors && data.errors.length > 0) {
          logger.warn('Some files failed to upload:', data.errors);
        }
      } else {
        const errorData = await response.json();
        logger.error('Failed to upload files:', errorData.error || errorData.errors);
        
        setAttachedFiles(prev => prev.filter(f => !f.id.startsWith('temp_')));
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        logger.info('[App] Upload cancelled by user');
        setAttachedFiles(prev => prev.filter(f => !f.id.startsWith('temp_')));
      } else {
        logger.error('[App] Error uploading files:', error);
        
        setAttachedFiles(prev => prev.filter(f => !f.id.startsWith('temp_')));
      }
    } finally {
      setUploadAbortController(null);
    }
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
      
      const optimisticFiles = Array.from(files).map(file => ({
        id: `temp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        name: file.name,
        size: file.size,
        type: file.type,
        api_state: 'local' as const,
        provider: undefined
      }));
      
      logger.info('[MULTI-FILE] Adding optimistic files to UI:', optimisticFiles.length, optimisticFiles.map(f => ({ name: f.name, api_state: f.api_state })));
      setAttachedFiles(prev => [...prev, ...optimisticFiles]);
      
      handleFileUpload(files, optimisticFiles);
      
    } catch (error) {
      logger.error('Error handling immediate file selection:', error);
    }
  };

  const handleRemoveFile = async (fileId: string) => {
    logger.info('Removing/canceling attached file with ID:', fileId);
    
    const fileToRemove = attachedFiles.find(file => file.id === fileId);
    if (!fileToRemove) {
      logger.warn('File not found in attached files:', fileId);
      return;
    }

    setAttachedFiles(prev => prev.filter(file => file.id !== fileId));
    
    if (fileId.startsWith('temp_')) {
      logger.info('Canceled temp file (no backend cleanup needed):', fileId);
      return;
    }
    
    try {
      const response = await fetch(apiUrl(`/api/files/${fileId}`), {
        method: 'DELETE'
      });
      
      if (response.ok) {
        const data = await response.json();
        logger.info('File deleted successfully from backend:', data.message);
      } else {
        const errorData = await response.json();
        logger.error('Failed to delete file from backend:', errorData.error);
        
        setAttachedFiles(prev => {
          if (prev.some(f => f.id === fileId)) return prev;
          return [...prev, fileToRemove];
        });
      }
    } catch (error) {
      logger.error('Error deleting file from backend:', error);
      
      setAttachedFiles(prev => {
        if (prev.some(f => f.id === fileId)) return prev;
        return [...prev, fileToRemove];
      });
    }
  };

  const clearAttachedFiles = () => {
    setAttachedFiles([]);
    BrowserStorage.clearAttachedFiles();
  };

  const handleClearAllFiles = async () => {
    if (attachedFiles.length === 0) return;
    
    logger.info('Clearing all attached files:', attachedFiles.length);
    
    if (uploadAbortController) {
      logger.info('[CANCEL] Cancelling ongoing upload request');
      uploadAbortController.abort();
      setUploadAbortController(null);
    }
    
    const filesToClear = [...attachedFiles];
    
    const tempFiles = filesToClear.filter(file => file.id.startsWith('temp_'));
    const realFiles = filesToClear.filter(file => !file.id.startsWith('temp_'));
    
    clearAttachedFiles();
    
    if (tempFiles.length > 0) {
      logger.info(`Cancelled ${tempFiles.length} temp files:`, tempFiles.map(f => f.name));
    }
    
    if (realFiles.length > 0) {
      const fileIds = realFiles.map(file => file.id);
      
      try {
        const response = await fetch(apiUrl('/api/files/batch'), {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ file_ids: fileIds })
        });
        
        if (!response.ok) {
          const errorData = await response.json();
          logger.error('Failed to batch delete files from backend:', errorData.error);
          setAttachedFiles(prev => [...prev, ...realFiles]);
        } else {
          logger.info(`Successfully deleted ${realFiles.length} files from backend`);
        }
      } catch (error) {
        logger.error('Error during batch delete:', error);
        setAttachedFiles(prev => [...prev, ...realFiles]);
      }
    } else {
      logger.info('No real files to delete from backend - all were temp files');
    }
  };

  const hasUnreadyFiles = useMemo(() => {
    const chatReadyStates = ['ready']; 
    const result = attachedFiles.some(file => 
      !file.api_state || !chatReadyStates.includes(file.api_state)
    );
    
    if (attachedFiles.length > 0) {
      const readyCount = attachedFiles.filter(f => f.api_state === 'ready').length;
      const processingCount = attachedFiles.filter(f => 
        f.api_state && ['local', 'processing_md', 'uploading', 'uploaded', 'processing'].includes(f.api_state)
      ).length;
      
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