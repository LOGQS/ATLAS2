import { useCallback } from 'react';
import logger from '../../utils/core/logger';
import { apiUrl } from '../../config/api';

interface ChatItem {
  id: string;
  name: string;
  isActive: boolean;
  state?: 'thinking' | 'responding' | 'static';
  last_active?: string;
}

interface UseBulkOperationsProps {
  setChats: React.Dispatch<React.SetStateAction<ChatItem[]>>;
  setPendingFirstMessages: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  handleNewChat: () => void;
  loadChatsFromDatabase: (options?: { expectedToken?: number }) => Promise<string[] | null>;
}

interface UseBulkOperationsReturn {
  handleBulkDelete: (chatIds: string[]) => Promise<void>;
  handleBulkExport: (chatIds: string[]) => Promise<void>;
  handleBulkImport: (files: FileList) => Promise<void>;
}

export const useBulkOperations = ({
  setChats,
  setPendingFirstMessages,
  handleNewChat,
  loadChatsFromDatabase
}: UseBulkOperationsProps): UseBulkOperationsReturn => {

  const handleBulkDelete = useCallback(async (chatIds: string[]) => {
    logger.info('Bulk deleting chats:', chatIds);

    const originalChats = await new Promise<ChatItem[]>(resolve => {
      setChats(prev => {
        resolve([...prev]);
        return prev;
      });
    });
    const originalPendingMessages = await new Promise<Map<string, string>>(resolve => {
      setPendingFirstMessages(prev => {
        resolve(new Map(prev));
        return prev;
      });
    });

    setChats(prev => prev.filter(chat => !chatIds.includes(chat.id)));
    setPendingFirstMessages(prev => {
      const newMap = new Map(prev);
      chatIds.forEach(id => newMap.delete(id));
      return newMap;
    });

    try {
      const response = await fetch(apiUrl('/api/db/chats/bulk-delete'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ chat_ids: chatIds })
      });

      if (response.ok) {
        const data = await response.json();
        logger.info('Bulk delete completed:', data.message);
        logger.info(`[BULK_DELETE] Successfully deleted ${data.deleted_chats?.length || chatIds.length} chats (cascade: ${data.cascade_deleted})`);

        if (data.active_chat_cleared) {
          logger.info('[BULK_DELETE] Active chat was cleared by backend, creating new chat');
          await handleNewChat();
        }
      } else {
        const data = await response.json();
        logger.error('Failed to bulk delete chats:', data.error);
        setChats(originalChats);
        setPendingFirstMessages(originalPendingMessages);
      }
    } catch (error) {
      logger.error('Failed to bulk delete chats:', error);
      setChats(originalChats);
      setPendingFirstMessages(originalPendingMessages);
    }
  }, [setChats, setPendingFirstMessages, handleNewChat]);

  const handleBulkExport = useCallback(async (chatIds: string[]) => {
    try {
      logger.info('Bulk exporting chats:', chatIds);
      const response = await fetch(apiUrl('/api/db/chats/bulk-export'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ chat_ids: chatIds })
      });

      if (response.ok) {
        const data = await response.json();
        logger.info('Bulk export completed:', data.export_count, 'chats');

        data.exported_chats.forEach((chat: any) => {
          const jsonData = JSON.stringify(chat, null, 2);
          const blob = new Blob([jsonData], { type: 'application/json' });
          const url = URL.createObjectURL(blob);

          const a = document.createElement('a');
          a.href = url;
          a.download = `chat_${chat.name?.replace(/[^a-zA-Z0-9]/g, '_') || chat.id}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        });
      } else {
        const data = await response.json();
        logger.error('Failed to bulk export chats:', data.error);
      }
    } catch (error) {
      logger.error('Failed to bulk export chats:', error);
    }
  }, []);

  const handleBulkImport = useCallback(async (files: FileList) => {
    try {
      logger.info('Bulk importing chats from', files.length, 'files');
      const chatsToImport: any[] = [];

      const fileArray = Array.from(files);
      logger.info('Processing files:', fileArray.map(f => f.name));

      for (const file of fileArray) {
        if (file.type === 'application/json' || file.name.endsWith('.json')) {
          try {
            logger.info('Processing file:', file.name);
            const text = await file.text();
            const chatData = JSON.parse(text);
            chatsToImport.push(chatData);
            logger.info('Successfully processed file:', file.name);
          } catch (error) {
            logger.error('Failed to parse JSON file:', file.name, error);
          }
        } else {
          logger.warn('Skipping non-JSON file:', file.name);
        }
      }

      if (chatsToImport.length === 0) {
        logger.warn('No valid JSON files found for import');
        return;
      }

      const response = await fetch(apiUrl('/api/db/chats/bulk-import'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ chats: chatsToImport })
      });

      if (response.ok) {
        const data = await response.json();
        logger.info('Bulk import completed:', data.message);

        await loadChatsFromDatabase();
      } else {
        const data = await response.json();
        logger.error('Failed to bulk import chats:', data.error);
      }
    } catch (error) {
      logger.error('Failed to bulk import chats:', error);
    }
  }, [loadChatsFromDatabase]);

  return {
    handleBulkDelete,
    handleBulkExport,
    handleBulkImport
  };
};