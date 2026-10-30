/**
 * BotManager - Main bot lifecycle manager
 * Handles connection, reconnection, state management, plugins, and graceful shutdown
 */

import { EventEmitter } from 'events';
import type { Bot, BotOptions } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import type { Vec3 } from 'vec3';

import type {
  BotConfig,
  BotManager as BotManagerInterface,
  BotStatus,
  Plugin,
  PluginManager,
  BotEvents,
  ShutdownOptions} from './types.js';
import {
  BotState,
  ReconnectConfig
} from './types.js';

import { StateMachine } from './StateMachine.js';
import { ConfigLoader } from './Config.js';
import { PluginManager as PluginManagerImpl } from './PluginManager.js';
import { BotEventEmitter, EventNames } from './events.js';

export class BotManager extends EventEmitter implements BotManagerInterface {
  // Core components
  private stateMachine: StateMachine;
  private pluginManager: PluginManagerImpl;
  private configLoader: ConfigLoader;
  private eventEmitter: BotEventEmitter;

  // Bot instance
  private bot: Bot | null = null;
  private _config: BotConfig;

  // Connection state
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private startTime = 0;
  private lastError: Error | null = null;

  // Mineflayer event handlers storage for cleanup
  private botEventHandlers = new Map<string, Function[]>();

  constructor(configOptions?: Partial<BotConfig>) {
    super();

    // Initialize components
    this.stateMachine = new StateMachine(BotState.DISCONNECTED);
    this.pluginManager = new PluginManagerImpl();
    this.configLoader = new ConfigLoader({ defaults: configOptions });
    this.eventEmitter = new BotEventEmitter();

    // Load configuration
    this._config = this.configLoader.load();

    // Setup state machine handlers
    this.setupStateMachine();

    // Setup event forwarding
    this.setupEventForwarding();

    // Set max listeners
    this.setMaxListeners(100);
  }

  /**
   * Setup state machine transitions and handlers
   */
  private setupStateMachine(): void {
    // Global state change logging
    this.stateMachine.onEnter(async (from, to) => {
      console.log(`[BotManager] State transition: ${from} -> ${to}`);
      this.eventEmitter.emit(EventNames.STATE_CHANGE, {
        newState: to,
        oldState: from,
        timestamp: Date.now()
      });
    });

    // Specific transition handlers
    this.stateMachine.addTransition({
      from: BotState.CONNECTING,
      to: BotState.CONNECTED,
      onEnter: async () => {
        this.reconnectAttempt = 0;
        this.startTime = Date.now();
        this.eventEmitter.emit(EventNames.CONNECT, {
          bot: this.bot,
          timestamp: Date.now()
        });
      }
    });

    this.stateMachine.addTransition({
      from: [BotState.CONNECTED, BotState.CONNECTING],
      to: BotState.RECONNECTING,
      onEnter: async () => {
        await this.handleReconnect();
      }
    });

    this.stateMachine.addTransition({
      from: BotState.RECONNECTING,
      to: BotState.CONNECTING,
      onEnter: async () => {
        await this.connect();
      }
    });

    this.stateMachine.addTransition({
      from: '*',
      to: BotState.ERROR,
      onEnter: async (from, to) => {
        this.lastError = new Error(`State error: ${from} -> ${to}`);
        this.eventEmitter.emit(EventNames.ERROR, {
          error: this.lastError,
          timestamp: Date.now(),
          fatal: false
        });
      }
    });

    this.stateMachine.addTransition({
      from: '*',
      to: BotState.SHUTTING_DOWN,
      onEnter: async () => {
        this.isShuttingDown = true;
        await this.cleanup();
      }
    });

    this.stateMachine.addTransition({
      from: BotState.SHUTTING_DOWN,
      to: BotState.SHUTDOWN,
      onEnter: async () => {
        this.eventEmitter.emit(EventNames.SHUTDOWN, {
          reason: 'Graceful shutdown',
          timestamp: Date.now()
        });
        this.emit('shutdown');
      }
    });
  }

  /**
   * Setup event forwarding from eventEmitter to this manager
   */
  private setupEventForwarding(): void {
    // Forward all events from eventEmitter to this manager
    const events = Object.values(EventNames);
    events.forEach(eventName => {
      this.eventEmitter.on(eventName, (...args: any[]) => {
        this.emit(eventName, ...args);
      });
    });
  }

