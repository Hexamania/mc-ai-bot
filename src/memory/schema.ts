/**
 * Schema versioning and migration system for memory data
 */

import type {
  MemoryData,
  MigrationResult,
  ExtendedLocationInfo,
  ExtendedPlayerInfo,
  FactEntry,
  RuleEntry,
  ExtendedTaskInfo,
  MemoryMetadata,
} from './types';
import { CURRENT_SCHEMA_VERSION } from './types';
import { isFactEntry, isRuleEntry } from './types';

/**
 * Migration function type
 */
type MigrationFn = (data: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Migration registry
 */
const migrations = new Map<number, MigrationFn>();

/**
 * Register a migration function
 */
export function registerMigration(fromVersion: number, fn: MigrationFn): void {
  migrations.set(fromVersion, fn);
}

/**
 * Get all registered migration versions
 */
export function getMigrationVersions(): number[] {
  return Array.from(migrations.keys()).sort((a, b) => a - b);
}

/**
 * Migrate memory data from any version to current version
 */
export async function migrateMemory(data: Record<string, unknown>): Promise<{
  data: MemoryData;
  results: MigrationResult[];
}> {
  const results: MigrationResult[] = [];
  let currentData = { ...data };
  let fromVersion = typeof currentData.schemaVersion === 'number' ? currentData.schemaVersion : 1;

  // If already at current version, just normalize and return
  if (fromVersion >= CURRENT_SCHEMA_VERSION) {
    const normalized = normalizeToCurrentSchema(currentData);
    return { data: normalized, results };
  }

  // Apply migrations sequentially
  const versions = getMigrationVersions().filter(
    (v) => v > fromVersion && v <= CURRENT_SCHEMA_VERSION
  );

  for (const version of versions) {
    const migration = migrations.get(version);
    if (!migration) {
      console.warn(`[MEMORY-SCHEMA] No migration function for version ${version}`);
      continue;
    }

    const startTime = Date.now();
    const startVersion = fromVersion;

    try {
      console.log(`[MEMORY-SCHEMA] Migrating from v${fromVersion} to v${version}`);
      currentData = await migration(currentData);
      fromVersion = version;

      results.push({
        fromVersion: startVersion,
        toVersion: version,
        success: true,
        changes: [`Applied migration to v${version}`],
        duration: Date.now() - startTime,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `[MEMORY-SCHEMA] Migration from v${startVersion} to v${version} failed:`,
        errorMessage
      );

      results.push({
        fromVersion: startVersion,
        toVersion: version,
        success: false,
        changes: [],
        duration: Date.now() - startTime,
        error: errorMessage,
      });

      // Stop migration chain on failure
      break;
    }
  }

  // Normalize to current schema
  const normalized = normalizeToCurrentSchema(currentData);

  return { data: normalized, results };
}

/**
 * Normalize data to current schema structure
 */
function normalizeToCurrentSchema(data: Record<string, unknown>): MemoryData {
  const now = new Date().toISOString();

  // Ensure all required fields exist
  const locations: Record<string, ExtendedLocationInfo> = {};
  if (data.locations && typeof data.locations === 'object' && !Array.isArray(data.locations)) {
    const locs = data.locations as Record<string, unknown>;
    for (const [key, loc] of Object.entries(locs)) {
      if (isValidLocation(loc)) {
        locations[key] = normalizeLocation(key, loc);
      }
    }
  }

  const players: Record<string, ExtendedPlayerInfo> = {};
  if (data.players && typeof data.players === 'object' && !Array.isArray(data.players)) {
    const plrs = data.players as Record<string, unknown>;
    for (const [key, player] of Object.entries(plrs)) {
      if (isValidPlayer(player)) {
        players[key] = normalizePlayer(key, player);
      }
    }
  }

  let currentTask: ExtendedTaskInfo | null = null;
  if (data.currentTask && typeof data.currentTask === 'object' && !Array.isArray(data.currentTask)) {
    currentTask = normalizeTask(data.currentTask as Record<string, unknown>);
  }

  const rules: RuleEntry[] = [];
  if (Array.isArray(data.rules)) {
    for (const rule of data.rules) {
      if (typeof rule === 'string') {
        rules.push(normalizeRule(rule));
      } else if (isRuleEntry(rule)) {
        rules.push(rule);
      }
    }
  }

  const learnedFacts: Record<string, FactEntry> = {};
  if (data.learnedFacts && typeof data.learnedFacts === 'object' && !Array.isArray(data.learnedFacts)) {
    const facts = data.learnedFacts as Record<string, unknown>;
    for (const [key, fact] of Object.entries(facts)) {
      if (typeof fact === 'string') {
        learnedFacts[key] = normalizeFact(key, fact);
      } else if (isFactEntry(fact)) {
        learnedFacts[key] = fact;
      }
    }
  }

  // Build metadata
  const metadata: MemoryMetadata =
    data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
      ? normalizeMetadata(data.metadata as Record<string, unknown>, now)
      : createDefaultMetadata(now);

  // Update stats
  metadata.stats = {
    totalLocations: Object.keys(locations).length,
    totalPlayers: Object.keys(players).length,
    totalFacts: Object.keys(learnedFacts).length,
    totalRules: rules.length,
    totalTasks: currentTask ? 1 : 0,
    lastCleanupAt: metadata.stats.lastCleanupAt,
    lastBackupAt: metadata.stats.lastBackupAt,
  };

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    locations,
    players,
    currentTask,
    rules,
    learnedFacts,
    metadata,
  };
}

/**
 * Create default metadata
 */
function createDefaultMetadata(now: string): MemoryMetadata {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    migrationHistory: [],
    stats: {
      totalLocations: 0,
      totalPlayers: 0,
      totalFacts: 0,
      totalRules: 0,
      totalTasks: 0,
    },
  };
}

