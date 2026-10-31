/**
 * Argument Parsing System
 * Advanced argument parsing with type validation, autocomplete, and error handling
 */

import type { CommandArgument, CommandOption, ParsedArguments } from './types';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

/**
 * Argument parser result
 */
export interface ParseResult<T = unknown> {
  /** Whether parsing succeeded */
  success: boolean;
  /** Parsed value */
  value?: T;
  /** Error message if failed */
  error?: string;
  /** Remaining unparsed arguments */
  remaining?: string[];
}

/**
 * Argument parser class
 * Handles parsing and validation of command arguments
 */
export class ArgumentParser {
  private bot: Bot | null = null;

  constructor(bot?: Bot) {
    this.bot = bot || null;
  }

  /**
   * Set bot instance for player/position lookups
   */
  setBot(bot: Bot): void {
    this.bot = bot;
  }

  /**
   * Parse raw arguments according to command definition
   */
  parse(
    rawArgs: string[],
    argsDef: CommandArgument[],
    optionsDef: CommandOption[]
  ): ParsedArguments {
    const positionalArgs: unknown[] = [];
    const options: Record<string, unknown> = {};
    const raw: string[] = [...rawArgs];

    let argIndex = 0;
    let i = 0;

    // First pass: extract options
    const remainingArgs: string[] = [];
    while (i < rawArgs.length) {
      const arg = rawArgs[i];

      if (arg.startsWith('--')) {
        // Long option (--flag)
        const optionName = arg.slice(2);
        const optionDef = optionsDef.find((o) => o.name === optionName);

        if (optionDef) {
          if (optionDef.hasValue) {
            i++;
            if (i < rawArgs.length) {
              const parsed = this.parseValue(rawArgs[i], optionDef.type);
              if (parsed.success) {
                options[optionName] = parsed.value;
              } else {
                options[optionName] = optionDef.defaultValue ?? true;
              }
            } else {
              options[optionName] = optionDef.defaultValue ?? true;
            }
          } else {
            options[optionName] = true;
          }
        } else {
          // Unknown option, treat as positional
          remainingArgs.push(arg);
        }
      } else if (arg.startsWith('-') && arg.length > 1 && arg !== '-') {
        // Short options (-f, -abc)
        const shortOptions = arg.slice(1).split('');
        let handledShort = true;

        for (const shortOpt of shortOptions) {
          const optionDef = optionsDef.find((o) => o.alias === shortOpt);
          if (optionDef) {
            if (optionDef.hasValue) {
              i++;
              if (i < rawArgs.length) {
                const parsed = this.parseValue(rawArgs[i], optionDef.type);
                if (parsed.success) {
                  options[optionDef.name] = parsed.value;
                } else {
                  options[optionDef.name] = optionDef.defaultValue ?? true;
                }
              } else {
                options[optionDef.name] = optionDef.defaultValue ?? true;
              }
            } else {
              options[optionDef.name] = true;
            }
          } else {
            handledShort = false;
            break;
          }
        }

        if (!handledShort) {
          remainingArgs.push(arg);
        }
      } else {
        // Positional argument
        remainingArgs.push(arg);
      }
      i++;
    }

    // Second pass: parse positional arguments
    for (const argDef of argsDef) {
      if (argDef.greedy) {
        // Consume all remaining arguments
        const remaining = remainingArgs.slice(argIndex);
        if (remaining.length > 0) {
          const parsed = remaining.map((v) => this.parseValue(v, argDef.type));
          if (parsed.every((p) => p.success)) {
            positionalArgs.push(parsed.map((p) => p.value));
          } else {
            // If any fail, push raw values
            positionalArgs.push(remaining);
          }
        } else if (argDef.required) {
          throw new Error(`Missing required argument: ${argDef.name}`);
        } else if (argDef.defaultValue !== undefined) {
          positionalArgs.push(argDef.defaultValue);
        }
        argIndex = remainingArgs.length;
        break;
      } else {
        if (argIndex < remainingArgs.length) {
          const parsed = this.parseValue(remainingArgs[argIndex], argDef.type, argDef);
          if (parsed.success) {
            positionalArgs.push(parsed.value);
          } else {
            // If parsing fails, use raw value
            positionalArgs.push(remainingArgs[argIndex]);
          }
          argIndex++;
        } else if (argDef.required) {
          throw new Error(`Missing required argument: ${argDef.name}`);
        } else if (argDef.defaultValue !== undefined) {
          positionalArgs.push(argDef.defaultValue);
        }
      }
    }

    // Add any extra arguments
    while (argIndex < remainingArgs.length) {
      positionalArgs.push(remainingArgs[argIndex]);
      argIndex++;
    }

    // Apply defaults for missing options
    for (const option of optionsDef) {
      if (!(option.name in options) && option.defaultValue !== undefined) {
        options[option.name] = option.defaultValue;
      }
    }

    return {
      args: positionalArgs,
      options,
      raw,
    };
  }

