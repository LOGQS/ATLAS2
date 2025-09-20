// status: complete

import { AttachedFile } from '../../utils/storage/BrowserStorage';
import { apiUrl } from '../../config/api';
import logger from '../../utils/core/logger';
import {
  shouldCleanupTempFiles,
  getTemporaryFiles,
  getRealFiles,
  isTemporaryFile,
  TEMP_FILE_PREFIX
} from './FileStateUtils';

export const performTempFileCleanup = (
  setAttachedFiles: React.Dispatch<React.SetStateAction<AttachedFile[]>>,
  context: string
) => {
  setAttachedFiles(prev => {
    if (!shouldCleanupTempFiles(prev)) return prev;

    const tempFiles = getTemporaryFiles(prev);
    if (tempFiles.length > 0) {
      logger.info(`[${context}] State-based cleanup of temp files:`, tempFiles.length);
      return getRealFiles(prev);
    }
    return prev;
  });
};

export const handleBackendError = (
  error: any,
  operation: string,
  setAttachedFiles: React.Dispatch<React.SetStateAction<AttachedFile[]>>,
  rollbackFile?: AttachedFile,
  rollbackFiles?: AttachedFile[]
) => {
  logger.error(`Backend error during ${operation}:`, error);

  if (rollbackFile) {
    setAttachedFiles(prev => {
      if (prev.some(f => f.id === rollbackFile.id)) return prev;
      return [...prev, rollbackFile];
    });
  }

  if (rollbackFiles) {
    setAttachedFiles(prev => [...prev, ...rollbackFiles]);
  }
};

export const handleClientError = (
  error: any,
  operation: string,
  setAttachedFiles: React.Dispatch<React.SetStateAction<AttachedFile[]>>
) => {
  if (error instanceof DOMException && error.name === 'AbortError') {
    logger.info(`${operation} cancelled by user`);
  } else {
    logger.error(`Client error during ${operation}:`, error);
  }

  setAttachedFiles(prev => getRealFiles(prev));
};

export const handleFileUpload = async (
  files: FileList,
  optimisticFiles: AttachedFile[] | undefined,
  attachedFiles: AttachedFile[],
  setUploadAbortController: React.Dispatch<React.SetStateAction<AbortController | null>>,
  setAttachedFiles: React.Dispatch<React.SetStateAction<AttachedFile[]>>
) => {
  try {
    logger.info('[MULTI-FILE] Starting parallel backend upload for', files.length, 'files');

    const formData = new FormData();
    const tempIds: string[] = [];

    const tempFilesToMatch = optimisticFiles || attachedFiles;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      formData.append('files', file);

      const matchingTempFile = tempFilesToMatch.find(af =>
        isTemporaryFile(af) && af.name === file.name
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

    const timeoutMs = 15 * 60 * 1000;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        abortController.abort();
        reject(new Error('Upload timeout after 15 minutes'));
      }, timeoutMs);
    });

    const fetchPromise = fetch(apiUrl('/api/files/upload'), {
      method: 'POST',
      body: formData,
      signal: abortController.signal
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (response.ok) {
      const data = await response.json();
      logger.info('[MULTI-FILE] Parallel upload completed successfully:', data.files?.length || 1, 'files processed in parallel', data.files?.map((f: { name: any; api_state: any; }) => ({ name: f.name, api_state: f.api_state })));

      performTempFileCleanup(setAttachedFiles, 'UPLOAD_COMPLETE');

      if (data.errors && data.errors.length > 0) {
        logger.warn('Some files failed to upload:', data.errors);
      }
    } else {
      const errorData = await response.json();
      handleBackendError(errorData.error || errorData.errors, 'file upload', setAttachedFiles);
    }
  } catch (error) {
    handleClientError(error, 'file upload', setAttachedFiles);
  } finally {
    setUploadAbortController(null);
  }
};

export const handleRemoveFile = async (
  fileId: string,
  attachedFiles: AttachedFile[],
  setAttachedFiles: React.Dispatch<React.SetStateAction<AttachedFile[]>>
) => {
  logger.info('Removing/canceling attached file with ID:', fileId);

  const fileToRemove = attachedFiles.find(file => file.id === fileId);
  if (!fileToRemove) {
    logger.warn('File not found in attached files:', fileId);
    return;
  }

  setAttachedFiles(prev => prev.filter(file => file.id !== fileId));

  if (fileId.startsWith(TEMP_FILE_PREFIX)) {
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
      handleBackendError(errorData.error, 'file deletion', setAttachedFiles, fileToRemove);
    }
  } catch (error) {
    handleBackendError(error, 'file deletion', setAttachedFiles, fileToRemove);
  }
};

export const handleClearAllFiles = async (
  attachedFiles: AttachedFile[],
  uploadAbortController: AbortController | null,
  setUploadAbortController: React.Dispatch<React.SetStateAction<AbortController | null>>,
  clearAttachedFiles: () => void,
  setAttachedFiles: React.Dispatch<React.SetStateAction<AttachedFile[]>>
) => {
  if (attachedFiles.length === 0) return;

  logger.info('Clearing all attached files:', attachedFiles.length);

  if (uploadAbortController) {
    logger.info('[CANCEL] Cancelling ongoing upload request');
    uploadAbortController.abort();
    setUploadAbortController(null);
  }

  const filesToClear = [...attachedFiles];

  const tempFiles = getTemporaryFiles(filesToClear);
  const realFiles = getRealFiles(filesToClear);

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
        handleBackendError(errorData.error, 'batch file deletion', setAttachedFiles, undefined, realFiles);
      } else {
        logger.info(`Successfully deleted ${realFiles.length} files from backend`);
      }
    } catch (error) {
      handleBackendError(error, 'batch file deletion', setAttachedFiles, undefined, realFiles);
    }
  } else {
    logger.info('No real files to delete from backend - all were temp files');
  }
};