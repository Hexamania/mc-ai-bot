/**
 * Socket.io event handlers for web server
 * Handles all real-time communication between bot and dashboard
 */

import type { Server, Socket } from 'socket.io';
import { Vec3 } from 'vec3';
import { Movements, goals } from 'mineflayer-pathfinder';
import type { BotManager } from '../../bot';
import {
  getMemory,
  rememberLocation,
  rememberFact,
  forgetFact,
  addRule,
  removeRule,
  stopRememberedTask,
} from '../../memory';
import { getCommandRegistry, createCommandContext } from '../../commands';
import type {
  BotStatusPayload,
  BotStatePayload,
  BulkUpdatePayload,
  AuthenticatePayload,
  SendCommandPayload,
  MoveToPayload,
  FollowPlayerPayload,
  DropItemPayload,
  MoveItemPayload,
  MineBlockPayload,
  PlaceBlockPayload,
  SaveLocationPayload,
  RememberFactPayload,
  UpdateSettingsPayload,
  PingPayload,
} from './events';
import { NAMESPACES, SERVER_EVENTS, CLIENT_EVENTS, ROOMS, ROOM_EVENTS } from './events';

interface AuthenticatedSocket extends Socket {
  user?: {
    username: string;
    role: 'guest' | 'trusted' | 'admin';
  };
}

/**
 * Set up main namespace handlers
 */
export function setupMainNamespace(io: Server, botManager: BotManager): void {
  const nsp = io.of(NAMESPACES.MAIN);

  // Authentication middleware
  nsp.use((socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    // In a real implementation, verify JWT here
    // For now, accept any token and extract username
    socket.user = {
      username: 'dashboard',
      role: 'admin', // Default to admin for development
    };
    next();
  });

  nsp.on('connection', (socket: AuthenticatedSocket) => {
    // Join default rooms
    void socket.join(ROOMS.ALL);
    if (socket.user?.role === 'admin') {
      void socket.join(ROOMS.ADMINS);
    } else if (socket.user?.role === 'trusted') {
      void socket.join(ROOMS.TRUSTED);
    }

    // Send initial state
    sendInitialState(socket, botManager);

    // Set up event handlers
    setupSocketEventHandlers(socket, botManager, io);

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      console.log(`[SOCKET] Dashboard disconnected: ${socket.id} (${reason})`);
    });
  });
}

/**
 * Set up admin namespace handlers
 */
export function setupAdminNamespace(io: Server, botManager: BotManager): void {
  const nsp = io.of(NAMESPACES.ADMIN);

  nsp.use((socket: AuthenticatedSocket, next) => {
    if (socket.user?.role !== 'admin') {
      return next(new Error('Admin access required'));
    }
    next();
  });

  nsp.on('connection', (socket: AuthenticatedSocket) => {
    console.log(`[SOCKET] Admin connected: ${socket.id}`);

    // Admin-only events
    socket.on(
      CLIENT_EVENTS.EXECUTE_CONSOLE_COMMAND,
      (data: { command: string; requestId?: string }) => {
        const bot = botManager.getBot();
        if (bot && data.command) {
          bot.chat(`/${data.command}`);
          socket.emit(SERVER_EVENTS.COMMAND_RESULT, {
            requestId: data.requestId,
            command: `console:${data.command}`,
            success: true,
            output: `Executed: /${data.command}`,
          });
        }
      }
    );
  });
}

/**
 * Set up commands namespace handlers
 */
