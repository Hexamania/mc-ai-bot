/**
 * Memory system for mc-ai-bot
 * Handles persistent storage of locations, players, tasks, rules, and learned facts
 */

import * as fs from 'node:fs';
import type { BaseMemoryData as MemoryData, LocationInfo, PlayerInfo, TaskInfo } from './types';
import { getConfig } from '../config';

const DEFAULT_MEMORY: MemoryData = {
  schemaVersion: 1,
  locations: {},
  players: {},
  currentTask: null,
  rules: [],
  learnedFacts: {},
};

let memoryCache: MemoryData | null = null;
let saveTimer: NodeJS.Timeout | null = null;

/**
 * Check if a value is a plain object (not null, not array)
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize memory data to ensure all required fields exist
 */
function normalizeMemory(value: unknown): MemoryData {
  if (!isRecord(value)) return { ...DEFAULT_MEMORY };

  const locations: Record<string, LocationInfo> = {};
  if (isRecord(value.locations)) {
    for (const [key, loc] of Object.entries(value.locations)) {
      if (
        isRecord(loc) &&
        typeof loc.x === 'number' &&
        typeof loc.y === 'number' &&
        typeof loc.z === 'number'
      ) {
        locations[key] = {
          x: loc.x,
          y: loc.y,
          z: loc.z,
          type: typeof loc.type === 'string' ? loc.type : 'waypoint',
          updatedAt: typeof loc.updatedAt === 'string' ? loc.updatedAt : new Date().toISOString(),
        };
      }
    }
  }

  const players: Record<string, PlayerInfo> = {};
  if (isRecord(value.players)) {
    for (const [key, player] of Object.entries(value.players)) {
      if (isRecord(player) && typeof player.username === 'string') {
        players[key] = {
          username: player.username,
          role: (player.role as PlayerInfo['role']) || 'guest',
          preferences: isRecord(player.preferences) ? player.preferences : {},
          firstSeen:
            typeof player.firstSeen === 'string' ? player.firstSeen : new Date().toISOString(),
          lastSeen:
            typeof player.lastSeen === 'string' ? player.lastSeen : new Date().toISOString(),
        };
      }
    }
  }

  let currentTask: TaskInfo | null = null;
  if (isRecord(value.currentTask)) {
    const task = value.currentTask;
    if (typeof task.goal === 'string' && typeof task.status === 'string') {
      currentTask = {
        goal: task.goal,
        status: task.status as TaskInfo['status'],
        progress: typeof task.progress === 'number' ? task.progress : null,
        updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : new Date().toISOString(),
      };
    }
  }

  const rules: string[] = Array.isArray(value.rules)
    ? value.rules.filter((rule) => typeof rule === 'string').slice(0, 100)
    : [];

  const learnedFacts: Record<string, string> = {};
  if (isRecord(value.learnedFacts)) {
    for (const [key, fact] of Object.entries(value.learnedFacts)) {
      if (typeof fact === 'string') {
        learnedFacts[key] = fact.slice(0, 500);
      }
    }
  }

  return {
    schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : 1,
    locations,
    players,
    currentTask,
    rules,
    learnedFacts,
  };
}

/**
 * Load memory from disk
 */
export function loadMemory(filePath?: string): MemoryData {
  const config = getConfig();
  if (!config.memory.enabled) {
    return { ...DEFAULT_MEMORY };
  }

  const targetPath = filePath || config.memory.filePath;

  try {
    if (!fs.existsSync(targetPath)) {
      return { ...DEFAULT_MEMORY };
    }

    const content = fs.readFileSync(targetPath, 'utf8');
    const parsed = JSON.parse(content);
    memoryCache = normalizeMemory(parsed);
    return memoryCache;
  } catch (error) {
    console.error(
      `[MEMORY] Could not load memory file: ${error instanceof Error ? error.message : String(error)}`
    );
    return { ...DEFAULT_MEMORY };
  }
}

/**
 * Save memory to disk atomically
 */
