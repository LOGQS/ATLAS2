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

export class BrowserStorage {
  private static readonly SETTINGS_KEY = 'atlas_ui_settings';
  private static readonly ATTACHED_FILES_KEY = 'atlas_attached_files';
  private static readonly SOURCE_PREFS_KEY = 'atlas_source_preferences';

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
}