/**
 * Normalize metadata
 */
function normalizeMetadata(data: Record<string, unknown>, now: string): MemoryMetadata {
  const defaultMeta = createDefaultMetadata(now);

  let stats = defaultMeta.stats;
  if (data.stats && typeof data.stats === 'object' && !Array.isArray(data.stats)) {
    const s = data.stats as Record<string, unknown>;
    stats = {
      totalLocations: typeof s.totalLocations === 'number' ? s.totalLocations : 0,
      totalPlayers: typeof s.totalPlayers === 'number' ? s.totalPlayers : 0,
      totalFacts: typeof s.totalFacts === 'number' ? s.totalFacts : 0,
      totalRules: typeof s.totalRules === 'number' ? s.totalRules : 0,
      totalTasks: typeof s.totalTasks === 'number' ? s.totalTasks : 0,
      lastCleanupAt: typeof s.lastCleanupAt === 'string' ? s.lastCleanupAt : undefined,
      lastBackupAt: typeof s.lastBackupAt === 'string' ? s.lastBackupAt : undefined,
    };
  }

  return {
    schemaVersion:
      typeof data.schemaVersion === 'number' ? data.schemaVersion : CURRENT_SCHEMA_VERSION,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : now,
    updatedAt: now,
    migrationHistory: Array.isArray(data.migrationHistory)
      ? (data.migrationHistory as MemoryMetadata['migrationHistory'])
      : [],
    stats,
  };
}

/**
 * Validate location object
 */
function isValidLocation(loc: unknown): loc is ExtendedLocationInfo {
  return (
    typeof loc === 'object' &&
    loc !== null &&
    typeof (loc as ExtendedLocationInfo).x === 'number' &&
    typeof (loc as ExtendedLocationInfo).y === 'number' &&
    typeof (loc as ExtendedLocationInfo).z === 'number'
  );
}

/**
 * Normalize location
 */
