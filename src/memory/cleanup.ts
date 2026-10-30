/**
 * Automatic cleanup and pruning for the memory system
 */

import type { MemoryData, CleanupOptions, CleanupResult} from './types';
import { ExtendedLocationInfo, ExtendedPlayerInfo, FactEntry, RuleEntry } from './types';

/**
 * Default cleanup configuration
 */
export interface CleanupConfig {
  // Time-based cleanup
  maxLocationAge: number; // ms - default 90 days
  maxPlayerInactiveAge: number; // ms - default 180 days
  maxFactAge: number; // ms - default 365 days
  maxRuleAge: number; // ms - default never (0 = disabled)

  // Count-based limits
  maxLocations: number; // default 1000
  maxPlayers: number; // default 500
  maxFacts: number; // default 2000
  maxRules: number; // default 500

  // Cleanup behavior
  enabled: boolean;
  interval: number; // ms - default 24 hours
  dryRun: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  maxLocationAge: 90 * 24 * 60 * 60 * 1000, // 90 days
  maxPlayerInactiveAge: 180 * 24 * 60 * 60 * 1000, // 180 days
  maxFactAge: 365 * 24 * 60 * 60 * 1000, // 365 days
  maxRuleAge: 0, // disabled
  maxLocations: 1000,
  maxPlayers: 500,
  maxFacts: 2000,
  maxRules: 500,
  enabled: true,
  interval: 24 * 60 * 60 * 1000, // 24 hours
  dryRun: false,
};

/**
 * Cleanup engine
 */
export class MemoryCleanup {
  private config: CleanupConfig;
  private timer: NodeJS.Timeout | null = null;
  private lastRun: Date | null = null;
  private lastResult: CleanupResult | null = null;

  constructor(config: Partial<CleanupConfig> = {}) {
    this.config = { ...DEFAULT_CLEANUP_CONFIG, ...config };
  }

  /**
   * Update configuration
   */
  configure(config: Partial<CleanupConfig>): this {
    this.config = { ...this.config, ...config };
    return this;
  }

  /**
   * Get current configuration
   */
  getConfig(): CleanupConfig {
    return { ...this.config };
  }

