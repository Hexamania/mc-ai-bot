/**
 * Extended type definitions for the enhanced memory system
 */

import type { LocationInfo, PlayerInfo, TaskInfo, MemoryData as BaseMemoryData } from '../types';

/**
 * Memory schema version - increment when making breaking changes
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Extended LocationInfo with additional metadata
 */
export interface ExtendedLocationInfo extends LocationInfo {
  description?: string;
  dimension?: string;
  tags?: string[];
  visitCount?: number;
  lastVisitedAt?: string;
}

/**
 * Extended PlayerInfo with additional metadata
 */
export interface ExtendedPlayerInfo extends PlayerInfo {
  displayName?: string;
  notes?: string;
  totalInteractions?: number;
  reputation?: number;
  trustedAt?: string;
}

/**
 * Extended TaskInfo with additional metadata
 */
export interface ExtendedTaskInfo extends TaskInfo {
  priority?: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Fact entry with metadata
 */
export interface FactEntry {
  key: string;
  value: string;
  category?: string;
  confidence?: number; // 0-1
  source?: string;
  createdAt: string;
  updatedAt: string;
  accessCount?: number;
  lastAccessedAt?: string;
}

/**
 * Rule entry with metadata
 */
export interface RuleEntry {
  id: string;
  rule: string;
  category?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  author?: string;
}

/**
 * Memory metadata for tracking and migrations
 */
export interface MemoryMetadata {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  migratedFrom?: number;
  migrationHistory: {
    fromVersion: number;
    toVersion: number;
    migratedAt: string;
    success: boolean;
    notes?: string;
  }[];
  stats: {
    totalLocations: number;
    totalPlayers: number;
    totalFacts: number;
    totalRules: number;
    totalTasks: number;
    lastCleanupAt?: string;
    lastBackupAt?: string;
  };
}

/**
 * Complete enhanced memory data structure
 */
export interface MemoryData extends BaseMemoryData {
  schemaVersion: number;
  locations: Record<string, ExtendedLocationInfo>;
  players: Record<string, ExtendedPlayerInfo>;
  currentTask: ExtendedTaskInfo | null;
  rules: RuleEntry[];
  learnedFacts: Record<string, FactEntry>;
  metadata: MemoryMetadata;
}

/**
 * Query options for finding/filtering memory entries
 */
export interface QueryOptions<T> {
  filter?: (item: T) => boolean;
  sort?: (a: T, b: T) => number;
  limit?: number;
  offset?: number;
  fields?: (keyof T)[];
}

/**
 * Search options for text-based search
 */
export interface SearchOptions {
  query: string;
  fields?: string[];
  caseSensitive?: boolean;
  fuzzy?: boolean;
  limit?: number;
}

/**
 * Cleanup options
 */
export interface CleanupOptions {
  maxAge?: number; // ms
  maxEntries?: number;
  dryRun?: boolean;
  categories?: string[];
}

/**
 * Backup metadata
 */
export interface BackupMetadata {
  id: string;
  createdAt: string;
  schemaVersion: number;
  size: number; // bytes
  entryCounts: {
    locations: number;
    players: number;
    facts: number;
    rules: number;
    tasks: number;
  };
  description?: string;
  tags?: string[];
}

/**
 * Restore options
 */
export interface RestoreOptions {
  backupId: string;
  merge?: boolean; // true = merge with existing, false = replace
  categories?: ('locations' | 'players' | 'facts' | 'rules' | 'tasks' | 'metadata')[];
}

/**
 * Memory event types for integration with bot events
 */
export interface MemoryEventMap {
  'memory:location:added': [string, ExtendedLocationInfo];
  'memory:location:updated': [string, ExtendedLocationInfo, ExtendedLocationInfo | null];
  'memory:location:removed': [string, ExtendedLocationInfo];
  'memory:player:added': [string, ExtendedPlayerInfo];
  'memory:player:updated': [string, ExtendedPlayerInfo, ExtendedPlayerInfo | null];
  'memory:player:removed': [string, ExtendedPlayerInfo];
  'memory:fact:added': [string, FactEntry];
  'memory:fact:updated': [string, FactEntry, FactEntry | null];
  'memory:fact:removed': [string, FactEntry];
  'memory:rule:added': [RuleEntry];
  'memory:rule:updated': [RuleEntry, RuleEntry | null];
  'memory:rule:removed': [RuleEntry];
  'memory:task:updated': [ExtendedTaskInfo | null, ExtendedTaskInfo | null];
  'memory:cleanup': [CleanupResult];
  'memory:backup:created': [BackupMetadata];
  'memory:backup:restored': [RestoreResult];
  'memory:migration:started': [number, number];
  'memory:migration:completed': [number, number, MigrationResult];
  'memory:migration:failed': [number, number, Error];
}

/**
 * Cleanup result
 */
export interface CleanupResult {
  removedLocations: number;
  removedPlayers: number;
  removedFacts: number;
  removedRules: number;
  timestamp: string;
  duration: number;
}

/**
 * Migration result
 */
export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  success: boolean;
  changes: string[];
  duration: number;
  error?: string;
}

/**
 * Restore result
 */
export interface RestoreResult {
  success: boolean;
  restoredCounts: {
    locations: number;
    players: number;
    facts: number;
    rules: number;
    tasks: number;
  };
  timestamp: string;
  error?: string;
}

/**
 * Default empty memory data factory
 */
export function createDefaultMemoryData(): MemoryData {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    locations: {},
    players: {},
    currentTask: null,
    rules: [],
    learnedFacts: {},
    metadata: {
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
    },
  };
}

/**
 * Type guards
 */
export function isExtendedLocationInfo(value: unknown): value is ExtendedLocationInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ExtendedLocationInfo).x === 'number' &&
    typeof (value as ExtendedLocationInfo).y === 'number' &&
    typeof (value as ExtendedLocationInfo).z === 'number'
  );
}

export function isExtendedPlayerInfo(value: unknown): value is ExtendedPlayerInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ExtendedPlayerInfo).username === 'string'
  );
}

export function isFactEntry(value: unknown): value is FactEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FactEntry).key === 'string' &&
    typeof (value as FactEntry).value === 'string'
  );
}

export function isRuleEntry(value: unknown): value is RuleEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RuleEntry).id === 'string' &&
    typeof (value as RuleEntry).rule === 'string'
  );
}
