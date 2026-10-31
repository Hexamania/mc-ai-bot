/**
 * Building/Construction Feature
 * Handles building structures, roof construction, nether portal, and block placement
 */

import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import type { FeaturePluginConfig } from './BaseFeature.js';
import { BaseFeature } from './BaseFeature.js';

/**
 * Building feature configuration
 */
export type BuildingFeatureConfig = FeaturePluginConfig;

/**
 * Building feature options
 */
export interface BuildingFeatureOptions {
  /** Default building material priority */
  materialPriority?: string[];
  /** Auto-collect materials when running out */
  autoCollectMaterials?: boolean;
  /** Maximum distance to search for blocks */
  maxSearchDistance?: number;
  /** Default roof radius */
  defaultRoofRadius?: number;
}

/**
 * Structure types
 */
export type StructureType = 'shelter' | 'house' | 'schematic';

/**
 * Build task info
 */
export interface BuildTask {
  type: StructureType;
  blocks: Vec3[];
  currentIndex: number;
  total: number;
  customData?: unknown;
}

/**
 * Building Feature Class
 */
export class BuildingFeature extends BaseFeature {
  public readonly name = 'building';
  public readonly version = '1.0.0';
  public readonly description = 'Building structures, roof construction, and block placement';
  public readonly dependencies = ['core', 'movement', 'inventory'];

  private currentTask: BuildTask | null = null;
  private isBuilding = false;
  private materialPriority: string[] = [
    'cobblestone',
    'dirt',
    'oak_planks',
    'stone',
    'netherrack',
    'planks',
  ];

  constructor() {
    super('building', '1.0.0', 'Building structures, roof construction, and block placement', [
      'core',
      'movement',
      'inventory',
    ]);
  }

  /**
   * Initialize the building feature
   */
  protected async onEnable(): Promise<void> {
    // const bot = this.getBot(); // Available via this.getBot()

    // Configure from options
    this.configureFromOptions();

    // Register commands
    this.registerCommands();

    console.log('[BuildingFeature] Building feature enabled');
  }

  /**
   * Disable the building feature
   */
  protected async onDisable(): Promise<void> {
    this.currentTask = null;
    this.isBuilding = false;
    this.removeAllListeners();
    console.log('[BuildingFeature] Building feature disabled');
  }

  /**
   * Configure from options
   */
  private configureFromOptions(): void {
    const options = this.config.options as BuildingFeatureOptions | undefined;
    if (!options) return;

    this.materialPriority = options.materialPriority ?? this.materialPriority;
  }

  /**
   * Register building commands
   */
  private registerCommands(): void {
    // Commands will be registered via the command system
  }

  // ========================================================================
  // Building Methods
  // ========================================================================

  /**
   * Build a structure
   */
  async buildStructure(type: StructureType, customData?: unknown): Promise<void> {
    const bot = this.getBot();
    const start = bot.entity.position.floored().offset(1, 0, 1);
    let blocks: Vec3[] = [];

    switch (type) {
      case 'shelter':
        blocks = this.generateShelter(start);
        break;
      case 'house':
        blocks = this.generateHouse(start);
        break;
      case 'schematic':
        if (Array.isArray(customData)) {
          const origin = bot.entity.position.floored();
          blocks = customData.map((b) => origin.offset(b.x, b.y, b.z));
          console.log(
            `[BuildingFeature] Starting custom schematic build (${customData.length} blocks)...`
          );
        }
        break;
    }

    if (blocks.length === 0) return;

    this.currentTask = {
      type,
      blocks,
      currentIndex: 0,
      total: blocks.length,
      customData,
    };
    this.isBuilding = true;

    console.log(`[BuildingFeature] Building ${type}...`);
    try {
      for (const p of blocks) {
        if (!this.isBuilding) break;
        await this.placeBlockAt(p);
        this.currentTask.currentIndex++;
      }
      if (this.isBuilding) {
        console.log(`[BuildingFeature] Build complete: ${type}`);
      }
    } catch (error) {
      console.error('[BuildingFeature] Build stopped:', error);
    } finally {
      this.isBuilding = false;
      this.currentTask = null;
    }
  }

  /**
   * Generate shelter blocks
   */
  private generateShelter(start: Vec3): Vec3[] {
    const blocks: Vec3[] = [];
    for (let y = -1; y <= 1; y++) {
      for (let x = 0; x < 3; x++) {
        for (let z = 0; z < 3; z++) {
          if (y === -1 || y === 1 || x === 0 || x === 2 || z === 0 || z === 2) {
            if (!(y === 0 && x === 1 && z === 1)) {
              blocks.push(start.offset(x, y, z));
            }
          }
        }
      }
    }
    return blocks;
  }

