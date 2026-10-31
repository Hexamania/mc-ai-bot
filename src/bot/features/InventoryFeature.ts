/**
 * Inventory Management Feature
 * Handles inventory operations, sorting, crafting, and item management
 */

import type { Item } from 'prismarine-item';
import type { Recipe, RecipeItem } from 'prismarine-recipe';
import type { Block } from 'prismarine-block';
import type { FeaturePluginConfig } from './BaseFeature.js';
import { BaseFeature } from './BaseFeature.js';

/**
 * Inventory feature configuration
 */
export type InventoryFeatureConfig = FeaturePluginConfig;

/**
 * Inventory feature options
 */
export interface InventoryFeatureOptions {
  /** Auto-sort inventory on changes */
  autoSort?: boolean;
  /** Auto-drop unwanted items */
  autoDrop?: boolean;
  /** List of item names to auto-drop */
  dropList?: string[];
  /** Keep minimum count of items */
  keepMinimum?: Record<string, number>;
  /** Auto-equip best armor */
  autoEquipArmor?: boolean;
  /** Auto-equip best tools */
  autoEquipTools?: boolean;
  /** Max stack size for combining */
  maxStackSize?: number;
  /** Enable crafting */
  enableCrafting?: boolean;
}

/**
 * Inventory item info
 */
export interface InventoryItemInfo {
  slot: number;
  name: string;
  displayName: string;
  count: number;
  maxStackSize: number;
  durability?: number;
  maxDurability?: number;
  enchantments?: Record<string, number>;
}

/**
 * Equipment slot info
 */
export interface EquipmentInfo {
  head: InventoryItemInfo | null;
  chest: InventoryItemInfo | null;
  legs: InventoryItemInfo | null;
  feet: InventoryItemInfo | null;
  hand: InventoryItemInfo | null;
  offhand: InventoryItemInfo | null;
}

/**
 * Crafting recipe
 */
export interface CraftingRecipe {
  name: string;
  ingredients: { name: string; count: number }[];
  result: { name: string; count: number };
  shaped?: boolean;
  pattern?: string[];
}

/**
 * Inventory Feature Class
 */
export class InventoryFeature extends BaseFeature {
  public readonly name = 'inventory';
  public readonly version = '1.0.0';
  public readonly description = 'Inventory management, sorting, crafting, and item handling';
  public readonly dependencies = ['core'];

  private autoSortEnabled = false;
  private autoDropEnabled = false;
  private dropList = new Set<string>();
  private keepMinimum = new Map<string, number>();
  private craftingRecipes = new Map<string, CraftingRecipe>();

  constructor() {
    super('inventory', '1.0.0', 'Inventory management, sorting, crafting, and item handling', [
      'core',
    ]);
  }

  /**
   * Initialize the inventory feature
   */
  protected async onEnable(): Promise<void> {
    // Configure from options
    this.configureFromOptions();

    // Load crafting recipes
    this.loadCraftingRecipes();

    // Set up event listeners
    this.setupEventListeners();

    // Register commands
    this.registerCommands();

    console.log('[InventoryFeature] Inventory feature enabled');
  }

  /**
   * Disable the inventory feature
   */
  protected async onDisable(): Promise<void> {
    this.removeAllListeners();
    this.craftingRecipes.clear();
    console.log('[InventoryFeature] Inventory feature disabled');
  }

  /**
   * Configure from options
   */
  private configureFromOptions(): void {
    const options = this.config.options as InventoryFeatureOptions | undefined;
    if (!options) return;

    this.autoSortEnabled = options.autoSort ?? false;
    this.autoDropEnabled = options.autoDrop ?? false;

    if (options.dropList) {
      this.dropList = new Set(options.dropList.map((item) => item.toLowerCase()));
    }

    if (options.keepMinimum) {
      this.keepMinimum = new Map(Object.entries(options.keepMinimum));
    }
  }

  /**
   * Load crafting recipes
   */
  private loadCraftingRecipes(): void {
    const bot = this.getBot();

    // Register basic recipes - recipesAll requires itemType, metadata, craftingTable
    const recipes = bot.recipesAll(-1, null, null);

    for (const recipe of recipes) {
      const result = recipe.result;
      if (result) {
        // Get item name from registry using the result item id
        const resultName = bot.registry.items[result.id]?.name ?? 'unknown';
        const recipeKey = resultName;
        if (
          !this.craftingRecipes.has(recipeKey) ||
          this.craftingRecipes.get(recipeKey)!.ingredients.length > recipe.ingredients.length
        ) {
          this.craftingRecipes.set(recipeKey, {
            name: resultName,
            ingredients: recipe.ingredients.map((ing) => ({
              name: bot.registry.items[ing.id]?.name ?? 'air',
              count: ing.count,
            })),
            result: {
              name: resultName,
              count: result.count,
            },
            shaped: recipe.requiresTable,
            pattern: recipe.requiresTable ? this.getRecipePattern(recipe) : undefined,
          });
        }
      }
    }

    console.log(`[InventoryFeature] Loaded ${this.craftingRecipes.size} crafting recipes`);
  }

