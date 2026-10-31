/**
 * Plugin Manager - Handles loading, unloading, and managing bot plugins
 */

import { EventEmitter } from 'events';
import type { Bot } from 'mineflayer';
import type {
  Plugin,
  PluginManager as PluginManagerInterface,
  PluginConfig,
  BotManager,
  BotEvents,
} from './types';

export class PluginManager extends EventEmitter implements PluginManagerInterface {
  private plugins = new Map<string, Plugin>();
  private loadOrder: string[] = [];
  private bot: Bot | null = null;
  private manager: BotManager | null = null;
  private configs = new Map<string, PluginConfig>();

  constructor() {
    super();
  }

  /**
   * Initialize the plugin manager with bot and manager instances
   */
  initialize(bot: Bot, manager: BotManager): void {
    this.bot = bot;
    this.manager = manager;
  }

  /**
   * Load a plugin
   */
  async load(plugin: Plugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin ${plugin.name} is already loaded`);
    }

    // Check dependencies
    if (plugin.dependencies) {
      for (const dep of plugin.dependencies) {
        if (!this.plugins.has(dep)) {
          throw new Error(`Plugin ${plugin.name} requires dependency: ${dep}`);
        }
      }
    }

    // Initialize plugin
    if (!this.bot || !this.manager) {
      throw new Error('Plugin manager not initialized with bot and manager');
    }

    try {
      // Call plugin's initialize method
      await Promise.resolve(plugin.initialize(this.bot, this.manager));

      // Register plugin
      this.plugins.set(plugin.name, plugin);
      this.loadOrder.push(plugin.name);

      // Emit load event
      this.emit('pluginLoad', plugin);
      this.manager.emit('pluginLoad', plugin);

      console.log(`[PluginManager] Loaded plugin: ${plugin.name} v${plugin.version}`);
    } catch (error) {
      console.error(`[PluginManager] Failed to load plugin ${plugin.name}:`, error);
      throw error;
    }
  }

  /**
   * Load multiple plugins in order
   */
  async loadAll(plugins: Plugin[]): Promise<void> {
    // Sort by dependencies (simple topological sort)
    const sorted = this.resolveLoadOrder(plugins);

    for (const plugin of sorted) {
      await this.load(plugin);
    }
  }

  /**
   * Resolve plugin load order based on dependencies
   */
  private resolveLoadOrder(plugins: Plugin[]): Plugin[] {
    const pluginMap = new Map(plugins.map((p) => [p.name, p]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: Plugin[] = [];

    const visit = (name: string) => {
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving: ${name}`);
      }
      if (visited.has(name)) return;

      visiting.add(name);
      const plugin = pluginMap.get(name);
      if (plugin?.dependencies) {
        for (const dep of plugin.dependencies) {
          visit(dep);
        }
      }
      visiting.delete(name);
      visited.add(name);
      if (plugin) result.push(plugin);
    };

    for (const plugin of plugins) {
      visit(plugin.name);
    }

    return result;
  }

  /**
   * Unload a plugin
   */
  async unload(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} is not loaded`);
    }

    // Check if other plugins depend on this one
    const dependents = this.loadOrder.filter((n) => {
      const p = this.plugins.get(n);
      return p?.dependencies?.includes(name);
    });

    if (dependents.length > 0) {
      throw new Error(`Cannot unload ${name}: required by ${dependents.join(', ')}`);
    }

    try {
      // Call plugin's shutdown method
      await Promise.resolve(plugin.shutdown());

      // Remove from registry
      this.plugins.delete(name);
      this.loadOrder = this.loadOrder.filter((n) => n !== name);

      // Emit unload event
      this.emit('pluginUnload', name);
      if (this.manager) {
        this.manager.emit('pluginUnload', name);
      }

      console.log(`[PluginManager] Unloaded plugin: ${name}`);
    } catch (error) {
      console.error(`[PluginManager] Failed to unload plugin ${name}:`, error);
      throw error;
    }
  }

  /**
   * Unload all plugins in reverse order
   */
  async unloadAll(): Promise<void> {
    // Unload in reverse load order
    for (let i = this.loadOrder.length - 1; i >= 0; i--) {
      const name = this.loadOrder[i];
      try {
        await this.unload(name);
      } catch (error) {
        console.error(`[PluginManager] Error unloading ${name}:`, error);
      }
    }
  }

  /**
   * Get a plugin by name
   */
  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all loaded plugins
   */
  getAll(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get plugin names in load order
   */
  getLoadOrder(): string[] {
    return [...this.loadOrder];
  }

  /**
   * Check if a plugin is loaded
   */
  isLoaded(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Get plugin count
   */
  size(): number {
    return this.plugins.size;
  }

  /**
   * Reload a plugin
   */
  async reload(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} is not loaded`);
    }

    await this.unload(name);
    await this.load(plugin);
  }

  /**
   * Enable/disable a plugin
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} is not loaded`);
    }

    const config = this.configs.get(name);
    if (config) {
      config.enabled = enabled;
    }

    if (enabled) {
      // Re-initialize if needed
      if (this.bot && this.manager) {
        await Promise.resolve(plugin.initialize(this.bot, this.manager));
      }
    } else {
      await Promise.resolve(plugin.shutdown());
    }
  }

  /**
   * Forward an event to all plugins that have onEvent handler
   */
  forwardEvent(event: string, data: unknown): void {
    for (const plugin of this.plugins.values()) {
      if (plugin.onEvent) {
        try {
          plugin.onEvent(event, data);
        } catch (error) {
          console.error(`[PluginManager] Error in plugin ${plugin.name} onEvent:`, error);
        }
      }
    }
  }

  /**
   * Register plugin configuration
   */
  registerConfig(config: PluginConfig): void {
    this.configs.set(config.name, config);
  }

  /**
   * Get plugin configuration
   */
  getConfig(name: string): PluginConfig | undefined {
    return this.configs.get(name);
  }

  /**
   * Get all plugin configurations
   */
  getAllConfigs(): PluginConfig[] {
    return Array.from(this.configs.values());
  }
}

