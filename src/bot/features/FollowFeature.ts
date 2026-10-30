/**
 * Follow Feature
 * Handles following a player using mineflayer-pathfinder's GoalFollow
 */

import type { Player } from 'mineflayer';
import { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { goals } from 'mineflayer-pathfinder';
import type { FeaturePluginConfig } from './BaseFeature.js';
import { BaseFeature } from './BaseFeature.js';
import { FeatureRegistry } from '../../types/index.js';

/**
 * Follow feature configuration
 */
export type FollowFeatureConfig = FeaturePluginConfig;

/**
 * Follow feature options
 */
export interface FollowFeatureOptions {
  /** Default follow range in blocks */
  defaultRange?: number;
  /** Follow update interval in ms */
  updateInterval?: number;
  /** Auto-stop following if target goes out of range */
  stopOnOutOfRange?: boolean;
  /** Maximum distance to target before stopping */
  maxFollowDistance?: number;
}

/**
 * Follow status
 */
export interface FollowStatus {
  following: boolean;
  target: string | null;
  targetEntity: Entity | null;
  distance: number;
  range: number;
}

/**
 * Follow Feature Class
 * Ported from original bot.js followLoop()
 */
export class FollowFeature extends BaseFeature {
  public readonly name = 'follow';
  public readonly version = '1.0.0';
  public readonly description = 'Follow player behavior';
  public readonly dependencies = ['core', 'movement'];

  private followTarget: string | null = null;
  private isFollowing = false;
  private targetEntity: Entity | null = null;
  private followInterval: NodeJS.Timeout | null = null;
  private statusListeners: ((status: FollowStatus) => void)[] = [];

  constructor() {
    super('follow', '1.0.0', 'Follow player behavior', ['core', 'movement']);
  }

  /**
   * Initialize the follow feature
   */
  protected async onEnable(): Promise<void> {
    const bot = this.getBot();

    // Set up event listeners
    this.setupEventListeners();

    // Register commands placeholder
    this.registerCommands();

    console.log('[FollowFeature] Follow feature enabled');
  }

  /**
   * Disable the follow feature
   */
  protected async onDisable(): Promise<void> {
    // Stop following if active
    await this.stopFollowing();

    // Clear interval
    if (this.followInterval) {
      clearInterval(this.followInterval);
      this.followInterval = null;
    }

    // Remove event listeners
    this.removeAllListeners();

    console.log('[FollowFeature] Follow feature disabled');
  }

  /**
   * Set up event listeners
   */
  private setupEventListeners(): void {
    const bot = this.getBot();

    // Handle entity gone (target disconnected/died)
    bot.on('entityGone', (entity: Entity) => {
      if (this.targetEntity && entity.id === this.targetEntity.id) {
        console.log(`[FollowFeature] Target entity ${this.followTarget} gone, stopping follow`);
        this.stopFollowing();
      }
    });

    // Handle player left
    bot.on('playerLeft', (player: Player) => {
      if (this.followTarget && player.username === this.followTarget) {
        console.log(`[FollowFeature] Target player ${this.followTarget} left, stopping follow`);
        this.stopFollowing();
      }
    });

    // Death event - stop following
    bot.on('death', () => {
      this.stopFollowing();
    });

    // Physics tick to monitor distance
    bot.on('physicsTick', () => {
      if (this.isFollowing && this.targetEntity) {
        this.monitorDistance();
      }
    });
  }

  /**
   * Register follow-related commands (placeholder)
   */
  private registerCommands(): void {
    // Commands will be registered via the command system
    // This is a placeholder for command registration
    console.log('[FollowFeature] Command registration placeholder');
  }

  /**
   * Start following a player by username
   */
  async startFollowing(target: string, range = 2): Promise<boolean> {
    const bot = this.getBot();
    const movementFeature = this.getFeature('movement');

    if (!movementFeature) {
      console.error('[FollowFeature] Movement feature not available');
      return false;
    }

    // Find the target player
    const player = Object.values(bot.players).find(p => p.username === target);
    if (!player?.entity) {
      console.warn(`[FollowFeature] Player ${target} not found or not loaded`);
      return false;
    }

    // Stop any current following
    if (this.isFollowing) {
      await this.stopFollowing();
    }

    this.followTarget = target;
    this.targetEntity = player.entity;
    this.isFollowing = true;

    console.log(`[FollowFeature] Started following ${target} at range ${range}`);

    // Start the follow loop
    this.startFollowLoop(range);

    this.emitStatus();
    return true;
  }

  /**
   * Stop following the current target
   */
  async stopFollowing(): Promise<void> {
    const bot = this.getBot();

    if (this.followInterval) {
      clearInterval(this.followInterval);
      this.followInterval = null;
    }

    // Stop pathfinder
    if (bot.pathfinder) {
      bot.pathfinder.stop();
    }

    this.isFollowing = false;
    this.followTarget = null;
    this.targetEntity = null;

    console.log('[FollowFeature] Stopped following');
    this.emitStatus();
  }

  /**
   * Check if currently following
   */
  isFollowingNow(): boolean {
    return this.isFollowing;
  }

  /**
   * Get current follow target username
   */
  getFollowTarget(): string | null {
    return this.followTarget;
  }

  /**
   * Get current target entity
   */
  getTargetEntity(): Entity | null {
    return this.targetEntity;
  }

  /**
   * Get current follow range
   */
  getFollowRange(): number {
    return this.getOption('defaultRange', 2);
  }

  /**
   * Private follow loop - updates follow position every 2 seconds
   * Ported from original bot.js followLoop()
   */
  private startFollowLoop(range: number): void {
    const bot = this.getBot();
    const movementFeature = this.getFeature('movement');

    const interval = this.getOption('updateInterval', 2000);

    this.followInterval = setInterval(async () => {
      if (!this.isFollowing || !this.targetEntity) {
        return;
      }

      // Check if target entity still exists
      if (!bot.entities[this.targetEntity.id]) {
        console.log('[FollowFeature] Target entity no longer exists');
        await this.stopFollowing();
        return;
      }

      // Check max follow distance
      const maxDistance = this.getOption('maxFollowDistance', 50);
      const distance = bot.entity.position.distanceTo(this.targetEntity.position);

      if (distance > maxDistance) {
        console.log(`[FollowFeature] Target too far (${distance.toFixed(1)} blocks), stopping follow`);
        if (this.getOption('stopOnOutOfRange', true)) {
          await this.stopFollowing();
          return;
        }
      }

      try {
        // Use movement feature to follow entity
        if (movementFeature && typeof (movementFeature as any).followEntity === 'function') {
          await (movementFeature as any).followEntity(this.targetEntity, range);
        } else {
          // Fallback: use pathfinder directly with GoalFollow
          const goal = new goals.GoalFollow(this.targetEntity.id, range);
          await bot.pathfinder.goto(goal);
        }

        this.emitStatus();
      } catch (error) {
        console.error('[FollowFeature] Follow loop error:', error);
      }
    }, interval);

    // Also run immediately once
    this.followInterval.refresh();
  }

  /**
   * Monitor distance to target and emit status updates
   */
  private monitorDistance(): void {
    if (!this.targetEntity) return;

    const bot = this.getBot();
    const distance = bot.entity.position.distanceTo(this.targetEntity.position);
    const range = this.getOption('defaultRange', 2);

    this.emitStatus(distance, range);
  }

  /**
   * Emit follow status to listeners
   */
  private emitStatus(distance?: number, range?: number): void {
    const bot = this.getBot();
    const dist = distance ?? (this.targetEntity ? bot.entity.position.distanceTo(this.targetEntity.position) : 0);
    const rng = range ?? this.getOption('defaultRange', 2);

    const status: FollowStatus = {
      following: this.isFollowing,
      target: this.followTarget,
      targetEntity: this.targetEntity,
      distance: dist,
      range: rng
    };

    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (error) {
        console.error('[FollowFeature] Status listener error:', error);
      }
    }
  }

  /**
   * Subscribe to follow status updates
   */
  onStatusChange(listener: (status: FollowStatus) => void): () => void {
    this.statusListeners.push(listener);
    return () => {
      const index = this.statusListeners.indexOf(listener);
      if (index !== -1) {
        this.statusListeners.splice(index, 1);
      }
    };
  }

  /**
   * Get current follow status
   */
  getStatus(): FollowStatus {
    const bot = this.getBot();
    const distance = this.targetEntity ? bot.entity.position.distanceTo(this.targetEntity.position) : 0;

    return {
      following: this.isFollowing,
      target: this.followTarget,
      targetEntity: this.targetEntity,
      distance,
      range: this.getOption('defaultRange', 2)
    };
  }

  /**
   * Set default follow range
   */
  setDefaultRange(range: number): void {
    this.setOption('defaultRange', range);
  }

  /**
   * Set update interval
   */
  setUpdateInterval(interval: number): void {
    this.setOption('updateInterval', interval);
    // Restart loop if active
    if (this.isFollowing && this.followInterval) {
      const range = this.getOption('defaultRange', 2);
      clearInterval(this.followInterval);
      this.startFollowLoop(range);
    }
  }

  /**
   * Set stop on out of range behavior
   */
  setStopOnOutOfRange(enabled: boolean): void {
    this.setOption('stopOnOutOfRange', enabled);
  }

  /**
   * Set max follow distance
   */
  setMaxFollowDistance(distance: number): void {
    this.setOption('maxFollowDistance', distance);
  }
}

export default FollowFeature;