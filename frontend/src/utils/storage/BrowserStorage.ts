// status: complete

export interface UISettings {
  leftSidebarToggled: boolean;
  rightSidebarToggled: boolean;
  bottomInputToggled: boolean;
  chatHistoryCollapsed: boolean;
  chatOrder?: string[];
  attachedFilesCollapsed?: boolean;
}

export type SourcePane = 'web' | 'local';

export type SourceInclusionState = 'included' | 'excluded';

export interface SourcePreferences {
  activePane: SourcePane;
  searchQuery: string;
  selectedTagIds: string[];
  expandedNodes: Record<SourcePane, string[]>;
  selectedNodeIds: Record<SourcePane, string | null>;
  inclusionOverrides: Record<string, SourceInclusionState>;
  pinnedSources: string[];
}

export interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type?: string;
  api_state?: string;
  provider?: string;
}

export type MessageStatsSource = 'performance-tracker' | 'manual';

export interface MessageGenerationStats {
  messageId: string;
  totalTimeMs: number | null;
  streamingTimeMs: number | null;
  firstTokenMs: number | null;
  recordedAt: string;
  source: MessageStatsSource;
  performanceMarks?: Partial<Record<string, number>>;
  phaseDurations?: Partial<Record<string, number>>;
  messageTimestamp?: string | null;
}

const DEFAULT_SETTINGS: UISettings = {
  leftSidebarToggled: true,
  rightSidebarToggled: true,
  bottomInputToggled: true,
  chatHistoryCollapsed: false,
  attachedFilesCollapsed: false,
};

export const DEFAULT_SOURCE_PREFERENCES: SourcePreferences = {
  activePane: 'web',
  searchQuery: '',
  selectedTagIds: [],
  expandedNodes: {
    web: [],
    local: []
  },
  selectedNodeIds: {
    web: null,
    local: null
  },
  inclusionOverrides: {},
  pinnedSources: []
};

interface MessageStatsChatEntry {
  records: Record<string, MessageGenerationStats>;
  aliases: Record<string, string>;
}

type MessageStatsStorage = Record<string, MessageStatsChatEntry>;

export class BrowserStorage {
  private static readonly SETTINGS_KEY = 'atlas_ui_settings';
  private static readonly ATTACHED_FILES_KEY = 'atlas_attached_files';
  private static readonly SOURCE_PREFS_KEY = 'atlas_source_preferences';
  private static readonly MESSAGE_STATS_KEY = 'atlas_message_stats_v1';
  private static readonly MESSAGE_STATS_LIMIT = 200;

