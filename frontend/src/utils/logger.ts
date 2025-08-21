// status: complete

const logger = {
  debug: (message: string, ...args: any[]) => console.debug(`[ATLAS]`, message, ...args),
  info: (message: string, ...args: any[]) => console.info(`[ATLAS]`, message, ...args),
  warn: (message: string, ...args: any[]) => console.warn(`[ATLAS]`, message, ...args),
  error: (message: string, ...args: any[]) => console.error(`[ATLAS]`, message, ...args)
};

export default logger;