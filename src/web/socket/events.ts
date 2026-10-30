/**
 * Socket.io event type definitions
 * Defines all events for real-time communication between bot and dashboard
 */

import type { BotState, BotStatus, BotPosition } from '../../types';

/**
 * Namespace identifiers
 */
export const NAMESPACES = {
  MAIN: '/',                    // Main dashboard namespace
  ADMIN: '/admin',              // Admin-only namespace
  BOT: '/bot',                  // Bot internal events
  COMMANDS: '/commands',        // Command execution namespace
  LOGS: '/logs',                // Log streaming namespace
} as const;

/**
 * Event names - Server -> Client (Dashboard)
 */
export const SERVER_EVENTS = {
  // Connection events
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  AUTHENTICATED: 'authenticated',
  AUTH_FAILED: 'auth_failed',

  // Bot state events
  BOT_STATUS: 'bot_status',
  BOT_STATE: 'bot_state',
  BULK_UPDATE: 'bulk_update',
  HEALTH_UPDATE: 'health_update',
  POSITION_UPDATE: 'position_update',
  INVENTORY_UPDATE: 'inventory_update',
  EQUIPMENT_UPDATE: 'equipment_update',

  // Map/World events
  MAP_UPDATE: 'map_update',
  ENTITY_UPDATE: 'entity_update',
  BLOCK_UPDATE: 'block_update',

  // Player events
  PLAYER_JOINED: 'player_joined',
  PLAYER_LEFT: 'player_left',
  PLAYER_LIST: 'player_list',

  // Chat/Message events
  CHAT_MESSAGE: 'chat_message',
  PRIVATE_MESSAGE: 'private_message',
  SYSTEM_MESSAGE: 'system_message',

  // Log events
  LOG_ENTRY: 'log_entry',
  LOG_BATCH: 'log_batch',

  // Command events
  COMMAND_RESULT: 'command_result',
  COMMAND_OUTPUT: 'command_output',
  COMMAND_HISTORY: 'command_history',
  COMMAND_LIST: 'command_list',

  // Task/Progress events
  TASK_STARTED: 'task_started',
  TASK_PROGRESS: 'task_progress',
  TASK_COMPLETED: 'task_completed',
  TASK_FAILED: 'task_failed',

  // Memory events
  MEMORY_UPDATED: 'memory_updated',
  LOCATION_SAVED: 'location_saved',
  FACT_LEARNED: 'fact_learned',

  // Settings events
  SETTINGS_CHANGED: 'settings_changed',
  FEATURE_TOGGLED: 'feature_toggled',

  // Error events
  ERROR: 'error',
  WARNING: 'warning',
} as const;

/**
 * Event names - Client (Dashboard) -> Server
 */
export const CLIENT_EVENTS = {
  // Authentication
  AUTHENTICATE: 'authenticate',
  LOGOUT: 'logout',

  // Bot control
  SEND_COMMAND: 'send_command',
  SEND_COMMANDS_BATCH: 'send_commands_batch',
  EXECUTE_CONSOLE_COMMAND: 'execute_console_command',

  // Movement/Navigation
  MOVE_TO: 'move_to',
  FOLLOW_PLAYER: 'follow_player',
  STOP_MOVEMENT: 'stop_movement',
  SET_HOME: 'set_home',
  GO_HOME: 'go_home',

  // Inventory/Equipment
  DROP_ITEM: 'drop_item',
  DROP_ALL: 'drop_all',
  MOVE_ITEM: 'move_item',
  SET_HOTBAR: 'set_hotbar',
  EQUIP_ITEM: 'equip_item',
  UNEQUIP_ITEM: 'unequip_item',

  // Block interaction
  MINE_BLOCK: 'mine_block',
  PLACE_BLOCK: 'place_block',
  BREAK_BLOCK: 'break_block',

  // Combat
  TOGGLE_KILLAURA: 'toggle_killaura',
  TOGGLE_AUTODEFENSE: 'toggle_autodefense',
  SET_PVP_TARGET: 'set_pvp_target',

  // Automation
  TOGGLE_ROAMING: 'toggle_roaming',
  TOGGLE_FARMING: 'toggle_farming',
  TOGGLE_MINING: 'toggle_mining',
  TOGGLE_LUMBERJACK: 'toggle_lumberjack',
  START_PROGRESSION: 'start_progression',
  STOP_ALL_TASKS: 'stop_all_tasks',

  // Settings
  TOGGLE_SAFEMODE: 'toggle_safemode',
  TOGGLE_STEALTH: 'toggle_stealth',
  TOGGLE_AUTOARMOR: 'toggle_autoarmor',
  UPDATE_SETTINGS: 'update_settings',

  // Memory
  SAVE_LOCATION: 'save_location',
  DELETE_LOCATION: 'delete_location',
  REMEMBER_FACT: 'remember_fact',
  FORGET_FACT: 'forget_fact',
  ADD_RULE: 'add_rule',
  REMOVE_RULE: 'remove_rule',

  // Utility
  GET_STATE: 'get_state',
  GET_STATUS: 'get_status',
  GET_MEMORY: 'get_memory',
  GET_COMMANDS: 'get_commands',
  GET_COMMAND_HELP: 'get_command_help',
  GET_HISTORY: 'get_history',
  CLEAR_HISTORY: 'clear_history',
  PING: 'ping',
} as const;

