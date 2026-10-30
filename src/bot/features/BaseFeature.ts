/**
 * Base Feature Class
 * Extends the BasePlugin from PluginManager for consistent plugin architecture
 */

import type { Bot } from 'mineflayer';
import { BasePlugin } from '../PluginManager.js';
import type { PluginConfig, BotManager, BotEvents } from '../types.js';
import type { Feature, FeatureRegistry } from '../../types/index.js';
import type { MovementFeature } from './MovementFeature.js';
import type { InventoryFeature } from './InventoryFeature.js';
import type { CombatFeature } from './CombatFeature.js';
import type { BuildingFeature } from './BuildingFeature.js';
import type { MiningFeature } from './MiningFeature.js';
import type { FarmingFeature } from './FarmingFeature.js';
import type { ChatAIFeature } from './ChatAIFeature.js';
import type { FollowFeature } from './FollowFeature.js';
import type { GuardFeature } from './GuardFeature.js';
import type { RoamFeature } from './RoamFeature.js';

/**
 * Extended plugin configuration with feature-specific options
 */
export type FeaturePluginConfig = PluginConfig;

/**
 * Base feature class that wraps the plugin system
 * Provides a consistent interface for all bot features
 */
export abstract class BaseFeature extends BasePlugin implements Feature {
  public readonly dependencies: string[] = [];
  public enabled = true;

  // Override description to be required (not optional like in BasePlugin)
  public override readonly description: string;

  protected registry: FeatureRegistry | null = null;
  protected config: FeaturePluginConfig = { name: '', enabled: true };

  constructor(
    name: string,
    version: string,
    description: string,
    dependencies: string[] = []
  ) {
    super(name, version, description, dependencies);
    this.description = description;
    this.dependencies = dependencies;
  }

  /**
   * Initialize the feature with bot, manager, and registry
   * Called by the plugin manager
   */
  async initialize(bot: Bot, manager: BotManager): Promise<void> {
    // Call parent initialize which calls onEnable
    await super.initialize(bot, manager);

    // Initialize feature-specific logic
    await this.onEnable();
  }

  /**
   * Shutdown the feature
   * Called by the plugin manager
   */
  async shutdown(): Promise<void> {
    await this.onDisable();
    await super.shutdown();
  }

  /**
   * Called when feature is enabled - override in subclasses
   * Matches BasePlugin's abstract method
   */
  protected abstract onEnable(): Promise<void> | void;

  /**
   * Called when feature is disabled - override in subclasses
   * Matches BasePlugin's abstract method
   */
  protected abstract onDisable(): Promise<void> | void;

  /**
   * Set the feature registry (for accessing other features)
   */
  setRegistry(registry: FeatureRegistry): void {
    this.registry = registry;
  }

  /**
   * Get the feature registry
   */
  getRegistry(): FeatureRegistry | null {
    return this.registry;
  }

  /**
   * Get another feature by name
   */
  protected getFeature<T extends BaseFeature>(name: string): T | undefined {
    return this.registry?.get(name) as T | undefined;
  }

  /**
   * Get movement feature
   */
  protected getMovementFeature(): MovementFeature | undefined {
    return this.registry?.get('movement') as MovementFeature | undefined;
  }

  /**
   * Get inventory feature
   */
  protected getInventoryFeature(): InventoryFeature | undefined {
    return this.registry?.get('inventory') as InventoryFeature | undefined;
  }

  /**
   * Get combat feature
   */
  protected getCombatFeature(): CombatFeature | undefined {
    return this.registry?.get('combat') as CombatFeature | undefined;
  }

  /**
   * Get building feature
   */
  protected getBuildingFeature(): BuildingFeature | undefined {
    return this.registry?.get('building') as BuildingFeature | undefined;
  }

  /**
   * Get mining feature
   */
  protected getMiningFeature(): MiningFeature | undefined {
    return this.registry?.get('mining') as MiningFeature | undefined;
  }

  /**
   * Get farming feature
   */
  protected getFarmingFeature(): FarmingFeature | undefined {
    return this.registry?.get('farming') as FarmingFeature | undefined;
  }

  /**
   * Get chatAI feature
   */
  protected getChatAIFeature(): ChatAIFeature | undefined {
    return this.registry?.get('chatAI') as ChatAIFeature | undefined;
  }

  /**
   * Get follow feature
   */
  protected getFollowFeature(): FollowFeature | undefined {
    return this.registry?.get('follow') as FollowFeature | undefined;
  }

  /**
   * Get guard feature
   */
  protected getGuardFeature(): GuardFeature | undefined {
    return this.registry?.get('guard') as GuardFeature | undefined;
  }

  /**
   * Get roam feature
   */
  protected getRoamFeature(): RoamFeature | undefined {
    return this.registry?.get('roam') as RoamFeature | undefined;
  }

  /**
   * Update feature configuration
   */
  setConfig(config: Partial<FeaturePluginConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get feature configuration
   */
  getConfig(): FeaturePluginConfig {
    return { ...this.config };
  }

  /**
   * Check if feature is enabled
   */
  isEnabled(): boolean {
    return this.enabled && this.config.enabled !== false;
  }

  /**
   * Enable the feature
   */
  async enable(): Promise<void> {
    if (!this.enabled) {
      this.enabled = true;
      this.config.enabled = true;
      if (this.bot && this.manager) {
        await this.onEnable();
      }
    }
  }

  /**
   * Disable the feature
   */
  async disable(): Promise<void> {
    if (this.enabled) {
      this.enabled = false;
      this.config.enabled = false;
      await this.onDisable();
    }
  }

  /**
   * Get a configuration option with type safety
   */
  protected getOption<T>(key: string, defaultValue: T): T {
    const options = this.config.options as Record<string, unknown> | undefined;
    return (options?.[key] as T) ?? defaultValue;
  }

  /**
   * Set a configuration option
   */
  protected setOption(key: string, value: unknown): void {
    if (!this.config.options) {
      this.config.options = {};
    }
    this.config.options[key] = value;
  }

  /**
   * Emit an event to the bot manager
   */
  protected emit<K extends keyof BotEvents>(event: K, ...args: BotEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Listen for an event from the bot manager
   */
  protected on<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    return super.on(event, listener);
  }

  /**
   * Listen for an event once from the bot manager
   */
  protected once<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    return super.once(event, listener);
  }

  /**
   * Get the mineflayer bot instance
   */
  protected getBot(): Bot {
    if (!this.bot) throw new Error('Bot not initialized');
    return this.bot;
  }

  /**
   * Get the bot manager instance
   */
  protected getManager(): BotManager {
    if (!this.manager) throw new Error('Manager not initialized');
    return this.manager;
  }

  /**
   * Remove all event listeners from the manager
   */
  removeAllListeners(event?: string | symbol): this {
    if (this.manager) {
      const emitter = this.manager as unknown as { removeAllListeners: (event?: string | symbol) => void };
      if (event) {
        emitter.removeAllListeners(event);
      } else {
        emitter.removeAllListeners();
      }
    }
    return this;
  }
}

/**
 * Feature configuration interface for each feature type
 */
export interface FeatureConfig {
  name: string;
  enabled: boolean;
  options?: Record<string, unknown>;
}

/**
 * Default feature options
 */
export interface FeatureOptions {
  enabled?: boolean;
  priority?: number;
}