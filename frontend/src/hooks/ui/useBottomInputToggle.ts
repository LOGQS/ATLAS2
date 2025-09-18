import { useState, useRef, useEffect, useCallback } from 'react';
import { BrowserStorage } from '../../utils/storage/BrowserStorage';
import logger from '../../utils/core/logger';

interface UseBottomInputToggleReturn {
  isBottomInputToggled: boolean;
  isBottomInputHovering: boolean;
  showToggleOutline: boolean;
  setIsBottomInputHovering: (hovering: boolean) => void;
  handleBottomInputDoubleClick: () => void;
  resetToggleOutlineTimer: () => void;
}

const TOGGLE_OUTLINE_TIMEOUT_MS = 3000;

export const useBottomInputToggle = (): UseBottomInputToggleReturn => {
  const [isBottomInputToggled, setIsBottomInputToggled] = useState(() => {
    const settings = BrowserStorage.getUISettings();
    return settings.bottomInputToggled;
  });

  const [isBottomInputHovering, setIsBottomInputHovering] = useState(false);
  const [showToggleOutline, setShowToggleOutline] = useState(false);
  const toggleOutlineTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const resetToggleOutlineTimer = useCallback(() => {
    if (toggleOutlineTimeoutRef.current) {
      clearTimeout(toggleOutlineTimeoutRef.current);
    }
    setShowToggleOutline(true);
    if (isBottomInputToggled) {
      toggleOutlineTimeoutRef.current = setTimeout(() => {
        setShowToggleOutline(false);
      }, TOGGLE_OUTLINE_TIMEOUT_MS);
    }
  }, [isBottomInputToggled]);

  useEffect(() => {
    if (!isBottomInputToggled) {
      setShowToggleOutline(false);
      if (toggleOutlineTimeoutRef.current) {
        clearTimeout(toggleOutlineTimeoutRef.current);
      }
    }
    return () => {
      if (toggleOutlineTimeoutRef.current) {
        clearTimeout(toggleOutlineTimeoutRef.current);
      }
    };
  }, [isBottomInputToggled]);

  const handleBottomInputDoubleClick = useCallback(() => {
    const newToggleState = !isBottomInputToggled;
    logger.info('Double-click toggling bottom input bar:', newToggleState);
    setIsBottomInputToggled(newToggleState);
    BrowserStorage.updateUISetting('bottomInputToggled', newToggleState);
  }, [isBottomInputToggled]);

  return {
    isBottomInputToggled,
    isBottomInputHovering,
    showToggleOutline,
    setIsBottomInputHovering,
    handleBottomInputDoubleClick,
    resetToggleOutlineTimer
  };
};