export function setupCommandsNamespace(io: Server, botManager: BotManager): void {
  const nsp = io.of(NAMESPACES.COMMANDS);

  nsp.use((socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth?.token || socket.handcape.query?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    socket.user = { username: 'dashboard', role: 'admin' };
    next();
  });

  nsp.on('connection', (socket: AuthenticatedSocket) => {
    const registry = getCommandRegistry();

    // Get command list
    socket.on(CLIENT_EVENTS.GET_COMMANDS, (callback: (data: { commands: unknown[] }) => void) => {
      const commands = registry.getAll().map((cmd: unknown) => {
        const c = cmd as Record<string, unknown>;
        return {
          name: c.name as string,
          aliases: (c.aliases as string[]) || [],
          description: c.description as string,
          usage: c.usage as string,
          category: (c.category as string) || 'General',
          permission: (c.permission as { level?: string } | undefined)?.level || 'guest',
          adminOnly: c.adminOnly as boolean,
          pmOnly: c.pmOnly as boolean,
        };
      });
      if (callback) callback({ commands });
    });

    // Get command help
    socket.on(
      CLIENT_EVENTS.GET_COMMAND_HELP,
      (data: { command: string; prefix?: string }, callback: (data: { help: string }) => void) => {
        const prefix = data.prefix || '!';
        const help = registry.getHelp(data.command, prefix);
        if (callback) callback({ help: help || `No help found for "${data.command}"` });
      }
    );

    // Execute command
    socket.on(CLIENT_EVENTS.SEND_COMMAND, async (data: SendCommandPayload) => {
      const requestId =
        data.requestId || `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const startTime = Date.now();

      try {
        const bot = botManager.getBot();
        if (!bot) {
          socket.emit(SERVER_EVENTS.COMMAND_RESULT, {
            requestId,
            command: data.command,
            success: false,
            error: 'Bot not connected',
            executionTime: Date.now() - startTime,
          });
          return;
        }

        const args = Array.isArray(data.args) ? data.args : data.args ? [data.args] : [];
        const context = createCommandContext(
          bot,
          socket.user?.username || 'dashboard',
          args,
          socket.user?.role === 'admin',
          true,
          (msg: string) =>
            socket.emit(SERVER_EVENTS.COMMAND_OUTPUT, {
              message: msg,
              type: 'reply',
              timestamp: new Date().toISOString(),
            }),
          (msg: string) =>
            socket.emit(SERVER_EVENTS.COMMAND_OUTPUT, {
              message: msg,
              type: 'private',
              timestamp: new Date().toISOString(),
            })
        );

        const result = await registry.execute(data.command, context);

        socket.emit(SERVER_EVENTS.COMMAND_RESULT, {
          requestId,
          command: data.command,
          success: result,
          output: result ? 'Command executed' : 'Command failed or not found',
          executionTime: Date.now() - startTime,
        });
      } catch (error) {
        socket.emit(SERVER_EVENTS.COMMAND_RESULT, {
          requestId,
          command: data.command,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          executionTime: Date.now() - startTime,
        });
      }
    });
  });
}

/**
 * Send initial state to newly connected client
 */
function sendInitialState(socket: AuthenticatedSocket, botManager: BotManager): void {
  socket.emit(SERVER_EVENTS.BOT_STATUS, botManager.getStatus());
  socket.emit(SERVER_EVENTS.BOT_STATE, botManager.getState());
  socket.emit(SERVER_EVENTS.BULK_UPDATE, botManager.getState());

  // Send memory data
  const memory = getMemory();
  socket.emit(SERVER_EVENTS.MEMORY_UPDATED, {
    type: 'full',
    key: 'all',
    data: memory,
  });

  // Send command list
  const registry = getCommandRegistry();
  const commands = registry.getAll().map((cmd: unknown) => {
    const c = cmd as Record<string, unknown>;
    return {
      name: c.name as string,
      aliases: (c.aliases as string[]) || [],
      description: c.description as string,
      usage: c.usage as string,
      category: (c.category as string) || 'General',
      permission: (c.permission as { level?: string } | undefined)?.level || 'guest',
    };
  });
  socket.emit(SERVER_EVENTS.COMMAND_LIST, { commands });
}

/**
 * Set up individual socket event handlers for bot control
 */
function setupSocketEventHandlers(
  socket: AuthenticatedSocket,
  botManager: BotManager,
  io: Server
): void {
  // Authentication
  socket.on(CLIENT_EVENTS.AUTHENTICATE, (_data: AuthenticatePayload) => {
    // Handled by middleware, but can re-authenticate
    socket.emit(SERVER_EVENTS.AUTHENTICATED, { user: socket.user });
  });

  // Get current state
  socket.on(CLIENT_EVENTS.GET_STATE, () => {
    socket.emit(SERVER_EVENTS.BOT_STATE, botManager.getState());
  });

  socket.on(CLIENT_EVENTS.GET_STATUS, () => {
    socket.emit(SERVER_EVENTS.BOT_STATUS, botManager.getStatus());
  });

  // Send command (legacy support)
  socket.on(CLIENT_EVENTS.SEND_COMMAND, async (data: SendCommandPayload) => {
    // Forward to commands namespace or handle directly
    const requestId =
      data.requestId || `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const startTime = Date.now();

    try {
      const currentBot = botManager.getBot();
      if (!currentBot) {
        socket.emit(SERVER_EVENTS.COMMAND_RESULT, {
          requestId,
          command: data.command,
          success: false,
          error: 'Bot is offline',
          executionTime: Date.now() - startTime,
        });
        return;
      }

      const args = Array.isArray(data.args) ? data.args : data.args ? [data.args] : [];
      const registry = getCommandRegistry();

      const context = createCommandContext(
        currentBot,
        socket.user?.username || 'dashboard',
        args,
        socket.user?.role === 'admin',
        true,
        (msg: string) =>
          socket.emit(SERVER_EVENTS.COMMAND_OUTPUT, {
            message: msg,
            type: 'reply',
            timestamp: new Date().toISOString(),
          }),
        (msg: string) =>
          socket.emit(SERVER_EVENTS.COMMAND_OUTPUT, {
            message: msg,
            type: 'private',
            timestamp: new Date().toISOString(),
          })
      );

      const result = await registry.execute(data.command, context);

      socket.emit(SERVER_EVENTS.COMMAND_RESULT, {
        requestId,
        command: data.command,
        success: result,
        executionTime: Date.now() - startTime,
      });
    } catch (error) {
      socket.emit(SERVER_EVENTS.COMMAND_RESULT, {
        requestId,
        command: data.command,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
      });
    }
  });

  // Movement commands
  socket.on(CLIENT_EVENTS.MOVE_TO, (data: MoveToPayload) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;

    const { x, y, z } = data;
    const movements = new Movements(currentBot);
    const goal = new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));

    currentBot.pathfinder.setMovements(movements);
    currentBot.pathfinder.setGoal(goal);
    botManager.say(`📍 Dashboard: Heading to ${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}`);
  });

  socket.on(CLIENT_EVENTS.FOLLOW_PLAYER, (data: FollowPlayerPayload) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;

    const target = currentBot.players[data.username]?.entity;
    if (target) {
      botManager.following = true;
      botManager.followTarget = data.username;
      currentBot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
      botManager.say(`🚶 Following ${data.username}`);
    } else {
      socket.emit(SERVER_EVENTS.COMMAND_RESULT, {
        command: 'follow',
        success: false,
        error: `Player "${data.username}" not found`,
      });
    }
  });

  socket.on(CLIENT_EVENTS.STOP_MOVEMENT, () => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;

    botManager.roaming = false;
    botManager.following = false;
    botManager.pvpTarget = null;
    botManager.progressionActive = false;
    botManager.minerActive = false;
    botManager.lumberjackActive = false;
    botManager.mineAreaActive = false;
    botManager.guarding = false;
    botManager.medicMode = false;
    currentBot.pathfinder.setGoal(null);
    botManager.say('⛔ Movement halted via dashboard');
  });

  socket.on(CLIENT_EVENTS.SET_HOME, () => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;

    const pos = currentBot.entity.position;
    rememberLocation('home', pos, 'home');
    botManager.baseLocation = pos;
    botManager.say(
      `🏠 Home set to ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`
    );
    socket.emit(SERVER_EVENTS.LOCATION_SAVED, { name: 'home', position: pos });
  });

  socket.on(CLIENT_EVENTS.GO_HOME, () => {
    const currentBot = botManager.getBot();
    if (!currentBot || !botManager.baseLocation) return;

    const { x, y, z } = botManager.baseLocation;
    const movements = new Movements(currentBot);
    const goal = new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));

    currentBot.pathfinder.setMovements(movements);
    currentBot.pathfinder.setGoal(goal);
    botManager.say(`🏠 Returning home to ${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}`);
  });

  // Inventory commands
  socket.on(CLIENT_EVENTS.DROP_ITEM, (data: DropItemPayload) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;

    const item = currentBot.inventory.slots[data.slot];
    if (item) {
      void currentBot.tossStack(item).catch((err: Error) => {
        socket.emit(SERVER_EVENTS.ERROR, { message: `Failed to drop item: ${err.message}` });
      });
    }
  });

  socket.on(CLIENT_EVENTS.DROP_ALL, async () => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;

    const items = currentBot.inventory.items();
    for (const item of items) {
      try {
        await currentBot.tossStack(item);
      } catch (err) {
        socket.emit(SERVER_EVENTS.ERROR, { message: `Failed to drop ${item.name}: ${err}` });
      }
    }
    botManager.say('🗑️ Dashboard triggered: Dropped entire inventory.');
  });

  socket.on(CLIENT_EVENTS.MOVE_ITEM, (data: MoveItemPayload) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;

    try {
      void currentBot.simpleClick.leftMouse(data.from);
      void currentBot.simpleClick.leftMouse(data.to);
    } catch (err) {
      socket.emit(SERVER_EVENTS.ERROR, { message: `Failed to move item: ${err}` });
    }
  });

  socket.on(CLIENT_EVENTS.SET_HOTBAR, (slot: number) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;
    if (slot >= 0 && slot <= 8) {
      currentBot.setQuickBarSlot(slot);
    }
  });

  // Block interaction
  socket.on(CLIENT_EVENTS.MINE_BLOCK, (data: MineBlockPayload) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;

    const block = currentBot.blockAt(new Vec3(data.x, data.y, data.z));
    if (block) {
      botManager.log('WEB-MINE', `Mining ${block.name} at ${data.x}, ${data.y}, ${data.z}`);
      // mineBlock function would be called here
      socket.emit(SERVER_EVENTS.COMMAND_RESULT, { success: true, action: 'mine_block' });
    }
  });

  socket.on(CLIENT_EVENTS.PLACE_BLOCK, (data: PlaceBlockPayload) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;

    botManager.log('WEB-PLACE', `Placing block at ${data.x}, ${data.y}, ${data.z}`);
    socket.emit(SERVER_EVENTS.COMMAND_RESULT, { success: true, action: 'place_block' });
  });

  // Combat toggles
  socket.on(CLIENT_EVENTS.TOGGLE_KILLAURA, (enabled: boolean) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;
    botManager.killAuraActive = enabled;
    botManager.log('WEB', `Kill Aura ${enabled ? 'Enabled' : 'Disabled'}`);
    socket.emit(SERVER_EVENTS.FEATURE_TOGGLED, { feature: 'killAura', enabled });
    void io
      .of(NAMESPACES.MAIN)
      .to(ROOMS.ALL)
      .emit(SERVER_EVENTS.BULK_UPDATE, botManager.getState());
  });

  socket.on(CLIENT_EVENTS.TOGGLE_AUTODEFENSE, (enabled: boolean) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;
    botManager.autoDefense = enabled;
    botManager.log('WEB', `Auto-defense ${enabled ? 'enabled' : 'disabled'}`);
    socket.emit(SERVER_EVENTS.FEATURE_TOGGLED, { feature: 'autoDefense', enabled });
    void io
      .of(NAMESPACES.MAIN)
      .to(ROOMS.ALL)
      .emit(SERVER_EVENTS.BULK_UPDATE, botManager.getState());
  });

  // Automation toggles
  socket.on(CLIENT_EVENTS.TOGGLE_ROAMING, (enabled: boolean) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;
    botManager.roaming = enabled;
    if (enabled) {
      botManager.currentObjective = 'Roaming';
      botManager.say('🚶 Roaming protocol active');
    } else {
      currentBot.pathfinder.setGoal(null);
      botManager.say('⛔ Roaming stopped');
    }
    socket.emit(SERVER_EVENTS.FEATURE_TOGGLED, { feature: 'roaming', enabled });
  });

  socket.on(CLIENT_EVENTS.TOGGLE_FARMING, (enabled: boolean) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;
    botManager.isFarming = enabled;
    socket.emit(SERVER_EVENTS.FEATURE_TOGGLED, { feature: 'farming', enabled });
  });

  socket.on(CLIENT_EVENTS.TOGGLE_MINING, (enabled: boolean) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;
    botManager.minerActive = enabled;
    socket.emit(SERVER_EVENTS.FEATURE_TOGGLED, { feature: 'mining', enabled });
  });

  socket.on(CLIENT_EVENTS.TOGGLE_LUMBERJACK, (enabled: boolean) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;
    botManager.lumberjackActive = enabled;
    socket.emit(SERVER_EVENTS.FEATURE_TOGGLED, { feature: 'lumberjack', enabled });
  });

  socket.on(CLIENT_EVENTS.START_PROGRESSION, () => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;
    if (botManager.progressionActive) return;

    botManager.progressionActive = true;
    botManager.say('🚀 Speedrun Protocol initiated!');
    socket.emit(SERVER_EVENTS.FEATURE_TOGGLED, { feature: 'progression', enabled: true });
  });

  socket.on(CLIENT_EVENTS.STOP_ALL_TASKS, () => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;

    botManager.roaming = false;
    botManager.following = false;
    botManager.pvpTarget = null;
    botManager.progressionActive = false;
    botManager.minerActive = false;
    botManager.lumberjackActive = false;
    botManager.mineAreaActive = false;
    botManager.guarding = false;
    botManager.medicMode = false;
    currentBot.pathfinder.setGoal(null);
    stopRememberedTask();
    botManager.say('⛔ All tasks stopped via dashboard');
    socket.emit(SERVER_EVENTS.FEATURE_TOGGLED, { feature: 'all', enabled: false });
  });

  // Settings
  socket.on(CLIENT_EVENTS.TOGGLE_SAFEMODE, (enabled: boolean) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;
    botManager.safeModeActive = enabled;
    botManager.log('WEB', `Safe Mode ${enabled ? 'Enabled' : 'Disabled'}`);
    socket.emit(SERVER_EVENTS.FEATURE_TOGGLED, { feature: 'safeMode', enabled });
  });

  socket.on(CLIENT_EVENTS.TOGGLE_STEALTH, (enabled: boolean) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;
    botManager.stealthMode = enabled;
    currentBot.setControlState('sneak', enabled);
    botManager.say(enabled ? '👻 Stealth Mode enabled' : '👁️ Stealth Mode disabled');
    socket.emit(SERVER_EVENTS.FEATURE_TOGGLED, { feature: 'stealth', enabled });
  });

  socket.on(CLIENT_EVENTS.TOGGLE_AUTOARMOR, (enabled: boolean) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;
    botManager.autoArmorEnabled = enabled;
    botManager.log('WEB', `Auto-armor ${enabled ? 'enabled' : 'disabled'}`);
    socket.emit(SERVER_EVENTS.FEATURE_TOGGLED, { feature: 'autoArmor', enabled });
  });

  socket.on(CLIENT_EVENTS.UPDATE_SETTINGS, (data: UpdateSettingsPayload) => {
    const state = botManager.getState();
    Object.assign(state.settings, data.settings);
    socket.emit(SERVER_EVENTS.SETTINGS_CHANGED, data.settings);
    void io
      .of(NAMESPACES.MAIN)
      .to(ROOMS.ALL)
      .emit(SERVER_EVENTS.BULK_UPDATE, botManager.getState());
  });

  // Memory
  socket.on(CLIENT_EVENTS.SAVE_LOCATION, (data: SaveLocationPayload) => {
    const currentBot = botManager.getBot();
    if (!currentBot) return;

    const pos = data.position || currentBot.entity.position;
    rememberLocation(`favorite:${data.name}`, pos, data.type || 'favorite');

    const state = botManager.getState();
    state.favorites[data.name] = pos;
    socket.emit(SERVER_EVENTS.LOCATION_SAVED, { name: data.name, position: pos });
    void io.of(NAMESPACES.MAIN).to(ROOMS.ALL).emit(SERVER_EVENTS.BULK_UPDATE, state);
  });

  socket.on(CLIENT_EVENTS.REMEMBER_FACT, (data: RememberFactPayload) => {
    const success = rememberFact(data.key, data.fact);
    socket.emit(SERVER_EVENTS.COMMAND_RESULT, {
      command: 'remember',
      success,
      output: success ? `Remembered: ${data.key}` : 'Failed to remember fact',
    });
  });

  socket.on(CLIENT_EVENTS.FORGET_FACT, (data: { key: string }) => {
    const success = forgetFact(data.key);
    socket.emit(SERVER_EVENTS.COMMAND_RESULT, {
      command: 'forget',
      success,
      output: success ? `Forgot: ${data.key}` : 'Fact not found',
    });
  });

  socket.on(CLIENT_EVENTS.ADD_RULE, (data: { rule: string }) => {
    const success = addRule(data.rule);
    socket.emit(SERVER_EVENTS.COMMAND_RESULT, {
      command: 'add_rule',
      success,
      output: success ? `Added rule: ${data.rule}` : 'Rule already exists or failed',
    });
  });

  socket.on(CLIENT_EVENTS.REMOVE_RULE, (data: { rule: string }) => {
    const success = removeRule(data.rule);
    socket.emit(SERVER_EVENTS.COMMAND_RESULT, {
      command: 'remove_rule',
      success,
      output: success ? `Removed rule: ${data.rule}` : 'Rule not found',
    });
  });

  // Utility
  socket.on(
    CLIENT_EVENTS.PING,
    (
      data: PingPayload,
      callback: (data: { pong: boolean; timestamp: number; latency: number }) => void
    ) => {
      if (callback) {
        callback({ pong: true, timestamp: Date.now(), latency: Date.now() - data.timestamp });
      }
    }
  );

  // Room management
  socket.on(ROOM_EVENTS.JOIN, (room: string) => {
    if (Object.values(ROOMS).includes(room as keyof typeof ROOMS)) {
      void socket.join(room);
      const roomObj = io.of(NAMESPACES.MAIN).adapter.rooms.get(room);
      void socket.emit(ROOM_EVENTS.ROOM_USERS, { room, users: roomObj?.size || 0 });
    }
  });

  socket.on(ROOM_EVENTS.LEAVE, (room: string) => {
    void socket.leave(room);
  });
}

