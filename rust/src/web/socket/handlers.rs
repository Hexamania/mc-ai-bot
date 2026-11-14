use axum::extract::State;
/**
 * Socket.io event handlers for web server
 * Handles all real-time communication between bot and dashboard
 */
use socketioxide::SocketIo;
use socketioxide::extract::{Data, SocketRef};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use crate::{
    bot::minecraft::MinecraftConnection,
    bot::runtime::MinecraftRuntime,
    config::AppConfig,
    web::{
        WebState,
        auth::{Claims, extract_socket_token, verify_socket_token},
        socket::events::*,
    },
};

/// Socket user data
#[derive(Debug, Clone)]
pub struct SocketUser {
    pub username: String,
    pub role: crate::web::auth::UserRole,
}

/// Set up main namespace handlers
pub fn setup_main_namespace(
    io: &SocketIo,
    state: Arc<WebState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state_clone = state.clone();

    io.ns(namespaces::MAIN)
        .on_connect(move |socket: SocketRef| {
            let state = state_clone.clone();

            // Authentication - extract token from socket handshake auth
            let auth_value = socket.auth();
            let query_value = socket.query();

            let token = extract_socket_token(auth_value.as_ref(), query_value.as_ref());

            if let Some(token) = token {
                let config = state.config.clone();
                if let Ok(claims) = verify_socket_token(&config, &token) {
                    let user = SocketUser {
                        username: claims.sub,
                        role: claims.role,
                    };

                    // Store user data in socket
                    socket.data.insert(user.clone());

                    // Join default rooms
                    socket.join(rooms::ALL).ok();
                    match user.role {
                        crate::web::auth::UserRole::Admin => {
                            socket.join(rooms::ADMINS).ok();
                        }
                        crate::web::auth::UserRole::Trusted => {
                            socket.join(rooms::TRUSTED).ok();
                        }
                        _ => {}
                    }

                    // Send initial state
                    send_initial_state(&socket, &state);

                    // Set up event handlers
                    setup_socket_event_handlers(socket, state);
                } else {
                    socket
                        .emit(server_events::AUTH_FAILED, "Invalid token")
                        .ok();
                    socket.disconnect().ok();
                }
            } else {
                socket
                    .emit(server_events::AUTH_FAILED, "Authentication required")
                    .ok();
                socket.disconnect().ok();
            }

            // Handle disconnection
            socket.on_disconnect(move |_socket: SocketRef, reason: String| {
                info!("[SOCKET] Dashboard disconnected: {}", reason);
            });
        });

    Ok(())
}

/// Set up admin namespace handlers
pub fn setup_admin_namespace(
    io: &SocketIo,
    state: Arc<WebState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state_clone = state.clone();

    io.ns(namespaces::ADMIN)
        .on_connect(move |socket: SocketRef| {
            let state = state_clone.clone();

            // Check if user is admin - get user from socket data
            let is_admin = socket
                .data
                .get::<SocketUser>()
                .map(|user| matches!(user.role, crate::web::auth::UserRole::Admin))
                .unwrap_or(false);

            if !is_admin {
                socket
                    .emit(server_events::AUTH_FAILED, "Admin access required")
                    .ok();
                socket.disconnect().ok();
                return;
            }

            info!("[SOCKET] Admin connected: {}", socket.id);

            // Admin-only events
            socket.on(
                client_events::EXECUTE_CONSOLE_COMMAND,
                move |socket: SocketRef, Data(data): Data<serde_json::Value>| {
                    let state = state.clone();
                    let command = data.get("command").and_then(|v| v.as_str()).unwrap_or("");
                    let request_id = data.get("requestId").and_then(|v| v.as_str());

                    if !command.is_empty() {
                        // Execute console command via bot
                        tokio::spawn(async move {
                            if let Some(runtime_arc) = state.runtime.as_ref() {
                                let runtime = runtime_arc.read().await;
                                runtime.execute_command(command).await;
                                socket
                                    .emit(
                                        server_events::COMMAND_RESULT,
                                        CommandResultPayload {
                                            request_id: request_id.map(|s| s.to_string()),
                                            command: format!("console:{}", command),
                                            success: true,
                                            output: Some(format!("Executed: /{}", command)),
                                            error: None,
                                            execution_time: None,
                                        },
                                    )
                                    .ok();
                            }
                        });
                    }
                },
            );
        });

    Ok(())
}

