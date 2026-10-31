/**
 * Combat/PVP Feature
 * Handles combat mechanics, PvP, auto-defense, kill aura, and targeting
 */

import type { Entity } from 'prismarine-entity';
import type { Block } from 'prismarine-block';
import type { FeaturePluginConfig } from './BaseFeature.js';
import { BaseFeature } from './BaseFeature.js';
import type { IndexedData } from 'minecraft-data';

/**
 * Combat feature configuration
 */
export type CombatFeatureConfig = FeaturePluginConfig;

/**
 * Combat feature options
 */
export interface CombatFeatureOptions {
  /** Enable kill aura (auto-attack nearby enemies) */
  killAura?: boolean;
  /** Enable auto-defense (attack when attacked) */
  autoDefense?: boolean;
  /** Attack range in blocks */
  attackRange?: number;
  /** Target players */
  targetPlayers?: boolean;
  /** Target hostile mobs */
  targetMobs?: boolean;
  /** Target passive mobs */
  targetPassive?: boolean;
  /** Target animals */
  targetAnimals?: boolean;
  /** Ignore players in same team */
  ignoreTeammates?: boolean;
  /** Priority targets (player names) */
  priorityTargets?: string[];
  /** Blacklisted targets (player names) */
  blacklist?: string[];
  /** Auto-equip best weapon */
  autoEquipWeapon?: boolean;
  /** Auto-eat when low health */
  autoEat?: boolean;
  /** Health threshold for auto-eat */
  eatThreshold?: number;
  /** Auto-use shield when blocking */
  autoShield?: boolean;
  /** Critical hit assist */
  criticalAssist?: boolean;
  /** Sprint reset for knockback */
  sprintReset?: boolean;
  /** Attack cooldown in ms */
  attackCooldown?: number;
}

/**
 * Combat target info
 */
export interface CombatTarget {
  entity: Entity;
  distance: number;
  health: number;
  isPlayer: boolean;
  priority: number;
}

/**
 * Combat statistics
 */
export interface CombatStats {
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
  longestKillStreak: number;
  currentKillStreak: number;
}

/**
 * Combat Feature Class
 */
export class CombatFeature extends BaseFeature {
  public readonly name = 'combat';
  public readonly version = '1.0.0';
  public readonly description = 'Combat mechanics, PvP, auto-defense, and kill aura';
  public readonly dependencies = ['core', 'movement', 'inventory'];

  private killAuraEnabled = false;
  private autoDefenseEnabled = false;
  private currentTarget: Entity | null = null;
  private lastAttackTime = 0;
  private stats: CombatStats = {
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
    longestKillStreak: 0,
    currentKillStreak: 0,
  };
  private targetChangeListeners: ((target: Entity | null) => void)[] = [];
  private attackCooldown = 500;

  constructor() {
    super('combat', '1.0.0', 'Combat mechanics, PvP, auto-defense, and kill aura', [
      'core',
      'movement',
      'inventory',
    ]);
  }

  /**
   * Initialize the combat feature
   */
  protected async onEnable(): Promise<void> {
    // Configure from options
    this.configureFromOptions();

    // Set up event listeners
    this.setupEventListeners();

    // Register commands
    this.registerCommands();

    console.log('[CombatFeature] Combat feature enabled');
  }

  /**
   * Disable the combat feature
   */
  protected async onDisable(): Promise<void> {
    this.killAuraEnabled = false;
    this.autoDefenseEnabled = false;
    this.currentTarget = null;
    this.removeAllListeners();
    console.log('[CombatFeature] Combat feature disabled');
  }

  /**
   * Configure from options
   */
  private configureFromOptions(): void {
    const options = this.config.options as CombatFeatureOptions | undefined;
    if (!options) return;

    this.killAuraEnabled = options.killAura ?? false;
    this.autoDefenseEnabled = options.autoDefense ?? false;
    this.attackCooldown = options.attackCooldown ?? 500;
  }

