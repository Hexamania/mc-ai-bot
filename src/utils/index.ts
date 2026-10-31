/**
 * Utility functions for mc-ai-bot
 */

import type { Bot } from 'mineflayer';
import type { Vec3 } from 'vec3';
import type { BotPosition } from '../types';

/**
 * Sleep/delay utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelay = 1000,
  maxDelay = 30000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxAttempts) break;

      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Format a number with commas
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Format time in milliseconds to human readable string
 */
export function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Calculate distance between two positions
 */
export function distance(pos1: BotPosition, pos2: BotPosition): number {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  const dz = pos1.z - pos2.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Calculate 2D distance (ignoring Y)
 */
export function distance2D(pos1: BotPosition, pos2: BotPosition): number {
  const dx = pos1.x - pos2.x;
  const dz = pos1.z - pos2.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Clamp a value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Linear interpolation
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Check if a position is within bounds
 */
export function inBounds(pos: BotPosition, min: BotPosition, max: BotPosition): boolean {
  return (
    pos.x >= min.x &&
    pos.x <= max.x &&
    pos.y >= min.y &&
    pos.y <= max.y &&
    pos.z >= min.z &&
    pos.z <= max.z
  );
}

/**
 * Get the best tool for a block
 */
export function getBestToolForBlock(bot: Bot, blockName: string): unknown | null {
  const pickaxes = [
    'netherite_pickaxe',
    'diamond_pickaxe',
    'iron_pickaxe',
    'stone_pickaxe',
    'wooden_pickaxe',
  ];

  let minTier = 0;
  const name = blockName;

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

  return bestPick || null;
}

/**
 * Find the best item of a category
 */
export function findBestItem(bot: Bot, category: 'weapon' | 'shield'): unknown | null {
  const items = bot.inventory.items();
  let bestItem: unknown = null;
  let bestTier = -1;

  const weaponTiers: Record<string, number> = {
    netherite_sword: 5,
    diamond_sword: 4,
    iron_sword: 3,
    golden_sword: 2,
    stone_sword: 1,
    wooden_sword: 0,
    netherite_axe: 4.5,
    diamond_axe: 3.5,
    iron_axe: 2.5,
    golden_axe: 1.5,
    stone_axe: 0.5,
    wooden_axe: 0,
  };

  for (const item of items) {
    const itemName = item.name;

    if (category === 'weapon') {
      const itemTier = weaponTiers[itemName];
      if (itemTier !== undefined && itemTier > bestTier) {
        bestTier = itemTier;
        bestItem = item;
      }
    } else if (category === 'shield' && itemName === 'shield') {
      return item;
    }
  }

  return bestItem;
}

/**
 * Auto-equip best armor
 */
export function autoArmor(bot: Bot): void {
  const registry = bot.registry;
  const armorSlots = {
    head: [
      registry.itemsByName.diamond_helmet?.id,
      registry.itemsByName.iron_helmet?.id,
      registry.itemsByName.golden_helmet?.id,
      registry.itemsByName.chainmail_helmet?.id,
      registry.itemsByName.leather_helmet?.id,
    ].filter(Boolean),
    torso: [
      registry.itemsByName.diamond_chestplate?.id,
      registry.itemsByName.iron_chestplate?.id,
      registry.itemsByName.golden_chestplate?.id,
      registry.itemsByName.chainmail_chestplate?.id,
      registry.itemsByName.leather_chestplate?.id,
    ].filter(Boolean),
    legs: [
      registry.itemsByName.diamond_leggings?.id,
      registry.itemsByName.iron_leggings?.id,
      registry.itemsByName.golden_leggings?.id,
      registry.itemsByName.chainmail_leggings?.id,
      registry.itemsByName.leather_leggings?.id,
    ].filter(Boolean),
    feet: [
      registry.itemsByName.diamond_boots?.id,
      registry.itemsByName.iron_boots?.id,
      registry.itemsByName.golden_boots?.id,
      registry.itemsByName.chainmail_boots?.id,
      registry.itemsByName.leather_boots?.id,
    ].filter(Boolean),
  };

  for (const [slot, ids] of Object.entries(armorSlots)) {
    const items = bot.inventory.items().filter((i) => ids.includes(i.type));
    if (items.length === 0) continue;

    items.sort((a, b) => ids.indexOf(a.type) - ids.indexOf(b.type));
    const best = items[0];

    const current = bot.inventory.slots[bot.getEquipmentDestSlot(slot)];
    if (!current || current.type !== best.type) {
      void bot.equip(best, slot).catch(() => undefined);
    }
  }
}

/**
 * Eat the best available food
 */
export async function forceEat(bot: Bot): Promise<boolean> {
  const foodItems = [
    'golden_apple',
    'enchanted_golden_apple',
    'cooked_beef',
    'cooked_porkchop',
    'cooked_chicken',
    'cooked_mutton',
    'cooked_salmon',
    'cooked_cod',
    'bread',
    'apple',
    'baked_potato',
  ];

  const inventory = bot.inventory.items();
  const food = foodItems.map((name) => inventory.find((item) => item.name === name)).find(Boolean);

  if (food) {
    try {
      await bot.equip(food, 'hand');
      await bot.consume();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Check if bot can see a position (raycast)
 */
export function canSeePosition(bot: Bot, from: Vec3, to: Vec3): boolean {
  const direction = to.minus(from).normalize();
  const distance = from.distanceTo(to);

  for (let d = 0; d < distance; d += 0.5) {
    const checkPos = from.plus(direction.scaled(d));
    const block = bot.blockAt(checkPos);
    if (block && block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
      return false;
    }
  }
  return true;
}

/**
 * Get nearby entities of a specific type
 */
export function getNearbyEntities(
  bot: Bot,
  type: string,
  maxDistance: number,
  filter?: (entity: unknown) => boolean
): unknown[] {
  return Object.values(bot.entities)
    .filter((e) => e.name === type && e.position.distanceTo(bot.entity.position) < maxDistance)
    .filter(filter || (() => true));
}

/**
 * Get the nearest entity matching a filter
 */
export function getNearestEntity(
  bot: Bot,
  filter: (entity: unknown) => boolean,
  maxDistance = 64
): unknown | null {
  let nearest: unknown = null;
  let nearestDist = maxDistance;

  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity) continue;
    const dist = entity.position.distanceTo(bot.entity.position);
    if (dist < nearestDist && filter(entity)) {
      nearest = entity;
      nearestDist = dist;
    }
  }

  return nearest;
}

/**
 * Safe pathfinder goto with timeout
 */
export async function safeGoto(bot: Bot, goal: unknown, timeout = 30000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bot.pathfinder.setGoal(null);
      resolve(false);
    }, timeout);

    bot.pathfinder.setGoal(goal);

    const onGoalReached = () => {
      clearTimeout(timer);
      bot.removeListener('goal_reached', onGoalReached);
      resolve(true);
    };

    bot.once('goal_reached', onGoalReached);
  });
}

