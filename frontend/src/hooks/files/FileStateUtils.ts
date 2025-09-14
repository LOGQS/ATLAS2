// status: complete

import { AttachedFile } from '../../utils/storage/BrowserStorage';

export const TEMP_FILE_PREFIX = 'temp_';

export const FILE_STATES = {
  LOCAL: 'local',
  PROCESSING_MD: 'processing_md',
  UPLOADING: 'uploading',
  UPLOADED: 'uploaded',
  PROCESSING: 'processing',
  READY: 'ready'
} as const;

export const PROCESSING_STATES = [FILE_STATES.LOCAL, FILE_STATES.PROCESSING_MD, FILE_STATES.UPLOADING, FILE_STATES.UPLOADED, FILE_STATES.PROCESSING];
export const CHAT_READY_STATES = [FILE_STATES.READY];

export const isTemporaryFile = (file: AttachedFile): boolean => {
  return file.id.startsWith(TEMP_FILE_PREFIX);
};

export const isProcessingFile = (file: AttachedFile): boolean => {
  return file.api_state ? PROCESSING_STATES.includes(file.api_state as any) : false;
};

export const isReadyFile = (file: AttachedFile): boolean => {
  return file.api_state === FILE_STATES.READY;
};

export const getProcessingFiles = (files: AttachedFile[]): AttachedFile[] => {
  return files.filter(f => isTemporaryFile(f) && isProcessingFile(f));
};

export const getTemporaryFiles = (files: AttachedFile[]): AttachedFile[] => {
  return files.filter(isTemporaryFile);
};

export const getRealFiles = (files: AttachedFile[]): AttachedFile[] => {
  return files.filter(f => !isTemporaryFile(f));
};

export const shouldCleanupTempFiles = (files: AttachedFile[]): boolean => {
  const tempFiles = getTemporaryFiles(files);
  if (tempFiles.length === 0) return false;

  return tempFiles.every(f =>
    !isProcessingFile(f) && f.api_state !== FILE_STATES.LOCAL
  );
};

export const findFileByDirectId = (files: AttachedFile[], fileId: string) => {
  const fileIndex = files.findIndex(file => file.id === fileId);
  return fileIndex !== -1 ? { file: files[fileIndex], index: fileIndex } : null;
};

export const findFileByTempId = (files: AttachedFile[], tempId: string) => {
  const tempFileIndex = files.findIndex(file => file.id === tempId);
  return tempFileIndex !== -1 ? { file: files[tempFileIndex], index: tempFileIndex } : null;
};

export const findFallbackProcessingFile = (files: AttachedFile[]) => {
  const processingFiles = getProcessingFiles(files);
  if (processingFiles.length === 0) return null;

  const fallbackFile = processingFiles[0];
  const fallbackIndex = files.findIndex(file => file.id === fallbackFile.id);
  return fallbackIndex !== -1 ? { file: fallbackFile, index: fallbackIndex } : null;
};

export const updateFileAtIndex = (files: AttachedFile[], index: number, updates: Partial<AttachedFile>): AttachedFile[] => {
  return files.map((f, idx) => idx === index ? { ...f, ...updates } : f);
};