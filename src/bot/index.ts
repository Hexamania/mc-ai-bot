/**
 * Bot core module for mc-ai-bot
 * Handles Mineflayer bot connection, reconnection, events, and state management
 */

import type { Bot } from 'mineflayer';
import * as mineflayer from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import mcDataLoader = require('minecraft-data');
import { EventEmitter } from 'events';
import { getConfig } from '../config';
import type { BotConfig, BotState, BotStatus, BotPosition, MapBlock, MapEntity, Equipment, AppConfig } from '../types';
import { loadMemory, rememberLocation, rememberPlayer, persistMemory } from '../memory';
import { getCommandRegistry, createCommandContext, parseCommand } from '../commands';
import { getFeatureRegistry } from '../plugins';
import type { Server as SocketIOServer } from 'socket.io';

// Extend FeatureRegistry with initializeAll and shutdownAll methods
import type { FeatureRegistry } from '../types';

interface ExtendedFeatureRegistry extends FeatureRegistry {
  initializeAll(bot: Bot): Promise<void>;
  shutdownAll(): Promise<void>;
}

/**
 * Bot manager class - handles bot lifecycle and state
 */
export class BotManager extends EventEmitter {
  private bot: Bot | null = null;
  private client: mineflayer.Bot | null = null;
  private mcData: unknown = null;
  private movements: Movements | null = null;

  // Connection state
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private isOnline = false;
  private statusEvent = 'connecting';
  private statusReason: string | null = null;
  private statusError: string | null = null;
  private retryAt: number | null = null;

  // Dashboard intervals
  private dashboardInterval: NodeJS.Timeout | null = null;
  private spawnLookInterval: NodeJS.Timeout | null = null;

  // Bot state
  private state: BotState = {
    status: 'Offline',
    users: [],
    admins: [],
    logs: ['Bot manager initialized'],
    settings: { theme: 'dark', autoDefense: true, autoArmor: true, stealth: false },
    botData: { health: 20, food: 20, pos: { x: 0, y: 0, z: 0 } },
    inventory: [],
    currentPath: [],
    favorites: {},
    equipment: {
      head: 'Empty',
      chest: 'Empty',
      legs: 'Empty',
      feet: 'Empty',
      hand: 'Empty',
      offhand: 'Empty',
    },
    mapData: { blocks: [], entities: [] },
  };

  // Feature flags
  roaming = false;
  following = false;
  followTarget: string | null = null;
  pvpTarget: string | null = null;
  miningBaseLocation: BotPosition | null = null;
  safeModeActive = false;
  killAuraActive = false;
  lumberjackActive = false;
  guarding = false;
  medicMode = false;
  medicTarget: string | null = null;
  progressionActive = false;
  minerActive = false;
  mineAreaActive = false;
  minerProgress = 0;
  minerTotal = 0;
  isDepositing = false;
  isFarming = false;
  isHandlingSafety = false;
  currentObjective = 'Idle';
  baseLocation: BotPosition | null = null;
  autoDefense = true;
  autoArmorEnabled = true;
  stealthMode = false;
  isShielding = false;
  waitingForHelp = false;
  helpObjective: string | null = null;

  // Admin sessions
  adminSessions: Record<string, boolean> = {};

  // Socket.io reference
  private io: SocketIOServer | null = null;

  constructor(private config: BotConfig) {
    super();
    this.loadBaseLocationFromMemory();
  }

  /**
   * Set Socket.io instance for real-time updates
   */
  setSocketIO(io: SocketIOServer): void {
    this.io = io;
  }

  /**
   * Get current bot instance
   */
  getBot(): Bot | null {
    return this.bot;
  }

  /**
   * Get current bot state
   */
  getState(): BotState {
    return this.state;
  }

  /**
   * Get current bot status
   */
  getStatus(): BotStatus {
    const fullConfig = getConfig();
    return {
      online: this.isOnline,
      username: this.client?.username || this.config.username,
      status: this.state.status,
      event: this.statusEvent,
      reason: this.statusReason,
      error: this.statusError,
      retryAt: this.retryAt,
      retryInMs: this.retryAt ? Math.max(0, this.retryAt - Date.now()) : null,
    };
  }