/// Set up commands namespace handlers
pub fn setup_commands_namespace(
    io: &SocketIo,
    state: Arc<WebState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state_clone = state.clone();

    io.ns(namespaces::COMMANDS)
        .on_connect(move |socket: SocketRef| {
            let state = state_clone.clone();

            // Authentication
            let auth_value = socket.auth();
            let query_value = socket.query();

            let token = extract_socket_token(auth_value.as_ref(), query_value.as_ref());

            if let Some(token) = token {
                let config = state.config.clone();
                if verify_socket_token(&config, &token).is_ok() {
                    socket.data.insert(SocketUser {
                        username: "dashboard".to_string(),
                        role: crate::web::auth::UserRole::Admin,
                    });
                } else {
                    socket
                        .emit(server_events::AUTH_FAILED, "Invalid token")
                        .ok();
                    socket.disconnect().ok();
                    return;
                }
            } else {
                socket
                    .emit(server_events::AUTH_FAILED, "Authentication required")
                    .ok();
                socket.disconnect().ok();
                return;
            }

            // Get command list
            socket.on(
                client_events::GET_COMMANDS,
                move |socket: SocketRef, _data: Data<()>| {
                    let state = state.clone();
                    tokio::spawn(async move {
                        if let Some(runtime_arc) = state.runtime.as_ref() {
                            let runtime = runtime_arc.read().await;
                            let commands = runtime.get_command_definitions().await;
                            let commands_list: Vec<serde_json::Value> = commands
                                .into_iter()
                                .map(|cmd| {
                                    serde_json::json!({
                                        "name": cmd.name,
                                        "aliases": cmd.aliases,
                                        "description": cmd.description,
                                        "usage": cmd.usage,
                                        "category": cmd.category,
                                        "permission": cmd.permission,
                                    })
                                })
                                .collect();

                            socket
                                .emit(
                                    server_events::COMMAND_LIST,
                                    serde_json::json!({
                                        "commands": commands_list
                                    }),
                                )
                                .ok();
                        }
                    });
                },
            );

            // Get command help
            socket.on(
                client_events::GET_COMMAND_HELP,
                move |socket: SocketRef, Data(data): Data<serde_json::Value>| {
                    let state = state.clone();
                    let command = data.get("command").and_then(|v| v.as_str()).unwrap_or("");
                    let prefix = data.get("prefix").and_then(|v| v.as_str()).unwrap_or("!");

                    if !command.is_empty() {
                        let state = state.clone();
                        tokio::spawn(async move {
                            if let Some(runtime_arc) = state.runtime.as_ref() {
                                let runtime = runtime_arc.read().await;
                                let help = runtime.get_command_help(command, prefix).await;
                                let has_help = !help.contains("Unknown command");
                                socket
                                    .emit(
                                        server_events::COMMAND_RESULT,
                                        CommandResultPayload {
                                            request_id: None,
                                            command: command.to_string(),
                                            success: has_help,
                                            output: Some(help),
                                            error: if has_help {
                                                None
                                            } else {
                                                Some(format!("No help found for \"{}\"", command))
                                            },
                                            execution_time: None,
                                        },
                                    )
                                    .ok();
                            }
                        });
                    }
                },
            );

            // Execute command
            socket.on(
                client_events::SEND_COMMAND,
                move |socket: SocketRef, Data(data): Data<SendCommandPayload>| {
                    let state = state.clone();
                    let request_id = data.request_id.clone().unwrap_or_else(|| {
                        format!(
                            "cmd_{}_{}",
                            chrono::Utc::now().timestamp_millis(),
                            uuid::Uuid::new_v4().simple()
                        )
                    });
                    let start_time = std::time::Instant::now();

                    tokio::spawn(async move {
                        if let Some(runtime_arc) = state.runtime.as_ref() {
                            let runtime = runtime_arc.read().await;

                            let result = runtime.execute_command(&data.command).await;
                            let execution_time = start_time.elapsed().as_millis() as u64;

                            let success = result.is_ok();
                            let output = if let Ok(_) = result {
                                Some("Command executed".to_string())
                            } else {
                                None
                            };
                            let error = if let Err(e) = result {
                                Some(e.to_string())
                            } else {
                                None
                            };

                            socket
                                .emit(
                                    server_events::COMMAND_RESULT,
                                    CommandResultPayload {
                                        request_id: Some(request_id),
                                        command: data.command,
                                        success,
                                        output,
                                        error,
                                        execution_time: Some(execution_time),
                                    },
                                )
                                .ok();
                        } else {
                            socket
                                .emit(
                                    server_events::COMMAND_RESULT,
                                    CommandResultPayload {
                                        request_id: Some(request_id),
                                        command: data.command,
                                        success: false,
                                        output: None,
                                        error: Some("Bot not connected".to_string()),
                                        execution_time: Some(
                                            start_time.elapsed().as_millis() as u64
                                        ),
                                    },
                                )
                                .ok();
                        }
                    });
                },
            );
        });

    Ok(())
}

