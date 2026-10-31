/**
 * Query API for the memory system - find, filter, search capabilities
 */

import type {
  MemoryData,
  ExtendedLocationInfo,
  ExtendedPlayerInfo,
  FactEntry,
  RuleEntry,
  QueryOptions,
  SearchOptions,
} from './types';

/**
 * Generic query builder for memory collections
 */
export class MemoryQuery<T> {
  private items: T[];
  private options: QueryOptions<T> = {};

  constructor(items: T[]) {
    this.items = items;
  }

  /**
   * Filter items with a predicate function
   */
  filter(predicate: (item: T) => boolean): this {
    this.options.filter = predicate;
    return this;
  }

  /**
   * Sort items with a comparator function
   */
  sort(comparator: (a: T, b: T) => number): this {
    this.options.sort = comparator;
    return this;
  }

  /**
   * Limit the number of results
   */
  limit(count: number): this {
    this.options.limit = count;
    return this;
  }

  /**
   * Skip a number of results (for pagination)
   */
  offset(count: number): this {
    this.options.offset = count;
    return this;
  }

  /**
   * Select specific fields (projection)
   */
  select<U extends keyof T>(...fields: U[]): this {
    this.options.fields = fields;
    return this;
  }

  /**
   * Execute the query and return results
   */
  execute(): T[] {
    let results = [...this.items];

    // Apply filter
    if (this.options.filter) {
      results = results.filter(this.options.filter);
    }

    // Apply sort
    if (this.options.sort) {
      results = results.sort(this.options.sort);
    }

    // Apply offset
    if (this.options.offset && this.options.offset > 0) {
      results = results.slice(this.options.offset);
    }

    // Apply limit
    if (this.options.limit && this.options.limit > 0) {
      results = results.slice(0, this.options.limit);
    }

    // Apply field selection (projection)
    if (this.options.fields && this.options.fields.length > 0) {
      results = results.map((item) => {
        const projected: Partial<T> = {};
        for (const field of this.options.fields!) {
          projected[field] = item[field];
        }
        return projected as T;
      });
    }

    return results;
  }

  /**
   * Execute and return first result
   */
  first(): T | undefined {
    return this.limit(1).execute()[0];
  }

  /**
   * Execute and return count
   */
  count(): number {
    let results = [...this.items];
    if (this.options.filter) {
      results = results.filter(this.options.filter);
    }
    return results.length;
  }

  /**
   * Check if any items match
   */
  exists(): boolean {
    return this.count() > 0;
  }
}

/**
 * Create a query for locations
 */
export function queryLocations(memory: MemoryData): MemoryQuery<ExtendedLocationInfo> {
  return new MemoryQuery(Object.values(memory.locations));
}

/**
 * Create a query for players
 */
export function queryPlayers(memory: MemoryData): MemoryQuery<ExtendedPlayerInfo> {
  return new MemoryQuery(Object.values(memory.players));
}

/**
 * Create a query for facts
 */
export function queryFacts(memory: MemoryData): MemoryQuery<FactEntry> {
  return new MemoryQuery(Object.values(memory.learnedFacts));
}

/**
 * Create a query for rules
 */
export function queryRules(memory: MemoryData): MemoryQuery<RuleEntry> {
  return new MemoryQuery(memory.rules);
}

/**
 * Search locations by text query
 */
export function searchLocations(
  memory: MemoryData,
  options: SearchOptions
): ExtendedLocationInfo[] {
  const {
    query,
    fields = ['type', 'description'],
    caseSensitive = false,
    fuzzy = false,
    limit = 50,
  } = options;
  const searchTerm = caseSensitive ? query : query.toLowerCase();
  const results: ExtendedLocationInfo[] = [];

  for (const location of Object.values(memory.locations)) {
    let match = false;

    for (const field of fields) {
      const value = location[field as keyof ExtendedLocationInfo];
      if (typeof value === 'string') {
        const haystack = caseSensitive ? value : value.toLowerCase();
        if (fuzzy) {
          match = fuzzyMatch(haystack, searchTerm);
        } else {
          match = haystack.includes(searchTerm);
        }
        if (match) break;
      }
    }

    if (match) {
      results.push(location);
      if (results.length >= limit) break;
    }
  }

  return results;
}

/**
 * Search players by text query
 */