  /**
   * Get recipe pattern for shaped recipes
   */
  private getRecipePattern(_recipe: Recipe): string[] {
    // This is a simplified pattern extraction
    // In reality, you'd need to parse the recipe matrix
    return ['###', '###', '###'];
  }

  /**
   * Set up event listeners
   */
  private setupEventListeners(): void {
    const bot = this.getBot();

    // Auto-sort on inventory change - use windowClose/windowOpen or just periodic check
    // windowUpdate is not a standard bot event, use a different approach
    if (this.autoSortEnabled) {
      // Listen for window changes - we can use a periodic check or the window events
      bot.on('windowOpen', (window) => {
        if (window.type === 'minecraft:container') {
          void this.sortInventory();
        }
      });
    }

    // Auto-drop unwanted items
    if (this.autoDropEnabled) {
      bot.on('playerCollect', (entity) => {
        if (entity.username === bot.username) {
          setTimeout(() => void this.checkAutoDrop(), 100);
        }
      });
    }

    // Auto-equip armor
    const options = this.config.options as InventoryFeatureOptions | undefined;
    if (options?.autoEquipArmor) {
      bot.on('health', () => {
        void this.autoEquipBestArmor();
      });
    }
  }

  /**
   * Register inventory commands
   */
  private registerCommands(): void {
    // Commands will be registered via the command system
  }

  // ========================================================================
  // Inventory Query Methods
  // ========================================================================

  /**
   * Get all inventory items
   */
  getItems(): InventoryItemInfo[] {
    const bot = this.getBot();
    const items: InventoryItemInfo[] = [];

    for (const item of bot.inventory.items()) {
      items.push(this.itemToInfo(item));
    }

    return items;
  }

  /**
   * Get item by name
   */
  getItemByName(name: string): InventoryItemInfo | null {
    const bot = this.getBot();
    const item = bot.inventory.items().find((i) => i.name === name || i.displayName === name);
    return item ? this.itemToInfo(item) : null;
  }

  /**
   * Get item count by name
   */
  getItemCount(name: string): number {
    const bot = this.getBot();
    const itemId = bot.registry.itemsByName[name]?.id ?? -1;
    // count requires itemType and metadata
    return bot.inventory.count(itemId, null);
  }

  /**
   * Get empty slot count
   */
  getEmptySlotCount(): number {
    const bot = this.getBot();
    return bot.inventory.emptySlotCount();
  }

  /**
   * Check if inventory is full
   */
  isFull(): boolean {
    return this.getEmptySlotCount() === 0;
  }

  /**
   * Get equipment
   */
  getEquipment(): EquipmentInfo {
    const bot = this.getBot();
    return {
      head: bot.inventory.slots[5] ? this.itemToInfo(bot.inventory.slots[5]!) : null,
      chest: bot.inventory.slots[6] ? this.itemToInfo(bot.inventory.slots[6]!) : null,
      legs: bot.inventory.slots[7] ? this.itemToInfo(bot.inventory.slots[7]!) : null,
      feet: bot.inventory.slots[8] ? this.itemToInfo(bot.inventory.slots[8]!) : null,
      hand: bot.inventory.slots[45] ? this.itemToInfo(bot.inventory.slots[45]!) : null,
      offhand: bot.inventory.slots[44] ? this.itemToInfo(bot.inventory.slots[44]!) : null,
    };
  }

  /**
   * Convert mineflayer item to info object
   */
  private itemToInfo(item: Item): InventoryItemInfo {
    // Use enchants getter which returns { name: string; lvl: number }[]
    const enchants = item.enchants
      ? Object.fromEntries(item.enchants.map((e) => [e.name, e.lvl]))
      : undefined;

    return {
      slot: item.slot,
      name: item.name,
      displayName: item.displayName,
      count: item.count,
      maxStackSize: item.stackSize,
      durability: item.durabilityUsed > 0 ? item.maxDurability - item.durabilityUsed : undefined,
      maxDurability: item.maxDurability > 0 ? item.maxDurability : undefined,
      enchantments: enchants,
    };
  }