/// Initialize all namespaces
pub fn initialize_all_namespaces(
    io: &SocketIo,
    state: Arc<WebState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    setup_main_namespace(io, state.clone())?;
    setup_admin_namespace(io, state.clone())?;
    setup_commands_namespace(io, state.clone())?;
    Ok(())
}

/// Send initial state to newly connected client
fn send_initial_state(socket: &SocketRef, state: &WebState) {
    tokio::spawn(async move {
        if let Some(runtime_arc) = state.runtime.as_ref() {
            let runtime = runtime_arc.read().await;
            let status = runtime.get_status().await;
            let bot_state = runtime.get_full_state().await;

            socket.emit(server_events::BOT_STATUS, status).ok();
            socket
                .emit(server_events::BOT_STATE, bot_state.clone())
                .ok();
            socket.emit(server_events::BULK_UPDATE, bot_state).ok();

            // Send command list
            let commands = runtime.get_command_definitions().await;
            let commands_list: Vec<serde_json::Value> = commands
                .into_iter()
                .map(|cmd| {
                    serde_json::json!({
                        "name": cmd.name,
                        "aliases": cmd.aliases,
                        "description": cmd.description,
                        "usage": cmd.usage,
                        "category": cmd.category,
                        "permission": cmd.permission,
                    })
                })
                .collect();
            socket
                .emit(
                    server_events::COMMAND_LIST,
                    serde_json::json!({ "commands": commands_list }),
                )
                .ok();
        }
    });
}

