/**
 * Socket.io event type definitions
 * Defines all events for real-time communication between bot and dashboard
 */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Namespace identifiers
pub mod namespaces {
    pub const MAIN: &str = "/"; // Main dashboard namespace
    pub const ADMIN: &str = "/admin"; // Admin-only namespace
    pub const BOT: &str = "/bot"; // Bot internal events
    pub const COMMANDS: &str = "/commands"; // Command execution namespace
    pub const LOGS: &str = "/logs"; // Log streaming namespace
}

/// Event names - Server -> Client (Dashboard)
pub mod server_events {
    // Connection events
    pub const CONNECTED: &str = "connected";
    pub const DISCONNECTED: &str = "disconnected";
    pub const AUTHENTICATED: &str = "authenticated";
    pub const AUTH_FAILED: &str = "auth_failed";

    // Bot state events
    pub const BOT_STATUS: &str = "bot_status";
    pub const BOT_STATE: &str = "bot_state";
    pub const BULK_UPDATE: &str = "bulk_update";
    pub const HEALTH_UPDATE: &str = "health_update";
    pub const POSITION_UPDATE: &str = "position_update";
    pub const INVENTORY_UPDATE: &str = "inventory_update";
    pub const EQUIPMENT_UPDATE: &str = "equipment_update";

    // Map/World events
    pub const MAP_UPDATE: &str = "map_update";
    pub const ENTITY_UPDATE: &str = "entity_update";
    pub const BLOCK_UPDATE: &str = "block_update";

    // Player events
    pub const PLAYER_JOINED: &str = "player_joined";
    pub const PLAYER_LEFT: &str = "player_left";
    pub const PLAYER_LIST: &str = "player_list";

    // Chat/Message events
    pub const CHAT_MESSAGE: &str = "chat_message";
    pub const PRIVATE_MESSAGE: &str = "private_message";
    pub const SYSTEM_MESSAGE: &str = "system_message";

    // Log events
    pub const LOG_ENTRY: &str = "log_entry";
    pub const LOG_BATCH: &str = "log_batch";

    // Command events
    pub const COMMAND_RESULT: &str = "command_result";
    pub const COMMAND_OUTPUT: &str = "command_output";
    pub const COMMAND_HISTORY: &str = "command_history";
    pub const COMMAND_LIST: &str = "command_list";

    // Task/Progress events
    pub const TASK_STARTED: &str = "task_started";
    pub const TASK_PROGRESS: &str = "task_progress";
    pub const TASK_COMPLETED: &str = "task_completed";
    pub const TASK_FAILED: &str = "task_failed";

    // Memory events
    pub const MEMORY_UPDATED: &str = "memory_updated";
    pub const LOCATION_SAVED: &str = "location_saved";
    pub const FACT_LEARNED: &str = "fact_learned";

    // Settings events
    pub const SETTINGS_CHANGED: &str = "settings_changed";
    pub const FEATURE_TOGGLED: &str = "feature_toggled";

    // Error events
    pub const ERROR: &str = "error";
    pub const WARNING: &str = "warning";
}

/// Event names - Client (Dashboard) -> Server
pub mod client_events {
    // Authentication
    pub const AUTHENTICATE: &str = "authenticate";
    pub const LOGOUT: &str = "logout";

    // Bot control
    pub const SEND_COMMAND: &str = "send_command";
    pub const SEND_COMMANDS_BATCH: &str = "send_commands_batch";
    pub const EXECUTE_CONSOLE_COMMAND: &str = "execute_console_command";

    // Movement/Navigation
    pub const MOVE_TO: &str = "move_to";
    pub const FOLLOW_PLAYER: &str = "follow_player";
    pub const STOP_MOVEMENT: &str = "stop_movement";
    pub const SET_HOME: &str = "set_home";
    pub const GO_HOME: &str = "go_home";

    // Inventory/Equipment
    pub const DROP_ITEM: &str = "drop_item";
    pub const DROP_ALL: &str = "drop_all";
    pub const MOVE_ITEM: &str = "move_item";
    pub const SET_HOTBAR: &str = "set_hotbar";
    pub const EQUIP_ITEM: &str = "equip_item";
    pub const UNEQUIP_ITEM: &str = "unequip_item";