function normalizeLocation(key: string, loc: ExtendedLocationInfo): ExtendedLocationInfo {
  const now = new Date().toISOString();
  return {
    x: loc.x,
    y: loc.y,
    z: loc.z,
    type: typeof loc.type === 'string' ? loc.type : 'waypoint',
    description: typeof loc.description === 'string' ? loc.description : undefined,
    dimension: typeof loc.dimension === 'string' ? loc.dimension : 'overworld',
    tags: Array.isArray(loc.tags) ? loc.tags.filter((t) => typeof t === 'string') : [],
    visitCount: typeof loc.visitCount === 'number' ? loc.visitCount : 0,
    lastVisitedAt: typeof loc.lastVisitedAt === 'string' ? loc.lastVisitedAt : undefined,
    updatedAt: typeof loc.updatedAt === 'string' ? loc.updatedAt : now,
  };
}

/**
 * Validate player object
 */
function isValidPlayer(player: unknown): player is ExtendedPlayerInfo {
  return (
    typeof player === 'object' &&
    player !== null &&
    typeof (player as ExtendedPlayerInfo).username === 'string'
  );
}

/**
 * Normalize player
 */
function normalizePlayer(key: string, player: ExtendedPlayerInfo): ExtendedPlayerInfo {
  const now = new Date().toISOString();
  return {
    username: player.username,
    role: ['guest', 'trusted', 'admin'].includes(player.role) ? player.role : 'guest',
    preferences:
      player.preferences && typeof player.preferences === 'object' ? player.preferences : {},
    displayName: typeof player.displayName === 'string' ? player.displayName : undefined,
    notes: typeof player.notes === 'string' ? player.notes : undefined,
    totalInteractions: typeof player.totalInteractions === 'number' ? player.totalInteractions : 0,
    reputation: typeof player.reputation === 'number' ? player.reputation : 0,
    firstSeen: typeof player.firstSeen === 'string' ? player.firstSeen : now,
    lastSeen: typeof player.lastSeen === 'string' ? player.lastSeen : now,
    trustedAt: typeof player.trustedAt === 'string' ? player.trustedAt : undefined,
  };
}

/**
 * Normalize task
 */
function normalizeTask(task: Record<string, unknown>): ExtendedTaskInfo | null {
  if (typeof task.goal !== 'string' || typeof task.status !== 'string') {
    return null;
  }

  const validStatuses = ['active', 'completed', 'stopped', 'failed'] as const;
  const status = validStatuses.includes(task.status as (typeof validStatuses)[0])
    ? (task.status as ExtendedTaskInfo['status'])
    : 'active';

  const now = new Date().toISOString();
  return {
    goal: task.goal,
    status,
    progress: typeof task.progress === 'number' ? task.progress : null,
    priority: ['low', 'medium', 'high', 'critical'].includes(task.priority as string)
      ? (task.priority as ExtendedTaskInfo['priority'])
      : 'medium',
    tags: Array.isArray(task.tags) ? task.tags.filter((t) => typeof t === 'string') : [],
    startedAt: typeof task.startedAt === 'string' ? task.startedAt : now,
    completedAt: typeof task.completedAt === 'string' ? task.completedAt : undefined,
    updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : now,
    metadata: task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata)
      ? (task.metadata as Record<string, unknown>)
      : undefined,
  };
}

/**
 * Normalize fact
 */
function normalizeFact(key: string, value: string): FactEntry {
  const now = new Date().toISOString();
  return {
    key,
    value: value.slice(0, 500),
    category: 'general',
    confidence: 1.0,
    source: 'user',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    lastAccessedAt: now,
  };
}

/**
 * Normalize rule
 */
function normalizeRule(rule: string): RuleEntry {
  const now = new Date().toISOString();
  return {
    id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    rule: rule.slice(0, 300),
    category: 'general',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    author: 'system',
  };
}

/**
 * ============================================
 * Built-in Migrations
 * ============================================
 */

