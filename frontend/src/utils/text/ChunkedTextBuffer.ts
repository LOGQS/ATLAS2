export class ChunkedTextBuffer {
  private chunks: string[] = [];
  private cachedValue: string | null = '';

  append(text?: string | null): void {
    if (!text) {
      return;
    }
    this.chunks.push(text);
    this.cachedValue = null;
  }

  clear(): void {
    this.chunks = [];
    this.cachedValue = '';
  }

  toString(): string {
    if (this.cachedValue === null) {
      this.cachedValue = this.chunks.join('');
    }
    return this.cachedValue;
  }

  finalize(): string {
    const value = this.toString();
    this.chunks = [];
    this.cachedValue = value;
    return value;
  }

  get length(): number {
    return this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  }
}

export const getBufferText = (buffer: ChunkedTextBuffer | undefined | null): string =>
  buffer ? buffer.toString() : '';
