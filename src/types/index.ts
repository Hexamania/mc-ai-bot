/**
 * Core type definitions for mc-ai-bot
 */

import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Vec3 } from 'vec3';
import type { BotManager } from '../bot/BotManager';

/**
 * Permission levels for commands
 */
export type PermissionLevel = 'guest' | 'trusted' | 'admin';

/**
 * Configuration types
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
export interface BotPosition {
  x: number;
  y: number;
  z: number;
}

export interface BotVitals {
  health: number;
  food: number;
  pos: BotPosition;
}

export interface InventoryItem {
  slot: number;
  name: string;
  displayName: string;
  count: number;
}

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

export interface MapData {
  blocks: MapBlock[];
  entities: MapEntity[];
}

export interface PlayerInfo {
  username: string;
  role: 'guest' | 'trusted' | 'admin';
  preferences: Record<string, unknown>;
  firstSeen: string;
  lastSeen: string;
}

export interface LocationInfo {
  x: number;
  y: number;
  z: number;
  type: string;
  updatedAt: string;
}

export interface TaskInfo {
  goal: string;
  status: 'active' | 'completed' | 'stopped' | 'failed';
  progress: number | null;
  updatedAt: string;
}

export interface MemoryData {
  schemaVersion: number;
  locations: Record<string, LocationInfo>;
  players: Record<string, PlayerInfo>;
  currentTask: TaskInfo | null;
  rules: string[];
  learnedFacts: Record<string, string>;
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
  botData: BotVitals;
  inventory: InventoryItem[];
  currentPath: BotPosition[];
  favorites: Record<string, BotPosition>;
  equipment: Equipment;
  mapData?: MapData;
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
 * Command types
 */
export interface CommandContext {
  bot: Bot;
  username: string;
  args: string[];
  isAdmin: boolean;
  isPM: boolean;
  reply: (message: string) => void;
  privateReply: (message: string) => void;
}

export interface CommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  adminOnly?: boolean;
  pmOnly?: boolean;
  execute: (context: CommandContext) => Promise<void> | void;
}

/**
 * Command execution result
 */
export interface CommandResult {
  success: boolean;
  found: boolean;
  error?: string;
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
 * Utility types
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type RequiredKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;