  /**
   * Connect to the Minecraft server
   */
  async connect(): Promise<Bot> {
    if (this.bot) {
      throw new Error('Bot already connected. Call disconnect() first.');
    }

    await this.stateMachine.transition(BotState.CONNECTING);

    return new Promise((resolve, reject) => {
      try {
        const options: BotOptions = {
          host: this._config.host,
          port: this._config.port,
          username: this._config.username,
          password: this._config.password,
          version: this._config.version,
          auth: this._config.auth,
          checkTimeoutInterval: this._config.checkTimeoutInterval
        };

        console.log(`[BotManager] Connecting to ${options.host}:${options.port} as ${options.username}`);

        this.bot = mineflayer.createBot(options);

        // Load pathfinder plugin
        this.bot.loadPlugin(pathfinder);

        // Setup bot event handlers
        this.setupBotEvents();

        // Handle connection events
        this.bot.once('spawn', () => {
          console.log('[BotManager] Bot spawned');
          this.stateMachine.transition(BotState.CONNECTED).then(success => {
            if (success) {
              resolve(this.bot!);
            } else {
              reject(new Error('Failed to transition to CONNECTED state'));
            }
          });
        });

        this.bot.once('error', (error: Error) => {
          console.error('[BotManager] Connection error:', error.message);
          this.handleConnectionError(error);
          reject(error);
        });

        this.bot.once('end', (reason: string) => {
          console.log('[BotManager] Connection ended:', reason);
          if (this.stateMachine.getState() === BotState.CONNECTING) {
            this.handleConnectionError(new Error(reason));
            reject(new Error(reason));
          }
        });

        this.bot.once('kicked', (reason: string, loggedIn: boolean) => {
          console.log('[BotManager] Kicked:', reason);
          if (this.stateMachine.getState() === BotState.CONNECTING) {
            this.handleConnectionError(new Error(reason));
            reject(new Error(reason));
          }
        });

      } catch (error) {
        this.stateMachine.transition(BotState.ERROR);
        reject(error);
      }
    });
  }

  /**
   * Setup bot event handlers
   */
  private setupBotEvents(): void {
    if (!this.bot) return;

    const handlers: { event: string; handler: Function }[] = [
      // Spawn event
      {
        event: 'spawn',
        handler: () => {
          this.eventEmitter.emit(EventNames.SPAWN, {
            position: this.bot!.entity.position,
            timestamp: Date.now()
          });
        }
      },

      // Death event
      {
        event: 'death',
        handler: () => {
          this.eventEmitter.emit(EventNames.DEATH, {
            location: this.bot!.entity.position,
            timestamp: Date.now()
          });
        }
      },

      // Chat event
      {
        event: 'chat',
        handler: (username: string, message: string, type: string) => {
          if (username === this.bot!.username) return;
          this.eventEmitter.emit(EventNames.CHAT, {
            username,
            message,
            type,
            timestamp: Date.now()
          });
        }
      },

      // Whisper event
      {
        event: 'whisper',
        handler: (username: string, message: string, type: string) => {
          this.eventEmitter.emit(EventNames.CHAT, {
            username,
            message,
            type: 'whisper',
            timestamp: Date.now()
          });
        }
      },

      // Error event
      {
        event: 'error',
        handler: (error: Error) => {
          console.error('[BotManager] Bot error:', error.message);
          this.lastError = error;
          this.eventEmitter.emit(EventNames.ERROR, {
            error,
            timestamp: Date.now(),
            fatal: false
          });

          // Check if we should reconnect
          if (this.stateMachine.getState() === BotState.CONNECTED) {
            this.stateMachine.transition(BotState.RECONNECTING);
          }
        }
      },

      // End event (disconnect)
      {
        event: 'end',
        handler: (reason: string) => {
          console.log('[BotManager] Disconnected:', reason);
          this.eventEmitter.emit(EventNames.DISCONNECT, {
            reason,
            timestamp: Date.now()
          });

          if (!this.isShuttingDown && this._config.reconnect.enabled) {
            this.stateMachine.transition(BotState.RECONNECTING);
          } else {
            this.stateMachine.transition(BotState.DISCONNECTED);
          }
        }
      },

      // Kicked event
      {
        event: 'kicked',
        handler: (reason: string, loggedIn: boolean) => {
          console.log('[BotManager] Kicked:', reason);
          this.eventEmitter.emit(EventNames.DISCONNECT, {
            reason: `Kicked: ${reason}`,
            timestamp: Date.now()
          });

          if (!this.isShuttingDown && this._config.reconnect.enabled) {
            this.stateMachine.transition(BotState.RECONNECTING);
          } else {
            this.stateMachine.transition(BotState.DISCONNECTED);
          }
        }
      },

      // Health changes
      {
        event: 'health',
        handler: () => {
          this.emit('healthChange', this.bot!.health, this.bot!.food);
        }
      },

      // Position changes
      {
        event: 'move',
        handler: () => {
          this.emit('positionChange', this.bot!.entity.position);
        }
      },

      // Inventory changes
      {
        event: 'windowOpen',
        handler: (window: any) => {
          this.emit('windowOpen', window);
        }
      },

      {
        event: 'windowClose',
        handler: (window: any) => {
          this.emit('windowClose', window);
        }
      }
    ];

    // Register all handlers
    handlers.forEach(({ event, handler }) => {
      this.bot!.on(event, handler);
      if (!this.botEventHandlers.has(event)) {
        this.botEventHandlers.set(event, []);
      }
      this.botEventHandlers.get(event)!.push(handler);
    });
  }