  /**
   * Parse a single value according to type
   */
  parseValue(value: string, type: CommandArgument['type'], argDef?: CommandArgument): ParseResult {
    const str = value.trim();

    // Handle empty string
    if (!str) {
      if (argDef?.defaultValue !== undefined) {
        return { success: true, value: argDef.defaultValue };
      }
      return { success: false, error: 'Empty value' };
    }

    switch (type) {
      case 'string':
        return { success: true, value: str };

      case 'number': {
        const num = Number(str);
        if (isNaN(num)) {
          return { success: false, error: `Expected number, got: ${str}` };
        }
        // Check validator if provided
        if (argDef?.validator) {
          const validation = argDef.validator(num);
          if (validation !== true) {
            return {
              success: false,
              error: typeof validation === 'string' ? validation : 'Validation failed',
            };
          }
        }
        return { success: true, value: num };
      }

      case 'boolean': {
        const bool =
          str.toLowerCase() === 'true' ||
          str === '1' ||
          str.toLowerCase() === 'yes' ||
          str.toLowerCase() === 'on';
        return { success: true, value: bool };
      }

      case 'player': {
        if (!this.bot) {
          return { success: true, value: str }; // Can't validate without bot
        }
        const player = this.bot.players[str];
        if (!player) {
          return { success: false, error: `Player "${str}" not found` };
        }
        return { success: true, value: player };
      }

      case 'position': {
        // Parse position formats: "x y z", "x,y,z", "~ ~ ~", "~1 ~2 ~3"
        const parsed = this.parsePosition(str);
        if (!parsed.success) {
          return { success: false, error: `Invalid position format: ${str}` };
        }
        return { success: true, value: parsed.value };
      }

      case 'item': {
        if (!this.bot) {
          return { success: true, value: str };
        }
        // Try to find item by name
        const item = this.bot.registry.itemsByName[str];
        if (!item) {
          // Try partial match
          const matches = Object.values(this.bot.registry.itemsByName).filter((i) =>
            i.name.toLowerCase().includes(str.toLowerCase())
          );
          if (matches.length === 1) {
            return { success: true, value: matches[0] };
          }
          if (matches.length > 1) {
            return {
              success: false,
              error: `Ambiguous item: ${str}. Matches: ${matches.map((m) => m.name).join(', ')}`,
            };
          }
          return { success: false, error: `Item "${str}" not found` };
        }
        return { success: true, value: item };
      }

      case 'enum': {
        if (!argDef?.enumValues || argDef.enumValues.length === 0) {
          return { success: true, value: str };
        }
        const matching = argDef.enumValues.find((v) => v.toLowerCase() === str.toLowerCase());
        if (!matching) {
          return {
            success: false,
            error: `Invalid value: ${str}. Allowed: ${argDef.enumValues.join(', ')}`,
          };
        }
        return { success: true, value: matching };
      }

      default:
        return { success: true, value: str };
    }
  }