/**
 * Event payload types
 */

// Server -> Client payloads
export interface BotStatusPayload extends BotStatus {}
export interface BotStatePayload extends BotState {}
export interface BulkUpdatePayload extends BotState {}

export interface HealthUpdatePayload {
  health: number;
  food: number;
  saturation?: number;
}

export interface PositionUpdatePayload extends BotPosition {
  yaw?: number;
  pitch?: number;
  dimension?: string;
}

export interface InventoryUpdatePayload {
  items: {
    slot: number;
    name: string;
    displayName: string;
    count: number;
  }[];
}

export interface EquipmentUpdatePayload {
  head: string;
  chest: string;
  legs: string;
  feet: string;
  hand: string;
  offhand: string;
}

export interface MapUpdatePayload {
  blocks: { x: number; z: number; name: string }[];
  entities: { x: number; z: number; name: string; isPlayer: boolean }[];
}

export interface EntityUpdatePayload {
  entities: {
    id: number;
    username?: string;
    name: string;
    position: BotPosition;
    type: string;
    distance: number;
  }[];
}

export interface ChatMessagePayload {
  username: string;
  message: string;
  type: 'chat' | 'whisper' | 'broadcast';
  timestamp: string;
}

export interface LogEntryPayload {
  level: 'info' | 'warn' | 'error' | 'debug';
  tag: string;
  message: string;
  timestamp: string;
}

export interface CommandResultPayload {
  requestId?: string;
  command: string;
  success: boolean;
  output?: string;
  error?: string;
  executionTime?: number;
}

export interface CommandOutputPayload {
  message: string;
  type: 'reply' | 'private' | 'error' | 'info';
  timestamp: string;
}

export interface TaskProgressPayload {
  taskId: string;
  name: string;
  progress: number;
  total: number;
  status: 'active' | 'completed' | 'failed' | 'stopped';
  message?: string;
}

export interface MemoryUpdatedPayload {
  type: 'location' | 'fact' | 'rule' | 'task' | 'player';
  key: string;
  data: unknown;
}

export interface SettingsChangedPayload {
  key: string;
  value: unknown;
}

export interface FeatureToggledPayload {
  feature: string;
  enabled: boolean;
}

export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

// Client -> Server payloads
export interface AuthenticatePayload {
  token?: string;
  username?: string;
  password?: string;
}

export interface SendCommandPayload {
  command: string;
  args?: string | string[];
  options?: Record<string, unknown>;
  requestId?: string;
}

export interface MoveToPayload {
  x: number;
  y: number;
  z: number;
}

export interface FollowPlayerPayload {
  username: string;
}

export interface DropItemPayload {
  slot: number;
  count?: number;
}

export interface MoveItemPayload {
  from: number;
  to: number;
}

export interface MineBlockPayload {
  x: number;
  y: number;
  z: number;
}

export interface PlaceBlockPayload {
  x: number;
  y: number;
  z: number;
  blockType?: string;
}

export interface SaveLocationPayload {
  name: string;
  position?: BotPosition;
  type?: string;
}

export interface RememberFactPayload {
  key: string;
  fact: string;
}

export interface UpdateSettingsPayload {
  settings: Record<string, unknown>;
}

export interface PingPayload {
  timestamp: number;
}

/**
 * Room names for targeted events
 */
export const ROOMS = {
  ADMINS: 'admins',
  TRUSTED: 'trusted',
  ALL: 'all',
  BOT_EVENTS: 'bot_events',
  COMMAND_RESULTS: 'command_results',
  LOGS: 'logs',
} as const;

/**
 * Join/Leave room events
 */
export const ROOM_EVENTS = {
  JOIN: 'join_room',
  LEAVE: 'leave_room',
  ROOM_USERS: 'room_users',
} as const;