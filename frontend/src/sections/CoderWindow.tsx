import React, { useEffect, useCallback, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { CoderProvider, useCoderContext } from '../contexts/CoderContext';
import { TabbedSidebar } from '../components/coder/TabbedSidebar';
import { TabBar } from '../components/coder/TabBar';
import { TerminalPanel } from '../components/coder/TerminalPanel';
import { WorkspacePickerModal } from '../components/coder/WorkspacePickerModal';
import { FileHistoryPanel } from '../components/coder/FileHistoryPanel';
import { WorkspaceHistoryPanel } from '../components/coder/WorkspaceHistoryPanel';
import { QuickFileSearch } from '../components/coder/QuickFileSearch';
import { CommandPalette } from '../components/coder/CommandPalette';
import { EditorPane } from '../components/coder/EditorPane';
import { Slider, type SliderOptions } from '../components/ui/Slider';
import { Icons } from '../components/ui/Icons';
import { configureMonaco } from '../config/monaco';
import '../styles/sections/CoderWindow.css';
import logger from '../utils/core/logger';

interface CoderWindowProps {
  isOpen: boolean;
  chatId?: string;
}

type ViewType = 'code' | 'preview';

const sliderOptions: SliderOptions<ViewType> = {
  left: {
    value: 'code',
    text: 'Code',
  },
  right: {
    value: 'preview',
    text: 'Preview',
  },
};

const CoderWindowContent: React.FC = () => {
  const {
    chatId,
    hasWorkspace,
    currentDocument,
    activeTabPath,
    unsavedFiles,
    error,
    isLoading,
    showTerminal,
    splitMode,
    activePaneId,
    panes,
    setWorkspace,
    updateFileContent,
    saveFile,
    resetFile,
    toggleTerminal,
    closeTab,
    setError,
    splitEditorHorizontal,
    splitEditorVertical,
    closeSplit,
    switchPane,
  } = useCoderContext();

  const [selectedView, setSelectedView] = React.useState<ViewType>('code');
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [isHistoryPanelOpen, setIsHistoryPanelOpen] = useState(false);
  const [isWorkspaceHistoryOpen, setIsWorkspaceHistoryOpen] = useState(false);
  const [isQuickSearchOpen, setIsQuickSearchOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const monacoConfigured = useRef(false);

  // Open modal when workspace is not set (only on mount or when hasWorkspace becomes false)
  useEffect(() => {
    if (!hasWorkspace && !isWorkspaceModalOpen) {
      setIsWorkspaceModalOpen(true);
    }
  }, [hasWorkspace, isWorkspaceModalOpen]);

  // Debug logging - intentionally logging mount-time values only
  React.useEffect(() => {
    logger.info('[CoderWindow] Component mounted', { hasWorkspace, showTerminal });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    logger.info('[CoderWindow] State changed:', { hasWorkspace, currentDocument: !!currentDocument, showTerminal });
  }, [hasWorkspace, currentDocument, showTerminal]);

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      updateFileContent(value);
    }
  }, [updateFileContent]);

  const handleSaveFile = useCallback(async () => {
    await saveFile();
  }, [saveFile]);

  const handleResetFile = useCallback(() => {
    resetFile();
  }, [resetFile]);

  const handleWorkspaceSelected = useCallback(async (path: string) => {
    logger.info('[CODER_WINDOW] workspace selected', { path });
    await setWorkspace(path);
    setIsWorkspaceModalOpen(false);
  }, [setWorkspace]);

  const handleCloseModal = useCallback(() => {
    // Only allow closing if workspace is already set
    if (hasWorkspace) {
      setIsWorkspaceModalOpen(false);
    }
  }, [hasWorkspace]);

  // Configure Monaco once before it mounts
  const handleEditorWillMount = useCallback((monaco: any) => {
    if (!monacoConfigured.current) {
      configureMonaco(monaco);
      monacoConfigured.current = true;
    }
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+S - Save file
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (currentDocument && unsavedFiles.has(currentDocument.filePath)) {
          handleSaveFile();
        }
      }
      // Ctrl+` - Toggle terminal
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault();
        logger.info('[CODER_WINDOW] toggle terminal via hotkey');
        toggleTerminal();
      }
      // Ctrl+W - Close active tab
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        if (activeTabPath) {
          closeTab(activeTabPath);
        }
      }
      // Ctrl+P - Quick file search
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setIsQuickSearchOpen(true);
      }
      // Ctrl+Shift+P - Command palette
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        setIsCommandPaletteOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentDocument, unsavedFiles, handleSaveFile, toggleTerminal, activeTabPath, closeTab]);

  const isFileUnsaved = currentDocument && unsavedFiles.has(currentDocument.filePath);

  logger.info('[CoderWindow] About to render, hasWorkspace:', hasWorkspace);

  return (
    <div className="coder-window-v2">
      {/* Workspace Picker Modal */}
      <AnimatePresence>
        {isWorkspaceModalOpen && (
          <WorkspacePickerModal
            isOpen={isWorkspaceModalOpen}
            onClose={handleCloseModal}
            onWorkspaceSelected={handleWorkspaceSelected}
            chatId={chatId}
          />
        )}
      </AnimatePresence>

      {/* Error Banner */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="error-banner"
          >
            <Icons.Close className="w-5 h-5 text-red-400" />
            <span className="error-message">{error}</span>
            <button
              className="error-close"
              onClick={() => setError('')}
            >
              <Icons.Close className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {hasWorkspace && (
        <div className="coder-workbench-container">
          <div className="coder-workbench-wrapper">
            {/* Top Toolbar */}
            <div className="flex items-center px-3 py-2 border-b border-bolt-elements-borderColor gap-1.5">
              <Slider
                selected={selectedView}
                options={sliderOptions}
                setSelected={setSelectedView}
              />
              <button
                onClick={() => setIsWorkspaceHistoryOpen(true)}
                className="
                  flex items-center gap-1.5 px-3 py-1.5
                  text-xs font-medium
                  bg-bolt-elements-bg-depth-2 text-bolt-elements-textPrimary
                  border border-bolt-elements-borderColor
                  rounded-md
                  hover:bg-bolt-elements-bg-depth-3
                  transition-colors duration-150
                "
                title="View workspace history"
              >
                <Icons.History className="w-3.5 h-3.5" />
                Workspace History
              </button>
              <div className="ml-auto" />
              {selectedView === 'code' && (
                <>
                  {splitMode === 'none' ? (
                    <>
                      <button
                        onClick={splitEditorHorizontal}
                        className="
                          flex items-center gap-1.5 px-3 py-1.5
                          text-xs font-medium
                          bg-bolt-elements-bg-depth-2 text-bolt-elements-textPrimary
                          border border-bolt-elements-borderColor
                          rounded-md
                          hover:bg-bolt-elements-bg-depth-3
                          transition-colors duration-150
                        "
                        title="Split editor horizontally"
                      >
                        <Icons.ChevronRight className="w-3.5 h-3.5" />
                        Split Horizontal
                      </button>
                      <button
                        onClick={splitEditorVertical}
                        className="
                          flex items-center gap-1.5 px-3 py-1.5
                          text-xs font-medium
                          bg-bolt-elements-bg-depth-2 text-bolt-elements-textPrimary
                          border border-bolt-elements-borderColor
                          rounded-md
                          hover:bg-bolt-elements-bg-depth-3
                          transition-colors duration-150
                        "
                        title="Split editor vertically"
                      >
                        <Icons.ChevronDown className="w-3.5 h-3.5" />
                        Split Vertical
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={closeSplit}
                      className="
                        flex items-center gap-1.5 px-3 py-1.5
                        text-xs font-medium
                        bg-bolt-elements-bg-depth-2 text-bolt-elements-textPrimary
                        border border-bolt-elements-borderColor
                        rounded-md
                        hover:bg-bolt-elements-bg-depth-3
                        transition-colors duration-150
                      "
                      title="Close split view"
                    >
                      <Icons.Close className="w-3.5 h-3.5" />
                      Close Split
                    </button>
                  )}
                  <button
                    onClick={toggleTerminal}
                    className="
                      flex items-center gap-1.5 px-3 py-1.5
                      text-xs font-medium
                      bg-bolt-elements-bg-depth-2 text-bolt-elements-textPrimary
                      border border-bolt-elements-borderColor
                      rounded-md
                      hover:bg-bolt-elements-bg-depth-3
                      hover:border-bolt-elements-borderColorActive
                      transition-all duration-150
                    "
                    title={showTerminal ? 'Hide terminal (Ctrl+`)' : 'Show terminal (Ctrl+`)'}
                  >
                    <Icons.Terminal className="w-3.5 h-3.5" />
                    {showTerminal ? 'Hide' : 'Show'} Terminal
                  </button>
                </>
              )}
            </div>

            {/* Main Content Area with Panels */}
            <div className="flex-1 overflow-hidden">
              <PanelGroup direction="vertical">
                {/* Editor/Terminal Split */}
                <Panel
                  id="editor-area"
                  order={1}
                  defaultSize={showTerminal ? 70 : 100}
                  minSize={20}
                >
                  <PanelGroup direction="horizontal">
                    {/* Sidebar Panel */}
                    <Panel
                      id="sidebar"
                      order={1}
                      defaultSize={20}
                      minSize={15}
                      collapsible
                      className="border-r border-bolt-elements-borderColor"
                    >
                      <div className="h-full flex flex-col bg-bolt-elements-background-depth-2">
                        <TabbedSidebar />
                      </div>
                    </Panel>

                    {/* Resize Handle */}
                    <PanelResizeHandle className="w-1 bg-bolt-elements-borderColor hover:bg-blue-500 transition-colors" />

                    {/* Editor Panel */}
                    <Panel id="editor" order={2} defaultSize={80} minSize={20} className="flex flex-col">
                      <div className="h-full flex flex-col" style={{background: 'var(--bolt-elements-bg-depth-1)'}}>
                        {/* Tab Bar */}
                        <TabBar />

                        {/* Editor Area - Single or Split */}
                        <div className="flex-1 overflow-hidden flex" style={{ minHeight: 0 }}>
                          {splitMode === 'none' ? (
                            /* Single Editor View */
                            <EditorPane
                              document={currentDocument}
                              isUnsaved={!!isFileUnsaved}
                              isLoading={isLoading}
                              isActive={true}
                              onContentChange={handleEditorChange}
                              onSave={handleSaveFile}
                              onReset={handleResetFile}
                              onHistoryClick={() => setIsHistoryPanelOpen(true)}
                              onEditorWillMount={handleEditorWillMount}
                              onPaneClick={() => {}}
                            />
                          ) : (
                            /* Split Editor View */
                            <PanelGroup
                              direction={splitMode === 'horizontal' ? 'horizontal' : 'vertical'}
                              className="flex-1"
                              style={{ minHeight: 0 }}
                            >
                              {/* Primary Pane */}
                              <Panel
                                id="editor-primary"
                                order={1}
                                defaultSize={50}
                                minSize={20}
                              >
                                <EditorPane
                                  document={panes.primary.currentDocument}
                                  isUnsaved={panes.primary.currentDocument ? unsavedFiles.has(panes.primary.currentDocument.filePath) : false}
                                  isLoading={isLoading}
                                  isActive={activePaneId === 'primary'}
                                  onContentChange={handleEditorChange}
                                  onSave={handleSaveFile}
                                  onReset={handleResetFile}
                                  onHistoryClick={() => setIsHistoryPanelOpen(true)}
                                  onEditorWillMount={handleEditorWillMount}
                                  onPaneClick={() => switchPane('primary')}
                                />
                              </Panel>

                              {/* Resize Handle */}
                              <PanelResizeHandle className={splitMode === 'horizontal' ? 'w-1 bg-bolt-elements-borderColor hover:bg-blue-500 transition-colors' : 'h-1 bg-bolt-elements-borderColor hover:bg-blue-500 transition-colors'} />

                              {/* Secondary Pane */}
                              <Panel
                                id="editor-secondary"
                                order={2}
                                defaultSize={50}
                                minSize={20}
                              >
                                <EditorPane
                                  document={panes.secondary.currentDocument}
                                  isUnsaved={panes.secondary.currentDocument ? unsavedFiles.has(panes.secondary.currentDocument.filePath) : false}
                                  isLoading={isLoading}
                                  isActive={activePaneId === 'secondary'}
                                  onContentChange={handleEditorChange}
                                  onSave={handleSaveFile}
                                  onReset={handleResetFile}
                                  onHistoryClick={() => setIsHistoryPanelOpen(true)}
                                  onEditorWillMount={handleEditorWillMount}
                                  onPaneClick={() => switchPane('secondary')}
                                />
                              </Panel>
                            </PanelGroup>
                          )}
                        </div>
                      </div>
                    </Panel>
                  </PanelGroup>
                </Panel>

                {/* Terminal Panel - Conditionally rendered with proper ordering */}
                {showTerminal && (
                  <>
                    <PanelResizeHandle className="h-1 bg-bolt-elements-borderColor hover:bg-blue-500 transition-colors" />
                    <Panel id="terminal" order={2} defaultSize={30} minSize={15}>
                      <TerminalPanel />
                    </Panel>
                  </>
                )}
              </PanelGroup>
            </div>
          </div>

          {/* File History Panel */}
          {currentDocument && (
            <FileHistoryPanel
              isOpen={isHistoryPanelOpen}
              onClose={() => setIsHistoryPanelOpen(false)}
              filePath={currentDocument.filePath}
            />
          )}

          {/* Workspace History Panel */}
          <WorkspaceHistoryPanel
            isOpen={isWorkspaceHistoryOpen}
            onClose={() => setIsWorkspaceHistoryOpen(false)}
          />

          {/* Quick File Search */}
          <QuickFileSearch
            isOpen={isQuickSearchOpen}
            onClose={() => setIsQuickSearchOpen(false)}
          />

          {/* Command Palette */}
          <CommandPalette
            isOpen={isCommandPaletteOpen}
            onClose={() => setIsCommandPaletteOpen(false)}
          />
        </div>
      )}
    </div>
  );
};

const CoderWindow: React.FC<CoderWindowProps> = ({ isOpen, chatId }) => {
  if (!isOpen) return null;

  return (
    <CoderProvider chatId={chatId}>
      <CoderWindowContent />
    </CoderProvider>
  );
};

export default CoderWindow;

