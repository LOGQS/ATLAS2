import React, { memo } from 'react';

interface IconButtonProps {
  icon: React.ReactNode;
  onClick?: () => void;
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  disabled?: boolean;
  title?: string;
}

const sizeClasses = {
  sm: 'w-6 h-6 text-sm',
  md: 'w-8 h-8 text-base',
  lg: 'w-9 h-9 text-lg',
  xl: 'w-10 h-10 text-xl',
};

export const IconButton = memo<IconButtonProps>(({
  icon,
  onClick,
  className = '',
  size = 'md',
  disabled = false,
  title,
}) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`
        ${sizeClasses[size]}
        flex items-center justify-center
        rounded-lg
        bg-transparent
        text-bolt-elements-textSecondary
        hover:text-bolt-elements-textPrimary
        hover:bg-bolt-elements-item-backgroundActive
        disabled:opacity-50
        disabled:cursor-not-allowed
        transition-all duration-150
        ${className}
      `.trim().replace(/\s+/g, ' ')}
    >
      {icon}
    </button>
  );
});

IconButton.displayName = 'IconButton';
