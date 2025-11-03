import React, { useCallback, useEffect, useState } from 'react';
import '../styles/sections/SettingsWindow.css';
import { apiUrl } from '../config/api';
import {
  BrowserStorage,
  RateLimitDrafts,
  RateLimitDraftValues,
  RateLimitFieldAlias,
} from '../utils/storage/BrowserStorage';

type RateLimitScope = 'global' | 'provider' | 'model';

type RateLimitField = keyof RateLimitResponseLimits;

type SettingsSection = 'appearance' | 'behavior' | 'rate-limits' | 'storage' | 'advanced';

interface RateLimitResponseLimits {
  requests_per_minute: number | null;
  requests_per_hour: number | null;
  requests_per_day: number | null;
  tokens_per_minute: number | null;
  tokens_per_hour: number | null;
  tokens_per_day: number | null;
  burst_size: number | null;
}

interface RateLimitSources {
  requests_per_minute: string;
  requests_per_hour: string;
  requests_per_day: string;
  tokens_per_minute: string;
  tokens_per_hour: string;
  tokens_per_day: string;
  burst_size: string;
}

interface RateLimitUsage {
  requests_per_minute?: number;
  requests_per_hour?: number;
  requests_per_day?: number;
  tokens_per_minute?: number;
  tokens_per_hour?: number;
  tokens_per_day?: number;
  expires_at?: {
    requests_minute?: number;
    requests_hour?: number;
    requests_day?: number;
    tokens_minute?: number;
    tokens_hour?: number;
    tokens_day?: number;
  };
}

interface RateLimitScopeData {
  limits: RateLimitResponseLimits;
  overrides: RateLimitResponseLimits;
  sources: RateLimitSources;
  usage?: RateLimitUsage;
}

interface RateLimitModel extends RateLimitScopeData {
  id: string;
  display_name: string;
}

interface RateLimitProvider extends RateLimitScopeData {
  id: string;
  display_name: string;
  models: RateLimitModel[];
}

interface RateLimitResponse {
  global: RateLimitScopeData;
  providers: RateLimitProvider[];
}

interface RateLimitStatus {
  type: 'success' | 'error';
  message: string;
}

interface RateLimitFieldConfig {
  alias: RateLimitFieldAlias;
  field: RateLimitField;
  label: string;
  description: string;
}

const RATE_LIMIT_FIELDS: ReadonlyArray<RateLimitFieldConfig> = [
  {
    alias: 'rpm',
    field: 'requests_per_minute',
    label: 'Requests / Minute',
    description: 'Maximum number of requests allowed every minute.',
  },
  {
    alias: 'rph',
    field: 'requests_per_hour',
    label: 'Requests / Hour',
    description: 'Maximum number of requests allowed every hour.',
  },
  {
    alias: 'rpd',
    field: 'requests_per_day',
    label: 'Requests / Day',
    description: 'Maximum number of requests allowed per day.',
  },
  {
    alias: 'tpm',
    field: 'tokens_per_minute',
    label: 'Tokens / Minute',
    description: 'Cumulative token allowance each minute.',
  },
  {
    alias: 'tph',
    field: 'tokens_per_hour',
    label: 'Tokens / Hour',
    description: 'Cumulative token allowance each hour.',
  },
  {
    alias: 'tpd',
    field: 'tokens_per_day',
    label: 'Tokens / Day',
    description: 'Cumulative token allowance across a full day.',
  },
];

interface RateLimitFieldState {
  alias: RateLimitFieldAlias;
  label: string;
  description: string;
  value: string;
  placeholder: string;
  overrideValue: string;
  source: string;
  isReadOnly: boolean;
}

interface RateLimitCardProps {
  title: string;
  subtitle?: string;
  scope: RateLimitScope;
  fields: ReadonlyArray<RateLimitFieldState>;
  hasChanges: boolean;
  canReset: boolean;
  saving: boolean;
  status?: RateLimitStatus;
  onChange: (alias: RateLimitFieldAlias, value: string) => void;
  onSave: () => void;
  onReset: () => void;
  children?: React.ReactNode;
  collapsible?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  usage?: RateLimitUsage;
}

