/**
 * Roam Feature
 * Handles random wandering/roaming behavior
 */

import { goals, Movements } from 'mineflayer-pathfinder';
import type { FeaturePluginConfig } from './BaseFeature.js';
import { BaseFeature } from './BaseFeature.js';

/**
 * Roam feature configuration
 */
export type RoamFeatureConfig = FeaturePluginConfig;

/**
 * Roam feature options
 */
export interface RoamFeatureOptions {
  /** Roam radius in blocks (default: 3) */
  roamRadius?: number;
  /** Update interval in milliseconds (default: 7000) */
  updateInterval?: number;
  /** Whether to roam on the Y-axis (default: false) */
  roamYAxis?: boolean;
  /** Maximum Y difference for roaming (default: 2) */
  maxYDifference?: number;
}

/**
 * Minecraft data type
 */
interface MinecraftData {
  version: string;
  [key: string]: unknown;
}

/**
 * Command context type
 */
interface CommandContext {
  args: string[];
  reply: (message: string) => void;
}

/**
 * Roam Feature Class
 * Ported from original bot.js roam() function
 */
export class RoamFeature extends BaseFeature {
  public readonly name = 'roam';
  public readonly version = '1.0.0';
  public readonly description = 'Random wandering/roaming behavior';
  public readonly dependencies = ['core', 'movement'];

  private isRoaming = false;
  private roamTimeout: NodeJS.Timeout | null = null;
  private roamRadius = 3;
  private updateInterval = 7000;
  private roamYAxis = false;
  private maxYDifference = 2;
  private movements: Movements | null = null;
  private mcData: MinecraftData | null = null;

  constructor() {
    super('roam', '1.0.0', 'Random wandering/roaming behavior', ['core', 'movement']);
  }

  /**
   * Initialize the roam feature
   */
  protected async onEnable(): Promise<void> {
    const bot = this.getBot();

    // Initialize minecraft-data and movements
    this.mcData = this.getMinecraftData();
    this.movements = new Movements(bot, this.mcData);
    this.movements.canDig = true;
    this.movements.allowParkour = true;
    this.movements.allowSprinting = true;
    bot.pathfinder.setMovements(this.movements);

    // Configure from options
    this.configureFromOptions();

    // Register commands
    this.registerCommands();

    console.log('[RoamFeature] Roam feature enabled');
  }

  /**
   * Disable the roam feature
   */
  protected async onDisable(): Promise<void> {
    // Stop roaming if active
    await this.stopRoaming();

    // Clear timeout
    if (this.roamTimeout) {
      clearTimeout(this.roamTimeout);
      this.roamTimeout = null;
    }

    // Stop pathfinder
    const bot = this.getBot();
    bot.pathfinder.stop();

    this.removeAllListeners();

    console.log('[RoamFeature] Roam feature disabled');
  }

  /**
   * Configure from options
   */
  private configureFromOptions(): void {
    const options = this.config.options as RoamFeatureOptions | undefined;
    if (!options) return;

    this.roamRadius = options.roamRadius ?? this.roamRadius;
    this.updateInterval = options.updateInterval ?? this.updateInterval;
    this.roamYAxis = options.roamYAxis ?? this.roamYAxis;
    this.maxYDifference = options.maxYDifference ?? this.maxYDifference;
  }

  /**
   * Get minecraft data
   */
  private getMinecraftData(): MinecraftData {
    const bot = this.getBot();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcDataLoader = require('minecraft-data');
    return mcDataLoader(bot.version) || mcDataLoader(process.env.MC_VERSION || '1.21.1');
  }

  /**
   * Register roam-related commands
   */
  private registerCommands(): void {
    const manager = this.getManager();

    // Roam command - start roaming
    manager.registerCommand?.({
      name: 'roam',
      description: 'Start random wandering/roaming',
      usage: 'roam [radius] [interval]',
      adminOnly: true,
      execute: async (context: CommandContext) => {
        const { args, reply } = context;

        let radius = this.roamRadius;
        let interval = this.updateInterval;

        if (args.length >= 1) {
          radius = parseInt(args[0], 10);
          if (isNaN(radius) || radius < 1) {
            reply('❌ Invalid radius. Must be a positive number.');
            return;
          }
        }

        if (args.length >= 2) {
          interval = parseInt(args[1], 10);
          if (isNaN(interval) || interval < 1000) {
            reply('❌ Invalid interval. Must be at least 1000ms.');
            return;
          }
        }

        await this.startRoaming(radius, interval);
        reply(`🚶 Started roaming (radius: ${radius}, interval: ${interval}ms)`);
      },
    });

    // Stop roam command
    manager.registerCommand?.({
      name: 'stoproam',
      description: 'Stop roaming',
      usage: 'stoproam',
      adminOnly: true,
      execute: async (context: CommandContext) => {
        const { reply } = context;
        await this.stopRoaming();
        reply('🛑 Stopped roaming');
      },
    });

    // Roam status command
    manager.registerCommand?.({
      name: 'roamstatus',
      description: 'Get current roam status',
      usage: 'roamstatus',
      adminOnly: true,
      execute: async (context: CommandContext) => {
        const { reply } = context;
        const status = this.isRoamingNow() ? 'Roaming' : 'Not roaming';
        const radius = this.getRoamRadius();
        const interval = this.getUpdateInterval();

        reply(`🚶 ${status} (radius: ${radius}, interval: ${interval}ms)`);
      },
    });
  }

