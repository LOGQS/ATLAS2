// status: complete

export interface UISettings {
  leftSidebarToggled: boolean;
  rightSidebarToggled: boolean;
}

const DEFAULT_SETTINGS: UISettings = {
  leftSidebarToggled: true,
  rightSidebarToggled: false,
};

export class BrowserStorage {
  private static readonly SETTINGS_KEY = 'atlas_ui_settings';

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

}