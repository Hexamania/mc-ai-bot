/**
 * Guard Feature
 * Handles guarding a location - stays at a position using GoalNear
 */

import type { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import type { FeaturePluginConfig } from './BaseFeature.js';
import { BaseFeature } from './BaseFeature.js';

/**
 * Guard feature configuration
 */
export type GuardFeatureConfig = FeaturePluginConfig;

/**
 * Guard feature options
 */
export interface GuardFeatureOptions {
  /** Update interval in milliseconds (default: 2000) */
  updateInterval?: number;
  /** Default range for the guard position (default: 1) */
  defaultRange?: number;
}

/**
 * Guard Feature Class
 * Handles guarding a location by staying at a position
 */
export class GuardFeature extends BaseFeature {
  public readonly name = 'guard';
  public readonly version = '1.0.0';
  public readonly description = 'Guard location behavior';
  public readonly dependencies = ['core', 'movement'];

  private guardPosition: Vec3 | null = null;
  private isGuarding = false;
  private guardInterval: NodeJS.Timeout | null = null;
  private updateInterval = 2000;
  private defaultRange = 1;

  constructor() {
    super('guard', '1.0.0', 'Guard location behavior', ['core', 'movement']);
  }

  /**
   * Initialize the guard feature
   */
  protected async onEnable(): Promise<void> {
    const options = this.config.options as GuardFeatureOptions | undefined;

    if (options) {
      this.updateInterval = options.updateInterval ?? 2000;
      this.defaultRange = options.defaultRange ?? 1;
    }

    console.log('[GuardFeature] Guard feature enabled');
  }

  /**
   * Disable the guard feature
   */
  protected async onDisable(): Promise<void> {
    // Stop guarding if active
    await this.stopGuarding();

    // Clear interval
    if (this.guardInterval) {
      clearInterval(this.guardInterval);
      this.guardInterval = null;
    }

    console.log('[GuardFeature] Guard feature disabled');
  }

  /**
   * Start guarding at a position
   * @param position - Optional position to guard. If not provided, uses current position.
   */
  async startGuarding(position?: Vec3): Promise<void> {
    const movementFeature = this.getFeature('movement');

    if (!movementFeature) {
      throw new Error('Movement feature is required for guarding');
    }

    // Use provided position or current position
    const bot = this.getBot();
    this.guardPosition = position ?? bot.entity.position.clone();
    this.isGuarding = true;

    // Start the guard loop
    this.guardLoop();

    console.log(
      `[GuardFeature] Started guarding at ${Math.floor(this.guardPosition.x)}, ${Math.floor(this.guardPosition.y)}, ${Math.floor(this.guardPosition.z)}`
    );
  }

  /**
   * Stop guarding
   */
  async stopGuarding(): Promise<void> {
    const bot = this.getBot();

    this.isGuarding = false;
    this.guardPosition = null;

    // Clear the guard interval
    if (this.guardInterval) {
      clearInterval(this.guardInterval);
      this.guardInterval = null;
    }

    // Stop the pathfinder
    bot.pathfinder.stop();

    console.log('[GuardFeature] Stopped guarding');
  }

  /**
   * Check if currently guarding
   * @returns true if guarding, false otherwise
   */
  isGuardingNow(): boolean {
    return this.isGuarding;
  }

  /**
   * Get the current guard position
   * @returns Vec3 of guard position or null if not guarding
   */
  getGuardPosition(): Vec3 | null {
    return this.guardPosition ? this.guardPosition.clone() : null;
  }

  /**
   * Private guard loop - stays at position using GoalNear
   * Updates every 2 seconds (configurable)
   */
  private guardLoop(): void {
    if (!this.isGuarding || !this.guardPosition) {
      return;
    }

    const bot = this.getBot();

    try {
      // Set goal to stay at the guard position with range
      const goal = new goals.GoalNear(
        this.guardPosition.x,
        this.guardPosition.y,
        this.guardPosition.z,
        this.defaultRange
      );

      bot.pathfinder.setGoal(goal);
    } catch (error) {
      console.error('[GuardFeature] Guard loop error:', error);
    }

    // Schedule next update
    this.guardInterval = setTimeout(() => {
      this.guardLoop();
    }, this.updateInterval);
  }

  /**
   * Set the update interval for the guard loop
   * @param interval - Update interval in milliseconds
   */
  setUpdateInterval(interval: number): void {
    this.updateInterval = interval;
    this.setOption('updateInterval', interval);
  }

  /**
   * Set the default range for the guard position
   * @param range - Range in blocks
   */
  setDefaultRange(range: number): void {
    this.defaultRange = range;
    this.setOption('defaultRange', range);
  }

  /**
   * Get the current update interval
   * @returns Update interval in milliseconds
   */
  getUpdateInterval(): number {
    return this.updateInterval;
  }

  /**
   * Get the current default range
   * @returns Range in blocks
   */
  getDefaultRange(): number {
    return this.defaultRange;
  }
}

export default GuardFeature;
