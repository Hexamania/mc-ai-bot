/**
 * Mining/Resource Gathering Feature
 * Handles mining tunnels, mining areas, refueling, and block mining
 */

import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { goals, Movements } from 'mineflayer-pathfinder';
import type { FeaturePluginConfig } from './BaseFeature.js';
import { BaseFeature } from './BaseFeature.js';
import * as mcDataLoader from 'minecraft-data';

/**
 * Mining feature configuration
 */
export type MiningFeatureConfig = FeaturePluginConfig;

/**
 * Mining feature options
 */
export interface MiningFeatureOptions {
  /** Auto-refuel when low on fuel */
  autoRefuel?: boolean;
  /** Maximum tunnel length */
  maxTunnelLength?: number;
  /** Maximum mining area volume */
  maxAreaVolume?: number;
  /** Default mining radius for area mining */
  defaultAreaRadius?: number;
}

/**
 * Mining direction
 */
export type MiningDirection = 'north' | 'south' | 'east' | 'west';

/**
 * Miner task info
 */
export interface MinerTask {
  active: boolean;
  direction?: MiningDirection;
  length: number;
  current: number;
}

/**
 * Mine area task info
 */
export interface MineAreaTask {
  active: boolean;
  min: [number, number, number];
  max: [number, number, number];
  current: [number, number, number];
  volume: number;
}

/**
 * Minecraft data type
 */
type MinecraftData = ReturnType<typeof mcDataLoader>;

/**
 * Mining Feature Class
 */
export class MiningFeature extends BaseFeature {
  public readonly name = 'mining';
  public readonly version = '1.0.0';
  public readonly description = 'Mining tunnels, areas, refueling, and resource gathering';
  public readonly dependencies = ['core', 'movement', 'inventory'];

  private minerTask: MinerTask = { active: false, length: 0, current: 0 };
  private mineAreaTask: MineAreaTask = {
    active: false,
    min: [0, 0, 0],
    max: [0, 0, 0],
    current: [0, 0, 0],
    volume: 0,
  };
  private miningBaseLocation: { x: number; y: number; z: number } | null = null;
  private movements: Movements | null = null;
  private mcData: MinecraftData | null = null;

  constructor() {
    super('mining', '1.0.0', 'Mining tunnels, areas, refueling, and resource gathering', [
      'core',
      'movement',
      'inventory',
    ]);
  }

  /**
   * Initialize the mining feature
   */
  protected async onEnable(): Promise<void> {
    const bot = this.getBot();

    // Initialize minecraft-data and movements
    this.mcData = this.getMinecraftData();
    this.movements = new Movements(bot, this.mcData);
    this.movements.canDig = true;
    this.movements.allowBridging = true;
    this.movements.allowParkour = true;
    this.movements.allowSprinting = true;
    bot.pathfinder.setMovements(this.movements);

    // Configure from options
    this.configureFromOptions();

    // Register commands
    this.registerCommands();

    console.log('[MiningFeature] Mining feature enabled');
  }

  /**
   * Disable the mining feature
   */
  protected async onDisable(): Promise<void> {
    this.stopMiner();
    this.stopMineArea();
    this.removeAllListeners();
    console.log('[MiningFeature] Mining feature disabled');
  }

  /**
   * Configure from options
   */
  private configureFromOptions(): void {
    const options = this.config.options as MiningFeatureOptions | undefined;
    if (!options) return;
  }

  /**
   * Register mining commands
   */
  private registerCommands(): void {
    // Commands will be registered via the command system
  }

  /**
   * Get minecraft data
   */
  private getMinecraftData(): MinecraftData {
    const bot = this.getBot();
    return mcDataLoader(bot.version) || mcDataLoader(process.env.MC_VERSION || '1.21.1');
  }

  // ========================================================================
  // Miner Tunnel Methods
  // ========================================================================

  /**
   * Start mining tunnel
   */
  async startMiner(direction: MiningDirection, length = 10): Promise<void> {
    if (this.minerTask.active) {
      console.warn('[MiningFeature] Miner already active');
      return;
    }

    const validDirections: MiningDirection[] = ['north', 'south', 'east', 'west'];
    if (!validDirections.includes(direction)) {
      throw new Error('Invalid direction. Use: north, south, east, west');
    }

    this.minerTask = { active: true, direction, length, current: 0 };
    console.log(`[MiningFeature] Starting ${length} block tunnel to the ${direction}...`);
    void this.minerLoop(direction, length, 0);
  }

  /**
   * Stop mining tunnel
   */
  stopMiner(): void {
    this.minerTask.active = false;
  }

  /**
   * Check if miner is active
   */
  isMinerActive(): boolean {
    return this.minerTask.active;
  }

