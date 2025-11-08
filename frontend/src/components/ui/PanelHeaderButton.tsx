import { memo } from 'react';

interface PanelHeaderButtonProps {
  className?: string;
  disabledClassName?: string;
  disabled?: boolean;
  children: React.ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
}

export const PanelHeaderButton = memo(
  ({ className, disabledClassName, disabled = false, children, onClick }: PanelHeaderButtonProps) => {
    const disabledClasses = disabled ? `opacity-30 ${disabledClassName || ''}` : '';

    return (
      <button
        className={`flex items-center shrink-0 gap-1.5 px-1.5 rounded-md py-0.5 text-bolt-elements-item-contentDefault bg-transparent enabled:hover:text-bolt-elements-item-contentActive enabled:hover:bg-bolt-elements-item-backgroundActive disabled:cursor-not-allowed ${disabledClasses} ${className || ''}`}
        disabled={disabled}
        onClick={(event) => {
          if (disabled) {
            return;
          }
          onClick?.(event);
        }}
      >
        {children}
      </button>
    );
  },
);

PanelHeaderButton.displayName = 'PanelHeaderButton';
