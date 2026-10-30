/**
 * Permission System
 * Handles user roles, permissions, and access control for commands
 */

import type { PermissionLevel, PermissionConfig, PlayerInfo } from './types';
import type { Bot } from 'mineflayer';

/**
 * Permission manager class
 * Manages user roles and permissions
 */
export class PermissionManager {
  private players = new Map<string, PlayerInfo>();
  private admins = new Set<string>();
  private trusted = new Set<string>();
  private config: PermissionConfig = { level: 'guest' };
  private bot: Bot | null = null;
  private adminPassword = '';
  private adminSessions = new Map<string, boolean>();
  private memory: any = null; // Will be set to memory module

  /**
   * Initialize the permission manager
   */
  initialize(bot: Bot, adminPassword = '', memory?: any): void {
    this.bot = bot;
    this.adminPassword = adminPassword;
    this.memory = memory;
    this.loadFromMemory();
  }

  /**
   * Load permissions from memory
   */
  private loadFromMemory(): void {
    if (this.memory && this.memory.players) {
      for (const [username, info] of Object.entries(this.memory.playters)) {
        const playerInfo = info as PlayerInfo;
        this.players.set(username.toLowerCase(), playerInfo);
        if (playerInfo.role === 'admin') this.admins.add(username.toLowerCase());
        else if (playerInfo.role === 'trusted') this.trusted.add(username.toLowerCase());
      }
    }
  }

  /**
   * Save permissions to memory
   */
  private saveToMemory(): void {
    if (this.memory) {
      this.memory.players = Object.fromEntries(this.players);
      // Trigger memory save
      if (typeof this.memory.save === 'function') {
        this.memory.save();
      }
    }
  }

  /**
   * Get a player's permission level
   */
  getPermissionLevel(username: string): PermissionLevel {
    const normalized = username.toLowerCase();

    // Check admin sessions first (temporary admin via password)
    if (this.adminSessions.get(normalized)) {
      return 'admin';
    }

    // Check permanent roles
    if (this.admins.has(normalized)) return 'admin';
    if (this.trusted.has(normalized)) return 'trusted';

    // Check memory
    const player = this.players.get(normalized);
    if (player) {
      return player.role;
    }

    return 'guest';
  }

  /**
   * Check if a user is admin
   */
  isAdmin(username: string): boolean {
    return this.getPermissionLevel(username) === 'admin';
  }

  /**
   * Check if a user is trusted
   */
  isTrusted(username: string): boolean {
    const level = this.getPermissionLevel(username);
    return level === 'admin' || level === 'trusted';
  }

  /**
   * Check if a user has a specific permission level or higher
   */
  hasPermission(username: string, requiredLevel: PermissionLevel): boolean {
    const userLevel = this.getPermissionLevel(username);
    const hierarchy: Record<PermissionLevel, number> = {
      guest: 0,
      trusted: 1,
      admin: 2,
    };
    return hierarchy[userLevel] >= hierarchy[requiredLevel];
  }

  /**
   * Attempt admin login via password
   */
  tryAdminLogin(username: string, password: string): boolean {
    if (password === this.adminPassword && this.adminPassword) {
      this.adminSessions.set(username.toLowerCase(), true);
      this.log(`Admin login: ${username}`);
      return true;
    }
    return false;
  }

  /**
   * Logout admin session
   */
  logoutAdmin(username: string): void {
    this.adminSessions.delete(username.toLowerCase());
    this.log(`Admin logout: ${username}`);
  }

  /**
   * Check if user has active admin session
   */
  hasAdminSession(username: string): boolean {
    return this.adminSessions.get(username.toLowerCase()) === true;
  }

