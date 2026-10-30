/**
 * Bot worker entry point - runs in utilityProcess
 * This is the actual Minecraft bot process
 */

import * as mineflayer from 'mineflayer';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import * as path from 'node:path';
import * as fs from 'node:fs';

// Configuration from environment
const config = {
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT || '25565', 10),
  username: process.env.MC_USERNAME || 'Airi',
  version: process.env.MC_VERSION || '1.21.1',
  enableMemory: process.env.ENABLE_MEMORY === 'true',
  webPort: parseInt(process.env.WEB_PORT || '3000', 10),
  webHost: process.env.WEB_HOST || '127.0.0.1',
  memoryFile: process.env.MEMORY_FILE || path.join(process.cwd(), 'memory.json'),
  openaiKey: process.env.OPENAI_KEY || '',
};

interface BotState {
  connected: boolean;
  status: 'offline' | 'connecting' | 'connected' | 'disconnected' | 'error';
  error: string | null;
  players: string[];
  health: number;
  food: number;
  position: { x: number; y: number; z: number } | null;
  dimension: string | null;
}

interface MemoryEntry {
  id: string;
  timestamp: number;
  type: 'chat' | 'event' | 'observation';
  content: string;
  metadata?: Record<string, any>;
}

let bot: mineflayer.Bot | null = null;
let wsServer: WebSocketServer | null = null;
let httpServer: ReturnType<typeof createServer> | null = null;
let memory: MemoryEntry[] = [];
let botState: BotState = {
  connected: false,
  status: 'offline',
  error: null,
  players: [],
  health: 0,
  food: 0,
  position: null,
  dimension: null,
};

// Load memory from file
function loadMemory(): void {
  try {
    if (fs.existsSync(config.memoryFile)) {
      const data = fs.readFileSync(config.memoryFile, 'utf8');
      memory = JSON.parse(data);
      log('system', `Loaded ${memory.length} memory entries`);
    }
  } catch (error) {
    log('error', `Failed to load memory: ${(error as Error).message}`);
  }
}

// Save memory to file
function saveMemory(): void {
  try {
    fs.writeFileSync(config.memoryFile, JSON.stringify(memory, null, 2), 'utf8');
  } catch (error) {
    log('error', `Failed to save memory: ${(error as Error).message}`);
  }
}

// Add memory entry
function addMemory(type: MemoryEntry['type'], content: string, metadata?: Record<string, any>): void {
  if (!config.enableMemory) return;

  const entry: MemoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: Date.now(),
    type,
    content,
    metadata,
  };

  memory.push(entry);

  // Keep only last 1000 entries
  if (memory.length > 1000) {
    memory = memory.slice(-1000);
  }

  saveMemory();
}

// Logging function
function log(stream: 'stdout' | 'stderr' | 'system' | 'error', message: string): void {
  const entry = {
    time: new Date().toISOString(),
    stream,
    line: message,
  };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

// Broadcast to WebSocket clients
function broadcast(type: string, data: any): void {
  if (!wsServer) return;

  const message = JSON.stringify({ type, data, timestamp: Date.now() });

  wsServer.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

// Update bot state and broadcast
function updateState(partial: Partial<BotState>): void {
  botState = { ...botState, ...partial };
  broadcast('state', botState);
}

// Create HTTP server for dashboard
function createHttpServer(): void {
  httpServer = createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', bot: botState }));
      return;
    }

    // Bot state API
    if (req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(botState));
      return;
    }

    // Memory API
    if (req.url === '/api/memory') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(memory));
      return;
    }

    // Players API
    if (req.url === '/api/players') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(botState.players));
      return;
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
  });

  // WebSocket server
  wsServer = new WebSocketServer({ server: httpServer });

  wsServer.on('connection', (ws) => {
    log('system', 'Dashboard connected via WebSocket');

    // Send initial state
    ws.send(JSON.stringify({ type: 'state', data: botState, timestamp: Date.now() }));
    ws.send(JSON.stringify({ type: 'memory', data: memory, timestamp: Date.now() }));

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleWsMessage(ws, message);
      } catch (error) {
        log('error', `Invalid WebSocket message: ${(error as Error).message}`);
      }
    });

    ws.on('close', () => {
      log('system', 'Dashboard disconnected');
    });
  });

  httpServer.listen(config.webPort, config.webHost, () => {
    log('system', `Dashboard server running at http://${config.webHost}:${config.webPort}`);
    broadcast('dashboard-ready', { url: `http://${config.webHost}:${config.webPort}` });
  });
}

