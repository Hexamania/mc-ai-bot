/**
 * Core type definitions for the bot module
 */

import type { Bot } from 'mineflayer';
import type { EventEmitter } from 'events';

// Bot lifecycle states
export enum BotState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
  SHUTTING_DOWN = 'shutting_down',
  SHUTDOWN = 'shutdown'
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

// Event types
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

  // Utility
  getBot(): Bot | null;
  isOnline(): boolean;
}

// Extended EventEmitter with typed events
export interface TypedEventEmitter<TEvents extends Record<string, unknown[]>> extends EventEmitter {
  on<K extends keyof TEvents>(event: K, listener: (...args: TEvents[K]) => void): this;
  once<K extends keyof TEvents>(event: K, listener: (...args: TEvents[K]) => void): this;
  emit<K extends keyof TEvents>(event: K, ...args: TEvents[K]): boolean;
  off<K extends keyof TEvents>(event: K, listener: (...args: TEvents[K]) => void): this;
  removeAllListeners<K extends keyof TEvents>(event?: K): this;
}