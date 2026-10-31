/**
 * Movement/Navigation Feature
 * Wraps mineflayer-pathfinder for pathfinding, movement, and navigation utilities
 */

import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import type { PartiallyComputedPath } from 'mineflayer-pathfinder';
import type { FeaturePluginConfig } from './BaseFeature.js';
import { BaseFeature } from './BaseFeature.js';

/**
 * Movement feature configuration
 */
export type MovementFeatureConfig = FeaturePluginConfig;

/**
 * Movement feature options
 */
export interface MovementFeatureOptions {
  /** Enable auto-jump when walking (deprecated, handled automatically) */
  autoJump?: boolean;
  /** Enable sprinting when possible */
  sprint?: boolean;
  /** Enable parkour (climb up blocks) */
  parkour?: boolean;
  /** Timeout for pathfinding in ms */
  pathfindingTimeout?: number;
  /** Movement speed multiplier */
  speedMultiplier?: number;
}

/**
 * Goal types for movement
 */
export type MovementGoal =
  | { type: 'block'; x: number; y: number; z: number; range?: number }
  | { type: 'entity'; entityId: number; range?: number }
  | { type: 'position'; x: number; y: number; z: number; range?: number }
  | { type: 'follow'; entity: Entity; range: number }
  | { type: 'wander'; radius: number; center?: Vec3 }
  | { type: 'stop' };

/**
 * Movement status
 */
export interface MovementStatus {
  moving: boolean;
  goal: MovementGoal | null;
  path: Vec3[] | null;
  progress: number;
  speed: number;
}

/**
 * Movement Feature Class
 */
export class MovementFeature extends BaseFeature {
  public readonly name = 'movement';
  public readonly version = '1.0.0';
  public readonly description = 'Pathfinding, movement, and navigation utilities';
  public readonly dependencies = ['core'];

  private movements: Movements | null = null;
  private currentGoal: MovementGoal | null = null;
  private path: Vec3[] | null = null;
  private pathIndex = 0;
  private isMoving = false;
  private moveTimeout: NodeJS.Timeout | null = null;
  private statusListeners: ((status: MovementStatus) => void)[] = [];

  constructor() {
    super('movement', '1.0.0', 'Pathfinding, movement, and navigation utilities', ['core']);
  }

  /**
   * Initialize the movement feature
   */
  protected async onEnable(): Promise<void> {
    const bot = this.getBot();

    // Load pathfinder plugin if not already loaded
    if (!bot.pathfinder) {
      bot.loadPlugin(pathfinder);
    }

    // Create movements instance
    this.movements = new Movements(bot);

    // Configure movements from options
    this.configureMovements();

    // Set up event listeners
    this.setupEventListeners();

    // Register movement commands
    this.registerCommands();

    console.log('[MovementFeature] Movement feature enabled');
  }

  /**
   * Disable the movement feature
   */
  protected async onDisable(): Promise<void> {
    // Stop any current movement
    await this.stop();

    // Clear timeout
    if (this.moveTimeout) {
      clearTimeout(this.moveTimeout);
      this.moveTimeout = null;
    }

    // Remove event listeners
    this.removeAllListeners();

    // Clear movements
    this.movements = null;

    console.log('[MovementFeature] Movement feature disabled');
  }

  /**
   * Configure movements based on options
   */
  private configureMovements(): void {
    if (!this.movements) return;

    const options = this.config.options as MovementFeatureOptions | undefined;
    if (!options) return;

    this.movements.allowSprinting = options.sprint ?? true;
    this.movements.canDig = false; // Don't dig by default
    // Removed deprecated properties: allowSwimming, avoidWater, avoidLava, avoidDangerous, maxFallDistance, allowJump
    // These are no longer available in newer mineflayer-pathfinder versions
  }

  /**
   * Set up event listeners for pathfinding
   */
  private setupEventListeners(): void {
    const bot = this.getBot();

    // Path update event - the callback receives PartiallyComputedPath
    bot.on('path_update', (results: PartiallyComputedPath) => {
      // PartiallyComputedPath has a path property that's Move[], need to convert to Vec3[]
      this.path = results.path.map((move) => new Vec3(move.x, move.y, move.z));
      this.pathIndex = 0;
      this.emitStatus();
    });

    // Goal reached event
    bot.on('goal_reached', () => {
      this.isMoving = false;
      this.currentGoal = null;
      this.path = null;
      this.pathIndex = 0;
      this.emitStatus();
    });

    // Physics tick for progress tracking
    bot.on('physicsTick', () => {
      if (this.isMoving && this.path && this.path.length > 0) {
        this.updateProgress();
      }
    });

    // Death event - stop movement
    bot.on('death', () => {
      void this.stop();
    });
  }

