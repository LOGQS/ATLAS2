// frontend/src/utils/streamReconciler.ts
type Field = 'content' | 'thoughts';

export interface MsgLike {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  thoughts?: string;
  provider?: string;
  model?: string;
  timestamp: string;
  isStreaming?: boolean;
  isStreamingResponse?: boolean;
}

function appendWithOverlap(prev: string, next: string, maxOverlap = 200): string {
  if (!prev) return next || '';
  if (!next) return prev;
  const start = Math.max(0, prev.length - maxOverlap);
  const win = prev.slice(start);
  for (let i = Math.min(win.length, next.length); i > 0; i--) {
    if (win.endsWith(next.slice(0, i))) return prev + next.slice(i);
  }
  return prev + next;
}

type BufferState = {
  msgId: number | null;
  content: string;
  thoughts: string;
};

class StreamReconciler {
  private byChat = new Map<string, BufferState>();

  begin(chatId: string) {
    if (!this.byChat.has(chatId)) {
      this.byChat.set(chatId, { msgId: null, content: '', thoughts: '' });
    }
  }

  clear(chatId: string) {
    this.byChat.delete(chatId);
  }

  setActiveMessage(chatId: string, msgId: number) {
    const s = this.byChat.get(chatId) ?? { msgId: null, content: '', thoughts: '' };
    if (s.msgId !== msgId) {
      // new stream: reset buffers
      this.byChat.set(chatId, { msgId, content: '', thoughts: '' });
    }
  }

  push(chatId: string, field: Field, delta: string) {
    const s = this.byChat.get(chatId);
    if (!s || s.msgId == null) return;
    if (field === 'content') s.content = appendWithOverlap(s.content, delta);
    else s.thoughts = appendWithOverlap(s.thoughts, delta);
  }

  // Merge buffered text into a fresh DB snapshot before rendering.
  // Snapshot must contain the currently-streaming assistant message.
  mergeSnapshot(chatId: string, snapshot: MsgLike[]): MsgLike[] {
    const s = this.byChat.get(chatId);
    if (!s || s.msgId == null) return snapshot;

    // Find last assistant (or exact id match, if present)
    let idx = snapshot.findIndex(m => m.id === s.msgId);
    if (idx < 0) {
      // fallback: last assistant
      for (let i = snapshot.length - 1; i >= 0; i--) {
        if (snapshot[i].role === 'assistant') { idx = i; break; }
      }
    }
    if (idx < 0) return snapshot;

    const snap = snapshot.slice();
    const m = { ...snap[idx] };
    m.content = appendWithOverlap(m.content || '', s.content || '');
    m.thoughts = appendWithOverlap(m.thoughts || '', s.thoughts || '');
    snap[idx] = m;
    return snap;
  }
}

export const streamReconciler = new StreamReconciler();