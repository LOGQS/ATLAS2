// status: complete

// In-memory log storage
let logBuffer: string[] = [];
const MAX_LOG_ENTRIES = 5000; // Keep last 5000 log entries

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
    console.debug(`[ATLAS]`, message, ...args);
  },
  info: (message: string, ...args: any[]) => {
    // Filter out non-relevant logs for testing
    const suppressedPatterns = [
      '[SCROLL]',
      'Loaded config:',
      '[App.syncActiveChat]',
      'Chat state changed:',
      '[Chat.render]' // Suppressing render logs temporarily
    ];
    
    const shouldSuppress = suppressedPatterns.some(pattern => message.includes(pattern));
    
    if (!shouldSuppress) {
      console.info(`[ATLAS]`, message, ...args);
    }
    addToBuffer('INFO', message, ...args);
  },
  warn: (message: string, ...args: any[]) => {
    addToBuffer('WARN', message, ...args);
    console.warn(`[ATLAS]`, message, ...args);
  },
  error: (message: string, ...args: any[]) => {
    addToBuffer('ERROR', message, ...args);
    console.error(`[ATLAS]`, message, ...args);
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

export default logger;