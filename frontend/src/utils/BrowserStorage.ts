// status: complete

export interface UISettings {
  leftSidebarToggled: boolean;
  rightSidebarToggled: boolean;
}

export interface ChatState {
  activeChatId: string;
}

const DEFAULT_SETTINGS: UISettings = {
  leftSidebarToggled: true,
  rightSidebarToggled: false,
};

const DEFAULT_CHAT_STATE: ChatState = {
  activeChatId: 'none',
};

export class BrowserStorage {
  private static readonly SETTINGS_KEY = 'atlas_ui_settings';
  private static readonly CHAT_STATE_KEY = 'atlas_chat_state';

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

  static getChatState(): ChatState {
    try {
      const stored = localStorage.getItem(this.CHAT_STATE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return { ...DEFAULT_CHAT_STATE, ...parsed };
      }
    } catch (error) {
      console.warn('Failed to load chat state from localStorage:', error);
    }
    return DEFAULT_CHAT_STATE;
  }

  static setChatState(state: ChatState): void {
    try {
      localStorage.setItem(this.CHAT_STATE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('Failed to save chat state to localStorage:', error);
    }
  }

  static updateChatState<K extends keyof ChatState>(
    key: K,
    value: ChatState[K]
  ): void {
    const currentState = this.getChatState();
    const updatedState = { ...currentState, [key]: value };
    this.setChatState(updatedState);
  }
}