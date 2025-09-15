/**
 * Utility functions for Chat component
 */

const SCROLL_EPSILON = 4;

export const computeIsScrollable = (el: HTMLElement | null): boolean => {
  if (!el) return false;
  const diff = el.scrollHeight - el.clientHeight;
  return diff > SCROLL_EPSILON;
};

export class MessageDuplicateChecker {
  private messageCache = new Map<string, number>();
  private readonly windowMs: number;
  private readonly MAX_CACHE_SIZE = 100;

  constructor(windowMs: number = 1000) {
    this.windowMs = windowMs;
  }

  isDuplicate(chatId: string | undefined, content: string): boolean {
    const now = Date.now();
    const cacheKey = `${chatId}:${content}`;

    if (this.messageCache.size > this.MAX_CACHE_SIZE) {
      const toDelete = Math.max(1, this.messageCache.size - this.MAX_CACHE_SIZE / 2);
      const entries = Array.from(this.messageCache.entries())
        .sort((a, b) => a[1] - b[1]);
      entries.slice(0, toDelete).forEach(([key]) => this.messageCache.delete(key));
    }

    const expiredKeys: string[] = [];
    this.messageCache.forEach((timestamp, key) => {
      if (now - timestamp > this.windowMs) {
        expiredKeys.push(key);
      }
    });
    expiredKeys.forEach(key => this.messageCache.delete(key));

    const lastSubmission = this.messageCache.get(cacheKey);
    if (lastSubmission && (now - lastSubmission) <= this.windowMs) {
      return true;
    }

    this.messageCache.set(cacheKey, now);
    return false;
  }

  clear(): void {
    this.messageCache.clear();
  }
}