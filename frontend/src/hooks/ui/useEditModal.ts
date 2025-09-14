import { useState, useCallback } from 'react';
import logger from '../../utils/core/logger';
import type { Message } from '../../types/messages';
import { useVersioning } from '../versioning/useVersioning';

interface UseEditModalProps {
  messages: Message[];
  messageOperations: ReturnType<typeof useVersioning>;
  onEditComplete?: (messageId: string, newContent: string, success: boolean) => void;
}

interface EditEmbedState {
  editingMessageId: string | null;
}

export const useEditModal = ({ messages, messageOperations, onEditComplete }: UseEditModalProps) => {
  const [editEmbed, setEditEmbed] = useState<EditEmbedState>({ 
    editingMessageId: null
  });

  const handleMessageEdit = useCallback((messageId: string) => {
    try {
      logger.info(`[EditEmbed] Starting embedded edit for message ${messageId}`);
      
      const message = messages.find(msg => msg.id === messageId);
      if (!message) {
        logger.error(`[EditEmbed] Message ${messageId} not found for editing`);
        return;
      }
      
      setEditEmbed({
        editingMessageId: messageId
      });
    } catch (error) {
      logger.error('[EditEmbed] Error starting embedded edit:', error);
    }
  }, [messages]);

  const handleEditSave = useCallback(async (newContent: string) => {
    if (!editEmbed.editingMessageId) return;
    
    logger.info(`[EditEmbed] Saving edit for message ${editEmbed.editingMessageId}`);
    setEditEmbed({ editingMessageId: null });
    
    try {
      const success = await messageOperations.editMessage(editEmbed.editingMessageId, newContent);
      
      if (success) {
        logger.info(`[EditEmbed] Successfully edited message ${editEmbed.editingMessageId}`);
      } else {
        logger.error(`[EditEmbed] Failed to edit message ${editEmbed.editingMessageId}`);
      }
      try { onEditComplete?.(editEmbed.editingMessageId, newContent, !!success); } catch (e) { /* noop */ }
    } catch (error) {
      logger.error('[EditEmbed] Error saving edit:', error);
    }
  }, [editEmbed.editingMessageId, messageOperations, onEditComplete]);

  const handleEditCancel = useCallback(() => {
    setEditEmbed({ editingMessageId: null });
  }, []);

  const isMessageBeingEdited = useCallback((messageId: string) => {
    return editEmbed.editingMessageId === messageId;
  }, [editEmbed.editingMessageId]);

  return {
    editEmbed,
    isMessageBeingEdited,
    handleMessageEdit,
    handleEditSave,
    handleEditCancel
  };
};