export function saveMemory(data: MemoryData, filePath?: string): boolean {
  const config = getConfig();
  if (!config.memory.enabled) {
    return false;
  }

  if (!isRecord(data)) {
    throw new TypeError('Memory data must be an object');
  }

  const targetPath = filePath || config.memory.filePath;
  const normalized = normalizeMemory(data);
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, targetPath);
    return true;
  } catch (error) {
    try {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
    } catch (cleanupError) {
      console.error(
        `[MEMORY] Could not remove temporary memory file: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
      );
    }
    throw error;
  }
}

/**
 * Get the current memory cache (loads if not loaded)
 */
export function getMemory(): MemoryData {
  if (!memoryCache) {
    memoryCache = loadMemory();
  }
  return memoryCache;
}

/**
 * Queue a memory save (debounced)
 */
export function queueMemorySave(): void {
  const config = getConfig();
  if (!config.memory.enabled) return;

  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    try {
      saveMemory(memoryCache!);
    } catch (error) {
      console.error(
        `[MEMORY] Could not save memory: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, 1000);
}

/**
 * Force save memory immediately
 */
export function persistMemory(): boolean {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return saveMemory(getMemory());
}

/**
 * Remember a location
 */
export function rememberLocation(
  name: string,
  position: { x: number; y: number; z: number },
  type = 'waypoint'
): boolean {
  const config = getConfig();
  if (!config.memory.enabled || !name || !position) return false;

  const coordinates = {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };

  if (!Object.values(coordinates).every(Number.isFinite)) return false;

  const memory = getMemory();
  const existing = memory.locations[name];

  if (
    existing &&
    existing.x === coordinates.x &&
    existing.y === coordinates.y &&
    existing.z === coordinates.z &&
    existing.type === type
  ) {
    return true;
  }

  memory.locations[name] = {
    ...coordinates,
    type,
    updatedAt: new Date().toISOString(),
  };

  return persistMemory();
}

/**
 * Remember a player
 */
export function rememberPlayer(username: string, role: PlayerInfo['role'] = 'guest'): void {
  const config = getConfig();
  if (!config.memory.enabled || !username) return;

  const memory = getMemory();
  const existing = memory.players[username];
  const now = new Date().toISOString();

  memory.players[username] = {
    ...(existing || {}),
    username,
    role,
    preferences:
      existing?.preferences && isRecord(existing.preferences) ? existing.preferences : {},
    firstSeen: existing?.firstSeen || now,
    lastSeen: now,
  };

  if (!existing || existing.role !== role) {
    persistMemory();
  } else {
    queueMemorySave();
  }
}

/**
 * Remember a fact
 */
export function rememberFact(key: string, fact: string): boolean {
  const config = getConfig();
  if (!config.memory.enabled) return false;

  const cleanKey = String(key || '')
    .trim()
    .slice(0, 80);
  const cleanFact = String(fact || '')
    .trim()
    .slice(0, 500);

  if (!cleanKey || !cleanFact) return false;

  const memory = getMemory();
  memory.learnedFacts[cleanKey] = cleanFact;
  return persistMemory();
}

/**
 * Forget a fact
 */
export function forgetFact(key: string): boolean {
  const config = getConfig();
  if (!config.memory.enabled) return false;

  const cleanKey = String(key || '').trim();
  if (!cleanKey) return false;

  const memory = getMemory();
  if (!Object.hasOwn(memory.learnedFacts, cleanKey)) return false;

  delete memory.learnedFacts[cleanKey];
  return persistMemory();
}

/**
 * Remember current task
 */
export function rememberTask(
  goal: string,
  status: TaskInfo['status'] = 'active',
  progress: number | null = null
): boolean {
  const config = getConfig();
  if (!config.memory.enabled) return false;

  const memory = getMemory();
  memory.currentTask = {
    goal,
    status,
    progress,
    updatedAt: new Date().toISOString(),
  };

  queueMemorySave();
  return true;
}

/**
 * Get memory context for AI
 */
export function getMemoryContext(): string {
  const config = getConfig();
  if (!config.memory.enabled) {
    return 'Persistent memory is disabled.';
  }

  const memory = getMemory();
  const context = {
    locations: Object.fromEntries(Object.entries(memory.locations).slice(-30)),
    rules: memory.rules.slice(-30).map((rule: string) => rule.slice(0, 300)),
    currentTask: memory.currentTask,
    learnedFacts: Object.fromEntries(Object.entries(memory.learnedFacts).slice(-50)),
  };

  return JSON.stringify(context, null, 2).slice(0, 6000);
}

/**
 * Add a rule to memory
 */
export function addRule(rule: string): boolean {
  const config = getConfig();
  if (!config.memory.enabled) return false;

  const cleanRule = String(rule || '')
    .trim()
    .slice(0, 300);
  if (!cleanRule) return false;

  const memory = getMemory();
  if (!memory.rules.includes(cleanRule)) {
    memory.rules.push(cleanRule);
    queueMemorySave();
  }
  return true;
}

/**
 * Remove a rule from memory
 */
export function removeRule(rule: string): boolean {
  const config = getConfig();
  if (!config.memory.enabled) return false;

  const memory = getMemory();
  const index = memory.rules.indexOf(rule);
  if (index === -1) return false;

  memory.rules.splice(index, 1);
  queueMemorySave();
  return true;
}

/**
 * Get all rules
 */
export function getRules(): string[] {
  return getMemory().rules;
}

/**
 * Get all locations
 */
export function getLocations(): Record<string, LocationInfo> {
  return getMemory().locations;
}

/**
 * Get all players
 */
export function getPlayers(): Record<string, PlayerInfo> {
  return getMemory().players;
}

/**
 * Get current task
 */
export function getCurrentTask(): TaskInfo | null {
  return getMemory().currentTask;
}

/**
 * Get all learned facts
 */
export function getFacts(): Record<string, string> {
  return getMemory().learnedFacts;
}

/**
 * Stop current remembered task
 */
export function stopRememberedTask(): boolean {
  const config = getConfig();
  if (!config.memory.enabled) return false;

  const memory = getMemory();
  if (memory.currentTask) {
    memory.currentTask = {
      ...memory.currentTask,
      status: 'stopped',
      updatedAt: new Date().toISOString(),
    };
    return persistMemory();
  }
  return true;
}

/**
 * Clear all memory
 */
export function clearMemory(): boolean {
  const config = getConfig();
  if (!config.memory.enabled) return false;

  memoryCache = { ...DEFAULT_MEMORY };
  return persistMemory();
}
