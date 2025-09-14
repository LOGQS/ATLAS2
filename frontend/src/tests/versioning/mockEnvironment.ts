/**
 * Mock environment for simulating backend responses
 */

import { 
  MockApiConfig, 
  StateSnapshot, 
  ApiCall, 
  VersionInfo,
  MockMessage 
} from './types';

export class MockEnvironment {
  private config: MockApiConfig;
  private state: StateSnapshot;
  private apiCallHistory: ApiCall[] = [];
  private originalFetch: typeof fetch;
  private interceptEnabled: boolean = false;
  private versionCounter: Map<string, number> = new Map();
  private globalChatVersionCounter: Map<string, number> = new Map();
  private allMessages: MockMessage[] = [];
  private streamingChats: Set<string> = new Set();
  private streamingCompleters: Map<string, Array<() => void>> = new Map();

  constructor(config: Partial<MockApiConfig> = {}) {
    this.config = {
      simulateLatency: false,
      latencyRange: [50, 200],
      failureRate: 0,
      streamingDelay: 100,
      interceptFetch: true,
      ...config
    };

    this.state = this.createInitialState();
    this.originalFetch = window.fetch;
  }

  private createInitialState(): StateSnapshot {
    return {
      messages: [],
      versions: {},
      currentChatId: '',
      isStreaming: false,
      sendButtonDisabled: false,
      visibleSwitchers: [],
      activeDropdown: null,
      operationInProgress: null
    };
  }

  /**
   * Initialize the mock environment with a specific state
   */
  public initialize(initialState: Partial<StateSnapshot>): void {
    this.state = { ...this.createInitialState(), ...initialState };
    this.apiCallHistory = [];
    this.versionCounter.clear();
    this.globalChatVersionCounter.clear();
    this.streamingChats.clear();
    this.streamingCompleters.clear();
    // Keep a master copy of all messages to allow non-destructive view switching
    this.allMessages = (this.state.messages || []).map(m => ({ ...m }));
    // Seed per-chat streaming if initial state indicates streaming
    if (this.state.isStreaming && this.state.currentChatId) {
      this.streamingChats.add(this.state.currentChatId);
    }
    
    // Initialize version counters
    Object.keys(this.state.versions).forEach(messageId => {
      const versions = this.state.versions[messageId];
      if (versions.length > 0) {
        const maxVersion = Math.max(...versions.map(v => v.version_number));
        this.versionCounter.set(messageId, maxVersion);
      }
    });

    // Seed global chat version counter from existing versions if provided
    for (const messageId of Object.keys(this.state.versions)) {
      const versions = this.state.versions[messageId];
      for (const v of versions) {
        const baseChatId = v.chat_version_id.split('_v')[0];
        // Default base chat id to at least 1
        if (!this.globalChatVersionCounter.has(baseChatId)) {
          this.globalChatVersionCounter.set(baseChatId, 1);
        }
        const match = v.chat_version_id.match(/_v(\d+)$/);
        if (match) {
          const n = parseInt(match[1], 10);
          const current = this.globalChatVersionCounter.get(baseChatId) || 1;
          if (n > current) this.globalChatVersionCounter.set(baseChatId, n);
        }
      }
    }

    if (this.config.interceptFetch) {
      this.enableInterception();
    }
  }

