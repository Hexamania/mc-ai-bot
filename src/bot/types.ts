/**
 * Core type definitions for the bot module
 */

import type { Bot } from 'mineflayer';
import type { EventEmitter } from 'events';
import type { Vec3 } from 'vec3';
import type { Window } from 'prismarine-windows';

// Bot lifecycle states
export enum BotState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
  SHUTTING_DOWN = 'shutting_down',
  SHUTDOWN = 'shutdown',
}

// Configuration types
export interface BotConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  version: string;
  auth: 'offline' | 'microsoft' | 'mojang';
  checkTimeoutInterval: number;
  reconnect: ReconnectConfig;
  plugins: PluginConfig[];
}

export interface ReconnectConfig {
  enabled: boolean;
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  exponentialBackoff: boolean;
}

export interface PluginConfig {
  name: string;
  enabled: boolean;
  options?: Record<string, unknown>;
}

// Plugin system types
export interface Plugin {
  name: string;
  version: string;
  description?: string;
  dependencies?: string[];
  initialize(bot: Bot, manager: BotManager): Promise<void> | void;
  shutdown(): Promise<void> | void;
  onEvent?(event: string, data: unknown): void;
}

export interface PluginManager {
  load(plugin: Plugin): Promise<void>;
  unload(name: string): Promise<void>;
  get(name: string): Plugin | undefined;
  getAll(): Plugin[];
  isLoaded(name: string): boolean;
}

// Event types - using tuple types for exact argument matching
export interface BotEvents {
  stateChange: [BotState, BotState]; // [newState, oldState]
  connect: [Bot];
  disconnect: [string];
  error: [Error];
  reconnect: [number]; // attempt number
  reconnectFailed: [Error];
  spawn: [];
  death: [];
  chat: [string, string, string]; // [username, message, type]
  command: [string, string[]]; // [command, args]
  pluginLoad: [Plugin];
  pluginUnload: [string];
  shutdown: [];
  // Custom events emitted by BotManager
  healthChange: [number, number]; // [health, food]
  positionChange: [Vec3];
  windowOpen: [Window];
  windowClose: [Window];
}

// Bot status data
export interface BotStatus {
  state: BotState;
  username?: string;
  uptime: number;
  reconnectAttempts: number;
  lastError?: Error;
  plugins: string[];
  memoryUsage: NodeJS.MemoryUsage;
}

// Configuration loader options
export interface ConfigLoaderOptions {
  configPath?: string;
  envPrefix?: string;
  defaults?: Partial<BotConfig>;
}

// Graceful shutdown options
export interface ShutdownOptions {
  timeout: number;
  forceExit: boolean;
  saveState: boolean;
}

// BotManager interface
export interface BotManager {
  // Lifecycle
  start(): Promise<void>;
  stop(options?: Partial<ShutdownOptions>): Promise<void>;
  restart(): Promise<void>;

  // State
  getState(): BotState;
  getStatus(): BotStatus;

  // Connection
  connect(): Promise<Bot>;
  disconnect(reason?: string): Promise<void>;

  // Plugins
  plugins: PluginManager;

  // Configuration
  config: BotConfig;

  // Events
  on<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this;
  once<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this;
  emit<K extends keyof BotEvents>(event: K, ...args: BotEvents[K]): boolean;
  off<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this;

  // Utility
  getBot(): Bot | null;
  isOnline(): boolean;
}

// Extended EventEmitter with typed events - uses string keys to avoid symbol issues
// Uses a more permissive constraint to allow tuple types
export interface TypedEventEmitter<TEvents> {
  on<K extends string & keyof TEvents>(event: K, listener: (...args: unknown[]) => void): this;
  once<K extends string & keyof TEvents>(event: K, listener: (...args: unknown[]) => void): this;
  emit<K extends string & keyof TEvents>(event: K, ...args: unknown[]): boolean;
  off<K extends string & keyof TEvents>(event: K, listener: (...args: unknown[]) => void): this;
  removeAllListeners<K extends string & keyof TEvents>(event?: K): this;
  // EventEmitter methods we need
  setMaxListeners(n: number): this;
  getMaxListeners(): number;
  listenerCount(eventName: string | symbol): number;
  eventNames(): (string | symbol)[];
  prependListener<K extends string & keyof TEvents>(event: K, listener: (...args: unknown[]) => void): this;
  prependOnceListener<K extends string & keyof TEvents>(event: K, listener: (...args: unknown[]) => void): this;
}