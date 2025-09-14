// status: complete

let logBuffer: string[] = [];
const MAX_LOG_ENTRIES = 5000;

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
    const allowedPatterns = ['[]'];
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
  
  getLogs: () => logBuffer.slice(),
  
  clearLogs: () => {
    logBuffer = [];
    console.info(`[ATLAS] Log buffer cleared`);
  }
};

(window as any).downloadAtlasLogs = logger.downloadLogs;
(window as any).clearAtlasLogs = logger.clearLogs;

export { sample, compact };

export default logger;