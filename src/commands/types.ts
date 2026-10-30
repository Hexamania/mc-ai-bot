/**
 * Command system type definitions
 * Provides types for the command registry, permissions, arguments, and execution context
 */

import type { Bot } from 'mineflayer';

/**
 * Permission levels for commands
 */
export type PermissionLevel = 'guest' | 'trusted' | 'admin';

/**
 * Permission configuration
 */
export interface PermissionConfig {
  /** Minimum permission level required */
  level: PermissionLevel;
  /** Specific usernames that are allowed (bypasses level check) */
  allowedUsers?: string[];
  /** Specific usernames that are denied (overrides level check) */
  deniedUsers?: string[];
  /** Whether command can only be used in private messages */
  pmOnly?: boolean;
  /** Whether command can only be used in public chat */
  publicOnly?: boolean;
}

/**
 * Command argument definition
 */
export interface CommandArgument {
  /** Argument name */
  name: string;
  /** Argument description */
  description: string;
  /** Whether argument is required */
  required: boolean;
  /** Default value if not provided */
  defaultValue?: unknown;
  /** Type for parsing and validation */
  type: 'string' | 'number' | 'boolean' | 'player' | 'position' | 'item' | 'enum';
  /** For enum type: allowed values */
  enumValues?: string[];
  /** For position type: whether to use current position as default */
  useCurrentPosition?: boolean;
  /** Validator function */
  validator?: (value: unknown) => boolean | string;
  /** Whether this argument consumes all remaining input (greedy) */
  greedy?: boolean;
}

/**
 * Command option/flag definition
 */
export interface CommandOption {
  /** Option name (e.g., 'help', 'verbose') */
  name: string;
  /** Short alias (e.g., 'h') */
  alias?: string;
  /** Option description */
  description: string;
  /** Whether option takes a value */
  hasValue: boolean;
  /** Default value */
  defaultValue?: unknown;
  /** Type for parsing */
  type: 'boolean' | 'string' | 'number';
}

/**
 * Parsed command arguments
 */
export interface ParsedArguments {
  /** Positional arguments */
  args: unknown[];
  /** Named options/flags */
  options: Record<string, unknown>;
  /** Raw argument strings */
  raw: string[];
}

/**
 * Command execution context
 */
export interface CommandContext {
  /** The mineflayer bot instance */
  bot: Bot;
  /** Username of the command sender */
  username: string;
  /** Parsed arguments */
  args: ParsedArguments;
  /** Raw arguments array (for backwards compatibility) */
  rawArgs: string[];
  /** Whether the sender is an admin */
  isAdmin: boolean;
  /** Whether the sender is trusted */
  isTrusted: boolean;
  /** Whether the command was sent via private message */
  isPM: boolean;
  /** Whether the sender has the required permission level */
  hasPermission: boolean;
  /** Send a public reply */
  reply: (message: string) => void;
  /** Send a private reply */
  privateReply: (message: string) => void;
  /** Send an error reply */
  error: (message: string) => void;
  /** Permission level of the sender */
  permissionLevel: PermissionLevel;
  /** Command name that was invoked */
  commandName: string;
  /** Full command string as typed */
  fullCommand: string;
  /** Timestamp of command execution */
  timestamp: number;
  /** Additional metadata */
  metadata: Record<string, unknown>;
}

/**
 * Command definition interface
 */
