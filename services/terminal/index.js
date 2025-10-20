'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.TERMINAL_PORT || '5051', 10);
const HOST = process.env.TERMINAL_HOST || '127.0.0.1';
const VENV_CANDIDATES = ['.venv', 'venv', 'env', 'virtualenv', '.virtualenv'];
const MAX_RECENT_OUTPUT = 8192;

const sessions = new Map();

const generateId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
};

const detectVenv = (workspacePath) => {
  for (const candidate of VENV_CANDIDATES) {
    const fullPath = path.join(workspacePath, candidate);
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        return fullPath;
      }
    } catch {
    }
  }
  return null;
};

const loadEnvFile = (workspacePath) => {
  const envVars = {};
  const envFile = path.join(workspacePath, '.env');
  if (!fs.existsSync(envFile)) {
    return envVars;
  }

  try {
    const contents = fs.readFileSync(envFile, 'utf8');
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .forEach((line) => {
        const index = line.indexOf('=');
        const key = line.slice(0, index).trim();
        const rawValue = line.slice(index + 1).trim();
        const value = rawValue.replace(/^['"]|['"]$/g, '');
        if (key) {
          envVars[key] = value;
        }
      });
  } catch (error) {
    console.warn('[terminal-server] Failed to read .env file:', error);
  }
  return envVars;
};

const broadcast = (session, payload) => {
  const data = JSON.stringify(payload);
  for (const client of session.clients) {
    if (client.readyState === client.OPEN) {
      try {
        client.send(data);
      } catch (error) {
        console.warn('[terminal-server] Failed to broadcast payload', error);
      }
    }
  }
};

const closeSession = (sessionId, reason) => {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.isAlive = false;
  try {
    session.pty.kill();
  } catch {
  }

  broadcast(session, { type: 'terminated', session_id: sessionId, reason });

  for (const client of session.clients) {
    try {
      client.close();
    } catch {
    }
  }
  session.clients.clear();
  sessions.delete(sessionId);
  return true;
};

const createSession = (chatId, workspacePath) => {
  const sessionId = generateId();
  const resolvedWorkspace = path.resolve(workspacePath);
  const platform = os.platform();
  const lineEnding = platform === 'win32' ? '\r\n' : '\n';
  const envVars = loadEnvFile(resolvedWorkspace);
  const env = {
    ...process.env,
    ...envVars,
    TERM: 'xterm-256color',
  };

  const shell = process.env.COMSPEC || (platform === 'win32' ? 'cmd.exe' : 'bash');
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cwd: resolvedWorkspace,
    env,
    cols: 120,
    rows: 32,
  });

  const session = {
    id: sessionId,
    chatId,
    workspacePath: resolvedWorkspace,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    shell,
    platform,
    lineEnding,
    pty: ptyProcess,
    clients: new Set(),
    recentOutput: '',
    venvPath: detectVenv(resolvedWorkspace),
    isAlive: true,
  };

  sessions.set(sessionId, session);

  const activationCommands = [];
  if (platform === 'win32') {
    activationCommands.push('chcp 65001 > nul');
  }

  if (session.venvPath) {
    const activateScript = path.join(session.venvPath, 'Scripts', 'activate.bat');
    if (fs.existsSync(activateScript)) {
      activationCommands.push(`call "${activateScript}"`);
    }
  }

  activationCommands.push(`echo Atlas terminal ready in ${resolvedWorkspace}`);

  activationCommands.forEach((command) => {
    try {
      ptyProcess.write(`${command}${lineEnding}`);
    } catch (error) {
      console.warn('[terminal-server] Failed to run bootstrap command:', error);
    }
  });

  ptyProcess.on('data', (data) => {
    session.lastActivity = Date.now();
    session.recentOutput = (session.recentOutput + data).slice(-MAX_RECENT_OUTPUT);
    broadcast(session, {
      type: 'output',
      session_id: sessionId,
      data,
    });
  });

  ptyProcess.on('exit', (exitCode, signal) => {
    if (!sessions.has(sessionId)) {
      return;
    }

    session.isAlive = false;
    broadcast(session, {
      type: 'terminated',
      session_id: sessionId,
      exit_code: exitCode,
      signal,
    });
    for (const client of session.clients) {
      try {
        client.close();
      } catch {
      }
    }
    session.clients.clear();
    sessions.delete(sessionId);
  });

  return session;
};

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/terminal/create', (req, res) => {
  try {
    const chatId = req.body?.chat_id;
    const workspacePath = req.body?.workspace_path;

    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chat_id is required' });
    }
    if (!workspacePath) {
      return res.status(400).json({ success: false, error: 'workspace_path is required' });
    }
    if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
      return res.status(404).json({ success: false, error: 'Workspace not found' });
    }

    const session = createSession(chatId, workspacePath);

    return res.json({
      success: true,
      session_id: session.id,
      created_at: session.createdAt,
      workspace_path: session.workspacePath,
      platform: session.platform,
      shell: session.shell,
      line_ending: session.lineEnding,
      is_alive: session.isAlive,
    });
  } catch (error) {
    console.error('[terminal-server] Failed to create session', error);
    return res.status(500).json({ success: false, error: 'Failed to create terminal session' });
  }
});