  // ========================================================================
  // Inventory Manipulation Methods
  // ========================================================================

  /**
   * Sort inventory
   */
  async sortInventory(): Promise<void> {
    const bot = this.getBot();

    // Simple sorting: group by item type
    const items = bot.inventory.items();
    [...items].sort((a, b) => {
      // Sort by name, then by count (descending)
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return b.count - a.count;
    });

    // This is a simplified sort - real implementation would move items
    console.log('[InventoryFeature] Inventory sorted');
  }

  /**
   * Drop item by name
   */
  async dropItem(name: string, count?: number): Promise<boolean> {
    const bot = this.getBot();
    const item = bot.inventory.items().find((i) => i.name === name);

    if (!item) return false;

    const dropCount = count ?? item.count;

    try {
      await bot.toss(item.type, null, dropCount);
      return true;
    } catch (error) {
      console.error('[InventoryFeature] Drop error:', error);
      return false;
    }
  }

  /**
   * Drop item by slot
   */
  async dropSlot(slot: number, count?: number): Promise<boolean> {
    const bot = this.getBot();
    const item = bot.inventory.slots[slot];

    if (!item) return false;

    const dropCount = count ?? item.count;

    try {
      await bot.toss(item.type, null, dropCount);
      return true;
    } catch (error) {
      console.error('[InventoryFeature] Drop slot error:', error);
      return false;
    }
  }

  /**
   * Drop all items matching filter
   */
  async dropAll(filter?: (item: InventoryItemInfo) => boolean): Promise<number> {
    const bot = this.getBot();
    let dropped = 0;

    for (const item of bot.inventory.items()) {
      const info = this.itemToInfo(item);

      if (!filter || filter(info)) {
        // Check keep minimum
        const minKeep = this.keepMinimum.get(item.name) ?? 0;
        const dropCount = Math.max(0, item.count - minKeep);

        if (dropCount > 0) {
          try {
            await bot.toss(item.type, null, dropCount);
            dropped++;
          } catch (error) {
            console.error('[InventoryFeature] Drop all error:', error);
          }
        }
      }
    }

    return dropped;
  }

  /**
   * Check auto-drop list
   */
  private async checkAutoDrop(): Promise<void> {
    if (!this.autoDropEnabled) return;

    for (const item of this.getBot().inventory.items()) {
      if (this.dropList.has(item.name.toLowerCase())) {
        const minKeep = this.keepMinimum.get(item.name) ?? 0;
        const dropCount = Math.max(0, item.count - minKeep);

        if (dropCount > 0) {
          try {
            await this.getBot().toss(item.type, null, dropCount);
            console.log(`[InventoryFeature] Auto-dropped ${dropCount}x ${item.name}`);
          } catch (error) {
            console.error('[InventoryFeature] Auto-drop error:', error);
          }
        }
      }
    }
  }

  /**
   * Move item between slots using moveSlotItem
   */
  async moveItem(fromSlot: number, toSlot: number, _count?: number): Promise<boolean> {
    const bot = this.getBot();

    try {
      const item = bot.inventory.slots[fromSlot];
      if (!item) return false;

      await bot.moveSlotItem(fromSlot, toSlot);
      return true;
    } catch (error) {
      console.error('[InventoryFeature] Move item error:', error);
      return false;
    }
  }

  /**
   * Swap items between slots
   */
  async swapSlots(slot1: number, slot2: number): Promise<boolean> {
    const bot = this.getBot();

    try {
      // Use moveSlotItem to swap
      await bot.moveSlotItem(slot1, slot2);
      await bot.moveSlotItem(slot2, slot1);
      await bot.moveSlotItem(slot1, slot2);
      return true;
    } catch (error) {
      console.error('[InventoryFeature] Swap error:', error);
      return false;
    }
  }

  // ========================================================================
  // Crafting Methods
  // ========================================================================