const RateLimitCard: React.FC<RateLimitCardProps> = ({
  title,
  subtitle,
  scope,
  fields,
  hasChanges,
  canReset,
  saving,
  status,
  onChange,
  onSave,
  onReset,
  children,
  collapsible = false,
  isExpanded = true,
  onToggleExpand,
  usage,
}) => {
  const handleHeaderClick = () => {
    if (collapsible && onToggleExpand) {
      onToggleExpand();
    }
  };

  return (
    <div className={`rate-limit-card rate-limit-card-${scope}`}>
      <div
        className={`rate-limit-card-header ${collapsible ? 'collapsible' : ''}`}
        onClick={collapsible ? handleHeaderClick : undefined}
      >
        <div className="rate-limit-card-title">
          {collapsible && (
            <span className={`rate-limit-card-chevron ${isExpanded ? 'expanded' : ''}`}>
              ▶
            </span>
          )}
          <div>
            <h6>{title}</h6>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
        </div>
        {isExpanded && (
          <div className="rate-limit-card-actions">
            <button
              className="section-button primary"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSave();
              }}
              disabled={!hasChanges || saving}
            >
              {saving ? 'Saving�' : 'Save'}
            </button>
            <button
              className="section-button secondary"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReset();
              }}
              disabled={!canReset || saving}
            >
              Reset
            </button>
          </div>
        )}
      </div>
      {isExpanded && (
        <>
          <div className="rate-limit-fields">
            {fields.map((field) => {
              // Map alias to usage field name (numeric fields only)
              type NumericUsageField = Exclude<keyof RateLimitUsage, 'oldest_timestamps'>;
              const aliasToUsageField: Record<string, NumericUsageField> = {
                rpm: 'requests_per_minute',
                rph: 'requests_per_hour',
                rpd: 'requests_per_day',
                tpm: 'tokens_per_minute',
                tph: 'tokens_per_hour',
                tpd: 'tokens_per_day',
              };
              const usageField = aliasToUsageField[field.alias];
              const usageValue = usage && usageField ? usage[usageField] : undefined;
              const currentUsage = (typeof usageValue === 'number' ? usageValue : 0) || 0;
              const limitValue = Number(field.placeholder) || null;
              const percentage = getUsagePercentage(currentUsage, limitValue);
              const progressClass = getProgressBarClass(percentage);

              return (
                <label key={field.alias} className="rate-limit-field">
                  <span className="rate-limit-field-label">
                    {field.label}
                    {field.source && (
                      <span
                        className={`rate-limit-source-badge rate-limit-source-${field.source}`}
                        title={
                          field.source === 'env'
                            ? 'Value from .env file (highest priority, cannot be overridden)'
                            : field.source === 'file'
                            ? 'Value from rate_limits.json (persisted override)'
                            : 'Default value (lowest priority)'
                        }
                      >
                        {field.source === 'env' ? '.env' : field.source === 'file' ? 'file' : 'default'}
                      </span>
                    )}
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={field.value}
                    placeholder={field.placeholder || 'Default'}
                    onChange={(event) => onChange(field.alias, event.target.value)}
                    disabled={field.isReadOnly}
                    title={field.isReadOnly ? 'This value is set in .env and cannot be overridden' : ''}
                  />
                  {limitValue !== null && limitValue > 0 && (
                    <div className="rate-limit-progress-container">
                      <div className="rate-limit-usage-label">
                        <span>{currentUsage} used</span>
                        <span>{percentage.toFixed(1)}%</span>
                      </div>
                      <div className="rate-limit-progress-bar">
                        <div
                          className={`rate-limit-progress-fill ${progressClass}`}
                          style={{ width: `${percentage}%` }}
                          title={`${currentUsage} / ${limitValue} (${percentage.toFixed(1)}%)`}
                        />
                      </div>
                    </div>
                  )}
                  <span className="rate-limit-field-description">{field.description}</span>
                </label>
              );
            })}
          </div>
          {status ? (
            <div className={`rate-limit-status rate-limit-status-${status.type}`}>
              {status.message}
            </div>
          ) : null}
          {children}
        </>
      )}
    </div>
  );
};