  /**
   * Get miner progress
   */
  getMinerProgress(): { current: number; total: number; direction?: MiningDirection } {
    return {
      current: this.minerTask.current,
      total: this.minerTask.length,
      direction: this.minerTask.direction,
    };
  }

  /**
   * Miner loop - recursive tunnel digging
   */
  private async minerLoop(
    direction: MiningDirection,
    length: number,
    current: number
  ): Promise<void> {
    if (!this.minerTask.active || current >= length) {
      this.minerTask.active = false;
      console.log(`[MiningFeature] Tunneling complete. Dug ${current} blocks.`);
      return;
    }

    const offsets = {
      north: { x: 0, z: -1 },
      south: { x: 0, z: 1 },
      east: { x: 1, z: 0 },
      west: { x: -1, z: 0 },
    };
    const off = offsets[direction];

    try {
      const bot = this.getBot();
      const b1 = bot.blockAt(bot.entity.position.offset(off.x, 0, off.z));
      const b2 = bot.blockAt(bot.entity.position.offset(off.x, 1, off.z));

      if (b1 && b1.name !== 'air') await bot.dig(b1);
      if (b2 && b2.name !== 'air') await bot.dig(b2);

      const goal = new goals.GoalBlock(
        bot.entity.position.x + off.x,
        bot.entity.position.y,
        bot.entity.position.z + off.z
      );
      await bot.pathfinder.goto(goal);

      this.minerTask.current = current + 1;
      setTimeout(() => void this.minerLoop(direction, length, current + 1), 500);
    } catch (error) {
      console.error('[MiningFeature] Miner error:', error);
      this.minerTask.active = false;
    }
  }

  // ========================================================================
  // Mine Area Methods
  // ========================================================================

  /**
   * Start mining area
   */
  async startMineArea(pos1: Vec3, pos2: Vec3): Promise<void> {
    if (this.mineAreaTask.active) {
      console.warn('[MiningFeature] Mine area already active');
      return;
    }

    const start = [Math.floor(pos1.x), Math.floor(pos1.y), Math.floor(pos1.z)];
    const end = [Math.floor(pos2.x), Math.floor(pos2.y), Math.floor(pos2.z)];
    const min = start.map((v, i) => Math.min(v, end[i])) as [number, number, number];
    const max = start.map((v, i) => Math.max(v, end[i])) as [number, number, number];

    const volume = (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1);
    const maxVolume = this.getOption('maxAreaVolume', 512);

    if (volume > maxVolume) {
      throw new Error(`Mine area is ${volume} blocks; maximum supported is ${maxVolume}`);
    }

    this.mineAreaTask = {
      active: true,
      min,
      max,
      current: [...min] as [number, number, number],
      volume,
    };

    console.log(
      `[MiningFeature] Mining area from ${min.join(', ')} to ${max.join(', ')} (${volume} blocks).`
    );
    void this.mineAreaLoop();
  }

  /**
   * Stop mining area
   */
  stopMineArea(): void {
    this.mineAreaTask.active = false;
  }

  /**
   * Check if mine area is active
   */
  isMineAreaActive(): boolean {
    return this.mineAreaTask.active;
  }

  /**
   * Get mine area progress
   */
  getMineAreaProgress(): { current: number; total: number } {
    const { min, max, current } = this.mineAreaTask;
    if (!this.mineAreaTask.active) return { current: 0, total: 0 };

    const total = (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1);
    const done =
      (current[0] - min[0]) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1) +
      (current[1] - min[1]) * (max[2] - min[2] + 1) +
      (current[2] - min[2]);

