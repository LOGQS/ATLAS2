import React from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useCoderContext } from '../../contexts/CoderContext';
import { FileTree } from './FileTree';
import { SearchPanel } from './SearchPanel';
import { Icons } from '../ui/Icons';

export const TabbedSidebar: React.FC = () => {
  const { activeTab, setActiveTab, loadFileTree, isLoading, startCreatingFile, startCreatingFolder } = useCoderContext();

  const handleTabChange = (value: string) => {
    if (value === 'files' || value === 'search') {
      setActiveTab(value);
    }
  };

  return (
    <Tabs.Root value={activeTab} onValueChange={handleTabChange} className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
        <Tabs.List className="flex items-center gap-1">
          <Tabs.Trigger
            value="files"
            className="
              px-3 py-1.5 text-xs font-medium rounded-md
              bg-transparent
              text-bolt-elements-textSecondary
              hover:bg-bolt-elements-background-depth-3
              hover:text-bolt-elements-textPrimary
              data-[state=active]:bg-bolt-elements-item-backgroundAccent
              data-[state=active]:text-bolt-elements-item-contentAccent
              transition-all duration-150
              flex items-center gap-1.5
            "
          >
            <Icons.Files size={14} />
            Files
          </Tabs.Trigger>
          <Tabs.Trigger
            value="search"
            className="
              px-3 py-1.5 text-xs font-medium rounded-md
              bg-transparent
              text-bolt-elements-textSecondary
              hover:bg-bolt-elements-background-depth-3
              hover:text-bolt-elements-textPrimary
              data-[state=active]:bg-bolt-elements-item-backgroundAccent
              data-[state=active]:text-bolt-elements-item-contentAccent
              transition-all duration-150
              flex items-center gap-1.5
            "
          >
            <Icons.Search size={14} />
            Search
          </Tabs.Trigger>
        </Tabs.List>

        {activeTab === 'files' && (
          <div className="flex items-center gap-1">
            <button
              onClick={startCreatingFile}
              className="
                w-7 h-7 flex items-center justify-center
                rounded-md
                bg-transparent
                text-gray-400
                hover:text-sky-400
                hover:bg-sky-950/40
                active:bg-sky-950/60
                transition-all duration-200
              "
              title="New File"
            >
              <Icons.NewFile size={16} />
            </button>
            <button
              onClick={startCreatingFolder}
              className="
                w-7 h-7 flex items-center justify-center
                rounded-md
                bg-transparent
                text-gray-400
                hover:text-yellow-400
                hover:bg-yellow-950/40
                active:bg-yellow-950/60
                transition-all duration-200
              "
              title="New Folder"
            >
              <Icons.NewFolder size={16} />
            </button>
            <button
              onClick={loadFileTree}
              disabled={isLoading}
              className="
                w-7 h-7 flex items-center justify-center
                rounded-md
                bg-transparent
                text-gray-400
                hover:text-emerald-400
                hover:bg-emerald-950/40
                active:bg-emerald-950/60
                disabled:opacity-30
                disabled:cursor-not-allowed
                disabled:hover:bg-transparent
                disabled:hover:text-gray-400
                transition-all duration-200
              "
              title="Refresh"
            >
              <Icons.Refresh size={16} className={isLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        )}
      </div>

      <Tabs.Content value="files" className="flex-1 overflow-auto modern-scrollbar focus-visible:outline-none">
        <FileTree />
      </Tabs.Content>

      <Tabs.Content value="search" className="flex-1 overflow-auto modern-scrollbar focus-visible:outline-none">
        <SearchPanel />
      </Tabs.Content>
    </Tabs.Root>
  );
};
