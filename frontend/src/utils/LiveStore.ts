// status: new
import { apiUrl } from '../config/api';
import logger from './logger';

type ChatLive = {
  state: 'thinking' | 'responding' | 'static';
  lastAssistantId: number | null;
  contentBuf: string;
  thoughtsBuf: string;
  version: number;
};

type Listener = (chatId: string, snap: ChatLive) => void;

class LiveStore {
  private es: EventSource | null = null;
  private byChat = new Map<string, ChatLive>();
  private listeners = new Map<string, Set<Listener>>();

  start() {
    if (this.es) return;
    
    logger.info('[LiveStore] Starting global SSE stream');
    this.es = new EventSource(apiUrl('/api/chat/stream/all'));
    
    this.es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        
        // Handle file state events first (they don't have chat_id)
        if (ev.type === 'file_state') {
          logger.info(`[LiveStore] File state event: ${ev.file_id} -> ${ev.api_state}`);
          window.dispatchEvent(new CustomEvent('fileStateUpdate', { 
            detail: { file_id: ev.file_id, api_state: ev.api_state, provider: ev.provider } 
          }));
          return; // Don't process further
        }

        // Handle chat events (require chat_id)
        const chatId = ev.chat_id as string;
        if (!chatId) return;

        const cur = this.byChat.get(chatId) ?? {
          state: 'static', lastAssistantId: null, contentBuf: '', thoughtsBuf: '', version: 0
        };

        let next = { ...cur };

        if (ev.type === 'chat_state') {
          next.state = ev.state || 'static';
          next.version++;
          logger.debug(`[LiveStore] State update for ${chatId}: ${ev.state}`);
        } else if (ev.type === 'thoughts') {
          next.thoughtsBuf = cur.thoughtsBuf + (ev.content || '');
          next.version++;
          logger.debug(`[LiveStore] Thoughts chunk for ${chatId}: +${(ev.content || '').length} chars`);
        } else if (ev.type === 'answer') {
          next.contentBuf = cur.contentBuf + (ev.content || '');
          next.version++;
          logger.debug(`[LiveStore] Content chunk for ${chatId}: +${(ev.content || '').length} chars`);
        } else if (ev.type === 'complete') {
          next.state = 'static';
          next.version++;
          logger.info(`[LiveStore] Stream complete for ${chatId}`);
        }

        this.byChat.set(chatId, next);
        this.emit(chatId, next);
      } catch (err) {
        logger.error('[LiveStore] Failed to process SSE event', err);
      }
    };
    
    this.es.onerror = (e) => {
      logger.warn('[LiveStore] SSE connection error, will reconnect', e);
    };
    
    this.es.onopen = () => {
      logger.info('[LiveStore] SSE connection established');
    };
  }

  subscribe(chatId: string, fn: Listener) {
    if (!this.listeners.has(chatId)) {
      this.listeners.set(chatId, new Set());
    }
    this.listeners.get(chatId)!.add(fn);
    
    const snap = this.byChat.get(chatId);
    if (snap) {
      fn(chatId, snap);
    }
    
    return () => {
      const set = this.listeners.get(chatId);
      if (set) {
        set.delete(fn);
        if (set.size === 0) {
          this.listeners.delete(chatId);
        }
      }
    };
  }

  get(chatId: string): ChatLive | undefined {
    return this.byChat.get(chatId);
  }

  reset(chatId: string) {
    this.byChat.delete(chatId);
    logger.debug(`[LiveStore] Reset state for ${chatId}`);
  }

  private emit(chatId: string, snap: ChatLive) {
    const ls = this.listeners.get(chatId);
    if (!ls) return;
    
    ls.forEach(fn => {
      try {
        fn(chatId, snap);
      } catch (err) {
        logger.error(`[LiveStore] Error in listener for ${chatId}`, err);
      }
    });
  }

  reconcileWithDB(chatId: string, lastAssistantId: number | null, dbContent: string, dbThoughts: string) {
    const cur = this.byChat.get(chatId);
    if (!cur) return;
    
    const next = { ...cur, lastAssistantId };
    
    if (dbContent.length >= cur.contentBuf.length) {
      next.contentBuf = '';
    }
    if (dbThoughts.length >= cur.thoughtsBuf.length) {
      next.thoughtsBuf = '';
    }
    
    next.version++;
    
    this.byChat.set(chatId, next);
    this.emit(chatId, next);
    
    logger.debug(`[LiveStore] Reconciled ${chatId} with DB - lastAid=${lastAssistantId}, cleared buffers`);
  }

  stop() {
    if (this.es) {
      this.es.close();
      this.es = null;
      logger.info('[LiveStore] SSE stream stopped');
    }
  }
}

export const liveStore = new LiveStore();