  /**
   * Parse position string
   * Supports: "x y z", "x,y,z", "~ ~ ~", "~1 ~2 ~3", "x y z relative"
   */
  parsePosition(str: string): ParseResult<Vec3> {
    const trimmed = str.trim();

    // Check for relative coordinates (~)
    if (trimmed.includes('~')) {
      if (!this.bot || !this.bot.entity) {
        return { success: false, error: 'Cannot parse relative position: bot not spawned' };
      }
      const currentPos = this.bot.entity.position;

      // Split by spaces or commas
      const parts = trimmed.split(/[\s,]+/).filter((p) => p);
      if (parts.length !== 3) {
        return {
          success: false,
          error: 'Relative position requires 3 coordinates (e.g., "~ ~ ~" or "~1 ~2 ~3")',
        };
      }

      const coords = parts.map((part, i) => {
        const axis = ['x', 'y', 'z'][i] as 'x' | 'y' | 'z';
        const current = currentPos[axis];

        if (part === '~') {
          return current;
        }

        // Relative offset (~5, ~-2, etc.)
        if (part.startsWith('~')) {
          const offset = parseFloat(part.slice(1));
          if (isNaN(offset)) {
            throw new Error(`Invalid relative coordinate: ${part}`);
          }
          return current + offset;
        }

        // Absolute coordinate
        const absolute = parseFloat(part);
        if (isNaN(absolute)) {
          throw new Error(`Invalid coordinate: ${part}`);
        }
        return absolute;
      });

      return { success: true, value: new Vec3(coords[0], coords[1], coords[2]) };
    }

    // Absolute coordinates
    const parts = trimmed.split(/[\s,]+/).filter((p) => p);
    if (parts.length !== 3) {
      return { success: false, error: 'Position requires 3 coordinates (x y z)' };
    }

    const coords = parts.map((p) => {
      const num = parseFloat(p);
      if (isNaN(num)) {
        throw new Error(`Invalid coordinate: ${p}`);
      }
      return num;
    });

    return { success: true, value: new Vec3(coords[0], coords[1], coords[2]) };
  }

  /**
   * Get autocomplete suggestions for an argument
   */
  getSuggestions(
    partial: string,
    argDef: CommandArgument,
    context: { bot?: Bot; players?: string[]; items?: string[]; positions?: Vec3[] } = {}
  ): string[] {
    const bot = context.bot || this.bot;
    const lowerPartial = partial.toLowerCase();

    switch (argDef.type) {
      case 'player':
        if (!bot) return [];
        return Object.keys(bot.players)
          .filter((name) => name.toLowerCase().startsWith(lowerPartial))
          .slice(0, 10);

      case 'item':
        if (!bot) return [];
        return Object.keys(bot.registry.itemsByName)
          .filter((name) => name.toLowerCase().includes(lowerPartial))
          .slice(0, 10);

      case 'position': {
        // Suggest current position and relative
        if (!bot?.entity) return ['~ ~ ~'];
        const pos = bot.entity.position;
        return [
          `~ ~ ~`,
          `~${Math.floor(pos.x)} ~${Math.floor(pos.y)} ~${Math.floor(pos.z)}`,
          `${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`,
        ].filter((s) => s.toLowerCase().startsWith(lowerPartial));
      }

      case 'enum':
        if (!argDef.enumValues) return [];
        return argDef.enumValues
          .filter((v) => v.toLowerCase().startsWith(lowerPartial))
          .slice(0, 10);

      case 'number':
        // Suggest common numbers
        return ['1', '10', '64', '100', '1000'].filter((n) => n.startsWith(partial)).slice(0, 5);

      case 'boolean':
        return ['true', 'false'].filter((b) => b.startsWith(lowerPartial));

      case 'string':
      default:
        // Could provide custom suggestions from argDef
        return [];
    }
  }

  /**
   * Format argument for display in help
   */
  formatArgument(argDef: CommandArgument): string {
    const required = argDef.required ? '<' : '[';
    const end = argDef.required ? '>' : ']';

    let typeStr: string = argDef.type;
    if (argDef.type === 'enum' && argDef.enumValues) {
      typeStr = argDef.enumValues.join('|');
    }

    let result = `${required}${argDef.name}: ${typeStr}${end}`;
    if (argDef.defaultValue !== undefined) {
      result += ` (default: ${argDef.defaultValue})`;
    }
    if (argDef.greedy) {
      result += '...';
    }
    return result;
  }

  /**
   * Format option for display in help
   */
  formatOption(optionDef: CommandOption): string {
    const aliasStr = optionDef.alias ? `, -${optionDef.alias}` : '';
    const valueStr = optionDef.hasValue ? ` <${optionDef.type}>` : '';
    const defaultStr =
      optionDef.defaultValue !== undefined ? ` (default: ${optionDef.defaultValue})` : '';
    return `--${optionDef.name}${aliasStr}${valueStr}${defaultStr}: ${optionDef.description}`;
  }

