/**
 * REST API routes for web server
 * Provides HTTP endpoints for bot state, memory, commands, and configuration
 */
use axum::{
    Router,
    extract::{Query, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Json, Response},
    routing::{delete, get, patch, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tracing::{error, info};

use crate::{
    bot::minecraft::MinecraftConnection,
    bot::runtime::MinecraftRuntime,
    config::AppConfig,
    memory::Memory,
    web::{
        WebState,
        auth::{
            Claims, UserRole, auth_middleware, optional_auth_middleware, require_admin,
            require_trusted,
        },
        rate_limit::{RateLimiters, create_rate_limiters, rate_limit_middleware},
    },
};

/// Health check response
#[derive(Serialize)]
struct HealthResponse {
    success: bool,
    status: String,
    timestamp: String,
    uptime: f64,
    version: String,
}

/// Bot status response
#[derive(Serialize)]
struct StatusResponse {
    success: bool,
    data: serde_json::Value,
}

/// Bot vitals response
#[derive(Serialize)]
struct VitalsResponse {
    success: bool,
    data: serde_json::Value,
}

/// Inventory response
#[derive(Serialize)]
struct InventoryResponse {
    success: bool,
    data: serde_json::Value,
}

/// Equipment response
#[derive(Serialize)]
struct EquipmentResponse {
    success: bool,
    data: serde_json::Value,
}

/// Players response
#[derive(Serialize)]
struct PlayersResponse {
    success: bool,
    data: serde_json::Value,
}

/// Map response
#[derive(Serialize)]
struct MapResponse {
    success: bool,
    data: serde_json::Value,
}

/// Logs response
#[derive(Serialize)]
struct LogsResponse {
    success: bool,
    data: serde_json::Value,
}

/// Settings response
#[derive(Serialize)]
struct SettingsResponse {
    success: bool,
    data: serde_json::Value,
}

/// Location request
#[derive(Deserialize)]
struct LocationRequest {
    name: String,
    position: Option<crate::web::socket::events::BotPosition>,
    location_type: Option<String>,
}

/// Memory fact request
#[derive(Deserialize)]
struct MemoryFactRequest {
    key: String,
    fact: String,
}

/// Memory rule request
#[derive(Deserialize)]
struct MemoryRuleRequest {
    rule: String,
}

/// Command execute request
#[derive(Deserialize)]
struct CommandExecuteRequest {
    command: String,
    args: Option<serde_json::Value>,
}

/// Chat message request
#[derive(Deserialize)]
struct ChatMessageRequest {
    message: String,
}

/// Console command request
#[derive(Deserialize)]
struct ConsoleCommandRequest {
    command: String,
}

/// Config response
#[derive(Serialize)]
struct ConfigResponse {
    success: bool,
    data: serde_json::Value,
}

/// Stats response
#[derive(Serialize)]
struct StatsResponse {
    success: bool,
    data: serde_json::Value,
}

/// Error response
#[derive(Serialize)]
struct ErrorResponse {
    success: bool,
    error: String,
    code: String,
}

impl IntoResponse for ErrorResponse {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(self)).into_response()
    }
}