  /**
   * Register movement-related commands
   */
  private registerCommands(): void {
    // Commands will be registered via the command system
    // This is a placeholder for command registration
  }

  /**
   * Move to a block position
   */
  async moveToBlock(x: number, y: number, z: number, range = 1): Promise<boolean> {
    return this.setGoal({ type: 'block', x, y, z, range });
  }

  /**
   * Move to an entity
   */
  async moveToEntity(entity: Entity, range = 2): Promise<boolean> {
    return this.setGoal({ type: 'entity', entityId: entity.id, range });
  }

  /**
   * Move to a position
   */
  async moveToPosition(x: number, y: number, z: number, range = 1): Promise<boolean> {
    return this.setGoal({ type: 'position', x, y, z, range });
  }

  /**
   * Follow an entity
   */
  async followEntity(entity: Entity, range = 2): Promise<boolean> {
    return this.setGoal({ type: 'follow', entity, range });
  }

  /**
   * Wander around a center point
   */
  async wander(radius: number, center?: Vec3): Promise<boolean> {
    return this.setGoal({ type: 'wander', radius, center });
  }

  /**
   * Stop current movement
   */
  async stop(): Promise<void> {
    const bot = this.getBot();

    if (this.moveTimeout) {
      clearTimeout(this.moveTimeout);
      this.moveTimeout = null;
    }

    bot.pathfinder.stop();
    this.isMoving = false;
    this.currentGoal = null;
    this.path = null;
    this.pathIndex = 0;
    this.emitStatus();
  }

  /**
   * Set a movement goal
   */
  private async setGoal(goal: MovementGoal): Promise<boolean> {
    const bot = this.getBot();

    if (!this.movements) {
      throw new Error('Movements not initialized');
    }

    // Stop current movement
    await this.stop();

    try {
      this.currentGoal = goal;
      this.isMoving = true;

      let pathfinderGoal: goals.Goal;
      let center: Vec3;

      switch (goal.type) {
        case 'block':
          // GoalBlock takes 3 args: x, y, z (range is not a parameter)
          pathfinderGoal = new goals.GoalBlock(goal.x, goal.y, goal.z);
          break;
        case 'entity': {
          // GoalFollow takes an Entity, not an entity ID
          // We need to find the entity by ID
          const entity = bot.entities[goal.entityId];
          if (entity) {
            pathfinderGoal = new goals.GoalFollow(entity, goal.range ?? 2);
          } else {
            throw new Error(`Entity with ID ${goal.entityId} not found`);
          }
          break;
        }
        case 'position': {
          // GoalNear takes 4 args: x, y, z, range
          pathfinderGoal = new goals.GoalNear(goal.x, goal.y, goal.z, goal.range ?? 1);
          break;
        }
        case 'follow': {
          // GoalFollow takes an Entity
          pathfinderGoal = new goals.GoalFollow(goal.entity, goal.range);
          break;
        }
        case 'wander': {
          center = goal.center ?? bot.entity.position;
          // GoalRandom was removed, implement custom wander goal using GoalNear with random offset
          const randomOffset = new Vec3(
            (Math.random() - 0.5) * 2 * goal.radius,
            0,
            (Math.random() - 0.5) * 2 * goal.radius
          );
          const wanderTarget = center.offset(randomOffset.x, randomOffset.y, randomOffset.z);
          pathfinderGoal = new goals.GoalNear(wanderTarget.x, wanderTarget.y, wanderTarget.z, 1);
          break;
        }
        case 'stop':
          await this.stop();
          return true;
        default: {
          const _exhaustive: never = goal;
          throw new Error(`Unknown goal type: ${_exhaustive}`);
        }
      }

      // Set timeout
      const timeout = this.getOption('pathfindingTimeout', 30000);
      this.moveTimeout = setTimeout(() => {
        if (this.isMoving) {
          console.warn('[MovementFeature] Pathfinding timeout');
          void this.stop();
        }
      }, timeout);

      // Start pathfinding
      await bot.pathfinder.goto(pathfinderGoal);
      return true; // goto() returns void, so we assume success if no error thrown
    } catch (error) {
      this.isMoving = false;
      this.currentGoal = null;
      console.error('[MovementFeature] Movement error:', error);
      return false;
    }
  }

