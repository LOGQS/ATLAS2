// status: complete

// In-memory log storage
let logBuffer: string[] = [];
const MAX_LOG_ENTRIES = 5000; // Keep last 5000 log entries

// Sampling and compacting helpers
let counters: Record<string, number> = {};
const sample = (key: string, n: number) => ((counters[key] = (counters[key]||0)+1) % n) === 0;

function compact(obj: any, max = 120) {
  try {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch { return String(obj); }
}

const fmtArgs = (...args: any[]) => args.map(a => compact(a, 160));

function addToBuffer(level: string, message: string, ...args: any[]) {
  const timestamp = new Date().toISOString();
  const argsStr = args.length > 0 ? ' ' + args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ') : '';
  
  const logEntry = `${timestamp} | ${level.padEnd(5)} | [ATLAS] | ${message}${argsStr}`;
  
  logBuffer.push(logEntry);
  
  // Keep buffer size manageable
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer = logBuffer.slice(-MAX_LOG_ENTRIES);
  }
}

const logger = {
  debug: (message: string, ...args: any[]) => {
    addToBuffer('DEBUG', message, ...args);
    console.debug(`[ATLAS]`, message, ...fmtArgs(...args));
  },
  info: (message: string, ...args: any[]) => {
    const allowedPatterns = [
      '[STREAM/open]',
      'Stream complete',
      '[STREAM] Completion signal received',
      '[STREAM/catch]',
      '[RESUME/cold-start]',
      '[OWNER/retarget]',
      '[STATE] ', // state transitions only
      '[DIA]', // diagnostic logs
      '[DB-snap]',
      '[DB-merge]',
      '[DB-apply]',
      '[DB-retarget]',
      '[STREAM/drain]',
      '[STREAM/event]',
      '[AUDIT/len]',
      '[CHUNK-apply]',
      '[RESUME-attach]',
      '[RESUME-own]',
      '[CHUNK/prevent-shrink]',
      '[OWNER/already-synced]',
      '[OWNER/retarget-sync-fail]',
      'checkAndResumeStreaming',
      'resumeStream',
      'loadChatHistoryImmediate',
      '[Chat.useEffect1]',
      '[SPINNER]',
      '[App]',
      'Error during async load',
      'Error during same-chat load',
      // Chat flow debugging
      '[Chat] Sending message',
      '[Chat] Message sent successfully',
      '[Chat] Loading history',
      '[Chat] Loaded',
      '[Chat] Empty DB for',
      '[Chat] New chat',
      '[Chat] Cannot send message',
      '[Chat] Finalizing',
      '[Chat] Creating optimistic',
      '[Chat] Current message count',
      '[Chat] Applying overlay',
      '[Chat] Have overlay buffers',
      '[LiveStore]',
      'State update for',
      'Thoughts chunk for',
      'Content chunk for',
      'Stream complete for',
      'File state event',
      'Received SSE file state update',
      '[SPINNER]',
      '[AttachedFiles]',
      'Updated file state',
      'Updated temp file',
      'Reconciled',
      'Reset state for',
    ];
    
    const shouldShow = allowedPatterns.some(pattern => message.includes(pattern));
    
    if (shouldShow) {
      console.info(`[ATLAS]`, message, ...fmtArgs(...args));
    }
    addToBuffer('INFO', message, ...args);
  },
  warn: (message: string, ...args: any[]) => {
    addToBuffer('WARN', message, ...args);
    console.warn(`[ATLAS]`, message, ...fmtArgs(...args));
  },
  error: (message: string, ...args: any[]) => {
    addToBuffer('ERROR', message, ...args);
    console.error(`[ATLAS]`, message, ...fmtArgs(...args));
  },
  
  // Function to download logs as a file
  downloadLogs: () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `atlas-frontend-${timestamp}.log`;
    
    const logContent = logBuffer.join('\n');
    const blob = new Blob([logContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.info(`[ATLAS] Downloaded ${logBuffer.length} log entries to ${filename}`);
  },
  
  // Function to get current log buffer
  getLogs: () => logBuffer.slice(),
  
  // Function to clear log buffer
  clearLogs: () => {
    logBuffer = [];
    console.info(`[ATLAS] Log buffer cleared`);
  }
};

// Add global function for easy access from browser console
(window as any).downloadAtlasLogs = logger.downloadLogs;
(window as any).clearAtlasLogs = logger.clearLogs;

// Export helpers for use in components
export { sample, compact };

export default logger;