function toAliasStringsFromLimits(limits: RateLimitResponseLimits): Record<RateLimitFieldAlias, string> {
  const result = {} as Record<RateLimitFieldAlias, string>;
  RATE_LIMIT_FIELDS.forEach(({ alias, field }) => {
    const value = limits[field];
    result[alias] = value === null || value === undefined ? '' : String(value);
  });
  return result;
}

function toAliasStringsFromOverrides(overrides: RateLimitResponseLimits): RateLimitDraftValues {
  const result: RateLimitDraftValues = {};
  RATE_LIMIT_FIELDS.forEach(({ alias, field }) => {
    const value = overrides[field];
    if (value !== null && value !== undefined) {
      result[alias] = String(value);
    }
  });
  return result;
}

function cloneRateLimitDrafts(source: RateLimitDrafts): RateLimitDrafts {
  return {
    global: source.global ? { ...source.global } : undefined,
    providers: source.providers
      ? Object.fromEntries(
          Object.entries(source.providers).map(([provider, values]) => [provider, { ...values }]),
        )
      : undefined,
    models: source.models
      ? Object.fromEntries(
          Object.entries(source.models).map(([provider, models]) => [
            provider,
            Object.fromEntries(
              Object.entries(models).map(([model, values]) => [model, { ...values }]),
            ),
          ]),
        )
      : undefined,
  };
}

function setDraftValueMutable(
  drafts: RateLimitDrafts,
  scope: RateLimitScope,
  provider: string | undefined,
  model: string | undefined,
  field: RateLimitFieldAlias,
  value: string | undefined,
): void {
  if (scope === 'global') {
    const entry = { ...(drafts.global ?? {}) };
    if (value === undefined) {
      delete entry[field];
    } else {
      entry[field] = value;
    }
    drafts.global = Object.keys(entry).length ? entry : undefined;
    return;
  }

  if (scope === 'provider' && provider) {
    const providers = drafts.providers ? { ...drafts.providers } : {};
    const entry = { ...(providers[provider] ?? {}) };
    if (value === undefined) {
      delete entry[field];
    } else {
      entry[field] = value;
    }
    if (Object.keys(entry).length) {
      providers[provider] = entry;
      drafts.providers = providers;
    } else {
      delete providers[provider];
      drafts.providers = Object.keys(providers).length ? providers : undefined;
    }
    return;
  }

  if (scope === 'model' && provider && model) {
    const modelsByProvider = drafts.models ? { ...drafts.models } : {};
    const providerModels = modelsByProvider[provider]
      ? { ...modelsByProvider[provider] }
      : {};
    const entry = { ...(providerModels[model] ?? {}) };
    if (value === undefined) {
      delete entry[field];
    } else {
      entry[field] = value;
    }
    if (Object.keys(entry).length) {
      providerModels[model] = entry;
      modelsByProvider[provider] = providerModels;
      drafts.models = modelsByProvider;
    } else {
      delete providerModels[model];
      if (Object.keys(providerModels).length) {
        modelsByProvider[provider] = providerModels;
        drafts.models = modelsByProvider;
      } else {
        delete modelsByProvider[provider];
        drafts.models = Object.keys(modelsByProvider).length ? modelsByProvider : undefined;
      }
    }
  }
}