export interface CommandDefinition {
  /** Command name (lowercase, no prefix) */
  name: string;
  /** Command aliases */
  aliases?: string[];
  /** Command description for help */
  description: string;
  /** Usage string for help (e.g., '<target> [reason]') */
  usage?: string;
  /** Short description for command list */
  shortDescription?: string;
  /** Category for help organization */
  category?: string;
  /** Permission configuration */
  permission?: PermissionConfig;
  /** Command arguments */
  arguments?: CommandArgument[];
  /** Command options/flags */
  options?: CommandOption[];
  /** Examples for help */
  examples?: string[];
  /** Whether command is hidden from help */
  hidden?: boolean;
  /** Whether command is deprecated */
  deprecated?: boolean;
  /** Deprecation message */
  deprecationMessage?: string;
  /** Cooldown in milliseconds */
  cooldown?: number;
  /** Maximum number of times command can be used per cooldown period */
  maxUses?: number;
  /** Command execute function */
  execute: (context: CommandContext) => Promise<void> | void;
  /** Command autocomplete/suggestions function */
  autocomplete?: (context: CommandContext, partial: string) => string[] | Promise<string[]>;
  /** Called before execute for validation */
  validate?: (context: CommandContext) => boolean | string | Promise<boolean | string>;
  /** Called after execute (success or error) */
  onComplete?: (context: CommandContext, error?: Error) => void | Promise<void>;
}

/**
 * Command registry interface
 */
export interface CommandRegistry {
  /** Register a command */
  register(command: CommandDefinition): void;
  /** Unregister a command */
  unregister(name: string): void;
  /** Get a command by name or alias */
  get(name: string): CommandDefinition | undefined;
  /** Get all registered commands */
  getAll(): CommandDefinition[];
  /** Get commands by category */
  getByCategory(category: string): CommandDefinition[];
  /** Execute a command */
  execute(name: string, context: CommandContext): Promise<CommandResult>;
  /** Check if a command exists */
  has(name: string): boolean;
  /** Get command names (for autocomplete) */
  getCommandNames(): string[];
  /** Get all aliases */
  getAliases(): Map<string, string>;
  /** Get command categories */
  getCategories(): string[];
  /** Get help for a command */
  getHelp(name: string, prefix: string): string | null;
  /** Get full help text */
  getFullHelp(prefix: string, userLevel: PermissionLevel): string;
  /** Register a help command */
  registerHelpCommand(prefix: string): void;
}

/**
 * Command execution result
 */
export interface CommandResult {
  /** Whether command was found and executed */
  success: boolean;
  /** Whether command was found (even if permission denied) */
  found: boolean;
  /** Error message if failed */
  error?: string;
  /** Execution time in ms */
  executionTime?: number;
}

/**
 * Chat message parsing result
 */
export interface ParsedMessage {
  /** Username of the sender */
  username: string;
  /** Message content */
  content: string;
  /** Message type */
  type: 'chat' | 'pm' | 'whisper' | 'system';
  /** Original raw message */
  raw: string;
}

/**
 * Chat command parser configuration
 */
export interface ChatParserConfig {
  /** Public command prefix (e.g., '!', ':', '/') */
  publicPrefix: string;
  /** Admin command prefix (e.g., '$', '!!') */
  adminPrefix: string;
  /** Whether to parse messages from the bot itself */
  ignoreBotMessages: boolean;
  /** Custom message parsers */
  customParsers?: ((raw: string) => ParsedMessage | null)[];
}

/**
 * Web command handler configuration
 */
export interface WebCommandConfig {
  /** Whether to enable web command handling */
  enabled: boolean;
  /** Allowed origins for web commands */
  allowedOrigins?: string[];
  /** Rate limit for web commands (per minute) */
  rateLimit?: number;
  /** Require authentication for web commands */
  requireAuth?: boolean;
}

/**
 * Cooldown tracking entry
 */
export interface CooldownEntry {
  /** Last execution timestamp */
  lastUsed: number;
  /** Number of uses in current window */
  uses: number;
  /** Window start timestamp */
  windowStart: number;
}

/**
 * Command usage statistics
 */
export interface CommandStats {
  /** Command name */
  name: string;
  /** Total executions */
  totalExecutions: number;
  /** Successful executions */
  successfulExecutions: number;
  /** Failed executions */
  failedExecutions: number;
  /** Average execution time */
  avgExecutionTime: number;
  /** Last executed timestamp */
  lastExecuted: number | null;
  /** Most common error */
  mostCommonError?: string;
}