    return { current: done, total };
  }

  /**
   * Mine area loop
   */
  private async mineAreaLoop(): Promise<void> {
    const { min, max, current } = this.mineAreaTask;
    const bot = this.getBot();

    for (let x = current[0]; x <= max[0] && this.mineAreaTask.active; x++) {
      for (let y = current[1]; y <= max[1] && this.mineAreaTask.active; y++) {
        for (let z = current[2]; z <= max[2] && this.mineAreaTask.active; z++) {
          this.mineAreaTask.current = [x, y, z];

          const block = bot.blockAt(new Vec3(x, y, z));
          if (!block || block.name === 'air' || !block.diggable) continue;

          try {
            await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world));
            if (!this.mineAreaTask.active) break;
            await this.equipToolForBlock(block);
            await bot.dig(block);
          } catch (error) {
            console.error('[MiningFeature] Mine area error:', error);
            if (this.mineAreaTask.active) {
              this.mineAreaTask.active = false;
              return;
            }
          }
        }
        this.mineAreaTask.current[2] = min[2]; // reset z for next y
      }
      this.mineAreaTask.current[1] = min[1]; // reset y for next x
    }

    if (this.mineAreaTask.active) {
      console.log('[MiningFeature] Mine area complete.');
    }
    this.mineAreaTask.active = false;
  }

  // ========================================================================
  // Refuel Methods
  // ========================================================================

  /**
   * Refuel - search for and mine coal
   */
  async refuel(): Promise<void> {
    const bot = this.getBot();
    const registry = bot.registry;
    const coalBlocks = registry.blocksArray
      .filter((b) => b.name === 'coal_ore' || b.name === 'deepslate_coal_ore')
      .map((b) => b.id);

    console.log('[MiningFeature] Refuel Protocol: Searching for coal...');

    let gathered = 0;
    for (let i = 0; i < 5; i++) {
      const block = bot.findBlock({ matching: coalBlocks, maxDistance: 32 });
      if (block) {
        try {
          await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world));
          await this.equipToolForBlock(block);
          await bot.dig(block);
          gathered++;
        } catch (error) {
          console.error('[MiningFeature] Refuel error:', error);
        }
      } else {
        break;
      }
    }

    if (gathered === 0) {
      // Check for charcoal smelting if no ore found
      const logs = bot.inventory.items().find((i) => i.name.includes('_log'));
      if (logs) {
        console.log('[MiningFeature] No coal ore found. Smelting logs for charcoal...');
        const furnaceBlock = bot.findBlock({
          matching: registry.blocksByName.furnace.id,
          maxDistance: 10,
        });
        if (furnaceBlock) {
          const furnace = await bot.openFurnace(furnaceBlock);
          await furnace.putInput(logs.type, null, logs.count);
        }
      } else {
        console.log('[MiningFeature] No coal found nearby and no logs to smelt.');
      }
    } else {
      console.log(`[MiningFeature] Refuel complete. Gathered from ${gathered} veins.`);
    }
  }

  // ========================================================================
  // Block Mining Methods
  // ========================================================================

  /**
   * Mine a specific block type
   */
  async mineBlock(name: string): Promise<void> {
    const bot = this.getBot();
    const blockType = bot.registry.blocksByName[name];
    if (!blockType) return;

    const block = bot.findBlock({ matching: blockType.id, maxDistance: 32 });
    if (!block) return;

    try {
      await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world));
      await this.equipToolForBlock(block);
      await bot.dig(block);
    } catch (error) {
      console.error('[MiningFeature] Mine block error:', error);
    }
  }

  /**
   * Equip best tool for a block
   */
  private async equipToolForBlock(block: Block): Promise<void> {
    const bot = this.getBot();
    const pickaxes = [
      'netherite_pickaxe',
      'diamond_pickaxe',
      'iron_pickaxe',
      'stone_pickaxe',
      'wooden_pickaxe',
    ];

    let minTier = 0;
    const name = block.name;

    if (name.includes('obsidian') || name.includes('ancient_debris')) minTier = 3;
    else if (
      name.includes('diamond_ore') ||
      name.includes('gold_ore') ||
      name.includes('emerald_ore') ||
      name.includes('redstone_ore')
    )
      minTier = 2;
    else if (name.includes('iron_ore') || name.includes('copper_ore') || name.includes('lapis_ore'))
      minTier = 1;

    const availablePicks = bot.inventory.items().filter((i) => pickaxes.includes(i.name));
    availablePicks.sort((a, b) => pickaxes.indexOf(a.name) - pickaxes.indexOf(b.name));

    const bestPick = availablePicks.find((p) => {
      const tier = 4 - pickaxes.indexOf(p.name);
      return tier >= minTier;
    });

    if (bestPick) {
      await bot.equip(bestPick, 'hand');
    } else if (minTier > 0) {
      console.warn(`[MiningFeature] No tool found suitable for ${name}. Tier ${minTier} required.`);
    }
  }

  // ========================================================================
  // Mining Base Methods
  // ========================================================================

  /**
   * Set mining base location
   */
  setMiningBase(location: { x: number; y: number; z: number }): void {
    this.miningBaseLocation = location;
  }

  /**
   * Get mining base location
   */
  getMiningBase(): { x: number; y: number; z: number } | null {
    return this.miningBaseLocation;
  }

  /**
   * Go to mining base
   */
  async goToMiningBase(): Promise<void> {
    if (!this.miningBaseLocation) {
      throw new Error('No mining base set');
    }
    const bot = this.getBot();
    await bot.pathfinder.goto(
      new goals.GoalBlock(
        this.miningBaseLocation.x,
        this.miningBaseLocation.y,
        this.miningBaseLocation.z
      )
    );
  }
}

export default MiningFeature;
