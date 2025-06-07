import { io, Socket } from 'socket.io-client';

// Utility function to generate a unique chat ID
export function generateChatId(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const randomPart = Math.random().toString(36).substr(2, 8);
  return `unified_${timestamp}_${randomPart}`;
}

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
type WebSocketEventCallback = (data: Record<string, unknown>) => void;

// Background chat processing interfaces
interface BackgroundChatState {
  chatId: string;
  status: 'idle' | 'pending' | 'processing' | 'streaming' | 'completed' | 'error';
  currentResponse: string;
  lastUpdate: number;
  messageSentAt?: number; // Track when the user message was sent
  responseStartedAt?: number; // Track when response actually started
  isThinking?: boolean; // Track thinking state for Gemini 2.5 Pro models
}

interface WebSocketMessage extends Record<string, unknown> {
  type: string;
  chat_id: string;
  content?: string;
  full_response?: string;
  status?: string;
  error?: string;
}

interface WebSocketSendMessage {
  type: string;
  chat_id?: string;
  messages?: unknown[];
  model?: string;
  [key: string]: unknown;
}

// WebSocket manager for real-time communication using Socket.IO
class WebSocketManager {
  private static instance: WebSocketManager | null = null;
  private socket: Socket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private listeners: Map<string, WebSocketEventCallback[]> = new Map();
  private isShutdown = false; // Flag to prevent reconnections after shutdown
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  
  private constructor() {
    console.log('🌐 [WebSocket] Initializing WebSocket Manager');
    // Don't immediately connect - wait for first use
  }

  public static getInstance(): WebSocketManager {
    if (!WebSocketManager.instance || WebSocketManager.instance.isShutdown) {
      WebSocketManager.instance = new WebSocketManager();
    }
    return WebSocketManager.instance;
  }
  
  private connect() {
    if (this.isShutdown) {
      console.log('🌐 [WebSocket] Connection blocked - manager is shut down');
      return;
    }
    
    if (this.socket?.connected) {
      console.log('🌐 [WebSocket] Already connected');
      return;
    }

    console.log('🌐 [WebSocket] Connecting to server...');
    
    // Determine the correct backend port
    const backendPort = window.location.port === '5173' ? '5000' : (window.location.port || '5000');
    const backendUrl = `http://${window.location.hostname}:${backendPort}`;
    
    // Clean up existing socket if any
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    
    this.socket = io(backendUrl, {
      transports: ['websocket', 'polling'],
      timeout: 10000,
      reconnection: false, // Disable built-in reconnection, we'll handle it manually
      autoConnect: false // Don't auto-connect until we're ready
    });

    this.socket.on('connect', () => {
      console.log('🌐 [WebSocket] Connected to server');
      this.reconnectAttempts = 0;
      
      // Clear any pending reconnection timeout since we're connected
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      
      this.emit('connected', {});
    });

    this.socket.on('disconnect', (reason) => {
      console.log('🌐 [WebSocket] Disconnected:', reason);
      
      // Only attempt to reconnect if disconnection wasn't intentional and we're not shut down
      if (!this.isShutdown && reason !== 'io client disconnect') {
        if (reason === 'io server disconnect') {
          // Server initiated disconnect, reconnect manually
          setTimeout(() => {
            if (!this.isShutdown) {
              this.handleReconnect();
            }
          }, this.reconnectDelay);
        }
      }
    });

    this.socket.on('connect_error', (error) => {
      console.error('🌐 [WebSocket] Connection error:', error.message);
      
      // Only handle reconnection if not shut down
      if (!this.isShutdown) {
        this.handleReconnect();
      }
    });

    // Listen for chat updates
    this.socket.on('chat_update', (data) => {
      this.emit('chat_update', data);
    });

    this.socket.on('chat_status', (data) => {
      this.emit('chat_status', data);
    });

    this.socket.on('background_started', (data) => {
      this.emit('background_started', data);
    });

    this.socket.on('error', (error) => {
      console.error('🌐 [WebSocket] Socket error:', error);
      this.emit('error', { error: error.message || error });
    });

    // Actually connect now
    this.socket.connect();
  }
  
