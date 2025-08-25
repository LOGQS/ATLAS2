// status: complete

export interface UISettings {
  leftSidebarToggled: boolean;
  rightSidebarToggled: boolean;
  chatOrder?: string[];
  attachedFilesCollapsed?: boolean;
}

export interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  api_state?: string;
  provider?: string;
}

const DEFAULT_SETTINGS: UISettings = {
  leftSidebarToggled: true,
  rightSidebarToggled: false,
  attachedFilesCollapsed: false,
};

export class BrowserStorage {
  private static readonly SETTINGS_KEY = 'atlas_ui_settings';
  private static readonly ATTACHED_FILES_KEY = 'atlas_attached_files';

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

}