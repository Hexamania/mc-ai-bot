/**
 * Base Command class
 * Abstract base class for creating commands with full type safety
 */

import type {
  CommandDefinition,
  CommandContext,
  CommandArgument,
  CommandOption,
  PermissionConfig,
  ParsedArguments,
  PermissionLevel
} from './types';
import type { Bot } from 'mineflayer';

/**
 * Abstract base class for commands
 * Provides a structured way to define commands with proper typing
 */
export abstract class BaseCommand implements CommandDefinition {
  public readonly name: string;
  public readonly aliases: string[];
  public readonly description: string;
  public readonly usage?: string;
  public readonly shortDescription?: string;
  public readonly category?: string;
  public readonly permission: PermissionConfig;
  public readonly arguments: CommandArgument[];
  public readonly options: CommandOption[];
  public readonly examples: string[];
  public readonly hidden: boolean;
  public readonly deprecated: boolean;
  public readonly deprecationMessage?: string;
  public readonly cooldown?: number;
  public readonly maxUses?: number;

  protected constructor(config: BaseCommandConfig) {
    this.name = config.name.toLowerCase();
    this.aliases = config.aliases?.map(a => a.toLowerCase()) ?? [];
    this.description = config.description;
    this.usage = config.usage;
    this.shortDescription = config.shortDescription;
    this.category = config.category ?? 'General';
    this.permission = config.permission ?? { level: 'guest' };
    this.arguments = config.arguments ?? [];
    this.options = config.options ?? [];
    this.examples = config.examples ?? [];
    this.hidden = config.hidden ?? false;
    this.deprecated = config.deprecated ?? false;
    this.deprecationMessage = config.deprecationMessage;
    this.cooldown = config.cooldown;
    this.maxUses = config.maxUses;
  }

  /**
   * Execute the command - must be implemented by subclasses
   */
  public abstract execute(context: CommandContext): Promise<void> | void;

  /**
   * Optional validation before execution
   * Return true for success, string for error message
   */
  public validate(context: CommandContext): boolean | string | Promise<boolean | string> {
    return true;
  }

  /**
   * Optional cleanup after execution
   */
  public onComplete(context: CommandContext, error?: Error): void | Promise<void> {
    // Override in subclass if needed
  }

  /**
   * Optional autocomplete/suggestions
   */
  public autocomplete(context: CommandContext, partial: string): string[] | Promise<string[]> {
    return [];
  }

  /**
   * Get the full command definition
   */
  public getDefinition(): CommandDefinition {
    return {
      name: this.name,
      aliases: this.aliases,
      description: this.description,
      usage: this.usage,
      shortDescription: this.shortDescription,
      category: this.category,
      permission: this.permission,
      arguments: this.arguments,
      options: this.options,
      examples: this.examples,
      hidden: this.hidden,
      deprecated: this.deprecated,
      deprecationMessage: this.deprecationMessage,
      cooldown: this.cooldown,
      maxUses: this.maxUses,
      execute: this.execute.bind(this),
      validate: this.validate.bind(this),
      onComplete: this.onComplete.bind(this),
      autocomplete: this.autocomplete.bind(this),
    };
  }

  /**
   * Create a command context from raw parameters
   */
  protected createContext(
    bot: Bot,
    username: string,
    rawArgs: string[],
    isAdmin: boolean,
    isTrusted: boolean,
    isPM: boolean,
    reply: (msg: string) => void,
    privateReply: (msg: string) => void,
    permissionLevel: PermissionLevel,
    fullCommand: string
  ): CommandContext {
    const parsedArgs = this.parseArguments(rawArgs);
    const hasPermission = this.checkPermission(permissionLevel, isAdmin, isTrusted, isPM);

    return {
      bot,
      username,
      args: parsedArgs,
      rawArgs,
      isAdmin,
      isTrusted,
      isPM,
      hasPermission,
      reply,
      privateReply,
      error: (msg: string) => privateReply(`❌ ${msg}`),
      permissionLevel,
      commandName: this.name,
      fullCommand,
      timestamp: Date.now(),
      metadata: {},
    };
  }

