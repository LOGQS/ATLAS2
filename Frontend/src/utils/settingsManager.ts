interface GenerationSettings {
  temperature: number | undefined;
  maxTokens: number | undefined;
}

interface AppSettings {
  defaultModel: string;
  ttsButtonEnabled: boolean;
  sttButtonEnabled: boolean;
  copyButtonEnabled: boolean;
  modelParametersEnabled: boolean;
  imageAnnotationEnabled: boolean;
  summarizeButtonEnabled: boolean;
  ttsVoice: string;
  ttsSpeed: number;
  generationSettings: GenerationSettings;
}

type SettingsKey = keyof AppSettings;

class SettingsManager {
  private cache: AppSettings | null = null;
  private isLoading = false;
  private callbacks: ((settings: AppSettings) => void)[] = [];

  // Default settings (matching backend)
  private defaultSettings: AppSettings = {
    defaultModel: 'gemini-2.5-flash',
    ttsButtonEnabled: true,
    sttButtonEnabled: true,
    copyButtonEnabled: true,
    modelParametersEnabled: false,
    imageAnnotationEnabled: true,
    summarizeButtonEnabled: true,
    ttsVoice: 'default',
    ttsSpeed: 1.0,
    generationSettings: {
      temperature: undefined,
      maxTokens: undefined
    }
  };

  constructor() {
    // Listen for storage events from other tabs
    window.addEventListener('storage', (e) => {
      if (e.key && this.isSettingsKey(e.key)) {
        this.invalidateCache();
        this.notifyCallbacks();
      }
    });

    // Listen for custom events from same window
    window.addEventListener('settingsChanged', () => {
      this.invalidateCache();
      this.notifyCallbacks();
    });
  }

  private isSettingsKey(key: string): boolean {
    return [
      'defaultModel', 'ttsButtonEnabled', 'sttButtonEnabled', 'copyButtonEnabled',
      'modelParametersEnabled', 'imageAnnotationEnabled', 'summarizeButtonEnabled',
      'ttsVoice', 'ttsSpeed', 'generationSettings'
    ].includes(key);
  }

  private invalidateCache() {
    this.cache = null;
  }

  private notifyCallbacks() {
    if (this.cache) {
      this.callbacks.forEach(callback => callback(this.cache!));
    }
  }

  // Subscribe to settings changes
  subscribe(callback: (settings: AppSettings) => void): () => void {
    this.callbacks.push(callback);
    
    // Call immediately with current settings
    this.getSettings().then(callback);
    
    // Return unsubscribe function
    return () => {
      this.callbacks = this.callbacks.filter(cb => cb !== callback);
    };
  }

  // Get all settings (API first, localStorage fallback)
  async getSettings(): Promise<AppSettings> {
    if (this.cache) {
      return this.cache;
    }

    if (this.isLoading) {
      // Wait for current loading to complete
      await new Promise(resolve => {
        const check = () => {
          if (!this.isLoading) {
            resolve(void 0);
          } else {
            setTimeout(check, 10);
          }
        };
        check();
      });
      return this.cache || this.getLocalStorageSettings();
    }

    this.isLoading = true;

    try {
      // Try API first
      const response = await fetch('/api/settings');
      if (response.ok) {
        const data = await response.json();
        this.cache = this.mergeWithDefaults(data);
        this.isLoading = false;
        return this.cache;
      }
    } catch (error) {
      console.warn('Failed to fetch settings from API, using localStorage:', error);
    }

    // Fallback to localStorage
    this.cache = this.getLocalStorageSettings();
    this.isLoading = false;
    return this.cache;
  }