  /**
   * Update movement progress
   */
  private updateProgress(): void {
    if (!this.path || this.path.length === 0) return;

    const bot = this.getBot();
    const currentPos = bot.entity.position;

    // Find closest path point
    let closestIndex = this.pathIndex;
    let closestDist = Infinity;

    for (let i = this.pathIndex; i < this.path.length; i++) {
      const dist = currentPos.distanceTo(this.path[i]);
      if (dist < closestDist) {
        closestDist = dist;
        closestIndex = i;
      }
    }

    this.pathIndex = closestIndex;
    const progress = this.path.length > 0 ? this.pathIndex / (this.path.length - 1) : 1;
    this.emitStatus(progress);
  }

  /**
   * Emit movement status to listeners
   */
  private emitStatus(progress?: number): void {
    const bot = this.getBot();
    const status: MovementStatus = {
      moving: this.isMoving,
      goal: this.currentGoal,
      path: this.path,
      progress:
        progress ??
        (this.path && this.path.length > 0 ? this.pathIndex / (this.path.length - 1) : 0),
      speed: bot.entity.velocity.distanceTo(new Vec3(0, 0, 0)),
    };

    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (error) {
        console.error('[MovementFeature] Status listener error:', error);
      }
    }
  }

  /**
   * Subscribe to movement status updates
   */
  onStatusChange(listener: (status: MovementStatus) => void): () => void {
    this.statusListeners.push(listener);
    return () => {
      const index = this.statusListeners.indexOf(listener);
      if (index !== -1) {
        this.statusListeners.splice(index, 1);
      }
    };
  }

  /**
   * Get current movement status
   */
  getStatus(): MovementStatus {
    return {
      moving: this.isMoving,
      goal: this.currentGoal,
      path: this.path,
      progress: this.path && this.path.length > 0 ? this.pathIndex / (this.path.length - 1) : 0,
      speed: this.getBot().entity.velocity.distanceTo(new Vec3(0, 0, 0)),
    };
  }

  /**
   * Check if currently moving
   */
  isMovingNow(): boolean {
    return this.isMoving;
  }

  /**
   * Get current goal
   */
  getCurrentGoal(): MovementGoal | null {
    return this.currentGoal;
  }

  /**
   * Get current path
   */
  getPath(): Vec3[] | null {
    return this.path;
  }

  /**
   * Move to a specific location by name (from memory)
   */
  async moveToNamedLocation(_name: string): Promise<boolean> {
    const memoryFeature = this.getFeature('memory');
    if (!memoryFeature) {
      console.warn('[MovementFeature] Memory feature not available');
      return false;
    }

    // This would integrate with the memory feature to get named locations
    // For now, return false
    return false;
  }

  /**
   * Look at a position while moving
   */
  lookAt(x: number, y: number, z: number): void {
    const bot = this.getBot();
    void bot.lookAt(new Vec3(x, y, z), true);
  }

  /**
   * Look at an entity while moving
   */
  lookAtEntity(entity: Entity): void {
    const bot = this.getBot();
    void bot.lookAt(entity.position.offset(0, 1.6, 0), true);
  }

  /**
   * Set auto-jump
   */
  setAutoJump(_enabled: boolean): void {
    // allowJump property was removed in newer mineflayer-pathfinder versions
    // Auto-jump is now handled automatically
    this.setOption('autoJump', _enabled);
  }

  /**
   * Set sprint enabled
   */
  setSprint(enabled: boolean): void {
    if (this.movements) {
      this.movements.allowSprinting = enabled;
      this.setOption('sprint', enabled);
    }
  }

  /**
   * Set speed multiplier
   */
  setSpeedMultiplier(multiplier: number): void {
    this.setOption('speedMultiplier', multiplier);
  }

  /**
   * Get distance to a position
   */
  distanceTo(x: number, y: number, z: number): number {
    const bot = this.getBot();
    return bot.entity.position.distanceTo(new Vec3(x, y, z));
  }

  /**
   * Get distance to an entity
   */
  distanceToEntity(entity: Entity): number {
    const bot = this.getBot();
    return bot.entity.position.distanceTo(entity.position);
  }

  /**
   * Check if position is reachable
   */
  async isReachable(x: number, y: number, z: number, _range = 1): Promise<boolean> {
    const bot = this.getBot();

    if (!this.movements) return false;

    const goal = new goals.GoalBlock(x, y, z);
    await bot.pathfinder.goto(goal);
    return true; // goto() returns void, so we assume success if no error thrown
  }

  /**
   * Get movements instance for advanced usage
   */
  getMovements(): Movements | null {
    return this.movements;
  }
}

export default MovementFeature;