  /**
   * Set a player's role permanently
   */
  setRole(username: string, role: PermissionLevel, save = true): boolean {
    const normalized = username.toLowerCase();

    // Remove from all sets
    this.admins.delete(normalized);
    this.trusted.delete(normalized);

    // Add to appropriate set
    switch (role) {
      case 'admin':
        this.admins.add(normalized);
        break;
      case 'trusted':
        this.trusted.add(normalized);
        break;
      case 'guest':
      default:
        // Guest - not in any set
        break;
    }

    // Update player info
    const existing = this.players.get(normalized);
    const now = new Date().toISOString();
    this.players.set(normalized, {
      username,
      role,
      preferences: existing?.preferences || {},
      firstSeen: existing?.firstSeen || now,
      lastSeen: now,
    });

    if (save) this.saveToMemory();
    this.log(`Set role for ${username}: ${role}`);
    return true;
  }

  /**
   * Promote a user
   */
  promote(username: string): boolean {
    const currentLevel = this.getPermissionLevel(username);
    if (currentLevel === 'guest') return this.setRole(username, 'trusted');
    if (currentLevel === 'trusted') return this.setRole(username, 'admin');
    return false; // Already admin
  }

  /**
   * Demote a user
   */
  demote(username: string): boolean {
    const currentLevel = this.getPermissionLevel(username);
    if (currentLevel === 'admin') return this.setRole(username, 'trusted');
    if (currentLevel === 'trusted') return this.setRole(username, 'guest');
    return false; // Already guest
  }

  /**
   * Get all admins
   */
  getAdmins(): string[] {
    return Array.from(this.admins);
  }

  /**
   * Get all trusted users
   */
  getTrusted(): string[] {
    return Array.from(this.trusted);
  }

  /**
   * Get all players with roles
   */
  getAllPlayers(): PlayerInfo[] {
    return Array.from(this.players.values());
  }

  /**
   * Get player info
   */
  getPlayer(username: string): PlayerInfo | undefined {
    return this.players.get(username.toLowerCase());
  }

  /**
   * Update player preferences
   */
  updatePreferences(username: string, preferences: Record<string, unknown>): void {
    const normalized = username.toLowerCase();
    const existing = this.players.get(normalized);
    if (existing) {
      this.players.set(normalized, {
        ...existing,
        preferences: { ...existing.preferences, ...preferences },
        lastSeen: new Date().toISOString(),
      });
      this.saveToMemory();
    }
  }

  /**
   * Update player last seen
   */
  updateLastSeen(username: string): void {
    const normalized = username.toLowerCase();
    const existing = this.players.get(normalized);
    if (existing) {
      this.players.set(normalized, {
        ...existing,
        lastSeen: new Date().toISOString(),
      });
      // Don't save immediately, let it batch
    }
  }

  /**
   * Check command permission
   */
  checkCommandPermission(username: string, config: PermissionConfig): { allowed: boolean; reason?: string } {
    const userLevel = this.getPermissionLevel(username);

    // Check denied users
    if (config.deniedUsers?.includes(username)) {
      return { allowed: false, reason: 'User is denied access to this command' };
    }

    // Check allowed users (bypasses level check)
    if (config.allowedUsers?.includes(username)) {
      return { allowed: true };
    }

    // Check PM/public only - would need context
    // This is checked in the registry with context

    // Check permission level
    const hierarchy: Record<PermissionLevel, number> = {
      guest: 0,
      trusted: 1,
      admin: 2,
    };

    if (hierarchy[userLevel] < hierarchy[config.level]) {
      return { allowed: false, reason: `Requires ${config.level} permission` };
    }

    return { allowed: true };
  }

  /**
   * Get permission config for a command based on user
   */
  getEffectivePermission(username: string, baseConfig: PermissionConfig): PermissionConfig {
    const userLevel = this.getPermissionLevel(username);

    // If user is admin, they can bypass most restrictions
    if (userLevel === 'admin') {
      return {
        ...baseConfig,
        level: 'admin',
        allowedUsers: [...(baseConfig.allowedUsers || []), username],
      };
    }

    return baseConfig;
  }

  /**
   * Log permission events
   */
  private log(message: string): void {
    console.log(`[PERMISSIONS] ${message}`);
  }

  /**
   * Clear admin sessions (e.g., on restart)
   */
  clearAdminSessions(): void {
    this.adminSessions.clear();
  }

