/**
 * BotManager - Main bot lifecycle manager
 * Handles connection, reconnection, state management, plugins, and graceful shutdown
 */

import { EventEmitter } from 'events';
import mineflayer from 'mineflayer';
import type { Bot, BotOptions } from 'mineflayer';
import { pathfinder, goals } from 'mineflayer-pathfinder';
import type { Vec3 } from 'vec3';
import type { Window } from 'prismarine-windows';

import type {
  BotConfig,
  BotManager as BotManagerInterface,
  BotStatus,
  Plugin,
  PluginManager,
  BotEvents,
  ShutdownOptions,
} from './types.js';
import { BotState } from './types.js';

import { StateMachine } from './StateMachine.js';
import { ConfigLoader } from './Config.js';
import { PluginManager as PluginManagerImpl } from './PluginManager.js';
import { BotEventEmitter, EventNames } from './events.js';

// Type for bot event handlers - using a more flexible type
type BotEventHandler = (...args: unknown[]) => void;

/**
 * BotManager - Uses composition over inheritance for EventEmitter to avoid type conflicts
 * but implements the BotManagerInterface which requires EventEmitter-like methods
 */
export class BotManager implements BotManagerInterface {
  // Use a private EventEmitter instance for event handling
  private readonly emitter = new EventEmitter();

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
  private botEventHandlers = new Map<string, BotEventHandler[]>();
  private readonly botEventNames: string[] = [];

  constructor(configOptions?: Partial<BotConfig>) {
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
    this.emitter.setMaxListeners(100);
  }

  /**
   * Setup state machine transitions and handlers
   */
  private setupStateMachine(): void {
    // Global state change logging
    this.stateMachine.onEnter(async (from, to) => {
      console.log(`[BotManager] State transition: ${from} -> ${to}`);
      this.eventEmitter.emit(EventNames.STATE_CHANGE, to, from);
    });

    // Specific transition handlers
    this.stateMachine.addTransition({
      from: BotState.CONNECTING,
      to: BotState.CONNECTED,
      onEnter: async () => {
        this.reconnectAttempt = 0;
        this.startTime = Date.now();
        this.eventEmitter.emit(EventNames.CONNECT, this.bot!);
      },
    });

    this.stateMachine.addTransition({
      from: [BotState.CONNECTED, BotState.CONNECTING],
      to: BotState.RECONNECTING,
      onEnter: async () => {
        void this.handleReconnect();
      },
    });

    this.stateMachine.addTransition({
      from: BotState.RECONNECTING,
      to: BotState.CONNECTING,
      onEnter: async () => {
        await this.connect();
      },
    });

    this.stateMachine.addTransition({
      from: [BotState.CONNECTING, BotState.CONNECTED, BotState.RECONNECTING, BotState.DISCONNECTED],
      to: BotState.ERROR,
      onEnter: async (from, to) => {
        this.lastError = new Error(`State error: ${from} -> ${to}`);
        this.eventEmitter.emit(EventNames.ERROR, this.lastError);
      },
    });

    this.stateMachine.addTransition({
      from: [BotState.CONNECTING, BotState.CONNECTED, BotState.RECONNECTING, BotState.ERROR, BotState.DISCONNECTED],
      to: BotState.SHUTTING_DOWN,
      onEnter: async () => {
        this.isShuttingDown = true;
        await this.cleanup();
      },
    });

    this.stateMachine.addTransition({
      from: BotState.SHUTTING_DOWN,
      to: BotState.SHUTDOWN,
      onEnter: async () => {
        this.eventEmitter.emit(EventNames.SHUTDOWN);
        this.emitter.emit('shutdown');
      },
    });
  }