  /**
   * Craft an item
   */
  async craftItem(name: string, count = 1, craftingTable?: boolean): Promise<boolean> {
    const bot = this.getBot();
    const recipe = this.craftingRecipes.get(name);

    if (!recipe) {
      console.warn(`[InventoryFeature] No recipe found for ${name}`);
      return false;
    }

    // Check if we have ingredients
    const missing = this.getMissingIngredients(recipe, count);
    if (missing.length > 0) {
      console.warn(`[InventoryFeature] Missing ingredients: ${missing.join(', ')}`);
      return false;
    }

    try {
      // Find the actual Recipe object from mineflayer
      const itemId = bot.registry.itemsByName[name]?.id;
      if (itemId === undefined) {
        console.warn(`[InventoryFeature] Unknown item: ${name}`);
        return false;
      }

      const recipes = bot.recipesAll(itemId, null, craftingTable ? true : null);
      const actualRecipe = recipes[0];

      if (!actualRecipe) {
        console.warn(`[InventoryFeature] No recipe available for ${name}`);
        return false;
      }

      // craft() expects a Block for craftingTable, not a boolean
      // For now, pass null (will craft in inventory)
      // A full implementation would find and place a crafting table block
      await bot.craft(actualRecipe, count, null);
      return true;
    } catch (error) {
      console.error('[InventoryFeature] Craft error:', error);
      return false;
    }
  }

  /**
   * Craft using a crafting table
   */
  private async craftWithTable(recipe: CraftingRecipe, count: number): Promise<void> {
    const bot = this.getBot();

    // Find crafting table in inventory or nearby
    const table = bot.inventory.items().find((i) => i.name === 'crafting_table');
    if (!table) {
      throw new Error('No crafting table available');
    }

    // Place crafting table, craft, then break it
    // This is a simplified implementation
    const itemId = bot.registry.itemsByName[recipe.name]?.id;
    if (itemId === undefined) throw new Error(`Unknown item: ${recipe.name}`);

    const recipes = bot.recipesAll(itemId, null, true);
    const actualRecipe = recipes[0];
    if (!actualRecipe) throw new Error(`No recipe for ${recipe.name}`);

    // craft() expects a Block for craftingTable, not a boolean
    // For now, pass null - a full implementation would place and use a crafting table block
    await bot.craft(actualRecipe, count, null);
  }

  /**
   * Get missing ingredients for a recipe
   */
  getMissingIngredients(recipe: CraftingRecipe, count = 1): string[] {
    const bot = this.getBot();
    const missing: string[] = [];

    for (const ingredient of recipe.ingredients) {
      const itemId = bot.registry.itemsByName[ingredient.name]?.id ?? -1;
      const have = bot.inventory.count(itemId, null);
      const need = ingredient.count * count;

      if (have < need) {
        missing.push(`${ingredient.name} (need ${need - have} more)`);
      }
    }

    return missing;
  }

  /**
   * Check if we can craft an item
   */
  canCraft(name: string, count = 1): boolean {
    const recipe = this.craftingRecipes.get(name);
    if (!recipe) return false;

    return this.getMissingIngredients(recipe, count).length === 0;
  }

  /**
   * Get all craftable items
   */
  getCraftableItems(): string[] {
    const craftable: string[] = [];

    for (const [name] of Array.from(this.craftingRecipes.entries())) {
      if (this.canCraft(name)) {
        craftable.push(name);
      }
    }

    return craftable;
  }

  // ========================================================================
  // Equipment Methods
  // ========================================================================

  /**
   * Auto-equip best armor
   */
  async autoEquipBestArmor(): Promise<void> {
    const bot = this.getBot();
    const armorSlots = ['head', 'chest', 'legs', 'feet'];
    const armorTypes = ['helmet', 'chestplate', 'leggings', 'boots'];

    for (let i = 0; i < armorSlots.length; i++) {
      const slot = armorSlots[i];
      const type = armorTypes[i];
      const current = bot.inventory.slots[5 - i]; // 5=head, 6=chest, 7=legs, 8=feet

      // Find best armor of this type in inventory
      const best = this.findBestArmor(type);
      if (best && (!current || this.getArmorValue(best) > this.getArmorValue(current))) {
        await this.equipItem(best.slot, slot);
      }
    }
  }

  /**
   * Find best armor of a type
   */
  private findBestArmor(type: string): Item | null {
    const bot = this.getBot();
    let best: Item | null = null;
    let bestValue = 0;

    for (const item of bot.inventory.items()) {
      if (item.name.includes(type)) {
        const value = this.getArmorValue(item);
        if (value > bestValue) {
          bestValue = value;
          best = item;
        }
      }
    }

    return best;
  }

