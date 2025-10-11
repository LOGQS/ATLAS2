import React, { memo, useMemo } from 'react';

interface FileBreadcrumbProps {
  filePath: string;
}

export const FileBreadcrumb = memo<FileBreadcrumbProps>(({ filePath }) => {
  const segments = useMemo(
    () => filePath.split('/').filter(s => s),
    [filePath]
  );

  if (segments.length === 0) return null;

  return (
    <div className="flex items-center gap-1 text-xs overflow-x-auto font-mono flex-1">
      {segments.map((segment, index) => (
        <React.Fragment key={index}>
          {index > 0 && (
            <span className="text-bolt-elements-borderColor font-light select-none">
              ›
            </span>
          )}
          <span
            className={`
              px-2 py-1 rounded-md transition-all duration-150
              ${index === segments.length - 1
                ? 'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent font-medium'
                : 'text-bolt-elements-textSecondary'
              }
            `}
          >
            {segment}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
});

FileBreadcrumb.displayName = 'FileBreadcrumb';