  /**
   * Run cleanup on memory data
   */
  cleanup(memory: MemoryData, options: CleanupOptions = {}): CleanupResult {
    const startTime = Date.now();
    const now = new Date();
    const mergedOptions = { ...this.config, ...options };

    let removedLocations = 0;
    let removedPlayers = 0;
    let removedFacts = 0;
    let removedRules = 0;

    // Clean up locations
    if (mergedOptions.maxAge || mergedOptions.maxEntries) {
      const locationAge = mergedOptions.maxAge ?? this.config.maxLocationAge;
      const maxLocations = mergedOptions.maxEntries ?? this.config.maxLocations;

      const locationEntries = Object.entries(memory.locations);

      // Sort by lastVisitedAt or updatedAt (oldest first)
      locationEntries.sort((a, b) => {
        const dateA = a[1].lastVisitedAt ? new Date(a[1].lastVisitedAt).getTime() : new Date(a[1].updatedAt).getTime();
        const dateB = b[1].lastVisitedAt ? new Date(b[1].lastVisitedAt).getTime() : new Date(b[1].updatedAt).getTime();
        return dateA - dateB;
      });

      const toRemove = new Set<string>();

      // Remove by age
      if (locationAge > 0) {
        const cutoff = now.getTime() - locationAge;
        for (const [key, loc] of locationEntries) {
          const lastVisit = loc.lastVisitedAt ? new Date(loc.lastVisitedAt).getTime() : new Date(loc.updatedAt).getTime();
          if (lastVisit < cutoff) {
            toRemove.add(key);
          }
        }
      }

      // Remove excess entries (keep most recently visited)
      if (maxLocations > 0 && locationEntries.length - toRemove.size > maxLocations) {
        const excess = locationEntries.length - toRemove.size - maxLocations;
        let removed = 0;
        for (const [key] of locationEntries) {
          if (!toRemove.has(key) && removed < excess) {
            toRemove.add(key);
            removed++;
          }
        }
      }

      // Actually remove
      if (!mergedOptions.dryRun) {
        for (const key of toRemove) {
          delete memory.locations[key];
          removedLocations++;
        }
      } else {
        removedLocations = toRemove.size;
      }
    }

    // Clean up players
    if (mergedOptions.maxAge || mergedOptions.maxEntries) {
      const playerAge = mergedOptions.maxAge ?? this.config.maxPlayerInactiveAge;
      const maxPlayers = mergedOptions.maxEntries ?? this.config.maxPlayers;

      const playerEntries = Object.entries(memory.players);

      // Sort by lastSeen (oldest first)
      playerEntries.sort((a, b) =>
        new Date(a[1].lastSeen).getTime() - new Date(b[1].lastSeen).getTime()
      );

      const toRemove = new Set<string>();

      // Remove by age (inactivity)
      if (playerAge > 0) {
        const cutoff = now.getTime() - playerAge;
        for (const [key, player] of playerEntries) {
          const lastSeen = new Date(player.lastSeen).getTime();
          if (lastSeen < cutoff && player.role === 'guest') {
            // Only remove guest players by inactivity
            toRemove.add(key);
          }
        }
      }

      // Remove excess entries (keep most recently seen)
      if (maxPlayers > 0 && playerEntries.length - toRemove.size > maxPlayers) {
        const excess = playerEntries.length - toRemove.size - maxPlayers;
        let removed = 0;
        for (const [key] of playerEntries) {
          if (!toRemove.has(key) && removed < excess) {
            toRemove.add(key);
            removed++;
          }
        }
      }

      // Actually remove
      if (!mergedOptions.dryRun) {
        for (const key of toRemove) {
          delete memory.players[key];
          removedPlayers++;
        }
      } else {
        removedPlayers = toRemove.size;
      }
    }

    // Clean up facts
    if (mergedOptions.maxAge || mergedOptions.maxEntries) {
      const factAge = mergedOptions.maxAge ?? this.config.maxFactAge;
      const maxFacts = mergedOptions.maxEntries ?? this.config.maxFacts;

      const factEntries = Object.entries(memory.learnedFacts);

      // Sort by lastAccessedAt or createdAt (oldest first)
      factEntries.sort((a, b) => {
        const dateA = a[1].lastAccessedAt ? new Date(a[1].lastAccessedAt).getTime() : new Date(a[1].createdAt).getTime();
        const dateB = b[1].lastAccessedAt ? new Date(b[1].lastAccessedAt).getTime() : new Date(b[1].createdAt).getTime();
        return dateA - dateB;
      });

      const toRemove = new Set<string>();

      // Remove by age
      if (factAge > 0) {
        const cutoff = now.getTime() - factAge;
        for (const [key, fact] of factEntries) {
          const lastAccess = fact.lastAccessedAt ? new Date(fact.lastAccessedAt).getTime() : new Date(fact.createdAt).getTime();
          if (lastAccess < cutoff && (fact.confidence ?? 1) < 0.9) {
            // Only remove low-confidence old facts
            toRemove.add(key);
          }
        }
      }

      // Remove excess entries (keep most accessed)
      if (maxFacts > 0 && factEntries.length - toRemove.size > maxFacts) {
        const excess = factEntries.length - toRemove.size - maxFacts;
        let removed = 0;
        // Sort by access count (least accessed first)
        const byAccess = [...factEntries].sort((a, b) => (a[1].accessCount ?? 0) - (b[1].accessCount ?? 0));
        for (const [key] of byAccess) {
          if (!toRemove.has(key) && removed < excess) {
            toRemove.add(key);
            removed++;
          }
        }
      }

      // Actually remove
      if (!mergedOptions.dryRun) {
        for (const key of toRemove) {
          delete memory.learnedFacts[key];
          removedFacts++;
        }
      } else {
        removedFacts = toRemove.size;
      }
    }

    // Clean up rules
    if (mergedOptions.maxAge || mergedOptions.maxEntries) {
      const ruleAge = mergedOptions.maxAge ?? this.config.maxRuleAge;
      const maxRules = mergedOptions.maxEntries ?? this.config.maxRules;

      const ruleEntries = [...memory.rules];

      // Sort by createdAt (oldest first)
      ruleEntries.sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

      const toRemove = new Set<string>();

      // Remove by age (only disabled rules)
      if (ruleAge > 0) {
        const cutoff = now.getTime() - ruleAge;
        for (const rule of ruleEntries) {
          if (!rule.enabled) {
            const created = new Date(rule.createdAt).getTime();
            if (created < cutoff) {
              toRemove.add(rule.id);
            }
          }
        }
      }

      // Remove excess entries (keep enabled rules first, then newest)
      if (maxRules > 0 && ruleEntries.length - toRemove.size > maxRules) {
        const excess = ruleEntries.length - toRemove.size - maxRules;
        let removed = 0;
        // Sort: disabled first, then oldest
        const sorted = [...ruleEntries].sort((a, b) => {
          if (a.enabled !== b.enabled) return a.enabled ? 1 : -1;
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });
        for (const rule of sorted) {
          if (!toRemove.has(rule.id) && removed < excess) {
            toRemove.add(rule.id);
            removed++;
          }
        }
      }

      // Actually remove
      if (!mergedOptions.dryRun) {
        memory.rules = memory.rules.filter(r => !toRemove.has(r.id));
        removedRules = toRemove.size;
      } else {
        removedRules = toRemove.size;
      }
    }

    const result: CleanupResult = {
      removedLocations,
      removedPlayers,
      removedFacts,
      removedRules,
      timestamp: now.toISOString(),
      duration: Date.now() - startTime,
    };

    this.lastRun = now;
    this.lastResult = result;

    // Update metadata
    if (!options.dryRun) {
      memory.metadata.updatedAt = now.toISOString();
      memory.metadata.stats.lastCleanupAt = now.toISOString();
      memory.metadata.stats.totalLocations = Object.keys(memory.locations).length;
      memory.metadata.stats.totalPlayers = Object.keys(memory.players).length;
      memory.metadata.stats.totalFacts = Object.keys(memory.learnedFacts).length;
      memory.metadata.stats.totalRules = memory.rules.length;
    }

    return result;
  }