  /**
   * Load base location from memory
   */
  private loadBaseLocationFromMemory(): void {
    const memory = loadMemory();
    this.baseLocation = memory.locations.home || null;
    this.miningBaseLocation = memory.locations.miningBase || null;

    // Load favorites
    for (const [name, location] of Object.entries(memory.locations)) {
      if (location.type === 'favorite' && name.startsWith('favorite:')) {
        this.state.favorites[name.slice('favorite:'.length)] = {
          x: location.x,
          y: location.y,
          z: location.z,
        };
      }
    }
  }

  /**
   * Log a message to console and dashboard
   */
  log(tag: string, message: string): void {
    const entry = `[${tag}] ${message}`;
    console.log(entry);
    this.state.logs.push(entry);
    if (this.state.logs.length > 100) this.state.logs.shift();
    this.io?.emit('log', entry);
    if (tag === 'ERROR' || tag.includes('ERR')) this.say(`⚠️ ${tag}: ${message}`);
  }

  /**
   * Send a chat message
   */
  say(message: string): void {
    console.log('[BOT SAY]', message);
    if (this.isOnline && this.bot?.entity) {
      this.bot.chat(message);
    }
  }

  /**
   * Send a private message
   */
  pm(username: string, message: string): void {
    console.log(`[BOT PM -> ${username}]`, message);
    this.bot?.chat(`/msg ${username} ${message}`);
  }

  /**
   * Emit bot status to dashboard
   */
  private emitBotStatus(extra: Partial<BotStatus> = {}): void {
    this.io?.emit('bot_status', { ...this.getStatus(), ...extra });
  }

  /**
   * Format connection reason for logging
   */
  private formatConnectionReason(reason: unknown): string {
    if (typeof reason === 'string') return reason;
    if (reason && typeof reason === 'object') {
      try {
        return JSON.stringify(reason);
      } catch {
        return reason.toString();
      }
    }
    return reason == null ? 'Unknown reason' : String(reason);
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(
    instance: mineflayer.Bot,
    reason: string,
    detail: string,
    status = 'Reconnecting',
    event = 'end'
  ): void {
    if (instance !== this.client) return;

    this.isOnline = false;

    if (this.reconnectTimer) {
      if (status === 'Error' && (this.state.status !== 'Error' || event === 'kicked')) {
        this.state.status = status;
        this.statusEvent = event;
        this.statusReason = reason;
        this.statusError = detail || reason;
      }
      this.emitBotStatus();
      return;
    }

    this.state.status = status;
    this.statusEvent = event;
    this.statusReason = reason;
    this.statusError = status === 'Error' ? detail || reason : null;

    const retryInMs = Math.min(1000 * 2 ** this.reconnectAttempt, 60000);
    this.reconnectAttempt += 1;
    this.retryAt = Date.now() + retryInMs;

    this.emitBotStatus();
    this.log(
      'RECONNECT',
      `${reason}${detail ? `: ${detail}` : ''}. Retrying in ${Math.round(retryInMs / 1000)}s.`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectBot();
    }, retryInMs);
  }

  /**
   * Connect to Minecraft server
   */
  connectBot(): void {
    this.state.status = 'Connecting';
    this.statusEvent = 'connecting';
    this.statusReason = null;
    this.statusError = null;
    this.retryAt = null;
    this.isOnline = false;
    this.emitBotStatus();

    try {
      const instance = mineflayer.createBot({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        password: this.config.password,
        version: this.config.version,
        auth: this.config.auth,
        checkTimeoutInterval: this.config.checkTimeoutInterval,
      });

      this.client = instance;
      this.bot = instance;
      instance.loadPlugin(pathfinder);

      // Set up event handlers
      this.setupEventHandlers(instance);

      // Re-attach any registered listeners
      // (In a full implementation, you'd store and re-attach listeners here)
    } catch (error) {
      this.isOnline = false;
      this.state.status = 'Offline';
      this.emitBotStatus({ reason: 'Connection setup failed' });
      this.log(
        'ERROR',
        `Unable to create bot connection: ${error instanceof Error ? error.message : String(error)}`
      );
      this.scheduleReconnect(
        this.client!,
        'Connection setup failed',
        error instanceof Error ? error.message : String(error),
        'Error',
        'error'
      );
    }
  }