  /**
   * Enable fetch interception
   */
  public enableInterception(): void {
    if (this.interceptEnabled) return;

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;

      // Record the API call
      const apiCall: ApiCall = {
        method,
        url,
        body,
        timestamp: Date.now()
      };

      // Simulate latency if configured
      if (this.config.simulateLatency) {
        await this.simulateLatency();
      }

      // Check for random failure
      if (Math.random() < this.config.failureRate) {
        apiCall.response = { error: 'Simulated failure' };
        this.apiCallHistory.push(apiCall);
        return new Response(JSON.stringify({ error: 'Simulated failure' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Route to appropriate mock handler
      const response = await this.handleApiCall(url, method, body);
      apiCall.response = response.data;
      // Record API call BEFORE returning to ensure it's available immediately
      this.apiCallHistory.push(apiCall);

      return new Response(JSON.stringify(response.data), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    this.interceptEnabled = true;
  }

  /**
   * Disable fetch interception
   */
  public disableInterception(): void {
    if (!this.interceptEnabled) return;
    window.fetch = this.originalFetch;
    this.interceptEnabled = false;
  }

  /**
   * Handle mock API calls
   */
  private async handleApiCall(url: string, method: string, body?: any): Promise<{ status: number; data: any }> {
    // Message versions endpoint
    if (url.includes('/api/messages/') && url.includes('/versions')) {
      const messageId = url.split('/messages/')[1].split('/versions')[0];
      return this.handleGetVersions(messageId);
    }

    // Versioning notify endpoint
    if (url.includes('/api/db/versioning/notify')) {
      return this.handleVersioningNotify(body);
    }

    // Chat switch endpoint
    if (url.includes('/api/chat/switch')) {
      return this.handleChatSwitch(body);
    }

    // Chat stream endpoint
    if (url.includes('/api/chat/stream')) {
      return this.handleChatStream(body);
    }

    // Chat cancel endpoint
    if (url.includes('/api/chat/cancel')) {
      return this.handleChatCancel(body);
    }

    // Chat delete endpoint
    if (url.includes('/api/db/chat/') && url.includes('/cancel-streaming')) {
      return this.handleCancelStreaming(url);
    }

    // Chat delete endpoint
    if (url.includes('/api/db/chat/') && method === 'DELETE') {
      return this.handleDeleteChat(url);
    }

    // Default response
    return { status: 404, data: { error: 'Not found' } };
  }

  /**
   * Handle get versions request
   */
  private handleGetVersions(messageId: string): { status: number; data: any } {
    const versions = this.state.versions[messageId] || [];
    
    // For assistant messages, check previous user message (retry parent)
    if (versions.length === 0) {
      const parsed = this.parseMessageId(messageId);
      if (parsed && parsed.pos > 1) {
        const prevId = `${parsed.base}_${parsed.pos - 1}`;
        const parentVersions = this.state.versions[prevId];
        if (parentVersions && parentVersions.length > 0) {
          return {
            status: 200,
            data: { 
              versions: parentVersions,
              active_version_number: this.getCurrentVersionNumber(prevId)
            }
          };
        }
      }
    }

    return {
      status: 200,
      data: { 
        versions,
        active_version_number: this.getCurrentVersionNumber(messageId)
      }
    };
  }

  /**
   * Handle versioning notify request
   */
  private handleVersioningNotify(body: any): { status: number; data: any } {
    const { operation_type, message_id, chat_id, new_content } = body;
    
    // Validate empty edit
    if (operation_type === 'edit' && (!new_content || !new_content.trim())) {
      return {
        status: 400,
        data: { error: 'Edit requires newContent in payload' }
      };
    }
    
    // Set operation in progress for the duration of the operation
    this.state.operationInProgress = operation_type;
    
    // Generate new version
    const versionNumber = this.getNextVersionNumber(message_id);
    // Flatten chat version id to baseChatId_vN so versions are coherent across branches
    const baseChatId = chat_id.split('_v')[0];
    let versionChatId: string;
    // Determine if target is an assistant message
    const targetMsg = this.allMessages.find(m => m.id === message_id) || this.state.messages.find(m => m.id === message_id);
    const isAssistantTarget = targetMsg?.role === 'assistant';
    // Version chat rules:
    // - User edit: create new chat version (branch)
    // - Assistant edit: stay in same chat version
    // - Retry (user or assistant): create new chat version
    if (operation_type === 'edit' && isAssistantTarget) {
      versionChatId = chat_id; // do not branch for assistant edit
    } else {
      const globalVersion = this.getNextGlobalChatVersion(baseChatId);
      versionChatId = `${baseChatId}_v${globalVersion}`;
    }
    
    const newVersion: VersionInfo = {
      version_number: versionNumber,
      chat_version_id: versionChatId,
      operation: operation_type,
      created_at: new Date().toISOString(),
      content: new_content || this.getMessageContent(message_id)
    };

    // Add version to state
    if (!this.state.versions[message_id]) {
      // Add original version if this is the first versioning operation
      this.state.versions[message_id] = [{
        version_number: 1,
        chat_version_id: chat_id,
        operation: 'original',
        created_at: new Date(Date.now() - 10000).toISOString(),
        content: this.getMessageContent(message_id)
      }];
    }
    this.state.versions[message_id].push(newVersion);

    // For retry on assistant message, also create versions for the parent user message
    if (operation_type === 'retry') {
      const parsed = this.parseMessageId(message_id);
      if (parsed && parsed.pos % 2 === 0) {
        // Assistant position is even; parent is previous position in base chat
        const parentMessageId = `${parsed.base}_${parsed.pos - 1}`;
        const parentContent = this.getMessageContentFromAll(parentMessageId) || this.getMessageContent(parentMessageId);
        // Create versions for parent user message if not exists
        if (!this.state.versions[parentMessageId]) {
          this.state.versions[parentMessageId] = [{
            version_number: 1,
            chat_version_id: chat_id,
            operation: 'original',
            created_at: new Date(Date.now() - 10000).toISOString(),
            content: parentContent
          }];
        }
        // Add the retry version for the parent user message
        const parentVersionNumber = this.getNextVersionNumber(parentMessageId);
        this.state.versions[parentMessageId].push({
          version_number: parentVersionNumber,
          chat_version_id: versionChatId,
          operation: 'retry',
          created_at: new Date().toISOString(),
          content: parentContent
        });
      }
    }

    // Update messages based on operation
    if (operation_type === 'delete') {
      const index = this.state.messages.findIndex(m => m.id === message_id);
      if (index >= 0) {
        this.state.messages = this.state.messages.slice(0, index);
      }
      const allIdx = this.allMessages.findIndex(m => m.id === message_id);
      if (allIdx >= 0) {
        this.allMessages = this.allMessages.slice(0, allIdx);
      }
    } else if (operation_type === 'edit' && new_content) {
      const index = this.state.messages.findIndex(m => m.id === message_id);
      if (index >= 0) {
        this.state.messages[index] = { ...this.state.messages[index], content: new_content };
        // Remove subsequent messages if editing user message
        if (this.state.messages[index].role === 'user') {
          this.state.messages = this.state.messages.slice(0, index + 1);
        }
      }
      // Do not mutate the full message history on edit; versions control view content
    }

    // Determine if streaming is needed
    const message = this.state.messages.find(m => m.id === message_id);
    // Streaming is needed for:
    // - Any retry (user or assistant) to regenerate a response
    // - Editing a user message (regenerate based on new prompt)
    const needsStreaming = (operation_type === 'retry') ||
                          (operation_type === 'edit' && message?.role === 'user');

    // Schedule clearing operation in progress after a small delay
    // This allows tests to check the state immediately after the operation starts
    setTimeout(() => {
      if (this.state.operationInProgress === operation_type) {
        this.state.operationInProgress = null;
      }
    }, 50);

    return {
      status: 200,
      data: {
        success: true,
        version_chat_id: versionChatId,
        needs_streaming: needsStreaming,
        stream_message: needsStreaming ? new_content || 'Regenerating response...' : undefined,
        target_message_id: message_id,
        attached_file_ids: []
      }
    };
  }

  /**
   * Handle chat switch request
   */
  private handleChatSwitch(body: any): { status: number; data: any } {
    const { chat_id } = body;
    
    // Update current chat ID
    this.state.currentChatId = chat_id;
    
    // Prune messages to reflect the selected chat context
    const baseChatId = chat_id.split('_v')[0];
    // Keep all user messages strictly from base chat (exclude versioned user IDs),
    // and only assistant messages whose ID base exactly matches the selected chat
    const pruned: typeof this.state.messages = [];
    for (const m of this.allMessages) {
      if (m.role === 'user') {
        const parsed = this.parseMessageId(m.id);
        if (parsed && parsed.base === baseChatId) {
          pruned.push({ ...m });
        }
      } else if (m.role === 'assistant') {
        const parsed = this.parseMessageId(m.id);
        if (parsed && parsed.base === chat_id) {
          pruned.push({ ...m });
        }
      }
    }
    this.state.messages = pruned;
    
    // Restore message content for this version after pruning
    this.restoreMessagesForVersion(chat_id);

    // Recompute streaming flags for the active chat
    const isStreamingForActive = this.streamingChats.has(this.state.currentChatId);
    this.state.isStreaming = isStreamingForActive;
    this.state.sendButtonDisabled = isStreamingForActive;
    
    // Close any open dropdown when switching versions
    this.state.activeDropdown = null;
    
    return {
      status: 200,
      data: {
        success: true,
        chat_id,
        messages: this.state.messages
      }
    };
  }

  /**
   * Handle chat stream request
   */
  private handleChatStream(body: any): { status: number; data: any } {
    const { chat_id, message, is_edit_regeneration, is_retry } = body;
    
    // Mark this chat as streaming and reflect state for the currently active chat
    this.streamingChats.add(chat_id);
    const isStreamingForActive = this.streamingChats.has(this.state.currentChatId);
    this.state.isStreaming = isStreamingForActive;
    this.state.sendButtonDisabled = isStreamingForActive;
    
    // Simulate streaming completion after delay
    setTimeout(() => {
      // Streaming complete for chat_id
      this.streamingChats.delete(chat_id);
      const isStreamingForActiveNow = this.streamingChats.has(this.state.currentChatId);
      this.state.isStreaming = isStreamingForActiveNow;
      this.state.sendButtonDisabled = isStreamingForActiveNow;
      
      // Add or replace the single assistant message for this version chat
      if (is_edit_regeneration || is_retry) {
        const prefix = `${chat_id}_`;
        const assistantId = `${chat_id}_2`;
        // Remove any existing assistant messages for this version chat
        this.state.messages = this.state.messages.filter(
          m => !(m.role === 'assistant' && m.id.startsWith(prefix))
        );
        // Append the regenerated assistant as position 2
        this.state.messages.push({
          id: assistantId,
          role: 'assistant',
          content: `Mock response for: ${message}`,
          created_at: new Date().toISOString()
        });

        // Mirror changes into the full message store
        this.allMessages = this.allMessages.filter(
          m => !(m.role === 'assistant' && m.id.startsWith(prefix))
        );
        this.allMessages.push({
          id: assistantId,
          role: 'assistant',
          content: `Mock response for: ${message}`,
          created_at: new Date().toISOString()
        });
      }

      // Resolve any waiters for this chat's streaming completion
      const waiters = this.streamingCompleters.get(chat_id) || [];
      waiters.forEach(resolve => resolve());
      this.streamingCompleters.delete(chat_id);

      // Clear any lingering operation marker once streaming finishes
      if (!this.state.isStreaming) {
        this.state.operationInProgress = null;
      }
    }, this.config.streamingDelay);
    
    return {
      status: 200,
      data: {
        success: true,
        streaming: true
      }
    };
  }

  /**
   * Handle chat cancel request
   */
  private handleChatCancel(body: any): { status: number; data: any } {
    const { chat_id } = body;
    
    // Cancel streaming immediately
    this.state.isStreaming = false;
    this.state.sendButtonDisabled = false;
    
    return {
      status: 200,
      data: {
        success: true,
        chat_id,
        cancelled: true
      }
    };
  }

  /**
   * Handle cancel streaming request for specific chat
   */
  private handleCancelStreaming(url: string): { status: number; data: any } {
    // Extract chat ID from URL
    const match = url.match(/\/chat\/([^/]+)\/cancel-streaming/);
    const chatId = match ? match[1] : '';
    
    // Cancel streaming for this specific chat
    if (this.streamingChats.has(chatId)) {
      this.streamingChats.delete(chatId);
      
      // Complete any pending stream waiters
      const completers = this.streamingCompleters.get(chatId);
      if (completers) {
        completers.forEach(complete => complete());
        this.streamingCompleters.delete(chatId);
      }
    }
    
    // Update state if it's the current chat
    if (this.state.currentChatId === chatId) {
      this.state.isStreaming = false;
      this.state.sendButtonDisabled = false;
    }
    
    return {
      status: 200,
      data: {
        success: true,
        chat_id: chatId,
        cancelled: true
      }
    };
  }

  /**
   * Handle delete chat request
   */
  private handleDeleteChat(url: string): { status: number; data: any } {
    // Extract chat ID from URL
    const match = url.match(/\/chat\/([^/]+)$/);
    const chatId = match ? match[1] : '';
    
    if (!chatId) {
      return {
        status: 400,
        data: { error: 'Chat ID required' }
      };
    }
    
    // Clear state if deleting current chat
    if (this.state.currentChatId === chatId) {
      this.state.messages = [];
      this.state.currentChatId = '';
      this.state.isStreaming = false;
      this.state.sendButtonDisabled = false;
      this.state.operationInProgress = null;
    }
    
    // Remove versions related to this chat
    const keysToDelete: string[] = [];
    for (const messageId of Object.keys(this.state.versions)) {
      if (messageId.startsWith(chatId + '_')) {
        keysToDelete.push(messageId);
      }
    }
    keysToDelete.forEach(key => delete this.state.versions[key]);
    
    // Clean up streaming state
    this.streamingChats.delete(chatId);
    this.streamingCompleters.delete(chatId);
    if (this.state.currentChatId === '') {
      this.state.operationInProgress = null;
    }
    
    return {
      status: 200,
      data: {
        success: true,
        deleted_chat_id: chatId
      }
    };
  }

  private restoreMessagesForVersion(chatId: string): void {
    // Restore original message content based on version
    for (const messageId in this.state.versions) {
      const versions = this.state.versions[messageId];
      const versionForChat = versions.find(v => v.chat_version_id === chatId);
      if (versionForChat && versionForChat.content) {
        const msgIndex = this.state.messages.findIndex(m => m.id === messageId);
        if (msgIndex >= 0) {
          this.state.messages[msgIndex].content = versionForChat.content;
        }
      }
    }
  }

  /**
   * Helper utilities
   */
  private parseMessageId(id: string): { base: string; pos: number } | null {
    if (!id || !id.includes('_')) return null;
    const parts = id.split('_');
    const last = parts.pop();
    if (!last) return null;
    const pos = parseInt(last, 10);
    if (Number.isNaN(pos)) return null;
    return { base: parts.join('_'), pos };
  }

  private getNextVersionNumber(messageId: string): number {
    const current = this.versionCounter.get(messageId) || 1;
    const next = current + 1;
    this.versionCounter.set(messageId, next);
    return next;
  }

  private getNextGlobalChatVersion(baseChatId: string): number {
    const current = this.globalChatVersionCounter.get(baseChatId) || 1;
    const next = current + 1;
    this.globalChatVersionCounter.set(baseChatId, next);
    return next;
  }

  private getCurrentVersionNumber(messageId: string): number {
    const versions = this.state.versions[messageId];
    if (!versions || versions.length === 0) return 1;
    
    // Find version matching current chat
    const currentVersion = versions.find(v => v.chat_version_id === this.state.currentChatId);
    return currentVersion?.version_number || versions[versions.length - 1].version_number;
  }

  private getMessageContent(messageId: string): string {
    const message = this.state.messages.find(m => m.id === messageId);
    return message?.content || '';
  }

  private getMessageContentFromAll(messageId: string): string {
    const message = this.allMessages.find(m => m.id === messageId);
    return message?.content || '';
  }

  private async simulateLatency(): Promise<void> {
    const [min, max] = this.config.latencyRange;
    const delay = Math.random() * (max - min) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Public methods for test control
   */
  public getState(): StateSnapshot {
    return { ...this.state };
  }

  public setState(updates: Partial<StateSnapshot>): void {
    this.state = { ...this.state, ...updates };
  }

  /**
   * Record a new user message into the full message store
   */
  public recordUserMessage(message: MockMessage): void {
    this.allMessages.push({ ...message });
  }

  /**
   * Enhanced state tracking for testing
   */
  public trackOperationStart(operationType: string): void {
    this.state.operationInProgress = operationType;
  }

  public trackOperationEnd(operationType: string): void {
    if (this.state.operationInProgress === operationType) {
      this.state.operationInProgress = null;
    }
  }

  /**
   * Wait for streaming to complete or timeout
   */
  public async waitForStreaming(chatId: string, shouldBeStreaming: boolean = true, timeoutMs: number = 5000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const isStreaming = this.streamingChats.has(chatId);
      if (isStreaming === shouldBeStreaming) {
        // If we're waiting for streaming to stop, wait a bit more to ensure it's truly done
        if (!shouldBeStreaming) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // Timeout reached - force state if needed
    if (!shouldBeStreaming) {
      this.streamingChats.delete(chatId);
      if (this.state.currentChatId === chatId) {
        this.state.isStreaming = false;
      }
    }
  }

  public getApiCallHistory(): ApiCall[] {
    return [...this.apiCallHistory];
  }

  public get lastApiCall(): ApiCall | undefined {
    return this.apiCallHistory[this.apiCallHistory.length - 1];
  }

  public clearApiCallHistory(): void {
    this.apiCallHistory = [];
  }


  public simulateHover(messageId: string | null): void {
    if (messageId) {
      // Only show switcher if versions exist for this message
      const versions = this.state.versions[messageId] || [];
      let hasMultiple = versions.length > 1;

      // Assistant fallback: if assistant has no direct versions, check the previous
      // message in the conversation (the parent user message) rather than relying
      // on ID base matching, since version chat IDs may differ.
      if (!hasMultiple) {
        const msgIndex = this.state.messages.findIndex(m => m.id === messageId);
        const msg = msgIndex >= 0 ? this.state.messages[msgIndex] : undefined;
        if (msg && msg.role === 'assistant' && msgIndex > 0) {
          const parent = this.state.messages[msgIndex - 1];
          if (parent && parent.role === 'user') {
            const parentVersions = this.state.versions[parent.id] || [];
            hasMultiple = parentVersions.length > 1;
          }
        }
      }

      if (hasMultiple) {
        if (!this.state.visibleSwitchers.includes(messageId)) {
          this.state.visibleSwitchers.push(messageId);
        }
      } else {
        // Ensure it's not visible if no versions
        this.state.visibleSwitchers = this.state.visibleSwitchers.filter(id => id !== messageId);
      }
    } else {
      this.state.visibleSwitchers = [];
    }
  }

  public simulateDropdownClick(messageId: string): void {
    if (this.state.activeDropdown === messageId) {
      this.state.activeDropdown = null;
    } else {
      this.state.activeDropdown = messageId;
    }
  }

  public cleanup(): void {
    this.disableInterception();
    this.state = this.createInitialState();
    this.apiCallHistory = [];
    this.versionCounter.clear();
    this.globalChatVersionCounter.clear();
    this.allMessages = [];
  }
}
