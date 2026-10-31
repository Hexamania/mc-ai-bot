/**
 * Core type definitions for mc-ai-bot
 */

import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Vec3 } from 'vec3';
import type { BotManager } from '../bot/BotManager';

/**
 * Bot position type (x, y, z coordinates)
 */
export interface BotPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * Equipment destination slots (matches mineflayer's EquipmentDestination type)
 */
export type EquipmentDestination = 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand';

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
  /** Command arguments as string array (for backwards compatibility) */
  args: string[];
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
  /** Permission configuration (new format) */
  permission?: PermissionConfig;
  /** @deprecated Use permission.level instead */
  adminOnly?: boolean;
  /** @deprecated Use permission.pmOnly instead */
  pmOnly?: boolean;
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

export interface CommandRegistry {
  register(command: CommandDefinition): void;
  unregister(name: string): void;
  get(name: string): CommandDefinition | undefined;
  getAll(): CommandDefinition[];
  getByCategory(category: string): CommandDefinition[];
  execute(name: string, context: CommandContext): Promise<CommandResult>;
  has(name: string): boolean;
  getCommandNames(): string[];
  getAliases(): Map<string, string>;
  getCategories(): string[];
  getHelp(name: string, prefix: string): string | null;
  getFullHelp(prefix: string, userLevel: PermissionLevel): string;
  registerHelpCommand(prefix: string): void;
}

/**
 * Feature/Plugin types
 */
export interface Feature {
  name: string;
  version: string;
  description: string;
  dependencies?: string[];
  enabled: boolean;
  initialize(bot: Bot, manager: BotManager): Promise<void> | void;
  shutdown(): Promise<void> | void;
  enable(): Promise<void> | void;
  disable(): Promise<void> | void;
}

export interface FeatureRegistry {
  register(feature: Feature): void;
  unregister(name: string): void;
  get(name: string): Feature | undefined;
  getAll(): Feature[];
  getDependencies(name: string): string[];
}

/**
 * Event types
 */
export interface BotEventMap {
  spawn: [];
  death: [];
  message: [string];
  chat: [string, string, string]; // username, message, type
  end: [string];
  kicked: [string];
  error: [Error];
  health: [];
  physicsTick: [];
  path_update: [PathUpdate];
  goal_reached: [];
  playerCollect: [Entity];
  resourcePack: [];
}

export interface PathUpdate {
  path: Vec3[];
  status: 'success' | 'failed' | 'interrupted';
}

/**
 * Web socket event types
 */
export interface WebSocketEvents {
  // Client -> Server
  mine_block: (data: { x: number; y: number; z: number }) => void;
  place_block: (data: { x: number; y: number; z: number }) => void;
  set_hotbar: (slot: number) => void;
  drop_all: () => void;
  move_item: (data: { from: number; to: number }) => void;
  toggle_safemode: (enabled: boolean) => void;
  start_farming: () => void;
  toggle_killaura: (enabled: boolean) => void;
  craft_armor: (data: { type?: string }) => void;
  save_location: (data: { name: string; pos?: BotPosition }) => void;
  send_command: (data: { command: string; args?: string }) => void;

  // Server -> Client
  bot_status: (status: BotStatus) => void;
  state: (state: BotState) => void;
  bulk_update: (state: BotState) => void;
  log: (entry: string) => void;
  path_update: (path: BotPosition[]) => void;
}

/**
 * API response types
 */
export interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export type StateAPIResponse = APIResponse<BotState>;
export type StatusAPIResponse = APIResponse<BotStatus>;

/**
 * Progression/Task types
 */
export type ObjectiveType =
  | 'idle'
  | 'collecting_wood'
  | 'mining_stone'
  | 'mining_iron'
  | 'mining_diamonds'
  | 'building_shelter'
  | 'farming'
  | 'roaming'
  | 'following'
  | 'guarding'
  | 'pvp'
  | 'speedrun'
  | 'mining_tunnel'
  | 'lumberjack'
  | 'mining_area'
  | 'returning_home'
  | 'depositing'
  | 'panic';

export interface Objective {
  type: ObjectiveType;
  target?: string;
  position?: BotPosition;
  progress?: number;
  total?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Bot Configuration types
 */
export interface BotConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  version: string;
  auth: 'offline' | 'microsoft' | 'mojang';
  checkTimeoutInterval: number;
}

export interface WebConfig {
  port: number;
  host?: string;
}

export interface OpenAIConfig {
  apiKey: string;
  model: string;
}

export interface MemoryConfig {
  enabled: boolean;
  filePath: string;
}

export interface AdminConfig {
  prefix: string;
  password: string;
}

export interface BotPrefixConfig {
  public: string;
  admin: string;
}

/**
 * Application configuration
 */
export interface AppConfig {
  bot: BotConfig;
  web: WebConfig;
  openai: OpenAIConfig;
  memory: MemoryConfig;
  admin: AdminConfig;
  prefix: BotPrefixConfig;
}

/**
 * Bot state types
 */
export interface Equipment {
  head: string;
  chest: string;
  legs: string;
  feet: string;
  hand: string;
  offhand: string;
}

export interface MapBlock {
  x: number;
  z: number;
  name: string;
}

export interface MapEntity {
  x: number;
  z: number;
  name: string;
  isPlayer: boolean;
}

export interface BotState {
  status: string;
  users: string[];
  admins: string[];
  logs: string[];
  settings: {
    theme: string;
    autoDefense: boolean;
    autoArmor: boolean;
    stealth: boolean;
  };
  botData: {
    health: number;
    food: number;
    pos: BotPosition;
  };
  inventory: {
    slot: number;
    name: string;
    displayName: string;
    count: number;
  }[];
  currentPath: BotPosition[];
  favorites: Record<string, BotPosition>;
  equipment: Equipment;
  mapData: {
    blocks: MapBlock[];
    entities: MapEntity[];
  };
  // Index signature for dynamic property access (used by web socket handlers)
  [key: string]: unknown;
}

export interface BotStatus {
  online: boolean;
  username: string;
  status: string;
  event: string;
  reason: string | null;
  error: string | null;
  retryAt: number | null;
  retryInMs: number | null;
}

/**
 * Utility types
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type RequiredKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;