/**
 * Parse coordinates from string
 */
export function parseCoordinates(str: string): BotPosition | null {
  const parts = str.split(/[ ,]+/).map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return { x: parts[0], y: parts[1], z: parts[2] };
}

/**
 * Format position for display
 */
export function formatPosition(pos: BotPosition): string {
  return `X: ${Math.floor(pos.x)}, Y: ${Math.floor(pos.y)}, Z: ${Math.floor(pos.z)}`;
}

/**
 * Chunk coordinates from block coordinates
 */
export function blockToChunk(pos: BotPosition): { x: number; z: number } {
  return {
    x: Math.floor(pos.x / 16),
    z: Math.floor(pos.z / 16),
  };
}

/**
 * Chunk coordinates to block coordinates (center of chunk)
 */
export function chunkToBlock(chunkX: number, chunkZ: number, y = 64): BotPosition {
  return {
    x: chunkX * 16 + 8,
    y,
    z: chunkZ * 16 + 8,
  };
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Throttle function
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;

  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Generate a random ID
 */
export function generateId(prefix = ''): string {
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Safe JSON parse
 */
export function safeJsonParse<T>(str: string, fallback: T): T {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Get item count in inventory
 */
export function getItemCount(bot: Bot, itemName: string): number {
  const item = bot.registry.itemsByName[itemName];
  return item ? bot.inventory.count(item.id) : 0;
}

/**
 * Check if inventory has space
 */
export function hasInventorySpace(bot: Bot, slots = 1): boolean {
  return bot.inventory.emptySlotCount() >= slots;
}

/**
 * Get all items of a type in inventory
 */
export function getItemsByType(bot: Bot, type: number): unknown[] {
  return bot.inventory.slots.filter((slot) => slot && slot.type === type).map((slot) => slot!);
}
