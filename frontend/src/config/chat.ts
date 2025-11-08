// status: complete

// Default concurrent stream limit (fallback if backend config fetch fails)
// Actual limit is fetched from backend /api/config at runtime
// This ensures frontend matches backend execution mode (async vs multiprocessing)
export const DEFAULT_MAX_CONCURRENT_STREAMS = 3;

export const DEBUG_TOOLS_CONFIG = {
  showTriggerLog: false,

  showPerformanceMonitor: false
};

