// status: complete

import { apiUrl } from './api';
import logger from '../utils/core/logger';

export interface ProviderInfo {
  available: boolean;
  fileSizeLimit: number | null;
}

export interface ProvidersResponse {
  providers: Record<string, ProviderInfo>;
  default_provider: string;
}

export interface ProviderLimits {
  [providerName: string]: number | null;
}

export const DEFAULT_PROVIDER_LIMITS: ProviderLimits = {
  gemini: 2 * 1024 * 1024 * 1024, 
  huggingface: null, 
  openrouter: null, 
};

const PROVIDER_LIMITS_CACHE_KEY = 'atlas_provider_limits';

interface CachedProviderData {
  limits: ProviderLimits;
  defaultProvider: string;
}

class ProviderConfig {
  private cachedLimits: ProviderLimits | null = null;
  private defaultProvider: string = 'gemini';
  private fetchPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    this.fetchPromise = this.fetchProviderLimits();
    await this.fetchPromise;
    this.fetchPromise = null;
  }

  private async fetchProviderLimits(): Promise<void> {
    try {
      const cached = this.getCachedLimits();
      if (cached) {
        this.cachedLimits = cached.limits;
        this.defaultProvider = cached.defaultProvider;
        logger.info('[PROVIDERS] Using cached provider limits');
        return;
      }

      logger.info('[PROVIDERS] Fetching provider limits from API');
      const response = await fetch(apiUrl('/api/chat/providers'));

      if (!response.ok) {
        throw new Error(`API response not ok: ${response.status}`);
      }

      const data: ProvidersResponse = await response.json();

      const limits: ProviderLimits = {};
      for (const [providerName, providerInfo] of Object.entries(data.providers)) {
        limits[providerName] = providerInfo.fileSizeLimit;
      }

      this.cachedLimits = limits;
      this.defaultProvider = data.default_provider;

      this.setCachedLimits({
        limits,
        defaultProvider: data.default_provider,
      });

      logger.info('[PROVIDERS] Successfully fetched provider limits:', limits);
    } catch (error) {
      logger.warn('[PROVIDERS] Failed to fetch provider limits, using defaults:', error);
      this.cachedLimits = DEFAULT_PROVIDER_LIMITS;
      this.defaultProvider = 'gemini';
    }
  }

  getProviderFileLimit(providerName: string): number | null {
    const limits = this.cachedLimits || DEFAULT_PROVIDER_LIMITS;
    return limits[providerName] ?? null;
  }

  getDefaultProviderFileLimit(): number | null {
    return this.getProviderFileLimit(this.defaultProvider);
  }

  getDefaultProvider(): string {
    return this.defaultProvider;
  }

  isFileSizeValid(fileSize: number, providerName?: string): boolean {
    const provider = providerName || this.defaultProvider;
    const limit = this.getProviderFileLimit(provider);

    if (limit === null) {
      return true;
    }

    return fileSize <= limit;
  }

  formatFileLimit(providerName: string): string {
    const limit = this.getProviderFileLimit(providerName);

    if (limit === null) {
      return 'No limit';
    }

    const gb = limit / (1024 * 1024 * 1024);
    if (gb >= 1) {
      return `${gb}GB`;
    }

    const mb = limit / (1024 * 1024);
    if (mb >= 1) {
      return `${mb}MB`;
    }

    const kb = limit / 1024;
    return `${kb}KB`;
  }

  private getCachedLimits(): CachedProviderData | null {
    try {
      const cached = localStorage.getItem(PROVIDER_LIMITS_CACHE_KEY);
      if (!cached) return null;

      const data: CachedProviderData = JSON.parse(cached);
      return data;
    } catch (error) {
      logger.warn('[PROVIDERS] Failed to parse cached provider limits:', error);
      localStorage.removeItem(PROVIDER_LIMITS_CACHE_KEY);
      return null;
    }
  }

  private setCachedLimits(data: CachedProviderData): void {
    try {
      localStorage.setItem(PROVIDER_LIMITS_CACHE_KEY, JSON.stringify(data));
    } catch (error) {
      logger.warn('[PROVIDERS] Failed to cache provider limits:', error);
    }
  }

  clearCache(): void {
    localStorage.removeItem(PROVIDER_LIMITS_CACHE_KEY);
    this.cachedLimits = null;
    this.fetchPromise = null;
  }
}

export const providerConfig = new ProviderConfig();

export const getDefaultProviderFileLimit = () => providerConfig.getDefaultProviderFileLimit();
export const isFileSizeValid = (fileSize: number, providerName?: string) =>
  providerConfig.isFileSizeValid(fileSize, providerName);
export const formatFileLimit = (providerName: string) => providerConfig.formatFileLimit(providerName);
export const getDefaultProvider = () => providerConfig.getDefaultProvider();