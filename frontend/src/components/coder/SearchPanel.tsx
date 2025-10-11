import React from 'react';
import { useCoderContext } from '../../contexts/CoderContext';
import { Icons } from '../ui/Icons';

export const SearchPanel: React.FC = () => {
  const { searchQuery, setSearchQuery } = useCoderContext();

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="relative">
        <input
          type="text"
          className="
            w-full px-3 py-2 pr-8
            text-sm
            bg-bolt-elements-background-depth-3
            border border-bolt-elements-borderColor
            rounded-lg
            text-bolt-elements-textPrimary
            placeholder-bolt-elements-textTertiary
            focus:outline-none
            focus:ring-2
            focus:ring-blue-500/50
            focus:border-blue-500
            transition-all duration-150
          "
          placeholder="Search files..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button
            className="
              absolute right-2 top-1/2 -translate-y-1/2
              w-6 h-6 flex items-center justify-center
              rounded-md
              text-bolt-elements-textTertiary
              hover:text-bolt-elements-textPrimary
              hover:bg-bolt-elements-item-backgroundActive
              transition-all duration-150
            "
            onClick={() => setSearchQuery('')}
            title="Clear search"
          >
            <Icons.Close className="w-4 h-4" />
          </button>
        )}
      </div>
      {searchQuery && (
        <div className="
          px-3 py-2 text-xs
          bg-blue-500/10
          border-l-2 border-blue-500
          rounded-r-md
          text-bolt-elements-textSecondary
        ">
          Files matching "{searchQuery}" will be shown in the Files tab
        </div>
      )}
    </div>
  );
};
