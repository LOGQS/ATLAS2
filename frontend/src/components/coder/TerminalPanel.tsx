import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { useCoderContext } from '../../contexts/CoderContext';
import { terminalApiUrl, terminalWsUrl } from '../../config/api';
import logger from '../../utils/core/logger';
import { Icons } from '../ui/Icons';
import 'xterm/css/xterm.css';

// Input batching removed - now using 10ms coalescing in queueInput
const TERMINAL_SCROLLBACK = 5000;
const DEFAULT_LINE_ENDING = '\n';
const WINDOWS_LINE_ENDING = '\r\n';
const CLEAR_SCREEN_SEQUENCE = '\u001b[2J\u001b[3J\u001b[H';

// Removed local echo detection - PTY handles all terminal semantics

interface SessionDescriptor {
  id: string;
  label: string;
  createdAt: number;
  isAlive: boolean;
  isConnected: boolean;
  platform?: string | null;
  shell?: string | null;
  lineEnding?: string | null;
}

interface SessionRuntime {
  terminal: Terminal;
  fitAddon: FitAddon;
  webLinksAddon: WebLinksAddon;
  socket: WebSocket | null;
  container: HTMLDivElement | null;
  isOpen: boolean;
  opening: boolean;
  inputBuffer: string;
  flushTimer: number | null;
  disposables: Array<{ dispose: () => void }>;
  lastWorkspaceSummary: string | null;
  pendingIntro: ((instance: Terminal) => void) | null;
  pendingOutput: string[];
  hasShownIntro: boolean;
  platform: string | null;
  shell: string | null;
  preferredLineEnding: string;
  localEchoBuffer: string; // Characters we've shown optimistically but PTY hasn't confirmed yet
}

const isWindowsPlatformName = (platform?: string | null) => {
  if (!platform) {
    return false;
  }
  const normalized = platform.toLowerCase();
  return (
    normalized.startsWith('win') ||
    normalized.includes('msys') ||
    normalized.includes('cygwin')
  );
};

const resolvePreferredLineEnding = (
  lineEnding: string | null | undefined,
  platform?: string | null,
) => {
  if (lineEnding === WINDOWS_LINE_ENDING) {
    return WINDOWS_LINE_ENDING;
  }
  if (lineEnding === DEFAULT_LINE_ENDING) {
    return DEFAULT_LINE_ENDING;
  }
  if (typeof lineEnding === 'string' && lineEnding.trim() === '') {
    return WINDOWS_LINE_ENDING;
  }
  if (typeof lineEnding === 'string') {
    if (lineEnding.includes('\r') && lineEnding.includes('\n')) {
      return WINDOWS_LINE_ENDING;
    }
    if (lineEnding.includes('\r')) {
      return WINDOWS_LINE_ENDING;
    }
    if (lineEnding.includes('\n')) {
      return DEFAULT_LINE_ENDING;
    }
  }
  if (isWindowsPlatformName(platform)) {
    return WINDOWS_LINE_ENDING;
  }
  return DEFAULT_LINE_ENDING;
};

const writeBanner = (terminal: Terminal) => {
  terminal.writeln('\x1b[1;36mAtlas Interactive Terminal\x1b[0m');
  terminal.writeln('\x1b[36m----------------------------------------\x1b[0m');
  terminal.writeln('');
};

const writeWorkspaceSummary = (terminal: Terminal, workspacePath?: string) => {
  if (workspacePath) {
    terminal.writeln(`\x1b[1;32mWorkspace:\x1b[0m ${workspacePath}`);
  } else {
    terminal.writeln('\x1b[33mNo workspace selected\x1b[0m');
  }
  terminal.writeln('');
};

const parseCreatedAt = (value: unknown): number => {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
};

const isPrintableInput = (data: string): boolean => {
  // Check if input is printable characters (not control sequences)
  // Allow: letters, numbers, spaces, punctuation, Enter, Tab
  // Disallow: escape sequences, Ctrl+C, Ctrl+D, arrow keys, etc.
  if (!data || data.length === 0) return false;

  // Single printable ASCII character (space to ~)
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    return (code >= 32 && code <= 126) || code === 13 || code === 10 || code === 9;
  }

  // Multi-character input - only allow if all printable
  return data.split('').every(char => {
    const code = char.charCodeAt(0);
    return (code >= 32 && code <= 126) || code === 13 || code === 10 || code === 9;
  });
};

