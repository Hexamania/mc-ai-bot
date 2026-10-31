/**
 * Farming/Agriculture Feature
 * Handles auto-farming wheat and other crops
 */

import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import type { FeaturePluginConfig } from './BaseFeature.js';
import { BaseFeature } from './BaseFeature.js';

/**
 * Farming feature configuration
 */
export type FarmingFeatureConfig = FeaturePluginConfig;

/**
 * Farming feature options
 */
export interface FarmingFeatureOptions {
  /** Auto-farm when food is low */
  autoFarmWhenHungry?: boolean;
  /** Food threshold to trigger auto-farming */
  foodThreshold?: number;
  /** Crops to farm */
  crops?: string[];
  /** Maximum distance to search for crops */
  maxSearchDistance?: number;
  /** Replant after harvesting */
  autoReplant?: boolean;
}

/**
 * Farming task info
 */
export interface FarmingTask {
  active: boolean;
  cropType: string;
  targetBlock: Block | null;
}

/**
 * Farming Feature Class
 */
export class FarmingFeature extends BaseFeature {
  public readonly name = 'farming';
  public readonly version = '1.0.0';
  public readonly description = 'Auto-farming wheat and other crops';
  public readonly dependencies = ['core', 'movement', 'inventory'];

  private isFarming = false;
  private cropsToFarm = ['wheat'];
  private foodThreshold = 15;
  private autoReplant = true;

  constructor() {
    super('farming', '1.0.0', 'Auto-farming wheat and other crops', [
      'core',
      'movement',
      'inventory',
    ]);
  }

  /**
   * Initialize the farming feature
   */
  protected async onEnable(): Promise<void> {
    // Configure from options
    this.configureFromOptions();

    // Set up event listeners
    this.setupEventListeners();

    // Register commands
    this.registerCommands();

    console.log('[FarmingFeature] Farming feature enabled');
  }

  /**
   * Disable the farming feature
   */
  protected async onDisable(): Promise<void> {
    this.isFarming = false;
    this.removeAllListeners();
    console.log('[FarmingFeature] Farming feature disabled');
  }

  /**
   * Configure from options
   */
  private configureFromOptions(): void {
    const options = this.config.options as FarmingFeatureOptions | undefined;
    if (!options) return;

    this.cropsToFarm = options.crops ?? this.cropsToFarm;
    this.foodThreshold = options.foodThreshold ?? this.foodThreshold;
    this.autoReplant = options.autoReplant ?? this.autoReplant;
  }

  /**
   * Set up event listeners
   */
  private setupEventListeners(): void {
    const bot = this.getBot();

    // Monitor food levels for auto-farming
    if (this.getOption('autoFarmWhenHungry', true)) {
      bot.on('health', () => {
        if (bot.food < this.foodThreshold) {
          void this.autoFarmWheat();
        }
      });
    }
  }

  /**
   * Register farming commands
   */
  private registerCommands(): void {
    // Commands will be registered via the command system
  }

  // ========================================================================
  // Auto Farm Wheat
  // ========================================================================

  /**
   * Auto-farm fully grown wheat
   */
  async autoFarmWheat(): Promise<void> {
    if (this.isFarming) return;

    const bot = this.getBot();

    // Find fully grown wheat (metadata 7)
    const wheatBlock = bot.findBlock({
      matching: (block) => {
        return block.name === 'wheat' && block.metadata === 7;
      },
      maxDistance: this.getOption('maxSearchDistance', 32),
    });

    if (wheatBlock) {
      this.isFarming = true;
      console.log('[FarmingFeature] Food low: Harvesting grown wheat...');

      try {
        const movementFeature = this.getFeature('movement');
        if (movementFeature) {
          await movementFeature.moveToBlock(
            wheatBlock.position.x,
            wheatBlock.position.y,
            wheatBlock.position.z,
            4
          );
        } else {
          await bot.pathfinder.goto(new goals.GoalLookAtBlock(wheatBlock.position, bot.world));
        }

        await bot.dig(wheatBlock);

        // Replant logic
        if (this.autoReplant) {
          const seeds = bot.inventory.items().find((i) => i.name === 'wheat_seeds');
          if (seeds) {
            const farmland = bot.blockAt(wheatBlock.position.offset(0, -1, 0));
            if (farmland && farmland.name === 'farmland') {
              await bot.equip(seeds, 'hand');
              await bot.placeBlock(farmland, new Vec3(0, 1, 0));
            }
          }
        }
      } catch (error) {
        console.error('[FarmingFeature] Farm error:', error);
      }

      this.isFarming = false;

      // Continue farming if food is still low
      if (bot.food < this.foodThreshold) {
        setTimeout(() => this.autoFarmWheat(), 1000);
      }
    } else {
      console.log('[FarmingFeature] No fully grown wheat found to harvest.');
    }
  }

  /**
   * Start farming a specific crop
   */
  async startFarming(cropType = 'wheat'): Promise<void> {
    if (this.isFarming) {
      console.warn('[FarmingFeature] Already farming');
      return;
    }

    if (!this.cropsToFarm.includes(cropType)) {
      throw new Error(`Crop type ${cropType} not supported`);
    }

    this.isFarming = true;

    // This would be expanded for different crop types
    if (cropType === 'wheat') {
      await this.autoFarmWheat();
    }
  }

  /**
   * Stop farming
   */
  stopFarming(): void {
    this.isFarming = false;
  }

  /**
   * Check if currently farming
   */
  isFarmingNow(): boolean {
    return this.isFarming;
  }

  /**
   * Set food threshold
   */
  setFoodThreshold(threshold: number): void {
    this.foodThreshold = threshold;
    this.setOption('foodThreshold', threshold);
  }

  /**
   * Get food threshold
   */
  getFoodThreshold(): number {
    return this.foodThreshold;
  }

  /**
   * Set auto-replant
   */
  setAutoReplant(enabled: boolean): void {
    this.autoReplant = enabled;
    this.setOption('autoReplant', enabled);
  }

  /**
   * Add crop type to farm
   */
  addCropType(cropType: string): void {
    if (!this.cropsToFarm.includes(cropType)) {
      this.cropsToFarm.push(cropType);
      this.setOption('crops', this.cropsToFarm);
    }
  }

  /**
   * Remove crop type
   */
  removeCropType(cropType: string): void {
    const index = this.cropsToFarm.indexOf(cropType);
    if (index !== -1) {
      this.cropsToFarm.splice(index, 1);
      this.setOption('crops', this.cropsToFarm);
    }
  }

  /**
   * Get supported crop types
   */
  getSupportedCrops(): string[] {
    return [...this.cropsToFarm];
  }
}

export default FarmingFeature;