  /**
   * Set up event listeners
   */
  private setupEventListeners(): void {
    const bot = this.getBot();

    // Physics tick for kill aura
    bot.on('physicsTick', () => {
      if (this.killAuraEnabled && this.isEnabled()) {
        void this.killAuraTick();
      }
    });

    // Entity hurt event (for auto-defense)
    bot.on('entityHurt', (entity: Entity, source: Entity | null) => {
      if (entity.id === bot.entity.id && this.autoDefenseEnabled && source) {
        void this.onDamaged(source);
      }
    });

    // Entity death event
    bot.on('entityGone', (entity: Entity) => {
      if (entity.id === this.currentTarget?.id) {
        this.onTargetDeath(entity);
      }
    });

    // Death event
    bot.on('death', () => {
      this.onDeath();
    });

    // Health changes for auto-eat
    bot.on('health', () => {
      void this.checkAutoEat();
    });
  }

  /**
   * Register combat commands
   */
  private registerCommands(): void {
    // Commands will be registered via the command system
  }

  // ========================================================================
  // Kill Aura
  // ========================================================================

  /**
   * Enable/disable kill aura
   */
  setKillAura(enabled: boolean): void {
    this.killAuraEnabled = enabled;
    this.setOption('killAura', enabled);
    console.log(`[CombatFeature] Kill aura ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Kill aura tick - find and attack targets
   */
  private async killAuraTick(): Promise<void> {
    const now = Date.now();

    // Check attack cooldown
    if (now - this.lastAttackTime < this.attackCooldown) return;

    // Find best target
    const target = this.findBestTarget();
    if (target) {
      await this.attackEntity(target.entity);
    } else if (this.currentTarget) {
      this.clearTarget();
    }
  }

  /**
   * Find best target based on priority and distance
   */
  private findBestTarget(): CombatTarget | null {
    const bot = this.getBot();
    const options = this.config.options as CombatFeatureOptions | undefined;
    const range = options?.attackRange ?? 4.5;

    let bestTarget: CombatTarget | null = null;
    let bestScore = -1;

    for (const entity of Object.values(bot.entities)) {
      if (entity.id === bot.entity.id) continue;
      if (!this.isValidTarget(entity)) continue;

      const distance = bot.entity.position.distanceTo(entity.position);
      if (distance > range) continue;

      const targetInfo = this.getTargetInfo(entity, distance);
      const score = this.calculateTargetScore(targetInfo);

      if (score > bestScore) {
        bestScore = score;
        bestTarget = targetInfo;
      }
    }

    return bestTarget;
  }

  /**
   * Check if entity is a valid target
   */
  private isValidTarget(entity: Entity): boolean {
    const bot = this.getBot();
    const options = this.config.options as CombatFeatureOptions | undefined;

    // Must be alive (use isValid and health check instead of isDead)
    if (!entity.isValid || (entity.health !== undefined && entity.health <= 0)) return false;

    // Check entity type
    const kind = entity.kind;
    const isPlayer = kind === 'Player' || entity.type === 'player';
    const isAnimal = entity.mobType === 'animal' || kind === 'Passive mob';

    if (isPlayer) {
      if (!options?.targetPlayers) return false;
      // Check blacklist
      if (options?.blacklist?.includes(entity.username ?? '')) return false;
      // Check teammates (simplified)
      if (options?.ignoreTeammates && this.isTeammate(entity.username ?? '')) return false;
    } else if (kind === 'Hostile mob' || entity.type === 'hostile') {
      if (!options?.targetMobs) return false;
    } else if (isAnimal || kind === 'Passive mob') {
      if (!options?.targetAnimals && !options?.targetPassive) return false;
    }

    // Must be visible (not through walls) - use raycast to check line of sight
    const targetPos = entity.position.offset(0, 1.6, 0);
    const blockAtCursor = bot.blockAtCursor(5, (block: Block) => {
      return block.position.equals(targetPos);
    });
    if (!blockAtCursor) {
      // Additional check: try to see if there's a clear line of sight using raycast
      // For now, we'll do a simple check - if the entity is far and we can't see the block at its position, skip
      // A more robust implementation would use raycasting
    }

    return true;
  }

  /**
   * Get target info
   */
  private getTargetInfo(entity: Entity, distance: number): CombatTarget {
    const options = this.config.options as CombatFeatureOptions | undefined;
    const isPlayer = entity.kind === 'Player' || entity.type === 'player';

    let priority = 0;
    if (isPlayer) priority += 100;
    if (options?.priorityTargets?.includes(entity.username ?? '')) priority += 1000;
    priority -= distance * 10;

    return {
      entity,
      distance,
      health: entity.health ?? 0,
      isPlayer,
      priority,
    };
  }

  /**
   * Calculate target score
   */
  private calculateTargetScore(target: CombatTarget): number {
    return target.priority;
  }

  /**
   * Check if player is teammate (simplified)
   */
  private isTeammate(_username: string): boolean {
    // This would integrate with a teams/friends system
    return false;
  }

  /**
   * Attack an entity
   */
  async attackEntity(entity: Entity): Promise<boolean> {
    const bot = this.getBot();
    const now = Date.now();

    if (now - this.lastAttackTime < this.attackCooldown) return false;

    const distance = bot.entity.position.distanceTo(entity.position);
    const options = this.config.options as CombatFeatureOptions | undefined;
    const range = options?.attackRange ?? 4.5;

    if (distance > range) {
      // Move closer using movement feature
      const movementFeature = this.getMovementFeature();
      if (movementFeature) {
        await movementFeature.moveToEntity(entity, range - 0.5);
      }
      return false;
    }

    try {
      // Look at entity
      await bot.lookAt(entity.position.offset(0, 1.6, 0), true);

      // Equip best weapon if enabled
      if (options?.autoEquipWeapon) {
        const inventoryFeature = this.getInventoryFeature();
        if (inventoryFeature) {
          await inventoryFeature.equipBestTool('sword');
        }
      }

      // Critical hit assist - jump if falling
      if (options?.criticalAssist && !bot.entity.onGround) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 50);
      }

      // Sprint reset for knockback
      if (options?.sprintReset) {
        bot.setControlState('sprint', false);
        setTimeout(() => bot.setControlState('sprint', true), 50);
      }

      // Attack
      bot.attack(entity);
      this.lastAttackTime = now;
      this.currentTarget = entity;
      this.notifyTargetChange(entity);

      return true;
    } catch (error) {
      console.error('[CombatFeature] Attack error:', error);
      return false;
    }
  }

  /**
   * Clear current target
   */
  private clearTarget(): void {
    if (this.currentTarget) {
      this.currentTarget = null;
      this.notifyTargetChange(null);
    }
  }

  /**
   * Notify target change listeners
   */
  private notifyTargetChange(target: Entity | null): void {
    for (const listener of this.targetChangeListeners) {
      try {
        listener(target);
      } catch (error) {
        console.error('[CombatFeature] Target listener error:', error);
      }
    }
  }

  // ========================================================================
  // Auto-Defense
  // ========================================================================

  /**
   * Enable/disable auto-defense
   */
  setAutoDefense(enabled: boolean): void {
    this.autoDefenseEnabled = enabled;
    this.setOption('autoDefense', enabled);
    console.log(`[CombatFeature] Auto-defense ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Called when bot takes damage
   */
  private async onDamaged(attacker: Entity): Promise<void> {
    if (!this.autoDefenseEnabled) return;

    // Attack back
    if (attacker.id !== this.getBot().entity.id) {
      await this.attackEntity(attacker);
    }
  }

  // ========================================================================
  // Target Death Handling
  // ========================================================================

  /**
   * Called when target dies
   */
  private onTargetDeath(entity: Entity): void {
    const isPlayer = entity.kind === 'Player' || entity.type === 'player';

    this.stats.kills++;
    this.stats.currentKillStreak++;
    this.stats.longestKillStreak = Math.max(
      this.stats.longestKillStreak,
      this.stats.currentKillStreak
    );

    if (isPlayer) {
      console.log(`[CombatFeature] Killed player: ${entity.username}`);
    }

    this.clearTarget();
  }

  /**
   * Called when bot dies
   */
  private onDeath(): void {
    this.stats.deaths++;
    this.stats.currentKillStreak = 0;
    this.clearTarget();
    console.log('[CombatFeature] Bot died');
  }

  // ========================================================================
  // Auto-Eat
  // ========================================================================

  /**
   * Check and eat food if needed
   */
  private async checkAutoEat(): Promise<void> {
    const bot = this.getBot();
    const options = this.config.options as CombatFeatureOptions | undefined;

    if (!options?.autoEat) return;

    const threshold = options?.eatThreshold ?? 18; // 9 hunger bars
    if (bot.food >= threshold) return;

    // Find food in inventory using minecraft-data foodsByName
    const registry = bot.registry as IndexedData;
    const food = bot.inventory.items().find((item) => {
      const foodData = registry.foodsByName?.[item.name];
      return foodData && foodData.foodPoints > 0;
    });

    if (food) {
      try {
        await bot.equip(food, 'hand');
        await bot.consume();
        console.log(`[CombatFeature] Auto-ate ${food.name}`);
      } catch (error) {
        console.error('[CombatFeature] Auto-eat error:', error);
      }
    }
  }

  // ========================================================================
  // Public Methods
  // ========================================================================

  /**
   * Get current target
   */
  getTarget(): Entity | null {
    return this.currentTarget;
  }

  /**
   * Check if kill aura is enabled
   */
  isKillAuraEnabled(): boolean {
    return this.killAuraEnabled;
  }

  /**
   * Check if auto-defense is enabled
   */
  isAutoDefenseEnabled(): boolean {
    return this.autoDefenseEnabled;
  }

  /**
   * Get combat stats
   */
  getStats(): CombatStats {
    return { ...this.stats };
  }

  /**
   * Subscribe to target changes
   */
  onTargetChange(listener: (target: Entity | null) => void): () => void {
    this.targetChangeListeners.push(listener);
    return () => {
      const index = this.targetChangeListeners.indexOf(listener);
      if (index !== -1) {
        this.targetChangeListeners.splice(index, 1);
      }
    };
  }

  /**
   * Set attack range
   */
  setAttackRange(range: number): void {
    this.setOption('attackRange', range);
  }

  /**
   * Set attack cooldown
   */
  setAttackCooldown(cooldown: number): void {
    this.attackCooldown = cooldown;
    this.setOption('attackCooldown', cooldown);
  }

  /**
   * Add priority target
   */
  addPriorityTarget(username: string): void {
    const options = this.config.options as CombatFeatureOptions | undefined;
    if (!options) return;

    const targets = options.priorityTargets ?? [];
    if (!targets.includes(username)) {
      targets.push(username);
      this.setOption('priorityTargets', targets);
    }
  }

  /**
   * Remove priority target
   */
  removePriorityTarget(username: string): void {
    const options = this.config.options as CombatFeatureOptions | undefined;
    if (!options) return;

    const targets = options.priorityTargets ?? [];
    const index = targets.indexOf(username);
    if (index !== -1) {
      targets.splice(index, 1);
      this.setOption('priorityTargets', targets);
    }
  }

  /**
   * Add to blacklist
   */
  addToBlacklist(username: string): void {
    const options = this.config.options as CombatFeatureOptions | undefined;
    if (!options) return;

    const blacklist = options.blacklist ?? [];
    if (!blacklist.includes(username)) {
      blacklist.push(username);
      this.setOption('blacklist', blacklist);
    }
  }

  /**
   * Remove from blacklist
   */
  removeFromBlacklist(username: string): void {
    const options = this.config.options as CombatFeatureOptions | undefined;
    if (!options) return;

    const blacklist = options.blacklist ?? [];
    const index = blacklist.indexOf(username);
    if (index !== -1) {
      blacklist.splice(index, 1);
      this.setOption('blacklist', blacklist);
    }
  }

  /**
   * Force attack a specific entity
   */
  async forceAttack(entity: Entity): Promise<boolean> {
    return this.attackEntity(entity);
  }

  /**
   * Stop attacking
   */
  stopAttacking(): void {
    this.clearTarget();
  }

  /**
   * Reset stats
   */
  resetStats(): void {
    this.stats = {
      kills: 0,
      deaths: 0,
      damageDealt: 0,
      damageTaken: 0,
      longestKillStreak: 0,
      currentKillStreak: 0,
    };
  }
}

export default CombatFeature;
