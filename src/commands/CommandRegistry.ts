/**
 * Command Registry
 * Central registry for managing commands, permissions, cooldowns, and execution
 */

import type {
  CommandDefinition,
  CommandRegistry as CommandRegistryInterface,
  CommandContext,
  CommandResult,
  PermissionLevel,
  CooldownEntry,
  CommandStats,
} from './types';

/**
 * Default permission hierarchy
 */
const PERMISSION_HIERARCHY: Record<PermissionLevel, number> = {
  guest: 0,
  trusted: 1,
  admin: 2,
};

/**
 * Command Registry Implementation
 */
export class CommandRegistryImpl implements CommandRegistryInterface {
  private commands = new Map<string, CommandDefinition>();
  private aliases = new Map<string, string>();
  private categories = new Set<string>();
  private cooldowns = new Map<string, CooldownEntry>();
  private stats = new Map<string, CommandStats>();
  private prefix = '!';
  private adminPrefix = '$';

  constructor(prefix = '!', adminPrefix = '$') {
    this.prefix = prefix;
    this.adminPrefix = adminPrefix;
  }

  /**
   * Register a command
   */
  register(command: CommandDefinition): void {
    // Validate command
    if (!command.name || typeof command.name !== 'string') {
      throw new Error('Command must have a valid name');
    }
    if (!command.execute || typeof command.execute !== 'function') {
      throw new Error(`Command "${command.name}" must have an execute function`);
    }

    const normalizedName = command.name.toLowerCase();

    // Check for conflicts
    if (this.commands.has(normalizedName)) {
      console.warn(`[COMMANDS] Command "${normalizedName}" is being overridden`);
    }

    // Set default category if not provided
    if (!command.category) {
      command.category = 'General';
    }
    this.categories.add(command.category);

    this.commands.set(normalizedName, command);

    // Initialize stats
    this.stats.set(normalizedName, {
      name: normalizedName,
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      avgExecutionTime: 0,
      lastExecuted: null,
    });

    // Register aliases
    if (command.aliases && Array.isArray(command.aliases)) {
      for (const alias of command.aliases) {
        const normalizedAlias = alias.toLowerCase();
        if (this.aliases.has(normalizedAlias) || this.commands.has(normalizedAlias)) {
          console.warn(`[COMMANDS] Alias "${normalizedAlias}" conflicts with existing command`);
        } else {
          this.aliases.set(normalizedAlias, normalizedName);
        }
      }
    }

    console.log(
      `[COMMANDS] Registered: ${normalizedName}${command.aliases ? ` (aliases: ${command.aliases.join(', ')})` : ''} [${command.category}]`
    );
  }

  /**
   * Unregister a command
   */
  unregister(name: string): void {
    const normalizedName = name.toLowerCase();
    const command = this.commands.get(normalizedName);

    if (command) {
      // Remove aliases
      if (command.aliases) {
        for (const alias of command.aliases) {
          this.aliases.delete(alias.toLowerCase());
        }
      }
      this.commands.delete(normalizedName);
      this.stats.delete(normalizedName);
      this.cooldowns.delete(normalizedName);
      console.log(`[COMMANDS] Unregistered: ${normalizedName}`);
    }
  }

  /**
   * Get a command by name or alias
   */
  get(name: string): CommandDefinition | undefined {
    const normalizedName = name.toLowerCase();
    // Check direct command
    if (this.commands.has(normalizedName)) {
      return this.commands.get(normalizedName);
    }
    // Check aliases
    const aliasTarget = this.aliases.get(normalizedName);
    if (aliasTarget) {
      return this.commands.get(aliasTarget);
    }
    return undefined;
  }