  static getUISettings(): UISettings {
    try {
      const stored = localStorage.getItem(this.SETTINGS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch (error) {
      console.warn('Failed to load UI settings from localStorage:', error);
    }
    return DEFAULT_SETTINGS;
  }

  static setUISettings(settings: UISettings): void {
    try {
      localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn('Failed to save UI settings to localStorage:', error);
    }
  }

  static updateUISetting<K extends keyof UISettings>(
    key: K,
    value: UISettings[K]
  ): void {
    const currentSettings = this.getUISettings();
    const updatedSettings = { ...currentSettings, [key]: value };
    this.setUISettings(updatedSettings);
  }

  static getAttachedFiles(): AttachedFile[] {
    try {
      const stored = localStorage.getItem(this.ATTACHED_FILES_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.warn('Failed to load attached files from localStorage:', error);
      return [];
    }
  }

  static setAttachedFiles(files: AttachedFile[]): void {
    try {
      localStorage.setItem(this.ATTACHED_FILES_KEY, JSON.stringify(files));
    } catch (error) {
      console.warn('Failed to save attached files to localStorage:', error);
    }
  }

  static clearAttachedFiles(): void {
    try {
      localStorage.removeItem(this.ATTACHED_FILES_KEY);
    } catch (error) {
      console.warn('Failed to clear attached files from localStorage:', error);
    }
  }

  static getSourcePreferences(): SourcePreferences {
    try {
      const stored = localStorage.getItem(this.SOURCE_PREFS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return {
          ...DEFAULT_SOURCE_PREFERENCES,
          ...parsed,
          expandedNodes: {
            ...DEFAULT_SOURCE_PREFERENCES.expandedNodes,
            ...(parsed?.expandedNodes ?? {})
          },
          selectedNodeIds: {
            ...DEFAULT_SOURCE_PREFERENCES.selectedNodeIds,
            ...(parsed?.selectedNodeIds ?? {})
          },
          selectedTagIds: Array.isArray(parsed?.selectedTagIds)
            ? parsed.selectedTagIds
            : DEFAULT_SOURCE_PREFERENCES.selectedTagIds,
          inclusionOverrides: parsed?.inclusionOverrides ?? { ...DEFAULT_SOURCE_PREFERENCES.inclusionOverrides },
          pinnedSources: Array.isArray(parsed?.pinnedSources)
            ? parsed.pinnedSources
            : [...DEFAULT_SOURCE_PREFERENCES.pinnedSources]
        };
      }
    } catch (error) {
      console.warn('Failed to load source preferences from localStorage:', error);
    }
    return { ...DEFAULT_SOURCE_PREFERENCES };
  }

  static setSourcePreferences(preferences: SourcePreferences): void {
    try {
      localStorage.setItem(this.SOURCE_PREFS_KEY, JSON.stringify(preferences));
    } catch (error) {
      console.warn('Failed to save source preferences to localStorage:', error);
    }
  }

  static updateSourcePreferences(
    updater: SourcePreferences | ((current: SourcePreferences) => SourcePreferences)
  ): SourcePreferences {
    const current = this.getSourcePreferences();
    const next =
      typeof updater === 'function'
        ? (updater as (current: SourcePreferences) => SourcePreferences)(current)
        : updater;
    this.setSourcePreferences(next);
    return next;
  }

  private static getMessageStatsStorage(): MessageStatsStorage {
    if (typeof window === 'undefined') {
      return {};
    }

    try {
      const stored = localStorage.getItem(this.MESSAGE_STATS_KEY);
      if (!stored) {
        return {};
      }
      const parsed = JSON.parse(stored) as MessageStatsStorage;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      console.warn('Failed to load message stats from localStorage:', error);
      return {};
    }
  }

  private static persistMessageStatsStorage(storage: MessageStatsStorage): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      localStorage.setItem(this.MESSAGE_STATS_KEY, JSON.stringify(storage));
    } catch (error) {
      console.warn('Failed to persist message stats to localStorage:', error);
    }
  }

  private static ensureMessageStatsEntry(storage: MessageStatsStorage, chatId: string): MessageStatsChatEntry {
    if (!storage[chatId]) {
      storage[chatId] = { records: {}, aliases: {} };
    }
    return storage[chatId];
  }

  private static resolveMessageStatsKey(entry: MessageStatsChatEntry | undefined, key: string): string {
    if (!entry) {
      return key;
    }

    let current = key;
    const visited = new Set<string>();

    while (entry.aliases[current] && !visited.has(current)) {
      visited.add(current);
      current = entry.aliases[current];
    }

    return current;
  }

  private static pruneMessageStats(entry: MessageStatsChatEntry): void {
    const records = Object.entries(entry.records);
    if (records.length <= this.MESSAGE_STATS_LIMIT) {
      return;
    }

    records.sort(([, a], [, b]) => {
      const aTime = new Date(a.recordedAt).getTime();
      const bTime = new Date(b.recordedAt).getTime();
      return aTime - bTime;
    });

    while (records.length > this.MESSAGE_STATS_LIMIT) {
      const [oldestKey] = records.shift()!;
      delete entry.records[oldestKey];
    }
  }

  private static notifyMessageStatsUpdate(chatId: string, key: string, messageId?: string): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.dispatchEvent(new CustomEvent('messageStatsUpdated', {
      detail: {
        chatId,
        key,
        messageId: messageId ?? null
      }
    }));
  }

  static getMessageStats(chatId: string | undefined, key: string | undefined | null): MessageGenerationStats | null {
    if (!chatId || !key) {
      return null;
    }

    const storage = this.getMessageStatsStorage();
    const entry = storage[chatId];
    if (!entry) {
      return null;
    }

    const resolvedKey = this.resolveMessageStatsKey(entry, key);
    const record = entry.records[resolvedKey];
    if (!record) {
      return null;
    }

    return {
      ...record,
      performanceMarks: record.performanceMarks ? { ...record.performanceMarks } : undefined,
      phaseDurations: record.phaseDurations ? { ...record.phaseDurations } : undefined,
    };
  }