    // Block interaction
    pub const MINE_BLOCK: &str = "mine_block";
    pub const PLACE_BLOCK: &str = "place_block";
    pub const BREAK_BLOCK: &str = "break_block";

    // Combat
    pub const TOGGLE_KILLAURA: &str = "toggle_killaura";
    pub const TOGGLE_AUTODEFENSE: &str = "toggle_autodefense";
    pub const SET_PVP_TARGET: &str = "set_pvp_target";

    // Automation
    pub const TOGGLE_ROAMING: &str = "toggle_roaming";
    pub const TOGGLE_FARMING: &str = "toggle_farming";
    pub const TOGGLE_MINING: &str = "toggle_mining";
    pub const TOGGLE_LUMBERJACK: &str = "toggle_lumberjack";
    pub const START_PROGRESSION: &str = "start_progression";
    pub const STOP_ALL_TASKS: &str = "stop_all_tasks";

    // Settings
    pub const TOGGLE_SAFEMODE: &str = "toggle_safemode";
    pub const TOGGLE_STEALTH: &str = "toggle_stealth";
    pub const TOGGLE_AUTOARMOR: &str = "toggle_autoarmor";
    pub const UPDATE_SETTINGS: &str = "update_settings";

    // Memory
    pub const SAVE_LOCATION: &str = "save_location";
    pub const DELETE_LOCATION: &str = "delete_location";
    pub const REMEMBER_FACT: &str = "remember_fact";
    pub const FORGET_FACT: &str = "forget_fact";
    pub const ADD_RULE: &str = "add_rule";
    pub const REMOVE_RULE: &str = "remove_rule";

    // Utility
    pub const GET_STATE: &str = "get_state";
    pub const GET_STATUS: &str = "get_status";
    pub const GET_MEMORY: &str = "get_memory";
    pub const GET_COMMANDS: &str = "get_commands";
    pub const GET_COMMAND_HELP: &str = "get_command_help";
    pub const GET_HISTORY: &str = "get_history";
    pub const CLEAR_HISTORY: &str = "clear_history";
    pub const PING: &str = "ping";
}

/// Room names for targeted events
pub mod rooms {
    pub const ADMINS: &str = "admins";
    pub const TRUSTED: &str = "trusted";
    pub const ALL: &str = "all";
    pub const BOT_EVENTS: &str = "bot_events";
    pub const COMMAND_RESULTS: &str = "command_results";
    pub const LOGS: &str = "logs";
}

/// Join/Leave room events
pub mod room_events {
    pub const JOIN: &str = "join_room";
    pub const LEAVE: &str = "leave_room";
    pub const ROOM_USERS: &str = "room_users";
}

/// Bot position
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotPosition {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Bot status payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotStatusPayload {
    pub status: String,
    pub username: Option<String>,
    pub uptime: u64,
    pub ping: Option<u32>,
}

/// Bot state payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotStatePayload {
    pub position: Option<BotPosition>,
    pub health: f32,
    pub food: i32,
    pub saturation: f32,
    pub inventory: Vec<InventoryItemPayload>,
    pub equipment: EquipmentPayload,
    pub players: Vec<PlayerInfoPayload>,
    pub features: FeatureStatePayload,
    pub settings: HashMap<String, serde_json::Value>,
    pub favorites: HashMap<String, BotPosition>,
    pub logs: Vec<String>,
    pub admins: Vec<String>,
    pub users: Vec<String>,
}

/// Inventory item payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventoryItemPayload {
    pub slot: i32,
    pub name: String,
    pub display_name: String,
    pub count: i32,
    pub max_stack_size: i32,
}

/// Equipment payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EquipmentPayload {
    pub head: String,
    pub chest: String,
    pub legs: String,
    pub feet: String,
    pub hand: String,
    pub offhand: String,
}

/// Player info payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerInfoPayload {
    pub username: String,
    pub entity_id: Option<i32>,
    pub position: Option<BotPosition>,
    pub health: Option<f32>,
    pub gamemode: Option<String>,
    pub ping: Option<i32>,
    pub is_bot: bool,
}

/// Feature state payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureStatePayload {
    pub roaming: bool,
    pub following: bool,
    pub pvp_target: Option<String>,
    pub safe_mode: bool,
    pub kill_aura: bool,
    pub auto_defense: bool,
    pub auto_armor: bool,
    pub stealth: bool,
    pub progression: bool,
    pub mining: bool,
    pub farming: bool,
    pub lumberjack: bool,
}

