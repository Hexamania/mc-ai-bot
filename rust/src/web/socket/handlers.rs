// Socket.io event handlers for web dashboard
use axum::extract::State;
use serde_json::Value;
use socketioxide::{
    SocketIo,
    adapter::LocalAdapter,
    extract::{Data, SocketRef},
    handler::FromConnectParts,
    socket::{DisconnectReason, Sid},
};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

/**
 * Socket.io event handlers for web server
 * Handles all real-time communication between bot and dashboard
 */
use crate::{
    bot::minecraft::MinecraftConnection,
    bot::runtime::MinecraftRuntime,
    config::AppConfig,
    web::{
        WebState,
        auth::{Claims, UserRole, extract_socket_token, verify_socket_token},
        socket::events::*,
    },
};

/// Socket user data
#[derive(Debug, Clone)]
pub struct SocketUser {
    pub username: String,
    pub role: UserRole,
}

/// Query string extractor for socket.io connect
struct QueryString(String);

impl<A: socketioxide::adapter::Adapter> FromConnectParts<A> for QueryString {
    type Error = std::convert::Infallible;
    fn from_connect_parts(
        _: &std::sync::Arc<socketioxide::socket::Socket<A>>,
        query: &Option<String>,
    ) -> Result<Self, Self::Error> {
        Ok(QueryString(query.clone().unwrap_or_default()))
    }
}

/// Get socket data from state
async fn get_socket_data(state: &Arc<WebState>, socket_id: &str) -> Option<crate::web::SocketData> {
    state.get_socket_data(socket_id).await
}

/// Set socket data in state
async fn set_socket_data(state: &Arc<WebState>, socket_id: String, data: crate::web::SocketData) {
    state.set_socket_data(socket_id, data).await;
}

/// Remove socket data from state
async fn remove_socket_data(state: &Arc<WebState>, socket_id: &str) {
    state.remove_socket_data(socket_id).await;
}

