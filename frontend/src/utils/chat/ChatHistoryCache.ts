// status: complete

import type { Message } from '../../types/messages';
import logger from '../core/logger';

interface CacheMetadata {
  lastServerMessageId: string | null;
  lastServerTimestamp: string | null;
  messageCount: number;
  snapshotHash: string;
  cachedAt: number;
  version: number;
}

interface CacheEntry {
  messages: Message[];
  metadata: CacheMetadata;
  status: 'clean-static' | 'dirty' | 'streaming';
}

interface CacheStorage {
  version: string;
  entries: { [key: string]: CacheEntry };
  lastAccessed: { [key: string]: number };
}

class ChatHistoryCache {
  private static STORAGE_KEY = 'atlas_chat_cache_v1';
  private static CACHE_VERSION = '1.0.0';
  private static MAX_CACHED_CHATS = 20;

  private memoryCache = new Map<string, CacheEntry>();
  private versionCounter = new Map<string, number>();
  private storageAvailable: boolean;

  constructor() {
    this.storageAvailable = this.detectStorageAvailability();
    if (this.storageAvailable) {
      this.loadFromStorage();
      this.setupStorageListener();
    }
  }

  private detectStorageAvailability(): boolean {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return false;
      }
      const testKey = `${ChatHistoryCache.STORAGE_KEY}__test__`;
      window.localStorage.setItem(testKey, '1');
      window.localStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }

  private generateHash(messages: Message[]): string {
    const sig = messages.map(m => `${m.id}:${m.content?.length || 0}`).join('|');
    if (sig.length === 0) return 'empty';
    let hash = 0;
    for (let i = 0; i < sig.length; i++) {
      const char = sig.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  private extractMetadata(messages: Message[]): Omit<CacheMetadata, 'cachedAt' | 'version'> {
    const lastMsg = messages[messages.length - 1];
    return {
      lastServerMessageId: lastMsg?.id || null,
      lastServerTimestamp: lastMsg?.timestamp || null,
      messageCount: messages.length,
      snapshotHash: this.generateHash(messages)
    };
  }

  hasClean(chatId: string): boolean {
    const entry = this.memoryCache.get(chatId);
    return !!entry && entry.status === 'clean-static';
  }

  get(chatId: string): CacheEntry | null {
    const entry = this.memoryCache.get(chatId);
    if (!entry) return null;

    if (entry.status !== 'clean-static') {
      logger.debug(`[ChatCache] Cache not clean for ${chatId} (status: ${entry.status})`);
      return null;
    }

    return entry;
  }

  put(chatId: string, messages: Message[], status: 'clean-static' | 'dirty' = 'clean-static'): void {
    const version = (this.versionCounter.get(chatId) || 0) + 1;
    this.versionCounter.set(chatId, version);

    const entry: CacheEntry = {
      messages,
      metadata: {
        ...this.extractMetadata(messages),
        cachedAt: Date.now(),
        version
      },
      status
    };

    this.memoryCache.set(chatId, entry);
    this.enforceStorageLimits();
    this.persistToStorage();

    logger.debug(`[ChatCache] Cached ${messages.length} messages for ${chatId} (status: ${status})`);
  }

  markDirty(chatId: string): void {
    const entry = this.memoryCache.get(chatId);
    if (entry) {
      entry.status = 'dirty';
      entry.metadata.version++;
      this.memoryCache.set(chatId, entry);
      this.persistToStorage();
      logger.debug(`[ChatCache] Marked ${chatId} as dirty`);
    }
  }

  markStreaming(chatId: string): void {
    const entry = this.memoryCache.get(chatId);
    if (entry) {
      entry.status = 'streaming';
      this.memoryCache.set(chatId, entry);
      this.persistToStorage();
      logger.debug(`[ChatCache] Marked ${chatId} as streaming`);
    }
  }

  validateMetadata(chatId: string, freshMessages: Message[]): boolean {
    const cached = this.get(chatId);
    if (!cached) return false;

    const freshMeta = this.extractMetadata(freshMessages);
    const cachedMeta = cached.metadata;

    const isValid = (
      cachedMeta.lastServerMessageId === freshMeta.lastServerMessageId &&
      cachedMeta.messageCount === freshMeta.messageCount &&
      cachedMeta.snapshotHash === freshMeta.snapshotHash
    );

    logger.debug(`[ChatCache] Validation for ${chatId}: ${isValid ? 'valid' : 'invalid'}`);
    if (!isValid) {
      logger.debug(`[ChatCache] Metadata mismatch - lastId: ${cachedMeta.lastServerMessageId} vs ${freshMeta.lastServerMessageId}, count: ${cachedMeta.messageCount} vs ${freshMeta.messageCount}, hash: ${cachedMeta.snapshotHash} vs ${freshMeta.snapshotHash}`);
    }

    return isValid;
  }

  private enforceStorageLimits(): void {
    if (this.memoryCache.size <= ChatHistoryCache.MAX_CACHED_CHATS) return;

    const sorted = Array.from(this.memoryCache.entries())
      .sort((a, b) => a[1].metadata.cachedAt - b[1].metadata.cachedAt);

    while (this.memoryCache.size > ChatHistoryCache.MAX_CACHED_CHATS) {
      const [oldestId] = sorted.shift()!;
      this.memoryCache.delete(oldestId);
      logger.debug(`[ChatCache] Evicted old cache for ${oldestId}`);
    }
  }

  private loadFromStorage(): void {
    try {
      const stored = window.localStorage.getItem(ChatHistoryCache.STORAGE_KEY);
      if (!stored) return;

      const data: CacheStorage = JSON.parse(stored);
      if (data.version !== ChatHistoryCache.CACHE_VERSION) {
        window.localStorage.removeItem(ChatHistoryCache.STORAGE_KEY);
        logger.info(`[ChatCache] Cache version mismatch, clearing cache`);
        return;
      }

      Object.entries(data.entries).forEach(([chatId, entry]) => {
        const typedEntry = entry as CacheEntry;
        this.memoryCache.set(chatId, typedEntry);
        this.versionCounter.set(chatId, typedEntry.metadata.version);
      });

      logger.info(`[ChatCache] Loaded ${this.memoryCache.size} cached chats from storage`);
    } catch (error) {
      logger.error('[ChatCache] Failed to load from storage:', error);
      window.localStorage.removeItem(ChatHistoryCache.STORAGE_KEY);
    }
  }

  private persistToStorage(): void {
    if (!this.storageAvailable) return;

    try {
      const cleanEntries: { [key: string]: CacheEntry } = {};
      Array.from(this.memoryCache.entries()).forEach(([id, entry]) => {
        if (entry.status === 'clean-static') {
          cleanEntries[id] = entry;
        }
      });

      const data: CacheStorage = {
        version: ChatHistoryCache.CACHE_VERSION,
        entries: cleanEntries,
        lastAccessed: {}
      };

      window.localStorage.setItem(ChatHistoryCache.STORAGE_KEY, JSON.stringify(data));
      logger.debug(`[ChatCache] Persisted ${Object.keys(cleanEntries).length} clean entries to storage`);
    } catch (error) {
      logger.error('[ChatCache] Failed to persist to storage:', error);
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        window.localStorage.removeItem(ChatHistoryCache.STORAGE_KEY);
        this.memoryCache.clear();
        this.versionCounter.clear();
        logger.warn('[ChatCache] Storage quota exceeded, cleared cache');
      }
    }
  }

  private setupStorageListener(): void {
    if (typeof window === 'undefined') return;

    window.addEventListener('storage', (event) => {
      if (event.key === ChatHistoryCache.STORAGE_KEY && event.newValue) {
        Array.from(this.memoryCache.entries()).forEach(([chatId, entry]) => {
          entry.status = 'dirty';
        });
        logger.info('[ChatCache] Cache invalidated due to cross-tab update');
      }
    });
  }

  clear(): void {
    this.memoryCache.clear();
    this.versionCounter.clear();
    if (this.storageAvailable && typeof window !== 'undefined') {
      window.localStorage.removeItem(ChatHistoryCache.STORAGE_KEY);
    }
    logger.info('[ChatCache] Cache cleared');
  }
}

export const chatHistoryCache = new ChatHistoryCache();

