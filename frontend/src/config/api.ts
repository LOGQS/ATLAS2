// status: complete

export const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:5000';

console.log('API Base URL:', API_BASE_URL);

export const apiUrl = (path: string): string => {
  const base = API_BASE_URL.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
};