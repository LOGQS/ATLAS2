export interface ChatHistoryItem {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
  first_message: string;
  cleared?: boolean; // Add flag to indicate if a chat has been cleared
  active?: boolean;  // Add flag to indicate if chat is in active sessions
  import_note?: string; // Note about when the chat was imported
}

// Add interfaces for stats and bulk operations
export interface ChatStats {
  total_chats: number;
  active_chats: number;
  total_messages: number;
  user_messages: number;
  assistant_messages: number;
  messages_ratio: {
    user: number;
    assistant: number;
  };
  avg_messages_per_chat: number;
  oldest_chat?: {
    id: string;
    date: string;
    title: string;
  };
  newest_chat?: {
    id: string;
    date: string;
    title: string;
  };
  chat_with_most_messages?: {
    id: string;
    count: number;
  };
  file_size: {
    bytes: number;
    kb: number;
    mb: number;
  };
  has_chat_history: boolean;
  timestamp: string;
  error?: string;
}

export interface BulkDeleteResult {
  success: boolean;
  message: string;
  stats: {
    requested: number;
    deleted_from_history: number;
    deleted_from_active: number;
    remaining_chats: number;
  };
}

export interface ChatSearchResult {
  chat_id: string;
  chat_title?: string;
  message_index: number;
  role: string;
  content: string;
  timestamp?: string;
  tags?: string[];
}

export interface ChatBackupMeta {
  exported_at: string;
  version: string;
  format: string;
  chat_count: number;
}

export interface ChatBackupData {
  data: {
    chats: ChatHistoryItem[];
  };
  meta: ChatBackupMeta;
}

// Simple event types for our event system
type EventCallback = (chats: ChatHistoryItem[]) => void;

// Update the interface for stats results
interface ImportResult {
  success: boolean;
  message: string;
  error?: string;
  stats: {
    imported_count: number;
    updated_count: number;
    skipped_count: number;
    total_chats: number;
  };
}

export interface ClearAllResult {
  success: boolean;
  message: string;
  error?: string; // Add optional error property
  stats: {
    removed_from_history: number;
    removed_from_active: number;
    deleted_files: number;
  };
}

// Add this interface with the other interfaces
interface ImportedChatData {
  history: Record<string, ImportedChat>;
}

interface ImportedChat {
  title?: string;
  model?: string;
  created_at?: string;
  messages: Array<{content?: string; [key: string]: unknown}>;
  [key: string]: unknown;
}

/**
 * Chat Manager - Singleton class to manage chat history throughout the application
 * Provides methods to load and access chat history
 */
class ChatManager {
  private static instance: ChatManager;
  private chats: ChatHistoryItem[] = [];
  private backendAvailable: boolean = false;
  private initialLoadAttempted: boolean = false;
  private maxRetries: number = 3;
  private retryCount: number = 0;
  private retryTimeout: number | null = null;
  private listeners: Map<string, EventCallback[]> = new Map();
  
  private constructor() {
    // Initialize and load chats
    this.initializeChats();
    this.checkBackendHealth();
  }
  
  /**
   * Get the singleton instance
   */
  public static getInstance(): ChatManager {
    if (!ChatManager.instance) {
      ChatManager.instance = new ChatManager();
    }
    return ChatManager.instance;
  }