const writeRemoteChunk = (runtime: SessionRuntime, chunk: string) => {
  if (!chunk) {
    return;
  }

  // Queue output if terminal not yet open
  if (!runtime.isOpen) {
    runtime.pendingOutput.push(chunk);
    return;
  }

  // Smart echo suppression: if PTY is echoing what we already showed optimistically, suppress it
  if (runtime.localEchoBuffer.length > 0) {
    // Check if the incoming chunk starts with our local echo buffer
    if (chunk.startsWith(runtime.localEchoBuffer)) {
      // Perfect match - PTY confirmed our optimistic echo
      const remaining = chunk.slice(runtime.localEchoBuffer.length);
      runtime.localEchoBuffer = ''; // Clear buffer
      if (remaining) {
        runtime.terminal.write(remaining); // Only write what's new
      }
      return;
    }

    // Check if our local echo buffer starts with the incoming chunk (partial confirmation)
    if (runtime.localEchoBuffer.startsWith(chunk)) {
      // PTY is confirming part of what we showed - remove confirmed part
      runtime.localEchoBuffer = runtime.localEchoBuffer.slice(chunk.length);
      return; // Don't write - already displayed
    }

    // No match - something unexpected happened (tab completion, password masking, etc.)
    // Clear buffer and show everything from PTY
    runtime.localEchoBuffer = '';
  }

  // Write PTY output directly to terminal
  runtime.terminal.write(chunk);
};

