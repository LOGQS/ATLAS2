export class StringInterner {
  private pool = new Map<string, { refCount: number; value: string }>();

  retain(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const entry = this.pool.get(value);
    if (entry) {
      entry.refCount += 1;
      return entry.value;
    }
    this.pool.set(value, { refCount: 1, value });
    return value;
  }

  release(value: string | null | undefined): void {
    if (typeof value !== 'string') {
      return;
    }
    const entry = this.pool.get(value);
    if (!entry) {
      return;
    }
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      this.pool.delete(value);
    }
  }

  clear(): void {
    this.pool.clear();
  }
}

export const stringInterner = new StringInterner();