  /**
   * Generate house blocks
   */
  private generateHouse(start: Vec3): Vec3[] {
    const blocks: Vec3[] = [];
    for (let x = 0; x < 5; x++) {
      for (let z = 0; z < 5; z++) {
        // Floor
        blocks.push(start.offset(x, -1, z));
        // Walls
        for (let y = 0; y < 3; y++) {
          if (x === 0 || x === 4 || z === 0 || z === 4) {
            if (!(x === 2 && z === 0 && y < 2)) {
              blocks.push(start.offset(x, y, z));
            }
          }
        }
        // Roof
        blocks.push(start.offset(x, 3, z));
      }
    }
    return blocks;
  }

  /**
   * Place a block at a specific position
   */
  async placeBlockAt(pos: Vec3): Promise<void> {
    const bot = this.getBot();

    const blockAtPos = bot.blockAt(pos);
    if (!blockAtPos || blockAtPos.name !== 'air') return;

    let material = this.findBuildingMaterial();

    if (!material && this.getOption('autoCollectMaterials', true)) {
      await this.collectMaterials();
      material = this.findBuildingMaterial();
    }

    if (!material) throw new Error('Out of building materials');

    const neighbors = [
      new Vec3(0, -1, 0),
      new Vec3(0, 1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
    ];

    for (const d of neighbors) {
      const ref = bot.blockAt(pos.plus(d));
      if (ref && ref.name !== 'air' && ref.name !== 'water' && ref.name !== 'lava') {
        try {
          const movementFeature = this.getMovementFeature();
          if (movementFeature) {
            await movementFeature.moveToPosition(pos.x, pos.y, pos.z, 4);
          } else {
            await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 4));
          }
          await bot.equip(material, 'hand');
          await bot.lookAt(ref.position);
          await bot.placeBlock(ref, d.scaled(-1));
          return;
        } catch (error) {
          console.error('[BuildingFeature] Place block error:', error);
        }
      }
    }
  }

  /**
   * Find building material in inventory
   */
  private findBuildingMaterial() {
    const bot = this.getBot();
    return bot.inventory
      .items()
      .find((item) => this.materialPriority.some((m) => item.name.includes(m)));
  }

  /**
   * Collect materials for building
   */
  async collectMaterials(): Promise<void> {
    const bot = this.getBot();
    console.log('[BuildingFeature] Out of building blocks! Gathering materials...');

    const targetBlocks = bot.registry.blocksArray
      .filter((b) =>
        ['dirt', 'cobblestone', 'netherrack', 'deepslate', 'grass_block'].includes(b.name)
      )
      .map((b) => b.id);

    for (let i = 0; i < 32; i++) {
      const block = bot.findBlock({ matching: targetBlocks, maxDistance: 32 });
      if (block) {
        try {
          const movementFeature = this.getMovementFeature();
          if (movementFeature) {
            await movementFeature.moveToBlock(
              block.position.x,
              block.position.y,
              block.position.z,
              4
            );
          } else {
            await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world));
          }
          await this.equipToolForBlock(block);
          await bot.dig(block);
        } catch (error) {
          console.error('[BuildingFeature] Gather error:', error);
        }
      }
    }
    console.log('[BuildingFeature] Materials collected. Resuming build.');
  }

  /**
   * Equip best tool for a block
   */
  private async equipToolForBlock(block: Block): Promise<void> {
    const bot = this.getBot();
    // const registry = bot.registry; // Available if needed
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
    }
  }

  /**
   * Build a roof at base location
   */
  async buildRoof(radius = 5): Promise<void> {
    const bot = this.getBot();

    // Get base location from bot manager
    const baseLocation = this.getBaseLocation();
    if (!baseLocation) {
      console.warn('[BuildingFeature] No base location set');
      return;
    }

    const slab = bot.inventory.items().find((i) => i.name.includes('slab'));
    if (!slab) {
      console.warn('[BuildingFeature] Need slabs to build roof');
      return;
    }

    const roofY = baseLocation.y + 3;
    console.log(`[BuildingFeature] Constructing roof at height ${Math.floor(roofY)}...`);

    for (let x = -radius; x <= radius; x++) {
      for (let z = -radius; z <= radius; z++) {
        if (!this.isBuilding) return;

        const pos = new Vec3(baseLocation.x + x, roofY, baseLocation.z + z);
        const blockAtPos = bot.blockAt(pos);
        if (!blockAtPos || blockAtPos.name !== 'air') continue;

        const material = bot.inventory.items().find((i) => i.name.includes('slab'));
        if (!material) {
          console.warn('[BuildingFeature] Out of slabs!');
          return;
        }

        try {
          const movementFeature = this.getMovementFeature();
          if (movementFeature) {
            await movementFeature.moveToPosition(pos.x, pos.y, pos.z, 4);
          } else {
            await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 4));
          }

          const neighbors = [
            new Vec3(0, -1, 0),
            new Vec3(1, 0, 0),
            new Vec3(-1, 0, 0),
            new Vec3(0, 0, 1),
            new Vec3(0, 0, -1),
          ];

          for (const d of neighbors) {
            const ref = bot.blockAt(pos.plus(d));
            if (ref && ref.name !== 'air') {
              await bot.equip(material, 'hand');
              await bot.placeBlock(ref, d.scaled(-1));
              break;
            }
          }
        } catch (error) {
          console.error('[BuildingFeature] Roof build error:', error);
        }
      }
    }
    console.log('[BuildingFeature] Roof construction complete.');
  }

  /**
   * Get base location (from bot manager or memory)
   */
  private getBaseLocation(): { x: number; y: number; z: number } | null {
    // This would integrate with bot manager's baseLocation property
    // For now, return null to indicate it needs to be set
    return null;
  }

  /**
   * Build a nether portal
   */
  async buildNetherPortal(): Promise<void> {
    const bot = this.getBot();
    const obsidianId = bot.registry.itemsByName.obsidian.id;
    const flintId = bot.registry.itemsByName.flint_and_steel.id;

    const startPos = bot.entity.position.floored().offset(2, 0, 0);
    console.log(
      `[BuildingFeature] Building Nether Portal at ${startPos.x}, ${startPos.y}, ${startPos.z}`
    );

    const frameOffsets = [
      [1, 0, 0],
      [2, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
      [0, 3, 0],
      [3, 1, 0],
      [3, 2, 0],
      [3, 3, 0],
      [1, 4, 0],
      [2, 4, 0],
    ];

    for (const offset of frameOffsets) {
      if (!this.isBuilding) return;

      const p = startPos.offset(offset[0], offset[1], offset[2]);
      const blockAtP = bot.blockAt(p);
      if (!blockAtP || blockAtP.name === 'obsidian') continue;

      try {
        const movementFeature = this.getMovementFeature();
        if (movementFeature) {
          await movementFeature.moveToPosition(p.x, p.y, p.z, 4);
        } else {
          await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 4));
        }

        const item = bot.inventory.findInventoryItem(obsidianId, null, false);
        if (!item) return;
        await bot.equip(item, 'hand');

        const neighbors: [number, number, number][] = [
          [0, -1, 0],
          [0, 1, 0],
          [1, 0, 0],
          [-1, 0, 0],
          [0, 0, 1],
          [0, 0, -1],
        ];
        for (const n of neighbors) {
          const ref = bot.blockAt(p.offset(n[0], n[1], n[2]));
          if (ref && ref.name !== 'air') {
            try {
              await bot.placeBlock(ref, new Vec3(n[0], n[1], n[2]).scaled(-1));
              break;
            } catch {
              // Ignore placement errors, try next neighbor
            }
          }
        }
      } catch (error) {
        console.error('[BuildingFeature] Portal build error:', error);
      }
    }

    const flint = bot.inventory.findInventoryItem(flintId, null, false);
    const portalInside = startPos.offset(1, 1, 0);
    const blockAtPortalInside = bot.blockAt(portalInside);
    if (flint && blockAtPortalInside && blockAtPortalInside.name === 'air') {
      await bot.equip(flint, 'hand');
      await bot.lookAt(portalInside, true);
      const blockBelowPortal = bot.blockAt(portalInside.offset(0, -1, 0));
      if (blockBelowPortal) {
        await bot.activateBlock(blockBelowPortal);
      }
    }
  }

  /**
   * Stop current building task
   */
  stopBuilding(): void {
    this.isBuilding = false;
    this.currentTask = null;
  }

  /**
   * Check if currently building
   */
  isBuildingNow(): boolean {
    return this.isBuilding;
  }

  /**
   * Get current build task
   */
  getCurrentTask(): BuildTask | null {
    return this.currentTask;
  }

  /**
   * Get build progress (0-1)
   */
  getBuildProgress(): number {
    if (!this.currentTask || this.currentTask.total === 0) return 0;
    return this.currentTask.currentIndex / this.currentTask.total;
  }
}

export default BuildingFeature;