export const TerminalPanel: React.FC = () => {
  const { chatId, workspacePath } = useCoderContext();
  const workspacePathRef = useRef<string>('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionsRef = useRef<Map<string, SessionRuntime>>(new Map());
  const containerCallbacksRef = useRef<Map<string, (node: HTMLDivElement | null) => void>>(new Map());
  const creatingSessionRef = useRef<boolean>(false);
  const focusRequestRef = useRef<boolean>(false);
  const [sessions, setSessions] = useState<SessionDescriptor[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const nextNameIndexRef = useRef<number>(1);
  const destroyedRef = useRef<boolean>(false);
  const [initializationError, setInitializationError] = useState<string | null>(null);

  const cleanupRuntime = useCallback((sessionId: string) => {
    const runtime = sessionsRef.current.get(sessionId);
    if (!runtime) {
      return;
    }

    if (runtime.socket) {
      try {
        runtime.socket.close();
      } catch (error) {
        logger.warn('[TERMINAL] Failed to close socket during cleanup:', error);
      }
      runtime.socket = null;
    }

    if (typeof window !== 'undefined' && runtime.flushTimer !== null) {
      window.clearTimeout(runtime.flushTimer);
    }

    runtime.flushTimer = null;
    runtime.inputBuffer = '';
    runtime.pendingOutput = [];
    runtime.localEchoBuffer = ''; // Clear optimistic echo buffer

    runtime.disposables.forEach((disposable) => {
      try {
        disposable.dispose();
      } catch (error) {
        logger.warn('[TERMINAL] Failed to dispose terminal resource:', error);
      }
    });
    runtime.disposables = [];

    try {
      runtime.fitAddon.dispose();
    } catch (error) {
      logger.warn('[TERMINAL] Failed to dispose fit addon:', error);
    }

    try {
      runtime.webLinksAddon.dispose();
    } catch (error) {
      logger.warn('[TERMINAL] Failed to dispose web links addon:', error);
    }

    try {
      runtime.terminal.dispose();
    } catch (error) {
      logger.warn('[TERMINAL] Failed to dispose terminal instance:', error);
    }

    sessionsRef.current.delete(sessionId);
    containerCallbacksRef.current.delete(sessionId);
  }, []);

  const sendInputChunk = useCallback((sessionId: string, chunk: string): boolean => {
    if (!chunk) {
      return true;
    }

    const runtime = sessionsRef.current.get(sessionId);
    if (!runtime) {
      return false;
    }

    const socket = runtime.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      logger.debug('[TERMINAL_WS] Socket not ready for input', {
        sessionId,
        readyState: socket ? socket.readyState : null,
      });
      return false;
    }

    try {
      socket.send(JSON.stringify({ type: 'input', data: chunk }));
      return true;
    } catch (error) {
      logger.warn('[TERMINAL_WS] Failed to send input chunk', { sessionId, error });
      return false;
    }
  }, []);

  const flushInputBuffer = useCallback((sessionId: string) => {
    const runtime = sessionsRef.current.get(sessionId);
    if (!runtime) {
      return;
    }

    runtime.flushTimer = null;
    const chunk = runtime.inputBuffer;
    runtime.inputBuffer = '';

    if (!chunk) {
      return;
    }

    const sent = sendInputChunk(sessionId, chunk);
    if (!sent) {
      runtime.inputBuffer = chunk + runtime.inputBuffer;
      if (typeof window !== 'undefined') {
        runtime.flushTimer = window.setTimeout(() => flushInputBuffer(sessionId), 30);
      } else {
        setTimeout(() => flushInputBuffer(sessionId), 30);
      }
    }
  }, [sendInputChunk]);

  const queueInput = useCallback((sessionId: string, data: string) => {
    if (!data) {
      return;
    }

    const runtime = sessionsRef.current.get(sessionId);
    if (!runtime) {
      return;
    }

    // Append to buffer
    runtime.inputBuffer += data;

    // Cancel existing timer
    if (runtime.flushTimer !== null) {
      if (typeof window !== 'undefined') {
        window.clearTimeout(runtime.flushTimer);
      }
      runtime.flushTimer = null;
    }

    // Batch with very short delay (10ms) to coalesce rapid keystrokes
    // But flush immediately if buffer gets large
    if (typeof window === 'undefined' || runtime.inputBuffer.length > 50) {
      flushInputBuffer(sessionId);
      return;
    }

    runtime.flushTimer = window.setTimeout(() => flushInputBuffer(sessionId), 10);
  }, [flushInputBuffer]);

  const sendResize = useCallback((sessionId: string, rows: number, cols: number) => {
    if (!rows || !cols) {
      return;
    }

    const runtime = sessionsRef.current.get(sessionId);
    if (!runtime) {
      return;
    }

    const socket = runtime.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      logger.debug('[TERMINAL_WS] resize skipped; socket not ready', {
        sessionId,
        readyState: socket ? socket.readyState : null,
      });
      return;
    }

    try {
      socket.send(JSON.stringify({ type: 'resize', rows, cols }));
      logger.debug('[TERMINAL_WS] resize sent', { sessionId, rows, cols });
    } catch (error) {
      logger.warn('[TERMINAL_WS] failed to send resize event', { sessionId, error });
    }
  }, []);

  const createRuntime = useCallback(
    (
      sessionId: string,
      options?: {
        skipIntro?: boolean;
        platform?: string | null;
        shell?: string | null;
        lineEnding?: string | null;
      },
    ) => {
      logger.info('[TERMINAL_UI] createRuntime start', { sessionId, options });
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Monaco', monospace",
        theme: {
          background: '#1E1E1E',
          foreground: '#D4D4D4',
          cursor: '#AEAFAD',
          black: '#1E1E1E',
          red: '#CD3131',
          green: '#0DBC79',
          yellow: '#E5E510',
          blue: '#2472C8',
          magenta: '#BC3FBC',
          cyan: '#11A8CD',
          white: '#E5E5E5',
          brightBlack: '#666666',
          brightRed: '#F14C4C',
          brightGreen: '#23D18B',
          brightYellow: '#F5F543',
          brightBlue: '#3B8EEA',
          brightMagenta: '#D670D6',
          brightCyan: '#29B8DB',
          brightWhite: '#FFFFFF',
        },
        allowProposedApi: true,
        scrollback: TERMINAL_SCROLLBACK,
        tabStopWidth: 4,
      });
      try {
        // Reduce xterm internal console noise
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (terminal as any).setOption?.('logLevel', 'off');
      } catch (e) {
        logger.debug('[TERMINAL_UI] failed to set xterm logLevel', e);
      }

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);

      const resolvedPlatform = options?.platform ?? null;
      const resolvedShell = options?.shell ?? null;
      const resolvedLineEnding = resolvePreferredLineEnding(options?.lineEnding, resolvedPlatform);

      const runtime: SessionRuntime = {
        terminal,
        fitAddon,
        webLinksAddon,
        socket: null,
        container: null,
        isOpen: false,
        opening: false,
        inputBuffer: '',
        flushTimer: null,
        disposables: [],
        lastWorkspaceSummary: null,
        pendingIntro: null,
        pendingOutput: [],
        hasShownIntro: false,
        platform: resolvedPlatform,
        shell: resolvedShell,
        preferredLineEnding: resolvedLineEnding,
        localEchoBuffer: '', // Initialize optimistic echo buffer
      };

      sessionsRef.current.set(sessionId, runtime);

      const dataDisposable = terminal.onData((chunk) => {
        logger.debug('[TERMINAL_IO] onData', { sessionId, len: chunk?.length, sample: chunk?.slice?.(0, 40) });

        // OPTIMISTIC LOCAL ECHO: Show printable characters immediately for responsiveness
        // PTY will echo them back, but we'll suppress the duplicate in writeRemoteChunk
        if (isPrintableInput(chunk)) {
          runtime.terminal.write(chunk);
          runtime.localEchoBuffer += chunk;
          logger.debug('[TERMINAL_IO] local echo', { chunk, bufferLen: runtime.localEchoBuffer.length });
        }

        // Send to backend (PTY will process and echo back)
        queueInput(sessionId, chunk);
      });
      runtime.disposables.push({
        dispose: () => {
          try {
            dataDisposable.dispose();
          } catch (error) {
            logger.warn('[TERMINAL] Failed to dispose data listener:', error);
          }
        },
      });

      runtime.pendingIntro = options?.skipIntro
        ? (instance: Terminal) => {
            instance.writeln('\x1b[33mReattached to running session\x1b[0m');
            instance.writeln('');
            runtime.hasShownIntro = true;
            runtime.lastWorkspaceSummary = (workspacePathRef.current || '').trim() || null;
          }
        : (instance: Terminal) => {
            // Only show intro once per session
            if (!runtime.hasShownIntro) {
              const isWin = isWindowsPlatformName(runtime.platform);
              if (!isWin) {
                // Non-Windows: keep Atlas banner + workspace summary
                writeBanner(instance);
                const normalizedWorkspace = (workspacePathRef.current || '').trim();
                writeWorkspaceSummary(instance, normalizedWorkspace || undefined);
                runtime.lastWorkspaceSummary = normalizedWorkspace || null;
              } else {
                // Windows: let underlying cmd.exe print its own intro/prompt
                runtime.lastWorkspaceSummary = (workspacePathRef.current || '').trim() || null;
              }
              runtime.hasShownIntro = true;
            }
          };

      return runtime;
    },
    [queueInput],
  );

  const attachTerminalIfReady = useCallback((sessionId: string) => {
    const runtime = sessionsRef.current.get(sessionId);
    if (!runtime || !runtime.container || runtime.isOpen) {
      return;
    }
    if (runtime.opening) {
      return;
    }
    runtime.opening = true;
    runtime.terminal.open(runtime.container);
    runtime.isOpen = true;
    runtime.opening = false;
    logger.info('[TERMINAL_UI] terminal opened', { sessionId });

    if (runtime.pendingIntro) {
      try {
        runtime.pendingIntro(runtime.terminal);
      } catch (error) {
        logger.warn('[TERMINAL] Failed to render terminal intro:', error);
      } finally {
        runtime.pendingIntro = null;
      }
    }

    const fit = () => {
      try {
        runtime.fitAddon.fit();
      } catch (error) {
        logger.debug('[TERMINAL] Fit failed (likely hidden container):', error);
      }
      try {
        const r = runtime.terminal.rows;
        const c = runtime.terminal.cols;
        if (r && c) {
          sendResize(sessionId, r, c);
        }
      } catch {
        // ignore
      }
    };

    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(fit);
    } else {
      fit();
    }

    if (runtime.pendingOutput.length > 0) {
      const queued = runtime.pendingOutput.slice();
      runtime.pendingOutput = [];
      queued.forEach((chunk) => writeRemoteChunk(runtime, chunk));
    }

    // Propagate future terminal resize events to backend PTY
    try {
      const resizeDisposable = runtime.terminal.onResize(({ rows, cols }) => {
        sendResize(sessionId, rows, cols);
      });
      runtime.disposables.push({
        dispose: () => {
          try { resizeDisposable.dispose(); } catch {}
        },
      });
    } catch (e) {
      logger.debug('[TERMINAL_UI] failed to register onResize', e);
    }
  }, [sendResize]);

  const updateSessionDescriptor = useCallback((sessionId: string, patch: Partial<SessionDescriptor>) => {
    setSessions((prev) =>
      prev.map((session) => (session.id === sessionId ? { ...session, ...patch } : session)),
    );
  }, []);

  const startStreaming = useCallback((sessionId: string) => {
    const runtime = sessionsRef.current.get(sessionId);
    if (!runtime) {
      return;
    }

    if (runtime.socket) {
      try {
        runtime.socket.close();
      } catch (error) {
        logger.warn('[TERMINAL_WS] Failed to close existing socket', { sessionId, error });
      }
      runtime.socket = null;
    }

    const streamUrl = `${terminalWsUrl('/api/terminal/stream')}?session_id=${encodeURIComponent(sessionId)}`;
    logger.info('[TERMINAL_WS] connect', { sessionId, streamUrl });

    const socket = new WebSocket(streamUrl);
    socket.binaryType = 'arraybuffer';
    runtime.socket = socket;

    runtime.disposables.push({
      dispose: () => {
        try {
          socket.close();
        } catch (error) {
          logger.warn('[TERMINAL_WS] Failed to dispose socket', { sessionId, error });
        }
      },
    });

    const processPayload = (raw: string) => {
      if (!raw) {
        return;
      }

      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        logger.warn('[TERMINAL_WS] Failed to parse payload', { sessionId, error });
        return;
      }

      if (!payload || (payload.session_id && payload.session_id !== sessionId)) {
        return;
      }

      const currentRuntime = sessionsRef.current.get(sessionId);
      if (!currentRuntime) {
        return;
      }

      switch (payload.type) {
        case 'ready': {
          logger.info('[TERMINAL_WS] ready', { sessionId, payload });
          const isAlive = payload.is_alive !== false;
          const incomingPlatform =
            typeof payload.platform === 'string' ? payload.platform : currentRuntime.platform;
          const incomingShell =
            typeof payload.shell === 'string' ? payload.shell : currentRuntime.shell;
          const incomingLineEnding =
            typeof payload.line_ending === 'string' ? payload.line_ending : undefined;

          currentRuntime.platform = incomingPlatform ?? currentRuntime.platform ?? null;
          currentRuntime.shell = incomingShell ?? currentRuntime.shell ?? null;
          currentRuntime.preferredLineEnding = resolvePreferredLineEnding(
            incomingLineEnding,
            currentRuntime.platform,
          );

          updateSessionDescriptor(sessionId, {
            isAlive,
            isConnected: true,
            platform: currentRuntime.platform,
            shell: currentRuntime.shell,
            lineEnding: currentRuntime.preferredLineEnding,
          });

          if (currentRuntime.inputBuffer) {
            flushInputBuffer(sessionId);
          }
          break;
        }
        case 'output': {
          const dataCandidate = typeof payload.data === 'string' ? payload.data : payload.output;
          if (typeof dataCandidate === 'string' && dataCandidate.length > 0) {
            writeRemoteChunk(currentRuntime, dataCandidate);
          }
          updateSessionDescriptor(sessionId, {
            isConnected: true,
            isAlive: true,
            platform: currentRuntime.platform,
            shell: currentRuntime.shell,
            lineEnding: currentRuntime.preferredLineEnding,
          });
          break;
        }
        case 'terminated': {
          logger.info('[TERMINAL_WS] terminated', { sessionId });
          updateSessionDescriptor(sessionId, { isAlive: false, isConnected: false });
          currentRuntime.terminal.writeln('\r\n\x1b[31mSession terminated\x1b[0m');
          break;
        }
        case 'error': {
          logger.warn('[TERMINAL_WS] error', { sessionId, payload });
          updateSessionDescriptor(sessionId, { isConnected: false });
          const message = typeof payload.message === 'string' ? payload.message : 'Terminal stream error';
          currentRuntime.terminal.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
          break;
        }
        default: {
          logger.debug('[TERMINAL_WS] unhandled payload type', {
            sessionId,
            payloadType: payload.type,
          });
          break;
        }
      }
    };

    socket.onopen = () => {
      logger.info('[TERMINAL_WS] open', { sessionId });
      updateSessionDescriptor(sessionId, { isConnected: true, isAlive: true });
      if (runtime.inputBuffer) {
        flushInputBuffer(sessionId);
      }
    };

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        processPayload(event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        const text = new TextDecoder('utf-8').decode(event.data);
        processPayload(text);
        return;
      }
      if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
        event.data
          .text()
          .then(processPayload)
          .catch((error) => {
            logger.warn('[TERMINAL_WS] Failed to decode blob payload', { sessionId, error });
          });
        return;
      }
      logger.warn('[TERMINAL_WS] Unsupported message format', { sessionId });
    };

    socket.onerror = (event) => {
      logger.warn('[TERMINAL_WS] socket error', { sessionId, event });
      updateSessionDescriptor(sessionId, { isConnected: false });
    };

    socket.onclose = (event) => {
      logger.info('[TERMINAL_WS] socket closed', {
        sessionId,
        code: event.code,
        reason: event.reason,
      });
      runtime.socket = null;
      updateSessionDescriptor(sessionId, { isConnected: false });
    };
  }, [flushInputBuffer, updateSessionDescriptor]);

  const createSession = useCallback(async () => {
    const normalizedWorkspace = (workspacePathRef.current || '').trim();

    if (!chatId) {
      setInitializationError('chat_id is required to start terminal sessions.');
      return null;
    }

    if (!normalizedWorkspace) {
      setInitializationError('Select a workspace before starting a terminal session.');
      return null;
    }

    if (creatingSessionRef.current) {
      logger.debug('[TERMINAL] Session creation already in progress, skipping duplicate request.');
      return null;
    }

    creatingSessionRef.current = true;

    try {
      setInitializationError(null);

      logger.info('[TERMINAL_UI] createSession request', { chatId, workspace: normalizedWorkspace });
      const response = await fetch(terminalApiUrl('/api/terminal/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, workspace_path: normalizedWorkspace }),
      });

      const payload = await response.json();
      if (!response.ok || !payload?.success) {
        const message = payload?.error || `Failed to create session (status ${response.status})`;
        throw new Error(message);
      }

      const sessionId = String(payload.session_id);
      logger.info('[TERMINAL_UI] createSession success', { sessionId, payload });

      if (destroyedRef.current) {
        logger.info('[TERMINAL_UI] component destroyed before session create applied; ignoring', { sessionId });
        return null;
      }
      const platform = typeof payload.platform === 'string' ? payload.platform : null;
      const shell = typeof payload.shell === 'string' ? payload.shell : null;
      const resolvedLineEnding = resolvePreferredLineEnding(
        typeof payload.line_ending === 'string' ? payload.line_ending : undefined,
        platform,
      );
      const runtime = createRuntime(sessionId, {
        platform,
        shell,
        lineEnding: typeof payload.line_ending === 'string' ? payload.line_ending : undefined,
      });
      if (runtime) {
        runtime.platform = runtime.platform ?? platform;
        runtime.shell = runtime.shell ?? shell;
        runtime.preferredLineEnding = runtime.preferredLineEnding || resolvedLineEnding;
      }
      const createdAt = parseCreatedAt(payload.created_at);
      const label = `Terminal ${nextNameIndexRef.current}`;
      nextNameIndexRef.current += 1;

      setSessions((prev) => [
        ...prev,
        {
          id: sessionId,
          label,
          createdAt,
          isAlive: true,
          isConnected: false,
          platform,
          shell,
          lineEnding: resolvedLineEnding,
        },
      ]);

      startStreaming(sessionId);
      setActiveSessionId(sessionId);

      return runtime;
    } catch (error) {
      logger.error('[TERMINAL] Failed to create terminal session:', error);
      if (!destroyedRef.current) {
        setInitializationError(error instanceof Error ? error.message : String(error));
      }
      return null;
    } finally {
      creatingSessionRef.current = false;
    }
  }, [chatId, createRuntime, startStreaming]);

  const handleContainerMount = useCallback((sessionId: string, node: HTMLDivElement | null) => {
    const runtime = sessionsRef.current.get(sessionId);
    if (!runtime) {
      return;
    }

    if (node) {
      // Only react when container actually changes or not open yet
      const sameNode = runtime.container === node;
      if (sameNode && runtime.isOpen) {
        return;
      }
      if (!sameNode) {
        runtime.container = node;
      }
      logger.debug('[TERMINAL_UI] container mounted', { sessionId, sameNode, isOpen: runtime.isOpen });
      if (!runtime.isOpen) {
        attachTerminalIfReady(sessionId);
      }
    } else if (runtime.container) {
      runtime.container = null;
      runtime.isOpen = false;
      logger.debug('[TERMINAL_UI] container unmounted', { sessionId });
    }
  }, [attachTerminalIfReady]);

  const getContainerCallback = useCallback(
    (sessionId: string) => {
      const existing = containerCallbacksRef.current.get(sessionId);
      if (existing) {
        return existing;
      }
      const callback: (node: HTMLDivElement | null) => void = (node) => {
        handleContainerMount(sessionId, node);
      };
      containerCallbacksRef.current.set(sessionId, callback);
      return callback;
    },
    [handleContainerMount],
  );

  const handleKillSession = useCallback(async (sessionId: string) => {
    cleanupRuntime(sessionId);

    setSessions((prev) => {
      const filtered = prev.filter((session) => session.id !== sessionId);
      if (filtered.length === 0) {
        setActiveSessionId(null);
      } else if (sessionId === activeSessionId) {
        const fallback = filtered[filtered.length - 1];
        focusRequestRef.current = true;
        setActiveSessionId(fallback.id);
      }
      return filtered;
    });

    try {
      await fetch(terminalApiUrl('/api/terminal/kill'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch (error) {
      logger.warn('[TERMINAL] Failed to kill session:', error);
    }
  }, [activeSessionId, cleanupRuntime]);

  const focusActiveTerminal = useCallback(() => {
    if (!activeSessionId) {
      return;
    }

    const runtime = sessionsRef.current.get(activeSessionId);
    if (!runtime) {
      return;
    }

    try {
      runtime.terminal.focus();
    } catch (error) {
      logger.debug('[TERMINAL] Failed to focus terminal:', error);
    }
  }, [activeSessionId]);

  const handleClearActiveSession = useCallback(() => {
    if (!activeSessionId) {
      return;
    }

    const runtime = sessionsRef.current.get(activeSessionId);
    if (!runtime) {
      return;
    }

    const windowsContext = isWindowsPlatformName(runtime.platform);
    const newline = runtime.preferredLineEnding || (windowsContext ? WINDOWS_LINE_ENDING : DEFAULT_LINE_ENDING);
    const clearCommand = windowsContext ? `cls${newline}` : `clear${newline}`;

    try {
      // Clear local echo buffer
      runtime.localEchoBuffer = '';

      // Queue the clear command to be sent to the shell
      queueInput(activeSessionId, clearCommand);
      if (windowsContext) {
        runtime.terminal.write(CLEAR_SCREEN_SEQUENCE);
      }
    } catch (error) {
      logger.warn('[TERMINAL] Failed to send clear command:', error);
    }

    focusActiveTerminal();
  }, [activeSessionId, focusActiveTerminal, queueInput]);

  const handleTerminalAreaMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      focusActiveTerminal();
    },
    [focusActiveTerminal],
  );

  useEffect(() => {
    destroyedRef.current = false;
    logger.info('[TERMINAL_UI] mount');

    const sessionMap = sessionsRef.current;
    const callbackMap = containerCallbacksRef.current;

    return () => {
      destroyedRef.current = true;
      logger.info('[TERMINAL_UI] unmount - cleaning all sessions');
      const sessionsToClean = Array.from(sessionMap.keys());
      sessionsToClean.forEach((sessionId) => cleanupRuntime(sessionId));
      sessionMap.clear();
      callbackMap.clear();
    };
  }, [cleanupRuntime]);

  useEffect(() => {
    const normalized = (workspacePath || '').trim();
    workspacePathRef.current = normalized;

    sessionsRef.current.forEach((runtime) => {
      if (normalized === runtime.lastWorkspaceSummary) {
        return;
      }

      if (runtime.pendingIntro) {
        return;
      }

      if (!normalized && runtime.lastWorkspaceSummary === null) {
        return;
      }

      // Avoid printing a custom summary on Windows; let cmd.exe prompt reflect cwd
      const isWin = isWindowsPlatformName(runtime.platform);
      if (runtime.isOpen && !isWin) {
        writeWorkspaceSummary(runtime.terminal, normalized || undefined);
      }

      runtime.lastWorkspaceSummary = normalized || null;
    });
  }, [workspacePath]);

  useEffect(() => {
    const normalizedWorkspace = (workspacePath || '').trim();

    if (!chatId || !normalizedWorkspace) {
      const sessionMap = sessionsRef.current;
      const sessionsToClean = Array.from(sessionMap.keys());
      sessionsToClean.forEach((sessionId) => cleanupRuntime(sessionId));
      sessionMap.clear();
      containerCallbacksRef.current.clear();
      creatingSessionRef.current = false;
      setSessions([]);
      setActiveSessionId(null);
      nextNameIndexRef.current = 1;
      setInitializationError(null);
      return;
    }

    let cancelled = false;

    const bootstrap = async () => {
      logger.info('[TERMINAL_UI] bootstrap', { chatId, workspacePath: normalizedWorkspace });
      const existingIds = Array.from(sessionsRef.current.keys());
      existingIds.forEach((sessionId) => cleanupRuntime(sessionId));
      sessionsRef.current.clear();
      containerCallbacksRef.current.clear();
      creatingSessionRef.current = false;
      setSessions([]);
      setActiveSessionId(null);
      nextNameIndexRef.current = 1;
      setInitializationError(null);

      try {
        const response = await fetch(terminalApiUrl('/api/terminal/list'));
        const payload = await response.json();
        logger.info('[TERMINAL_UI] list response', { ok: response.ok, count: Array.isArray(payload?.sessions) ? payload.sessions.length : -1 });

        if (cancelled || destroyedRef.current) {
          return;
        }

        if (!response.ok || !payload?.success) {
          const message = payload?.error || `Failed to list sessions (status ${response.status})`;
          throw new Error(message);
        }

        const items = Array.isArray(payload.sessions) ? payload.sessions : [];
        const relevant = items.filter(
          (item: any) =>
            typeof item?.session_id === 'string' &&
            (item.workspace_path === normalizedWorkspace || item.workspace_path === workspacePath),
        );

        relevant.sort((a: any, b: any) => parseCreatedAt(a.created_at) - parseCreatedAt(b.created_at));

        if (relevant.length === 0) {
          if (creatingSessionRef.current) {
            logger.info('[TERMINAL_UI] no relevant sessions; creation already in-flight, skipping');
          } else {
            logger.info('[TERMINAL_UI] no relevant sessions; creating fresh');
            await createSession();
          }
          return;
        }

        const descriptors: SessionDescriptor[] = relevant.map((item: any, index: number) => {
          const platform = typeof item.platform === 'string' ? item.platform : null;
          const shell = typeof item.shell === 'string' ? item.shell : null;
          const lineEnding = resolvePreferredLineEnding(
            typeof item.line_ending === 'string' ? item.line_ending : undefined,
            platform,
          );
          return {
            id: String(item.session_id),
            label: `Terminal ${index + 1}`,
            createdAt: parseCreatedAt(item.created_at),
            isAlive: Boolean(item.is_alive ?? true),
            isConnected: false,
            platform,
            shell,
            lineEnding,
          };
        });

        descriptors.forEach((descriptor) => {
          logger.debug('[TERMINAL_UI] reattach runtime', { id: descriptor.id, platform: descriptor.platform, shell: descriptor.shell });
          createRuntime(descriptor.id, {
            skipIntro: true,
            platform: descriptor.platform ?? null,
            shell: descriptor.shell ?? null,
            lineEnding: descriptor.lineEnding ?? undefined,
          });
        });

        nextNameIndexRef.current = descriptors.length + 1;
        setSessions(descriptors);

        descriptors.forEach((descriptor) => {
          logger.debug('[TERMINAL_WS] start streaming', { id: descriptor.id });
          startStreaming(descriptor.id);
        });

        const lastId = descriptors[descriptors.length - 1]?.id ?? null;
        setActiveSessionId(lastId);
      } catch (error) {
        if (cancelled || destroyedRef.current) {
          return;
        }
        logger.warn('[TERMINAL] Bootstrap failed, creating fresh session:', error);
        setInitializationError(error instanceof Error ? error.message : String(error));
        await createSession();
      }
    };

    void bootstrap();

    const sessionMap = sessionsRef.current;
    const callbackMap = containerCallbacksRef.current;

    return () => {
      cancelled = true;
      const sessionIds = Array.from(sessionMap.keys());
      sessionIds.forEach((sessionId) => cleanupRuntime(sessionId));
      sessionMap.clear();
      callbackMap.clear();
      creatingSessionRef.current = false;
    };
  }, [chatId, workspacePath, cleanupRuntime, createRuntime, startStreaming, createSession]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }

    attachTerminalIfReady(activeSessionId);

    const runtime = sessionsRef.current.get(activeSessionId);
    if (!runtime) {
      return;
    }

    const focusAndFit = () => {
      try {
        runtime.fitAddon.fit();
      } catch (error) {
        logger.debug('[TERMINAL] Fit failed during activation:', error);
      }
      let shouldFocus = false;
      if (focusRequestRef.current) {
        shouldFocus = true;
        focusRequestRef.current = false;
      } else if (typeof document === 'undefined') {
        shouldFocus = true;
      } else {
        const activeElement = document.activeElement;
        shouldFocus = !activeElement || activeElement === document.body;
      }

      if (shouldFocus) {
        runtime.terminal.focus();
      }
    };

    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(focusAndFit);
    } else {
      focusAndFit();
    }
  }, [activeSessionId, attachTerminalIfReady]);

  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (!activeSessionId) {
        return;
      }

      const runtime = sessionsRef.current.get(activeSessionId);
      if (!runtime || !runtime.isOpen) {
        return;
      }

      try {
        runtime.fitAddon.fit();
        const r = runtime.terminal.rows;
        const c = runtime.terminal.cols;
        if (r && c) {
          sendResize(activeSessionId, r, c);
        }
      } catch {
        // Ignore fit issues triggered mid-resize.
      }
    });

    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
    };
  }, [activeSessionId, sendResize]);

  const activeSession = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId)
    : null;

  const handleCreateSessionClick = useCallback(() => {
    focusRequestRef.current = true;
    void createSession();
  }, [createSession]);

  const renderStatusIndicator = () => {
    if (!activeSession) {
      return (
        <span className="flex items-center gap-1 text-xs text-bolt-elements-textSecondary">
          <span className="w-2 h-2 bg-bolt-elements-borderColor rounded-full"></span>
          Idle
        </span>
      );
    }

    if (!activeSession.isAlive) {
      return (
        <span className="flex items-center gap-1 text-xs text-red-500">
          <span className="w-2 h-2 bg-red-500 rounded-full"></span>
          Terminated
        </span>
      );
    }

    if (!activeSession.isConnected) {
      return (
        <span className="flex items-center gap-1 text-xs text-yellow-500">
          <span className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse"></span>
          Connecting...
        </span>
      );
    }

    return (
      <span className="flex items-center gap-1 text-xs text-green-500">
        <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
        Connected
      </span>
    );
  };

  return (
    <div className="flex flex-col h-full bg-bolt-elements-bg-depth-1">
      <div className="flex items-center justify-between px-4 py-2 bg-bolt-elements-background-depth-2 border-b border-bolt-elements-borderColor">
        <div className="flex items-center gap-2">
          <Icons.Terminal className="w-4 h-4 text-bolt-elements-textPrimary" />
          <span className="text-xs font-semibold uppercase tracking-wide text-bolt-elements-textPrimary">
            Terminal
          </span>
          {renderStatusIndicator()}
          {initializationError ? (
            <span className="text-xs text-red-400 truncate max-w-[12rem]" title={initializationError}>
              {initializationError}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleClearActiveSession}
            disabled={!activeSessionId}
            className="px-2 py-1 text-xs text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-bg-depth-3 rounded transition-colors disabled:opacity-40 disabled:hover:text-bolt-elements-textSecondary disabled:hover:bg-transparent"
            title="Clear active terminal (Ctrl+L)"
          >
            <Icons.Discard className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleCreateSessionClick}
            className="px-2 py-1 text-xs text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-bg-depth-3 rounded transition-colors"
            title="Create new terminal"
          >
            <Icons.Add className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex flex-col flex-1">
        <div className="flex items-stretch gap-1 px-2 py-1 bg-bolt-elements-bg-depth-2 border-b border-bolt-elements-borderColor overflow-x-auto">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            const statusDotClass = !session.isAlive
              ? 'bg-red-500'
              : session.isConnected
              ? 'bg-green-500'
              : 'bg-yellow-500';

            return (
              <div
                key={session.id}
                className={`flex items-center rounded-md border transition-colors ${
                  isActive
                    ? 'border-bolt-elements-borderColor bg-bolt-elements-bg-depth-3'
                    : 'border-transparent bg-transparent hover:bg-bolt-elements-bg-depth-3/50'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    focusRequestRef.current = true;
                    setActiveSessionId(session.id);
                  }}
                  className={`flex items-center gap-2 px-3 py-1 text-xs whitespace-nowrap ${
                    isActive
                      ? 'text-bolt-elements-textPrimary'
                      : 'text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary'
                  }`}
                >
                  <span>{session.label}</span>
                  <span className={`w-2 h-2 rounded-full ${statusDotClass}`}></span>
                </button>
                <button
                  type="button"
                  onClick={() => handleKillSession(session.id)}
                  className="px-2 py-1 text-xs text-bolt-elements-textSecondary hover:text-red-400"
                  title="Kill terminal session"
                >
                  <Icons.Delete className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={handleCreateSessionClick}
            className="flex items-center gap-1 px-2 py-1 text-xs text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-bg-depth-3 rounded transition-colors"
            title="New terminal"
          >
            <Icons.Add className="w-3.5 h-3.5" />
            <span>New</span>
          </button>
        </div>

        <div
          ref={containerRef}
          className="relative flex-1"
          style={{ background: '#1E1E1E' }}
          onMouseDown={handleTerminalAreaMouseDown}
        >
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`absolute inset-0 ${session.id === activeSessionId ? 'block' : 'hidden'}`}
            >
              <div
                ref={getContainerCallback(session.id)}
                className="w-full h-full overflow-hidden p-2"
              />
            </div>
          ))}

          {sessions.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-bolt-elements-textSecondary px-6 text-center">
              {chatId && workspacePath
                ? 'No terminal sessions yet. Use the New button to start one.'
                : 'Select a workspace to start using the terminal.'}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