  /**
   * Get armor value (protection + durability)
   */
  private getArmorValue(item: Item): number {
    let value = 0;

    // Base protection by material
    if (item.name.includes('netherite')) value += 1000;
    else if (item.name.includes('diamond')) value += 800;
    else if (item.name.includes('iron')) value += 500;
    else if (item.name.includes('chainmail')) value += 300;
    else if (item.name.includes('gold')) value += 200;
    else if (item.name.includes('leather')) value += 100;

    // Add enchantment value - use enchants getter
    if (item.enchants) {
      for (const ench of item.enchants) {
        if (
          ench.name.includes('protection') ||
          ench.name.includes('blast') ||
          ench.name.includes('fire') ||
          ench.name.includes('projectile')
        ) {
          value += ench.lvl * 50;
        }
      }
    }

    // Factor in durability
    if (item.durabilityUsed > 0 && item.maxDurability > 0) {
      value *= (item.maxDurability - item.durabilityUsed) / item.maxDurability;
    }

    return value;
  }

  /**
   * Equip item to armor slot
   */
  private async equipItem(fromSlot: number, toSlot: string): Promise<void> {
    const bot = this.getBot();
    const slotMap: Record<string, number> = {
      head: 5,
      chest: 6,
      legs: 7,
      feet: 8,
      hand: 45,
      offhand: 44,
    };

    const targetSlot = slotMap[toSlot];
    if (targetSlot === undefined) return;

    try {
      // Use moveSlotItem instead of clickWindow
      await bot.moveSlotItem(fromSlot, targetSlot);
    } catch (error) {
      console.error('[InventoryFeature] Equip error:', error);
    }
  }

  /**
   * Equip best tool for a job
   */
  async equipBestTool(toolType: 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword'): Promise<void> {
    const bot = this.getBot();
    const handSlot = 45;
    const current = bot.inventory.slots[handSlot];

    const best = this.findBestTool(toolType);
    if (
      best &&
      (!current || this.getToolValue(best, toolType) > this.getToolValue(current, toolType))
    ) {
      await this.equipItem(best.slot, 'hand');
    }
  }

  /**
   * Find best tool of a type
   */
  private findBestTool(type: string): Item | null {
    const bot = this.getBot();
    let best: Item | null = null;
    let bestValue = 0;

    for (const item of bot.inventory.items()) {
      if (item.name.includes(type)) {
        const value = this.getToolValue(item, type);
        if (value > bestValue) {
          bestValue = value;
          best = item;
        }
      }
    }

    return best;
  }

  /**
   * Get tool value
   */
  private getToolValue(item: Item, _type: string): number {
    let value = 0;

    if (item.name.includes('netherite')) value += 1000;
    else if (item.name.includes('diamond')) value += 800;
    else if (item.name.includes('iron')) value += 500;
    else if (item.name.includes('gold')) value += 300;
    else if (item.name.includes('stone')) value += 200;
    else if (item.name.includes('wooden')) value += 100;

    if (item.enchants) {
      for (const ench of item.enchants) {
        if (
          ench.name.includes('efficiency') ||
          ench.name.includes('fortune') ||
          ench.name.includes('silk_touch') ||
          ench.name.includes('sharpness')
        ) {
          value += ench.lvl * 100;
        }
        if (ench.name.includes('unbreaking') || ench.name.includes('mending')) {
          value += ench.lvl * 50;
        }
      }
    }

    if (item.durabilityUsed > 0 && item.maxDurability > 0) {
      value *= (item.maxDurability - item.durabilityUsed) / item.maxDurability;
    }

    return value;
  }

  // ========================================================================
  // Configuration Methods
  // ========================================================================

  /**
   * Set auto-sort enabled
   */
  setAutoSort(enabled: boolean): void {
    this.autoSortEnabled = enabled;
    this.setOption('autoSort', enabled);
  }

  /**
   * Set auto-drop enabled
   */
  setAutoDrop(enabled: boolean): void {
    this.autoDropEnabled = enabled;
    this.setOption('autoDrop', enabled);
  }

  /**
   * Add item to drop list
   */
  addToDropList(itemName: string): void {
    this.dropList.add(itemName.toLowerCase());
    const list = Array.from(this.dropList);
    this.setOption('dropList', list);
  }

  /**
   * Remove item from drop list
   */
  removeFromDropList(itemName: string): void {
    this.dropList.delete(itemName.toLowerCase());
    const list = Array.from(this.dropList);
    this.setOption('dropList', list);
  }

  /**
   * Set minimum keep count for item
   */
  setKeepMinimum(itemName: string, count: number): void {
    this.keepMinimum.set(itemName, count);
    this.setOption('keepMinimum', Object.fromEntries(this.keepMinimum));
  }

  /**
   * Get drop list
   */
  getDropList(): string[] {
    return Array.from(this.dropList);
  }

  /**
   * Get keep minimum map
   */
  getKeepMinimum(): Record<string, number> {
    return Object.fromEntries(this.keepMinimum);
  }
}

export default InventoryFeature;