/// Create API router with all routes
pub fn create_api_router(state: Arc<WebState>) -> Router {
    let rate_limiters = Arc::new(create_rate_limiters(&state.config));

    Router::new()
        // Health check (no auth required)
        .route("/health", get(health_check))
        // Bot status (optional auth)
        .route(
            "/status",
            get(bot_status).layer(middleware::from_fn_with_state(
                state.clone(),
                optional_auth_middleware,
            )),
        )
        // Bot state (auth required)
        .route(
            "/state",
            get(bot_state).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        // Bot vitals
        .route(
            "/vitals",
            get(bot_vitals).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        // Inventory
        .route(
            "/inventory",
            get(bot_inventory).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        // Equipment
        .route(
            "/equipment",
            get(bot_equipment).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        // Players
        .route(
            "/players",
            get(bot_players).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        // Map
        .route(
            "/map",
            get(bot_map).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        // Logs
        .route(
            "/logs",
            get(bot_logs).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        // Settings
        .route(
            "/settings",
            get(get_settings)
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    auth_middleware,
                ))
                .patch(update_settings)
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    require_trusted(),
                )),
        )
        // Locations
        .route(
            "/locations",
            get(get_locations).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        .route(
            "/locations",
            post(save_location).layer(middleware::from_fn_with_state(
                state.clone(),
                require_trusted(),
            )),
        )
        .route(
            "/locations/:name",
            delete(delete_location).layer(middleware::from_fn_with_state(
                state.clone(),
                require_admin(),
            )),
        )
        // Memory
        .route(
            "/memory",
            get(get_memory).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        .route(
            "/memory/context",
            get(get_memory_context).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        .route(
            "/memory/facts",
            get(get_memory_facts).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        .route(
            "/memory/facts",
            post(add_memory_fact).layer(middleware::from_fn_with_state(
                state.clone(),
                require_trusted(),
            )),
        )
        .route(
            "/memory/facts/:key",
            delete(delete_memory_fact).layer(middleware::from_fn_with_state(
                state.clone(),
                require_admin(),
            )),
        )
        .route(
            "/memory/rules",
            get(get_memory_rules).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        .route(
            "/memory/rules",
            post(add_memory_rule).layer(middleware::from_fn_with_state(
                state.clone(),
                require_admin(),
            )),
        )
        .route(
            "/memory/rules/:rule",
            delete(delete_memory_rule).layer(middleware::from_fn_with_state(
                state.clone(),
                require_admin(),
            )),
        )
        .route(
            "/memory/task",
            get(get_memory_task).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        .route(
            "/memory/players",
            get(get_memory_players).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        .route(
            "/memory/save",
            post(save_memory).layer(middleware::from_fn_with_state(
                state.clone(),
                require_admin(),
            )),
        )
        .route(
            "/memory/clear",
            post(clear_memory).layer(middleware::from_fn_with_state(
                state.clone(),
                require_admin(),
            )),
        )
        // Commands
        .route(
            "/commands",
            get(get_commands).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        .route(
            "/commands/execute",
            post(execute_command).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        // Config
        .route(
            "/config",
            get(get_config).layer(middleware::from_fn_with_state(
                state.clone(),
                require_admin(),
            )),
        )
        // Stats
        .route(
            "/stats",
            get(get_stats).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        // Chat
        .route(
            "/chat",
            get(get_chat).layer(middleware::from_fn_with_state(
                state.clone(),
                auth_middleware,
            )),
        )
        .route(
            "/chat",
            post(send_chat).layer(middleware::from_fn_with_state(
                state.clone(),
                require_trusted(),
            )),
        )
        // Console
        .route(
            "/console",
            post(execute_console).layer(middleware::from_fn_with_state(
                state.clone(),
                require_admin(),
            )),
        )
        // Bot control
        .route(
            "/bot/restart",
            post(restart_bot).layer(middleware::from_fn_with_state(
                state.clone(),
                require_admin(),
            )),
        )
        .route(
            "/bot/shutdown",
            post(shutdown_bot).layer(middleware::from_fn_with_state(
                state.clone(),
                require_admin(),
            )),
        )
        // Global rate limiting
        .layer(middleware::from_fn_with_state(
            rate_limiters,
            rate_limit_middleware,
        ))
        .with_state(state)
}

/// Health check endpoint
async fn health_check() -> Json<HealthResponse> {
    Json(HealthResponse {
        success: true,
        status: "ok".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        uptime: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

/// Get bot status
async fn bot_status(
    State(state): State<Arc<WebState>>,
) -> Result<Json<StatusResponse>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let status = runtime.get_status().await;
        Ok(Json(StatusResponse {
            success: true,
            data: serde_json::to_value(status).unwrap_or(json!({})),
        }))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Get full bot state
async fn bot_state(
    State(state): State<Arc<WebState>>,
) -> Result<Json<StatusResponse>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let bot_state = runtime.get_state().await;
        Ok(Json(StatusResponse {
            success: true,
            data: serde_json::to_value(bot_state).unwrap_or(json!({})),
        }))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Get bot vitals
async fn bot_vitals(
    State(state): State<Arc<WebState>>,
) -> Result<Json<VitalsResponse>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let vitals = runtime.get_vitals().await;
        Ok(Json(VitalsResponse {
            success: true,
            data: serde_json::to_value(vitals).unwrap_or(json!({})),
        }))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Get bot inventory
async fn bot_inventory(
    State(state): State<Arc<WebState>>,
) -> Result<Json<InventoryResponse>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let inventory = runtime.get_inventory().await;
        Ok(Json(InventoryResponse {
            success: true,
            data: serde_json::to_value(inventory).unwrap_or(json!({})),
        }))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Get bot equipment
async fn bot_equipment(
    State(state): State<Arc<WebState>>,
) -> Result<Json<EquipmentResponse>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let equipment = runtime.get_equipment().await;
        Ok(Json(EquipmentResponse {
            success: true,
            data: serde_json::to_value(equipment).unwrap_or(json!({})),
        }))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Get players
async fn bot_players(
    State(state): State<Arc<WebState>>,
) -> Result<Json<PlayersResponse>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let players = runtime.get_players().await;
        let runtime_state = runtime.get_state().await;

        Ok(Json(PlayersResponse {
            success: true,
            data: json!({
                "players": players,
                "count": players.len(),
                "admins": runtime_state.get("admins").cloned().unwrap_or(json!([])),
            }),
        }))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Get map data
async fn bot_map(
    State(state): State<Arc<WebState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<MapResponse>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let radius = params
            .get("radius")
            .and_then(|s| s.parse().ok())
            .unwrap_or(15);
        let map_data = runtime.get_map(radius).await;
        Ok(Json(MapResponse {
            success: true,
            data: serde_json::to_value(map_data).unwrap_or(json!({})),
        }))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Get logs
async fn bot_logs(
    State(state): State<Arc<WebState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<LogsResponse>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let limit = params
            .get("limit")
            .and_then(|s| s.parse().ok())
            .unwrap_or(100);
        let logs = runtime.get_logs(limit).await;
        Ok(Json(LogsResponse {
            success: true,
            data: json!({
                "logs": logs,
                "total": runtime.get_logs_count().await,
            }),
        }))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Get settings
async fn get_settings(
    State(state): State<Arc<WebState>>,
) -> Result<Json<SettingsResponse>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let settings = runtime.get_settings().await;
        Ok(Json(SettingsResponse {
            success: true,
            data: settings,
        }))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Update settings
async fn update_settings(
    State(state): State<Arc<WebState>>,
    Json(settings): Json<serde_json::Value>,
) -> Result<Json<SettingsResponse>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        runtime.update_settings(settings.clone()).await;
        Ok(Json(SettingsResponse {
            success: true,
            data: settings,
        }))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Get locations
async fn get_locations(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    Ok(Json(json!({
        "success": true,
        "data": memory.locations,
    })))
}

/// Save location
async fn save_location(
    State(state): State<Arc<WebState>>,
    Json(payload): Json<LocationRequest>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    if payload.name.is_empty() {
        return Err(ErrorResponse {
            success: false,
            error: "Name and position required".to_string(),
            code: "BAD_REQUEST".to_string(),
        });
    }

    let mut memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    let pos = payload.position.unwrap_or_else(|| {
        if let Some(runtime_arc) = state.runtime.as_ref() {
            let runtime = runtime_arc.read().await;
            runtime.get_position_blocking()
        } else {
            crate::web::socket::events::BotPosition {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            }
        }
    });

    memory.save_location(
        &payload.name,
        pos,
        payload
            .location_type
            .unwrap_or_else(|| "waypoint".to_string()),
    );
    memory
        .save(&state.config.memory.file_path)
        .await
        .map_err(|e| ErrorResponse {
            success: false,
            error: e.to_string(),
            code: "INTERNAL_ERROR".to_string(),
        })?;

    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        runtime.add_favorite(&payload.name, pos).await;
    }

    Ok(Json(json!({
        "success": true,
        "message": format!("Location \"{}\" saved", payload.name),
    })))
}

/// Delete location
async fn delete_location(
    State(state): State<Arc<WebState>>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let mut memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();

    if memory
        .locations
        .as_object()
        .is_some_and(|o| o.contains_key(&name))
    {
        memory.locations.as_object_mut().unwrap().remove(&name);
        memory
            .save(&state.config.memory.file_path)
            .await
            .map_err(|e| ErrorResponse {
                success: false,
                error: e.to_string(),
                code: "INTERNAL_ERROR".to_string(),
            })?;

        Ok(Json(json!({
            "success": true,
            "message": format!("Location \"{}\" deleted", name),
        })))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Location not found".to_string(),
            code: "NOT_FOUND".to_string(),
        })
    }
}

/// Get all memory
async fn get_memory(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    Ok(Json(json!({
        "success": true,
        "data": memory,
    })))
}

/// Get memory context for AI
async fn get_memory_context(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    let context = memory.get_context();
    Ok(Json(json!({
        "success": true,
        "data": { "context": context },
    })))
}

/// Get memory facts
async fn get_memory_facts(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    Ok(Json(json!({
        "success": true,
        "data": memory.learned_facts,
    })))
}

/// Add memory fact
async fn add_memory_fact(
    State(state): State<Arc<WebState>>,
    Json(payload): Json<MemoryFactRequest>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    if payload.key.is_empty() || payload.fact.is_empty() {
        return Err(ErrorResponse {
            success: false,
            error: "Key and fact required".to_string(),
            code: "BAD_REQUEST".to_string(),
        });
    }

    let mut memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    let success = memory.remember_fact(&payload.key, &payload.fact);
    memory
        .save(&state.config.memory.file_path)
        .await
        .map_err(|e| ErrorResponse {
            success: false,
            error: e.to_string(),
            code: "INTERNAL_ERROR".to_string(),
        })?;

    Ok(Json(json!({
        "success": success,
        "message": if success { format!("Fact \"{}\" remembered", payload.key) } else { "Failed to remember fact".to_string() },
    })))
}

/// Delete memory fact
async fn delete_memory_fact(
    State(state): State<Arc<WebState>>,
    axum::extract::Path(key): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let mut memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    let success = memory.forget_fact(&key);
    memory
        .save(&state.config.memory.file_path)
        .await
        .map_err(|e| ErrorResponse {
            success: false,
            error: e.to_string(),
            code: "INTERNAL_ERROR".to_string(),
        })?;

    Ok(Json(json!({
        "success": success,
        "message": if success { format!("Fact \"{}\" forgotten", key) } else { "Fact not found".to_string() },
    })))
}

/// Get memory rules
async fn get_memory_rules(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    Ok(Json(json!({
        "success": true,
        "data": memory.rules,
    })))
}

/// Add memory rule
async fn add_memory_rule(
    State(state): State<Arc<WebState>>,
    Json(payload): Json<MemoryRuleRequest>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    if payload.rule.is_empty() {
        return Err(ErrorResponse {
            success: false,
            error: "Rule required".to_string(),
            code: "BAD_REQUEST".to_string(),
        });
    }

    let mut memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    let success = memory.add_rule(&payload.rule);
    memory
        .save(&state.config.memory.file_path)
        .await
        .map_err(|e| ErrorResponse {
            success: false,
            error: e.to_string(),
            code: "INTERNAL_ERROR".to_string(),
        })?;

    Ok(Json(json!({
        "success": success,
        "message": if success { "Rule added".to_string() } else { "Rule already exists or failed".to_string() },
    })))
}

/// Delete memory rule
async fn delete_memory_rule(
    State(state): State<Arc<WebState>>,
    axum::extract::Path(rule): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let mut memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    let success = memory.remove_rule(&rule);
    memory
        .save(&state.config.memory.file_path)
        .await
        .map_err(|e| ErrorResponse {
            success: false,
            error: e.to_string(),
            code: "INTERNAL_ERROR".to_string(),
        })?;

    Ok(Json(json!({
        "success": success,
        "message": if success { "Rule removed".to_string() } else { "Rule not found".to_string() },
    })))
}

/// Get memory current task
async fn get_memory_task(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    Ok(Json(json!({
        "success": true,
        "data": memory.current_task,
    })))
}

/// Get memory players
async fn get_memory_players(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    Ok(Json(json!({
        "success": true,
        "data": memory.players,
    })))
}

/// Save memory
async fn save_memory(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let mut memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    let success = memory.save(&state.config.memory.file_path).await.is_ok();
    Ok(Json(json!({
        "success": success,
        "message": if success { "Memory saved" } else { "Memory is disabled" },
    })))
}

/// Clear memory
async fn clear_memory(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let mut memory = Memory::load(&state.config.memory.file_path)
        .await
        .unwrap_or_default();
    let success = memory.clear().is_ok();
    Ok(Json(json!({
        "success": success,
        "message": if success { "Memory cleared" } else { "Memory is disabled" },
    })))
}

/// Get commands list
async fn get_commands(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let commands = runtime.get_command_definitions().await;
        let commands_list: Vec<serde_json::Value> = commands
            .into_iter()
            .map(|cmd| {
                json!({
                    "name": cmd.name,
                    "aliases": cmd.aliases,
                    "description": cmd.description,
                    "usage": cmd.usage,
                    "category": cmd.category,
                    "permission": cmd.permission,
                    "adminOnly": cmd.admin_only,
                    "pmOnly": cmd.pm_only,
                    "hidden": cmd.hidden,
                })
            })
            .collect();

        Ok(Json(json!({
            "success": true,
            "data": { "commands": commands_list },
        })))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Execute command
async fn execute_command(
    State(state): State<Arc<WebState>>,
    Json(payload): Json<CommandExecuteRequest>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let args: Vec<String> = match &payload.args {
            Some(serde_json::Value::String(s)) => vec![s.clone()],
            Some(serde_json::Value::Array(arr)) => arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            _ => vec![],
        };

        // We need auth claims - for now use placeholder
        let context = crate::bot::runtime::CommandContext {
            bot: runtime.get_bot().await,
            username: "api".to_string(),
            args,
            is_admin: true,
            is_pm: true,
            reply_sender: None,
            private_sender: None,
        };

        let result = runtime.execute_command(&payload.command, context).await;

        Ok(Json(json!({
            "success": result,
            "command": payload.command,
            "message": if result { "Command executed" } else { "Command failed or not found" },
        })))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot not connected".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Get config (safe version)
async fn get_config(
    State(state): State<Arc<WebState>>,
) -> Result<Json<ConfigResponse>, ErrorResponse> {
    let config = &state.config;
    let safe_config = json!({
        "bot": {
            "host": config.bot.host,
            "port": config.bot.port,
            "username": config.bot.username,
            "version": config.bot.version,
            "auth": config.bot.auth,
        },
        "web": {
            "port": config.web.port,
            "host": config.web.host,
        },
        "memory": {
            "enabled": config.memory.enabled,
            "filePath": config.memory.file_path,
        },
        "prefix": config.prefix,
    });

    Ok(Json(ConfigResponse {
        success: true,
        data: safe_config,
    }))
}

/// Get stats
async fn get_stats(
    State(state): State<Arc<WebState>>,
) -> Result<Json<StatsResponse>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let bot_state = runtime.get_state().await;
        let bot = runtime.get_bot().await;

        let features = bot_state.get("features").cloned().unwrap_or(json!({}));

        Ok(Json(StatsResponse {
            success: true,
            data: json!({
                "uptime": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64(),
                "memoryUsage": json!({
                    "rss": 0, // Would need sysinfo crate
                }),
                "bot": {
                    "online": bot.is_some(),
                    "username": bot.as_ref().map(|b| b.username()),
                    "health": bot.as_ref().map(|b| b.health()),
                    "food": bot.as_ref().map(|b| b.food()),
                    "position": bot.as_ref().map(|b| b.position()),
                },
                "state": {
                    "logsCount": bot_state.get("logs").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
                    "inventoryCount": bot_state.get("inventory").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
                    "favoritesCount": bot_state.get("favorites").and_then(|v| v.as_object()).map(|o| o.len()).unwrap_or(0),
                    "adminsCount": bot_state.get("admins").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
                    "usersCount": bot_state.get("users").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
                },
                "features": features,
            }),
        }))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Get chat history
async fn get_chat(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        let limit = 50;
        let logs = runtime.get_chat_logs(limit).await;
        Ok(Json(json!({
            "success": true,
            "data": { "logs": logs },
        })))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Send chat message
async fn send_chat(
    State(state): State<Arc<WebState>>,
    Json(payload): Json<ChatMessageRequest>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    if payload.message.is_empty() {
        return Err(ErrorResponse {
            success: false,
            error: "Message required".to_string(),
            code: "BAD_REQUEST".to_string(),
        });
    }

    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        runtime
            .send_chat(&payload.message)
            .await
            .map_err(|e| ErrorResponse {
                success: false,
                error: e.to_string(),
                code: "INTERNAL_ERROR".to_string(),
            })?;
        Ok(Json(json!({
            "success": true,
            "message": "Chat message sent",
        })))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Execute console command
async fn execute_console(
    State(state): State<Arc<WebState>>,
    Json(payload): Json<ConsoleCommandRequest>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    if payload.command.is_empty() {
        return Err(ErrorResponse {
            success: false,
            error: "Command required".to_string(),
            code: "BAD_REQUEST".to_string(),
        });
    }

    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        runtime
            .execute_command(&format!("/{}", payload.command))
            .await
            .map_err(|e| ErrorResponse {
                success: false,
                error: e.to_string(),
                code: "INTERNAL_ERROR".to_string(),
            })?;
        Ok(Json(json!({
            "success": true,
            "message": format!("Executed: /{}", payload.command),
        })))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Restart bot
async fn restart_bot(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        runtime.restart().await;
        Ok(Json(json!({
            "success": true,
            "message": "Bot restart initiated",
        })))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}

/// Shutdown bot
async fn shutdown_bot(
    State(state): State<Arc<WebState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    if let Some(runtime_arc) = state.runtime.as_ref() {
        let runtime = runtime_arc.read().await;
        runtime.shutdown().await;
        Ok(Json(json!({
            "success": true,
            "message": "Bot shut down",
        })))
    } else {
        Err(ErrorResponse {
            success: false,
            error: "Bot manager not initialized".to_string(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        })
    }
}