function clearDraftEntryMutable(
  drafts: RateLimitDrafts,
  scope: RateLimitScope,
  provider: string | undefined,
  model: string | undefined,
): void {
  if (scope === 'global') {
    drafts.global = undefined;
    return;
  }
  if (scope === 'provider' && provider && drafts.providers) {
    const providers = { ...drafts.providers };
    delete providers[provider];
    drafts.providers = Object.keys(providers).length ? providers : undefined;
    return;
  }
  if (scope === 'model' && provider && model && drafts.models) {
    const modelsByProvider = { ...drafts.models };
    const providerModels = modelsByProvider[provider]
      ? { ...modelsByProvider[provider] }
      : undefined;
    if (!providerModels) {
      return;
    }
    delete providerModels[model];
    if (Object.keys(providerModels).length) {
      modelsByProvider[provider] = providerModels;
      drafts.models = modelsByProvider;
    } else {
      delete modelsByProvider[provider];
      drafts.models = Object.keys(modelsByProvider).length ? modelsByProvider : undefined;
    }
  }
}

function getDraftEntry(
  drafts: RateLimitDrafts,
  scope: RateLimitScope,
  provider: string | undefined,
  model: string | undefined,
): RateLimitDraftValues | undefined {
  if (scope === 'global') {
    return drafts.global;
  }
  if (scope === 'provider' && provider) {
    return drafts.providers?.[provider];
  }
  if (scope === 'model' && provider && model) {
    return drafts.models?.[provider]?.[model];
  }
  return undefined;
}

function hasAnyDraftValues(draft?: RateLimitDraftValues): boolean {
  if (!draft) {
    return false;
  }
  return Object.values(draft).some((value) => value !== undefined);
}

function getUsagePercentage(current: number, limit: number | null): number {
  if (!limit || limit <= 0) {
    return 0;
  }
  return Math.min((current / limit) * 100, 100);
}

function getProgressBarClass(percentage: number): string {
  if (percentage >= 90) {
    return 'high';
  }
  if (percentage >= 70) {
    return 'medium';
  }
  return 'low';
}

function getEntryKey(scope: RateLimitScope, provider?: string, model?: string): string {
  if (scope === 'global') {
    return 'global';
  }
  if (scope === 'provider') {
    return `provider:${provider ?? ''}`;
  }
  return `model:${provider ?? ''}:${model ?? ''}`;
}

function buildPayloadFromAlias(values: RateLimitDraftValues): Record<string, number | null> {
  const payload: Record<string, number | null> = {};
  RATE_LIMIT_FIELDS.forEach(({ alias, field }) => {
    if (!Object.prototype.hasOwnProperty.call(values, alias)) {
      return;
    }
    const rawValue = values[alias];
    if (rawValue === undefined) {
      return;
    }
    if (rawValue === '') {
      payload[field] = null;
      return;
    }
    const numeric = Number(rawValue);
    payload[field] = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
  });
  return payload;
}

