// TEMPORARY_DEBUG_TRIGGERLOG - REMOVE AFTER DEBUGGING
// To remove all TriggerLog debugging code, search for: TEMPORARY_DEBUG_TRIGGERLOG
import React from 'react';
import '../../styles/visualization/TriggerLog.css';
import { apiUrl } from '../../config/api';
import { liveStore } from '../../utils/chat/LiveStore';
import { versionSwitchLoadingManager } from '../../utils/versioning/versionSwitchLoadingManager';

interface TriggerLogProps {
  // Minimal dependency: we only need the active chat id
  activeChatId: string;
}


const TriggerLog: React.FC<TriggerLogProps> = ({ activeChatId }) => {
  const handleClick = async () => {
    const timestamp = new Date().toISOString();
    console.group(`🔍 TriggerLog - Chat Loading Animation Analysis @ ${timestamp}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📍 QUESTION: Is chat loading animation active in the current chat? If so why. All states that can cause this and which ones are causing it`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🎯 Active Chat: ${activeChatId}`);

    if (!activeChatId || activeChatId === 'none') {
      console.log('❌ No active chat - cannot analyze loading states.');
      console.groupEnd();
      return;
    }

    try {
      // 1) Get LiveStore state (streaming states)
      const liveState = liveStore.get(activeChatId);
      const streamingState = liveState?.state ?? 'static';
      const isStreaming = streamingState !== 'static';

      console.groupCollapsed(`📡 LiveStore Streaming State`);
      console.log(`State: ${streamingState}`);
      console.log(`Is Streaming: ${isStreaming}`);
      console.log(`Content Buffer: ${liveState?.contentBuf?.length || 0} chars`);
      console.log(`Thoughts Buffer: ${liveState?.thoughtsBuf?.length || 0} chars`);
      console.log(`Last Assistant ID: ${liveState?.lastAssistantId || 'none'}`);
      console.log(`Version: ${liveState?.version || 0}`);
      console.groupEnd();

      // 2) Get Version Switch Loading state
      const versionLoadingState = versionSwitchLoadingManager.getState();
      const isVersionSwitchLoading = versionSwitchLoadingManager.isLoadingForChat(activeChatId);

      console.groupCollapsed(`🔄 Version Switch Loading State`);
      console.log(`Is Loading: ${versionLoadingState.isLoading}`);
      console.log(`Operation: ${versionLoadingState.operation || 'none'}`);
      console.log(`Target Chat ID: ${versionLoadingState.targetChatId || 'none'}`);
      console.log(`Loading for Current Chat: ${isVersionSwitchLoading}`);
      console.groupEnd();

      // 3) Simulate Chat History Loading states by checking current loading patterns
      // Since we can't directly access the useChatHistory hook state from here, we'll note the patterns
      console.groupCollapsed(`📚 Chat History Loading Indicators`);
      console.log(`Note: Cannot directly access useChatHistory loading state from TriggerLog component`);
      console.log(`Loading happens when:`);
      console.log(`  - Chat switches occur`);
      console.log(`  - History fetch API calls are made`);
      console.log(`  - Component mounts/remounts`);
      console.log(`  - Reload notifications are received`);
      console.groupEnd();

      // 4) Check for chat messages to understand loading context
      let messageCount = 0;
      let hasMessages = false;
      let lastAssistant = null;
      try {
        const res = await fetch(apiUrl(`/api/db/chat/${activeChatId}`));
        if (res.ok) {
          const data = await res.json();
          const history = data.history || [];
          messageCount = history.length;
          hasMessages = messageCount > 0;
          lastAssistant = [...history].reverse().find((m: any) => m.role === 'assistant');
        }
      } catch (e) {
        console.log(`Failed to fetch chat history: ${e}`);
      }

      console.groupCollapsed(`💬 Chat State Context`);
      console.log(`Message Count: ${messageCount}`);
      console.log(`Has Messages: ${hasMessages}`);
      console.log(`Last Assistant Message: ${lastAssistant ? `${lastAssistant.id} (${lastAssistant.content?.substring(0, 50)}...)` : 'none'}`);
      console.groupEnd();

      // 5) Loading Animation Analysis
      console.group(`🎬 LOADING ANIMATION ANALYSIS`);

      const loadingCauses = [];
      let hasLoadingAnimation = false;

      // Check streaming states
      if (isStreaming) {
        loadingCauses.push(`🌊 Live Streaming (${streamingState})`);
        hasLoadingAnimation = true;
      }

      // Check version switch loading
      if (isVersionSwitchLoading) {
        loadingCauses.push(`🔄 Version Switch Loading (${versionLoadingState.operation})`);
        hasLoadingAnimation = true;
      }

      // Check skeleton loading conditions (simulated)
      const couldShowSkeleton = !hasMessages && !isStreaming;
      if (couldShowSkeleton) {
        loadingCauses.push(`💀 Skeleton Loading (no messages + not streaming)`);
        hasLoadingAnimation = true;
      }

      // Check for potential "persisting after stream" state
      if (!isStreaming && liveState?.contentBuf && liveState.contentBuf.length > 0) {
        loadingCauses.push(`⏳ Post-Stream Persistence (content buffer not cleared)`);
        hasLoadingAnimation = true;
      }

      console.log(`🎯 ANSWER: Is chat loading animation active? ${hasLoadingAnimation ? '✅ YES' : '❌ NO'}`);
      console.log('');

      if (hasLoadingAnimation) {
        console.log(`🔍 ACTIVE LOADING CAUSES (${loadingCauses.length}):`);
        loadingCauses.forEach((cause, index) => {
          console.log(`  ${index + 1}. ${cause}`);
        });
      } else {
        console.log(`✨ No loading animations are currently active for chat ${activeChatId}`);
      }

      console.log('');
      console.log(`📋 ALL POSSIBLE LOADING ANIMATION CAUSES:`);
      console.log(`  1. 🌊 LiveStore Streaming States:`);
      console.log(`     • state: 'thinking' - AI is processing/thinking`);
      console.log(`     • state: 'responding' - AI is generating response`);
      console.log(`     • contentBuf/thoughtsBuf accumulation during streaming`);
      console.log(`  2. 🔄 Version Switch Loading:`);
      console.log(`     • edit operations on messages`);
      console.log(`     • retry operations on messages`);
      console.log(`     • delete operations on messages`);
      console.log(`  3. 📚 Chat History Loading:`);
      console.log(`     • Initial chat load (useChatHistory.isLoading)`);
      console.log(`     • Chat switching operations`);
      console.log(`     • History refetch/reload operations`);
      console.log(`  4. 💀 Skeleton Loading:`);
      console.log(`     • Empty chat + loading state + timing conditions`);
      console.log(`     • skeletonReady + (isLoading || isOperationLoading)`);
      console.log(`  5. ⚙️ Message Operation Loading:`);
      console.log(`     • useVersioning.isOperationLoading`);
      console.log(`     • Individual message operations in progress`);
      console.log(`  6. ⏳ Post-Stream States:`);
      console.log(`     • persistingAfterStream - cleanup after streaming`);
      console.log(`     • notLoadingSettled - timing state transitions`);

      console.groupEnd();
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.groupEnd();
    } catch (err) {
      console.error('❌ TriggerLog analysis error:', err);
      console.groupEnd();
    }
  };

  return (
    <div className="trigger-log-container" onClick={handleClick} title="Click to analyze chat loading animation states">
      <div className="trigger-log-button">
        <span className="trigger-log-icon">🐛</span>
        <span className="trigger-log-text">TriggerLog</span>
      </div>
    </div>
  );
};

export default TriggerLog;