/// Set up main namespace handlers
pub fn setup_main_namespace(
    io: SocketIo,
    state: Arc<WebState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state_clone = state.clone();
    let io_clone = io.clone();

    io_clone.clone().ns(
        namespaces::MAIN,
        move |socket: SocketRef, Data(auth): Data<Value>, QueryString(query_string)| {
            let state = state_clone.clone();
            let socket_id_sid = socket.id;
            let socket_id_str = socket_id_sid.to_string();

            // Parse query string
            let query_value: Value = {
                let qs = query_string.replace('&', ",");
                let qs = qs.replace('=', ":");
                serde_json::from_str(&format!("{{{}}}", qs))
                    .unwrap_or(Value::Object(serde_json::Map::new()))
            };

            // Store handshake data in state
            let socket_data = crate::web::SocketData {
                handshake_auth: Some(auth.clone()),
                handshake_query: Some(query_value.clone()),
                ..Default::default()
            };
            let state_clone = state.clone();
            let socket_id_clone = socket_id_str.clone();
            tokio::spawn(async move {
                set_socket_data(&state_clone, socket_id_clone, socket_data).await;
            });

            // Authentication - extract token from socket handshake auth
            let token = extract_socket_token(Some(&auth), Some(&query_value));

            if let Some(token) = token {
                let config = state.config.clone();
                if let Ok(claims) = verify_socket_token(&config, &token) {
                    let user = SocketUser {
                        username: claims.sub,
                        role: claims.role,
                    };

                    // Store user data in socket state
                    let socket_data = crate::web::SocketData {
                        user: Some(user.role),
                        username: Some(user.username.clone()),
                        handshake_auth: None,
                        handshake_query: None,
                    };
                    let state_clone = state.clone();
                    let socket_id_clone = socket_id_str.clone();
                    tokio::spawn(async move {
                        set_socket_data(&state_clone, socket_id_clone, socket_data).await;
                    });

                    // Join default rooms
                    socket.join(rooms::ALL).ok();
                    match user.role {
                        UserRole::Admin => {
                            socket.join(rooms::ADMINS).ok();
                        }
                        UserRole::Trusted => {
                            socket.join(rooms::TRUSTED).ok();
                        }
                        _ => {}
                    }

                    // Send initial state - use SocketIo and socket ID
                    send_initial_state(
                        io_clone.clone(),
                        namespaces::MAIN.to_string(),
                        socket_id_sid,
                        state.clone(),
                    );

                    // Set up event handlers
                    setup_socket_event_handlers(&socket, state.clone(), io_clone.clone());

                    // Handle disconnection - clone state and socket_id before they're moved
                    let state_disconnect = state.clone();
                    let socket_id_disconnect = socket_id_sid;
                    socket.on_disconnect(move |_socket: SocketRef, _reason: DisconnectReason| {
                        let state = state_disconnect.clone();
                        let socket_id = socket_id_disconnect.to_string();
                        tokio::spawn(async move {
                            remove_socket_data(&state, &socket_id).await;
                        });
                        info!("[SOCKET] Dashboard disconnected");
                    });
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
        },
    );

    Ok(())
}

/// Set up admin namespace handlers
pub fn setup_admin_namespace(
    io: &SocketIo,
    state: Arc<WebState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state_clone = state.clone();
    let io_clone = io.clone();

    io.ns(
        namespaces::ADMIN,
        move |socket: SocketRef, _auth: Data<Value>, QueryString(_query_string): QueryString| {
            let state = state_clone.clone();
            let io = io_clone.clone();
            let socket_id = socket.id.to_string();

            // Check if user is admin - get user from socket data
            let state_check = state.clone();
            let socket_id_check = socket_id.clone();
            tokio::spawn(async move {
                if let Some(data) = get_socket_data(&state_check, &socket_id_check).await {
                    let is_admin = data.user == Some(UserRole::Admin);

                    if !is_admin {
                        // Note: we can't easily emit here from inside spawn,
                        // but the connection will be rejected on the main namespace
                    }
                }
            });

            info!("[SOCKET] Admin connected: {}", socket.id);

            // Admin-only events
            let state_clone = state.clone();
            socket.on(
                client_events::EXECUTE_CONSOLE_COMMAND,
                move |socket: SocketRef, Data(data): Data<serde_json::Value>| {
                    let state = state_clone.clone();
                    let command = data
                        .get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let request_id = data
                        .get("requestId")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    if !command.is_empty() {
                        // Execute console command via bot
                        tokio::spawn(async move {
                            if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                                let runtime = runtime_arc.read().await;
                                runtime.execute_command(&command).await;
                                socket
                                    .emit(
                                        server_events::COMMAND_RESULT,
                                        CommandResultPayload {
                                            request_id,
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
        },
    );

    Ok(())
}

/// Set up commands namespace handlers
pub fn setup_commands_namespace(
    io: &SocketIo,
    state: Arc<WebState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state_clone = state.clone();

    io.ns(
        namespaces::COMMANDS,
        move |socket: SocketRef, Data(auth_value): Data<Value>, QueryString(query_string)| {
            let state = state_clone.clone();
            let socket_id = socket.id.to_string();

            // Parse query string
            let query_value: Value = {
                let qs = query_string.replace('&', ",");
                let qs = qs.replace('=', ":");
                serde_json::from_str(&format!("{{{}}}", qs))
                    .unwrap_or(Value::Object(serde_json::Map::new()))
            };

            // Store handshake data in state
            let socket_data = crate::web::SocketData {
                handshake_auth: Some(auth_value.clone()),
                handshake_query: Some(query_value.clone()),
                ..Default::default()
            };
            let state_clone = state.clone();
            let socket_id_clone = socket_id.clone();
            tokio::spawn(async move {
                set_socket_data(&state_clone, socket_id_clone, socket_data).await;
            });

            // Authentication
            let token = extract_socket_token(Some(&auth_value), Some(&query_value));

            if let Some(token) = token {
                let config = state.config.clone();
                if verify_socket_token(&config, &token).is_ok() {
                    let socket_data = crate::web::SocketData {
                        user: Some(UserRole::Admin),
                        username: Some("dashboard".to_string()),
                        handshake_auth: None,
                        handshake_query: None,
                    };
                    let state_clone = state.clone();
                    let socket_id_clone = socket_id.clone();
                    tokio::spawn(async move {
                        set_socket_data(&state_clone, socket_id_clone, socket_data).await;
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
            let state_clone = state.clone();
            socket.on(
                client_events::GET_COMMANDS,
                move |socket: SocketRef, _data: Data<()>| {
                    let state = state_clone.clone();
                    tokio::spawn(async move {
                        if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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
            let state_clone = state.clone();
            socket.on(
                client_events::GET_COMMAND_HELP,
                move |socket: SocketRef, Data(data): Data<serde_json::Value>| {
                    let state = state_clone.clone();
                    let command = data
                        .get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let prefix = data
                        .get("prefix")
                        .and_then(|v| v.as_str())
                        .unwrap_or("!")
                        .to_string();

                    if !command.is_empty() {
                        tokio::spawn(async move {
                            if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                                let runtime = runtime_arc.read().await;
                                let help = runtime.get_command_help(&command, &prefix).await;
                                let has_help = !help.contains("Unknown command");
                                socket
                                    .emit(
                                        server_events::COMMAND_RESULT,
                                        CommandResultPayload {
                                            request_id: None,
                                            command: command.clone(),
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
            let state_clone = state.clone();
            socket.on(
                client_events::SEND_COMMAND,
                move |socket: SocketRef, Data(data): Data<SendCommandPayload>| {
                    let state = state_clone.clone();
                    let request_id = data.request_id.clone().unwrap_or_else(|| {
                        format!(
                            "cmd_{}_{}",
                            chrono::Utc::now().timestamp_millis(),
                            uuid::Uuid::new_v4().simple()
                        )
                    });
                    let start_time = std::time::Instant::now();

                    tokio::spawn(async move {
                        if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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
        },
    );

    Ok(())
}

/// Initialize all namespaces
pub fn initialize_all_namespaces(
    io: &SocketIo,
    state: Arc<WebState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    setup_main_namespace(io.clone(), state.clone())?;
    setup_admin_namespace(io, state.clone())?;
    setup_commands_namespace(io, state.clone())?;
    Ok(())
}

/// Send initial state to newly connected client
fn send_initial_state(io: SocketIo, namespace: String, socket_id: Sid, state: Arc<WebState>) {
    tokio::spawn(async move {
        if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
            let runtime = runtime_arc.read().await;
            let status = runtime.get_status().await;
            let bot_state = runtime.get_full_state().await;

            // Get namespace operators for each emit (Operators doesn't implement Copy)
            let ns_path = namespace.as_str();
            if let Some(ns) = io.of(ns_path) {
                ns.to(socket_id)
                    .emit(server_events::BOT_STATUS, status)
                    .ok();
            }
            if let Some(ns) = io.of(ns_path) {
                ns.to(socket_id)
                    .emit(server_events::BOT_STATE, bot_state.clone())
                    .ok();
            }
            if let Some(ns) = io.of(ns_path) {
                ns.to(socket_id)
                    .emit(server_events::BULK_UPDATE, bot_state)
                    .ok();
            }

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
            if let Some(ns) = io.of(ns_path) {
                ns.to(socket_id)
                    .emit(
                        server_events::COMMAND_LIST,
                        serde_json::json!({ "commands": commands_list }),
                    )
                    .ok();
            }
        }
    });
}

/// Set up individual socket event handlers for bot control
fn setup_socket_event_handlers(socket: &SocketRef, state: Arc<WebState>, io: SocketIo) {
    // Get current state
    let state_clone = state.clone();
    socket.on(
        client_events::GET_STATE,
        move |socket: SocketRef, _data: Data<()>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let runtime = runtime_arc.read().await;
                    let bot_state = runtime.get_full_state().await;
                    socket.emit(server_events::BOT_STATE, bot_state).ok();
                }
            });
        },
    );

    let state_clone = state.clone();
    socket.on(
        client_events::GET_STATUS,
        move |socket: SocketRef, _data: Data<()>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let runtime = runtime_arc.read().await;
                    let status = runtime.get_status().await;
                    socket.emit(server_events::BOT_STATUS, status).ok();
                }
            });
        },
    );

    // Movement commands
    let state_clone = state.clone();
    socket.on(
        client_events::MOVE_TO,
        move |_socket: SocketRef, Data(data): Data<MoveToPayload>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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

    let state_clone = state.clone();
    socket.on(
        client_events::FOLLOW_PLAYER,
        move |socket: SocketRef, Data(data): Data<FollowPlayerPayload>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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

    let state_clone = state.clone();
    let io_clone = io.clone();
    socket.on(
        client_events::STOP_MOVEMENT,
        move |socket: SocketRef, _data: Data<()>| {
            let state = state_clone.clone();
            let io = io_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.stop_all_movement().await;

                    // Broadcast feature toggled
                    if let Some(ns) = io.of(namespaces::MAIN) {
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
                    if let Some(ns) = io.of(namespaces::MAIN) {
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

    let state_clone = state.clone();
    socket.on(
        client_events::SET_HOME,
        move |socket: SocketRef, _data: Data<()>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.set_home().await;
                    let pos = runtime.get_position().unwrap_or_else(|| {
                        crate::web::socket::events::BotPosition {
                            x: 0.0,
                            y: 0.0,
                            z: 0.0,
                        }
                    });
                    if let Some(conn) = state.connection.read().await.as_ref() {
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

    let state_clone = state.clone();
    socket.on(
        client_events::GO_HOME,
        move |_socket: SocketRef, _data: Data<()>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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
    let state_clone = state.clone();
    socket.on(
        client_events::DROP_ITEM,
        move |_socket: SocketRef, Data(data): Data<DropItemPayload>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.drop_item(data.slot, data.count).await;
                }
            });
        },
    );

    let state_clone = state.clone();
    socket.on(
        client_events::DROP_ALL,
        move |_socket: SocketRef, _data: Data<()>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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

    let state_clone = state.clone();
    socket.on(
        client_events::MOVE_ITEM,
        move |_socket: SocketRef, Data(data): Data<MoveItemPayload>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.move_item(data.from, data.to).await;
                }
            });
        },
    );

    let state_clone = state.clone();
    socket.on(
        client_events::SET_HOTBAR,
        move |_socket: SocketRef, Data(slot): Data<i32>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.set_hotbar_slot(slot).await;
                }
            });
        },
    );

    // Block interaction
    let state_clone = state.clone();
    socket.on(
        client_events::MINE_BLOCK,
        move |socket: SocketRef, Data(data): Data<MineBlockPayload>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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

    let state_clone = state.clone();
    socket.on(
        client_events::PLACE_BLOCK,
        move |socket: SocketRef, Data(data): Data<PlaceBlockPayload>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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
    let state_clone = state.clone();
    let io_clone = io.clone();
    socket.on(
        client_events::TOGGLE_KILLAURA,
        move |socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state_clone.clone();
            let io = io_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.toggle_kill_aura(enabled);

                    // Broadcast feature toggled
                    if let Some(ns) = io.of(namespaces::MAIN) {
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
                    if let Some(ns) = io.of(namespaces::MAIN) {
                        ns.to(rooms::ALL)
                            .emit(server_events::BULK_UPDATE, bot_state)
                            .ok();
                    }
                }
            });
        },
    );

    let state_clone = state.clone();
    let io_clone = io.clone();
    socket.on(
        client_events::TOGGLE_AUTODEFENSE,
        move |socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state_clone.clone();
            let io = io_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.toggle_auto_defense(enabled);

                    if let Some(ns) = io.of(namespaces::MAIN) {
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
                    if let Some(ns) = io.of(namespaces::MAIN) {
                        ns.to(rooms::ALL)
                            .emit(server_events::BULK_UPDATE, bot_state)
                            .ok();
                    }
                }
            });
        },
    );

    // Automation toggles
    let state_clone = state.clone();
    socket.on(
        client_events::TOGGLE_ROAMING,
        move |socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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

    let state_clone = state.clone();
    socket.on(
        client_events::TOGGLE_FARMING,
        move |socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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

    let state_clone = state.clone();
    socket.on(
        client_events::TOGGLE_MINING,
        move |socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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

    let state_clone = state.clone();
    socket.on(
        client_events::TOGGLE_LUMBERJACK,
        move |socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    if enabled {
                        let _ = runtime.start_lumberjack(16); // Default radius
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

    let state_clone = state.clone();
    socket.on(
        client_events::START_PROGRESSION,
        move |_socket: SocketRef, _data: Data<()>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.start_progression();
                    if let Some(conn) = state.connection.read().await.as_ref() {
                        conn.say("🚀 Speedrun Protocol initiated!").await;
                    }
                }
            });
        },
    );

    let state_clone = state.clone();
    let io_clone = io.clone();
    socket.on(
        client_events::STOP_ALL_TASKS,
        move |socket: SocketRef, _data: Data<()>| {
            let state = state_clone.clone();
            let io = io_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.stop_all_tasks();

                    // Broadcast feature toggled
                    if let Some(ns) = io.of(namespaces::MAIN) {
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
    let state_clone = state.clone();
    socket.on(
        client_events::TOGGLE_SAFEMODE,
        move |_socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.toggle_safe_mode(enabled);
                }
            });
        },
    );

    let state_clone = state.clone();
    socket.on(
        client_events::TOGGLE_STEALTH,
        move |_socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.toggle_stealth(enabled);
                }
            });
        },
    );

    let state_clone = state.clone();
    socket.on(
        client_events::TOGGLE_AUTOARMOR,
        move |_socket: SocketRef, Data(enabled): Data<bool>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let mut runtime = runtime_arc.write().await;
                    runtime.toggle_auto_armor(enabled);
                }
            });
        },
    );

    let state_clone = state.clone();
    let io_clone = io.clone();
    socket.on(
        client_events::UPDATE_SETTINGS,
        move |socket: SocketRef, Data(data): Data<UpdateSettingsPayload>| {
            let state = state_clone.clone();
            let io = io_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let runtime = runtime_arc.read().await;
                    // Convert HashMap to Value
                    let settings_value =
                        serde_json::to_value(data.settings).unwrap_or(serde_json::Value::Null);
                    runtime.update_settings(settings_value).await;

                    let bot_state = runtime.get_full_state().await;
                    if let Some(ns) = io.of(namespaces::MAIN) {
                        ns.to(rooms::ALL)
                            .emit(server_events::BULK_UPDATE, bot_state)
                            .ok();
                    }
                }
            });
        },
    );

    // Memory
    let state_clone = state.clone();
    socket.on(
        client_events::SAVE_LOCATION,
        move |socket: SocketRef, Data(data): Data<SaveLocationPayload>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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
                    let pos_clone = pos.clone();
                    runtime.save_location(&data.name, pos, location_type);

                    socket
                        .emit(
                            server_events::LOCATION_SAVED,
                            serde_json::json!({
                                "name": data.name,
                                "position": pos_clone
                            }),
                        )
                        .ok();
                }
            });
        },
    );

    let state_clone = state.clone();
    socket.on(
        client_events::REMEMBER_FACT,
        move |socket: SocketRef, Data(data): Data<RememberFactPayload>| {
            let state = state_clone.clone();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
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

    let state_clone = state.clone();
    socket.on(
        client_events::FORGET_FACT,
        move |socket: SocketRef, Data(data): Data<serde_json::Value>| {
            let state = state_clone.clone();
            let key = data
                .get("key")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let runtime = runtime_arc.read().await;
                    let success = runtime.forget_fact(&key).await;
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

    let state_clone = state.clone();
    socket.on(
        client_events::ADD_RULE,
        move |socket: SocketRef, Data(data): Data<serde_json::Value>| {
            let state = state_clone.clone();
            let rule = data
                .get("rule")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let runtime = runtime_arc.read().await;
                    let success = runtime.add_rule(&rule).await;
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

    let state_clone = state.clone();
    socket.on(
        client_events::REMOVE_RULE,
        move |socket: SocketRef, Data(data): Data<serde_json::Value>| {
            let state = state_clone.clone();
            let rule = data
                .get("rule")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default();
            tokio::spawn(async move {
                if let Some(runtime_arc) = state.runtime.read().await.as_ref() {
                    let runtime = runtime_arc.read().await;
                    let success = runtime.remove_rule(&rule).await;
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
    let state_clone = state.clone();
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
    let state_clone = state.clone();
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

    let state_clone = state.clone();
    socket.on(
        room_events::LEAVE,
        move |socket: SocketRef, Data(room): Data<String>| {
            socket.leave(room).ok();
        },
    );
}

/// Broadcast bot status to all connected dashboards
pub async fn broadcast_bot_status(state: &WebState, status: serde_json::Value) {
    if let Ok(io) = state.get_socket_io().await {
        if let Some(ns) = io.of(namespaces::MAIN) {
            ns.to(rooms::ALL)
                .emit(server_events::BOT_STATUS, status)
                .ok();
        }
    }
}

/// Broadcast bot state to all connected dashboards
pub async fn broadcast_bot_state(state: &WebState, bot_state: serde_json::Value) {
    if let Ok(io) = state.get_socket_io().await {
        if let Some(ns) = io.of(namespaces::MAIN) {
            ns.to(rooms::ALL)
                .emit(server_events::BOT_STATE, bot_state)
                .ok();
        }
    }
}

/// Broadcast log entry to all connected dashboards
pub async fn broadcast_log(state: &WebState, level: &str, tag: &str, message: &str) {
    if let Ok(io) = state.get_socket_io().await {
        if let Some(ns) = io.of(namespaces::MAIN) {
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
    if let Ok(io) = state.get_socket_io().await {
        if let Some(ns) = io.of(namespaces::MAIN) {
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
    if let Ok(io) = state.get_socket_io().await {
        if let Some(ns) = io.of(namespaces::MAIN) {
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
