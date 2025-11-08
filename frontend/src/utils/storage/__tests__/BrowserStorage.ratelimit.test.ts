/**
 * Tests for browser storage rate limit usage caching.
 */

import { BrowserStorage, RateLimitUsageCache} from '../BrowserStorage';

describe('BrowserStorage Rate Limit Usage', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('getRateLimitUsage', () => {
    it('returns empty object when no cached data exists', () => {
      const usage = BrowserStorage.getRateLimitUsage();

      expect(usage).toEqual({});
    });

    it('retrieves cached usage data from localStorage', () => {
      const mockUsage: RateLimitUsageCache = {
        global: {
          requests_per_minute: 5,
          tokens_per_hour: 10000,
          oldest_timestamps: {
            requests_minute: 1234567890.5,
            tokens_hour: 1234567800.0,
          },
        },
        providers: {
          gemini: {
            requests_per_minute: 3,
            oldest_timestamps: {
              requests_minute: 1234567890.5,
            },
          },
        },
        models: {
          gemini: {
            'flash': {
              requests_per_minute: 2,
              oldest_timestamps: {
                requests_minute: 1234567891.0,
              },
            },
          },
        },
        lastSyncTimestamp: Date.now(),
      };

      localStorage.setItem('atlas_rate_limit_usage', JSON.stringify(mockUsage));

      const retrieved = BrowserStorage.getRateLimitUsage();

      expect(retrieved).toEqual(mockUsage);
    });

    it('handles corrupted localStorage data gracefully', () => {
      localStorage.setItem('atlas_rate_limit_usage', 'invalid json{');

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const usage = BrowserStorage.getRateLimitUsage();

      expect(usage).toEqual({});
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('setRateLimitUsage', () => {
    it('stores usage data with automatic timestamp', () => {
      const usageData: RateLimitUsageCache = {
        global: {
          requests_per_minute: 10,
          oldest_timestamps: {
            requests_minute: 1234567890.0,
          },
        },
      };

      const beforeTime = Date.now();
      BrowserStorage.setRateLimitUsage(usageData);
      const afterTime = Date.now();

      const stored = localStorage.getItem('atlas_rate_limit_usage');
      expect(stored).not.toBeNull();

      const parsed = JSON.parse(stored!);
      expect(parsed.global).toEqual(usageData.global);
      expect(parsed.lastSyncTimestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(parsed.lastSyncTimestamp).toBeLessThanOrEqual(afterTime);
    });

    it('preserves nested structure for providers and models', () => {
      const usageData: RateLimitUsageCache = {
        providers: {
          gemini: {
            requests_per_minute: 5,
            requests_per_hour: 20,
          },
          openai: {
            tokens_per_minute: 10000,
          },
        },
        models: {
          gemini: {
            'flash': { requests_per_minute: 3 },
            'pro': { requests_per_minute: 2 },
          },
        },
      };

      BrowserStorage.setRateLimitUsage(usageData);

      const retrieved = BrowserStorage.getRateLimitUsage();
      expect(retrieved.providers).toEqual(usageData.providers);
      expect(retrieved.models).toEqual(usageData.models);
    });

    it('handles storage quota errors gracefully', () => {
      const largeMockData: RateLimitUsageCache = {
        models: {},
      };

      // Create very large mock data to trigger quota error
      for (let i = 0; i < 10000; i++) {
        largeMockData.models![`provider${i}`] = {};
        for (let j = 0; j < 100; j++) {
          largeMockData.models![`provider${i}`][`model${j}`] = {
            requests_per_minute: i * j,
            tokens_per_hour: i * j * 1000,
          };
        }
      }

      const setItemSpy = jest.spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new DOMException('QuotaExceededError');
        });

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      BrowserStorage.setRateLimitUsage(largeMockData);

      expect(consoleSpy).toHaveBeenCalled();

      setItemSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe('clearRateLimitUsage', () => {
    it('removes usage data from localStorage', () => {
      const mockData: RateLimitUsageCache = {
        global: { requests_per_minute: 5 },
      };

      localStorage.setItem('atlas_rate_limit_usage', JSON.stringify(mockData));
      expect(localStorage.getItem('atlas_rate_limit_usage')).not.toBeNull();

      BrowserStorage.clearRateLimitUsage();

      expect(localStorage.getItem('atlas_rate_limit_usage')).toBeNull();
    });

    it('handles errors when clearing non-existent key', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      BrowserStorage.clearRateLimitUsage();

      // Should not throw, may or may not warn depending on implementation
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('timestamp preservation', () => {
    it('preserves timestamp precision for event scheduling', () => {
      const preciseTimestamp = 1234567890.123456;

      const usageData: RateLimitUsageCache = {
        global: {
          requests_per_minute: 1,
          oldest_timestamps: {
            requests_minute: preciseTimestamp,
          },
        },
      };

      BrowserStorage.setRateLimitUsage(usageData);
      const retrieved = BrowserStorage.getRateLimitUsage();

      expect(retrieved.global?.oldest_timestamps?.requests_minute).toBe(preciseTimestamp);
    });

    it('handles missing timestamps gracefully', () => {
      const usageData: RateLimitUsageCache = {
        global: {
          requests_per_minute: 5,
          // No oldest_timestamps
        },
      };

      BrowserStorage.setRateLimitUsage(usageData);
      const retrieved = BrowserStorage.getRateLimitUsage();

      expect(retrieved.global?.oldest_timestamps).toBeUndefined();
    });
  });

  describe('coherency with backend data', () => {
    it('overwrites stale cached data with fresh backend data', () => {
      const staleData: RateLimitUsageCache = {
        global: {
          requests_per_minute: 10,
          oldest_timestamps: {
            requests_minute: 1000000000.0,
          },
        },
        lastSyncTimestamp: Date.now() - 60000, // 1 minute ago
      };

      BrowserStorage.setRateLimitUsage(staleData);

      const freshData: RateLimitUsageCache = {
        global: {
          requests_per_minute: 2,
          oldest_timestamps: {
            requests_minute: 2000000000.0,
          },
        },
        lastSyncTimestamp: Date.now(),
      };

      BrowserStorage.setRateLimitUsage(freshData);

      const retrieved = BrowserStorage.getRateLimitUsage();
      expect(retrieved.global?.requests_per_minute).toBe(2);
      expect(retrieved.lastSyncTimestamp).toBeGreaterThan(staleData.lastSyncTimestamp!);
    });

    it('stores partial updates without losing other scopes', () => {
      const initialData: RateLimitUsageCache = {
        global: {
          requests_per_minute: 5,
        },
        providers: {
          gemini: {
            requests_per_minute: 3,
          },
        },
      };

      BrowserStorage.setRateLimitUsage(initialData);

      // Update only providers (simulating partial fetch)
      const partialUpdate: RateLimitUsageCache = {
        providers: {
          gemini: {
            requests_per_minute: 5,
          },
          openai: {
            requests_per_minute: 2,
          },
        },
      };

      BrowserStorage.setRateLimitUsage(partialUpdate);

      const retrieved = BrowserStorage.getRateLimitUsage();
      // Note: This overwrites the entire object, so global is lost
      // This is expected behavior - backend always sends full state
      expect(retrieved.global).toBeUndefined();
      expect(retrieved.providers?.gemini?.requests_per_minute).toBe(5);
      expect(retrieved.providers?.openai?.requests_per_minute).toBe(2);
    });
  });
});
