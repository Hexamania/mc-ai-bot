/**
 * Command registry and execution system for mc-ai-bot
 * Provides a plugin-style command registration and execution framework
 */

import type { Bot } from 'mineflayer';
import type {
  CommandDefinition,
  CommandContext,
  CommandRegistry as CommandRegistryType,
  CommandResult,
  PermissionLevel,
} from '../types';

/**
 * Internal command registry implementation
 */
class CommandRegistryImpl implements CommandRegistryType {
  private commands = new Map<string, CommandDefinition>();
  private aliases = new Map<string, string>();

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

    this.commands.set(normalizedName, command);

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
      `[COMMANDS] Registered: ${normalizedName}${command.aliases ? ` (aliases: ${command.aliases.join(', ')})` : ''}`
    );
  }

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
      console.log(`[COMMANDS] Unregistered: ${normalizedName}`);
    }
  }

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

  getAll(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  getAliases(): Map<string, string> {
    return new Map(this.aliases);
  }

  getCategories(): string[] {
    const categories = new Set<string>();
    for (const command of this.commands.values()) {
      if (command.category) {
        categories.add(command.category);
      } else {
        categories.add('General');
      }
    }
    return Array.from(categories).sort();
  }

  getByCategory(category: string): CommandDefinition[] {
    const normalizedCategory = category.toLowerCase();
    return this.getAll().filter((cmd) => {
      const cmdCategory = (cmd.category || 'General').toLowerCase();
      return cmdCategory === normalizedCategory;
    });
  }

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

    // Check admin-only restriction
    if (command.adminOnly && !context.isAdmin) {
      return {
        success: false,
        found: true,
        error: 'Access denied. This command requires admin privileges.',
        executionTime: Date.now() - startTime,
      };
    }

    // Check PM-only restriction
    if (command.pmOnly && !context.isPM) {
      return {
        success: false,
        found: true,
        error: 'This command can only be used in private messages.',
        executionTime: Date.now() - startTime,
      };
    }

    try {
      await command.execute(context);
      return {
        success: true,
        found: true,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      console.error(`[COMMANDS] Error executing "${name}":`, error);
      return {
        success: false,
        found: true,
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Get command help text
   */
  getHelp(name: string, prefix: string): string | null {
    const command = this.get(name);
    if (!command) return null;

    let help = `\n📋 **${prefix}${command.name}**`;
    if (command.description) help += `\n${command.description}`;
    if (command.usage) help += `\nUsage: ${prefix}${command.name} ${command.usage}`;
    if (command.aliases && command.aliases.length > 0)
      help += `\nAliases: ${command.aliases.map((a) => `${prefix}${a}`).join(', ')}`;
    if (command.adminOnly) help += `\n⚠️ Admin only`;
    if (command.pmOnly) help += `\n📩 PM only`;
    return help;
  }

  /**
   * Get full help text for all commands visible to user level
   */
  getFullHelp(prefix: string, userLevel: PermissionLevel): string {
    const allCommands = this.getAll();
    const hierarchy: Record<PermissionLevel, number> = { guest: 0, trusted: 1, admin: 2 };
    const userLevelNum = hierarchy[userLevel];

    // Filter commands by permission level
    const visibleCommands = allCommands.filter((cmd) => {
      if (!cmd.permission) return true;
      const cmdLevelNum = hierarchy[cmd.permission.level] ?? 0;
      return cmdLevelNum <= userLevelNum;
    });

    // Categorize commands
    const byCategory = new Map<string, CommandDefinition[]>();
    for (const cmd of visibleCommands) {
      const category = cmd.category || 'General';
      if (!byCategory.has(category)) {
        byCategory.set(category, []);
      }
      byCategory.get(category)!.push(cmd);
    }

    let helpText = `📋 **Available Commands** (Prefix: \`${prefix}\`)\n\n`;

    for (const [category, commands] of byCategory.entries()) {
      helpText += `**${category}:**\n`;
      for (const cmd of commands) {
        const usage = cmd.usage ? ` ${cmd.usage}` : '';
        helpText += `  \`${prefix}${cmd.name}${usage}\` - ${cmd.description}\n`;
      }
      helpText += '\n';
    }

    helpText += `Use \`${prefix}help <command>\` for details on a specific command.`;
    return helpText;
  }

  /**
   * Register a help command
   */
  registerHelpCommand(prefix: string): void {
    this.register({
      name: 'help',
      aliases: ['h', 'commands'],
      description: 'Show available commands',
      usage: '[command]',
      category: 'General',
      permission: { level: 'guest' },
      execute: async (context) => {
        const { rawArgs, privateReply, isAdmin } = context;
        const userLevel: PermissionLevel = isAdmin ? 'admin' : 'guest';

        if (rawArgs.length > 0) {
          // Show help for specific command
          const help = this.getHelp(rawArgs[0], prefix);
          if (help) {
            privateReply(help);
          } else {
            privateReply(`❌ Command "${rawArgs[0]}" not found.`);
          }
          return;
        }

        // Show full help
        privateReply(this.getFullHelp(prefix, userLevel));
      },
    });
  }

  /**
   * Get all command names for help listing
   */
  getCommandNames(): string[] {
    return Array.from(this.commands.keys()).sort();
  }
}

/**
 * Singleton command registry instance
 */
let registryInstance: CommandRegistryImpl | null = null;

export function getCommandRegistry(): CommandRegistryType {
  if (!registryInstance) {
    registryInstance = new CommandRegistryImpl();
  }
  return registryInstance;
}

export function createCommandRegistry(): CommandRegistryType {
  return new CommandRegistryImpl();
}

/**
 * Helper to create a command context from bot message event
 */
export function createCommandContext(
  bot: Bot,
  username: string,
  args: string[],
  isAdmin: boolean,
  isPM: boolean,
  replyFn: (msg: string) => void,
  privateReplyFn: (msg: string) => void
): CommandContext {
  return {
    bot,
    username,
    args,
    rawArgs: args,
    isAdmin,
    isTrusted: false, // Default, can be overridden
    isPM,
    hasPermission: true, // Default, checked elsewhere
    reply: replyFn,
    privateReply: privateReplyFn,
    error: (msg: string) => replyFn(`❌ ${msg}`),
    permissionLevel: isAdmin ? 'admin' : 'guest',
    commandName: '',
    fullCommand: '',
    timestamp: Date.now(),
    metadata: {},
  };
}

/**
 * Parse command arguments from a message string
 */
export function parseCommand(
  message: string,
  prefix: string
): { command: string; args: string[] } | null {
  const trimmed = message.trim();

  if (!trimmed.startsWith(prefix)) {
    return null;
  }

  const content = trimmed.slice(prefix.length).trim();
  if (!content) {
    return null;
  }

  const parts = content.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  return { command, args };
}

/**
 * Format command usage string
 */
export function formatUsage(command: CommandDefinition, prefix: string): string {
  const base = `${prefix}${command.name}`;
  if (command.usage) {
    return `${base} ${command.usage}`;
  }
  return base;
}

/**
 * Built-in help command
 */
export function registerHelpCommand(registry: CommandRegistryType, prefix: string): void {
  registry.register({
    name: 'help',
    aliases: ['h', 'commands'],
    description: 'Show available commands',
    usage: '[command]',
    category: 'General',
    permission: { level: 'guest' },
    execute: async (context) => {
      const { rawArgs, reply, privateReply, isAdmin } = context;
      const allCommands = registry.getAll();

      if (rawArgs.length > 0) {
        // Show help for specific command
        const help = registry.getHelp(rawArgs[0], prefix);
        if (help) {
          privateReply(help);
        } else {
          privateReply(`❌ Command "${rawArgs[0]}" not found.`);
        }
        return;
      }

      // Categorize commands
      const publicCommands = allCommands.filter((c) => !c.adminOnly && !c.pmOnly);
      const adminCommands = allCommands.filter((c) => c.adminOnly);
      const pmCommands = allCommands.filter((c) => c.pmOnly && !c.adminOnly);

      let helpText = `📋 **Available Commands** (Prefix: \`${prefix}\`)\n\n`;

      if (publicCommands.length > 0) {
        helpText += `**Public:**\n${publicCommands.map((c) => `\`${prefix}${c.name}\``).join(', ')}\n\n`;
      }

      if (pmCommands.length > 0) {
        helpText += `**PM Only:**\n${pmCommands.map((c) => `\`${prefix}${c.name}\``).join(', ')}\n\n`;
      }

      if (adminCommands.length > 0 && isAdmin) {
        helpText += `**Admin:**\n${adminCommands.map((c) => `\`${prefix}${c.name}\``).join(', ')}\n\n`;
      }

      helpText += `Use \`${prefix}help <command>\` for details on a specific command.`;

      reply(helpText);
    },
  });
}

/**
 * Built-in ping command
 */
export function registerPingCommand(registry: CommandRegistryType): void {
  registry.register({
    name: 'ping',
    description: 'Check bot responsiveness',
    execute: async (context) => {
      context.reply('🏓 Pong!');
    },
  });
}

/**
 * Built-in status command
 */
export function registerStatusCommand(
  registry: CommandRegistryType,
  getStatusReport: () => string
): void {
  registry.register({
    name: 'status',
    description: 'Show bot status and progression info',
    execute: async (context) => {
      context.reply(getStatusReport());
    },
  });
}

/**
 * Built-in coords command
 */
export function registerCoordsCommand(registry: CommandRegistryType): void {
  registry.register({
    name: 'coords',
    aliases: ['pos', 'position'],
    description: 'Show current coordinates',
    execute: async (context) => {
      const { bot } = context;
      if (!bot.entity) {
        context.reply('❌ Bot not spawned yet.');
        return;
      }
      const { x, y, z } = bot.entity.position;
      context.reply(
        `📍 Current Location: X: ${Math.floor(x)}, Y: ${Math.floor(y)}, Z: ${Math.floor(z)}`
      );
    },
  });
}