  static saveMessageStats(
    chatId: string,
    key: string,
    input: Partial<Omit<MessageGenerationStats, 'messageId' | 'recordedAt' | 'source'>> & {
      messageId?: string;
      recordedAt?: string;
      source?: MessageStatsSource;
    }
  ): MessageGenerationStats {
    const storage = this.getMessageStatsStorage();
    const entry = this.ensureMessageStatsEntry(storage, chatId);

    const resolvedKey = this.resolveMessageStatsKey(entry, key);
    const existing = entry.records[resolvedKey];

    const record: MessageGenerationStats = {
      messageId: input.messageId ?? existing?.messageId ?? resolvedKey,
      totalTimeMs: input.totalTimeMs ?? existing?.totalTimeMs ?? null,
      streamingTimeMs: input.streamingTimeMs ?? existing?.streamingTimeMs ?? null,
      firstTokenMs: input.firstTokenMs ?? existing?.firstTokenMs ?? null,
      recordedAt: input.recordedAt ?? existing?.recordedAt ?? new Date().toISOString(),
      source: input.source ?? existing?.source ?? 'performance-tracker',
      performanceMarks: {
        ...(existing?.performanceMarks ?? {}),
        ...(input.performanceMarks ?? {}),
      },
      phaseDurations: {
        ...(existing?.phaseDurations ?? {}),
        ...(input.phaseDurations ?? {}),
      },
      messageTimestamp: input.messageTimestamp ?? existing?.messageTimestamp ?? null,
    };

    if (record.performanceMarks && Object.keys(record.performanceMarks).length === 0) {
      record.performanceMarks = undefined;
    }

    if (record.phaseDurations && Object.keys(record.phaseDurations).length === 0) {
      record.phaseDurations = undefined;
    }

    entry.records[resolvedKey] = record;
    this.pruneMessageStats(entry);
    this.persistMessageStatsStorage(storage);
    this.notifyMessageStatsUpdate(chatId, resolvedKey, record.messageId);
    return record;
  }

  static setMessageStatsAlias(chatId: string, alias: string | undefined | null, targetKey: string): void {
    if (!chatId || !alias || alias === targetKey) {
      return;
    }

    const storage = this.getMessageStatsStorage();
    const entry = this.ensureMessageStatsEntry(storage, chatId);
    const resolvedTarget = this.resolveMessageStatsKey(entry, targetKey);

    if (entry.aliases[alias] === resolvedTarget) {
      return;
    }

    entry.aliases[alias] = resolvedTarget;
    this.persistMessageStatsStorage(storage);
    this.notifyMessageStatsUpdate(chatId, resolvedTarget);
  }

  static promoteMessageStats(chatId: string, fromKey: string, toKey: string): void {
    if (!chatId || !fromKey || !toKey) {
      return;
    }

    if (fromKey === toKey) {
      this.setMessageStatsAlias(chatId, fromKey, toKey);
      return;
    }

    const storage = this.getMessageStatsStorage();
    const entry = storage[chatId];
    if (!entry) {
      this.setMessageStatsAlias(chatId, fromKey, toKey);
      return;
    }

    const resolvedFrom = this.resolveMessageStatsKey(entry, fromKey);
    const resolvedTo = this.resolveMessageStatsKey(entry, toKey);

    const record = entry.records[resolvedFrom];
    if (!record) {
      this.setMessageStatsAlias(chatId, fromKey, resolvedTo);
      return;
    }

    delete entry.records[resolvedFrom];
    const updated: MessageGenerationStats = { ...record, messageId: resolvedTo };
    entry.records[resolvedTo] = updated;

    Object.entries(entry.aliases).forEach(([aliasKey, currentTarget]) => {
      if (currentTarget === resolvedFrom) {
        entry.aliases[aliasKey] = resolvedTo;
      }
    });
    entry.aliases[fromKey] = resolvedTo;

    this.persistMessageStatsStorage(storage);
    this.notifyMessageStatsUpdate(chatId, resolvedTo, updated.messageId);
  }
}