  /**
   * Parse arguments based on command definition
   */
  protected parseArguments(rawArgs: string[]): ParsedArguments {
    const args: unknown[] = [];
    const options: Record<string, unknown> = {};
    const raw: string[] = [...rawArgs];

    let i = 0;
    while (i < rawArgs.length) {
      const arg = rawArgs[i];

      // Check for options (--flag or -f)
      if (arg.startsWith('--')) {
        const optionName = arg.slice(2);
        const optionDef = this.options.find(o => o.name === optionName);
        if (optionDef) {
          if (optionDef.hasValue) {
            i++;
            if (i < rawArgs.length) {
              options[optionName] = this.parseValue(rawArgs[i], optionDef.type);
            } else {
              options[optionName] = optionDef.defaultValue ?? true;
            }
          } else {
            options[optionName] = true;
          }
        } else {
          // Unknown option, treat as positional
          args.push(arg);
        }
      } else if (arg.startsWith('-') && arg.length > 1) {
        // Short options (-f, -abc)
        const shortOptions = arg.slice(1).split('');
        for (const shortOpt of shortOptions) {
          const optionDef = this.options.find(o => o.alias === shortOpt);
          if (optionDef) {
            if (optionDef.hasValue) {
              i++;
              if (i < rawArgs.length) {
                options[optionDef.name] = this.parseValue(rawArgs[i], optionDef.type);
              } else {
                options[optionDef.name] = optionDef.defaultValue ?? true;
              }
            } else {
              options[optionDef.name] = true;
            }
          } else {
            // Unknown short option
            args.push(arg);
            break;
          }
        }
      } else {
        // Positional argument
        args.push(arg);
      }
      i++;
    }

    // Apply defaults for missing options
    for (const option of this.options) {
      if (!(option.name in options) && option.defaultValue !== undefined) {
        options[option.name] = option.defaultValue;
      }
    }

    // Parse positional arguments according to definition
    const parsedPositional = this.parsePositionalArguments(args);

    return {
      args: parsedPositional,
      options,
      raw,
    };
  }

  /**
   * Parse positional arguments according to argument definitions
   */
  private parsePositionalArguments(rawPositional: unknown[]): unknown[] {
    const result: unknown[] = [];
    let argIndex = 0;

    for (const argDef of this.arguments) {
      if (argDef.greedy) {
        // Consume all remaining arguments
        const remaining = rawPositional.slice(argIndex);
        if (remaining.length > 0) {
          result.push(remaining.map(v => this.parseValue(v, argDef.type)));
        } else if (argDef.required) {
          throw new Error(`Missing required argument: ${argDef.name}`);
        } else if (argDef.defaultValue !== undefined) {
          result.push(argDef.defaultValue);
        }
        argIndex = rawPositional.length;
        break;
      } else {
        if (argIndex < rawPositional.length) {
          result.push(this.parseValue(rawPositional[argIndex], argDef.type));
          argIndex++;
        } else if (argDef.required) {
          throw new Error(`Missing required argument: ${argDef.name}`);
        } else if (argDef.defaultValue !== undefined) {
          result.push(argDef.defaultValue);
        }
      }
    }

    // Add any extra arguments
    while (argIndex < rawPositional.length) {
      result.push(rawPositional[argIndex]);
      argIndex++;
    }

    return result;
  }

  /**
   * Parse a value according to type
   */
  private parseValue(value: unknown, type: CommandArgument['type']): unknown {
    const str = String(value);

    switch (type) {
      case 'number': {
        const num = Number(str);
        if (isNaN(num)) throw new Error(`Expected number, got: ${str}`);
        return num;
      }
      case 'boolean':
        return str.toLowerCase() === 'true' || str === '1' || str.toLowerCase() === 'yes';
      case 'player':
        return str; // Player name, validation done elsewhere
      case 'position':
        return str; // Position string, parsed elsewhere
      case 'item':
        return str; // Item name, parsed elsewhere
      case 'enum':
        return str; // Enum value, validated elsewhere
      case 'string':
      default:
        return str;
    }
  }

  /**
   * Check if user has permission to execute this command
   */
  protected checkPermission(
    userLevel: PermissionLevel,
    isAdmin: boolean,
    isTrusted: boolean,
    isPM: boolean
  ): boolean {
    const { level, allowedUsers, deniedUsers, pmOnly, publicOnly } = this.permission;

    // Check denied users first (overrides everything)
    // Note: would need username here, so this is checked in registry

    // Check allowed users (bypasses level check)
    // Note: would need username here, so this is checked in registry

    // Check PM/public only restrictions
    if (pmOnly && !isPM) return false;
    if (publicOnly && isPM) return false;

    // Check permission level
    const levelHierarchy: Record<PermissionLevel, number> = {
      guest: 0,
      trusted: 1,
      admin: 2,
    };

    return levelHierarchy[userLevel] >= levelHierarchy[level];
  }

  /**
   * Format usage string for help
   */
  protected formatUsage(prefix: string): string {
    let usage = `${prefix}${this.name}`;
    if (this.usage) {
      usage += ` ${this.usage}`;
    }
    return usage;
  }