  /**
   * Start automatic cleanup interval
   */
  startAutoCleanup(memory: MemoryData, onCleanup?: (result: CleanupResult) => void): void {
    if (!this.config.enabled) return;

    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(() => {
      try {
        const result = this.cleanup(memory);
        if (onCleanup) {
          onCleanup(result);
        }
        if (result.removedLocations > 0 || result.removedPlayers > 0 ||
            result.removedFacts > 0 || result.removedRules > 0) {
          console.log(`[MEMORY-CLEANUP] Cleaned up: ${result.removedLocations} locations, ${result.removedPlayers} players, ${result.removedFacts} facts, ${result.removedRules} rules in ${result.duration}ms`);
        }
      } catch (error) {
        console.error('[MEMORY-CLEANUP] Auto cleanup failed:', error);
      }
    }, this.config.interval);

    // Don't prevent process exit
    this.timer.unref?.();
  }

  /**
   * Stop automatic cleanup
   */
  stopAutoCleanup(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Get last cleanup result
   */
  getLastResult(): CleanupResult | null {
    return this.lastResult;
  }

  /**
   * Get last run time
   */
  getLastRun(): Date | null {
    return this.lastRun;
  }

  /**
   * Preview what would be cleaned up (dry run)
   */
  preview(memory: MemoryData): CleanupResult {
    return this.cleanup(memory, { dryRun: true });
  }

  /**
   * Clean up specific categories only
   */
  cleanupCategory(
    memory: MemoryData,
    category: 'locations' | 'players' | 'facts' | 'rules',
    options: CleanupOptions = {}
  ): Partial<CleanupResult> {
    const startTime = Date.now();
    const now = new Date();

    switch (category) {
      case 'locations': {
        const locationAge = options.maxAge ?? this.config.maxLocationAge;
        const maxLocations = options.maxEntries ?? this.config.maxLocations;
        const entries = Object.entries(memory.locations);
        entries.sort((a, b) => {
          const dateA = a[1].lastVisitedAt ? new Date(a[1].lastVisitedAt).getTime() : new Date(a[1].updatedAt).getTime();
          const dateB = b[1].lastVisitedAt ? new Date(b[1].lastVisitedAt).getTime() : new Date(b[1].updatedAt).getTime();
          return dateA - dateB;
        });
        const toRemove = new Set<string>();
        if (locationAge > 0) {
          const cutoff = now.getTime() - locationAge;
          for (const [key, loc] of entries) {
            const lastVisit = loc.lastVisitedAt ? new Date(loc.lastVisitedAt).getTime() : new Date(loc.updatedAt).getTime();
            if (lastVisit < cutoff) toRemove.add(key);
          }
        }
        if (maxLocations > 0 && entries.length - toRemove.size > maxLocations) {
          const excess = entries.length - toRemove.size - maxLocations;
          let removed = 0;
          for (const [key] of entries) {
            if (!toRemove.has(key) && removed < excess) { toRemove.add(key); removed++; }
          }
        }
        if (!options.dryRun) {
          for (const key of toRemove) delete memory.locations[key];
        }
        return { removedLocations: options.dryRun ? toRemove.size : toRemove.size, timestamp: now.toISOString(), duration: Date.now() - startTime };
      }
      case 'players': {
        const playerAge = options.maxAge ?? this.config.maxPlayerInactiveAge;
        const maxPlayers = options.maxEntries ?? this.config.maxPlayers;
        const entries = Object.entries(memory.players);
        entries.sort((a, b) => new Date(a[1].lastSeen).getTime() - new Date(b[1].lastSeen).getTime());
        const toRemove = new Set<string>();
        if (playerAge > 0) {
          const cutoff = now.getTime() - playerAge;
          for (const [key, player] of entries) {
            if (player.role === 'guest' && new Date(player.lastSeen).getTime() < cutoff) toRemove.add(key);
          }
        }
        if (maxPlayers > 0 && entries.length - toRemove.size > maxPlayers) {
          const excess = entries.length - toRemove.size - maxPlayers;
          let removed = 0;
          for (const [key] of entries) {
            if (!toRemove.has(key) && removed < excess) { toRemove.add(key); removed++; }
          }
        }
        if (!options.dryRun) {
          for (const key of toRemove) delete memory.players[key];
        }
        return { removedPlayers: options.dryRun ? toRemove.size : toRemove.size, timestamp: now.toISOString(), duration: Date.now() - startTime };
      }
      case 'facts': {
        const factAge = options.maxAge ?? this.config.maxFactAge;
        const maxFacts = options.maxEntries ?? this.config.maxFacts;
        const entries = Object.entries(memory.learnedFacts);
        entries.sort((a, b) => {
          const dateA = a[1].lastAccessedAt ? new Date(a[1].lastAccessedAt).getTime() : new Date(a[1].createdAt).getTime();
          const dateB = b[1].lastAccessedAt ? new Date(b[1].lastAccessedAt).getTime() : new Date(b[1].createdAt).getTime();
          return dateA - dateB;
        });
        const toRemove = new Set<string>();
        if (factAge > 0) {
          const cutoff = now.getTime() - factAge;
          for (const [key, fact] of entries) {
            const lastAccess = fact.lastAccessedAt ? new Date(fact.lastAccessedAt).getTime() : new Date(fact.createdAt).getTime();
            if (lastAccess < cutoff && (fact.confidence ?? 1) < 0.9) toRemove.add(key);
          }
        }
        if (maxFacts > 0 && entries.length - toRemove.size > maxFacts) {
          const excess = entries.length - toRemove.size - maxFacts;
          let removed = 0;
          const byAccess = [...entries].sort((a, b) => (a[1].accessCount ?? 0) - (b[1].accessCount ?? 0));
          for (const [key] of byAccess) {
            if (!toRemove.has(key) && removed < excess) { toRemove.add(key); removed++; }
          }
        }
        if (!options.dryRun) {
          for (const key of toRemove) delete memory.learnedFacts[key];
        }
        return { removedFacts: options.dryRun ? toRemove.size : toRemove.size, timestamp: now.toISOString(), duration: Date.now() - startTime };
      }
      case 'rules': {
        const ruleAge = options.maxAge ?? this.config.maxRuleAge;
        const maxRules = options.maxEntries ?? this.config.maxRules;
        const entries = [...memory.rules];
        entries.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        const toRemove = new Set<string>();
        if (ruleAge > 0) {
          const cutoff = now.getTime() - ruleAge;
          for (const rule of entries) {
            if (!rule.enabled && new Date(rule.createdAt).getTime() < cutoff) toRemove.add(rule.id);
          }
        }
        if (maxRules > 0 && entries.length - toRemove.size > maxRules) {
          const excess = entries.length - toRemove.size - maxRules;
          let removed = 0;
          const sorted = [...entries].sort((a, b) => {
            if (a.enabled !== b.enabled) return a.enabled ? 1 : -1;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          });
          for (const rule of sorted) {
            if (!toRemove.has(rule.id) && removed < excess) { toRemove.add(rule.id); removed++; }
          }
        }
        if (!options.dryRun) {
          memory.rules = memory.rules.filter(r => !toRemove.has(r.id));
        }
        return { removedRules: options.dryRun ? toRemove.size : toRemove.size, timestamp: now.toISOString(), duration: Date.now() - startTime };
      }
    }

    return { timestamp: now.toISOString(), duration: Date.now() - startTime };
  }
}

/**
 * Create a cleanup instance with default config
 */
export function createCleanup(config?: Partial<CleanupConfig>): MemoryCleanup {
  return new MemoryCleanup(config);
}