  // Simple event emitter method
  private emit(event: string, data: ChatHistoryItem[]): void {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error('Error in chat manager event listener:', error);
      }
    });
  }

  /**
   * Check if the backend is available by making a health check request
   */
  private async checkBackendHealth(): Promise<void> {
    try {
      const response = await fetch('/api/health', {
        method: 'GET',
        headers: {
          'Cache-Control': 'no-cache'
        }
      }).catch(() => {
        // Silently catch connection errors
        return { ok: false } as Response;
      });

      this.backendAvailable = response.ok;
      console.log(`Backend health check: ${this.backendAvailable ? 'Available' : 'Unavailable'}`);

      // If backend is available now and we haven't successfully loaded the chats yet,
      // try to load them
      if (this.backendAvailable && !this.initialLoadAttempted) {
        console.log('Backend is now available. Attempting to load chat history...');
        this.loadChats()
          .then(() => {
            this.initialLoadAttempted = true;
            console.log('Chat history loaded successfully after backend became available');
          })
          .catch(error => {
            console.warn('Failed to load chat history after backend became available:', error);
          });
      }

      // If backend is still not available, set up another health check after a delay
      if (!this.backendAvailable && this.retryCount < this.maxRetries) {
        this.retryCount++;
        const retryDelay = Math.min(2000 * this.retryCount, 10000); // Exponential backoff, max 10 seconds
        console.log(`Will retry backend health check in ${retryDelay}ms (attempt ${this.retryCount}/${this.maxRetries})`);
        
        // Clear any existing timeout
        if (this.retryTimeout !== null) {
          window.clearTimeout(this.retryTimeout);
        }
        
        // Set up a new timeout
        this.retryTimeout = window.setTimeout(() => {
          this.checkBackendHealth();
        }, retryDelay);
      }
    } catch (error) {
      console.error('Error checking backend health:', error);
      this.backendAvailable = false;
      
      // Retry health check with backoff
      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        const retryDelay = Math.min(2000 * this.retryCount, 10000);
        console.log(`Will retry backend health check in ${retryDelay}ms (attempt ${this.retryCount}/${this.maxRetries})`);
        
        if (this.retryTimeout !== null) {
          window.clearTimeout(this.retryTimeout);
        }
        
        this.retryTimeout = window.setTimeout(() => {
          this.checkBackendHealth();
        }, retryDelay);
      }
    }
  }
  
  /**
   * Initialize chats by loading from the backend
   */
  private async initializeChats(): Promise<void> {
    try {
      // Check local storage first for immediate UI display
      this.loadFromLocalStorage();
      
      // Try to load from backend as well, but handle connection errors gracefully
      try {
        // Initial attempt to load from backend
        await this.loadChats();
        this.initialLoadAttempted = true;
      } catch (error) {
        // If it's a connection error, we'll try again when the backend is available
        if (error instanceof Error && error.message.includes('Backend not available')) {
          console.log('Backend not available yet. Will load chat history when backend is ready.');
        } else {
          console.error('Error loading chat history from backend:', error);
        }
      }
    } catch (error) {
      console.error('Error initializing chats:', error);
    }
  }
  
  /**
   * Load chats from the backend API
   */
  private async loadChats(): Promise<void> {
    try {
      
      // Add error handling for potential connection errors when the backend is starting up
      const response = await fetch('/api/chats/load', {
        cache: 'no-cache',
        headers: {
          'Cache-Control': 'no-cache'
        },
        // Set a timeout for the request
        signal: AbortSignal.timeout(3000) // 3 second timeout
      }).catch(error => {
        console.log('Chat history load connection error:', error.message);
        this.backendAvailable = false;
        throw new Error('Backend not available yet');
      });
      
      if (!response.ok) {
        throw new Error(`Failed to load chat history: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (data && data.chats) {
        this.chats = data.chats || [];
        
        // If we successfully loaded, mark backend as available
        this.backendAvailable = true;
        this.initialLoadAttempted = true;
        
        // Store in local storage for quick access next time
        this.saveToLocalStorage();
        
        // Emit update event
        this.emit('update', this.chats);
      }
    } catch (error) {
      console.error('Error loading chat history from backend:', error);
      
      // Check if it's a connection error and set backend availability accordingly
      if (error instanceof Error && 
          (error.message.includes('Failed to fetch') || 
           error.message.includes('Backend not available'))) {
        this.backendAvailable = false;
        throw new Error('Backend not available yet');
      }
      
      throw error;
    }
  }
  
  /**
   * Save chats to local storage (for quick access on next load)
   */
  private saveToLocalStorage(): void {
    try {
      localStorage.setItem('atlas_chat_history', JSON.stringify({
        chats: this.chats,
        lastUpdated: new Date().toISOString()
      }));
    } catch (error) {
      console.error('Failed to save chat history to local storage:', error);
    }
  }
  
  /**
   * Load chats from local storage (for quick access before API loads)
   */
  private loadFromLocalStorage(): void {
    try {
      const data = localStorage.getItem('atlas_chat_history');
      if (data) {
        const parsed = JSON.parse(data);
        
        // Only load from local storage if we don't already have data
        if (this.chats.length === 0 && parsed.chats) {
          this.chats = parsed.chats || [];
        }
      }
    } catch (error) {
      console.error('Failed to load chat history from local storage:', error);
    }
  }
  
  /**
   * Refresh chats from the backend
   * This is useful after creating or deleting chats
   */
  public async refreshChats(): Promise<void> {
    try {
      if (!this.backendAvailable) {
        console.log('Backend not available, cannot refresh chat history');
        throw new Error('Backend not available');
      }
      
      await this.loadChats();
    } catch (error) {
      console.error('Error refreshing chat history:', error);
      throw error;
    }
  }
  
  /**
   * Get all chats
   */
  public getChats(): ChatHistoryItem[] {
    // Sort by updated_at timestamp (most recent first)
    // Filter out any chats that are marked as cleared
    return [...this.chats]
      .filter(chat => !chat.cleared)
      .sort((a, b) => 
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
  }
  
  /**
   * Get a chat by ID
   */
  public getChatById(id: string): ChatHistoryItem | undefined {
    return this.chats.find(chat => chat.id === id);
  }
  
  /**
   * Delete a chat by ID
   * This makes an API call to delete the chat from the backend
   */
  public async deleteChat(id: string): Promise<boolean> {
    try {
      if (!this.backendAvailable) {
        console.log('Backend not available, cannot delete chat');
        return false;
      }
      
      const response = await fetch(`/api/chat/${id}/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to delete chat: ${response.status} ${response.statusText}`);
      }
      
      // Remove from local array
      this.chats = this.chats.filter(chat => chat.id !== id);
      
      // Update local storage
      this.saveToLocalStorage();
      
      // Emit update event
      this.emit('update', this.chats);
      
      return true;
    } catch (error) {
      console.error('Error deleting chat:', error);
      return false;
    }
  }
  
  /**
   * Update a chat's metadata (title, model, etc.)
   * This now uses the dedicated endpoint for single chat updates
   */
  public async updateChatMetadata(id: string, metadata: Partial<ChatHistoryItem>): Promise<boolean> {
    try {
      if (!this.backendAvailable) {
        console.log('Backend not available, cannot update chat metadata');
        return false;
      }
      
      // Use the new dedicated endpoint for chat updates
      const response = await fetch(`/api/chats/${id}/update`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata)
      });
      
      if (!response.ok) {
        throw new Error(`Failed to update chat: ${response.status} ${response.statusText}`);
      }
      
      // Update local chat
      const chatIndex = this.chats.findIndex(chat => chat.id === id);
      if (chatIndex === -1) {
        console.error(`Chat with ID ${id} not found`);
        return false;
      }
      
      // Update the chat with new metadata
      this.chats[chatIndex] = { 
        ...this.chats[chatIndex], 
        ...metadata,
        updated_at: new Date().toISOString() // Always update timestamp
      };
      
      // Update local storage
      this.saveToLocalStorage();
      
      // Emit update event
      this.emit('update', this.chats);
      
      return true;
    } catch (error) {
      console.error('Error updating chat metadata:', error);
      return false;
    }
  }
  
  /**
   * Create a new empty chat
   * This creates a chat entry without starting a conversation
   */
  public async createEmptyChat(title: string = "New Chat", model: string = "gemini-2.0-flash"): Promise<ChatHistoryItem | null> {
    try {
      if (!this.backendAvailable) {
        console.log('Backend not available, cannot create chat');
        return null;
      }
      
      const response = await fetch('/api/chats/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          model
        })
      });
      
      if (!response.ok) {
        throw new Error(`Failed to create chat: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (data.success && data.chat) {
        // Add new chat to local array
        this.chats.push(data.chat);
        
        // Update local storage
        this.saveToLocalStorage();
        
        // Emit update event
        this.emit('update', this.chats);
        
        return data.chat;
      } else {
        throw new Error('Failed to create chat: Invalid response from server');
      }
    } catch (error) {
      console.error('Error creating chat:', error);
      return null;
    }
  }
  
  /**
   * Export chat history as a backup file
   * This downloads a JSON file with all chat history
   */
  public async exportChatHistory(): Promise<void> {
    try {
      if (!this.backendAvailable) {
        console.log('Backend not available, cannot export chat history');
        throw new Error('Backend not available');
      }
      
      // Directly trigger a file download by creating a link to the export endpoint
      const link = document.createElement('a');
      link.href = '/api/chats/export';
      link.download = `atlas_chat_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      link.click();
      
    } catch (error) {
      console.error('Error exporting chat history:', error);
      throw error;
    }
  }
  
  /**
   * Import chat history from a backup file
   * @param file The backup file to import
   * @param mergeMode Whether to merge with existing chats or replace them ('merge' or 'replace')
   */
  public async importChatHistory(file: File, mergeMode: 'merge' | 'replace' = 'merge'): Promise<ImportResult> {
    try {
      if (!this.backendAvailable) {
        console.log('Backend not available, cannot import chat history');
        throw new Error('Backend not available');
      }
      
      const formData = new FormData();
      formData.append('backup_file', file);
      formData.append('merge_mode', mergeMode);
      
      const response = await fetch('/api/chats/import', {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) {
        throw new Error(`Failed to import chat history: ${response.status} ${response.statusText}`);
      }
      
      const result = await response.json() as ImportResult;
      
      if (result.success) {
        // Refresh chats to get the updated list
        await this.refreshChats();
        return result;
      } else {
        throw new Error(result.error || 'Failed to import chat history');
      }
    } catch (error) {
      console.error('Error importing chat history:', error);
      throw error;
    }
  }
  
  /**
   * Get chat statistics
   * This returns detailed statistics about the chat history
   */
  public async getChatStats(): Promise<ChatStats> {
    try {
      if (!this.backendAvailable) {
        console.log('Backend not available, cannot get chat stats');
        throw new Error('Backend not available');
      }
      
      const response = await fetch('/api/chats/stats', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to get chat stats: ${response.status} ${response.statusText}`);
      }
      
      return await response.json() as ChatStats;
    } catch (error) {
      console.error('Error getting chat stats:', error);
      throw error;
    }
  }
  
  /**
   * Delete multiple chats at once
   * @param chatIds Array of chat IDs to delete
   */
  public async bulkDeleteChats(chatIds: string[]): Promise<BulkDeleteResult> {
    try {
      if (!this.backendAvailable) {
        console.log('Backend not available, cannot bulk delete chats');
        throw new Error('Backend not available');
      }
      
      const response = await fetch('/api/chats/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_ids: chatIds })
      });
      
      if (!response.ok) {
        throw new Error(`Failed to bulk delete chats: ${response.status} ${response.statusText}`);
      }
      
      const result = await response.json();
      
      if (result.success) {
        // Remove the deleted chats from local array
        this.chats = this.chats.filter(chat => !chatIds.includes(chat.id));
        
        // Update local storage
        this.saveToLocalStorage();
        
        // Emit update event
        this.emit('update', this.chats);
        
        return result;
      } else {
        throw new Error(result.error || 'Failed to bulk delete chats');
      }
    } catch (error) {
      console.error('Error bulk deleting chats:', error);
      throw error;
    }
  }
  
  /**
   * Clear all chat history
   * This deletes all chats from the backend and local storage
   */
  public async clearAllChats(): Promise<ClearAllResult> {
    try {
      if (!this.backendAvailable) {
        console.log('Backend not available, cannot clear all chats');
        throw new Error('Backend not available');
      }
      
      // This requires explicit confirmation to prevent accidental deletion
      const response = await fetch('/api/chats/clear-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'confirm_delete_all' })
      });
      
      if (!response.ok) {
        throw new Error(`Failed to clear all chats: ${response.status} ${response.statusText}`);
      }
      
      const result = await response.json() as ClearAllResult;
      
      if (result.success) {
        // Clear local array
        this.chats = [];
        
        // Update local storage
        this.saveToLocalStorage();
        
        // Emit update event
        this.emit('update', this.chats);
        
        return result;
      } else {
        throw new Error(result.error || 'Failed to clear all chats');
      }
    } catch (error) {
      console.error('Error clearing all chats:', error);
      throw error;
    }
  }

  /**
   * Search chat messages via backend
   */
  public async searchMessages(query: string, start?: string, end?: string, tags?: string[]): Promise<ChatSearchResult[]> {
    try {
      const params = new URLSearchParams();
      if (query) params.append('q', query);
      if (start) params.append('start', start);
      if (end) params.append('end', end);
      if (tags && tags.length) params.append('tags', tags.join(','));

      const response = await fetch(`/api/chats/search?${params.toString()}`, { cache: 'no-cache' });
      if (!response.ok) {
        throw new Error(`Search failed: ${response.status}`);
      }
      const data = await response.json();
      return data.results as ChatSearchResult[];
    } catch (error) {
      console.error('Error searching messages:', error);
      return [];
    }
  }

  /**
   * Update tags for a specific message
   */
  public async updateMessageTags(chatId: string, index: number, tags: string[]): Promise<boolean> {
    try {
      const response = await fetch(`/api/chats/${chatId}/messages/${index}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags })
      });
      if (!response.ok) return false;
      return true;
    } catch (error) {
      console.error('Error updating message tags:', error);
      return false;
    }
  }
  
  /**
   * Subscribe to chat updates
   */
  public subscribe(callback: (chats: ChatHistoryItem[]) => void): () => void {
    // Get existing callbacks or initialize empty array
    const callbacks = this.listeners.get('update') || [];
    
    // Add the new callback
    callbacks.push(callback);
    
    // Update the map
    this.listeners.set('update', callbacks);
    
    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get('update') || [];
      const updatedCallbacks = callbacks.filter(cb => cb !== callback);
      this.listeners.set('update', updatedCallbacks);
    };
  }

  /**
   * Import chat history from JSON data
   * @param data The chat history data to import
   * @param mode Whether to merge with existing chats or replace them
   */
  public async importChats(data: ImportedChatData, mode: 'merge' | 'replace' = 'merge'): Promise<ImportResult> {
    try {
      if (!data || typeof data !== 'object' || !data.history) {
        throw new Error('Invalid chat history format');
      }

      if (!this.backendAvailable) {
        console.log('Backend not available, cannot import chats');
        throw new Error('Backend not available');
      }

      // Statistics for the operation
      const stats = {
        imported_count: 0,
        updated_count: 0,
        skipped_count: 0,
        total_chats: 0
      };

      // If mode is replace, clear the current history first
      if (mode === 'replace') {
        this.chats = [];
      }

      // Merge the imported history with the current history
      const importedHistory = data.history;
      const timestamp = new Date().toISOString();
      
      // Check each imported chat and add it if it doesn't exist or update if it does
      Object.keys(importedHistory).forEach(chatId => {
        const importedChat = importedHistory[chatId];
        
        // Ensure the imported chat has the required properties
        if (importedChat && 
            typeof importedChat === 'object' && 
            importedChat.messages && 
            Array.isArray(importedChat.messages)) {
          
          // Check if the chat already exists
          const existingChatIndex = this.chats.findIndex(chat => chat.id === chatId);
          
          if (existingChatIndex !== -1) {
            // Update existing chat
            this.chats[existingChatIndex] = {
              ...this.chats[existingChatIndex],
              ...importedChat,
              updated_at: timestamp,
              import_note: `Updated during import on ${timestamp}`
            };
            stats.updated_count++;
          } else {
            // Add new chat
            this.chats.push({
              id: chatId,
              title: importedChat.title || 'Imported Chat',
              model: importedChat.model || 'unknown',
              created_at: importedChat.created_at || timestamp,
              updated_at: timestamp,
              first_message: importedChat.first_message || (importedChat.messages[0]?.content || 'No content'),
              import_note: `Imported on ${timestamp}`
            } as ChatHistoryItem);
            stats.imported_count++;
          }
        } else {
          stats.skipped_count++;
        }
      });

      stats.total_chats = this.chats.length;

      // Save the updated history to both local storage and backend
      this.saveToLocalStorage();
      
      // Send to backend
      const response = await fetch('/api/chats/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chats: this.chats })
      });
      
      if (!response.ok) {
        throw new Error(`Failed to save imported chat history: ${response.status} ${response.statusText}`);
      }

      // Notify subscribers of the update
      this.emit('update', this.chats);

      return {
        success: true,
        message: `Successfully imported ${stats.imported_count} new chats and updated ${stats.updated_count} existing chats.`,
        stats
      };
    } catch (error) {
      console.error('Error importing chats:', error);
      return {
        success: false,
        message: 'Failed to import chat history',
        error: error instanceof Error ? error.message : String(error),
        stats: {
          imported_count: 0,
          updated_count: 0,
          skipped_count: 0,
          total_chats: this.chats.length
        }
      };
    }
  }

  /**
   * Retrieve an LLM-generated summary for the given chat
   * @param id Chat ID
   * @param model Model to use for summarization
   */
  public async getChatSummary(id: string, model: string): Promise<string | null> {
    try {
      if (!this.backendAvailable) {
        console.log('Backend not available, cannot summarize chat');
        return null;
      }

      const response = await fetch(`/api/chat/${id}/summary?model=${encodeURIComponent(model)}`, {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!response.ok) {
        throw new Error(`Failed to summarize chat: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.summary as string;
    } catch (error) {
      console.error('Error fetching chat summary:', error);
      return null;
    }
  }

  /**
   * Replace chat history with a condensed summary
   * @param id Chat ID
   * @param summary Summary text
   * @param model Model name
   */
  public async condenseChat(id: string, summary: string, model: string): Promise<boolean> {
    try {
      if (!this.backendAvailable) {
        console.log('Backend not available, cannot condense chat');
        return false;
      }

      const response = await fetch(`/api/chat/${id}/condense`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary, model })
      });

      if (!response.ok) {
        throw new Error(`Failed to condense chat: ${response.status} ${response.statusText}`);
      }

      // Refresh chats list after condensing
      await this.refreshChats();
      return true;
    } catch (error) {
      console.error('Error condensing chat:', error);
      return false;
    }
  }
}

// Export the singleton instance
const chatManager = ChatManager.getInstance();
export default chatManager; 