// Handle WebSocket messages from dashboard
function handleWsMessage(ws: any, message: any): void {
  switch (message.type) {
    case 'command':
      if (bot && message.command) {
        bot.chat(message.command);
        addMemory('chat', `> ${message.command}`, { source: 'dashboard' });
      }
      break;
    case 'getState':
      ws.send(JSON.stringify({ type: 'state', data: botState, timestamp: Date.now() }));
      break;
    case 'getMemory':
      ws.send(JSON.stringify({ type: 'memory', data: memory, timestamp: Date.now() }));
      break;
    case 'clearMemory':
      memory = [];
      saveMemory();
      broadcast('memory', memory);
      break;
    default:
      log('system', `Unknown WebSocket message type: ${message.type}`);
  }
}

// Create and configure the mineflayer bot
function createBot(): void {
  if (bot) {
    bot.end();
  }

  updateState({ status: 'connecting', error: null });
  log('system', `Connecting to ${config.host}:${config.port} as ${config.username}...`);

  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    auth: 'offline',
    hideErrors: false,
    checkTimeoutInterval: 30000,
  });

  // Event handlers
  bot.on('spawn', () => {
    log('system', 'Bot spawned in world');
    updateState({
      connected: true,
      status: 'connected',
      health: bot.health,
      food: bot.food,
      position: bot.entity.position ? {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z),
      } : null,
      dimension: bot.game.dimension,
    });
    addMemory('event', `Joined server ${config.host}:${config.port}`);
  });

  bot.on('login', () => {
    log('system', 'Bot logged in');
  });

  bot.on('chat', (username, message, translate, jsonMsg) => {
    if (username === bot?.username) return;

    const formatted = `<${username}> ${message}`;
    log('stdout', formatted);
    addMemory('chat', formatted, { username, translate: !!translate });

    broadcast('chat', { username, message, translate: !!translate, jsonMsg });
  });

  bot.on('whisper', (username, message) => {
    const formatted = `[whisper] <${username}> ${message}`;
    log('stdout', formatted);
    addMemory('chat', formatted, { username, whisper: true });
    broadcast('whisper', { username, message });
  });

  bot.on('playerJoined', (player) => {
    if (player.username !== bot?.username) {
      log('system', `${player.username} joined`);
      addMemory('event', `${player.username} joined the game`);
      updatePlayersList();
    }
  });

  bot.on('playerLeft', (player) => {
    log('system', `${player.username} left`);
    addMemory('event', `${player.username} left the game`);
    updatePlayersList();
  });

  bot.on('health', () => {
    if (bot) {
      updateState({ health: bot.health });
    }
  });

  bot.on('hunger', () => {
    if (bot) {
      updateState({ food: bot.food });
    }
  });

  bot.on('move', () => {
    if (bot?.entity?.position) {
      updateState({
        position: {
          x: Math.floor(bot.entity.position.x),
          y: Math.floor(bot.entity.position.y),
          z: Math.floor(bot.entity.position.z),
        },
      });
    }
  });

  bot.on('death', () => {
    log('system', 'Bot died');
    addMemory('event', 'Bot died');
    updateState({ health: 0 });
  });

  bot.on('respawn', () => {
    log('system', 'Bot respawned');
    addMemory('event', 'Bot respawned');
  });

  bot.on('kicked', (reason) => {
    log('error', `Kicked: ${reason}`);
    addMemory('event', `Kicked: ${reason}`);
    updateState({ status: 'error', error: `Kicked: ${reason}`, connected: false });
  });

  bot.on('error', (err) => {
    log('error', `Bot error: ${err.message}`);
    updateState({ status: 'error', error: err.message, connected: false });
  });

  bot.on('end', (reason) => {
    log('system', `Disconnected: ${reason}`);
    addMemory('event', `Disconnected: ${reason}`);
    updateState({
      connected: false,
      status: 'disconnected',
      error: reason || 'Disconnected',
      health: 0,
      food: 0,
    });
  });

  // Handle process signals
  process.on('SIGINT', () => {
    log('system', 'Received SIGINT, shutting down...');
    shutdown();
  });

  process.on('SIGTERM', () => {
    log('system', 'Received SIGTERM, shutting down...');
    shutdown();
  });
}

function updatePlayersList(): void {
  if (!bot) return;
  const players = Object.values(bot.players).map(p => p.username);
  updateState({ players });
}

// Graceful shutdown
function shutdown(): void {
  log('system', 'Shutting down bot worker...');

  if (bot) {
    bot.end('Shutting down');
    bot = null;
  }

  if (wsServer) {
    wsServer.close();
    wsServer = null;
  }

  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }

  saveMemory();
  process.exit(0);
}

// Initialize
log('system', 'Airi OS Bot Worker starting...');
log('system', `Config: ${config.host}:${config.port} (${config.username}, MC ${config.version})`);
log('system', `Dashboard: http://${config.webHost}:${config.webPort}`);
log('system', `Memory: ${config.enableMemory ? 'enabled' : 'disabled'}`);

loadMemory();
createHttpServer();
createBot();

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  log('error', `Uncaught exception: ${err.stack || err.message}`);
  shutdown();
});

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});