app.get('/api/terminal/list', (_req, res) => {
  try {
    const list = Array.from(sessions.values()).map((session) => ({
      session_id: session.id,
      chat_id: session.chatId,
      workspace_path: session.workspacePath,
      created_at: session.createdAt,
      last_activity: session.lastActivity,
      is_alive: session.isAlive,
      platform: session.platform,
      shell: session.shell,
      line_ending: session.lineEnding,
    }));
    res.json({ success: true, sessions: list });
  } catch (error) {
    console.error('[terminal-server] Failed to list sessions', error);
    res.status(500).json({ success: false, error: 'Failed to list sessions' });
  }
});

app.post('/api/terminal/kill', (req, res) => {
  try {
    const sessionId = req.body?.session_id;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'session_id is required' });
    }

    const success = closeSession(sessionId, 'killed');
    if (!success) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[terminal-server] Failed to kill session', error);
    res.status(500).json({ success: false, error: 'Failed to kill session' });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId || !sessions.has(sessionId)) {
    ws.close(4404, 'Session not found');
    return;
  }

  const session = sessions.get(sessionId);
  session.clients.add(ws);

  ws.send(
    JSON.stringify({
      type: 'ready',
      session_id: sessionId,
      workspace_path: session.workspacePath,
      platform: session.platform,
      shell: session.shell,
      line_ending: session.lineEnding,
      is_alive: session.isAlive,
    }),
  );

  if (session.recentOutput) {
    ws.send(
      JSON.stringify({
        type: 'output',
        session_id: sessionId,
        data: session.recentOutput,
      }),
    );
  }

  ws.on('message', (raw) => {
    if (!sessions.has(sessionId)) {
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch (error) {
      console.warn('[terminal-server] Received invalid JSON from client', error);
      return;
    }

    if (!payload || typeof payload.type !== 'string') {
      return;
    }

    const current = sessions.get(sessionId);
    if (!current || !current.isAlive) {
      ws.send(
        JSON.stringify({
          type: 'terminated',
          session_id: sessionId,
        }),
      );
      return;
    }

    switch (payload.type) {
      case 'input': {
        if (typeof payload.data === 'string' && payload.data.length > 0) {
          current.pty.write(payload.data);
        }
        break;
      }
      case 'resize': {
        const rows = Number(payload.rows);
        const cols = Number(payload.cols);
        if (Number.isFinite(rows) && Number.isFinite(cols) && rows > 0 && cols > 0) {
          try {
            current.pty.resize(cols, rows);
          } catch (error) {
            console.warn('[terminal-server] Failed to resize PTY', error);
          }
        }
        break;
      }
      case 'kill': {
        closeSession(sessionId, 'killed-by-client');
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.warn('[terminal-server] WebSocket error', error);
    session.clients.delete(ws);
  });
});

server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname !== '/api/terminal/stream') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } catch (error) {
    console.error('[terminal-server] Upgrade failed', error);
    socket.destroy();
  }
});

const shutdown = () => {
  console.info('[terminal-server] Shutting down terminal sessions');
  const ids = Array.from(sessions.keys());
  ids.forEach((sessionId) => closeSession(sessionId, 'shutdown'));
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.info(`[terminal-server] Listening on http://${HOST}:${PORT}`);
});