  private handleReconnect() {
    if (this.isShutdown) {
      console.log('🌐 [WebSocket] Reconnection blocked - manager is shut down');
      return;
    }
    
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);
      
      // Clear any existing reconnection timeout
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
      }
      
      this.reconnectTimeout = setTimeout(() => {
        if (!this.isShutdown) {
          console.log(`🌐 [WebSocket] Attempting to reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          this.connect();
        }
      }, delay);
    } else {
      console.error('🌐 [WebSocket] Max reconnection attempts reached. Stopping all reconnection attempts.');
      this.shutdown(); // Properly shutdown to stop all further attempts
      this.emit('max_retries_reached', {});
    }
  }
  
  public send(message: WebSocketSendMessage) {
    if (this.isShutdown) {
      console.debug('🔌 [WebSocket] Cannot send message - manager is shut down');
      return;
    }
    
    if (this.socket && this.socket.connected) {
      this.socket.emit(message.type, message);
    } else {
      console.debug('🔌 [WebSocket] Socket not connected, message dropped:', message.type);
      // Don't attempt to reconnect here to avoid spam
    }
  }
  
  public on(event: string, callback: WebSocketEventCallback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }
  
  public off(event: string, callback: WebSocketEventCallback) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }
  
  private emit(event: string, data: Record<string, unknown>) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error('Error in WebSocket event listener:', error);
      }
    });
  }
  
  public joinChat(chatId: string) {
    if (this.isShutdown) {
      console.debug('🔌 [WebSocket] Cannot join chat - manager is shut down');
      return;
    }
    
    // Ensure connection before sending
    if (!this.socket?.connected) {
      this.connect();
      // Wait a bit for connection before sending
      setTimeout(() => {
        if (!this.isShutdown) {
          this.send({
            type: 'join_chat',
            chat_id: chatId
          });
        }
      }, 1000);
    } else {
      this.send({
        type: 'join_chat',
        chat_id: chatId
      });
    }
  }
  
  public leaveChat(chatId: string) {
    if (this.socket?.connected) {
      this.send({
        type: 'leave_chat',
        chat_id: chatId
      });
    }
  }
  
  public startBackgroundChat(chatId: string, messages: unknown[], model: string, options: Record<string, unknown> = {}) {
    if (this.isShutdown) {
      console.debug('🔌 [WebSocket] Cannot start background chat - manager is shut down');
      return;
    }
    
    if (!this.socket?.connected) {
      this.connect();
      // Queue the message for when connection is established
      setTimeout(() => {
        if (!this.isShutdown) {
          this.send({
            type: 'start_background_chat',
            chat_id: chatId,
            messages: messages,
            model: model,
            ...options
          });
        }
      }, 1000);
    } else {
      this.send({
        type: 'start_background_chat',
        chat_id: chatId,
        messages: messages,
        model: model,
        ...options
      });
    }
  }
  
  public shutdown() {
    console.log('🌐 [WebSocket] Shutting down WebSocket manager');
    this.isShutdown = true;
    
    // Clear any pending reconnection timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    // Disconnect and cleanup socket
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    
    // Clear all listeners
    this.listeners.clear();
    
    console.log('🌐 [WebSocket] WebSocket manager shut down successfully');
  }
}

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
 * Provides methods to load and access chat history with background processing support
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
  
  // Background processing state
  private backgroundChats: Map<string, BackgroundChatState> = new Map();
  private wsManager: WebSocketManager;
  private backgroundProcessingEnabled: boolean = true;
  
  // Active chat tracking
  private activeChatId: string | null = null;
  
  // Performance optimization
  private maxBackgroundChats: number = 10;
  private cleanupInterval: number | null = null;
  private lastCleanup: number = Date.now();
  
  private constructor() {
    // Initialize and load chats
    this.initializeChats();
    this.checkBackendHealth();
    
    // Initialize WebSocket manager for background processing using singleton
    this.wsManager = WebSocketManager.getInstance();
    this.setupWebSocketListeners();
    
    // Start cleanup interval for inactive chats
    this.startCleanupInterval();
  }
  
  /**
   * Setup WebSocket event listeners for background chat processing
   */
  private setupWebSocketListeners() {
    // Handle chat updates from background processing
    this.wsManager.on('chat_update', (data: Record<string, unknown>) => {
      if (data.chat_id && typeof data.chat_id === 'string') {
        console.log(`📨 [ChatManager] Received chat update for ${data.chat_id.slice(-8)}:`, data.type);
        this.handleBackgroundChatUpdate(data.chat_id, data as WebSocketMessage);
      }
    });
    
    // Handle background processing status
    this.wsManager.on('chat_status', (data: Record<string, unknown>) => {
      if (data.chat_id && typeof data.chat_id === 'string') {
        const state = this.backgroundChats.get(data.chat_id) || {
          chatId: data.chat_id,
          status: 'idle',
          currentResponse: '',
          lastUpdate: Date.now()
        };
        if (typeof data.status === 'string') {
          state.status = data.status as 'idle' | 'pending' | 'processing' | 'streaming' | 'completed' | 'error';
        }
        this.backgroundChats.set(data.chat_id, state);
      }
    });
    
    // Handle background processing start confirmation
    this.wsManager.on('background_started', (data: Record<string, unknown>) => {
      if (data.chat_id && typeof data.chat_id === 'string') {
        this.backgroundChats.set(data.chat_id, {
          chatId: data.chat_id,
          status: 'processing',
          currentResponse: '',
          lastUpdate: Date.now()
        });
        console.log(`🚀 [ChatManager] Background processing started for chat ${data.chat_id.slice(-8)}`);
        console.log(`🗂️ [ChatManager] Current background chats:`, Array.from(this.backgroundChats.keys()).map(id => id.slice(-8)));
      }
    });
    
    // Handle errors and recovery
    this.wsManager.on('error', (data: Record<string, unknown>) => {
      console.error('WebSocket error:', data);
      // Emit error event for UI to handle
      this.emit('websocket-error', this.chats);
    });
    
    // Handle max retries reached
    this.wsManager.on('max_retries_reached', () => {
      console.error('WebSocket connection failed permanently');
      // Disable background processing temporarily
      this.backgroundProcessingEnabled = false;
      this.emit('connection-lost', this.chats);
    });
    
    // Handle reconnection success
    this.wsManager.on('connected', () => {
      console.log('WebSocket reconnected, re-enabling background processing');
      this.backgroundProcessingEnabled = true;
      
      // Rejoin all active chat rooms
      for (const [chatId, state] of this.backgroundChats) {
        if (state.status === 'pending' || 
            state.status === 'processing' || 
            state.status === 'streaming') {
          this.wsManager.joinChat(chatId);
        }
      }
      
      this.emit('connection-restored', this.chats);
    });
  }
  
  /**
   * Handle background chat updates from WebSocket
   */
  private handleBackgroundChatUpdate(chatId: string, data: WebSocketMessage) {
    if (!this.backgroundChats.has(chatId)) {
      // Initialize background state if it doesn't exist
      this.backgroundChats.set(chatId, {
        chatId: chatId,
        status: 'idle',
        currentResponse: '',
        lastUpdate: Date.now(),
        isThinking: false
      });
    }
    
    const state = this.backgroundChats.get(chatId)!;
    
    console.log(`🌐 [CM-WS] Processing WebSocket update for ${chatId.slice(-8)}:`, {
      type: data.type,
      hasContent: !!data.content,
      contentLength: data.content?.length || 0,
      hasFullResponse: !!data.full_response,
      fullResponseLength: data.full_response?.length || 0,
      currentStatus: state.status,
      currentResponseLength: state.currentResponse.length
    });
    
    switch (data.type) {
      case 'chunk':
        // Handle streaming chunks - accumulate response content
        if (data.content) {
          state.currentResponse += data.content;
          state.status = 'streaming';
          state.lastUpdate = Date.now();
          
          // ISSUE 2 FIX: Clear thinking state when actual content starts arriving
          if (state.isThinking && data.content.trim()) {
            console.log(`🧠 [CM-WS] Clearing thinking state for ${chatId.slice(-8)} - content received`);
            state.isThinking = false;
          }
          
          console.log(`📝 [CM-WS] Background chat ${chatId.slice(-8)} streaming chunk:`, {
            chunkLength: data.content.length,
            totalResponse: state.currentResponse.length,
            preview: state.currentResponse.substring(0, 50) + '...'
          });
        }
        break;
        
      case 'complete':
        // ISSUE 4 FIX: Properly handle completion with final response content
        if (data.full_response) {
          state.currentResponse = data.full_response;
          console.log(`🏁 [CM-WS] Background chat ${chatId.slice(-8)} completed with final response: ${state.currentResponse.length} chars`);
        } else if (data.content) {
          state.currentResponse += data.content;
          console.log(`🏁 [CM-WS] Background chat ${chatId.slice(-8)} completed with final chunk: ${state.currentResponse.length} chars total`);
        }
        
        state.status = 'completed';
        state.lastUpdate = Date.now();
        state.isThinking = false; // Clear thinking state on completion
        
        // ISSUE 4 FIX: Don't immediately clear background state - let the UI handle completion
        // Only clear after a reasonable delay to allow UI to show completion
        setTimeout(() => {
          console.log(`🧹 [CM-WS] Delayed clearing of background state for completed chat ${chatId.slice(-8)}`);
          this.clearBackgroundStateForChat(chatId);
        }, 3000); // 3 second delay
        break;
        
      case 'thinking':
        // ISSUE 1 FIX: Properly handle thinking state
        state.isThinking = true;
        if (state.status === 'idle' || state.status === 'pending') {
          state.status = 'processing';
        }
        state.lastUpdate = Date.now();
        console.log(`🧠 [CM-WS] Background chat ${chatId.slice(-8)} is thinking`);
        break;
        
      case 'processing':
        // Backend started processing but not streaming yet
        if (state.status === 'pending') {
          state.status = 'processing';
          state.lastUpdate = Date.now();
          console.log(`⚙️ [CM-WS] Background chat ${chatId.slice(-8)} moved to processing state`);
        }
        break;
        
      case 'error':
        state.status = 'error';
        state.lastUpdate = Date.now();
        state.isThinking = false; // Clear thinking on error
        console.error(`❌ [CM-WS] Background chat error for ${chatId.slice(-8)}:`, data.error);
        break;
    }
    
    this.backgroundChats.set(chatId, state);
    console.log(`🗗️ [CM-STATE] Updated background state for ${chatId.slice(-8)}:`, {
      status: state.status,
      responseLength: state.currentResponse.length,
      isThinking: state.isThinking,
      totalBackgroundChats: this.backgroundChats.size
    });
    
    // Emit update event for UI
    this.emit('background-update', this.chats);
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
      
      // Save background processing states separately
      localStorage.setItem('atlas_background_states', JSON.stringify({
        states: Array.from(this.backgroundChats.entries()),
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
      
      // Load background processing states
      const backgroundData = localStorage.getItem('atlas_background_states');
      if (backgroundData) {
        const parsed = JSON.parse(backgroundData);
        
        // Restore background chat states
        if (parsed.states && Array.isArray(parsed.states)) {
          this.backgroundChats = new Map(parsed.states);
          
          // For any chats that were processing, try to reconnect to their state
          for (const [chatId, state] of this.backgroundChats) {
            if (state.status === 'pending' || 
                state.status === 'processing' || 
                state.status === 'streaming') {
              // Join the chat room to continue receiving updates
              this.wsManager.joinChat(chatId);
            }
          }
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
   * Subscribe to background chat updates
   */
  public subscribeToBackgroundUpdates(callback: (chats: ChatHistoryItem[]) => void): () => void {
    const callbacks = this.listeners.get('background-update') || [];
    callbacks.push(callback);
    this.listeners.set('background-update', callbacks);
    
    return () => {
      const callbacks = this.listeners.get('background-update') || [];
      const updatedCallbacks = callbacks.filter(cb => cb !== callback);
      this.listeners.set('background-update', updatedCallbacks);
    };
  }
  
  /**
   * Start background processing for a chat
   */
  public async startBackgroundChat(chatId: string, messages: unknown[], model: string, options: Record<string, unknown> = {}): Promise<boolean> {
    try {
      if (!this.backgroundProcessingEnabled) {
        console.warn('🚫 [CM-BG] Background processing is disabled');
        return false;
      }
      
      // Check if this chat is already processing in background
      const currentState = this.backgroundChats.get(chatId);
      console.log(`🚀 [CM-BG] Starting background chat for ${chatId.slice(-8)}:`, {
        currentState: currentState?.status || 'none',
        messageCount: Array.isArray(messages) ? messages.length : 0,
        model: model,
        options: Object.keys(options),
        totalBackgroundChats: this.backgroundChats.size
      });
      
      if (currentState && (currentState.status === 'processing' || currentState.status === 'streaming')) {
        console.log(`⚠️ [CM-BG] Chat ${chatId.slice(-8)} is already processing in background (${currentState.status})`);
        return true; // Return true since it's already processing
      }
      
      console.log(`🚀 [CM-BG] Initiating background processing for ${chatId.slice(-8)}`);
      
      // Join chat room via WebSocket for real-time updates
      this.wsManager.joinChat(chatId);
      console.log(`🌐 [CM-BG] Joined WebSocket room for ${chatId.slice(-8)}`);
      
      // Use HTTP request for background processing
      const payload = {
        chat_id: chatId,
        messages: messages,
        model: model,
        background: true,
        ...options
      };
      
      console.log(`📤 [CM-BG] Sending background request for ${chatId.slice(-8)}:`, {
        payloadSize: JSON.stringify(payload).length,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        backgroundFlag: payload.background
      });
      
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      console.log(`📡 [CM-BG] Received response for ${chatId.slice(-8)}:`, {
        status: response.status,
        ok: response.ok
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const result = await response.json();
      console.log(`✅ [CM-BG] Background chat started successfully for ${chatId.slice(-8)}:`, {
        success: result.success,
        resultKeys: Object.keys(result)
      });
      return result.success || false;
      
    } catch (error) {
      console.error(`❌ [CM-BG] Error starting background chat for ${chatId?.slice(-8) || 'unknown'}:`, error);
      return false;
    }
  }
  
  /**
   * Get background processing status for a chat
   */
  public getBackgroundStatus(chatId: string): BackgroundChatState | null {
    const state = this.backgroundChats.get(chatId) || null;
    if (state) {
      console.log(`🔍 [CM-STATUS] Background status for ${chatId.slice(-8)}:`, {
        status: state.status,
        responseLength: state.currentResponse.length,
        lastUpdate: new Date(state.lastUpdate).toISOString(),
        ageMinutes: Math.round((Date.now() - state.lastUpdate) / 60000)
      });
    }
    return state;
  }
  
  /**
   * Get current response from background processing
   */
  public getBackgroundResponse(chatId: string): string {
    const state = this.backgroundChats.get(chatId);
    return state?.currentResponse || '';
  }
  
  /**
   * Get streaming continuation data for a chat
   */
  public getStreamingContinuation(chatId: string): {
    hasPartialResponse: boolean;
    partialResponse: string;
    isStreaming: boolean;
    isPending: boolean;
  } {
    const state = this.backgroundChats.get(chatId);
    return {
      hasPartialResponse: !!(state?.currentResponse),
      partialResponse: state?.currentResponse || '',
      isStreaming: state?.status === 'streaming' || state?.status === 'processing',
      isPending: state?.status === 'pending'
    };
  }
  
  /**
   * Mark a chat as pending when user sends a message
   * This ensures immediate background indication even before backend responds
   */
  public markChatAsPending(chatId: string, clearPreviousResponse = true) {
    const now = Date.now();
    const existingState = this.backgroundChats.get(chatId);
    
    const newState: BackgroundChatState = {
      chatId: chatId,
      status: 'pending',
      currentResponse: clearPreviousResponse ? '' : (existingState?.currentResponse || ''),
      lastUpdate: now,
      messageSentAt: now,
      responseStartedAt: undefined, // Reset response start time
      isThinking: false // Reset thinking state
    };
    
    this.backgroundChats.set(chatId, newState);
    console.log(`📤 [CM-PENDING] Marked ${chatId.slice(-8)} as pending:`, {
      previousStatus: existingState?.status || 'none',
      clearedResponse: clearPreviousResponse,
      totalBackgroundChats: this.backgroundChats.size,
      allBackgroundChatIds: Array.from(this.backgroundChats.keys()).map(id => id.slice(-8))
    });
    
    // Emit update to trigger UI changes immediately
    this.emit('background-update', this.chats);
    this.saveToLocalStorage();
  }

  /**
   * Mark a chat as thinking (for Gemini 2.5 Pro models)
   */
  public markChatAsThinking(chatId: string) {
    const existingState = this.backgroundChats.get(chatId);
    
    const newState: BackgroundChatState = {
      chatId: chatId,
      status: existingState?.status || 'processing',
      currentResponse: existingState?.currentResponse || '',
      lastUpdate: Date.now(),
      messageSentAt: existingState?.messageSentAt,
      responseStartedAt: existingState?.responseStartedAt,
      isThinking: true
    };
    
    this.backgroundChats.set(chatId, newState);
    console.log(`🧠 [CM-THINKING] Marked ${chatId.slice(-8)} as thinking:`, {
      status: newState.status,
      totalBackgroundChats: this.backgroundChats.size
    });
    
    this.emit('background-update', this.chats);
    this.saveToLocalStorage();
  }

  /**
   * Clear thinking state for a chat (when streaming starts)
   */
  public clearThinkingState(chatId: string) {
    const existingState = this.backgroundChats.get(chatId);
    if (existingState && existingState.isThinking) {
      const newState: BackgroundChatState = {
        ...existingState,
        isThinking: false,
        lastUpdate: Date.now()
      };
      
      this.backgroundChats.set(chatId, newState);
      console.log(`🧠 [CM-THINKING] Cleared thinking state for ${chatId.slice(-8)}`);
      
      this.emit('background-update', this.chats);
      this.saveToLocalStorage();
    }
  }

  /**
   * Check if a chat is processing in background (includes pending state)
   */
  public isProcessingInBackground(chatId: string): boolean {
    const state = this.backgroundChats.get(chatId);
    const isProcessing = state?.status === 'pending' || 
                        state?.status === 'processing' || 
                        state?.status === 'streaming';
    console.log(`🔍 [CM-CHECK] Is ${chatId.slice(-8)} processing in background:`, {
      hasState: !!state,
      status: state?.status || 'none',
      isProcessing: isProcessing,
      responseLength: state?.currentResponse?.length || 0
    });
    return isProcessing;
  }
  
  /**
   * Enable or disable background processing
   */
  public setBackgroundProcessingEnabled(enabled: boolean) {
    this.backgroundProcessingEnabled = enabled;
    console.log(`Background processing ${enabled ? 'enabled' : 'disabled'}`);
  }
  
  /**
   * Join a chat room for real-time updates
   */
  public joinChatRoom(chatId: string) {
    // Only attempt WebSocket operations if backend is available
    if (!this.backendAvailable) {
      console.debug('🔌 [ChatManager] Backend not available, skipping chat room join for:', chatId.slice(-8));
      return;
    }
    
    this.wsManager.joinChat(chatId);
  }
  
  /**
   * Leave a chat room
   */
  public leaveChatRoom(chatId: string) {
    // Only attempt WebSocket operations if backend is available
    if (!this.backendAvailable) {
      console.debug('🔌 [ChatManager] Backend not available, skipping chat room leave for:', chatId.slice(-8));
      return;
    }
    
    this.wsManager.leaveChat(chatId);
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
  
  /**
   * Start cleanup interval for performance optimization
   */
  private startCleanupInterval() {
    // Run cleanup every 5 minutes
    this.cleanupInterval = window.setInterval(() => {
      this.cleanupInactiveChats();
    }, 5 * 60 * 1000);
  }
  
  /**
   * Clean up inactive background chats to manage memory
   */
  private cleanupInactiveChats() {
    const now = Date.now();
    const inactiveThreshold = 30 * 60 * 1000; // 30 minutes
    
    // Don't run cleanup too frequently
    if (now - this.lastCleanup < 60000) { // Only cleanup once per minute max
      return;
    }
    
    // Get inactive chats (idle and completed states that are old enough)
    const inactiveChats: string[] = [];
    for (const [chatId, state] of this.backgroundChats) {
      if ((state.status === 'idle' || state.status === 'completed') && 
          (now - state.lastUpdate) > inactiveThreshold) {
        inactiveChats.push(chatId);
      }
    }
    
    // If we have too many background chats, remove the oldest inactive ones
    if (this.backgroundChats.size > this.maxBackgroundChats) {
      const sortedInactive = inactiveChats.sort((a, b) => {
        const stateA = this.backgroundChats.get(a)!;
        const stateB = this.backgroundChats.get(b)!;
        return stateA.lastUpdate - stateB.lastUpdate;
      });
      
      const toRemove = sortedInactive.slice(0, this.backgroundChats.size - this.maxBackgroundChats);
      toRemove.forEach(chatId => {
        this.backgroundChats.delete(chatId);
        this.wsManager.leaveChat(chatId);
        console.log(`Cleaned up inactive background chat: ${chatId}`);
      });
    }
    
    this.lastCleanup = now;
    this.saveToLocalStorage();
  }
  
  /**
   * Clear background state for a specific chat
   */
  public clearBackgroundStateForChat(chatId: string) {
    if (this.backgroundChats.has(chatId)) {
      const state = this.backgroundChats.get(chatId);
      this.backgroundChats.delete(chatId);
      console.log(`🧹 [CM-CLEAR] Cleared background state for ${chatId.slice(-8)}:`, {
        previousStatus: state?.status,
        responseLength: state?.currentResponse?.length || 0,
        remainingBackgroundChats: this.backgroundChats.size,
        remainingChatIds: Array.from(this.backgroundChats.keys()).map(id => id.slice(-8))
      });
      this.emit('background-update', this.chats);
      this.saveToLocalStorage();
    } else {
      console.log(`🧹 [CM-CLEAR] No background state to clear for ${chatId.slice(-8)}`);
    }
  }
  
  /**
   * Force cleanup of all background processing state
   */
  public clearBackgroundState() {
    this.backgroundChats.clear();
    localStorage.removeItem('atlas_background_states');
    console.log('Cleared all background processing state');
  }
  
  /**
   * Mark a chat as background streaming (when switching away from an active stream)
   */
  public markAsBackgroundStreaming(chatId: string) {
    const existingState = this.backgroundChats.get(chatId);
    const newState = {
      chatId: chatId,
      status: 'streaming' as const,
      currentResponse: existingState?.currentResponse || '',
      lastUpdate: Date.now()
    };
    
    this.backgroundChats.set(chatId, newState);
    console.log(`🔄 [CM-MARK] Marked ${chatId.slice(-8)} as background streaming:`, {
      hadExistingState: !!existingState,
      previousStatus: existingState?.status,
      responseLength: newState.currentResponse.length,
      totalBackgroundChats: this.backgroundChats.size,
      allBackgroundChatIds: Array.from(this.backgroundChats.keys()).map(id => id.slice(-8))
    });
    this.emit('background-update', this.chats);
  }
  
  /**
   * Debug: Manually set a background state for testing
   */
  public debugSetBackgroundState(chatId: string) {
    this.backgroundChats.set(chatId, {
      chatId: chatId,
      status: 'streaming',
      currentResponse: 'Test response...',
      lastUpdate: Date.now()
    });
    console.log(`🧪 [ChatManager] DEBUG: Set background state for ${chatId.slice(-8)}`);
    this.emit('background-update', this.chats);
  }
  
  /**
   * Debug: Log comprehensive state of all chats
   */
  public logAllChatStates(context: string = 'DEBUG', activeChatId?: string) {
    // Use provided activeChatId or fall back to internal tracking
    const currentActiveChatId = activeChatId || this.activeChatId;
    const allChatIds = this.chats.map(chat => chat.id);
    const backgroundChatIds = Array.from(this.backgroundChats.keys());
    
    console.log(`\n🔍 [${context}] === CHAT STATES DEBUG ===`);
    console.log(`🔍 [${context}] Active Chat ID: ${currentActiveChatId ? currentActiveChatId.slice(-8) : 'NONE'}`);
    console.log(`🔍 [${context}] Total Chats: ${allChatIds.length}`);
    console.log(`🔍 [${context}] Background Processing Chats: ${backgroundChatIds.length}`);
    console.log(`🔍 [${context}] Backend Available: ${this.backendAvailable}`);
    
    // Log each loaded chat
    this.chats.forEach((chat, index) => {
      const isActive = currentActiveChatId === chat.id;
      const backgroundState = this.getBackgroundStatus(chat.id);
      const isProcessingInBackground = this.isProcessingInBackground(chat.id);
      
      console.log(`🔍 [${context}] Chat ${index + 1}/${this.chats.length}: ${chat.id.slice(-8)} | ${chat.title}`);
      console.log(`    ├─ Active: ${isActive ? '✅ YES' : '❌ No'}`);
      console.log(`    ├─ Background Processing: ${isProcessingInBackground ? '🔄 YES' : '❌ No'}`);
      if (backgroundState) {
        console.log(`    ├─ Background Status: ${backgroundState.status}`);
        console.log(`    ├─ Background Response Length: ${backgroundState.currentResponse.length}`);
        console.log(`    ├─ Background Thinking: ${backgroundState.isThinking ? '🧠 YES' : '❌ No'}`);
        console.log(`    ├─ Last Update: ${new Date(backgroundState.lastUpdate).toLocaleTimeString()}`);
      } else {
        console.log(`    ├─ Background State: None`);
      }
      console.log(`    └─ Model: ${chat.model}`);
    });
    
    // Log background-only chats
    const backgroundOnlyChats = backgroundChatIds.filter(chatId => !allChatIds.includes(chatId));
    if (backgroundOnlyChats.length > 0) {
      console.log(`🔍 [${context}] Background-Only Chats (${backgroundOnlyChats.length}):`);
      backgroundOnlyChats.forEach(chatId => {
        const backgroundState = this.getBackgroundStatus(chatId);
        console.log(`    🔄 ${chatId.slice(-8)}: ${backgroundState?.status} | Response: ${backgroundState?.currentResponse.length} chars${backgroundState?.isThinking ? ' | 🧠 Thinking' : ''}`);
      });
    }
    
    console.log(`🔍 [${context}] === END CHAT STATES DEBUG ===\n`);
  }

  /**
   * Shutdown the ChatManager and clean up resources
   */
  public shutdown() {
    // Clear cleanup interval
    if (this.cleanupInterval !== null) {
      window.clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    // Clear retry timeout
    if (this.retryTimeout !== null) {
      window.clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
    
    // Shutdown WebSocket manager to stop reconnection loops
    if (this.wsManager) {
      this.wsManager.shutdown();
    }
    
    // Clear all background states
    this.clearBackgroundState();
    
    console.log('ChatManager shutdown completed');
  }

  /**
   * Set the currently active chat ID (called from App component)
   */
  public setActiveChatId(chatId: string | null) {
    const previousActiveId = this.activeChatId;
    this.activeChatId = chatId;
    console.log(`🎯 [CM-ACTIVE] Active chat changed:`, {
      previous: previousActiveId?.slice(-8) || 'NONE',
      current: chatId?.slice(-8) || 'NONE'
    });
  }

  /**
   * Get the currently active chat ID
   */
  public getActiveChatId(): string | null {
    return this.activeChatId;
  }
}

// Export the singleton instance
const chatManager = ChatManager.getInstance();

// Debug: Expose to window for testing
if (typeof window !== 'undefined') {
  (window as unknown as { debugChatManager: unknown }).debugChatManager = {
    setBackgroundState: (chatId: string) => chatManager.debugSetBackgroundState(chatId),
    clearBackgroundState: () => chatManager.clearBackgroundState(),
    getBackgroundChats: () => {
      const manager = chatManager as unknown as { backgroundChats: Map<string, BackgroundChatState> };
      return Array.from(manager.backgroundChats.entries());
    },
    getChats: () => chatManager.getChats()
  };
}

export default chatManager;
export type { BackgroundChatState, WebSocketMessage }; 