export function searchPlayers(memory: MemoryData, options: SearchOptions): ExtendedPlayerInfo[] {
  const {
    query,
    fields = ['username', 'displayName', 'notes'],
    caseSensitive = false,
    fuzzy = false,
    limit = 50,
  } = options;
  const searchTerm = caseSensitive ? query : query.toLowerCase();
  const results: ExtendedPlayerInfo[] = [];

  for (const player of Object.values(memory.players)) {
    let match = false;

    for (const field of fields) {
      const value = player[field as keyof ExtendedPlayerInfo];
      if (typeof value === 'string') {
        const haystack = caseSensitive ? value : value.toLowerCase();
        if (fuzzy) {
          match = fuzzyMatch(haystack, searchTerm);
        } else {
          match = haystack.includes(searchTerm);
        }
        if (match) break;
      }
    }

    if (match) {
      results.push(player);
      if (results.length >= limit) break;
    }
  }

  return results;
}

/**
 * Search facts by text query
 */
export function searchFacts(memory: MemoryData, options: SearchOptions): FactEntry[] {
  const {
    query,
    fields = ['key', 'value', 'category'],
    caseSensitive = false,
    fuzzy = false,
    limit = 50,
  } = options;
  const searchTerm = caseSensitive ? query : query.toLowerCase();
  const results: FactEntry[] = [];

  for (const fact of Object.values(memory.learnedFacts)) {
    let match = false;

    for (const field of fields) {
      const value = fact[field as keyof FactEntry];
      if (typeof value === 'string') {
        const haystack = caseSensitive ? value : value.toLowerCase();
        if (fuzzy) {
          match = fuzzyMatch(haystack, searchTerm);
        } else {
          match = haystack.includes(searchTerm);
        }
        if (match) break;
      }
    }

    if (match) {
      results.push(fact);
      if (results.length >= limit) break;
    }
  }

  return results;
}

/**
 * Search rules by text query
 */
export function searchRules(memory: MemoryData, options: SearchOptions): RuleEntry[] {
  const {
    query,
    fields = ['rule', 'category'],
    caseSensitive = false,
    fuzzy = false,
    limit = 50,
  } = options;
  const searchTerm = caseSensitive ? query : query.toLowerCase();
  const results: RuleEntry[] = [];

  for (const rule of memory.rules) {
    let match = false;

    for (const field of fields) {
      const value = rule[field as keyof RuleEntry];
      if (typeof value === 'string') {
        const haystack = caseSensitive ? value : value.toLowerCase();
        if (fuzzy) {
          match = fuzzyMatch(haystack, searchTerm);
        } else {
          match = haystack.includes(searchTerm);
        }
        if (match) break;
      }
    }

    if (match) {
      results.push(rule);
      if (results.length >= limit) break;
    }
  }

  return results;
}

/**
 * Global search across all memory types
 */
export function searchAll(
  memory: MemoryData,
  options: SearchOptions
): {
  locations: ExtendedLocationInfo[];
  players: ExtendedPlayerInfo[];
  facts: FactEntry[];
  rules: RuleEntry[];
} {
  return {
    locations: searchLocations(memory, options),
    players: searchPlayers(memory, options),
    facts: searchFacts(memory, options),
    rules: searchRules(memory, options),
  };
}

/**
 * Simple fuzzy matching - checks if all characters of query appear in order in haystack
 */
function fuzzyMatch(haystack: string, needle: string): boolean {
  if (needle.length === 0) return true;
  if (haystack.length === 0) return false;

  let needleIndex = 0;
  for (let i = 0; i < haystack.length && needleIndex < needle.length; i++) {
    if (haystack[i] === needle[needleIndex]) {
      needleIndex++;
    }
  }
  return needleIndex === needle.length;
}

/**
 * Predefined query helpers
 */

// Location queries
export const LocationQueries = {
  byType: (memory: MemoryData, type: string) =>
    queryLocations(memory).filter((loc) => loc.type === type),

  byDimension: (memory: MemoryData, dimension: string) =>
    queryLocations(memory).filter((loc) => loc.dimension === dimension),

  byTag: (memory: MemoryData, tag: string) =>
    queryLocations(memory).filter((loc) => loc.tags?.includes(tag) ?? false),

  nearby: (memory: MemoryData, center: { x: number; y: number; z: number }, radius: number) =>
    queryLocations(memory).filter((loc) => {
      const dx = loc.x - center.x;
      const dy = loc.y - center.y;
      const dz = loc.z - center.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius;
    }),

  recentlyVisited: (memory: MemoryData, since: Date) =>
    queryLocations(memory).filter(
      (loc) => loc.lastVisitedAt && new Date(loc.lastVisitedAt) >= since
    ),

  mostVisited: (memory: MemoryData, limit = 10) =>
    queryLocations(memory)
      .sort((a, b) => (b.visitCount ?? 0) - (a.visitCount ?? 0))
      .limit(limit),
};

