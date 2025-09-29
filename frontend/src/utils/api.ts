import { apiUrl } from '../config/api';

export interface ApiResponse<T = any> {
  data?: T;
  error?: string;
  status: number;
}

export async function apiCall<T = any>(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: any
): Promise<ApiResponse<T>> {
  try {
    const url = apiUrl(endpoint);
    const config: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (body && method !== 'GET') {
      config.body = JSON.stringify(body);
    }

    const response = await fetch(url, config);
    const data = await response.json();

    if (!response.ok) {
      return {
        error: data.error || `HTTP ${response.status}`,
        status: response.status,
      };
    }

    return {
      data,
      status: response.status,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Network error',
      status: 0,
    };
  }
}