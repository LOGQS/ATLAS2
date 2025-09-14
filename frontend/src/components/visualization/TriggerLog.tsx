// TEMPORARY_DEBUG_TRIGGERLOG - REMOVE AFTER DEBUGGING
// To remove all TriggerLog debugging code, search for: TEMPORARY_DEBUG_TRIGGERLOG
import React from 'react';
import '../../styles/visualization/TriggerLog.css';
import { apiUrl } from '../../config/api';
import { liveStore } from '../../utils/chat/LiveStore';

interface TriggerLogProps {
  // Minimal dependency: we only need the active chat id
  activeChatId: string;
}

// Helper to parse message position from id like "<chat_id>_<pos>"
const parsePosition = (id: string): { base: string; pos: number } | null => {
  if (!id || id.indexOf('_') === -1) return null;
  const parts = id.split('_');
  const last = parts.pop();
  if (!last) return null;
  const pos = parseInt(last, 10);
  if (Number.isNaN(pos)) return null;
  const base = parts.join('_');
  return { base, pos };
};

const TriggerLog: React.FC<TriggerLogProps> = ({ activeChatId }) => {
  const handleClick = async () => {
    const timestamp = new Date().toISOString();
    console.group(`🔍 TriggerLog - MessageVersionSwitcher visibility @ ${timestamp}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Active Chat: ${activeChatId}`);

    if (!activeChatId || activeChatId === 'none') {
      console.log('No active chat.');
      console.groupEnd();
      return;
    }

    try {
      // 1) Fetch latest chat history for deterministic debugging
      const res = await fetch(apiUrl(`/api/db/chat/${activeChatId}`));
      const data = await res.json();
      if (!res.ok) {
        console.error('Failed to load chat for debug:', data.error);
        console.groupEnd();
        return;
      }
      const history: Array<{ id: string; role: 'user' | 'assistant'; content: string }>
        = (data.history || []) as any;

      // 2) Determine live state and last assistant id (matches Chat logic)
      const live = liveStore.get(activeChatId);
      const liveState = live?.state ?? 'static';
      const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
      const lastAssistantId = lastAssistant?.id;

      // 3) Helper to check versions for a message id (with assistant fallback)
      const checkHasVersions = async (msgId: string, role: 'user' | 'assistant') => {
        const cache: Map<string, any[]> | undefined = (window as any).messageVersionsCache;
        const getFromCache = (id: string): any[] | undefined => cache?.get(id);

        const fetchVersions = async (id: string): Promise<{ list: any[]; debug?: any }> => {
          try {
            const resp = await fetch(apiUrl(`/api/messages/${id}/versions`));
            if (!resp.ok) return { list: [] };
            const j = await resp.json();
            return { list: j.versions || [], debug: j.debug };
          } catch { return { list: [] }; }
        };

        // Direct check
        let direct = getFromCache?.(msgId);
        let directDebug: any = undefined;
        if (!direct) {
          const r = await fetchVersions(msgId);
          direct = r.list;
          directDebug = r.debug;
        }
        const directCount = direct?.length ?? 0;

        let usedFallback = false;
        let fallbackCount = 0;
        let fallbackId: string | null = null;

        if ((directCount <= 1) && role === 'assistant') {
          const parsed = parsePosition(msgId);
          if (parsed && parsed.pos > 1) {
            fallbackId = `${parsed.base}_${parsed.pos - 1}`;
            let prev = getFromCache?.(fallbackId);
            if (!prev) {
              const r2 = await fetchVersions(fallbackId);
              prev = r2.list;
            }
            fallbackCount = prev?.length ?? 0;
            usedFallback = fallbackCount > 1;
          }
        }

        const hasVersions = (directCount > 1) || (fallbackCount > 1);
        return { hasVersions, directCount, fallbackCount, usedFallback, fallbackId, directDebug };
      };

      // 4) Walk each message and compute the same base-visibility checks as MessageWrapper/Switcher
      for (let i = 0; i < history.length; i++) {
        const m = history[i];
        const isUser = m.role === 'user';
        const isLastAssistant = !isUser && (m.id === lastAssistantId);
        const isStaticForWrapper = isUser
          ? true
          : ((liveState === 'static' || !isLastAssistant) && !(isLastAssistant && !(m.content || '').trim()));

        const { hasVersions, directCount, fallbackCount, usedFallback, fallbackId, directDebug } = await checkHasVersions(m.id, m.role);

        const baseConditions = {
          currentChatIdPresent: !!activeChatId,
          onVersionSwitchPresent: true, // Chat always passes switchToVersion
          isStaticForWrapper,
          hasVersions
        };
        const shouldShow = baseConditions.currentChatIdPresent && baseConditions.onVersionSwitchPresent && baseConditions.isStaticForWrapper && baseConditions.hasVersions;

        console.groupCollapsed(`◽ [${i + 1}/${history.length}] ${m.id} (${m.role}) → shouldShow: ${shouldShow}`);
        console.log(`isStaticForWrapper=${isStaticForWrapper} | liveState=${liveState} | isLastAssistant=${isLastAssistant}`);
        if (directDebug) {
          console.log(`versions: direct=${directCount} (group=${directDebug.group_msg_id}, base=${directDebug.base_chat_id}, main=${directDebug.main_chat_id}, pos=${directDebug.msg_position}) ${usedFallback ? `(fallback ${fallbackId}=${fallbackCount})` : ''}`);
        } else {
          console.log(`versions: direct=${directCount} ${usedFallback ? `(fallback ${fallbackId}=${fallbackCount})` : ''}`);
        }
        console.log('baseConditions:', JSON.parse(JSON.stringify(baseConditions)));
        console.groupEnd();
      }

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.groupEnd();
    } catch (err) {
      console.error('TriggerLog error:', err);
      console.groupEnd();
    }
  };

  return (
    <div className="trigger-log-container" onClick={handleClick} title="Click to log MessageVersionSwitcher state for all messages">
      <div className="trigger-log-button">
        <span className="trigger-log-icon">🐛</span>
        <span className="trigger-log-text">TriggerLog</span>
      </div>
    </div>
  );
};

export default TriggerLog;