  /**
   * Send formatted help for this command
   */
  protected sendHelp(context: CommandContext, prefix: string): void {
    const lines: string[] = [];

    lines.push(`📋 **${this.name}**`);
    if (this.description) lines.push(this.description);
    if (this.usage) lines.push(`Usage: ${this.formatUsage(prefix)}`);
    if (this.aliases.length > 0) lines.push(`Aliases: ${this.aliases.map(a => `${prefix}${a}`).join(', ')}`);

    if (this.arguments.length > 0) {
      lines.push('\n**Arguments:**');
      for (const arg of this.arguments) {
        const required = arg.required ? 'required' : 'optional';
        const defaultStr = arg.defaultValue !== undefined ? ` (default: ${arg.defaultValue})` : '';
        lines.push(`  • ${arg.name}: ${arg.description} [${required}]${defaultStr}`);
      }
    }

    if (this.options.length > 0) {
      lines.push('\n**Options:**');
      for (const opt of this.options) {
        const aliasStr = opt.alias ? `, -${opt.alias}` : '';
        const valueStr = opt.hasValue ? ' <value>' : '';
        lines.push(`  • --${opt.name}${aliasStr}${valueStr}: ${opt.description}`);
      }
    }

    if (this.examples.length > 0) {
      lines.push('\n**Examples:**');
      for (const example of this.examples) {
        lines.push(`  ${prefix}${example}`);
      }
    }

    if (this.permission.level !== 'guest') {
      lines.push(`\n⚠️ Requires: ${this.permission.level}`);
    }
    if (this.permission.pmOnly) lines.push('📩 PM only');
    if (this.permission.publicOnly) lines.push('💬 Public only');

    context.privateReply(lines.join('\n'));
  }
}

/**
 * Configuration for BaseCommand constructor
 */
export interface BaseCommandConfig {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  shortDescription?: string;
  category?: string;
  permission?: PermissionConfig;
  arguments?: CommandArgument[];
  options?: CommandOption[];
  examples?: string[];
  hidden?: boolean;
  deprecated?: boolean;
  deprecationMessage?: string;
  cooldown?: number;
  maxUses?: number;
}

/**
 * Helper function to create a simple command without subclassing
 */
export function createCommand(definition: CommandDefinition): CommandDefinition {
  return definition;
}

/**
 * Command builder for fluent API
 */
export class CommandBuilder {
  private config: BaseCommandConfig = {
    name: '',
    description: '',
  };

  public setName(name: string): this {
    this.config.name = name;
    return this;
  }

  public setAliases(aliases: string[]): this {
    this.config.aliases = aliases;
    return this;
  }

  public setDescription(description: string): this {
    this.config.description = description;
    return this;
  }

  public setUsage(usage: string): this {
    this.config.usage = usage;
    return this;
  }

  public setShortDescription(shortDescription: string): this {
    this.config.shortDescription = shortDescription;
    return this;
  }

  public setCategory(category: string): this {
    this.config.category = category;
    return this;
  }

  public setPermission(permission: PermissionConfig): this {
    this.config.permission = permission;
    return this;
  }

  public setArguments(arguments_: CommandArgument[]): this {
    this.config.arguments = arguments_;
    return this;
  }

  public setOptions(options: CommandOption[]): this {
    this.config.options = options;
    return this;
  }

  public setExamples(examples: string[]): this {
    this.config.examples = examples;
    return this;
  }

  public setHidden(hidden: boolean): this {
    this.config.hidden = hidden;
    return this;
  }

  public setDeprecated(deprecated: boolean, message?: string): this {
    this.config.deprecated = deprecated;
    this.config.deprecationMessage = message;
    return this;
  }

  public setCooldown(cooldown: number, maxUses?: number): this {
    this.config.cooldown = cooldown;
    this.config.maxUses = maxUses;
    return this;
  }

  public setExecute(execute: (context: CommandContext) => Promise<void> | void): this {
    // Store execute in a way we can use it
    (this.config as any)._execute = execute;
    return this;
  }

  public build(): CommandDefinition {
    if (!this.config.name) throw new Error('Command name is required');
    if (!this.config.description) throw new Error('Command description is required');
    if (!(this.config as any)._execute) throw new Error('Command execute function is required');

    return {
      name: this.config.name,
      aliases: this.config.aliases,
      description: this.config.description,
      usage: this.config.usage,
      shortDescription: this.config.shortDescription,
      category: this.config.category,
      permission: this.config.permission,
      arguments: this.config.arguments,
      options: this.config.options,
      examples: this.config.examples,
      hidden: this.config.hidden,
      deprecated: this.config.deprecated,
      deprecationMessage: this.config.deprecationMessage,
      cooldown: this.config.cooldown,
      maxUses: this.config.maxUses,
      execute: (this.config as any)._execute,
      validate: this.config.validate,
      onComplete: this.config.onComplete,
      autocomplete: this.config.autocomplete,
    };
  }
}