  /**
   * Start roaming
   * @param radius - Optional roam radius override
   * @param interval - Optional update interval override
   */
  async startRoaming(radius?: number, interval?: number): Promise<void> {
    if (this.isRoaming) {
      console.warn('[RoamFeature] Already roaming');
      return;
    }

    const effectiveRadius = radius ?? this.roamRadius;
    const effectiveInterval = interval ?? this.updateInterval;

    this.isRoaming = true;

    // Set the objective for tracking
    this.emit('taskUpdate', { goal: 'roaming', status: 'active', radius: effectiveRadius });

    // Start the roam loop
    this.roamLoop(effectiveRadius, effectiveInterval);

    console.log(
      `[RoamFeature] Started roaming with radius ${effectiveRadius}, interval ${effectiveInterval}ms`
    );
  }

  /**
   * Stop roaming
   */
  async stopRoaming(): Promise<void> {
    const bot = this.getBot();

    this.isRoaming = false;

    // Clear the roam timeout
    if (this.roamTimeout) {
      clearTimeout(this.roamTimeout);
      this.roamTimeout = null;
    }

    // Stop the pathfinder
    bot.pathfinder.stop();

    this.emit('taskUpdate', { goal: 'roaming', status: 'stopped' });

    console.log('[RoamFeature] Stopped roaming');
  }

  /**
   * Check if currently roaming
   * @returns true if roaming, false otherwise
   */
  isRoamingNow(): boolean {
    return this.isRoaming;
  }

  /**
   * Get current roam radius
   * @returns Roam radius in blocks
   */
  getRoamRadius(): number {
    return this.roamRadius;
  }

  /**
   * Get current update interval
   * @returns Update interval in milliseconds
   */
  getUpdateInterval(): number {
    return this.updateInterval;
  }

  /**
   * Set roam radius
   * @param radius - Roam radius in blocks
   */
  setRoamRadius(radius: number): void {
    this.roamRadius = Math.max(1, radius);
    this.setOption('roamRadius', this.roamRadius);
  }

  /**
   * Set update interval
   * @param interval - Update interval in milliseconds
   */
  setUpdateInterval(interval: number): void {
    this.updateInterval = Math.max(1000, interval);
    this.setOption('updateInterval', this.updateInterval);
  }

  /**
   * Set whether to roam on Y-axis
   * @param enabled - Whether to enable Y-axis roaming
   */
  setRoamYAxis(enabled: boolean): void {
    this.roamYAxis = enabled;
    this.setOption('roamYAxis', enabled);
  }

  /**
   * Set max Y difference for roaming
   * @param difference - Maximum Y difference in blocks
   */
  setMaxYDifference(difference: number): void {
    this.maxYDifference = Math.max(0, difference);
    this.setOption('maxYDifference', this.maxYDifference);
  }

  /**
   * Private roam loop - sets random goal within radius
   * Ported from original bot.js roam() function
   */
  private roamLoop(radius: number, interval: number): void {
    if (!this.isRoaming) {
      return;
    }

    const bot = this.getBot();

    try {
      // Set movements
      if (this.movements) {
        bot.pathfinder.setMovements(this.movements);
      }

      const p = bot.entity.position;

      // Calculate random target within radius
      const targetX = Math.floor(p.x + (Math.random() - 0.5) * 2 * radius);
      const targetZ = Math.floor(p.z + (Math.random() - 0.5) * 2 * radius);
      let targetY = Math.floor(p.y);

      if (this.roamYAxis) {
        targetY = Math.floor(p.y + (Math.random() - 0.5) * 2 * this.maxYDifference);
      }

      // Set goal to random position
      const goal = new goals.GoalBlock(targetX, targetY, targetZ);
      bot.pathfinder.setGoal(goal);

      console.log(`[RoamFeature] Roaming to ${targetX}, ${targetY}, ${targetZ}`);
    } catch (error) {
      console.error('[RoamFeature] Roam loop error:', error);
    }

    // Schedule next roam
    this.roamTimeout = setTimeout(() => {
      this.roamLoop(radius, interval);
    }, interval);
  }
}

export default RoamFeature;