  /**
   * Set up bot event handlers
   */
  private setupEventHandlers(instance: mineflayer.Bot): void {
    instance.on('login', () => {
      if (instance !== this.client) return;
      this.state.status = 'Connecting';
      this.statusEvent = 'login';
      this.statusReason = null;
      this.statusError = null;
      this.retryAt = null;
      this.emitBotStatus();
    });

    instance.on('spawn', () => this.onSpawn(instance));

    instance.on('end', (reason) => {
      if (instance !== this.client) return;
      this.clearSpawnLookInterval();
      this.scheduleReconnect(
        instance,
        'Disconnected',
        this.formatConnectionReason(reason),
        'Reconnecting',
        'end'
      );
    });

    instance.on('kicked', (kickReason) => {
      if (instance !== this.client) return;
      this.clearSpawnLookInterval();
      const detail = this.formatConnectionReason(kickReason);
      this.scheduleReconnect(instance, 'Kicked', detail, 'Error', 'kicked');
      this.log('KICKED', detail);
    });

    instance.on('error', (error) => {
      if (instance !== this.client) return;
      this.clearSpawnLookInterval();
      this.scheduleReconnect(instance, 'Connection error', error.message, 'Error', 'error');
      this.log('ERROR', error.message);
    });

    instance.on('death', () => {
      this.log('DEATH', 'Respawning...');
      if (this.bot?.entity?.position) {
        rememberLocation('lastDeath', this.bot.entity.position, 'death');
      }
      setTimeout(() => instance.emit('respawn'), 1000);
    });

    instance.on('message', (msg) => this.onMessage(instance, msg));

    // Forward other events - using void to handle boolean return
    instance.on('health', () => void this.emit('health'));
    instance.on('physicsTick', () => void this.emit('physicsTick'));
    instance.on('path_update', (r) => void this.emit('path_update', r));
    instance.on('goal_reached', () => void this.emit('goal_reached'));
    instance.on('playerCollect', (e) => void this.emit('playerCollect', e));
    instance.on('resourcePack', () => void this.emit('resourcePack'));
  }

  /**
   * Handle spawn event
   */
  private onSpawn(instance: mineflayer.Bot): void {
    if (instance !== this.client) return;

    this.log('SPAWN', 'Bot online');
    this.isOnline = true;
    this.reconnectAttempt = 0;
    this.state.status = 'Online';
    this.statusEvent = 'spawn';
    this.statusReason = null;
    this.statusError = null;
    this.retryAt = null;
    this.emitBotStatus();

    // Initialize minecraft-data and movements
    this.mcData = mcDataLoader(instance.version) || mcDataLoader(this.config.version);
    this.movements = new Movements(instance);

    // Configure movements - using available properties only
    this.movements.canDig = true;
    this.movements.allowParkour = true;
    this.movements.allowSprinting = true;
    instance.pathfinder.setMovements(this.movements);

    // Set up periodic look updates to prevent AFK kick
    this.setupSpawnLookInterval(instance);

    // Initialize features
    void this.initializeFeatures(instance);

    // Start dashboard updates
    this.startDashboardInterval(instance);

    this.say('🤖 Airi online | :help');
  }

  /**
   * Set up periodic look updates
   */
  private setupSpawnLookInterval(instance: mineflayer.Bot): void {
    let lookDirection = 1;
    const nudgeLook = () => {
      if (!this.isOnline || !instance.entity) return;
      instance
        .look(instance.entity.yaw + (lookDirection * Math.PI) / 90, instance.entity.pitch, true)
        .catch((error) => this.log('LOOK-ERR', `Spawn look update failed: ${error.message}`));
      lookDirection *= -1;
    };
    this.clearSpawnLookInterval();
    nudgeLook();
    this.spawnLookInterval = setInterval(nudgeLook, 15000);
  }

  private clearSpawnLookInterval(): void {
    if (this.spawnLookInterval) {
      clearInterval(this.spawnLookInterval);
      this.spawnLookInterval = null;
    }
  }

