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
import { IDEMenuBar } from '../components/coder/IDEMenuBar';
import { StatusBar } from '../components/coder/StatusBar';
import { ActivityChatPanel } from '../components/coder/ActivityChatPanel';
import { Slider, type SliderOptions } from '../components/ui/Slider';
import { Icons } from '../components/ui/Icons';
import { configureMonaco } from '../config/monaco';
import '../styles/sections/CoderWindow.css';
import logger from '../utils/core/logger';
import { liveStore, type CoderStreamSegment } from '../utils/chat/LiveStore';

interface CoderWindowProps {
  isOpen?: boolean;
  chatId?: string;
  fullscreen?: boolean;
  onBackToChat?: () => void;
  onWorkspaceReady?: () => void;
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


interface CoderWindowContentProps {
  fullscreen?: boolean;
  onBackToChat?: () => void;
}

const CoderWindowContent: React.FC<CoderWindowContentProps> = ({ fullscreen = false, onBackToChat }) => {
  const {
    chatId,
    hasWorkspace,
    workspaceName,
    currentDocument,
    activeTabPath,
    unsavedFiles,
    error,
    isLoading,
    showTerminal,
    splitMode,
    activePaneId,
    panes,
    openTabs,
    isGitRepo,
    checkpoints,
    currentPlan,
    pendingDiffs,
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
    acceptAllDiffs,
    rejectAllDiffs,
  } = useCoderContext();

  const [selectedView, setSelectedView] = React.useState<ViewType>('code');
  const [isHistoryPanelOpen, setIsHistoryPanelOpen] = useState(false);
  const [isWorkspaceHistoryOpen, setIsWorkspaceHistoryOpen] = useState(false);
  const [isQuickSearchOpen, setIsQuickSearchOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [autoAcceptTools, setAutoAcceptTools] = useState(() => {
    return localStorage.getItem('coder-auto-accept') === 'true';
  });
  const [domainExecution, setDomainExecution] = useState<any>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [coderStream, setCoderStream] = useState<CoderStreamSegment[]>([]);
  const monacoConfigured = useRef(false);
  const sidebarDefaultSize = 22;
  const editorDefaultSize = 100 - sidebarDefaultSize;
  const panelGroupKey = 'coder-horizontal';

  // Handle auto-accept toggle
  const handleAutoAcceptToggle = useCallback(() => {
    const newValue = !autoAcceptTools;
    setAutoAcceptTools(newValue);
    localStorage.setItem('coder-auto-accept', String(newValue));

    // Dispatch storage event for other components (like DomainBox) to pick up
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'coder-auto-accept',
      newValue: String(newValue),
      oldValue: String(!newValue),
      storageArea: localStorage,
    }));
  }, [autoAcceptTools]);

  // Workspace picker is now handled in chat flow - modal only shown on manual trigger
  // No auto-show on mount

  const handleCloseModal = useCallback(() => {
    setIsWorkspaceModalOpen(false);
  }, []);

  const handleWorkspaceSelected = useCallback(async (workspace: string) => {
    logger.info('[CoderWindow] Workspace selected:', workspace);
    await setWorkspace(workspace);
    setIsWorkspaceModalOpen(false);
  }, [setWorkspace]);

  // Debug logging - intentionally logging mount-time values only
  React.useEffect(() => {
    logger.info('[CoderWindow] Component mounted', { hasWorkspace, showTerminal });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    logger.info('[CoderWindow] State changed:', { hasWorkspace, currentDocument: !!currentDocument, showTerminal });
  }, [hasWorkspace, currentDocument, showTerminal]);

  // Subscribe to execution data from liveStore
  React.useEffect(() => {
    if (!chatId) return;

    const unsubscribe = liveStore.subscribe(chatId, (id, snap) => {
      setDomainExecution(snap.domainExecution);
      setIsProcessing(snap.state === 'thinking' || snap.state === 'responding');

      // Log coderStream updates with detailed segment info
      if (snap.coderStream.length > 0) {
        const toolCalls = snap.coderStream.filter(s => s.type === 'tool_call');
        const streamingTools = toolCalls.filter(s => s.status === 'streaming');
        logger.info(`[SSE-UPDATE] Received coderStream update: ${snap.coderStream.length} segments, ${toolCalls.length} tool_calls, ${streamingTools.length} streaming`);

        streamingTools.forEach(tool => {
          if (tool.type === 'tool_call') {
            const params = tool.params.map(p => `${p.name}=${p.value ? `${p.value.length}b` : 'null'}`).join(', ');
            logger.info(`[SSE-UPDATE] Streaming tool: ${tool.tool} (id=${tool.id}) params: ${params}`);
          }
        });
      }

      setCoderStream(snap.coderStream);
    });

    return unsubscribe;
  }, [chatId]);

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
    <div className={`coder-window-v2 ${fullscreen ? 'coder-window-fullscreen' : ''}`}>
      {/* IDE Menu Bar */}
      {onBackToChat && (
        <IDEMenuBar
          onBackToChat={onBackToChat}
          workspace={workspaceName}
          onOpenWorkspace={() => setIsWorkspaceModalOpen(true)}
          onSave={currentDocument && isFileUnsaved ? handleSaveFile : undefined}
          onToggleTerminal={toggleTerminal}
        />
      )}

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

      {/* Workspace Picker Modal - shown as fallback if no workspace */}
      <WorkspacePickerModal
        isOpen={isWorkspaceModalOpen}
        onClose={handleCloseModal}
        onWorkspaceSelected={handleWorkspaceSelected}
        chatId={chatId}
      />

      {hasWorkspace && (
        <div className="coder-workbench-container">
          <div className="coder-workbench-wrapper">
            {/* Top Toolbar - iOS-like with grouped sections */}
            <div className="coder-toolbar">
              <div className="coder-toolbar__section">
                <Slider
                  selected={selectedView}
                  options={sliderOptions}
                  setSelected={setSelectedView}
                />
              </div>

              <div className="coder-toolbar__section">
                <button
                  onClick={() => setIsWorkspaceHistoryOpen(true)}
                  className="coder-toolbar__button"
                  title="View workspace history"
                >
                  <Icons.History className="w-3.5 h-3.5" />
                  <span>Workspace History</span>
                </button>
              </div>

              <div className="coder-toolbar__section">
                <button
                  onClick={handleAutoAcceptToggle}
                  className={`coder-toolbar__button ${autoAcceptTools ? 'coder-toolbar__button--active coder-toolbar__button--auto-accept' : ''}`}
                  title={autoAcceptTools ? 'Disable auto-accept (tools will require manual approval)' : 'Enable auto-accept (tools will execute automatically)'}
                >
                  <Icons.Zap className="w-3.5 h-3.5" />
                  <span>Auto-Accept</span>
                  {autoAcceptTools && <span className="coder-toolbar__badge">ON</span>}
                </button>
              </div>

              <div className="coder-toolbar__spacer" />
              {selectedView === 'code' && (
                <div className="coder-toolbar__section coder-toolbar__section--actions">
                  {splitMode === 'none' ? (
                    <>
                      <button
                        onClick={splitEditorHorizontal}
                        className="coder-toolbar__button"
                        title="Split editor horizontally"
                      >
                        <Icons.ChevronRight className="w-3.5 h-3.5" />
                        <span>Split Horizontal</span>
                      </button>
                      <button
                        onClick={splitEditorVertical}
                        className="coder-toolbar__button"
                        title="Split editor vertically"
                      >
                        <Icons.ChevronDown className="w-3.5 h-3.5" />
                        <span>Split Vertical</span>
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={closeSplit}
                      className="coder-toolbar__button"
                      title="Close split view"
                    >
                      <Icons.Close className="w-3.5 h-3.5" />
                      <span>Close Split</span>
                    </button>
                  )}
                  <div className="coder-toolbar__separator" />
                  <button
                    onClick={toggleTerminal}
                    className={`coder-toolbar__button ${showTerminal ? 'coder-toolbar__button--active' : ''}`}
                    title={showTerminal ? 'Hide terminal (Ctrl+`)' : 'Show terminal (Ctrl+`)'}
                  >
                    <Icons.Terminal className="w-3.5 h-3.5" />
                    <span>{showTerminal ? 'Hide' : 'Show'} Terminal</span>
                  </button>
                </div>
              )}
            </div>

            {/* Main Content Area with Panels */}
            <div className="flex-1 overflow-hidden">
              <PanelGroup direction="horizontal">
                {/* Left Side: Sidebar + Editor + Terminal */}
                <Panel
                  id="main-content"
                  order={1}
                  defaultSize={70}
                  minSize={40}
                >
                  <PanelGroup direction="vertical">
                    {/* Editor/Terminal Split */}
                    <Panel
                      id="editor-area"
                      order={1}
                      defaultSize={showTerminal ? 70 : 100}
                      minSize={20}
                    >
                      <PanelGroup
                        key={panelGroupKey}
                        direction="horizontal"
                      >
                        {/* Sidebar Panel */}
                        <Panel
                          id="sidebar"
                          order={1}
                          defaultSize={sidebarDefaultSize}
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
                        <Panel
                          id="editor"
                          order={2}
                          defaultSize={editorDefaultSize}
                          minSize={20}
                          className="flex flex-col"
                        >
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
                              chatId={chatId}
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
                                  chatId={chatId}
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
                                  chatId={chatId}
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
            </Panel>

            {/* Resize Handle */}
            <PanelResizeHandle className="w-1 bg-bolt-elements-borderColor hover:bg-blue-500 transition-colors" />

            {/* Right Side: Activity & Chat Panel */}
            <Panel
              id="activity-panel"
              order={2}
              defaultSize={30}
              minSize={20}
              maxSize={50}
            >
              <ActivityChatPanel
                chatId={chatId}
                currentPlan={currentPlan}
                checkpoints={checkpoints}
                pendingDiffsCount={pendingDiffs.size}
                onAcceptAllDiffs={acceptAllDiffs}
                onRejectAllDiffs={rejectAllDiffs}
                domainExecution={domainExecution}
                isProcessing={isProcessing}
                autoAcceptEnabled={autoAcceptTools}
                coderStream={coderStream}
              />
            </Panel>
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

      {/* Status Bar */}
      {hasWorkspace && (
        <StatusBar
          workspace={workspaceName}
          isGitRepo={isGitRepo}
          gitBranch="main"
          fileCount={openTabs.length}
          unsavedCount={unsavedFiles.size}
          modelName={domainExecution?.metadata?.current_model || "gemini-2.5-pro"}
          onWorkspaceClick={() => setIsWorkspaceModalOpen(true)}
        />
      )}
    </div>
  );
};

const CoderWindow: React.FC<CoderWindowProps> = ({ isOpen = true, chatId, fullscreen = true, onBackToChat, onWorkspaceReady }) => {
  if (!isOpen) return null;

  return (
    <CoderProvider chatId={chatId} onWorkspaceReady={onWorkspaceReady}>
      <CoderWindowContent fullscreen={fullscreen} onBackToChat={onBackToChat} />
    </CoderProvider>
  );
};

export default CoderWindow;
