/**
 * Feature Factory
 * Creates and manages all bot feature instances
 */

import type { Bot } from 'mineflayer';
import type { BotManager } from '../BotManager.js';
import type { BaseFeature } from './BaseFeature.js';
import { MovementFeature } from './MovementFeature.js';
import { InventoryFeature } from './InventoryFeature.js';
import { CombatFeature } from './CombatFeature.js';
import { BuildingFeature } from './BuildingFeature.js';
import { MiningFeature } from './MiningFeature.js';
import { FarmingFeature } from './FarmingFeature.js';
import { ChatAIFeature } from './ChatAIFeature.js';
import { FollowFeature } from './FollowFeature.js';
import { GuardFeature } from './GuardFeature.js';
import { RoamFeature } from './RoamFeature.js';

/**
 * Feature instances container
 */
export interface FeatureInstances {
  movement: MovementFeature;
  inventory: InventoryFeature;
  combat: CombatFeature;
  building: BuildingFeature;
  mining: MiningFeature;
  farming: FarmingFeature;
  chatAI: ChatAIFeature;
  follow: FollowFeature;
  guard: GuardFeature;
  roam: RoamFeature;
}

/**
 * Feature configuration map
 */
export interface FeatureConfigMap {
  movement?: any;
  inventory?: any;
  combat?: any;
  building?: any;
  mining?: any;
  farming?: any;
  chatAI?: any;
  follow?: any;
  guard?: any;
  roam?: any;
}

/**
 * Creates all feature instances
 * @param bot - The mineflayer bot instance
 * @param manager - The bot manager instance
 * @param configs - Optional configuration for each feature
 * @returns Object containing all feature instances
 */
export function createAllFeatures(bot: Bot, manager: BotManager, configs: FeatureConfigMap = {}): FeatureInstances {
  // Create all feature instances
  const features: FeatureInstances = {
    movement: new MovementFeature(),
    inventory: new InventoryFeature(),
    combat: new CombatFeature(),
    building: new BuildingFeature(),
    mining: new MiningFeature(),
    farming: new FarmingFeature(),
    chatAI: new ChatAIFeature(),
    follow: new FollowFeature(),
    guard: new GuardFeature(),
    roam: new RoamFeature(),
  };

  // Apply configurations
  for (const [key, config] of Object.entries(configs)) {
    if (config && features[key as keyof FeatureInstances]) {
      features[key as keyof FeatureInstances].configure(config);
    }
  }

  // Initialize all features with the bot and manager
  for (const feature of Object.values(features)) {
    feature.initialize(bot, manager);
  }

  // Enable all features in dependency order
  // Core features first (movement, inventory)
  features.movement.enable();
  features.inventory.enable();

  // Then dependent features
  features.combat.enable();
  features.building.enable();
  features.mining.enable();
  features.farming.enable();
  features.chatAI.enable();
  features.follow.enable();
  features.guard.enable();
  features.roam.enable();

  return features;
}

/**
 * FeatureFactory class for more control over feature creation
 */
export class FeatureFactory {
  private bot: Bot | null = null;
  private manager: BotManager | null = null;
  private features: Partial<FeatureInstances> = {};
  private enabledFeatures = new Set<string>();
  private configs: FeatureConfigMap = {};

  /**
   * Set the bot instance
   */
  setBot(bot: Bot): void {
    this.bot = bot;
  }

  /**
   * Set the manager instance
   */
  setManager(manager: BotManager): void {
    this.manager = manager;
  }

  /**
   * Get the bot instance
   */
  getBot(): Bot {
    if (!this.bot) {
      throw new Error('Bot not set. Call setBot() first.');
    }
    return this.bot;
  }

  /**
   * Get the manager instance
   */
  getManager(): BotManager {
    if (!this.manager) {
      throw new Error('Manager not set. Call setManager() first.');
    }
    return this.manager;
  }

  /**
   * Set configuration for a feature
   */
  setConfig(featureName: keyof FeatureConfigMap, config: any): void {
    this.configs[featureName] = config;
  }

  /**
   * Create a single feature instance
   */
  private createFeature<T extends BaseFeature>(FeatureClass: new () => T): T {
    const feature = new FeatureClass();
    if (this.bot && this.manager) {
      feature.initialize(this.bot, this.manager);
    }
    return feature;
  }

  /**
   * Get or create a feature instance
   */
  getFeature<T extends BaseFeature>(featureName: keyof FeatureInstances, FeatureClass: new () => T): T {
    if (!this.features[featureName]) {
      this.features[featureName] = this.createFeature(FeatureClass);
    }
    return this.features[featureName] as T;
  }