  /**
   * Handle connection error
   */
  private handleConnectionError(error: Error): void {
    this.lastError = error;
    this.stateMachine.transition(BotState.ERROR);
  }

  /**
   * Handle reconnection logic
   */
  private async handleReconnect(): Promise<void> {
    if (this.isShuttingDown) return;

    const { maxAttempts, baseDelay, maxDelay, exponentialBackoff } = this._config.reconnect;

    if (this.reconnectAttempt >= maxAttempts) {
      console.error(`[BotManager] Max reconnect attempts (${maxAttempts}) reached`);
      const error = new Error(`Max reconnect attempts (${maxAttempts}) reached`);
      this.eventEmitter.emit(EventNames.RECONNECT_FAILED, {
        error,
        attempts: this.reconnectAttempt,
        timestamp: Date.now()
      });
      this.stateMachine.transition(BotState.ERROR);
      return;
    }

    this.reconnectAttempt++;
    const delay = exponentialBackoff
      ? Math.min(baseDelay * Math.pow(2, this.reconnectAttempt - 1), maxDelay)
      : baseDelay;

    console.log(`[BotManager] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}/${maxAttempts})`);

    this.eventEmitter.emit(EventNames.RECONNECT, {
      attempt: this.reconnectAttempt,
      delay,
      timestamp: Date.now()
    });

    // Wait for delay
    await new Promise(resolve => {
      this.reconnectTimer = setTimeout(resolve, delay);
    });

    this.reconnectTimer = null;

    // Transition to CONNECTING to trigger new connection
    await this.stateMachine.transition(BotState.CONNECTING);
  }

  /**
   * Disconnect from the server
   */
  async disconnect(reason = 'Manual disconnect'): Promise<void> {
    if (!this.bot) return;

    console.log('[BotManager] Disconnecting:', reason);

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Quit the bot
    this.bot.quit(reason);
    this.bot = null;

    await this.stateMachine.transition(BotState.DISCONNECTED);
  }

  /**
   * Cleanup bot resources
   */
  private async cleanup(): Promise<void> {
    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Remove all bot event handlers
    if (this.bot) {
      this.botEventHandlers.forEach((handlers, event) => {
        handlers.forEach(handler => {
          this.bot!.off(event, handler);
        });
      });
      this.botEventHandlers.clear();
    }

    // Unload all plugins
    await this.pluginManager.unloadAll();
  }

  /**
   * Start the bot manager
   */
  async start(): Promise<void> {
    console.log('[BotManager] Starting...');
    await this.connect();
    console.log('[BotManager] Started successfully');
  }