  /**
   * Validate parsed arguments against definitions
   */
  validate(
    parsed: ParsedArguments,
    argsDef: CommandArgument[],
    optionsDef: CommandOption[]
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate positional arguments
    for (let i = 0; i < argsDef.length; i++) {
      const argDef = argsDef[i];
      const value = parsed.args[i];

      if (argDef.required && (value === undefined || value === null)) {
        errors.push(`Missing required argument: ${argDef.name}`);
        continue;
      }

      if (value !== undefined && value !== null && argDef.validator) {
        const validation = argDef.validator(value);
        if (validation !== true) {
          errors.push(
            typeof validation === 'string' ? validation : `Invalid value for ${argDef.name}`
          );
        }
      }

      if (argDef.type === 'enum' && argDef.enumValues && value !== undefined) {
        const strVal = String(value);
        if (!argDef.enumValues.includes(strVal)) {
          errors.push(
            `Invalid value for ${argDef.name}: ${strVal}. Allowed: ${argDef.enumValues.join(', ')}`
          );
        }
      }
    }

    // Validate options
    for (const optionDef of optionsDef) {
      const value = parsed.options[optionDef.name];

      if (optionDef.hasValue && value !== undefined && value !== null) {
        // Could add type validation here
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

/**
 * Create an argument parser instance
 */
export function createArgumentParser(bot?: Bot): ArgumentParser {
  return new ArgumentParser(bot);
}

/**
 * Common argument definitions for reuse
 */
export const CommonArguments = {
  player: (required = true): CommandArgument => ({
    name: 'player',
    description: 'Target player name',
    required,
    type: 'player',
  }),

  playerOptional: (): CommandArgument => ({
    name: 'player',
    description: 'Target player name (defaults to sender)',
    required: false,
    type: 'player',
  }),

  position: (required = true): CommandArgument => ({
    name: 'position',
    description: 'Target position (x y z or ~ ~ ~ for relative)',
    required,
    type: 'position',
  }),

  positionOptional: (): CommandArgument => ({
    name: 'position',
    description: 'Target position (defaults to current position)',
    required: false,
    type: 'position',
  }),

  item: (required = true): CommandArgument => ({
    name: 'item',
    description: 'Item name or ID',
    required,
    type: 'item',
  }),

  number: (name: string, description: string, required = true): CommandArgument => ({
    name,
    description,
    required,
    type: 'number',
  }),

  integer: (
    name: string,
    description: string,
    required = true,
    min?: number,
    max?: number
  ): CommandArgument => ({
    name,
    description,
    required,
    type: 'number',
    validator: (value) => {
      const num = Number(value);
      if (!Number.isInteger(num)) return 'Must be an integer';
      if (min !== undefined && num < min) return `Must be at least ${min}`;
      if (max !== undefined && num > max) return `Must be at most ${max}`;
      return true;
    },
  }),

  string: (name: string, description: string, required = true): CommandArgument => ({
    name,
    description,
    required,
    type: 'string',
  }),

  boolean: (name: string, description: string, required = false): CommandArgument => ({
    name,
    description,
    required,
    type: 'boolean',
  }),

  enum: (
    name: string,
    description: string,
    values: string[],
    required = true
  ): CommandArgument => ({
    name,
    description,
    required,
    type: 'enum',
    enumValues: values,
  }),

  greedyString: (name: string, description: string, required = true): CommandArgument => ({
    name,
    description,
    required,
    type: 'string',
    greedy: true,
  }),
};

/**
 * Common option definitions for reuse
 */
export const CommonOptions = {
  help: (): CommandOption => ({
    name: 'help',
    alias: 'h',
    description: 'Show help for this command',
    hasValue: false,
    type: 'boolean',
  }),

  verbose: (): CommandOption => ({
    name: 'verbose',
    alias: 'v',
    description: 'Enable verbose output',
    hasValue: false,
    type: 'boolean',
  }),

  quiet: (): CommandOption => ({
    name: 'quiet',
    alias: 'q',
    description: 'Suppress output',
    hasValue: false,
    type: 'boolean',
  }),

  force: (): CommandOption => ({
    name: 'force',
    alias: 'f',
    description: 'Force execution without confirmation',
    hasValue: false,
    type: 'boolean',
  }),

  dryRun: (): CommandOption => ({
    name: 'dry-run',
    description: 'Show what would be done without executing',
    hasValue: false,
    type: 'boolean',
  }),

  reason: (): CommandOption => ({
    name: 'reason',
    alias: 'r',
    description: 'Reason for the action',
    hasValue: true,
    type: 'string',
  }),
};
