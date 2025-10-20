// status: complete

export const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:5000';
export const TERMINAL_API_BASE_URL = process.env.REACT_APP_TERMINAL_API_BASE_URL || 'http://localhost:5051';

console.log('API Base URL:', API_BASE_URL);
console.log('Terminal API Base URL:', TERMINAL_API_BASE_URL);

const joinPath = (base: string, path: string): string => {
  const normalizedBase = base.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
};

export const apiUrl = (path: string): string => joinPath(API_BASE_URL, path);

export const terminalApiUrl = (path: string): string => joinPath(TERMINAL_API_BASE_URL, path);

export const terminalWsUrl = (path: string): string => {
  const httpUrl = joinPath(TERMINAL_API_BASE_URL, path);
  if (httpUrl.startsWith('https://')) {
    return `wss://${httpUrl.slice('https://'.length)}`;
  }
  if (httpUrl.startsWith('http://')) {
    return `ws://${httpUrl.slice('http://'.length)}`;
  }
  return httpUrl;
};