  // Get settings from localStorage (existing behavior)
  private getLocalStorageSettings(): AppSettings {
    const settings = { ...this.defaultSettings };
    
    try {
      settings.defaultModel = localStorage.getItem('defaultModel') || settings.defaultModel;
      settings.ttsButtonEnabled = JSON.parse(localStorage.getItem('ttsButtonEnabled') || 'true');
      settings.sttButtonEnabled = JSON.parse(localStorage.getItem('sttButtonEnabled') || 'true');
      settings.copyButtonEnabled = JSON.parse(localStorage.getItem('copyButtonEnabled') || 'true');
      settings.modelParametersEnabled = JSON.parse(localStorage.getItem('modelParametersEnabled') || 'false');
      settings.imageAnnotationEnabled = JSON.parse(localStorage.getItem('imageAnnotationEnabled') || 'true');
      settings.summarizeButtonEnabled = JSON.parse(localStorage.getItem('summarizeButtonEnabled') || 'true');
      settings.ttsVoice = localStorage.getItem('ttsVoice') || settings.ttsVoice;
      settings.ttsSpeed = parseFloat(localStorage.getItem('ttsSpeed') || '1.0');
      
      const generationSettings = localStorage.getItem('generationSettings');
      if (generationSettings) {
        settings.generationSettings = JSON.parse(generationSettings);
      }
    } catch (error) {
      console.warn('Error reading from localStorage:', error);
    }

    return settings;
  }

  // Merge API response with defaults
  private mergeWithDefaults(apiSettings: Partial<AppSettings>): AppSettings {
    return {
      ...this.defaultSettings,
      ...apiSettings
    };
  }

  // Update a setting (optimistic update, then sync to backend)
  async setSetting<K extends SettingsKey>(key: K, value: AppSettings[K]): Promise<boolean> {
    // Optimistic update - update UI immediately
    if (this.cache) {
      this.cache = { ...this.cache, [key]: value };
    }
    this.syncToLocalStorage(key, value);
    this.notifyCallbacks(); // Update UI immediately
    
    try {
      // Try API in background
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ [key]: value }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          // Sync cache with server response (in case server modified the value)
          this.cache = this.mergeWithDefaults(data.settings);
          this.notifyCallbacks(); // Update again if server changed anything
          return true;
        }
      }
    } catch (error) {
      console.warn('Failed to update setting via API, continuing with localStorage only:', error);
    }

    // If API failed, we already have the optimistic update, so this is still success
    return true;
  }

  // Sync individual setting to localStorage
  private syncToLocalStorage<K extends SettingsKey>(key: K, value: AppSettings[K]) {
    try {
      if (typeof value === 'object') {
        localStorage.setItem(key, JSON.stringify(value));
      } else {
        localStorage.setItem(key, value.toString());
      }

      // Dispatch events for cross-tab sync (maintaining existing behavior)
      window.dispatchEvent(new CustomEvent('settingsChanged', {
        detail: { key, value }
      }));
    } catch (error) {
      console.error('Failed to sync to localStorage:', error);
    }
  }

  // Get a specific setting
  async getSetting<K extends SettingsKey>(key: K): Promise<AppSettings[K]> {
    const settings = await this.getSettings();
    return settings[key];
  }

  // Batch update multiple settings (optimistic update, then sync to backend)
  async updateSettings(updates: Partial<AppSettings>): Promise<boolean> {
    // Optimistic update - update UI immediately
    if (this.cache) {
      this.cache = { ...this.cache, ...updates };
    }
    
    // Sync all updates to localStorage immediately
    Object.entries(updates).forEach(([key, value]) => {
      this.syncToLocalStorage(key as SettingsKey, value);
    });
    this.notifyCallbacks(); // Update UI immediately
    
    try {
      // Try API in background
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          // Sync cache with server response (in case server modified values)
          this.cache = this.mergeWithDefaults(data.settings);
          this.notifyCallbacks(); // Update again if server changed anything
          return true;
        }
      }
    } catch (error) {
      console.warn('Failed to batch update settings via API, using localStorage only:', error);
    }

    // Fallback: if API failed, we already updated localStorage and UI, so continue
    // This maintains the same fallback behavior but with immediate UI response
    return true;
  }
}

// Export singleton instance
export const settingsManager = new SettingsManager();
export type { AppSettings, SettingsKey, GenerationSettings };