  /**
   * Initialize features after spawn
   */
  private async initializeFeatures(instance: mineflayer.Bot): Promise<void> {
    const featureRegistry = getFeatureRegistry() as ExtendedFeatureRegistry;
    await featureRegistry.initializeAll(instance);
  }

  /**
   * Start periodic dashboard updates
   */
  private startDashboardInterval(instance: mineflayer.Bot): void {
    this.clearDashboardInterval();
    this.dashboardInterval = setInterval(() => {
      if (instance.entity) {
        this.updateDashboardState(instance);
      }
    }, 500);
  }

  private clearDashboardInterval(): void {
    if (this.dashboardInterval) {
      clearInterval(this.dashboardInterval);
      this.dashboardInterval = null;
    }
  }

  /**
   * Update dashboard state with current bot data
   */
  private updateDashboardState(instance: mineflayer.Bot): void {
    // Update vitals
    this.state.botData = {
      health: instance.health,
      food: instance.food,
      pos: instance.entity.position,
    };

    // Update inventory
    this.state.inventory = instance.inventory.slots.map((item, index) => {
      if (!item) return { slot: index, name: 'air', count: 0, displayName: 'Empty' };
      return {
        slot: index,
        name: item.name,
        displayName: item.displayName,
        count: item.count,
      };
    });

    // Update equipment
    this.state.equipment = {
      head: instance.inventory.slots[5]?.displayName || 'Empty',
      chest: instance.inventory.slots[6]?.displayName || 'Empty',
      legs: instance.inventory.slots[7]?.displayName || 'Empty',
      feet: instance.inventory.slots[8]?.displayName || 'Empty',
      hand: instance.heldItem?.displayName || 'Empty',
      offhand: instance.inventory.slots[45]?.displayName || 'Empty',
    };

    // Update users and admins
    this.state.admins = Object.keys(this.adminSessions).filter((u) => this.adminSessions[u]);
    this.state.users = Object.keys(instance.players);

    // Generate map data
    const mapRadius = 15;
    const mapBlocks: MapBlock[] = [];
    for (let x = -mapRadius; x <= mapRadius; x++) {
      for (let z = -mapRadius; z <= mapRadius; z++) {
        const b =
          instance.blockAt(instance.entity.position.offset(x, -1, z)) ||
          instance.blockAt(instance.entity.position.offset(x, -2, z));
        if (b && b.name !== 'air') {
          mapBlocks.push({ x, z, name: b.name });
        }
      }
    }

    // Type the entities properly - use unknown to avoid type overlap issues
    const entities = Object.values(instance.entities) as unknown as Array<{
      position: { x: number; y: number; z: number; distanceTo: (pos: { x: number; y: number; z: number }) => number };
      username?: string;
      displayName?: string;
      name?: string;
      type?: string;
      id: number;
    }>;

    const botEntityId = instance.entity.id;
    const mapEntities: MapEntity[] = entities
      .filter(
        (e) => e.id !== botEntityId && e.position.distanceTo(instance.entity.position) < mapRadius
      )
      .map((e) => ({
        x: e.position.x - instance.entity.position.x,
        z: e.position.z - instance.entity.position.z,
        name: e.username || e.displayName || e.name || 'Unknown',
        isPlayer: e.type === 'player',
      }));

    this.state.mapData = { blocks: mapBlocks, entities: mapEntities };

    // Emit consolidated update
    this.io?.emit('bulk_update', { ...this.state, botData: this.state.botData });
  }

  /**
   * Handle incoming chat messages
   */
  private onMessage(instance: mineflayer.Bot, msg: unknown): void {
    const raw = String(msg);
    this.log('SERVER', raw);

    const parsed = this.parseMessage(raw);
    if (!parsed) return;

    const { user, msg: content, type } = parsed;
    rememberPlayer(user);
    const fullConfig = getConfig();
    const isAdmin = this.adminSessions[user] === true;

    // Handle waiting for help
    if (this.waitingForHelp) {
      this.handleHelpResponse(user, content);
      return;
    }

    // Handle admin login via PM
    if (type === 'pm' && content.startsWith(fullConfig.admin.prefix)) {
      this.handleAdminLogin(user, content);
      return;
    }

    // Process commands
    this.processCommand(user, content, type, isAdmin);
  }

