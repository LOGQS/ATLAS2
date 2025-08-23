import { apiUrl } from '../config/api';

type State = 'thinking' | 'responding' | 'static';
type Listener = (chatId: string, state: State) => void;

let es: EventSource | null = null;
const listeners = new Set<Listener>();

function ensure() {
  if (es && es.readyState !== EventSource.CLOSED) return;
  
  es = new EventSource(apiUrl('/api/chat/state/stream'));
  es.onmessage = (ev) => {
    try {
      const { chat_id, state } = JSON.parse(ev.data);
      if (chat_id && state) {
        listeners.forEach(fn => fn(chat_id, state));
      }
    } catch {}
  };
  es.onerror = (error) => {
    console.warn('[ChatState] EventSource error, will reconnect in 1s:', error);
    try { es?.close(); } catch {}
    es = null;
    setTimeout(ensure, 1000);
  };
  es.onopen = () => {
    console.info('[ChatState] EventSource connected successfully');
  };
}

function teardown() {
  if (!listeners.size && es) {
    try { es.close(); } catch {}
    es = null;
  }
}

export function subscribe(fn: Listener) {
  listeners.add(fn);
  ensure();
  return () => {
    listeners.delete(fn);
    teardown();
  };
}