  /**
   * Get all registered commands
   */
  getAll(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  /**
   * Get commands by category
   */
  getByCategory(category: string): CommandDefinition[] {
    return this.getAll().filter((c) => c.category === category);
  }

  /**
   * Execute a command
   */
  async execute(name: string, context: CommandContext): Promise<CommandResult> {
    const startTime = Date.now();
    const command = this.get(name);

    if (!command) {
      return {
        success: false,
        found: false,
        error: `Command "${name}" not found`,
        executionTime: Date.now() - startTime,
      };
    }

    // Check if deprecated
    if (command.deprecated) {
      const msg = command.deprecationMessage || `This command is deprecated.`;
      context.error(`⚠️ ${msg}`);
    }

    // Check permission
    const permissionCheck = this.checkPermission(command, context);
    if (!permissionCheck.allowed) {
      context.error(permissionCheck.message ?? '❌ Access denied. Insufficient permissions.');
      return {
        success: false,
        found: true,
        error: permissionCheck.message ?? 'Permission denied',
        executionTime: Date.now() - startTime,
      };
    }

    // Check cooldown
    const cooldownCheck = this.checkCooldown(command, context);
    if (!cooldownCheck.allowed) {
      context.error(
        `⏳ Command on cooldown. Try again in ${Math.ceil(cooldownCheck.remaining! / 1000)}s.`
      );
      return {
        success: false,
        found: true,
        error: 'Command on cooldown',
        executionTime: Date.now() - startTime,
      };
    }

    // Validate
    if (command.validate) {
      const validation = await command.validate(context);
      if (validation !== true) {
        const errorMsg = typeof validation === 'string' ? validation : 'Validation failed';
        context.error(`❌ ${errorMsg}`);
        return {
          success: false,
          found: true,
          error: errorMsg,
          executionTime: Date.now() - startTime,
        };
      }
    }

    // Update cooldown
    this.updateCooldown(command, context);

    try {
      // Execute command
      await command.execute(context);

      // Update stats
      this.updateStats(command.name, Date.now() - startTime, true);

      // Call onComplete
      if (command.onComplete) {
        await command.onComplete(context);
      }

      return {
        success: true,
        found: true,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[COMMANDS] Error executing "${name}":`, error);

      // Update stats
      this.updateStats(command.name, Date.now() - startTime, false, errorMessage);

      // Call onComplete with error
      if (command.onComplete) {
        await command.onComplete(context, error instanceof Error ? error : new Error(errorMessage));
      }

      // Send error to user
      context.error(`❌ Command error: ${errorMessage}`);

      return {
        success: false,
        found: true,
        error: errorMessage,
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Check if a command exists
   */
  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /**
   * Get command names for autocomplete
   */
  getCommandNames(): string[] {
    return Array.from(this.commands.keys()).sort();
  }

  /**
   * Get all aliases
   */
  getAliases(): Map<string, string> {
    return new Map(this.aliases);
  }

  /**
   * Get command categories
   */
  getCategories(): string[] {
    return Array.from(this.categories).sort();
  }

  /**
   * Get help for a specific command
   */
  getHelp(name: string, prefix: string): string | null {
    const command = this.get(name);
    if (!command) return null;

    let help = `\n📋 **${command.name}**`;
    if (command.description) help += `\n${command.description}`;
    if (command.usage) help += `\nUsage: ${prefix}${command.name} ${command.usage}`;
    if (command.aliases && command.aliases.length > 0)
      help += `\nAliases: ${command.aliases.join(', ')}`;
    if (command.examples && command.examples.length > 0) {
      help += `\nExamples:`;
      for (const example of command.examples) {
        help += `\n  ${prefix}${example}`;
      }
    }
    const perm = command.permission;
    if (perm && perm.level !== 'guest') help += `\n⚠️ Requires: ${perm.level}`;
    if (perm?.pmOnly) help += `\n📩 PM only`;
    if (perm?.publicOnly) help += `\n💬 Public only`;
    if (command.cooldown) help += `\n⏱️ Cooldown: ${command.cooldown / 1000}s`;
    return help;
  }

  /**
   * Get full help text for all commands
   */
  getFullHelp(prefix: string, userLevel: PermissionLevel): string {
    const allCommands = this.getAll();
    const userLevelValue = PERMISSION_HIERARCHY[userLevel];

    // Filter commands by permission
    const accessibleCommands = allCommands.filter((cmd) => {
      const cmdLevelValue = PERMISSION_HIERARCHY[cmd.permission?.level ?? 'guest'];
      return cmdLevelValue <= userLevelValue && !cmd.hidden;
    });

    // Categorize commands
    const categorized: Record<string, CommandDefinition[]> = {};
    for (const cmd of accessibleCommands) {
      const cat = cmd.category || 'General';
      if (!categorized[cat]) categorized[cat] = [];
      categorized[cat].push(cmd);
    }

    let helpText = `📋 **Available Commands** (Prefix: \`${prefix}\`)\n\n`;

    // Sort categories alphabetically
    const sortedCategories = Object.keys(categorized).sort();

    for (const category of sortedCategories) {
      const cmds = categorized[category];
      helpText += `**${category}:**\n`;
      const cmdList = cmds
        .map((c) => {
          let cmdStr = `\`${prefix}${c.name}\``;
          if (c.shortDescription) cmdStr += ` - ${c.shortDescription}`;
          return cmdStr;
        })
        .join('\n');
      helpText += `${cmdList}\n\n`;
    }

    helpText += `Use \`${prefix}help <command>\` for details on a specific command.`;

    return helpText;
  }

  /**
   * Register the built-in help command
   */
  registerHelpCommand(prefix: string = this.prefix): void {
    this.register({
      name: 'help',
      aliases: ['h', 'commands', 'cmds'],
      description: 'Show available commands',
      usage: '[command]',
      shortDescription: 'Show command list or get help for a specific command',
      category: 'General',
      permission: { level: 'guest' },
      arguments: [
        {
          name: 'command',
          description: 'Command to get help for',
          required: false,
          type: 'string',
        },
      ],
      examples: ['help', 'help ping', 'help follow'],
      execute: async (context) => {
        const { args, privateReply, permissionLevel } = context;

        if (args.args.length > 0) {
          // Show help for specific command
          const help = this.getHelp(args.args[0] as string, prefix);
          if (help) {
            privateReply(help);
          } else {
            privateReply(`❌ Command "${args.args[0]}" not found.`);
          }
          return;
        }

        // Show full help
        privateReply(this.getFullHelp(prefix, permissionLevel));
      },
    });
  }

  /**
   * Register a simple ping command
   */
  registerPingCommand(): void {
    this.register({
      name: 'ping',
      description: 'Check bot responsiveness',
      shortDescription: 'Check if bot is responsive',
      category: 'General',
      permission: { level: 'guest' },
      execute: async (context) => {
        context.reply('🏓 Pong!');
      },
    });
  }

  /**
   * Check command permission
   */
  private checkPermission(
    command: CommandDefinition,
    context: CommandContext
  ): { allowed: boolean; message?: string } {
    const permission = command.permission ?? { level: 'guest' as PermissionLevel };
    const { username, isPM, permissionLevel } = context;

    // Check denied users
    if (permission.deniedUsers?.includes(username)) {
      return { allowed: false, message: '❌ You are not allowed to use this command.' };
    }

    // Check allowed users (bypasses level check)
    if (permission.allowedUsers?.includes(username)) {
      return { allowed: true };
    }

    // Check PM/public only
    if (permission.pmOnly && !isPM) {
      return { allowed: false, message: '❌ This command can only be used in private messages.' };
    }
    if (permission.publicOnly && isPM) {
      return { allowed: false, message: '❌ This command can only be used in public chat.' };
    }

    // Check permission level
    const userLevelValue = PERMISSION_HIERARCHY[permissionLevel];
    const requiredLevelValue = PERMISSION_HIERARCHY[permission.level];

    if (userLevelValue < requiredLevelValue) {
      return {
        allowed: false,
        message: `❌ Access denied. This command requires ${permission.level} permission.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check command cooldown
   */
  private checkCooldown(
    command: CommandDefinition,
    context: CommandContext
  ): { allowed: boolean; remaining?: number } {
    if (!command.cooldown) return { allowed: true };

    const key = `${command.name}:${context.username}`;
    const entry = this.cooldowns.get(key);
    const now = Date.now();

    if (!entry) return { allowed: true };

    // Check if we're in a new window
    if (now - entry.windowStart >= command.cooldown) {
      return { allowed: true };
    }

    // Check max uses
    if (command.maxUses && entry.uses >= command.maxUses) {
      const remaining = command.cooldown - (now - entry.windowStart);
      return { allowed: false, remaining };
    }

    return { allowed: true };
  }

  /**
   * Update command cooldown
   */
  private updateCooldown(command: CommandDefinition, context: CommandContext): void {
    if (!command.cooldown) return;

    const key = `${command.name}:${context.username}`;
    const now = Date.now();
    const entry = this.cooldowns.get(key);

    if (!entry || now - entry.windowStart >= command.cooldown) {
      // New window
      this.cooldowns.set(key, {
        lastUsed: now,
        uses: 1,
        windowStart: now,
      });
    } else {
      // Increment uses in current window
      entry.uses++;
      entry.lastUsed = now;
    }
  }

  /**
   * Update command statistics
   */
  private updateStats(
    commandName: string,
    executionTime: number,
    success: boolean,
    error?: string
  ): void {
    const stats = this.stats.get(commandName);
    if (!stats) return;

    stats.totalExecutions++;
    stats.lastExecuted = Date.now();

    if (success) {
      stats.successfulExecutions++;
    } else {
      stats.failedExecutions++;
      if (error) {
        stats.mostCommonError = error;
      }
    }

    // Update average execution time (exponential moving average)
    stats.avgExecutionTime = stats.avgExecutionTime * 0.9 + executionTime * 0.1;
  }

  /**
   * Get command statistics
   */
  getStats(commandName?: string): CommandStats[] {
    if (commandName) {
      const stats = this.stats.get(commandName.toLowerCase());
      return stats ? [stats] : [];
    }
    return Array.from(this.stats.values()).sort((a, b) => b.totalExecutions - a.totalExecutions);
  }

  /**
   * Clear cooldown for a user/command
   */
  clearCooldown(commandName: string, username: string): void {
    const key = `${commandName.toLowerCase()}:${username}`;
    this.cooldowns.delete(key);
  }

  /**
   * Clear all cooldowns
   */
  clearAllCooldowns(): void {
    this.cooldowns.clear();
  }

  /**
   * Set command prefix
   */
  setPrefix(prefix: string): void {
    this.prefix = prefix;
  }

  /**
   * Set admin prefix
   */
  setAdminPrefix(prefix: string): void {
    this.adminPrefix = prefix;
  }

  /**
   * Get command prefix
   */
  getPrefix(): string {
    return this.prefix;
  }

  /**
   * Get admin prefix
   */
  getAdminPrefix(): string {
    return this.adminPrefix;
  }
}

/**
 * Create a new command registry
 */
export function createCommandRegistry(
  prefix?: string,
  adminPrefix?: string
): CommandRegistryInterface {
  return new CommandRegistryImpl(prefix, adminPrefix);
}

/**
 * Singleton command registry instance
 */
let registryInstance: CommandRegistryImpl | null = null;

/**
 * Get the singleton command registry instance
 */
export function getCommandRegistry(
  prefix?: string,
  adminPrefix?: string
): CommandRegistryInterface {
  if (!registryInstance) {
    registryInstance = new CommandRegistryImpl(prefix, adminPrefix);
  }
  return registryInstance;
}

/**
 * Reset the singleton registry (for testing)
 */
export function resetCommandRegistry(): void {
  registryInstance = null;
}
