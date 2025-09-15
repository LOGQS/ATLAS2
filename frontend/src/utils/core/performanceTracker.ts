// Performance tracking utility for monitoring message send timing
import logger from './logger';

interface PerformanceEntry {
  messageId: string;
  chatId: string;
  marks: Map<string, number>;
  startTime: number;
  endTime?: number;
  isComplete: boolean;
}

export interface PerformanceMetrics {
  messageId: string;
  chatId: string;
  totalTime: number;
  phases: {
    name: string;
    duration: number;
    percentage: number;
  }[];
  timestamps: {
    [key: string]: number;
  };
}

type PerformanceListener = (metrics: PerformanceMetrics) => void;

class PerformanceTracker {
  private entries: Map<string, PerformanceEntry> = new Map();
  private activeEntry: string | null = null;
  private listeners: Set<PerformanceListener> = new Set();
  private readonly MAX_ENTRIES = 10;

  readonly MARKS = {
    SEND_INITIATED: 'send_initiated',
    CHAT_CREATED: 'chat_created',
    COMPONENT_MOUNTED: 'component_mounted',
    FIRST_MESSAGE_CHECK: 'first_message_check',
    API_CALL_START: 'api_call_start',
    API_CALL_SENT: 'api_call_sent',
    FIRST_STREAM_EVENT: 'first_stream_event',
    STREAM_THINKING: 'stream_thinking',
    STREAM_RESPONDING: 'stream_responding',
    STREAM_COMPLETE: 'stream_complete',
  } as const;

  startTracking(messageId: string, chatId: string): void {
    const entry: PerformanceEntry = {
      messageId,
      chatId,
      marks: new Map(),
      startTime: performance.now(),
      isComplete: false,
    };

    this.entries.set(messageId, entry);
    this.activeEntry = messageId;

    if (this.entries.size > this.MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey === 'string') {
        this.entries.delete(oldestKey);
      }
    }

    logger.info(`[PERF] Started tracking message: ${messageId} for chat: ${chatId}`);
    this.mark(this.MARKS.SEND_INITIATED, messageId);
  }


  mark(markName: string, identifier: string): void {
    let entry = this.entries.get(identifier);

    if (!entry) {
      this.entries.forEach(e => {
        if (!entry && e.chatId === identifier && !e.isComplete) {
          entry = e;
        }
      });
    }

    if (!entry && markName === this.MARKS.CHAT_CREATED) {
      this.startTracking(identifier, identifier);
      entry = this.entries.get(identifier);
    }

    if (!entry) {
      logger.debug(`[PERF] No entry found for mark ${markName} on ${identifier}`);
      return;
    }

    const timestamp = performance.now();
    entry.marks.set(markName, timestamp);

    logger.info(`[PERF] Mark '${markName}' at ${(timestamp - entry.startTime).toFixed(2)}ms for ${entry.messageId}`);

    if (markName === this.MARKS.STREAM_COMPLETE) {
      entry.endTime = timestamp;
      entry.isComplete = true;
      this.notifyListeners(entry);

      if (this.activeEntry === entry.messageId) {
        this.activeEntry = null;
      }
    } else {
      this.notifyListeners(entry);
    }
  }

  getCurrentMetrics(): PerformanceMetrics | null {
    if (!this.activeEntry) return null;

    const entry = this.entries.get(this.activeEntry);
    if (!entry) return null;

    return this.calculateMetrics(entry);
  }

  getMetrics(messageId: string): PerformanceMetrics | null {
    const entry = this.entries.get(messageId);
    if (!entry) return null;

    return this.calculateMetrics(entry);
  }

  getAllMetrics(): PerformanceMetrics[] {
    return Array.from(this.entries.values()).map(entry => this.calculateMetrics(entry));
  }

  subscribe(listener: PerformanceListener): () => void {
    this.listeners.add(listener);

    const current = this.getCurrentMetrics();
    if (current) {
      listener(current);
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.entries.clear();
    this.activeEntry = null;
    logger.info('[PERF] Cleared all performance tracking data');
  }

  private calculateMetrics(entry: PerformanceEntry): PerformanceMetrics {
    const currentTime = entry.endTime || performance.now();
    const totalTime = currentTime - entry.startTime;

    const phaseDefinitions = [
      { name: 'Input Processing', start: this.MARKS.SEND_INITIATED, end: this.MARKS.CHAT_CREATED },
      { name: 'Chat Creation', start: this.MARKS.CHAT_CREATED, end: this.MARKS.COMPONENT_MOUNTED },
      { name: 'Component Mount', start: this.MARKS.COMPONENT_MOUNTED, end: this.MARKS.API_CALL_START },
      { name: 'Message Prep', start: this.MARKS.API_CALL_START, end: this.MARKS.API_CALL_SENT },
      { name: 'API Response Wait', start: this.MARKS.API_CALL_SENT, end: this.MARKS.FIRST_STREAM_EVENT },
      { name: 'Streaming', start: this.MARKS.FIRST_STREAM_EVENT, end: this.MARKS.STREAM_COMPLETE },
    ];

    const phases = [];

    for (const phase of phaseDefinitions) {
      const startTime = entry.marks.get(phase.start);
      const endTime = entry.marks.get(phase.end);

      if (startTime !== undefined && endTime !== undefined) {
        const duration = endTime - startTime;
        phases.push({
          name: phase.name,
          duration,
          percentage: (duration / totalTime) * 100,
        });
      } else if (startTime !== undefined && phase.end === this.MARKS.STREAM_COMPLETE && !entry.isComplete) {
        const duration = currentTime - startTime;
        phases.push({
          name: phase.name + ' (ongoing)',
          duration,
          percentage: (duration / totalTime) * 100,
        });
      }
    }

    const timestamps: { [key: string]: number } = {};
    entry.marks.forEach((time, mark) => {
      timestamps[mark] = time - entry.startTime;
    });

    return {
      messageId: entry.messageId,
      chatId: entry.chatId,
      totalTime,
      phases,
      timestamps,
    };
  }

  private notifyListeners(entry: PerformanceEntry): void {
    const metrics = this.calculateMetrics(entry);
    this.listeners.forEach(listener => {
      try {
        listener(metrics);
      } catch (error) {
        logger.error('[PERF] Error in listener:', error);
      }
    });
  }

  linkClientId(clientId: string, chatId: string): void {
    let foundKey: string | undefined;
    let foundEntry: PerformanceEntry | undefined;

    this.entries.forEach((entry, key) => {
      if (!foundKey && entry.chatId === chatId && !entry.isComplete) {
        foundKey = key;
        foundEntry = entry;
      }
    });

    if (foundKey && foundEntry) {
      this.entries.delete(foundKey);
      this.entries.set(clientId, foundEntry);
      foundEntry.messageId = clientId;

      if (this.activeEntry === foundKey) {
        this.activeEntry = clientId;
      }

      logger.info(`[PERF] Linked client ID ${clientId} to chat ${chatId}`);
    }
  }
}

export const performanceTracker = new PerformanceTracker();