// Migration v1 -> v2: Add metadata, convert rules/facts to objects, add extended fields
registerMigration(2, async (data: Record<string, unknown>) => {
  const now = new Date().toISOString();

  // Convert rules array from strings to RuleEntry objects
  if (Array.isArray(data.rules)) {
    data.rules = data.rules.map((rule, index) => {
      if (typeof rule === 'string') {
        return {
          id: `rule_migrated_${index}_${Date.now()}`,
          rule: rule.slice(0, 300),
          category: 'general',
          enabled: true,
          createdAt: now,
          updatedAt: now,
          author: 'migration',
        };
      }
      return rule;
    });
  }

  // Convert learnedFacts from simple strings to FactEntry objects
  if (data.learnedFacts && typeof data.learnedFacts === 'object' && !Array.isArray(data.learnedFacts)) {
    const newFacts: Record<string, FactEntry> = {};
    const oldFacts = data.learnedFacts as Record<string, unknown>;
    for (const [key, fact] of Object.entries(oldFacts)) {
      if (typeof fact === 'string') {
        newFacts[key] = {
          key,
          value: fact.slice(0, 500),
          category: 'general',
          confidence: 1.0,
          source: 'legacy',
          createdAt: now,
          updatedAt: now,
          accessCount: 0,
          lastAccessedAt: now,
        };
      } else {
        newFacts[key] = fact as FactEntry;
      }
    }
    data.learnedFacts = newFacts;
  }

  // Add metadata if missing
  if (!data.metadata) {
    data.metadata = createDefaultMetadata(now);
  } else if (typeof data.metadata === 'object' && data.metadata !== null && !Array.isArray(data.metadata)) {
    const meta = data.metadata as Record<string, unknown>;
    meta.updatedAt = now;
    if (!meta.migrationHistory) meta.migrationHistory = [];
    (meta.migrationHistory as unknown[]).push({
      fromVersion: 1,
      toVersion: 2,
      migratedAt: now,
      success: true,
      notes: 'Migrated to v2: added metadata, converted rules/facts to objects',
    });
  }

  // Add extended fields to locations
  if (data.locations && typeof data.locations === 'object' && !Array.isArray(data.locations)) {
    for (const loc of Object.values(data.locations as Record<string, unknown>)) {
      if (loc && typeof loc === 'object' && !Array.isArray(loc)) {
        const l = loc as Record<string, unknown>;
        if (!l.dimension) l.dimension = 'overworld';
        if (!l.tags) l.tags = [];
        if (!l.visitCount) l.visitCount = 0;
        if (!l.updatedAt) l.updatedAt = now;
      }
    }
  }

  // Add extended fields to players
  if (data.players && typeof data.players === 'object' && !Array.isArray(data.players)) {
    for (const player of Object.values(data.players as Record<string, unknown>)) {
      if (player && typeof player === 'object' && !Array.isArray(player)) {
        const p = player as Record<string, unknown>;
        if (!p.preferences) p.preferences = {};
        if (!p.totalInteractions) p.totalInteractions = 0;
        if (!p.reputation) p.reputation = 0;
      }
    }
  }

  // Add extended fields to currentTask
  if (data.currentTask && typeof data.currentTask === 'object' && !Array.isArray(data.currentTask)) {
    const task = data.currentTask as Record<string, unknown>;
    if (!task.priority) task.priority = 'medium';
    if (!task.tags) task.tags = [];
    if (!task.startedAt) task.startedAt = now;
    if (!task.updatedAt) task.updatedAt = now;
  }

  data.schemaVersion = 2;
  return data;
});

/**
 * Validate memory data structure
 */
export function validateMemoryData(data: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    errors.push('Memory data must be an object');
    return { valid: false, errors };
  }

  const d = data as Record<string, unknown>;

  if (typeof d.schemaVersion !== 'number') {
    errors.push('schemaVersion must be a number');
  }

  if (d.locations && typeof d.locations !== 'object') {
    errors.push('locations must be an object');
  }

  if (d.players && typeof d.players !== 'object') {
    errors.push('players must be an object');
  }

  if (d.rules && !Array.isArray(d.rules)) {
    errors.push('rules must be an array');
  }

  if (d.learnedFacts && typeof d.learnedFacts !== 'object') {
    errors.push('learnedFacts must be an object');
  }

  return { valid: errors.length === 0, errors };
}