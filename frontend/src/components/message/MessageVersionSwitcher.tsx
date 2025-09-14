import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { apiUrl } from '../../config/api';
import logger from '../../utils/core/logger';
import '../../styles/message/MessageVersionSwitcher.css';

interface MessageVersion {
  version_number: number;
  chat_version_id: string;
  operation: string;
  created_at: string;
  content?: string;
}

interface MessageVersionSwitcherProps {
  messageId: string;
  currentChatId: string;
  onVersionSwitch?: (newChatId: string) => void;
  isVisible: boolean;
  messageRole?: 'user' | 'assistant';
  hasVersions?: boolean;
}

const MessageVersionSwitcher: React.FC<MessageVersionSwitcherProps> = ({
  messageId,
  currentChatId,
  onVersionSwitch,
  isVisible,
  messageRole,
  hasVersions
}) => {
  const [versions, setVersions] = useState<MessageVersion[]>([]);
  const [currentVersion, setCurrentVersion] = useState<number>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 220 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const requestIdRef = useRef(0);
  const bestListRef = useRef<MessageVersion[]>([]);
  const resolvedSourceIdRef = useRef<string | null>(null);

  const parsePosition = (id: string): { base: string; pos: number } | null => {
    if (!id || !id.includes('_')) return null;
    const parts = id.split('_');
    const last = parts.pop();
    if (!last) return null;
    const pos = parseInt(last, 10);
    if (Number.isNaN(pos)) return null;
    const base = parts.join('_');
    return { base, pos };
  };

  const pickCurrentVersionNumber = (list: MessageVersion[], chatId: string): number => {
    const current = list.find((v) => v.chat_version_id === chatId);
    if (current) return current.version_number;
    if (list.length > 0) {
      return Math.max(...list.map(v => v.version_number || 1));
    }
    return 1;
  };

  const tryLoad = useCallback(async (id: string) => {
    const cached = (window as any).messageVersionsCache?.get(id);
    if (cached && cached.length > 0) {
      return { versions: cached as MessageVersion[], active: undefined };
    }
    const response = await fetch(apiUrl(`/api/messages/${id}/versions`));
    if (!response.ok) return { versions: [] as MessageVersion[], active: undefined };
    const data = await response.json();
    return { versions: (data.versions || []) as MessageVersion[], active: data.active_version_number as number | undefined };
  }, []);

  const loadVersions = useCallback(async () => {
    const localRequestId = ++requestIdRef.current;
    try {
      let sourceId = messageId;
      let result = await tryLoad(sourceId);
      let list = result.versions;
      let activeFromApi = result.active;

      if ((!list || list.length <= 1) && messageRole === 'assistant') {
        const parsed = parsePosition(messageId);
        if (parsed && parsed.pos > 1) {
          const prevId = `${parsed.base}_${parsed.pos - 1}`;
          const prevResult = await tryLoad(prevId);
          const prevList = prevResult.versions;
          if (prevList && prevList.length > 1) {
            sourceId = prevId;
            list = prevList;
            activeFromApi = prevResult.active;
          }
        }
      }

      if (localRequestId !== requestIdRef.current) return;

      const currentBest = bestListRef.current || [];
      const shouldApply = (list && list.length >= currentBest.length) || resolvedSourceIdRef.current === null || resolvedSourceIdRef.current === sourceId;
      if (!shouldApply) return;

      resolvedSourceIdRef.current = sourceId;
      bestListRef.current = list || [];
      setVersions(list || []);
      if (list && list.length > 0) {
        const picked = activeFromApi && activeFromApi > 0
          ? activeFromApi
          : pickCurrentVersionNumber(list, currentChatId);
        setCurrentVersion(picked);
      }
    } catch (error) {
      logger.error('Failed to load message versions:', error);
    }
  }, [messageId, currentChatId, tryLoad, messageRole]);

  useEffect(() => {
    bestListRef.current = [];
    resolvedSourceIdRef.current = null;
    setVersions([]);
    setCurrentVersion(1);
  }, [messageId]);

  useEffect(() => {
    if (hasVersions === false) {
      requestIdRef.current++;
      bestListRef.current = [];
      resolvedSourceIdRef.current = null;
      setVersions([]);
      setCurrentVersion(1);
      return;
    }
    loadVersions();
  }, [messageId, currentChatId, hasVersions, loadVersions]);

  useEffect(() => {
    if (!isVisible && showDropdown) setShowDropdown(false);
  }, [isVisible, showDropdown]);

  const handleVersionClick = useCallback((version: MessageVersion) => {
    if (version.chat_version_id === currentChatId) {
      setShowDropdown(false);
      return;
    }

    setIsLoading(true);
    setCurrentVersion(version.version_number);
    setShowDropdown(false);
    
    onVersionSwitch?.(version.chat_version_id);
    
    setIsLoading(false);
  }, [currentChatId, onVersionSwitch]);

  const openDropdown = useCallback(() => {
    const btn = buttonRef.current;
    if (btn) {
      const rect = btn.getBoundingClientRect();
      const vw = window.innerWidth;
      const dropdownWidth = Math.max(220, rect.width);
      const left = Math.min(rect.left, vw - dropdownWidth - 8);
      setDropdownPos({ top: rect.bottom + 6, left, width: dropdownWidth });
    }
    setShowDropdown(true);
  }, []);

  const closeDropdown = useCallback(() => setShowDropdown(false), []);

  useEffect(() => {
    if (!showDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      const btn = buttonRef.current;
      if (btn && e.target instanceof Node && !btn.contains(e.target)) {
        closeDropdown();
      }
    };
    const handleResize = () => {
      const btn = buttonRef.current;
      if (btn) {
        const rect = btn.getBoundingClientRect();
        const vw = window.innerWidth;
        const dropdownWidth = Math.max(220, rect.width);
        const left = Math.min(rect.left, vw - dropdownWidth - 8);
        setDropdownPos({ top: rect.bottom + 6, left, width: dropdownWidth });
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
    };
  }, [showDropdown, closeDropdown]);

  const hasMultipleVersions = versions.length > 1;
  const shouldShowContent = !!isVisible && !!onVersionSwitch && !!hasVersions;

  const getVersionLabel = (version: MessageVersion) => {
    if (version.version_number === 1) return 'Original';
    
    switch (version.operation) {
      case 'edit':
        return `Edit ${version.version_number - 1}`;
      case 'retry':
        return `Retry ${version.version_number - 1}`;
      default:
        return `v${version.version_number}`;
    }
  };

  return (
    <div className={`message-version-switcher ${shouldShowContent ? 'visible' : ''}`}>
      {shouldShowContent && versions.length > 0 && (
        <>
          <button 
            ref={buttonRef}
            className={`version-indicator ${isLoading ? 'loading' : ''} ${showDropdown ? 'open' : ''}`}
            onClick={() => {
              if (isLoading || !hasMultipleVersions) return;
              return showDropdown ? closeDropdown() : openDropdown();
            }}
            disabled={isLoading || !hasMultipleVersions}
            title="Switch between versions of this message"
          >
            <span className="version-icon" aria-hidden="true" />
            <span className="version-label">
              {getVersionLabel(versions[currentVersion - 1] || versions[0])}
            </span>
            <span className="version-count">({currentVersion}/{versions.length})</span>
            <span className="dropdown-arrow">▼</span>
          </button>

          {showDropdown && !isLoading && createPortal(
            <div
              className="version-dropdown"
              style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, minWidth: dropdownPos.width }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="version-dropdown-header">Message Versions</div>
              <div className="version-list">
                {versions.map((version) => (
                  <button
                    key={version.version_number}
                    className={`version-item ${version.version_number === currentVersion ? 'active' : ''}`}
                    onClick={() => handleVersionClick(version)}
                  >
                    <span className="version-number">{getVersionLabel(version)}</span>
                    <span className="version-time">{new Date(version.created_at).toLocaleString()}</span>
                    {version.version_number === currentVersion && <span className="current-indicator">✓</span>}
                  </button>
                ))}
              </div>
            </div>,
            document.body
          )}
        </>
      )}
    </div>
  );
};

export default MessageVersionSwitcher;