  /**
   * Setup event forwarding from eventEmitter to this manager
   */
  private setupEventForwarding(): void {
    // Forward all events from eventEmitter to this manager's emitter
    const events = Object.values(EventNames);
    events.forEach((eventName) => {
      this.eventEmitter.on(eventName, (...args: unknown[]) => {
        // Cast to string to satisfy EventEmitter.emit
        this.emitter.emit(eventName, ...args);
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
          checkTimeoutInterval: this._config.checkTimeoutInterval,
        };

        console.log(
          `[BotManager] Connecting to ${options.host}:${options.port} as ${options.username}`
        );

        this.bot = mineflayer.createBot(options);

        // Load pathfinder plugin
        this.bot.loadPlugin(pathfinder);

        // Setup bot event handlers
        this.setupBotEvents();

        // Handle connection events
        this.bot.once('spawn', () => {
          console.log('[BotManager] Bot spawned');
          void this.stateMachine.transition(BotState.CONNECTED).then((success) => {
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

        this.bot.once('kicked', (reason: string, _loggedIn: boolean) => {
          console.log('[BotManager] Kicked:', reason);
          if (this.stateMachine.getState() === BotState.CONNECTING) {
            this.handleConnectionError(new Error(reason));
            reject(new Error(reason));
          }
        });
      } catch (error) {
        void this.stateMachine.transition(BotState.ERROR);
        reject(error);
      }
    });
  }

  /**
   * Setup bot event handlers
   */
  private setupBotEvents(): void {
    if (!this.bot) return;

    const handlers: { event: string; handler: BotEventHandler }[] = [
      // Spawn event
      {
        event: 'spawn',
        handler: () => {
          this.eventEmitter.emit(EventNames.SPAWN);
        },
      },

      // Death event
      {
        event: 'death',
        handler: () => {
          this.eventEmitter.emit(EventNames.DEATH);
        },
      },

      // Chat event
      {
        event: 'chat',
        handler: ((username: string, message: string, _type: string) => {
          if (username === this.bot!.username) return;
          this.eventEmitter.emit(EventNames.CHAT, username, message, _type);
        }) as BotEventHandler,
      },

      // Whisper event
      {
        event: 'whisper',
        handler: ((username: string, message: string, _type: string) => {
          this.eventEmitter.emit(EventNames.CHAT, username, message, 'whisper');
        }) as BotEventHandler,
      },

      // Error event
      {
        event: 'error',
        handler: ((error: Error) => {
          console.error('[BotManager] Bot error:', error.message);
          this.lastError = error;
          this.eventEmitter.emit(EventNames.ERROR, error);

          // Check if we should reconnect
          if (this.stateMachine.getState() === BotState.CONNECTED) {
            void this.stateMachine.transition(BotState.RECONNECTING);
          }
        }) as BotEventHandler,
      },

      // End event (disconnect)
      {
        event: 'end',
        handler: ((reason: string) => {
          console.log('[BotManager] Disconnected:', reason);
          this.eventEmitter.emit(EventNames.DISCONNECT, reason);

          if (!this.isShuttingDown && this._config.reconnect.enabled) {
            void this.stateMachine.transition(BotState.RECONNECTING);
          } else {
            void this.stateMachine.transition(BotState.DISCONNECTED);
          }
        }) as BotEventHandler,
      },

      // Kicked event
      {
        event: 'kicked',
        handler: ((reason: string, _loggedIn: boolean) => {
          console.log('[BotManager] Kicked:', reason);
          this.eventEmitter.emit(EventNames.DISCONNECT, `Kicked: ${reason}`);

          if (!this.isShuttingDown && this._config.reconnect.enabled) {
            void this.stateMachine.transition(BotState.RECONNECTING);
          } else {
            void this.stateMachine.transition(BotState.DISCONNECTED);
          }
        }) as BotEventHandler,
      },

      // Health changes
      {
        event: 'health',
        handler: () => {
          this.emitter.emit('healthChange', this.bot!.health, this.bot!.food);
        },
      },

      // Position changes
      {
        event: 'move',
        handler: () => {
          this.emitter.emit('positionChange', this.bot!.entity.position);
        },
      },

      // Inventory changes
      {
        event: 'windowOpen',
        handler: ((window: Window) => {
          this.emitter.emit('windowOpen', window);
        }) as BotEventHandler,
      },

      {
        event: 'windowClose',
        handler: ((window: Window) => {
          this.emitter.emit('windowClose', window);
        }) as BotEventHandler,
      },
    ];

    // Register all handlers
    handlers.forEach(({ event, handler }) => {
      (this.bot as any).on(event, handler);
      if (!this.botEventHandlers.has(event)) {
        this.botEventHandlers.set(event, []);
        this.botEventNames.push(event);
      }
      this.botEventHandlers.get(event)!.push(handler);
    });
  }

  /**
   * Handle connection error
   */
  private handleConnectionError(error: Error): void {
    this.lastError = error;
    void this.stateMachine.transition(BotState.ERROR);
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
      this.eventEmitter.emit(EventNames.RECONNECT_FAILED, error);
      void this.stateMachine.transition(BotState.ERROR);
      return;
    }

    this.reconnectAttempt++;
    const delay = exponentialBackoff
      ? Math.min(baseDelay * Math.pow(2, this.reconnectAttempt - 1), maxDelay)
      : baseDelay;

    console.log(
      `[BotManager] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}/${maxAttempts})`
    );

    this.eventEmitter.emit(EventNames.RECONNECT, this.reconnectAttempt);

    // Wait for delay
    await new Promise((resolve) => {
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
      this.botEventNames.forEach((event) => {
        const handlers = this.botEventHandlers.get(event);
        if (handlers) {
          handlers.forEach((handler) => {
            (this.bot as any).off(event, handler);
          });
        }
      });
      this.botEventHandlers.clear();
      this.botEventNames.length = 0;
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
      saveState: options.saveState ?? true,
    };

    console.log('[BotManager] Stopping...');

    // Transition to shutting down state
    await this.stateMachine.transition(BotState.SHUTTING_DOWN);

    // Wait for shutdown with timeout
    await Promise.race([
      new Promise<void>((resolve) => this.once('shutdown', resolve)),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown timeout')), opts.timeout)
      ),
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
      lastError: this.lastError ?? undefined,
      plugins: this.pluginManager.getLoadOrder(),
      memoryUsage: process.memoryUsage(),
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

    const goal = new goals.GoalBlock(x, y, z);
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
  getInventory(): ReturnType<Bot['inventory']['items']> {
    return this.bot?.inventory.items() ?? [];
  }

  // EventEmitter delegation - delegate to internal emitter
  on<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    this.emitter.on(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    this.emitter.once(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof BotEvents>(event: K, ...args: BotEvents[K]): boolean {
    return this.emitter.emit(event as string, ...args);
  }

  off<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    this.emitter.off(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  // Additional EventEmitter methods for compatibility
  setMaxListeners(n: number): this {
    this.emitter.setMaxListeners(n);
    return this;
  }

  getMaxListeners(): number {
    return this.emitter.getMaxListeners();
  }

  listenerCount(eventName: string | symbol): number {
    return this.emitter.listenerCount(eventName);
  }

  eventNames(): (string | symbol)[] {
    return this.emitter.eventNames();
  }

  prependListener<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    this.emitter.prependListener(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  prependOnceListener<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    this.emitter.prependOnceListener(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  removeAllListeners<K extends keyof BotEvents>(event?: K): this {
    this.emitter.removeAllListeners(event as string | undefined);
    return this;
  }
}

export default BotManager;

/**
 * Factory function to create a BotManager
 */
export function createBotManager(config?: Partial<BotConfig>): BotManager {
  return new BotManager(config);
}