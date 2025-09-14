export const TREE_CONFIG = {
  INDENT_SIZE: 24,
  BASE_PADDING: 12,
  COLLAPSE_ICON_SIZE: 12,
} as const;

export const VERSION_TYPES = {
  EDIT: { icon: '✏️', color: '#FFA726', prefixes: ['edit_'] },
  REFRESH: { icon: '🔄', color: '#42A5F5', prefixes: ['refresh_', 'retry_'] },
  DELETE: { icon: '🗑️', color: '#EF5350', prefixes: ['delete_'] },
  DEFAULT: { icon: '📋', color: '#9C27B0', prefixes: [] }
} as const;

export const DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
} as const;

export interface WindowWithChatSwitch extends Window {
  handleChatSwitch?: (chatId: string) => Promise<void>;
}

export interface VersionNode {
  id: string;
  name: string;
  isversion: boolean;
  belongsto?: string | null;
  created_at: string;
  is_active: boolean;
  children: VersionNode[];
}

export interface VersionTreeResponse {
  success: boolean;
  current_chat_id: string;
  main_chat_id: string;
  version_tree: VersionNode;
}

export type ViewMode = 'list' | 'tree';

export const getVersionType = (name: string) => {
  for (const config of Object.values(VERSION_TYPES)) {
    if (config.prefixes.some(prefix => name.startsWith(prefix))) {
      return config;
    }
  }
  return VERSION_TYPES.DEFAULT;
};

export const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleString(undefined, DATE_FORMAT_OPTIONS);
};