  /**
   * Parse chat message
   */
  private parseMessage(raw: string): { user: string; msg: string; type: 'chat' | 'pm' } | null {
    raw = raw.trim();

    // PM: [User -> me] message
    const pmMatch = raw.match(/^\[(.+?) -> me\] (.+)$/);
    if (pmMatch) return { user: pmMatch[1], msg: pmMatch[2], type: 'pm' };

    // PM: User whispers to you: message
    const whisperMatch = raw.match(/^(.+?) whispers to you: (.+)$/);
    if (whisperMatch) return { user: whisperMatch[1], msg: whisperMatch[2], type: 'pm' };

    // Chat: <User> Message
    const chatMatch = raw.match(/^<(.+?)> (.+)$/);
    if (chatMatch) return { user: chatMatch[1], msg: chatMatch[2], type: 'chat' };

    // Chat: User » Message
    if (raw.includes('»')) {
      const [l, r] = raw.split('»');
      const u = l.match(/(\.?[A-Za-z0-9_]{3,16})/);
      if (u) return { user: u[1], msg: r.trim(), type: 'chat' };
    }

    return null;
  }

  /**
   * Handle help response
   */
  private handleHelpResponse(user: string, content: string): void {
    const lower = content.toLowerCase();
    if (lower === 'yes') {
      this.waitingForHelp = false;
      this.following = true;
      this.followTarget = user;
      this.say(`🤝 Okay! Leading the way to ${this.helpObjective}.`);
      this.followLoop();
    } else if (lower === 'no') {
      this.waitingForHelp = false;
      this.bot?.pathfinder.setGoal(null);
      this.say('🤷 Okay, I will wait here until I am needed or attacked.');
    }
  }

  /**
   * Handle admin login
   */
  private handleAdminLogin(user: string, content: string): void {
    const fullConfig = getConfig();
    const args = content.slice(1).split(' ');
    if (args[0] === 'loginadmin' && args.slice(1).join(' ') === fullConfig.admin.password) {
      this.adminSessions[user] = true;
      this.pm(user, '✅ Admin login successful');
      this.log('ADMIN', `${user} logged in`);
    }
  }

  /**
   * Process command
   */
  private processCommand(
    user: string,
    content: string,
    type: 'chat' | 'pm',
    isAdmin: boolean
  ): void {
    const fullConfig = getConfig();
    const isPublic = content.startsWith(fullConfig.prefix.public);
    const isAdminCmd = content.startsWith(fullConfig.prefix.admin);

    if (!isPublic && !isAdminCmd) return;

    const prefix = isAdminCmd ? fullConfig.prefix.admin : fullConfig.prefix.public;
    const parsed = parseCommand(content, prefix);
    if (!parsed) return;

    const { command, args } = parsed;
    const registry = getCommandRegistry();

    const context = createCommandContext(
      this.bot!,
      user,
      args,
      isAdmin,
      type === 'pm',
      (msg) => this.say(msg),
      (msg) => this.pm(user, msg)
    );

    void registry.execute(command, context);
  }

  /**
   * Follow loop
   */
  private followLoop(): void {
    if (!this.following || !this.followTarget || !this.bot) return;
    const target = this.bot.players[this.followTarget]?.entity;
    if (!target) return;

    this.bot.pathfinder.setMovements(this.movements!);
    this.bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
    setTimeout(() => this.followLoop(), 2000);
  }

  /**
   * Shutdown bot manager
   */
  async shutdown(): Promise<void> {
    this.clearDashboardInterval();
    this.clearSpawnLookInterval();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Shutdown features
    const featureRegistry = getFeatureRegistry() as ExtendedFeatureRegistry;
    await featureRegistry.shutdownAll();

    // Disconnect bot
    if (this.client) {
      this.client.quit();
      this.client = null;
      this.bot = null;
    }

    // Save memory
    persistMemory();

    this.log('SHUTDOWN', 'Bot manager shut down');
  }
}

/**
 * Create and return a BotManager instance
 */
export function createBotManager(config?: Partial<BotConfig>): BotManager {
  const fullConfig = getConfig();
  const botConfig: BotConfig = {
    ...fullConfig.bot,
    ...config,
  };
  return new BotManager(botConfig);
}