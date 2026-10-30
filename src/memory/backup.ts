/**
 * Backup and restore functionality for the memory system
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  MemoryData,
  BackupMetadata,
  RestoreOptions,
  RestoreResult} from './types';
import {
  CleanupResult,
} from './types';

/**
 * Backup configuration
 */
export interface BackupConfig {
  directory: string;
  maxBackups: number; // maximum number of backups to keep
  compress: boolean; // whether to compress backups (not implemented, placeholder)
  autoBackup: boolean;
  autoBackupInterval: number; // ms
  prefix: string; // filename prefix
}

/**
 * Default backup configuration
 */
export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  directory: './backups/memory',
  maxBackups: 10,
  compress: false,
  autoBackup: true,
  autoBackupInterval: 6 * 60 * 60 * 1000, // 6 hours
  prefix: 'memory-backup',
};

/**
 * Backup manager
 */
export class MemoryBackup {
  private config: BackupConfig;
  private timer: NodeJS.Timeout | null = null;
  private lastBackup: BackupMetadata | null = null;

  constructor(config: Partial<BackupConfig> = {}) {
    this.config = { ...DEFAULT_BACKUP_CONFIG, ...config };
    this.ensureDirectory();
  }

  /**
   * Ensure backup directory exists
   */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.config.directory)) {
      fs.mkdirSync(this.config.directory, { recursive: true });
    }
  }

  /**
   * Update configuration
   */
  configure(config: Partial<BackupConfig>): this {
    const oldDir = this.config.directory;
    this.config = { ...this.config, ...config };

    if (this.config.directory !== oldDir) {
      this.ensureDirectory();
    }
    return this;
  }

  /**
   * Get current configuration
   */
  getConfig(): BackupConfig {
    return { ...this.config };
  }

  /**
   * Generate backup filename
   */
  private generateFilename(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${this.config.prefix}-${timestamp}.json`;
  }

  /**
   * Create a backup of memory data
   */
  createBackup(memory: MemoryData, description?: string, tags?: string[]): BackupMetadata {
    const filename = this.generateFilename();
    const filepath = path.join(this.config.directory, filename);

    const backupData = {
      ...memory,
      // Don't include metadata in backup to avoid circular references
      metadata: {
        ...memory.metadata,
        // Clear stats that will be recalculated on restore
        stats: {
          ...memory.metadata.stats,
          lastBackupAt: new Date().toISOString(),
        },
      },
    };

    const content = JSON.stringify(backupData, null, 2);
    const size = Buffer.byteLength(content, 'utf8');

    // Write atomically
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filepath);

    const metadata: BackupMetadata = {
      id: filename.replace('.json', ''),
      createdAt: new Date().toISOString(),
      schemaVersion: memory.schemaVersion,
      size,
      entryCounts: {
        locations: Object.keys(memory.locations).length,
        players: Object.keys(memory.players).length,
        facts: Object.keys(memory.learnedFacts).length,
        rules: memory.rules.length,
        tasks: memory.currentTask ? 1 : 0,
      },
      description,
      tags,
    };

    // Save metadata alongside backup
    const metaPath = filepath.replace('.json', '.meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');

    this.lastBackup = metadata;

    // Prune old backups
    this.pruneOldBackups();

    console.log(`[MEMORY-BACKUP] Created backup: ${filename} (${this.formatBytes(size)})`);
    return metadata;
  }

  /**
   * List all available backups
   */
  listBackups(): BackupMetadata[] {
    const backups: BackupMetadata[] = [];

    try {
      const files = fs.readdirSync(this.config.directory);
      const metaFiles = files.filter(f => f.endsWith('.meta.json'));

      for (const metaFile of metaFiles) {
        try {
          const metaPath = path.join(this.config.directory, metaFile);
          const content = fs.readFileSync(metaPath, 'utf8');
          const metadata = JSON.parse(content) as BackupMetadata;
          backups.push(metadata);
        } catch (error) {
          console.warn(`[MEMORY-BACKUP] Failed to read backup metadata: ${metaFile}`, error);
        }
      }

      // Sort by creation date (newest first)
      backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch (error) {
      console.error('[MEMORY-BACKUP] Failed to list backups:', error);
    }

    return backups;
  }

  /**
   * Get backup metadata by ID
   */
  getBackup(backupId: string): BackupMetadata | null {
    const metaPath = path.join(this.config.directory, `${backupId}.meta.json`);
    if (!fs.existsSync(metaPath)) return null;

    try {
      const content = fs.readFileSync(metaPath, 'utf8');
      return JSON.parse(content) as BackupMetadata;
    } catch (error) {
      console.error(`[MEMORY-BACKUP] Failed to read backup metadata: ${backupId}`, error);
      return null;
    }
  }

  /**
   * Restore memory from a backup
   */
  restore(memory: MemoryData, options: RestoreOptions): RestoreResult {
    const startTime = Date.now();
    const { backupId, merge = false, categories = ['locations', 'players', 'facts', 'rules', 'tasks', 'metadata'] } = options;

    const metaPath = path.join(this.config.directory, `${backupId}.meta.json`);
    const backupPath = path.join(this.config.directory, `${backupId}.json`);

    if (!fs.existsSync(metaPath) || !fs.existsSync(backupPath)) {
      return {
        success: false,
        restoredCounts: { locations: 0, players: 0, facts: 0, rules: 0, tasks: 0 },
        timestamp: new Date().toISOString(),
        error: `Backup not found: ${backupId}`,
      };
    }

    try {
      const backupContent = fs.readFileSync(backupPath, 'utf8');
      const backupData = JSON.parse(backupContent) as MemoryData;

      const restoredCounts = {
        locations: 0,
        players: 0,
        facts: 0,
        rules: 0,
        tasks: 0,
      };

      // Restore selected categories
      if (categories.includes('locations') && backupData.locations) {
        if (merge) {
          for (const [key, loc] of Object.entries(backupData.locations)) {
            if (!memory.locations[key]) {
              memory.locations[key] = loc;
              restoredCounts.locations++;
            }
          }
        } else {
          memory.locations = { ...backupData.locations };
          restoredCounts.locations = Object.keys(backupData.locations).length;
        }
      }

      if (categories.includes('players') && backupData.players) {
        if (merge) {
          for (const [key, player] of Object.entries(backupData.players)) {
            if (!memory.players[key]) {
              memory.players[key] = player;
              restoredCounts.players++;
            }
          }
        } else {
          memory.players = { ...backupData.players };
          restoredCounts.players = Object.keys(backupData.players).length;
        }
      }

      if (categories.includes('facts') && backupData.learnedFacts) {
        if (merge) {
          for (const [key, fact] of Object.entries(backupData.learnedFacts)) {
            if (!memory.learnedFacts[key]) {
              memory.learnedFacts[key] = fact;
              restoredCounts.facts++;
            }
          }
        } else {
          memory.learnedFacts = { ...backupData.learnedFacts };
          restoredCounts.facts = Object.keys(backupData.learnedFacts).length;
        }
      }

      if (categories.includes('rules') && backupData.rules) {
        if (merge) {
          const existingIds = new Set(memory.rules.map(r => r.id));
          for (const rule of backupData.rules) {
            if (!existingIds.has(rule.id)) {
              memory.rules.push(rule);
              restoredCounts.rules++;
            }
          }
        } else {
          memory.rules = [...backupData.rules];
          restoredCounts.rules = backupData.rules.length;
        }
      }

      if (categories.includes('tasks') && backupData.currentTask) {
        memory.currentTask = backupData.currentTask;
        restoredCounts.tasks = 1;
      }

      if (categories.includes('metadata') && backupData.metadata) {
        // Preserve current migration history but update other metadata
        const currentHistory = memory.metadata.migrationHistory;
        memory.metadata = {
          ...backupData.metadata,
          migrationHistory: currentHistory,
          updatedAt: new Date().toISOString(),
        };
      }

      // Update stats
      memory.metadata.stats.totalLocations = Object.keys(memory.locations).length;
      memory.metadata.stats.totalPlayers = Object.keys(memory.players).length;
      memory.metadata.stats.totalFacts = Object.keys(memory.learnedFacts).length;
      memory.metadata.stats.totalRules = memory.rules.length;
      memory.metadata.stats.totalTasks = memory.currentTask ? 1 : 0;

      return {
        success: true,
        restoredCounts,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MEMORY-BACKUP] Restore failed: ${errorMessage}`);

      return {
        success: false,
        restoredCounts: { locations: 0, players: 0, facts: 0, rules: 0, tasks: 0 },
        timestamp: new Date().toISOString(),
        error: errorMessage,
      };
    }
  }

  /**
   * Delete a backup
   */
  deleteBackup(backupId: string): boolean {
    const metaPath = path.join(this.config.directory, `${backupId}.meta.json`);
    const backupPath = path.join(this.config.directory, `${backupId}.json`);

    let deleted = false;

    try {
      if (fs.existsSync(metaPath)) {
        fs.unlinkSync(metaPath);
        deleted = true;
      }
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
        deleted = true;
      }
    } catch (error) {
      console.error(`[MEMORY-BACKUP] Failed to delete backup: ${backupId}`, error);
      return false;
    }

    return deleted;
  }

  /**
   * Prune old backups beyond maxBackups limit
   */
  private pruneOldBackups(): void {
    const backups = this.listBackups();

    if (backups.length > this.config.maxBackups) {
      const toDelete = backups.slice(this.config.maxBackups);
      for (const backup of toDelete) {
        this.deleteBackup(backup.id);
        console.log(`[MEMORY-BACKUP] Pruned old backup: ${backup.id}`);
      }
    }
  }

  /**
   * Start automatic backup interval
   */
  startAutoBackup(memory: MemoryData, onBackup?: (metadata: BackupMetadata) => void): void {
    if (!this.config.autoBackup) return;

    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(() => {
      try {
        const metadata = this.createBackup(memory);
        if (onBackup) {
          onBackup(metadata);
        }
      } catch (error) {
        console.error('[MEMORY-BACKUP] Auto backup failed:', error);
      }
    }, this.config.autoBackupInterval);

    // Don't prevent process exit
    this.timer.unref?.();
  }

  /**
   * Stop automatic backup
   */
  stopAutoBackup(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Get last backup metadata
   */
  getLastBackup(): BackupMetadata | null {
    return this.lastBackup;
  }

  /**
   * Export backup to a specific location (for manual backup)
   */
  exportBackup(backupId: string, destinationPath: string): boolean {
    const backupPath = path.join(this.config.directory, `${backupId}.json`);
    const metaPath = path.join(this.config.directory, `${backupId}.meta.json`);

    if (!fs.existsSync(backupPath) || !fs.existsSync(metaPath)) {
      return false;
    }

    try {
      fs.copyFileSync(backupPath, destinationPath);
      fs.copyFileSync(metaPath, destinationPath.replace('.json', '.meta.json'));
      return true;
    } catch (error) {
      console.error('[MEMORY-BACKUP] Export failed:', error);
      return false;
    }
  }

  /**
   * Import backup from a file
   */
  importBackup(sourcePath: string): BackupMetadata | null {
    const metaPath = sourcePath.replace('.json', '.meta.json');

    if (!fs.existsSync(sourcePath) || !fs.existsSync(metaPath)) {
      console.error('[MEMORY-BACKUP] Import failed: backup or metadata file not found');
      return null;
    }

    try {
      const metaContent = fs.readFileSync(metaPath, 'utf8');
      const metadata = JSON.parse(metaContent) as BackupMetadata;

      // Copy to backup directory
      const destPath = path.join(this.config.directory, `${metadata.id}.json`);
      const destMetaPath = path.join(this.config.directory, `${metadata.id}.meta.json`);

      fs.copyFileSync(sourcePath, destPath);
      fs.copyFileSync(metaPath, destMetaPath);

      this.pruneOldBackups();
      console.log(`[MEMORY-BACKUP] Imported backup: ${metadata.id}`);
      return metadata;
    } catch (error) {
      console.error('[MEMORY-BACKUP] Import failed:', error);
      return null;
    }
  }

  /**
   * Format bytes to human readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

/**
 * Create a backup manager with default config
 */
export function createBackup(config?: Partial<BackupConfig>): MemoryBackup {
  return new MemoryBackup(config);
}