const SettingsWindow: React.FC = () => {
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance');
  const [expandedGlobal, setExpandedGlobal] = useState(true);
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});

  const [theme, setTheme] = useState('dark');
  const [autoSave, setAutoSave] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [language, setLanguage] = useState('en');
  const [storageLimit] = useState(80);

  const [rateLimitData, setRateLimitData] = useState<RateLimitResponse | null>(null);
  const [rateLimitDrafts, setRateLimitDrafts] = useState<RateLimitDrafts>(
    BrowserStorage.getRateLimitDrafts(),
  );
  const [rateLimitLoading, setRateLimitLoading] = useState(false);
  const [rateLimitError, setRateLimitError] = useState<string | null>(null);
  const [savingKeys, setSavingKeys] = useState<Record<string, boolean>>({});
  const [statusMap, setStatusMap] = useState<Record<string, RateLimitStatus | undefined>>({});

  const fetchRateLimits = useCallback(async () => {
    setRateLimitLoading(true);
    setRateLimitError(null);
    try {
      const response = await fetch(apiUrl('/api/rate-limits'));
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      const data: RateLimitResponse = await response.json();
      setRateLimitData(data);

      // Save backend state to browser storage for comparison
      BrowserStorage.setRateLimitBackendState({
        global: data.global.limits,
      });

      // Extract and save usage data to browser storage (JSON is source of truth)
      const usageCache: import('../utils/storage/BrowserStorage').RateLimitUsageCache = {
        global: data.global.usage,
        providers: {},
        models: {},
      };

      for (const provider of data.providers) {
        if (provider.usage) {
          usageCache.providers![provider.id] = provider.usage;
        }
        for (const model of provider.models) {
          if (model.usage) {
            if (!usageCache.models![provider.id]) {
              usageCache.models![provider.id] = {};
            }
            usageCache.models![provider.id][model.id] = model.usage;
          }
        }
      }

      BrowserStorage.setRateLimitUsage(usageCache);
    } catch (error) {
      console.error('Failed to fetch rate limits:', error);
      setRateLimitError(
        error instanceof Error ? error.message : 'Failed to load rate limit configuration.',
      );
    } finally {
      setRateLimitLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch immediately on mount - backend reads from JSON file (source of truth)
    // Backend data is then saved to browser storage for future caching
    fetchRateLimits();
  }, [fetchRateLimits]);

  // Event-driven timer: Find next expiration and schedule refresh
  useEffect(() => {
    if (activeSection !== 'rate-limits' || !rateLimitData) {
      return;
    }

    // Find the earliest upcoming expiration across all scopes
    const now = Date.now() / 1000; // Convert to seconds
    let nextExpiration: number | null = null;

    const checkUsageExpirations = (usage?: RateLimitUsage) => {
      if (!usage?.expires_at) return;

      // Check all expiration timestamps directly (no calculation needed)
      const expirationKeys = [
        'requests_minute',
        'requests_hour',
        'requests_day',
        'tokens_minute',
        'tokens_hour',
        'tokens_day',
      ] as const;

      for (const key of expirationKeys) {
        const expiresAt = usage.expires_at[key];
        if (expiresAt !== undefined && expiresAt !== null && expiresAt > now) {
          if (nextExpiration === null || expiresAt < nextExpiration) {
            nextExpiration = expiresAt;
          }
        }
      }
    };

    // Check global usage
    checkUsageExpirations(rateLimitData.global.usage);

    // Check provider and model usage
    for (const provider of rateLimitData.providers) {
      checkUsageExpirations(provider.usage);
      for (const model of provider.models) {
        checkUsageExpirations(model.usage);
      }
    }

    // If we found an upcoming expiration, set timer for it
    if (nextExpiration !== null) {
      const msUntilExpiration = Math.max(0, (nextExpiration - now) * 1000);
      const timerId = window.setTimeout(() => {
        fetchRateLimits(); // Refetch when entry expires
      }, msUntilExpiration);

      return () => window.clearTimeout(timerId);
    }
  }, [rateLimitData, activeSection, fetchRateLimits]);

  const updateDraftStorage = useCallback((updater: (current: RateLimitDrafts) => RateLimitDrafts) => {
    setRateLimitDrafts((previous) => {
      const nextDrafts = updater(previous);
      if (
        !nextDrafts.global &&
        (!nextDrafts.providers || Object.keys(nextDrafts.providers).length === 0) &&
        (!nextDrafts.models || Object.keys(nextDrafts.models).length === 0)
      ) {
        BrowserStorage.clearRateLimitDrafts();
      } else {
        BrowserStorage.setRateLimitDrafts(nextDrafts);
      }
      return nextDrafts;
    });
  }, []);

  const clearDraftEntry = useCallback(
    (scope: RateLimitScope, provider?: string, model?: string) => {
      updateDraftStorage((prev) => {
        const next = cloneRateLimitDrafts(prev);
        clearDraftEntryMutable(next, scope, provider, model);
        return next;
      });
    },
    [updateDraftStorage],
  );

  const handleDraftChange = useCallback(
    (
      scope: RateLimitScope,
      provider: string | undefined,
      model: string | undefined,
      field: RateLimitFieldAlias,
      value: string,
      overrideValue: string,
    ) => {
      const key = getEntryKey(scope, provider, model);
      setStatusMap((prev) => {
        if (!prev[key]) {
          return prev;
        }
        const next = { ...prev };
        delete next[key];
        return next;
      });

      const normalized = value === '' ? '' : value;
      const effectiveOverride = overrideValue ?? '';
      const valueToStore = normalized === effectiveOverride ? undefined : normalized;

      updateDraftStorage((prev) => {
        const next = cloneRateLimitDrafts(prev);
        setDraftValueMutable(next, scope, provider, model, field, valueToStore);
        return next;
      });
    },
    [updateDraftStorage],
  );

  const handleSave = useCallback(
    async (
      scope: RateLimitScope,
      provider: string | undefined,
      model: string | undefined,
      mergedValues: RateLimitDraftValues,
    ) => {
      const key = getEntryKey(scope, provider, model);
      setSavingKeys((prev) => ({ ...prev, [key]: true }));
      setStatusMap((prev) => {
        if (!prev[key]) {
          return prev;
        }
        const next = { ...prev };
        delete next[key];
        return next;
      });

      try {
        const payload = buildPayloadFromAlias(mergedValues);
        if (Object.keys(payload).length === 0) {
          setStatusMap((prev) => ({
            ...prev,
            [key]: { type: 'error', message: 'No changes to save.' },
          }));
        } else {
          const response = await fetch(apiUrl('/api/rate-limits'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope, provider, model, limits: payload }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || (body && body.success === false)) {
            throw new Error(body?.error || `Request failed with status ${response.status}`);
          }

          clearDraftEntry(scope, provider, model);
          setStatusMap((prev) => ({
            ...prev,
            [key]: { type: 'success', message: 'Saved.' },
          }));
          await fetchRateLimits();
        }
      } catch (error) {
        setStatusMap((prev) => ({
          ...prev,
          [key]: {
            type: 'error',
            message: error instanceof Error ? error.message : 'Failed to update rate limits.',
          },
        }));
      } finally {
        setSavingKeys((prev) => ({ ...prev, [key]: false }));
      }
    },
    [clearDraftEntry, fetchRateLimits],
  );

  const handleReset = useCallback(
    async (
      scope: RateLimitScope,
      provider: string | undefined,
      model: string | undefined,
      hasOverrides: boolean,
    ) => {
      const key = getEntryKey(scope, provider, model);
      setStatusMap((prev) => {
        if (!prev[key]) {
          return prev;
        }
        const next = { ...prev };
        delete next[key];
        return next;
      });

      if (!hasOverrides) {
        clearDraftEntry(scope, provider, model);
        return;
      }

      setSavingKeys((prev) => ({ ...prev, [key]: true }));
      try {
        const response = await fetch(apiUrl('/api/rate-limits'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope, provider, model, limits: {} }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || (body && body.success === false)) {
          throw new Error(body?.error || `Request failed with status ${response.status}`);
        }

        clearDraftEntry(scope, provider, model);
        setStatusMap((prev) => ({
          ...prev,
          [key]: { type: 'success', message: 'Reset to defaults.' },
        }));
        await fetchRateLimits();
      } catch (error) {
        setStatusMap((prev) => ({
          ...prev,
          [key]: {
            type: 'error',
            message: error instanceof Error ? error.message : 'Failed to reset rate limits.',
          },
        }));
      } finally {
        setSavingKeys((prev) => ({ ...prev, [key]: false }));
      }
    },
    [clearDraftEntry, fetchRateLimits],
  );

  const toggleGlobal = useCallback(() => {
    setExpandedGlobal((prev) => !prev);
  }, []);

  const toggleProvider = useCallback((providerId: string) => {
    setExpandedProviders((prev) => ({
      ...prev,
      [providerId]: !prev[providerId],
    }));
  }, []);

  const renderRateLimitCard = (
    scope: RateLimitScope,
    title: string,
    data: RateLimitScopeData,
    providerId?: string,
    modelId?: string,
    subtitle?: string,
    childContent?: React.ReactNode,
    collapsible?: boolean,
    isExpanded?: boolean,
    onToggleExpand?: () => void,
  ) => {
    const overrideAlias = toAliasStringsFromOverrides(data.overrides);
    const effectiveAlias = toAliasStringsFromLimits(data.limits);
    const draftEntry = getDraftEntry(rateLimitDrafts, scope, providerId, modelId);

    const mergedAlias: RateLimitDraftValues = { ...overrideAlias };
    if (draftEntry) {
      RATE_LIMIT_FIELDS.forEach(({ alias }) => {
        if (Object.prototype.hasOwnProperty.call(draftEntry, alias)) {
          const draftValue = draftEntry[alias];
          if (draftValue === undefined) {
            delete mergedAlias[alias];
          } else {
            mergedAlias[alias] = draftValue;
          }
        }
      });
    }

    const fields: RateLimitFieldState[] = RATE_LIMIT_FIELDS.map(({ alias, field, label, description }) => {
      const overrideValue = overrideAlias[alias] ?? '';
      let value = overrideValue;
      if (draftEntry && Object.prototype.hasOwnProperty.call(draftEntry, alias)) {
        const draftValue = draftEntry[alias];
        value = draftValue ?? '';
      }
      const fieldSource = data.sources?.[field] || 'default';
      const isReadOnly = fieldSource === 'env';
      return {
        alias,
        label,
        description,
        value,
        placeholder: effectiveAlias[alias] ?? '',
        overrideValue,
        source: fieldSource,
        isReadOnly,
      };
    });

    const hasChanges = RATE_LIMIT_FIELDS.some(
      ({ alias }) => (mergedAlias[alias] ?? '') !== (overrideAlias[alias] ?? ''),
    );
    const hasOverrides = Object.keys(overrideAlias).length > 0;
    const canReset = hasOverrides || hasAnyDraftValues(draftEntry);
    const key = getEntryKey(scope, providerId, modelId);
    const saving = !!savingKeys[key];
    const status = statusMap[key];

    const handleFieldChange = (fieldAlias: RateLimitFieldAlias, newValue: string) => {
      const overrideValue = overrideAlias[fieldAlias] ?? '';
      handleDraftChange(scope, providerId, modelId, fieldAlias, newValue, overrideValue);
    };

    const saveValues: RateLimitDraftValues = { ...mergedAlias };

    const onSave = () => handleSave(scope, providerId, modelId, saveValues);
    const onReset = () => handleReset(scope, providerId, modelId, hasOverrides);

    return (
      <RateLimitCard
        key={key}
        title={title}
        subtitle={subtitle}
        scope={scope}
        fields={fields}
        hasChanges={hasChanges}
        canReset={canReset}
        saving={saving}
        status={status}
        onChange={handleFieldChange}
        onSave={onSave}
        onReset={onReset}
        collapsible={collapsible}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        usage={data.usage}
      >
        {childContent}
      </RateLimitCard>
    );
  };

  const sections: { id: SettingsSection; label: string }[] = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'behavior', label: 'Behavior' },
    { id: 'rate-limits', label: 'Rate Limits' },
    { id: 'storage', label: 'Storage' },
    { id: 'advanced', label: 'Advanced' },
  ];

  return (
    <div className="section-content">
      <div className="section-header">
        <h4>Settings</h4>
      </div>
      <div className="settings-tabs">
        {sections.map((section) => (
          <button
            key={section.id}
            className={`settings-tab ${activeSection === section.id ? 'active' : ''}`}
            onClick={() => setActiveSection(section.id)}
          >
            {section.label}
          </button>
        ))}
      </div>
      <div className="section-body settings-body">
        {activeSection === 'appearance' && (
          <div className="settings-group">
            <h5>Appearance</h5>
          <div className="setting-item">
            <div className="setting-label">
              <span>Theme</span>
              <span className="setting-description">Choose your preferred theme</span>
            </div>
            <select
              value={theme}
              onChange={(event) => setTheme(event.target.value)}
              className="setting-select"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="auto">Auto</option>
            </select>
          </div>
          <div className="setting-item">
            <div className="setting-label">
              <span>Language</span>
              <span className="setting-description">Select interface language</span>
            </div>
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              className="setting-select"
            >
              <option value="en">English</option>
              <option value="de">Deutsch</option>
            </select>
          </div>
        </div>
        )}

        {activeSection === 'behavior' && (
          <div className="settings-group">
            <h5>Behavior</h5>
          <div className="setting-item">
            <div className="setting-label">
              <span>Auto-save</span>
              <span className="setting-description">Automatically save changes</span>
            </div>
            <div className="setting-toggle">
              <button
                type="button"
                className={`toggle-switch ${autoSave ? 'active' : ''}`}
                onClick={() => setAutoSave(!autoSave)}
              >
                <div className="toggle-slider" />
              </button>
            </div>
          </div>
          <div className="setting-item">
            <div className="setting-label">
              <span>Notifications</span>
              <span className="setting-description">Show system notifications</span>
            </div>
            <div className="setting-toggle">
              <button
                type="button"
                className={`toggle-switch ${notifications ? 'active' : ''}`}
                onClick={() => setNotifications(!notifications)}
              >
                <div className="toggle-slider" />
              </button>
            </div>
          </div>
        </div>
        )}

        {activeSection === 'rate-limits' && (
          <div className="settings-group rate-limits-group">
            <h5>Rate Limits</h5>
          <p className="rate-limit-intro">
            Configure request and token limits for the backend providers. Leave a field blank to use
            the inherited defaults. Tokens represent total usage across prompt and completion.
          </p>
          {rateLimitLoading ? (
            <div className="rate-limit-feedback">Loading rate limits�</div>
          ) : null}
          {rateLimitError ? (
            <div className="rate-limit-feedback rate-limit-feedback-error">{rateLimitError}</div>
          ) : null}
          {!rateLimitLoading && !rateLimitError && rateLimitData ? (
            <div className="rate-limit-grid">
              {renderRateLimitCard(
                'global',
                'Global Defaults',
                rateLimitData.global,
                undefined,
                undefined,
                undefined,
                undefined,
                true,
                expandedGlobal,
                toggleGlobal,
              )}
              {rateLimitData.providers.map((provider) => {
                const isProviderExpanded = expandedProviders[provider.id] ?? false;
                const modelCards = isProviderExpanded
                  ? provider.models.map((model) =>
                      renderRateLimitCard(
                        'model',
                        `Model: ${model.display_name}`,
                        model,
                        provider.id,
                        model.id,
                      ),
                    )
                  : [];

                return renderRateLimitCard(
                  'provider',
                  provider.display_name,
                  provider,
                  provider.id,
                  undefined,
                  undefined,
                  modelCards.length > 0 ? (
                    <div className="rate-limit-models">{modelCards}</div>
                  ) : null,
                  true,
                  isProviderExpanded,
                  () => toggleProvider(provider.id),
                );
              })}
              {rateLimitData.providers.length === 0 ? (
                <div className="rate-limit-feedback">No providers available.</div>
              ) : null}
            </div>
          ) : null}
        </div>
        )}

        {activeSection === 'storage' && (
          <div className="settings-group">
            <h5>Storage</h5>
          <div className="setting-item">
            <div className="setting-label">
              <span>Storage Usage</span>
              <span className="setting-description">{storageLimit}% of 1GB used</span>
            </div>
            <div className="storage-bar">
              <div className="storage-fill" style={{ width: `${storageLimit}%` }} />
            </div>
          </div>
          <div className="setting-item">
            <button className="section-button secondary" type="button">Clear Cache</button>
            <button className="section-button secondary" type="button">Export Data</button>
          </div>
        </div>
        )}

        {activeSection === 'advanced' && (
          <div className="settings-group">
            <h5>Advanced</h5>
          <div className="setting-item">
            <button className="section-button danger" type="button">Reset All Settings</button>
          </div>
        </div>
        )}
      </div>
    </div>
  );
};

export default SettingsWindow;
