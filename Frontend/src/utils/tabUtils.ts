let cachedId: string | null = null;
export function getTabId(): string {
  if (cachedId) return cachedId;
  try {
    const existing = sessionStorage.getItem('atlas_tab_id');
    if (existing) {
      cachedId = existing;
      return existing;
    }
    const newId = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2));
    sessionStorage.setItem('atlas_tab_id', newId);
    cachedId = newId;
    return newId;
  } catch {
    cachedId = Math.random().toString(36).slice(2);
    return cachedId;
  }
}

export function getActiveChatKey(): string {
  return `atlas_active_chat_${getTabId()}`;
}

export function getOpenChatsKey(): string {
  return `atlas_open_chats_${getTabId()}`;
}