// Player queries
export const PlayerQueries = {
  byRole: (memory: MemoryData, role: ExtendedPlayerInfo['role']) =>
    queryPlayers(memory).filter((p) => p.role === role),

  trusted: (memory: MemoryData) =>
    queryPlayers(memory).filter((p) => p.role === 'trusted' || p.role === 'admin'),

  admins: (memory: MemoryData) => queryPlayers(memory).filter((p) => p.role === 'admin'),

  recentlySeen: (memory: MemoryData, since: Date) =>
    queryPlayers(memory).filter((p) => p.lastSeen && new Date(p.lastSeen) >= since),

  byReputation: (memory: MemoryData, minReputation: number) =>
    queryPlayers(memory).filter((p) => (p.reputation ?? 0) >= minReputation),

  topInteractions: (memory: MemoryData, limit = 10) =>
    queryPlayers(memory)
      .sort((a, b) => (b.totalInteractions ?? 0) - (a.totalInteractions ?? 0))
      .limit(limit),
};

// Fact queries
export const FactQueries = {
  byCategory: (memory: MemoryData, category: string) =>
    queryFacts(memory).filter((f) => f.category === category),

  highConfidence: (memory: MemoryData, threshold = 0.8) =>
    queryFacts(memory).filter((f) => (f.confidence ?? 1) >= threshold),

  bySource: (memory: MemoryData, source: string) =>
    queryFacts(memory).filter((f) => f.source === source),

  recentlyAccessed: (memory: MemoryData, since: Date) =>
    queryFacts(memory).filter((f) => f.lastAccessedAt && new Date(f.lastAccessedAt) >= since),

  mostAccessed: (memory: MemoryData, limit = 10) =>
    queryFacts(memory)
      .sort((a, b) => (b.accessCount ?? 0) - (a.accessCount ?? 0))
      .limit(limit),
};

// Rule queries
export const RuleQueries = {
  enabled: (memory: MemoryData) => queryRules(memory).filter((r) => r.enabled),

  byCategory: (memory: MemoryData, category: string) =>
    queryRules(memory).filter((r) => r.category === category),

  byAuthor: (memory: MemoryData, author: string) =>
    queryRules(memory).filter((r) => r.author === author),

  recentlyAdded: (memory: MemoryData, since: Date) =>
    queryRules(memory).filter((r) => r.createdAt && new Date(r.createdAt) >= since),
};

/**
 * Get memory statistics
 */
export function getMemoryStats(memory: MemoryData) {
  const locations = Object.values(memory.locations);
  const players = Object.values(memory.players);
  const facts = Object.values(memory.learnedFacts);
  const rules = memory.rules;

  return {
    locations: {
      total: locations.length,
      byType: locations.reduce(
        (acc, loc) => {
          acc[loc.type] = (acc[loc.type] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      ),
      byDimension: locations.reduce(
        (acc, loc) => {
          acc[loc.dimension || 'overworld'] = (acc[loc.dimension || 'overworld'] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      ),
    },
    players: {
      total: players.length,
      byRole: players.reduce(
        (acc, p) => {
          acc[p.role] = (acc[p.role] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      ),
    },
    facts: {
      total: facts.length,
      byCategory: facts.reduce(
        (acc, f) => {
          acc[f.category || 'general'] = (acc[f.category || 'general'] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      ),
      avgConfidence:
        facts.length > 0
          ? facts.reduce((sum, f) => sum + (f.confidence ?? 1), 0) / facts.length
          : 0,
    },
    rules: {
      total: rules.length,
      enabled: rules.filter((r) => r.enabled).length,
      byCategory: rules.reduce(
        (acc, r) => {
          acc[r.category || 'general'] = (acc[r.category || 'general'] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      ),
    },
    currentTask: memory.currentTask
      ? {
          goal: memory.currentTask.goal,
          status: memory.currentTask.status,
          progress: memory.currentTask.progress,
        }
      : null,
    metadata: memory.metadata,
  };
}
