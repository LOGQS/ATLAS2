/**
 * Tests for rate limit browser storage integration.
 */

import React from 'react';
import { render, waitFor, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the API module
jest.mock('../../config/api', () => ({
  apiUrl: (path: string) => `http://localhost:5000${path}`,
}));

// Mock BrowserStorage - create all mocks inline
jest.mock('../../utils/storage/BrowserStorage');

// Import after mocks
import SettingsWindow from '../SettingsWindow';
import { BrowserStorage } from '../../utils/storage/BrowserStorage';

describe('SettingsWindow Rate Limit Storage Integration', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup all BrowserStorage mocks to return empty objects by default
    (BrowserStorage.getRateLimitDrafts as jest.Mock).mockReturnValue({});
    (BrowserStorage.getRateLimitBackendState as jest.Mock).mockReturnValue({});
    (BrowserStorage.getRateLimitUsage as jest.Mock).mockReturnValue({});

    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  const createMockResponse = (overrides = {}) => ({
    global: {
      limits: {
        requests_per_minute: null,
        requests_per_hour: null,
        requests_per_day: null,
        tokens_per_minute: null,
        tokens_per_hour: null,
        tokens_per_day: null,
        burst_size: null,
      },
      overrides: {},
      sources: {
        requests_per_minute: 'default',
        requests_per_hour: 'default',
        requests_per_day: 'default',
        tokens_per_minute: 'default',
        tokens_per_hour: 'default',
        tokens_per_day: 'default',
        burst_size: 'default',
      },
      ...overrides,
    },
    providers: [],
  });

  it('saves usage to browser storage after fetching', async () => {
    const now = Date.now() / 1000;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        global: {
          limits: {},
          overrides: {},
          sources: {},
          usage: {
            requests_per_minute: 5,
            expires_at: {
              requests_minute: now + 30, // Expires 30 seconds from now
            },
          },
        },
        providers: [
          {
            id: 'gemini',
            display_name: 'Gemini',
            limits: {},
            overrides: {},
            sources: {},
            usage: {
              requests_per_minute: 7,
            },
            models: [
              {
                id: 'flash',
                display_name: 'Flash',
                limits: {},
                overrides: {},
                sources: {},
                usage: {
                  requests_per_minute: 3,
                  expires_at: {
                    requests_minute: now + 35, // Expires 35 seconds from now
                  },
                },
              },
            ],
          },
        ],
      }),
    });

    render(<SettingsWindow />);

    // Click on Rate Limits tab
    const rateLimitsTab = await screen.findByText('Rate Limits');
    await userEvent.click(rateLimitsTab);

    await waitFor(() => {
      expect(BrowserStorage.setRateLimitUsage).toHaveBeenCalled();
    });

    const savedData = (BrowserStorage.setRateLimitUsage as jest.Mock).mock.calls[0][0];

    // Verify structure
    expect(savedData.global).toBeDefined();
    expect(savedData.global.requests_per_minute).toBe(5);
    expect(savedData.global.expires_at).toBeDefined();

    expect(savedData.providers).toBeDefined();
    expect(savedData.providers.gemini).toBeDefined();
    expect(savedData.providers.gemini.requests_per_minute).toBe(7);

    expect(savedData.models).toBeDefined();
    expect(savedData.models.gemini).toBeDefined();
    expect(savedData.models.gemini.flash).toBeDefined();
    expect(savedData.models.gemini.flash.requests_per_minute).toBe(3);
  });

  it('saves backend state for coherency checking', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => createMockResponse({
        limits: {
          requests_per_minute: 100,
          requests_per_hour: 6000,
        },
      }),
    });

    render(<SettingsWindow />);

    const rateLimitsTab = await screen.findByText('Rate Limits');
    await userEvent.click(rateLimitsTab);

    await waitFor(() => {
      expect(BrowserStorage.setRateLimitBackendState).toHaveBeenCalled();
    });

    const savedState = (BrowserStorage.setRateLimitBackendState as jest.Mock).mock.calls[0][0];
    expect(savedState.global).toBeDefined();
  });

  it('fetches rate limits on component mount', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => createMockResponse(),
    });

    render(<SettingsWindow />);

    // Should fetch immediately on mount
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:5000/api/rate-limits');
    });
  });

  it('preserves timestamp precision in storage', async () => {
    const preciseExpiration = 1234567950.123456; // Absolute expiration timestamp

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        global: {
          limits: {},
          overrides: {},
          sources: {},
          usage: {
            requests_per_minute: 1,
            expires_at: {
              requests_minute: preciseExpiration,
            },
          },
        },
        providers: [],
      }),
    });

    render(<SettingsWindow />);

    const rateLimitsTab = await screen.findByText('Rate Limits');
    await userEvent.click(rateLimitsTab);

    await waitFor(() => {
      expect(BrowserStorage.setRateLimitUsage).toHaveBeenCalled();
    });

    const savedData = (BrowserStorage.setRateLimitUsage as jest.Mock).mock.calls[0][0];
    expect(savedData.global.expires_at.requests_minute).toBe(preciseExpiration);
  });

  it('handles empty usage data gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        global: {
          limits: {},
          overrides: {},
          sources: {},
        },
        providers: [],
      }),
    });

    render(<SettingsWindow />);

    const rateLimitsTab = await screen.findByText('Rate Limits');
    await userEvent.click(rateLimitsTab);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    // Should still call storage but with empty/undefined usage
    expect(BrowserStorage.setRateLimitUsage).toHaveBeenCalled();
  });

  it('extracts nested provider and model usage correctly', async () => {
    const now = Date.now() / 1000;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        global: {
          limits: {},
          overrides: {},
          sources: {},
        },
        providers: [
          {
            id: 'openai',
            display_name: 'OpenAI',
            limits: {},
            overrides: {},
            sources: {},
            usage: {
              tokens_per_hour: 50000,
            },
            models: [
              {
                id: 'gpt-4',
                display_name: 'GPT-4',
                limits: {},
                overrides: {},
                sources: {},
                usage: {
                  requests_per_minute: 10,
                  tokens_per_minute: 8000,
                  expires_at: {
                    requests_minute: now + 20, // Expires 20 seconds from now
                    tokens_minute: now + 25,   // Expires 25 seconds from now
                  },
                },
              },
              {
                id: 'gpt-3.5',
                display_name: 'GPT-3.5',
                limits: {},
                overrides: {},
                sources: {},
                usage: {
                  requests_per_minute: 20,
                },
              },
            ],
          },
        ],
      }),
    });

    render(<SettingsWindow />);

    const rateLimitsTab = await screen.findByText('Rate Limits');
    await userEvent.click(rateLimitsTab);

    await waitFor(() => {
      expect(BrowserStorage.setRateLimitUsage).toHaveBeenCalled();
    });

    const savedData = (BrowserStorage.setRateLimitUsage as jest.Mock).mock.calls[0][0];

    // Check provider usage
    expect(savedData.providers.openai.tokens_per_hour).toBe(50000);

    // Check model usage
    expect(savedData.models.openai['gpt-4'].requests_per_minute).toBe(10);
    expect(savedData.models.openai['gpt-4'].tokens_per_minute).toBe(8000);
    expect(savedData.models.openai['gpt-3.5'].requests_per_minute).toBe(20);
  });
});