/// Set up individual socket event handlers for bot control
fn setup_socket_event_handlers(socket: SocketRef, state: Arc<WebState>, io: SocketIo) {
    // Get current state
    socket.on(
        client_events::GET_STATE,
        move |socket: SocketRef, _data: Data<()>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let runtime = runtime_arc.read().await;
                    let bot_state = runtime.get_full_state().await;
                    socket.emit(server_events::BOT_STATE, bot_state).ok();
                }
            });
        },
    );

    socket.on(
        client_events::GET_STATUS,
        move |socket: SocketRef, _data: Data<()>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let runtime = runtime_arc.read().await;
                    let status = runtime.get_status().await;
                    socket.emit(server_events::BOT_STATUS, status).ok();
                }
            });
        },
    );

    // Movement commands
    socket.on(
        client_events::MOVE_TO,
        move |_socket: SocketRef, Data(data): Data<MoveToPayload>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.move_to(data.x, data.y, data.z).await;
                    if let Some(conn) = state.connection.read().await.as_ref() {
                        conn.say(&format!(
                            "📍 Dashboard: Heading to {}, {}, {}",
                            data.x as i32, data.y as i32, data.z as i32
                        ))
                        .await;
                    }
                }
            });
        },
    );

    socket.on(
        client_events::FOLLOW_PLAYER,
        move |socket: SocketRef, Data(data): Data<FollowPlayerPayload>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    let result = runtime.follow_player(&data.username).await;
                    if !result {
                        socket
                            .emit(
                                server_events::COMMAND_RESULT,
                                CommandResultPayload {
                                    request_id: None,
                                    command: "follow".to_string(),
                                    success: false,
                                    error: Some(format!("Player \"{}\" not found", data.username)),
                                    output: None,
                                    execution_time: None,
                                },
                            )
                            .ok();
                    }
                }
            });
        },
    );

    socket.on(
        client_events::STOP_MOVEMENT,
        move |socket: SocketRef, _data: Data<()>| {
            let state = state.clone();
            let io = io.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.stop_all_movement().await;

                    // Broadcast feature toggled
                    if let Some(ns) = io.ns(namespaces::MAIN) {
                        ns.to(rooms::ALL)
                            .emit(
                                server_events::FEATURE_TOGGLED,
                                FeatureToggledPayload {
                                    feature: "all".to_string(),
                                    enabled: false,
                                },
                            )
                            .ok();
                    }

                    // Broadcast bulk update
                    let bot_state = runtime.get_full_state().await;
                    if let Some(ns) = io.ns(namespaces::MAIN) {
                        ns.to(rooms::ALL)
                            .emit(server_events::BULK_UPDATE, bot_state)
                            .ok();
                    }

                    if let Some(conn) = state.connection.read().await.as_ref() {
                        conn.say("⛔ Movement halted via dashboard").await;
                    }
                }
            });
        },
    );

    socket.on(
        client_events::SET_HOME,
        move |socket: SocketRef, _data: Data<()>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.set_home().await;
                    if let Some(conn) = state.connection.read().await.as_ref() {
                        let pos = runtime.get_position().unwrap_or_else(|| {
                            crate::web::socket::events::BotPosition {
                                x: 0.0,
                                y: 0.0,
                                z: 0.0,
                            }
                        });
                        conn.say(&format!(
                            "🏠 Home set to {}, {}, {}",
                            pos.x as i32, pos.y as i32, pos.z as i32
                        ))
                        .await;
                    }
                    socket
                        .emit(
                            server_events::LOCATION_SAVED,
                            serde_json::json!({
                                "name": "home",
                                "position": pos
                            }),
                        )
                        .ok();
                }
            });
        },
    );

    socket.on(
        client_events::GO_HOME,
        move |_socket: SocketRef, _data: Data<()>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.go_home().await;
                    if let Some(conn) = state.connection.read().await.as_ref() {
                        if let Some(pos) = runtime.get_base_location() {
                            conn.say(&format!(
                                "🏠 Returning home to {}, {}, {}",
                                pos.x as i32, pos.y as i32, pos.z as i32
                            ))
                            .await;
                        }
                    }
                }
            });
        },
    );

    // Inventory commands
    socket.on(
        client_events::DROP_ITEM,
        move |_socket: SocketRef, Data(data): Data<DropItemPayload>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.drop_item(data.slot, data.count).await;
                }
            });
        },
    );

    socket.on(
        client_events::DROP_ALL,
        move |_socket: SocketRef, _data: Data<()>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.drop_all_items().await;
                    if let Some(conn) = state.connection.read().await.as_ref() {
                        conn.say("🗑️ Dashboard triggered: Dropped entire inventory.")
                            .await;
                    }
                }
            });
        },
    );

    socket.on(
        client_events::MOVE_ITEM,
        move |_socket: SocketRef, Data(data): Data<MoveItemPayload>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.move_item(data.from, data.to).await;
                }
            });
        },
    );

    socket.on(
        client_events::SET_HOTBAR,
        move |_socket: SocketRef, Data(slot): Data<i32>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.set_hotbar_slot(slot).await;
                }
            });
        },
    );

    // Block interaction
    socket.on(
        client_events::MINE_BLOCK,
        move |socket: SocketRef, Data(data): Data<MineBlockPayload>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.mine_block(data.x, data.y, data.z).await;
                    socket
                        .emit(
                            server_events::COMMAND_RESULT,
                            serde_json::json!({
                                "success": true,
                                "action": "mine_block"
                            }),
                        )
                        .ok();
                }
            });
        },
    );

    socket.on(
        client_events::PLACE_BLOCK,
        move |socket: SocketRef, Data(data): Data<PlaceBlockPayload>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime
                        .place_block(data.x, data.y, data.z, data.block_type)
                        .await;
                    socket
                        .emit(
                            server_events::COMMAND_RESULT,
                            serde_json::json!({
                                "success": true,
                                "action": "place_block"
                            }),
                        )
                        .ok();
                }
            });
        },
    );

    // Combat toggles
    socket.on(
        client_events::TOGGLE_KILLAURA,
        move |socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state.clone();
            let io = io.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.toggle_kill_aura(enabled);

                    // Broadcast feature toggled
                    if let Some(ns) = io.ns(namespaces::MAIN) {
                        ns.to(rooms::ALL)
                            .emit(
                                server_events::FEATURE_TOGGLED,
                                FeatureToggledPayload {
                                    feature: "killAura".to_string(),
                                    enabled,
                                },
                            )
                            .ok();
                    }

                    // Broadcast bulk update
                    let bot_state = runtime.get_full_state().await;
                    if let Some(ns) = io.ns(namespaces::MAIN) {
                        ns.to(rooms::ALL)
                            .emit(server_events::BULK_UPDATE, bot_state)
                            .ok();
                    }
                }
            });
        },
    );

    socket.on(
        client_events::TOGGLE_AUTODEFENSE,
        move |socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state.clone();
            let io = io.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.toggle_auto_defense(enabled);

                    if let Some(ns) = io.ns(namespaces::MAIN) {
                        ns.to(rooms::ALL)
                            .emit(
                                server_events::FEATURE_TOGGLED,
                                FeatureToggledPayload {
                                    feature: "autoDefense".to_string(),
                                    enabled,
                                },
                            )
                            .ok();
                    }

                    let bot_state = runtime.get_full_state().await;
                    if let Some(ns) = io.ns(namespaces::MAIN) {
                        ns.to(rooms::ALL)
                            .emit(server_events::BULK_UPDATE, bot_state)
                            .ok();
                    }
                }
            });
        },
    );

    // Automation toggles
    socket.on(
        client_events::TOGGLE_ROAMING,
        move |socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    if enabled {
                        runtime.start_roaming();
                        if let Some(conn) = state.connection.read().await.as_ref() {
                            conn.say("🚶 Roaming protocol active").await;
                        }
                    } else {
                        runtime.stop_roaming();
                        if let Some(conn) = state.connection.read().await.as_ref() {
                            conn.say("⛔ Roaming stopped").await;
                        }
                    }

                    socket
                        .emit(
                            server_events::FEATURE_TOGGLED,
                            FeatureToggledPayload {
                                feature: "roaming".to_string(),
                                enabled,
                            },
                        )
                        .ok();
                }
            });
        },
    );

    socket.on(
        client_events::TOGGLE_FARMING,
        move |socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    if enabled {
                        runtime.start_farming();
                    } else {
                        runtime.stop_farming();
                    }
                    socket
                        .emit(
                            server_events::FEATURE_TOGGLED,
                            FeatureToggledPayload {
                                feature: "farming".to_string(),
                                enabled,
                            },
                        )
                        .ok();
                }
            });
        },
    );

    socket.on(
        client_events::TOGGLE_MINING,
        move |socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    if enabled {
                        runtime.start_mining();
                    } else {
                        runtime.stop_mining();
                    }
                    socket
                        .emit(
                            server_events::FEATURE_TOGGLED,
                            FeatureToggledPayload {
                                feature: "mining".to_string(),
                                enabled,
                            },
                        )
                        .ok();
                }
            });
        },
    );

    socket.on(
        client_events::TOGGLE_LUMBERJACK,
        move |socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    if enabled {
                        runtime.start_lumberjack();
                    } else {
                        runtime.stop_lumberjack();
                    }
                    socket
                        .emit(
                            server_events::FEATURE_TOGGLED,
                            FeatureToggledPayload {
                                feature: "lumberjack".to_string(),
                                enabled,
                            },
                        )
                        .ok();
                }
            });
        },
    );

    socket.on(
        client_events::START_PROGRESSION,
        move |_socket: SocketRef, _data: Data<()>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.start_progression();
                    if let Some(conn) = state.connection.read().await.as_ref() {
                        conn.say("🚀 Speedrun Protocol initiated!").await;
                    }
                }
            });
        },
    );

    socket.on(
        client_events::STOP_ALL_TASKS,
        move |socket: SocketRef, _data: Data<()>| {
            let state = state.clone();
            let io = io.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.stop_all_tasks();

                    // Broadcast feature toggled
                    if let Some(ns) = io.ns(namespaces::MAIN) {
                        ns.to(rooms::ALL)
                            .emit(
                                server_events::FEATURE_TOGGLED,
                                FeatureToggledPayload {
                                    feature: "all".to_string(),
                                    enabled: false,
                                },
                            )
                            .ok();
                    }

                    if let Some(conn) = state.connection.read().await.as_ref() {
                        conn.say("⛔ All tasks stopped via dashboard").await;
                    }
                }
            });
        },
    );

    // Settings
    socket.on(
        client_events::TOGGLE_SAFEMODE,
        move |_socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.toggle_safe_mode(enabled);
                }
            });
        },
    );

    socket.on(
        client_events::TOGGLE_STEALTH,
        move |_socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.toggle_stealth(enabled);
                }
            });
        },
    );

    socket.on(
        client_events::TOGGLE_AUTOARMOR,
        move |_socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.toggle_auto_armor(enabled);
                }
            });
        },
    );

    socket.on(
        client_events::UPDATE_SETTINGS,
        move |socket: SocketRef, Data(data): Data<UpdateSettingsPayload>| {
            let state = state.clone();
            let io = io.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let runtime = runtime_arc.read().await;
                    // Convert HashMap to Value
                    let settings_value =
                        serde_json::to_value(data.settings).unwrap_or(serde_json::Value::Null);
                    runtime.update_settings(settings_value).await;

                    let bot_state = runtime.get_full_state().await;
                    if let Some(ns) = io.ns(namespaces::MAIN) {
                        ns.to(rooms::ALL)
                            .emit(server_events::BULK_UPDATE, bot_state)
                            .ok();
                    }
                }
            });
        },
    );

    // Memory
    socket.on(
        client_events::SAVE_LOCATION,
        move |socket: SocketRef, Data(data): Data<SaveLocationPayload>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    let pos = data.position.unwrap_or_else(|| {
                        runtime.get_position().unwrap_or_else(|| {
                            // Default position if bot not connected
                            crate::web::socket::events::BotPosition {
                                x: 0.0,
                                y: 0.0,
                                z: 0.0,
                            }
                        })
                    });
                    let location_type = data.location_type.as_deref().unwrap_or("custom");
                    runtime.save_location(&data.name, pos, location_type);

                    socket
                        .emit(
                            server_events::LOCATION_SAVED,
                            serde_json::json!({
                                "name": data.name,
                                "position": pos
                            }),
                        )
                        .ok();
                }
            });
        },
    );

    socket.on(
        client_events::REMEMBER_FACT,
        move |socket: SocketRef, Data(data): Data<RememberFactPayload>| {
            let state = state.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let runtime = runtime_arc.read().await;
                    let success = runtime.remember_fact(&data.key, &data.fact).await;
                    socket
                        .emit(
                            server_events::COMMAND_RESULT,
                            CommandResultPayload {
                                request_id: None,
                                command: "remember".to_string(),
                                success,
                                output: if success {
                                    Some(format!("Remembered: {}", data.key))
                                } else {
                                    None
                                },
                                error: if !success {
                                    Some("Failed to remember fact".to_string())
                                } else {
                                    None
                                },
                                execution_time: None,
                            },
                        )
                        .ok();
                }
            });
        },
    );

    socket.on(
        client_events::FORGET_FACT,
        move |socket: SocketRef, Data(data): Data<serde_json::Value>| {
            let state = state.clone();
            let key = data.get("key").and_then(|v| v.as_str()).unwrap_or("");
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let runtime = runtime_arc.read().await;
                    let success = runtime.forget_fact(key).await;
                    socket
                        .emit(
                            server_events::COMMAND_RESULT,
                            CommandResultPayload {
                                request_id: None,
                                command: "forget".to_string(),
                                success,
                                output: if success {
                                    Some(format!("Forgot: {}", key))
                                } else {
                                    None
                                },
                                error: if !success {
                                    Some("Fact not found".to_string())
                                } else {
                                    None
                                },
                                execution_time: None,
                            },
                        )
                        .ok();
                }
            });
        },
    );

    socket.on(
        client_events::ADD_RULE,
        move |socket: SocketRef, Data(data): Data<serde_json::Value>| {
            let state = state.clone();
            let rule = data.get("rule").and_then(|v| v.as_str()).unwrap_or("");
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let runtime = runtime_arc.read().await;
                    let success = runtime.add_rule(rule).await;
                    socket
                        .emit(
                            server_events::COMMAND_RESULT,
                            CommandResultPayload {
                                request_id: None,
                                command: "add_rule".to_string(),
                                success,
                                output: if success {
                                    Some(format!("Added rule: {}", rule))
                                } else {
                                    None
                                },
                                error: if !success {
                                    Some("Rule already exists or failed".to_string())
                                } else {
                                    None
                                },
                                execution_time: None,
                            },
                        )
                        .ok();
                }
            });
        },
    );

    socket.on(
        client_events::REMOVE_RULE,
        move |socket: SocketRef, Data(data): Data<serde_json::Value>| {
            let state = state.clone();
            let rule = data.get("rule").and_then(|v| v.as_str()).unwrap_or("");
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.as_ref() {
                    let runtime = runtime_arc.read().await;
                    let success = runtime.remove_rule(rule).await;
                    socket
                        .emit(
                            server_events::COMMAND_RESULT,
                            CommandResultPayload {
                                request_id: None,
                                command: "remove_rule".to_string(),
                                success,
                                output: if success {
                                    Some(format!("Removed rule: {}", rule))
                                } else {
                                    None
                                },
                                error: if !success {
                                    Some("Rule not found".to_string())
                                } else {
                                    None
                                },
                                execution_time: None,
                            },
                        )
                        .ok();
                }
            });
        },
    );

    // Utility
    socket.on(
        client_events::PING,
        move |socket: SocketRef, Data(data): Data<PingPayload>| {
            let latency = chrono::Utc::now().timestamp_millis() as u64 - data.timestamp;
            socket
                .emit(
                    server_events::PONG,
                    PongPayload {
                        pong: true,
                        timestamp: chrono::Utc::now().timestamp_millis() as u64,
                        latency,
                    },
                )
                .ok();
        },
    );

    // Room management
    socket.on(
        room_events::JOIN,
        move |socket: SocketRef, Data(room): Data<String>| {
            let valid_rooms = vec![
                rooms::ADMINS.to_string(),
                rooms::TRUSTED.to_string(),
                rooms::ALL.to_string(),
                rooms::BOT_EVENTS.to_string(),
                rooms::COMMAND_RESULTS.to_string(),
                rooms::LOGS.to_string(),
            ];

            if valid_rooms.contains(&room) {
                socket.join(room).ok();
                // Could emit room users count here
            }
        },
    );

    socket.on(
        room_events::LEAVE,
        move |socket: SocketRef, Data(room): Data<String>| {
            socket.leave(room).ok();
        },
    );
}