/// Bulk update payload (same as bot state)
pub type BulkUpdatePayload = BotStatePayload;

/// Health update payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthUpdatePayload {
    pub health: f32,
    pub food: i32,
    pub saturation: Option<f32>,
}

/// Position update payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PositionUpdatePayload {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: Option<f32>,
    pub pitch: Option<f32>,
    pub dimension: Option<String>,
}

/// Inventory update payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventoryUpdatePayload {
    pub items: Vec<InventoryItemPayload>,
}

/// Equipment update payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EquipmentUpdatePayload {
    pub head: String,
    pub chest: String,
    pub legs: String,
    pub feet: String,
    pub hand: String,
    pub offhand: String,
}

/// Map update payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapUpdatePayload {
    pub blocks: Vec<BlockInfoPayload>,
    pub entities: Vec<EntityInfoPayload>,
}

/// Block info payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockInfoPayload {
    pub x: i32,
    pub z: i32,
    pub name: String,
}

/// Entity info payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityInfoPayload {
    pub x: i32,
    pub z: i32,
    pub name: String,
    pub is_player: bool,
}

/// Entity update payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityUpdatePayload {
    pub entities: Vec<EntityDetailPayload>,
}

/// Entity detail payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityDetailPayload {
    pub id: i32,
    pub username: Option<String>,
    pub name: String,
    pub position: BotPosition,
    pub type_name: String,
    pub distance: f64,
}

/// Chat message payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessagePayload {
    pub username: String,
    pub message: String,
    pub message_type: String, // "chat" | "whisper" | "broadcast"
    pub timestamp: String,
}

/// Log entry payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntryPayload {
    pub level: String, // "info" | "warn" | "error" | "debug"
    pub tag: String,
    pub message: String,
    pub timestamp: String,
}

/// Command result payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResultPayload {
    pub request_id: Option<String>,
    pub command: String,
    pub success: bool,
    pub output: Option<String>,
    pub error: Option<String>,
    pub execution_time: Option<u64>,
}

/// Command output payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandOutputPayload {
    pub message: String,
    pub output_type: String, // "reply" | "private" | "error" | "info"
    pub timestamp: String,
}

/// Task progress payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskProgressPayload {
    pub task_id: String,
    pub name: String,
    pub progress: u32,
    pub total: u32,
    pub status: String, // "active" | "completed" | "failed" | "stopped"
    pub message: Option<String>,
}

/// Memory updated payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryUpdatedPayload {
    pub memory_type: String, // "location" | "fact" | "rule" | "task" | "player"
    pub key: String,
    pub data: serde_json::Value,
}

/// Settings changed payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsChangedPayload {
    pub key: String,
    pub value: serde_json::Value,
}

/// Feature toggled payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureToggledPayload {
    pub feature: String,
    pub enabled: bool,
}

/// Error payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
}

/// Client -> Server payloads

/// Authenticate payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticatePayload {
    pub token: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// Send command payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendCommandPayload {
    pub command: String,
    pub args: Option<serde_json::Value>, // string | string[]
    pub options: Option<HashMap<String, serde_json::Value>>,
    pub request_id: Option<String>,
}

/// Move to payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveToPayload {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Follow player payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowPlayerPayload {
    pub username: String,
}

/// Drop item payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropItemPayload {
    pub slot: i32,
    pub count: Option<i32>,
}

/// Move item payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveItemPayload {
    pub from: i32,
    pub to: i32,
}

/// Mine block payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MineBlockPayload {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

/// Place block payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaceBlockPayload {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub block_type: Option<String>,
}

/// Save location payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveLocationPayload {
    pub name: String,
    pub position: Option<BotPosition>,
    pub location_type: Option<String>,
}

/// Remember fact payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RememberFactPayload {
    pub key: String,
    pub fact: String,
}

/// Update settings payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSettingsPayload {
    pub settings: HashMap<String, serde_json::Value>,
}

/// Ping payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingPayload {
    pub timestamp: u64,
}

/// Pong response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PongPayload {
    pub pong: bool,
    pub timestamp: u64,
    pub latency: u64,
}