  /**
   * Stop the bot manager gracefully
   */
  async stop(options: Partial<ShutdownOptions> = {}): Promise<void> {
    const opts: ShutdownOptions = {
      timeout: options.timeout ?? 10000,
      forceExit: options.forceExit ?? false,
      saveState: options.saveState ?? true
    };

    console.log('[BotManager] Stopping...');

    // Transition to shutting down state
    await this.stateMachine.transition(BotState.SHUTTING_DOWN);

    // Wait for shutdown with timeout
    await Promise.race([
      new Promise<void>(resolve => this.once('shutdown', resolve)),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown timeout')), opts.timeout)
      )
    ]);

    console.log('[BotManager] Stopped');

    if (opts.forceExit) {
      process.exit(0);
    }
  }

  /**
   * Restart the bot
   */
  async restart(): Promise<void> {
    console.log('[BotManager] Restarting...');
    await this.disconnect('Restart');
    await this.connect();
    console.log('[BotManager] Restarted');
  }

  /**
   * Get current state
   */
  getState(): BotState {
    return this.stateMachine.getState();
  }

  /**
   * Get bot status
   */
  getStatus(): BotStatus {
    return {
      state: this.getState(),
      username: this.bot?.username,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      reconnectAttempts: this.reconnectAttempt,
      lastError: this.lastError,
      plugins: this.pluginManager.getLoadOrder(),
      memoryUsage: process.memoryUsage()
    };
  }

  /**
   * Get the bot instance
   */
  getBot(): Bot | null {
    return this.bot;
  }

  /**
   * Check if bot is online
   */
  isOnline(): boolean {
    return this.stateMachine.isInState(BotState.CONNECTED) && this.bot !== null;
  }

  /**
   * Get plugin manager
   */
  get plugins(): PluginManager {
    return this.pluginManager;
  }

  /**
   * Get configuration
   */
  get config(): BotConfig {
    return this.configLoader.getConfig();
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(updates: Partial<BotConfig>): BotConfig {
    return this.configLoader.updateConfig(updates);
  }

  /**
   * Load a plugin
   */
  async loadPlugin(plugin: Plugin): Promise<void> {
    await this.pluginManager.load(plugin);
  }

  /**
   * Load multiple plugins
   */
  async loadPlugins(plugins: Plugin[]): Promise<void> {
    await this.pluginManager.loadAll(plugins);
  }

  /**
   * Unload a plugin
   */
  async unloadPlugin(name: string): Promise<void> {
    await this.pluginManager.unload(name);
  }

  /**
   * Send a chat message
   */
  chat(message: string): void {
    if (this.bot && this.isOnline()) {
      this.bot.chat(message);
    }
  }

  /**
   * Send a command
   */
  command(command: string, args: string[] = []): void {
    if (this.bot && this.isOnline()) {
      const fullCommand = `/${command} ${args.join(' ')}`.trim();
      this.bot.chat(fullCommand);
    }
  }

  /**
   * Move bot to position
   */
  async moveTo(x: number, y: number, z: number): Promise<void> {
    if (!this.bot || !this.isOnline()) {
      throw new Error('Bot not connected');
    }

    const goal = new (require('mineflayer-pathfinder').goals.GoalBlock)(x, y, z);
    await this.bot.pathfinder.goto(goal);
  }

  /**
   * Get bot position
   */
  getPosition(): Vec3 | null {
    return this.bot?.entity.position ?? null;
  }

  /**
   * Get bot health
   */
  getHealth(): number {
    return this.bot?.health ?? 0;
  }

  /**
   * Get bot food level
   */
  getFood(): number {
    return this.bot?.food ?? 0;
  }

  /**
   * Get bot inventory
   */
  getInventory(): any[] {
    return this.bot?.inventory.items() ?? [];
  }

  // EventEmitter delegation
  on<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    return super.on(event, listener);
  }

  once<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    return super.once(event, listener);
  }

  emit<K extends keyof BotEvents>(event: K, ...args: BotEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  off<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    return super.off(event, listener);
  }
}

export default BotManager;

/**
 * Factory function to create a BotManager
 */
export function createBotManager(config?: Partial<BotConfig>): BotManager {
  return new BotManager(config);
}