/// Broadcast bot status to all connected dashboards
pub async fn broadcast_bot_status(state: &WebState, status: serde_json::Value) {
    if let Ok(io) = state.get_socket_io() {
        if let Some(ns) = io.ns(namespaces::MAIN) {
            ns.to(rooms::ALL)
                .emit(server_events::BOT_STATUS, status)
                .ok();
        }
    }
}

/// Broadcast bot state to all connected dashboards
pub async fn broadcast_bot_state(state: &WebState, bot_state: serde_json::Value) {
    if let Ok(io) = state.get_socket_io() {
        if let Some(ns) = io.ns(namespaces::MAIN) {
            ns.to(rooms::ALL)
                .emit(server_events::BOT_STATE, bot_state)
                .ok();
        }
    }
}

/// Broadcast log entry to all connected dashboards
pub async fn broadcast_log(state: &WebState, level: &str, tag: &str, message: &str) {
    if let Ok(io) = state.get_socket_io() {
        if let Some(ns) = io.ns(namespaces::MAIN) {
            ns.to(rooms::LOGS)
                .emit(
                    server_events::LOG_ENTRY,
                    LogEntryPayload {
                        level: level.to_string(),
                        tag: tag.to_string(),
                        message: message.to_string(),
                        timestamp: chrono::Utc::now().to_rfc3339(),
                    },
                )
                .ok();
        }
    }
}

/// Broadcast chat message to all connected dashboards
pub async fn broadcast_chat_message(
    state: &WebState,
    username: &str,
    message: &str,
    message_type: &str,
) {
    if let Ok(io) = state.get_socket_io() {
        if let Some(ns) = io.ns(namespaces::MAIN) {
            ns.to(rooms::ALL)
                .emit(
                    server_events::CHAT_MESSAGE,
                    ChatMessagePayload {
                        username: username.to_string(),
                        message: message.to_string(),
                        message_type: message_type.to_string(),
                        timestamp: chrono::Utc::now().to_rfc3339(),
                    },
                )
                .ok();
        }
    }
}

/// Broadcast command output to all connected dashboards
pub async fn broadcast_command_output(state: &WebState, message: &str, output_type: &str) {
    if let Ok(io) = state.get_socket_io() {
        if let Some(ns) = io.ns(namespaces::MAIN) {
            ns.to(rooms::ALL)
                .emit(
                    server_events::COMMAND_OUTPUT,
                    CommandOutputPayload {
                        message: message.to_string(),
                        output_type: output_type.to_string(),
                        timestamp: chrono::Utc::now().to_rfc3339(),
                    },
                )
                .ok();
        }
    }
}