export default PluginManager;

/**
 * Base plugin class for easier plugin development
 */
export abstract class BasePlugin implements Plugin {
  public readonly name: string;
  public readonly version: string;
  public readonly description?: string;
  public readonly dependencies?: string[];

  protected bot: Bot | null = null;
  protected manager: BotManager | null = null;

  constructor(name: string, version: string, description?: string, dependencies?: string[]) {
    this.name = name;
    this.version = version;
    this.description = description;
    this.dependencies = dependencies;
  }

  async initialize(bot: Bot, manager: BotManager): Promise<void> {
    this.bot = bot;
    this.manager = manager;
    await this.onEnable();
  }

  async shutdown(): Promise<void> {
    await this.onDisable();
    this.bot = null;
    this.manager = null;
  }

  // Override these in subclasses
  protected abstract onEnable(): Promise<void> | void;
  protected abstract onDisable(): Promise<void> | void;

  // Optional event handler
  onEvent?(event: string, data: unknown): void;

  // Helper methods
  protected getBot(): Bot {
    if (!this.bot) throw new Error('Bot not initialized');
    return this.bot;
  }

  protected getManager(): BotManager {
    if (!this.manager) throw new Error('Manager not initialized');
    return this.manager;
  }

  protected emit<K extends keyof BotEvents>(event: K, ...args: BotEvents[K]): boolean {
    return this.manager?.emit(event, ...args) ?? false;
  }

  protected on<K extends keyof BotEvents>(
    event: K,
    listener: (...args: BotEvents[K]) => void
  ): this {
    this.manager?.on(event, listener);
    return this;
  }

  protected once<K extends keyof BotEvents>(
    event: K,
    listener: (...args: BotEvents[K]) => void
  ): this {
    this.manager?.once(event, listener);
    return this;
  }
}