  /**
   * Get movement feature
   */
  getMovement(): MovementFeature {
    return this.getFeature('movement', MovementFeature);
  }

  /**
   * Get inventory feature
   */
  getInventory(): InventoryFeature {
    return this.getFeature('inventory', InventoryFeature);
  }

  /**
   * Get combat feature
   */
  getCombat(): CombatFeature {
    return this.getFeature('combat', CombatFeature);
  }

  /**
   * Get building feature
   */
  getBuilding(): BuildingFeature {
    return this.getFeature('building', BuildingFeature);
  }

  /**
   * Get mining feature
   */
  getMining(): MiningFeature {
    return this.getFeature('mining', MiningFeature);
  }

  /**
   * Get farming feature
   */
  getFarming(): FarmingFeature {
    return this.getFeature('farming', FarmingFeature);
  }

  /**
   * Get chatAI feature
   */
  getChatAI(): ChatAIFeature {
    return this.getFeature('chatAI', ChatAIFeature);
  }

  /**
   * Get follow feature
   */
  getFollow(): FollowFeature {
    return this.getFeature('follow', FollowFeature);
  }

  /**
   * Get guard feature
   */
  getGuard(): GuardFeature {
    return this.getFeature('guard', GuardFeature);
  }

  /**
   * Get roam feature
   */
  getRoam(): RoamFeature {
    return this.getFeature('roam', RoamFeature);
  }

  /**
   * Enable a feature
   */
  async enableFeature(featureName: keyof FeatureInstances): Promise<void> {
    const feature = this.features[featureName];
    if (!feature) {
      throw new Error(`Feature ${featureName} not created yet`);
    }

    if (this.enabledFeatures.has(featureName)) {
      console.warn(`[FeatureFactory] Feature ${featureName} already enabled`);
      return;
    }

    await feature.enable();
    this.enabledFeatures.add(featureName);
    console.log(`[FeatureFactory] Enabled ${featureName} feature`);
  }

  /**
   * Disable a feature
   */
  async disableFeature(featureName: keyof FeatureInstances): Promise<void> {
    const feature = this.features[featureName];
    if (!feature) {
      console.warn(`[FeatureFactory] Feature ${featureName} not created`);
      return;
    }

    if (!this.enabledFeatures.has(featureName)) {
      console.warn(`[FeatureFactory] Feature ${featureName} not enabled`);
      return;
    }

    await feature.disable();
    this.enabledFeatures.delete(featureName);
    console.log(`[FeatureFactory] Disabled ${featureName} feature`);
  }

  /**
   * Enable all features in dependency order
   */
  async enableAll(): Promise<void> {
    const enableOrder: (keyof FeatureInstances)[] = [
      'movement',
      'inventory',
      'combat',
      'building',
      'mining',
      'farming',
      'chatAI',
      'follow',
      'guard',
      'roam'
    ];

    for (const featureName of enableOrder) {
      if (this.features[featureName]) {
        await this.enableFeature(featureName);
      }
    }
  }

  /**
   * Disable all features in reverse order
   */
  async disableAll(): Promise<void> {
    const disableOrder: (keyof FeatureInstances)[] = [
      'roam',
      'guard',
      'follow',
      'chatAI',
      'farming',
      'mining',
      'building',
      'combat',
      'inventory',
      'movement'
    ];

    for (const featureName of disableOrder) {
      if (this.enabledFeatures.has(featureName)) {
        await this.disableFeature(featureName);
      }
    }
  }

  /**
   * Check if a feature is enabled
   */
  isEnabled(featureName: keyof FeatureInstances): boolean {
    return this.enabledFeatures.has(featureName);
  }

  /**
   * Get list of enabled features
   */
  getEnabledFeatures(): string[] {
    return [...this.enabledFeatures];
  }

  /**
   * Get all feature instances (for direct access)
   */
  getAllFeatures(): Partial<FeatureInstances> {
    return { ...this.features };
  }

  /**
   * Reset the factory (disable all features and clear instances)
   */
  async reset(): Promise<void> {
    await this.disableAll();
    this.features = {};
    this.enabledFeatures.clear();
    this.configs = {};
    console.log('[FeatureFactory] Factory reset');
  }
}

/**
 * Default feature factory instance
 */
let defaultFactory: FeatureFactory | null = null;

/**
 * Get or create the default feature factory
 */
export function getDefaultFactory(): FeatureFactory {
  if (!defaultFactory) {
    defaultFactory = new FeatureFactory();
  }
  return defaultFactory;
}

/**
 * Reset the default factory
 */
export function resetDefaultFactory(): void {
  if (defaultFactory) {
    defaultFactory.reset();
    defaultFactory = null;
  }
}

export default FeatureFactory;