/**
 * Broadcast bot status to all connected dashboards
 */
export function broadcastBotStatus(io: Server, status: BotStatusPayload): void {
  io.of(NAMESPACES.MAIN).to(ROOMS.ALL).emit(SERVER_EVENTS.BOT_STATUS, status);
}

/**
 * Broadcast bot state to all connected dashboards
 */
export function broadcastBotState(io: Server, state: BotStatePayload): void {
  io.of(NAMESPACES.MAIN).to(ROOMS.ALL).emit(SERVER_EVENTS.BOT_STATE, state);
}

/**
 * Broadcast bulk update to all connected dashboards
 */
export function broadcastBulkUpdate(io: Server, state: BulkUpdatePayload): void {
  io.of(NAMESPACES.MAIN).to(ROOMS.ALL).emit(SERVER_EVENTS.BULK_UPDATE, state);
}

/**
 * Broadcast log entry to all connected dashboards
 */
export function broadcastLog(
  io: Server,
  entry: { level: string; tag: string; message: string }
): void {
  io.of(NAMESPACES.MAIN)
    .to(ROOMS.LOGS)
    .emit(SERVER_EVENTS.LOG_ENTRY, {
      ...entry,
      timestamp: new Date().toISOString(),
    });
}

/**
 * Broadcast chat message to all connected dashboards
 */
export function broadcastChatMessage(
  io: Server,
  username: string,
  message: string,
  type: 'chat' | 'whisper' | 'broadcast' = 'chat'
): void {
  io.of(NAMESPACES.MAIN).to(ROOMS.ALL).emit(SERVER_EVENTS.CHAT_MESSAGE, {
    username,
    message,
    type,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Broadcast command output to all connected dashboards
 */
export function broadcastCommandOutput(
  io: Server,
  message: string,
  type: 'reply' | 'private' | 'error' | 'info' = 'info'
): void {
  io.of(NAMESPACES.MAIN).to(ROOMS.ALL).emit(SERVER_EVENTS.COMMAND_OUTPUT, {
    message,
    type,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Initialize all namespaces
 */
export function initializeAllNamespaces(io: Server, botManager: BotManager): void {
  setupMainNamespace(io, botManager);
  setupAdminNamespace(io, botManager);
  setupCommandsNamespace(io, botManager);

  // Make botManager available to broadcast functions
  (io as { botManager?: BotManager }).botManager = botManager;
}