  /**
   * Get admin password (for verification)
   */
  getAdminPassword(): string {
    return this.adminPassword;
  }

  /**
   * Set admin password
   */
  setAdminPassword(password: string): void {
    this.adminPassword = password;
  }
}

/**
 * Create a permission manager instance
 */
export function createPermissionManager(): PermissionManager {
  return new PermissionManager();
}

/**
 * Default permission configs for common command types
 */
export const PermissionPresets = {
  /** Public command - anyone can use */
  PUBLIC: { level: 'guest' as PermissionLevel },
  /** Trusted users only */
  TRUSTED: { level: 'trusted' as PermissionLevel },
  /** Admin only */
  ADMIN: { level: 'admin' as PermissionLevel },
  /** PM only - for sensitive commands */
  PM_ONLY: { level: 'guest' as PermissionLevel, pmOnly: true },
  /** Admin PM only */
  ADMIN_PM: { level: 'admin' as PermissionLevel, pmOnly: true },
  /** Trusted PM only */
  TRUSTED_PM: { level: 'trusted' as PermissionLevel, pmOnly: true },
};

/**
 * Helper to check if a user can execute a command
 */
export function canExecute(
  username: string,
  userLevel: PermissionLevel,
  config: PermissionConfig,
  isPM: boolean,
  isAdmin: boolean
): { allowed: boolean; reason?: string } {
  // Check denied users
  if (config.deniedUsers?.includes(username)) {
    return { allowed: false, reason: 'User is denied access' };
  }

  // Check allowed users
  if (config.allowedUsers?.includes(username)) {
    return { allowed: true };
  }

  // Check PM/public only
  if (config.pmOnly && !isPM) {
    return { allowed: false, reason: 'Command can only be used in private messages' };
  }
  if (config.publicOnly && isPM) {
    return { allowed: false, reason: 'Command can only be used in public chat' };
  }

  // Check permission level
  const hierarchy: Record<PermissionLevel, number> = {
    guest: 0,
    trusted: 1,
    admin: 2,
  };

  if (hierarchy[userLevel] < hierarchy[config.level]) {
    return { allowed: false, reason: `Requires ${config.level} permission` };
  }

  return { allowed: true };
}

/**
 * Permission decorator for command classes
 */
export function RequirePermission(level: PermissionLevel, options?: Partial<PermissionConfig>) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    descriptor.value = async function (context: any) {
      const permissionManager = (this as any).permissionManager;
      if (!permissionManager) {
        console.warn('[PERMISSIONS] No permission manager available');
        return originalMethod.apply(this, arguments);
      }

      const check = permissionManager.checkCommandPermission(context.username, {
        level,
        ...options,
      });

      if (!check.allowed) {
        context.error(`❌ ${check.reason || 'Access denied'}`);
        return;
      }

      return originalMethod.apply(this, arguments);
    };
    return descriptor;
  };
}

/**
 * Permission mixin for classes that need permission checking
 */
export class PermissionMixin {
  protected permissionManager: PermissionManager | null = null;

  setPermissionManager(manager: PermissionManager): void {
    this.permissionManager = manager;
  }

  protected checkPermission(
    username: string,
    config: PermissionConfig,
    isPM: boolean,
    isAdmin: boolean
  ): { allowed: boolean; reason?: string } {
    if (!this.permissionManager) {
      return { allowed: true };
    }
    return this.permissionManager.checkCommandPermission(username, config);
  }

  protected getPermissionLevel(username: string): PermissionLevel {
    if (!this.permissionManager) {
      return 'guest';
    }
    return this.permissionManager.getPermissionLevel(username);
  }

  protected isAdmin(username: string): boolean {
    if (!this.permissionManager) {
      return false;
    }
    return this.permissionManager.isAdmin(username);
  }

  protected isTrusted(username: string): boolean {
    if (!this.permissionManager) {
      return false;
    }
    return this.permissionManager.isTrusted(username);
  }
}