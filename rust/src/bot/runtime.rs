use std::{sync::mpsc, time::Duration};

use thiserror::Error;
use tokio::time::sleep;

use crate::{
    arguments::{ArgumentConstraint, ArgumentDefinition, ArgumentType, ArgumentValue},
    bot::minecraft::MinecraftEvent::Chat,
    bot::{
        minecraft::{
            MAX_SUPPORTED_Y_COORDINATE, MAX_WORLD_COORDINATE, MinecraftConnection, MinecraftEvent,
            MinecraftTransportError, parse_mineable_block,
        },
        state_machine::{BotState, StateMachine},
    },
    command_registry::{
        CommandContext, CommandDefinition, CommandRegistry, CommandRegistryError, CommandResult,
    },
    commands::{
        ChatParser, ChatParserConfig, MessageType, PermissionConfig, PermissionLevel,
        PermissionManager,
    },
    config::{AppConfig, BotConfig},
    features::{FeatureRegistry, register_builtin_features},
    memory::{MemoryError, default_memory, forget_fact, load_memory, remember_fact, save_memory},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MinecraftRuntimeEvent {
    Minecraft(MinecraftEvent),
    CommandExecuted {
        username: String,
        command: String,
        result: CommandResult,
    },
    ReconnectScheduled {
        attempt: u32,
        retry_in_ms: u64,
        reason: Option<String>,
    },
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum MinecraftRuntimeError {
    #[error(transparent)]
    Transport(#[from] MinecraftTransportError),
    #[error(transparent)]
    CommandRegistry(#[from] CommandRegistryError),
    #[error("Invalid bot state transition: {0}")]
    StateTransition(#[from] crate::bot::state_machine::InvalidTransition),
}

pub struct MinecraftRuntime {
    config: BotConfig,
    connection: Option<MinecraftConnection>,
    state_machine: StateMachine,
    reconnect_attempt: u32,
    command_registry: CommandRegistry,
    command_actions: mpsc::Receiver<RuntimeCommandAction>,
    chat_parser: ChatParser,
    permissions: PermissionManager,
    fatal_error: Option<MinecraftRuntimeError>,
    feature_registry: FeatureRegistry,
}

impl MinecraftRuntime {
    pub fn new(config: BotConfig) -> Self {
        Self::with_chat_config(config, ChatParserConfig::default(), None)
    }

    pub fn from_app_config(config: AppConfig) -> Self {
        let chat_config = ChatParserConfig {
            public_prefix: config.prefix.public,
            admin_prefix: config.prefix.admin,
            ignore_bot_messages: true,
        };
        Self::with_chat_config(config.bot, chat_config, Some(config.admin.password))
    }

    fn with_chat_config(
        config: BotConfig,
        chat_config: ChatParserConfig,
        admin_password: Option<String>,
    ) -> Self {
        let command_registry = CommandRegistry::new(
            chat_config.public_prefix.clone(),
            chat_config.admin_prefix.clone(),
        );
        let (action_sender, command_actions) = mpsc::channel();
        let fatal_error = command_registry
            .register_help_command(chat_config.public_prefix.clone())
            .and_then(|_| command_registry.register_ping_command())
            .and_then(|_| register_coordinate_commands(&command_registry, action_sender.clone()))
            .and_then(|_| register_follow_commands(&command_registry, action_sender.clone()))
            .and_then(|_| register_roam_commands(&command_registry, action_sender.clone()))
            .and_then(|_| register_navigation_commands(&command_registry, action_sender.clone()))
            .and_then(|_| register_inventory_commands(&command_registry, action_sender.clone()))
            .and_then(|_| register_mining_commands(&command_registry, action_sender.clone()))
            .and_then(|_| register_base_commands(&command_registry, action_sender.clone()))
            .and_then(|_| {
                register_mining_feature_commands(&command_registry, action_sender.clone())
            })
            .and_then(|_| register_building_commands(&command_registry, action_sender.clone()))
            .and_then(|_| register_combat_commands(&command_registry, action_sender.clone()))
            .and_then(|_| register_utility_commands(&command_registry, action_sender.clone()))
            .and_then(|_| register_memory_commands(&command_registry, action_sender.clone()))
            .and_then(|_| register_chat_commands(&command_registry, action_sender.clone()))
            .and_then(|_| register_admin_commands(&command_registry, action_sender.clone()))
            .and_then(|_| register_general_commands(&command_registry, action_sender))
            .err()
            .map(MinecraftRuntimeError::CommandRegistry);

        let mut permissions = PermissionManager::default();
        if let Some(password) = admin_password {
            permissions.set_admin_password(password);
        }

        // Initialize feature registry with built-in features
        let mut feature_registry = FeatureRegistry::new();
        if let Err(e) = register_builtin_features(&mut feature_registry) {
            log::error!("[FEATURES] Failed to register built-in features: {}", e);
        }

        Self {
            config,
            connection: None,
            state_machine: StateMachine::default(),
            reconnect_attempt: 0,
            command_registry,
            command_actions,
            chat_parser: ChatParser::new(chat_config),
            permissions,
            fatal_error,
            feature_registry,
        }
    }

    pub fn state(&self) -> BotState {
        self.state_machine.state()
    }

    pub fn username(&self) -> Option<&str> {
        self.connection.as_ref().map(MinecraftConnection::username)
    }

    pub fn command_registry(&self) -> &CommandRegistry {
        &self.command_registry
    }

    pub fn configure_chat(
        &mut self,
        config: ChatParserConfig,
    ) -> Result<(), MinecraftRuntimeError> {
        let prefix_changed = self.command_registry.get_prefix()? != config.public_prefix;
        self.command_registry
            .set_prefix(config.public_prefix.clone())?;
        self.command_registry
            .set_admin_prefix(config.admin_prefix.clone())?;
        if prefix_changed {
            self.command_registry
                .register_help_command(config.public_prefix.clone())?;
        }
        self.chat_parser.update_config(config);
        Ok(())
    }

    pub fn permission_manager_mut(&mut self) -> &mut PermissionManager {
        &mut self.permissions
    }

    pub fn send_chat(&self, message: &str) -> Result<(), MinecraftRuntimeError> {
        self.connection
            .as_ref()
            .ok_or(MinecraftTransportError::NotConnected)?
            .send_chat(message)?;
        Ok(())
    }

    // Web API support methods - delegate to connection

    /// Get bot vitals (health, food, saturation, position)
    pub async fn get_vitals(&self) -> Result<serde_json::Value, MinecraftRuntimeError> {
        self.connection
            .as_ref()
            .ok_or(MinecraftTransportError::NotConnected)?
            .get_vitals()
            .await
            .map_err(MinecraftRuntimeError::Transport)
    }

    /// Get bot position
    pub fn get_position(&mut self) -> Option<crate::web::socket::events::BotPosition> {
        self.connection
            .as_mut()
            .and_then(|c| c.position())
            .map(|pos| crate::web::socket::events::BotPosition {
                x: pos.x,
                y: pos.y,
                z: pos.z,
            })
    }

    /// Get bot status (simple status for dashboard)
    pub async fn get_status(&self) -> crate::web::socket::events::BotStatusPayload {
        let uptime = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        crate::web::socket::events::BotStatusPayload {
            status: format!("{:?}", self.state()),
            username: self.username().map(|s| s.to_owned()),
            uptime,
            ping: None, // TODO: Get actual ping
        }
    }

    /// Get full bot state for dashboard
    pub async fn get_full_state(&self) -> crate::web::socket::events::BotStatePayload {
        // Get vitals for health, food, saturation, position
        let vitals = self.get_vitals().await.unwrap_or(serde_json::Value::Null);
        let position = vitals.get("position").and_then(|p| {
            Some(crate::web::socket::events::BotPosition {
                x: p.get("x")?.as_f64()?,
                y: p.get("y")?.as_f64()?,
                z: p.get("z")?.as_f64()?,
            })
        });
        let health = vitals.get("health").and_then(|h| h.as_f64()).unwrap_or(0.0) as f32;
        let food = vitals.get("food").and_then(|f| f.as_i64()).unwrap_or(0) as i32;
        let saturation = vitals.get("saturation").and_then(|s| s.as_f64()).unwrap_or(0.0) as f32;

        // Get inventory
        let inventory = self.get_inventory().await.unwrap_or(serde_json::Value::Null);
        let inventory_items: Vec<crate::web::socket::events::InventoryItemPayload> = inventory
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        Some(crate::web::socket::events::InventoryItemPayload {
                            slot: item.get("slot")?.as_i64()? as i32,
                            name: item.get("name")?.as_str()?.to_owned(),
                            display_name: item.get("displayName")?.as_str()?.to_owned(),
                            count: item.get("count")?.as_i64()? as i32,
                            max_stack_size: item.get("maxStackSize")?.as_i64()? as i32,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        // Get equipment
        let equipment = self.get_equipment().await.unwrap_or(serde_json::Value::Null);
        let equipment_payload = crate::web::socket::events::EquipmentPayload {
            head: equipment.get("head").and_then(|v| v.as_str()).unwrap_or("").to_owned(),
            chest: equipment.get("chest").and_then(|v| v.as_str()).unwrap_or("").to_owned(),
            legs: equipment.get("legs").and_then(|v| v.as_str()).unwrap_or("").to_owned(),
            feet: equipment.get("feet").and_then(|v| v.as_str()).unwrap_or("").to_owned(),
            hand: equipment.get("hand").and_then(|v| v.as_str()).unwrap_or("").to_owned(),
            offhand: equipment.get("offhand").and_then(|v| v.as_str()).unwrap_or("").to_owned(),
        };

        // Get players
        let players = self.get_players().await.unwrap_or_default();
        let players_payload: Vec<crate::web::socket::events::PlayerInfoPayload> = players
            .into_iter()
            .filter_map(|p| {
                Some(crate::web::socket::events::PlayerInfoPayload {
                    username: p.get("username")?.as_str()?.to_owned(),
                    entity_id: p.get("entityId").and_then(|v| v.as_i64()).map(|v| v as i32),
                    position: p.get("position").and_then(|pos| {
                        Some(crate::web::socket::events::BotPosition {
                            x: pos.get("x")?.as_f64()?,
                            y: pos.get("y")?.as_f64()?,
                            z: pos.get("z")?.as_f64()?,
                        })
                    }),
                    health: p.get("health").and_then(|h| h.as_f64()).map(|h| h as f32),
                    gamemode: p.get("gamemode").and_then(|g| g.as_str()).map(|s| s.to_owned()),
                    ping: p.get("ping").and_then(|p| p.as_i64()).map(|p| p as i32),
                })
            })
            .collect();

        // Get features state
        let features = crate::web::socket::events::FeatureStatePayload {
            movement: self.feature_registry.is_initialized("movement"),
            combat: self.feature_registry.is_initialized("combat"),
            automation: self.feature_registry.is_initialized("automation"),
            memory: self.feature_registry.is_initialized("memory"),
            web: self.feature_registry.is_initialized("web"),
        };

        // Get settings from config
        let settings = std::collections::HashMap::new(); // TODO: Get from config

        // Get favorites from connection if available
        let favorites = std::collections::HashMap::new(); // TODO: Get from connection

        // Get logs
        let logs = vec![]; // TODO: Get from logger

        // Get admins and users from permission manager
        let admins: Vec<String> = self.permissions.get_admins().into_iter().cloned().collect();
        let users: Vec<String> = self.permissions.get_users().into_iter().cloned().collect();

        crate::web::socket::events::BotStatePayload {
            position,
            health,
            food,
            saturation,
            inventory: inventory_items,
            equipment: equipment_payload,
            players: players_payload,
            features,
            settings,
            favorites,
            logs,
            admins,
            users,
        }
    }

    /// Get command definitions for dashboard
    pub async fn get_command_definitions(&self) -> Vec<crate::command_registry::CommandDefinition> {
        self.command_registry.get_all().unwrap_or_default()
    }

    /// Get command help
    pub async fn get_command_help(&self, command: &str, prefix: &str) -> String {
        if let Some(cmd) = self.command_registry.get(command) {
            format!(
                "{} {} - {}\nUsage: {}\nAliases: {}",
                prefix,
                cmd.name,
                cmd.description,
                cmd.usage,
                cmd.aliases.join(", ")
            )
        } else {
            format!("Unknown command: {}", command)
        }
    }

    /// Get inventory items
    pub async fn get_inventory(&self) -> Result<serde_json::Value, MinecraftRuntimeError> {
        self.connection
            .as_ref()
            .ok_or(MinecraftTransportError::NotConnected)?
            .get_inventory()
            .await
            .map_err(MinecraftRuntimeError::Transport)
    }

    /// Get equipment (armor and held items)
    pub async fn get_equipment(&self) -> Result<serde_json::Value, MinecraftRuntimeError> {
        self.connection
            .as_ref()
            .ok_or(MinecraftTransportError::NotConnected)?
            .get_equipment()
            .await
            .map_err(MinecraftRuntimeError::Transport)
    }

    /// Get nearby players
    pub async fn get_players(&self) -> Result<Vec<serde_json::Value>, MinecraftRuntimeError> {
        self.connection
            .as_ref()
            .ok_or(MinecraftTransportError::NotConnected)?
            .get_players()
            .await
            .map_err(MinecraftRuntimeError::Transport)
    }

    /// Get map data
    pub async fn get_map(&self, radius: i32) -> Result<serde_json::Value, MinecraftRuntimeError> {
        self.connection
            .as_ref()
            .ok_or(MinecraftTransportError::NotConnected)?
            .get_map(radius)
            .await
            .map_err(MinecraftRuntimeError::Transport)
    }

    /// Execute a server command
    pub async fn execute_command(&self, command: &str) -> Result<(), MinecraftRuntimeError> {
        self.connection
            .as_ref()
            .ok_or(MinecraftTransportError::NotConnected)?
            .execute_command(command)
            .await
            .map_err(MinecraftRuntimeError::Transport)
    }

    /// Execute a command with context (for permissions, etc.)
    pub async fn execute_command_with_context(
        &self,
        command: &str,
        context: crate::bot::runtime::CommandContext,
    ) -> Result<(), MinecraftRuntimeError> {
        // For now, just execute the command string
        // In the future, this could check permissions from context
        self.execute_command(command).await
    }

    /// Toggle kill aura
    pub fn toggle_kill_aura(&mut self, enabled: bool) {
        if let Some(connection) = self.connection.as_mut() {
            connection.toggle_kill_aura(enabled);
        }
    }

    /// Toggle auto defense
    pub fn toggle_auto_defense(&mut self, enabled: bool) {
        if let Some(connection) = self.connection.as_mut() {
            connection.toggle_auto_defense(enabled);
        }
    }

    /// Toggle safe mode
    pub fn toggle_safe_mode(&mut self, enabled: bool) {
        if let Some(connection) = self.connection.as_mut() {
            connection.toggle_safe_mode(enabled);
        }
    }

    /// Toggle stealth
    pub fn toggle_stealth(&mut self, enabled: bool) {
        if let Some(connection) = self.connection.as_mut() {
            connection.toggle_stealth(enabled);
        }
    }

    /// Toggle auto armor
    pub fn toggle_auto_armor(&mut self, enabled: bool) {
        if let Some(connection) = self.connection.as_mut() {
            connection.toggle_auto_armor(enabled);
        }
    }

    /// Start roaming
    pub fn start_roaming(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.start_roaming();
        }
    }

    /// Stop roaming
    pub fn stop_roaming(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.stop_roaming();
        }
    }

    /// Start farming
    pub fn start_farming(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.start_farming();
        }
    }

    /// Stop farming
    pub fn stop_farming(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.stop_farming();
        }
    }

    /// Start mining
    pub fn start_mining(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.start_mining();
        }
    }

    /// Stop mining
    pub fn stop_mining(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.stop_mining();
        }
    }

    /// Start lumberjack
    pub fn start_lumberjack(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.start_lumberjack();
        }
    }

    /// Stop lumberjack
    pub fn stop_lumberjack(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.stop_lumberjack();
        }
    }

    /// Start progression
    pub fn start_progression(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.start_progression();
        }
    }

    /// Stop all tasks
    pub fn stop_all_tasks(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.stop_all_tasks();
        }
    }

    /// Save location
    pub fn save_location(
        &mut self,
        name: &str,
        pos: crate::web::socket::events::BotPosition,
        location_type: &str,
    ) {
        if let Some(connection) = self.connection.as_mut() {
            connection.save_location(name, pos, location_type);
        }
    }

    /// Add favorite location
    pub fn add_favorite(&mut self, name: &str, pos: crate::web::socket::events::BotPosition) {
        if let Some(connection) = self.connection.as_mut() {
            connection.add_favorite(name, pos);
        }
    }

    /// Remember fact
    pub async fn remember_fact(&self, key: &str, fact: &str) -> bool {
        self.connection
            .as_ref()
            .map(|c| c.remember_fact(key, fact).await)
            .unwrap_or(false)
    }

    /// Forget fact
    pub async fn forget_fact(&self, key: &str) -> bool {
        self.connection
            .as_ref()
            .map(|c| c.forget_fact(key).await)
            .unwrap_or(false)
    }

    /// Add rule
    pub async fn add_rule(&self, rule: &str) -> bool {
        self.connection
            .as_ref()
            .map(|c| c.add_rule(rule).await)
            .unwrap_or(false)
    }

    /// Remove rule
    pub async fn remove_rule(&self, rule: &str) -> bool {
        self.connection
            .as_ref()
            .map(|c| c.remove_rule(rule).await)
            .unwrap_or(false)
    }

    /// Update settings
    pub async fn update_settings(&self, settings: serde_json::Value) {
        if let Some(connection) = self.connection.as_ref() {
            connection.update_settings(settings).await;
        }
    }

    /// Drop item
    pub async fn drop_item(&mut self, slot: i32, count: Option<i32>) {
        if let Some(connection) = self.connection.as_mut() {
            connection.drop_item(slot, count).await;
        }
    }

    /// Drop all items
    pub async fn drop_all_items(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.drop_all_items().await;
        }
    }

    /// Move item
    pub async fn move_item(&mut self, from: i32, to: i32) {
        if let Some(connection) = self.connection.as_mut() {
            connection.move_item(from, to).await;
        }
    }

    /// Set hotbar slot
    pub async fn set_hotbar_slot(&mut self, slot: i32) {
        if let Some(connection) = self.connection.as_mut() {
            connection.set_hotbar_slot(slot).await;
        }
    }

    /// Mine block
    pub async fn mine_block(&mut self, x: i32, y: i32, z: i32) {
        if let Some(connection) = self.connection.as_mut() {
            connection.mine_block(x, y, z).await;
        }
    }

    /// Place block
    pub async fn place_block(&mut self, x: i32, y: i32, z: i32, block_type: Option<String>) {
        if let Some(connection) = self.connection.as_mut() {
            connection.place_block(x, y, z, block_type).await;
        }
    }

    /// Move to position
    pub async fn move_to(&mut self, x: f64, y: f64, z: f64) {
        if let Some(connection) = self.connection.as_mut() {
            connection.move_to(x, y, z).await;
        }
    }

    /// Follow player
    pub async fn follow_player(&mut self, username: &str) -> bool {
        self.connection
            .as_mut()
            .map(|c| c.follow_player(username).await)
            .unwrap_or(false)
    }

    /// Stop all movement
    pub async fn stop_all_movement(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.stop_all_movement().await;
        }
    }

    /// Go home
    pub async fn go_home(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.go_home().await;
        }
    }

    /// Set home
    pub async fn set_home(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.set_home().await;
        }
    }

    /// Restart bot
    pub async fn restart(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.restart().await;
        }
    }

    /// Shutdown bot
    pub async fn shutdown(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.shutdown().await;
        }
    }

    pub async fn next_event(
        &mut self,
    ) -> Result<Option<MinecraftRuntimeEvent>, MinecraftRuntimeError> {
        if self.state() == BotState::Shutdown {
            return Ok(None);
        }
        if let Some(error) = &self.fatal_error {
            return Err(error.clone());
        }

        if self.connection.is_none() {
            if self.state() == BotState::Reconnecting {
                let retry_delay = reconnect_delay(self.reconnect_attempt.saturating_sub(1));
                sleep(retry_delay).await;
            }
            self.state_machine.transition(BotState::Connecting)?;

            match MinecraftConnection::connect(&self.config).await {
                Ok(mut connection) => {
                    self.chat_parser
                        .set_bot_username(Some(connection.username().to_owned()));
                    self.state_machine.transition(BotState::Connected)?;

                    // Initialize features
                    if let Err(e) = self
                        .feature_registry
                        .initialize_all(&mut connection, self)
                        .await
                    {
                        log::error!("[FEATURES] Failed to initialize features: {}", e);
                    }

                    self.connection = Some(connection);
                }
                Err(error @ MinecraftTransportError::Connection(_)) => {
                    return self.schedule_reconnect(Some(error.to_string())).map(Some);
                }
                Err(error) => {
                    self.state_machine.transition(BotState::Error)?;
                    let error = MinecraftRuntimeError::Transport(error);
                    self.fatal_error = Some(error.clone());
                    return Err(error);
                }
            }
        }

        let event_result = match self.connection.as_mut() {
            Some(connection) => connection.next_event().await,
            None => Err(MinecraftTransportError::NotConnected),
        };
        let event = match event_result {
            Ok(event) => event,
            Err(error @ MinecraftTransportError::Connection(_)) => {
                return self.schedule_reconnect(Some(error.to_string())).map(Some);
            }
            Err(error) => {
                self.connection = None;
                self.state_machine.transition(BotState::Error)?;
                let error = MinecraftRuntimeError::Transport(error);
                self.fatal_error = Some(error.clone());
                return Err(error);
            }
        };

        match event {
            Some(MinecraftEvent::Login) => {
                self.reconnect_attempt = 0;
                Ok(Some(MinecraftRuntimeEvent::Minecraft(
                    MinecraftEvent::Login,
                )))
            }
            Some(MinecraftEvent::Disconnected { reason }) => {
                self.schedule_reconnect(reason).map(Some)
            }
            None => self.schedule_reconnect(None).map(Some),
            Some(Chat {
                username,
                message,
                is_whisper,
            }) => {
                if let Some(dispatch) = self
                    .dispatch_chat_command(username.as_deref(), &message, is_whisper)
                    .await?
                {
                    for reply in dispatch.replies {
                        let message = match reply.destination {
                            ReplyDestination::Public => reply.message,
                            ReplyDestination::Private => {
                                format!("/msg {} {}", dispatch.username, reply.message)
                            }
                        };
                        self.send_chat(&message)?;
                    }
                    Ok(Some(dispatch.event))
                } else {
                    Ok(Some(MinecraftRuntimeEvent::Minecraft(Chat {
                        username,
                        message,
                        is_whisper,
                    })))
                }
            }
            Some(event) => Ok(Some(MinecraftRuntimeEvent::Minecraft(event))),
        }
    }

    async fn dispatch_chat_command(
        &mut self,
        username: Option<&str>,
        message: &str,
        is_whisper: bool,
    ) -> Result<Option<CommandDispatch>, MinecraftRuntimeError> {
        let Some(username) = username else {
            return Ok(None);
        };
        let raw_message = if is_whisper {
            format!("{username} whispers to you: {message}")
        } else {
            format!("<{username}> {message}")
        };
        let Some(parsed) = self.chat_parser.parse(&raw_message) else {
            return Ok(None);
        };
        let Some(command_name) = parsed.command_name else {
            return Ok(None);
        };

        let permission_level = self.permissions.permission_level(&parsed.message.username);
        let is_private_message = matches!(
            parsed.message.message_type,
            MessageType::PrivateMessage | MessageType::Whisper
        );
        if parsed.is_admin_command && is_private_message && command_name == "loginadmin" {
            let success = self
                .permissions
                .try_admin_login(&parsed.message.username, &parsed.args.join(" "));
            let replies = if success {
                vec![CommandReply {
                    destination: ReplyDestination::Private,
                    message: "✅ Admin login successful".to_owned(),
                }]
            } else {
                Vec::new()
            };
            return Ok(Some(CommandDispatch {
                event: MinecraftRuntimeEvent::CommandExecuted {
                    username: parsed.message.username.clone(),
                    command: command_name,
                    result: CommandResult {
                        success,
                        found: true,
                        error: None,
                        execution_time_ms: Some(0),
                    },
                },
                username: parsed.message.username,
                replies,
            }));
        }
        let (reply_sender, reply_receiver) = mpsc::channel();
        let public_sender = reply_sender.clone();
        let mut context = CommandContext::new(
            parsed.message.username.clone(),
            parsed.args,
            permission_level,
            is_private_message,
            move |message| {
                public_sender
                    .send(CommandReply {
                        destination: ReplyDestination::Public,
                        message: message.to_owned(),
                    })
                    .expect("command reply receiver remains alive during execution");
            },
            move |message| {
                reply_sender
                    .send(CommandReply {
                        destination: ReplyDestination::Private,
                        message: message.to_owned(),
                    })
                    .expect("command reply receiver remains alive during execution");
            },
        );
        context.full_command = parsed.message.content.clone();

        let mut result = self
            .command_registry
            .execute(&command_name, &mut context)
            .await?;
        let actions = self.command_actions.try_iter().collect::<Vec<_>>();
        if result.success {
            self.apply_command_actions(actions, &context, &mut result)?;
        }
        let replies = reply_receiver.try_iter().collect();
        Ok(Some(CommandDispatch {
            event: MinecraftRuntimeEvent::CommandExecuted {
                username: parsed.message.username.clone(),
                command: command_name,
                result,
            },
            username: parsed.message.username,
            replies,
        }))
    }

    fn apply_command_actions(
        &mut self,
        actions: Vec<RuntimeCommandAction>,
        context: &CommandContext,
        result: &mut CommandResult,
    ) -> Result<(), MinecraftRuntimeError> {
        for action in actions {
            let connection = self
                .connection
                .as_mut()
                .ok_or(MinecraftTransportError::NotConnected)?;
            match action {
                RuntimeCommandAction::Follow { target, range } => {
                    if connection.start_following(&target, range)? {
                        context.reply(&format!("👣 Following {target}."));
                    } else {
                        let error = format!(
                            "Player \"{target}\" is not available nearby; follow was not started."
                        );
                        context.error(&error);
                        result.success = false;
                        result.error = Some(error);
                    }
                }
                RuntimeCommandAction::StopFollowing => {
                    if let Some(target) = connection.stop_following() {
                        context.reply(&format!("Stopped following {target}."));
                    } else {
                        context.reply("Not following a player.");
                    }
                }
                RuntimeCommandAction::StartRoaming {
                    radius,
                    update_interval,
                } => {
                    if connection.start_roaming(radius, update_interval)? {
                        context.reply(&format!(
                            "🚶 Roaming started (radius {radius}, update every {} ms).",
                            update_interval.as_millis()
                        ));
                    } else {
                        let error =
                            "Roaming is already active or the requested settings are invalid.";
                        context.error(error);
                        result.success = false;
                        result.error = Some(error.to_owned());
                    }
                }
                RuntimeCommandAction::StopRoaming => {
                    if connection.stop_roaming() {
                        context.reply("Stopped roaming.");
                    } else {
                        context.reply("Roaming is not active.");
                    }
                }
                RuntimeCommandAction::StopAll => {
                    connection.stop_movement();
                    context.reply("⛔ All movement and mining operations halted.");
                }
                RuntimeCommandAction::MoveToPosition { x, y, z, range } => {
                    if connection.move_to_position(x, y, z, range)? {
                        context.reply(&format!("🏃 Moving to {x:.1}, {y:.1}, {z:.1}."));
                    } else {
                        let error =
                            "Coordinates must be within supported world bounds and range 0.5–50.";
                        context.error(error);
                        result.success = false;
                        result.error = Some(error.to_owned());
                    }
                }
                RuntimeCommandAction::Coordinates => match connection.position() {
                    Some(position) => context.reply(&format!(
                        "📍 Current Location: X: {}, Y: {}, Z: {}",
                        position.x.floor(),
                        position.y.floor(),
                        position.z.floor()
                    )),
                    None => {
                        let error = "Bot not spawned yet.";
                        context.error(error);
                        result.success = false;
                        result.error = Some(error.to_owned());
                    }
                },
                RuntimeCommandAction::Inventory { slot } => {
                    let snapshot = connection.inventory_snapshot()?;
                    context.private_reply(&snapshot.inventory_report(slot));
                }
                RuntimeCommandAction::ItemCount { name } => {
                    let snapshot = connection.inventory_snapshot()?;
                    let count = snapshot.count_item(&name);
                    context.private_reply(&format!("📦 {count}x {name}"));
                }
                RuntimeCommandAction::Equipment => {
                    let snapshot = connection.inventory_snapshot()?;
                    context.private_reply(&snapshot.equipment_report());
                }
                RuntimeCommandAction::MineBlock { name } => {
                    if connection.start_mining_block(&name, &context.username)? {
                        context.private_reply(&format!(
                            "⛏️ Mining the nearest {name} within 32 blocks."
                        ));
                    } else {
                        let error = format!(
                            "No breakable {name} block was found nearby, or mining is already active."
                        );
                        context.error(&error);
                        result.success = false;
                        result.error = Some(error);
                    }
                }
                // Base/Storage commands
                RuntimeCommandAction::SetBase { x, y, z } => {
                    if let Err(e) = connection.set_base(x, y, z) {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply(&format!(
                            "🏠 Base location set to X: {}, Y: {}, Z: {}",
                            x.unwrap_or(0.0).floor(),
                            y.unwrap_or(0.0).floor(),
                            z.unwrap_or(0.0).floor()
                        ));
                    }
                }
                RuntimeCommandAction::Home => {
                    if let Err(e) = connection.go_home() {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply("🏃 Heading home to base location.");
                    }
                }
                RuntimeCommandAction::SetMiningBase => {
                    if let Err(e) = connection.set_mining_base() {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply("⛏️ Mining base set at current location.");
                    }
                }
                RuntimeCommandAction::MiningBase => {
                    if let Err(e) = connection.go_mining_base() {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply("🏃 Heading to mining operations base.");
                    }
                }
                RuntimeCommandAction::BaseChest => {
                    if let Err(e) = connection.open_base_chest() {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    }
                }
                RuntimeCommandAction::SortChest => {
                    if let Err(e) = connection.sort_chest() {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply("📦 Chest sorted.");
                    }
                }
                RuntimeCommandAction::DepositItems => {
                    if let Err(e) = connection.deposit_items() {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply("📦 Items deposited to chest.");
                    }
                }
                // Mining commands
                RuntimeCommandAction::StartMiner { direction, length } => {
                    if let Err(e) = connection.start_miner(&direction, length) {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply(&format!(
                            "⛏️ Starting {length} block tunnel to the {direction}..."
                        ));
                    }
                }
                RuntimeCommandAction::StopMiner => {
                    connection.stop_miner();
                    context.reply("⛏️ Miner stopped.");
                }
                RuntimeCommandAction::StartMineArea {
                    x1,
                    y1,
                    z1,
                    x2,
                    y2,
                    z2,
                } => {
                    if let Err(e) = connection.start_mine_area(x1, y1, z1, x2, y2, z2) {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply(&format!(
                            "⛏️ Mining area from ({x1},{y1},{z1}) to ({x2},{y2},{z2})."
                        ));
                    }
                }
                RuntimeCommandAction::StopMineArea => {
                    connection.stop_mine_area();
                    context.reply("⛏️ Mine area stopped.");
                }
                RuntimeCommandAction::Refuel => {
                    if let Err(e) = connection.refuel() {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply("⛽ Refuel protocol started.");
                    }
                }
                RuntimeCommandAction::Lumberjack { radius } => {
                    if let Err(e) = connection.start_lumberjack(radius) {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply(&format!("🌲 Lumberjack mode started (radius {radius})."));
                    }
                }
                // Building commands
                RuntimeCommandAction::BuildRoof { radius } => {
                    if let Err(e) = connection.build_roof(radius) {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply(&format!("🏠 Building roof with radius {radius}."));
                    }
                }
                // Combat/Guard commands
                RuntimeCommandAction::StartGuard => {
                    if let Err(e) = connection.start_guard() {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply("🛡️ Guarding current location.");
                    }
                }
                RuntimeCommandAction::StopGuard => {
                    connection.stop_guard();
                    context.reply("🛑 Guard stopped.");
                }
                RuntimeCommandAction::StartPvp { target } => {
                    if let Err(e) = connection.start_pvp(&target) {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply(&format!("⚔️ PVP engaged vs {target}."));
                    }
                }
                RuntimeCommandAction::StopPvp => {
                    connection.stop_pvp();
                    context.reply("🛑 PVP stopped.");
                }
                // Utility commands
                RuntimeCommandAction::Panic => {
                    connection.activate_panic_mode();
                    context.reply("🚨 Panic mode activated!");
                }
                RuntimeCommandAction::Stealth => {
                    connection.toggle_stealth();
                    context.reply("👻 Stealth mode toggled.");
                }
                RuntimeCommandAction::StopDefense => {
                    connection.stop_defense();
                    context.reply("🛑 Auto-defense halted and target cleared.");
                }
                // Memory commands
                RuntimeCommandAction::Remember { key, fact } => {
                    let memory_path = "./memory.json";
                    match load_memory(memory_path) {
                        Ok(mut memory) => match remember_fact(&mut memory, &key, &fact) {
                            Ok(true) => {
                                if let Err(e) = save_memory(memory_path, &memory) {
                                    context.error(&format!("Failed to save memory: {e}"));
                                    result.success = false;
                                    result.error = Some(e.to_string());
                                } else {
                                    context.private_reply(&format!("🧠 Remembered: {key}"));
                                }
                            }
                            Ok(false) => {
                                context
                                    .private_reply("Memory is disabled or the key/fact is empty.");
                                result.success = false;
                            }
                            Err(e) => {
                                context.error(&format!("Failed to remember: {e}"));
                                result.success = false;
                                result.error = Some(e.to_string());
                            }
                        },
                        Err(e) => {
                            context.error(&format!("Failed to load memory: {e}"));
                            result.success = false;
                            result.error = Some(e.to_string());
                        }
                    }
                }
                RuntimeCommandAction::Forget { key } => {
                    let memory_path = "./memory.json";
                    match load_memory(memory_path) {
                        Ok(mut memory) => match forget_fact(&mut memory, &key) {
                            Ok(true) => {
                                if let Err(e) = save_memory(memory_path, &memory) {
                                    context.error(&format!("Failed to save memory: {e}"));
                                    result.success = false;
                                    result.error = Some(e.to_string());
                                } else {
                                    context.private_reply(&format!("🧠 Forgot: {key}"));
                                }
                            }
                            Ok(false) => {
                                context.private_reply(
                                    "Memory is disabled or that fact was not found.",
                                );
                                result.success = false;
                            }
                            Err(e) => {
                                context.error(&format!("Failed to forget: {e}"));
                                result.success = false;
                                result.error = Some(e.to_string());
                            }
                        },
                        Err(e) => {
                            context.error(&format!("Failed to load memory: {e}"));
                            result.success = false;
                            result.error = Some(e.to_string());
                        }
                    }
                }
                // Chat/OpenAI
                RuntimeCommandAction::Chat { message } => {
                    // This would need OpenAI integration - for now just acknowledge
                    context.private_reply(&format!(
                        "💬 Chat received: {message} (OpenAI integration pending)"
                    ));
                }
                // Server command
                RuntimeCommandAction::ServerCommand { command } => {
                    connection.send_chat(&format!("/{command}"))?;
                    context.reply(&format!("📤 Sent server command: /{command}"));
                }
                // General commands
                RuntimeCommandAction::Status => {
                    let state = connection.state();
                    let pos = connection.position();
                    let uptime = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    context.reply(&format!(
                        "📊 **Bot Status**\nState: {:?}\nPosition: {}\nUptime: {}s",
                        state,
                        pos.map(|p| format!("X:{:.1} Y:{:.1} Z:{:.1}", p.x, p.y, p.z))
                            .unwrap_or("Unknown".to_owned()),
                        uptime
                    ));
                }
                RuntimeCommandAction::Test => {
                    context.reply("✅ Test command working! Rust runtime is operational.");
                }
                RuntimeCommandAction::Version => {
                    context.reply(&format!(
                        "🤖 **mc-ai-bot Rust Runtime**\nVersion: 0.1.0-rust\nMinecraft: {}\nRust: {}",
                        crate::config::SUPPORTED_MINECRAFT_VERSION,
                        env!("CARGO_PKG_VERSION")
                    ));
                }
                RuntimeCommandAction::Uptime => {
                    let uptime = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    let hours = uptime / 3600;
                    let minutes = (uptime % 3600) / 60;
                    let seconds = uptime % 60;
                    context.reply(&format!("⏱️ Uptime: {}h {}m {}s", hours, minutes, seconds));
                }
                RuntimeCommandAction::List => {
                    let commands = connection.command_registry().get_all().unwrap_or_default();
                    let cmd_list = commands
                        .iter()
                        .map(|c| {
                            format!("  {} - {}", c.name, c.description.as_deref().unwrap_or(""))
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    context.private_reply(&format!(
                        "📋 **Available Commands** ({}):\n{}",
                        commands.len(),
                        cmd_list
                    ));
                }
                // Rescue/Survival commands
                RuntimeCommandAction::Rescue { target } => {
                    if let Err(e) = connection.rescue_player(&target) {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply(&format!("🚑 Rescue mission started for {target}."));
                    }
                }
                RuntimeCommandAction::Medic { target } => {
                    if let Err(e) = connection.medic_player(&target) {
                        context.error(&e);
                        result.success = false;
                        result.error = Some(e);
                    } else {
                        context.reply(&format!("🏥 Medic mode activated for {target}."));
                    }
                }
            }
        }
        Ok(())
    }

    fn schedule_reconnect(
        &mut self,
        reason: Option<String>,
    ) -> Result<MinecraftRuntimeEvent, MinecraftRuntimeError> {
        self.connection = None;
        if self.state() == BotState::Connecting {
            self.state_machine.transition(BotState::Error)?;
        }
        self.state_machine.transition(BotState::Reconnecting)?;
        self.reconnect_attempt = self.reconnect_attempt.saturating_add(1);
        Ok(reconnect_event(self.reconnect_attempt, reason))
    }

    pub fn shutdown(&mut self) -> Result<(), MinecraftRuntimeError> {
        match self.state() {
            BotState::Shutdown => return Ok(()),
            BotState::Connected => {
                self.state_machine.transition(BotState::ShuttingDown)?;
                if let Some(mut connection) = self.connection.take() {
                    connection.disconnect()?;
                }
            }
            BotState::Error => {
                self.state_machine.transition(BotState::ShuttingDown)?;
            }
            BotState::Disconnected | BotState::Connecting | BotState::Reconnecting => {
                self.state_machine.transition(BotState::Disconnected)?;
            }
            BotState::ShuttingDown => {}
        }

        // Shutdown features
        if let Err(e) =
            tokio::runtime::Handle::current().block_on(self.feature_registry.shutdown_all())
        {
            log::error!("[FEATURES] Error during feature shutdown: {}", e);
        }

        self.state_machine.transition(BotState::Shutdown)?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
enum RuntimeCommandAction {
    Follow {
        target: String,
        range: f64,
    },
    StopFollowing,
    StartRoaming {
        radius: u32,
        update_interval: Duration,
    },
    StopRoaming,
    StopAll,
    MoveToPosition {
        x: f64,
        y: f64,
        z: f64,
        range: f64,
    },
    Coordinates,
    Inventory {
        slot: Option<usize>,
    },
    ItemCount {
        name: String,
    },
    Equipment,
    MineBlock {
        name: String,
    },
    // Base/Storage commands
    SetBase {
        x: Option<f64>,
        y: Option<f64>,
        z: Option<f64>,
    },
    Home,
    SetMiningBase,
    MiningBase,
    BaseChest,
    SortChest,
    DepositItems,
    // Mining commands
    StartMiner {
        direction: String,
        length: u32,
    },
    StopMiner,
    StartMineArea {
        x1: i32,
        y1: i32,
        z1: i32,
        x2: i32,
        y2: i32,
        z2: i32,
    },
    StopMineArea,
    Refuel,
    Lumberjack {
        radius: u32,
    },
    // Building commands
    BuildRoof {
        radius: u32,
    },
    // Combat/Guard commands
    StartGuard,
    StopGuard,
    StartPvp {
        target: String,
    },
    StopPvp,
    // Utility commands
    Panic,
    Stealth,
    StopDefense,
    // Memory commands
    Remember {
        key: String,
        fact: String,
    },
    Forget {
        key: String,
    },
    // Chat/OpenAI
    Chat {
        message: String,
    },
    // Server command
    ServerCommand {
        command: String,
    },
    // General commands
    Status,
    Test,
    Version,
    Uptime,
    List,
    // Rescue/Survival commands
    Rescue {
        target: String,
    },
    Medic {
        target: String,
    },
}

fn register_coordinate_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    let mut coords = CommandDefinition::new(
        "coords",
        "Show current coordinates",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: coords".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::Coordinates)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    coords.aliases = vec![
        "pos".to_owned(),
        "position".to_owned(),
        "whereami".to_owned(),
    ];
    coords.category = Some("General".to_owned());
    coords.permission = Some(PermissionConfig::default());
    registry.register(coords)?;
    Ok(())
}

fn register_follow_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    let follow_sender = action_sender.clone();
    let mut follow = CommandDefinition::new(
        "follow",
        "Follow a nearby player without breaking blocks",
        std::sync::Arc::new(move |context, _| {
            let sender = follow_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() > 2 {
                    return Err("Usage: follow <player> [range]".to_owned());
                }
                let target = match context.args.args.first() {
                    Some(ArgumentValue::Player(target)) if !target.trim().is_empty() => {
                        target.clone()
                    }
                    _ => return Err("A player name is required.".to_owned()),
                };
                let range = match context.args.args.get(1) {
                    Some(ArgumentValue::Number(range))
                        if range.is_finite() && (0.5..=50.0).contains(range) =>
                    {
                        *range
                    }
                    Some(_) => return Err("Follow range must be between 0.5 and 50.".to_owned()),
                    None => 2.0,
                };
                sender
                    .send(RuntimeCommandAction::Follow { target, range })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    follow.aliases = vec!["followplayer".to_owned()];
    follow.usage = Some("<player> [range]".to_owned());
    follow.category = Some("Movement".to_owned());
    follow.permission = Some(PermissionConfig::default());
    follow.arguments = vec![
        ArgumentDefinition::new("player", ArgumentType::Player, true),
        ArgumentDefinition::new("range", ArgumentType::Number, false)
            .with_default(ArgumentValue::Number(2.0))
            .with_constraint(ArgumentConstraint::Minimum(0.5))
            .with_constraint(ArgumentConstraint::Maximum(50.0)),
    ];
    registry.register(follow)?;

    let mut stop_following = CommandDefinition::new(
        "stopfollow",
        "Stop following the current player",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: stopfollow".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::StopFollowing)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    stop_following.aliases = vec!["unfollow".to_owned()];
    stop_following.category = Some("Movement".to_owned());
    stop_following.permission = Some(PermissionConfig::default());
    registry.register(stop_following)?;
    Ok(())
}

fn register_roam_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    let roam_sender = action_sender.clone();
    let mut roam = CommandDefinition::new(
        "roam",
        "Start random roaming",
        std::sync::Arc::new(move |context, _| {
            let sender = roam_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() > 2 {
                    return Err("Usage: roam [radius] [interval-ms]".to_owned());
                }
                let radius = match context.args.args.first() {
                    Some(ArgumentValue::Number(radius))
                        if radius.is_finite()
                            && radius.fract() == 0.0
                            && (1.0..=50.0).contains(radius) =>
                    {
                        *radius as u32
                    }
                    _ => return Err("Roam radius must be a whole number from 1 to 50.".to_owned()),
                };
                let interval = match context.args.args.get(1) {
                    Some(ArgumentValue::Number(interval))
                        if interval.is_finite()
                            && interval.fract() == 0.0
                            && (1_000.0..=60_000.0).contains(interval) =>
                    {
                        Duration::from_millis(*interval as u64)
                    }
                    _ => {
                        return Err(
                            "Roam interval must be a whole number from 1000 to 60000 ms."
                                .to_owned(),
                        );
                    }
                };
                sender
                    .send(RuntimeCommandAction::StartRoaming {
                        radius,
                        update_interval: interval,
                    })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    roam.aliases = vec!["startroam".to_owned()];
    roam.usage = Some("[radius] [interval-ms]".to_owned());
    roam.category = Some("Movement".to_owned());
    roam.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    roam.arguments = vec![
        ArgumentDefinition::new("radius", ArgumentType::Number, false)
            .with_default(ArgumentValue::Number(3.0))
            .with_constraint(ArgumentConstraint::Integer)
            .with_constraint(ArgumentConstraint::Minimum(1.0))
            .with_constraint(ArgumentConstraint::Maximum(50.0)),
        ArgumentDefinition::new("interval-ms", ArgumentType::Number, false)
            .with_default(ArgumentValue::Number(7_000.0))
            .with_constraint(ArgumentConstraint::Integer)
            .with_constraint(ArgumentConstraint::Minimum(1_000.0))
            .with_constraint(ArgumentConstraint::Maximum(60_000.0)),
    ];
    registry.register(roam)?;

    let stop_roaming_sender = action_sender.clone();
    let mut stop_roaming = CommandDefinition::new(
        "stoproam",
        "Stop roaming",
        std::sync::Arc::new(move |context, _| {
            let sender = stop_roaming_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: stoproam".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::StopRoaming)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    stop_roaming.aliases = vec!["unroam".to_owned()];
    stop_roaming.category = Some("Movement".to_owned());
    stop_roaming.permission = Some(PermissionConfig::default());
    registry.register(stop_roaming)?;

    let mut stop_all = CommandDefinition::new(
        "stop",
        "Stop all movement operations",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: stop".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::StopAll)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    stop_all.aliases = vec!["stopall".to_owned()];
    stop_all.category = Some("Movement".to_owned());
    stop_all.permission = Some(PermissionConfig::default());
    registry.register(stop_all)?;
    Ok(())
}

fn register_navigation_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    let mut go_to = CommandDefinition::new(
        "goto",
        "Move to a world position without breaking blocks",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() > 4 {
                    return Err("Usage: goto <x> <y> <z> [range]".to_owned());
                }
                let coordinate = |index: usize| match context.args.args.get(index) {
                    Some(ArgumentValue::Number(value)) => Some(*value),
                    _ => None,
                };
                let (Some(x), Some(y), Some(z)) = (coordinate(0), coordinate(1), coordinate(2))
                else {
                    return Err("Three coordinates are required.".to_owned());
                };
                let range = match context.args.args.get(3) {
                    Some(ArgumentValue::Number(range)) if range.is_finite() => *range,
                    _ => return Err("Move range must be between 0.5 and 50.".to_owned()),
                };
                sender
                    .send(RuntimeCommandAction::MoveToPosition { x, y, z, range })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    go_to.aliases = vec!["move".to_owned(), "moveto".to_owned()];
    go_to.usage = Some("<x> <y> <z> [range]".to_owned());
    go_to.category = Some("Movement".to_owned());
    go_to.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    go_to.arguments = vec![
        ArgumentDefinition::new("x", ArgumentType::Number, true)
            .with_constraint(ArgumentConstraint::Minimum(-MAX_WORLD_COORDINATE))
            .with_constraint(ArgumentConstraint::Maximum(MAX_WORLD_COORDINATE)),
        ArgumentDefinition::new("y", ArgumentType::Number, true)
            .with_constraint(ArgumentConstraint::Minimum(-MAX_SUPPORTED_Y_COORDINATE))
            .with_constraint(ArgumentConstraint::Maximum(MAX_SUPPORTED_Y_COORDINATE)),
        ArgumentDefinition::new("z", ArgumentType::Number, true)
            .with_constraint(ArgumentConstraint::Minimum(-MAX_WORLD_COORDINATE))
            .with_constraint(ArgumentConstraint::Maximum(MAX_WORLD_COORDINATE)),
        ArgumentDefinition::new("range", ArgumentType::Number, false)
            .with_default(ArgumentValue::Number(1.0))
            .with_constraint(ArgumentConstraint::Minimum(0.5))
            .with_constraint(ArgumentConstraint::Maximum(50.0)),
    ];
    registry.register(go_to)?;
    Ok(())
}

fn register_inventory_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    let inventory_sender = action_sender.clone();
    let mut inventory = CommandDefinition::new(
        "inventory",
        "Show inventory contents or inspect a slot",
        std::sync::Arc::new(move |context, _| {
            let sender = inventory_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() > 1 {
                    return Err("Usage: inventory [slot 0-35]".to_owned());
                }
                let slot = match context.args.args.first() {
                    Some(ArgumentValue::Number(slot))
                        if slot.is_finite()
                            && slot.fract() == 0.0
                            && (0.0..36.0).contains(slot) =>
                    {
                        Some(*slot as usize)
                    }
                    Some(_) => return Err("Inventory slot must be between 0 and 35.".to_owned()),
                    None => None,
                };
                sender
                    .send(RuntimeCommandAction::Inventory { slot })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    inventory.aliases = vec!["inv".to_owned()];
    inventory.usage = Some("[slot 0-35]".to_owned());
    inventory.category = Some("Inventory".to_owned());
    inventory.permission = Some(PermissionConfig::default());
    inventory.arguments = vec![
        ArgumentDefinition::new("slot", ArgumentType::Number, false)
            .with_constraint(ArgumentConstraint::Integer)
            .with_constraint(ArgumentConstraint::Minimum(0.0))
            .with_constraint(ArgumentConstraint::Maximum(35.0)),
    ];
    registry.register(inventory)?;

    let item_count_sender = action_sender.clone();
    let mut item_count = CommandDefinition::new(
        "itemcount",
        "Count an item in the inventory",
        std::sync::Arc::new(move |context, _| {
            let sender = item_count_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() != 1 {
                    return Err("Usage: itemcount <item-name>".to_owned());
                }
                let Some(ArgumentValue::String(name)) = context.args.args.first() else {
                    return Err("An item name is required.".to_owned());
                };
                sender
                    .send(RuntimeCommandAction::ItemCount { name: name.clone() })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    item_count.aliases = vec!["countitem".to_owned()];
    item_count.usage = Some("<item-name>".to_owned());
    item_count.category = Some("Inventory".to_owned());
    item_count.permission = Some(PermissionConfig::default());
    item_count.arguments = vec![ArgumentDefinition::new(
        "item-name",
        ArgumentType::String,
        true,
    )];
    registry.register(item_count)?;

    let mut equipment = CommandDefinition::new(
        "equipment",
        "Show equipped armor and held items",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: equipment".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::Equipment)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    equipment.aliases = vec!["gear".to_owned()];
    equipment.category = Some("Inventory".to_owned());
    equipment.permission = Some(PermissionConfig::default());
    registry.register(equipment)?;
    Ok(())
}

fn register_mining_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    let mut mine = CommandDefinition::new(
        "mine",
        "Mine the nearest nearby block of a type",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() != 1 {
                    return Err("Usage: mine <block-name>".to_owned());
                }
                let Some(ArgumentValue::String(name)) = context.args.args.first() else {
                    return Err("A block name is required.".to_owned());
                };
                let Some(block) = parse_mineable_block(name) else {
                    return Err("Enter a valid breakable Minecraft block name.".to_owned());
                };
                let id = block.to_string();
                let name = id.strip_prefix("minecraft:").unwrap_or(&id).to_owned();
                sender
                    .send(RuntimeCommandAction::MineBlock { name })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    mine.usage = Some("<block-name>".to_owned());
    mine.category = Some("Mining".to_owned());
    mine.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    mine.arguments = vec![ArgumentDefinition::new(
        "block-name",
        ArgumentType::String,
        true,
    )];
    registry.register(mine)?;
    Ok(())
}

fn register_base_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    // sbase / setbase - Set base location
    let mut set_base = CommandDefinition::new(
        "sbase",
        "Set base location",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() > 3 {
                    return Err("Usage: sbase [x] [y] [z]".to_owned());
                }
                let x = match context.args.args.get(0) {
                    Some(ArgumentValue::Number(x)) if x.is_finite() => Some(*x),
                    Some(_) => return Err("X must be a valid number.".to_owned()),
                    None => None,
                };
                let y = match context.args.args.get(1) {
                    Some(ArgumentValue::Number(y)) if y.is_finite() => Some(*y),
                    Some(_) => return Err("Y must be a valid number.".to_owned()),
                    None => None,
                };
                let z = match context.args.args.get(2) {
                    Some(ArgumentValue::Number(z)) if z.is_finite() => Some(*z),
                    Some(_) => return Err("Z must be a valid number.".to_owned()),
                    None => None,
                };
                sender
                    .send(RuntimeCommandAction::SetBase { x, y, z })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    set_base.aliases = vec!["setbase".to_owned()];
    set_base.usage = Some("[x] [y] [z]".to_owned());
    set_base.category = Some("Base".to_owned());
    set_base.permission = Some(PermissionConfig::default());
    set_base.arguments = vec![
        ArgumentDefinition::new("x", ArgumentType::Number, false),
        ArgumentDefinition::new("y", ArgumentType::Number, false),
        ArgumentDefinition::new("z", ArgumentType::Number, false),
    ];
    registry.register(set_base)?;

    // home - Return to base
    let mut home = CommandDefinition::new(
        "home",
        "Return to base location",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: home".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::Home)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    home.category = Some("Base".to_owned());
    home.permission = Some(PermissionConfig::default());
    registry.register(home)?;

    // sminebase - Set mining base
    let mut set_mine_base = CommandDefinition::new(
        "sminebase",
        "Set mining base location",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: sminebase".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::SetMiningBase)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    set_mine_base.category = Some("Base".to_owned());
    set_mine_base.permission = Some(PermissionConfig::default());
    registry.register(set_mine_base)?;

    // minebase - Go to mining base
    let mut mine_base = CommandDefinition::new(
        "minebase",
        "Go to mining base",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: minebase".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::MiningBase)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    mine_base.category = Some("Base".to_owned());
    mine_base.permission = Some(PermissionConfig::default());
    registry.register(mine_base)?;

    // basechest - View base chest contents
    let mut base_chest = CommandDefinition::new(
        "basechest",
        "View base chest contents",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: basechest".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::BaseChest)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    base_chest.category = Some("Base".to_owned());
    base_chest.permission = Some(PermissionConfig::default());
    registry.register(base_chest)?;

    // sort - Auto-sort nearby chest
    let mut sort_chest = CommandDefinition::new(
        "sort",
        "Auto-sort nearby chest",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: sort".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::SortChest)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    sort_chest.category = Some("Base".to_owned());
    sort_chest.permission = Some(PermissionConfig::default());
    registry.register(sort_chest)?;

    // deposit - Deposit items to chest
    let mut deposit = CommandDefinition::new(
        "deposit",
        "Deposit non-essential items to chest",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: deposit".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::DepositItems)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    deposit.category = Some("Base".to_owned());
    deposit.permission = Some(PermissionConfig::default());
    registry.register(deposit)?;

    Ok(())
}

fn register_mining_feature_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    // miner - Start mining tunnel
    let mut miner = CommandDefinition::new(
        "miner",
        "Start a mining tunnel",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() > 2 {
                    return Err("Usage: miner <north|south|east|west> [length]".to_owned());
                }
                let direction = match context.args.args.first() {
                    Some(ArgumentValue::String(d))
                        if ["north", "south", "east", "west"].contains(&d.as_str()) =>
                    {
                        d.clone()
                    }
                    Some(_) => {
                        return Err("Direction must be north, south, east, or west.".to_owned());
                    }
                    None => return Err("A direction is required.".to_owned()),
                };
                let length = match context.args.args.get(1) {
                    Some(ArgumentValue::Number(l))
                        if l.is_finite() && l.fract() == 0.0 && (1.0..=1000.0).contains(l) =>
                    {
                        *l as u32
                    }
                    Some(_) => {
                        return Err("Length must be a whole number from 1 to 1000.".to_owned());
                    }
                    None => 10,
                };
                sender
                    .send(RuntimeCommandAction::StartMiner { direction, length })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    miner.usage = Some("<north|south|east|west> [length]".to_owned());
    miner.category = Some("Mining".to_owned());
    miner.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    miner.arguments = vec![
        ArgumentDefinition::new("direction", ArgumentType::String, true),
        ArgumentDefinition::new("length", ArgumentType::Number, false)
            .with_default(ArgumentValue::Number(10.0))
            .with_constraint(ArgumentConstraint::Integer)
            .with_constraint(ArgumentConstraint::Minimum(1.0))
            .with_constraint(ArgumentConstraint::Maximum(1000.0)),
    ];
    registry.register(miner)?;

    // stopminer - Stop mining tunnel
    let mut stop_miner = CommandDefinition::new(
        "stopminer",
        "Stop mining tunnel",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: stopminer".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::StopMiner)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    stop_miner.category = Some("Mining".to_owned());
    stop_miner.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    registry.register(stop_miner)?;

    // minearea - Start mining area
    let mut mine_area = CommandDefinition::new(
        "minearea",
        "Start mining an area between two positions",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() != 6 {
                    return Err("Usage: minearea <x1> <y1> <z1> <x2> <y2> <z2>".to_owned());
                }
                let coords: Result<Vec<i32>, _> =
                    context.raw_args.iter().map(|s| s.parse::<i32>()).collect();
                let coords = coords.map_err(|_| "All coordinates must be integers.".to_owned())?;
                sender
                    .send(RuntimeCommandAction::StartMineArea {
                        x1: coords[0],
                        y1: coords[1],
                        z1: coords[2],
                        x2: coords[3],
                        y2: coords[4],
                        z2: coords[5],
                    })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    mine_area.usage = Some("<x1> <y1> <z1> <x2> <y2> <z2>".to_owned());
    mine_area.category = Some("Mining".to_owned());
    mine_area.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    mine_area.arguments = vec![
        ArgumentDefinition::new("x1", ArgumentType::Number, true)
            .with_constraint(ArgumentConstraint::Integer),
        ArgumentDefinition::new("y1", ArgumentType::Number, true)
            .with_constraint(ArgumentConstraint::Integer),
        ArgumentDefinition::new("z1", ArgumentType::Number, true)
            .with_constraint(ArgumentConstraint::Integer),
        ArgumentDefinition::new("x2", ArgumentType::Number, true)
            .with_constraint(ArgumentConstraint::Integer),
        ArgumentDefinition::new("y2", ArgumentType::Number, true)
            .with_constraint(ArgumentConstraint::Integer),
        ArgumentDefinition::new("z2", ArgumentType::Number, true)
            .with_constraint(ArgumentConstraint::Integer),
    ];
    registry.register(mine_area)?;

    // stopminearea - Stop mining area
    let mut stop_mine_area = CommandDefinition::new(
        "stopminearea",
        "Stop mining area",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: stopminearea".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::StopMineArea)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    stop_mine_area.category = Some("Mining".to_owned());
    stop_mine_area.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    registry.register(stop_mine_area)?;

    // refuel - Search for and mine coal
    let mut refuel = CommandDefinition::new(
        "refuel",
        "Search for and mine coal",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: refuel".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::Refuel)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    refuel.category = Some("Mining".to_owned());
    refuel.permission = Some(PermissionConfig::default());
    registry.register(refuel)?;

    // lumberjack - Toggle lumberjack mode
    let mut lumberjack = CommandDefinition::new(
        "lumberjack",
        "Start lumberjack mode (chop trees in radius)",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() > 1 {
                    return Err("Usage: lumberjack [radius]".to_owned());
                }
                let radius = match context.args.args.first() {
                    Some(ArgumentValue::Number(r))
                        if r.is_finite() && r.fract() == 0.0 && (1.0..=50.0).contains(r) =>
                    {
                        *r as u32
                    }
                    Some(_) => return Err("Radius must be a whole number from 1 to 50.".to_owned()),
                    None => 5,
                };
                sender
                    .send(RuntimeCommandAction::Lumberjack { radius })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    lumberjack.usage = Some("[radius]".to_owned());
    lumberjack.category = Some("Mining".to_owned());
    lumberjack.permission = Some(PermissionConfig::default());
    lumberjack.arguments = vec![
        ArgumentDefinition::new("radius", ArgumentType::Number, false)
            .with_default(ArgumentValue::Number(5.0))
            .with_constraint(ArgumentConstraint::Integer)
            .with_constraint(ArgumentConstraint::Minimum(1.0))
            .with_constraint(ArgumentConstraint::Maximum(50.0)),
    ];
    registry.register(lumberjack)?;

    Ok(())
}

fn register_building_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    // roof - Build a roof at base
    let mut roof = CommandDefinition::new(
        "roof",
        "Build a roof at base",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() > 1 {
                    return Err("Usage: roof [radius]".to_owned());
                }
                let radius = match context.args.args.first() {
                    Some(ArgumentValue::Number(r))
                        if r.is_finite() && r.fract() == 0.0 && (1.0..=50.0).contains(r) =>
                    {
                        *r as u32
                    }
                    Some(_) => return Err("Radius must be a whole number from 1 to 50.".to_owned()),
                    None => 5,
                };
                sender
                    .send(RuntimeCommandAction::BuildRoof { radius })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    roof.usage = Some("[radius]".to_owned());
    roof.category = Some("Building".to_owned());
    roof.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    roof.arguments = vec![
        ArgumentDefinition::new("radius", ArgumentType::Number, false)
            .with_default(ArgumentValue::Number(5.0))
            .with_constraint(ArgumentConstraint::Integer)
            .with_constraint(ArgumentConstraint::Minimum(1.0))
            .with_constraint(ArgumentConstraint::Maximum(50.0)),
    ];
    registry.register(roof)?;

    Ok(())
}

fn register_combat_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    // guard - Guard current location
    let mut guard = CommandDefinition::new(
        "guard",
        "Guard current location",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: guard".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::StartGuard)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    guard.category = Some("Combat".to_owned());
    guard.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    registry.register(guard)?;

    // stopguard - Stop guarding
    let mut stop_guard = CommandDefinition::new(
        "stopguard",
        "Stop guarding",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: stopguard".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::StopGuard)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    stop_guard.category = Some("Combat".to_owned());
    stop_guard.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    registry.register(stop_guard)?;

    // pvp - Engage PVP with player
    let mut pvp = CommandDefinition::new(
        "pvp",
        "Engage PVP with player",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() != 1 {
                    return Err("Usage: pvp <player>".to_owned());
                }
                let Some(ArgumentValue::String(target)) = context.args.args.first() else {
                    return Err("A player name is required.".to_owned());
                };
                sender
                    .send(RuntimeCommandAction::StartPvp {
                        target: target.clone(),
                    })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    pvp.usage = Some("<player>".to_owned());
    pvp.category = Some("Combat".to_owned());
    pvp.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    pvp.arguments = vec![ArgumentDefinition::new(
        "player",
        ArgumentType::String,
        true,
    )];
    registry.register(pvp)?;

    // stoppvp - Stop PVP
    let mut stop_pvp = CommandDefinition::new(
        "stoppvp",
        "Stop PVP",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: stoppvp".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::StopPvp)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    stop_pvp.category = Some("Combat".to_owned());
    stop_pvp.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    registry.register(stop_pvp)?;

    Ok(())
}

fn register_utility_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    // panic - Activate panic mode
    let mut panic = CommandDefinition::new(
        "panic",
        "Activate panic mode (flee to safety)",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: panic".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::Panic)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    panic.category = Some("Utility".to_owned());
    panic.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    registry.register(panic)?;

    // stealth - Toggle stealth mode
    let mut stealth = CommandDefinition::new(
        "stealth",
        "Toggle stealth mode (sneak)",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: stealth".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::Stealth)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    stealth.category = Some("Utility".to_owned());
    stealth.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    registry.register(stealth)?;

    // dstop - Stop auto-defense
    let mut dstop = CommandDefinition::new(
        "dstop",
        "Stop auto-defense",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: dstop".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::StopDefense)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    dstop.category = Some("Utility".to_owned());
    dstop.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    registry.register(dstop)?;

    Ok(())
}

fn register_memory_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    // remember - Remember a fact
    let mut remember = CommandDefinition::new(
        "remember",
        "Remember a fact",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.is_empty() {
                    return Err("Usage: remember <key>=<fact>".to_owned());
                }
                let content = context.raw_args.join(" ");
                let separator = content.find('=').ok_or("Usage: remember <key>=<fact>")?;
                let key = content[..separator].trim().to_owned();
                let fact = content[separator + 1..].trim().to_owned();
                if key.is_empty() || fact.is_empty() {
                    return Err("Key and fact cannot be empty.".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::Remember { key, fact })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    remember.usage = Some("<key>=<fact>".to_owned());
    remember.category = Some("Memory".to_owned());
    remember.permission = Some(PermissionConfig::default());
    registry.register(remember)?;

    // forget - Forget a fact
    let mut forget = CommandDefinition::new(
        "forget",
        "Forget a fact",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() != 1 {
                    return Err("Usage: forget <key>".to_owned());
                }
                let Some(ArgumentValue::String(key)) = context.args.args.first() else {
                    return Err("A key is required.".to_owned());
                };
                sender
                    .send(RuntimeCommandAction::Forget { key: key.clone() })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    forget.usage = Some("<key>".to_owned());
    forget.category = Some("Memory".to_owned());
    forget.permission = Some(PermissionConfig::default());
    forget.arguments = vec![ArgumentDefinition::new("key", ArgumentType::String, true)];
    registry.register(forget)?;

    Ok(())
}

fn register_chat_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    // chat - Chat with AI assistant
    let mut chat = CommandDefinition::new(
        "chat",
        "Chat with AI assistant",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.is_empty() {
                    return Err("Usage: chat <message>".to_owned());
                }
                let message = context.raw_args.join(" ");
                sender
                    .send(RuntimeCommandAction::Chat { message })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    chat.usage = Some("<message>".to_owned());
    chat.category = Some("Chat".to_owned());
    chat.permission = Some(PermissionConfig::default());
    registry.register(chat)?;

    Ok(())
}

fn register_admin_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    // servercmd - Execute server command
    let mut server_cmd = CommandDefinition::new(
        "servercmd",
        "Execute server command",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.is_empty() {
                    return Err("Usage: servercmd <command>".to_owned());
                }
                let command = context.raw_args.join(" ");
                sender
                    .send(RuntimeCommandAction::ServerCommand { command })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    server_cmd.usage = Some("<command>".to_owned());
    server_cmd.category = Some("Admin".to_owned());
    server_cmd.permission = Some(PermissionConfig {
        level: PermissionLevel::Admin,
        ..PermissionConfig::default()
    });
    registry.register(server_cmd)?;

    Ok(())
}

fn register_general_commands(
    registry: &CommandRegistry,
    action_sender: mpsc::Sender<RuntimeCommandAction>,
) -> Result<(), CommandRegistryError> {
    // status - Show bot status
    let mut status = CommandDefinition::new(
        "status",
        "Show bot status",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: status".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::Status)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    status.aliases = vec!["info".to_owned()];
    status.category = Some("General".to_owned());
    status.permission = Some(PermissionConfig::default());
    registry.register(status)?;

    // test - Test command
    let mut test = CommandDefinition::new(
        "test",
        "Test if bot is responsive",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: test".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::Test)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    test.category = Some("General".to_owned());
    test.permission = Some(PermissionConfig::default());
    registry.register(test)?;

    // version - Show version info
    let mut version = CommandDefinition::new(
        "version",
        "Show version information",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: version".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::Version)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    version.aliases = vec!["ver".to_owned()];
    version.category = Some("General".to_owned());
    version.permission = Some(PermissionConfig::default());
    registry.register(version)?;

    // uptime - Show uptime
    let mut uptime = CommandDefinition::new(
        "uptime",
        "Show bot uptime",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: uptime".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::Uptime)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    uptime.category = Some("General".to_owned());
    uptime.permission = Some(PermissionConfig::default());
    registry.register(uptime)?;

    // list - List all commands
    let mut list = CommandDefinition::new(
        "list",
        "List all available commands",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if !context.raw_args.is_empty() {
                    return Err("Usage: list".to_owned());
                }
                sender
                    .send(RuntimeCommandAction::List)
                    .map_err(|error| error.to_string())
            })
        }),
    );
    list.aliases = vec!["commands".to_owned(), "help".to_owned()];
    list.category = Some("General".to_owned());
    list.permission = Some(PermissionConfig::default());
    registry.register(list)?;

    // rescue - Rescue a player
    let mut rescue = CommandDefinition::new(
        "rescue",
        "Rescue a player (bring food, protect)",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() != 1 {
                    return Err("Usage: rescue <player>".to_owned());
                }
                let Some(ArgumentValue::Player(target)) = context.args.args.first() else {
                    return Err("A player name is required.".to_owned());
                };
                sender
                    .send(RuntimeCommandAction::Rescue {
                        target: target.clone(),
                    })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    rescue.usage = Some("<player>".to_owned());
    rescue.category = Some("Survival".to_owned());
    rescue.permission = Some(PermissionConfig::default());
    rescue.arguments = vec![ArgumentDefinition::new(
        "player",
        ArgumentType::Player,
        true,
    )];
    registry.register(rescue)?;

    // medic - Medic mode for a player
    let mut medic = CommandDefinition::new(
        "medic",
        "Continuous heal/protect a player",
        std::sync::Arc::new(move |context, _| {
            let sender = action_sender.clone();
            Box::pin(async move {
                if context.raw_args.len() != 1 {
                    return Err("Usage: medic <player>".to_owned());
                }
                let Some(ArgumentValue::Player(target)) = context.args.args.first() else {
                    return Err("A player name is required.".to_owned());
                };
                sender
                    .send(RuntimeCommandAction::Medic {
                        target: target.clone(),
                    })
                    .map_err(|error| error.to_string())
            })
        }),
    );
    medic.usage = Some("<player>".to_owned());
    medic.category = Some("Survival".to_owned());
    medic.permission = Some(PermissionConfig::default());
    medic.arguments = vec![ArgumentDefinition::new(
        "player",
        ArgumentType::Player,
        true,
    )];
    registry.register(medic)?;

    Ok(())
}

struct CommandDispatch {
    event: MinecraftRuntimeEvent,
    username: String,
    replies: Vec<CommandReply>,
}

struct CommandReply {
    destination: ReplyDestination,
    message: String,
}

enum ReplyDestination {
    Public,
    Private,
}

fn reconnect_event(attempt: u32, reason: Option<String>) -> MinecraftRuntimeEvent {
    let retry_in_ms = reconnect_delay(attempt.saturating_sub(1)).as_millis() as u64;
    MinecraftRuntimeEvent::ReconnectScheduled {
        attempt,
        retry_in_ms,
        reason,
    }
}

fn reconnect_delay(attempt: u32) -> Duration {
    Duration::from_secs((1_u64 << attempt.min(6)).min(60))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        sync::Arc,
        task::{Context, Poll, Wake, Waker},
    };

    struct NoopWake;

    impl Wake for NoopWake {
        fn wake(self: Arc<Self>) {}
    }

    fn run<F: Future>(future: F) -> F::Output {
        let waker = Waker::from(Arc::new(NoopWake));
        let mut context = Context::from_waker(&waker);
        let mut future = Box::pin(future);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    #[test]
    fn reconnect_delay_doubles_and_stops_at_sixty_seconds() {
        for (attempt, expected_seconds) in [(0, 1), (1, 2), (2, 4), (5, 32), (6, 60), (20, 60)] {
            assert_eq!(
                reconnect_delay(attempt),
                Duration::from_secs(expected_seconds)
            );
        }
    }

    #[test]
    fn reconnect_events_report_attempt_and_delay() {
        assert_eq!(
            reconnect_event(1, Some("disconnected".to_owned())),
            MinecraftRuntimeEvent::ReconnectScheduled {
                attempt: 1,
                retry_in_ms: 1_000,
                reason: Some("disconnected".to_owned()),
            }
        );
        assert_eq!(
            reconnect_event(2, None),
            MinecraftRuntimeEvent::ReconnectScheduled {
                attempt: 2,
                retry_in_ms: 2_000,
                reason: None,
            }
        );
    }

    #[test]
    fn runtime_shutdown_is_idempotent() {
        let config = BotConfig {
            host: "localhost".to_owned(),
            port: 25565,
            username: "Airi".to_owned(),
            password: None,
            version: "1.21.1".to_owned(),
            auth: "offline".to_owned(),
            check_timeout_interval: 60_000,
        };
        let mut runtime = MinecraftRuntime::new(config);

        runtime.shutdown().unwrap();
        runtime.shutdown().unwrap();

        assert_eq!(runtime.state(), BotState::Shutdown);
    }

    #[test]
    fn runtime_dispatches_chat_commands_and_queues_replies() {
        let config = BotConfig {
            host: "localhost".to_owned(),
            port: 25565,
            username: "Airi".to_owned(),
            password: None,
            version: "1.21.1".to_owned(),
            auth: "offline".to_owned(),
            check_timeout_interval: 60_000,
        };
        let mut runtime = MinecraftRuntime::new(config);

        let dispatch = run(runtime.dispatch_chat_command(Some("Alex"), "!ping", false))
            .unwrap()
            .unwrap();

        let MinecraftRuntimeEvent::CommandExecuted {
            username,
            command,
            result,
        } = dispatch.event
        else {
            panic!("expected command execution event");
        };
        assert_eq!(username, "Alex");
        assert_eq!(command, "ping");
        assert!(result.success);
        assert!(result.found);
        assert_eq!(result.error, None);
        assert_eq!(dispatch.replies.len(), 1);
        assert!(matches!(
            dispatch.replies[0].destination,
            ReplyDestination::Public
        ));
        assert_eq!(dispatch.replies[0].message, "🏓 Pong!");
    }

    #[test]
    fn follow_command_schedules_valid_target_and_rejects_out_of_range_values() {
        let registry = CommandRegistry::default();
        let (sender, receiver) = mpsc::channel();
        register_follow_commands(&registry, sender).unwrap();
        let mut context = CommandContext::new(
            "Alex",
            vec!["Jordan".to_owned(), "4".to_owned()],
            crate::commands::PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );

        let result = run(registry.execute("follow", &mut context)).unwrap();
        assert!(result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::Follow {
                target: "Jordan".to_owned(),
                range: 4.0,
            }
        );

        let mut invalid_context = CommandContext::new(
            "Alex",
            vec!["Jordan".to_owned(), "51".to_owned()],
            crate::commands::PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let invalid_result = run(registry.execute("follow", &mut invalid_context)).unwrap();
        assert!(!invalid_result.success);
        assert!(receiver.try_recv().is_err());

        let mut default_range_context = CommandContext::new(
            "Alex",
            vec!["Jordan".to_owned()],
            crate::commands::PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let default_range_result =
            run(registry.execute("follow", &mut default_range_context)).unwrap();
        assert!(default_range_result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::Follow {
                target: "Jordan".to_owned(),
                range: 2.0,
            }
        );

        let mut stop_context = CommandContext::new(
            "Alex",
            Vec::new(),
            crate::commands::PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let stop_result = run(registry.execute("unfollow", &mut stop_context)).unwrap();
        assert!(stop_result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::StopFollowing
        );
    }

    #[test]
    fn roam_commands_require_admin_and_schedule_valid_settings() {
        let registry = CommandRegistry::default();
        let (sender, receiver) = mpsc::channel();
        register_roam_commands(&registry, sender).unwrap();
        let mut guest_context = CommandContext::new(
            "Alex",
            Vec::new(),
            PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let denied_result = run(registry.execute("roam", &mut guest_context)).unwrap();
        assert!(!denied_result.success);
        assert!(receiver.try_recv().is_err());

        let mut admin_context = CommandContext::new(
            "Alex",
            Vec::new(),
            PermissionLevel::Admin,
            false,
            |_| {},
            |_| {},
        );
        let default_result = run(registry.execute("roam", &mut admin_context)).unwrap();
        assert!(default_result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::StartRoaming {
                radius: 3,
                update_interval: Duration::from_millis(7_000),
            }
        );

        let mut custom_context = CommandContext::new(
            "Alex",
            vec!["12".to_owned(), "1500".to_owned()],
            PermissionLevel::Admin,
            false,
            |_| {},
            |_| {},
        );
        let custom_result = run(registry.execute("startroam", &mut custom_context)).unwrap();
        assert!(custom_result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::StartRoaming {
                radius: 12,
                update_interval: Duration::from_millis(1_500),
            }
        );

        let mut invalid_context = CommandContext::new(
            "Alex",
            vec!["12".to_owned(), "999".to_owned()],
            PermissionLevel::Admin,
            false,
            |_| {},
            |_| {},
        );
        let invalid_result = run(registry.execute("roam", &mut invalid_context)).unwrap();
        assert!(!invalid_result.success);
        assert!(receiver.try_recv().is_err());

        let mut stop_context = CommandContext::new(
            "Alex",
            Vec::new(),
            PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let stop_result = run(registry.execute("unroam", &mut stop_context)).unwrap();
        assert!(stop_result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::StopRoaming
        );

        let mut stop_all_context = CommandContext::new(
            "Alex",
            Vec::new(),
            PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let stop_all_result = run(registry.execute("stopall", &mut stop_all_context)).unwrap();
        assert!(stop_all_result.success);
        assert_eq!(receiver.try_recv().unwrap(), RuntimeCommandAction::StopAll);
    }

    #[test]
    fn goto_command_requires_admin_and_validates_coordinates() {
        let registry = CommandRegistry::default();
        let (sender, receiver) = mpsc::channel();
        register_navigation_commands(&registry, sender).unwrap();
        let mut guest_context = CommandContext::new(
            "Alex",
            vec!["12".to_owned(), "64".to_owned(), "-4".to_owned()],
            PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let denied_result = run(registry.execute("goto", &mut guest_context)).unwrap();
        assert!(!denied_result.success);
        assert!(receiver.try_recv().is_err());

        let mut admin_context = CommandContext::new(
            "Alex",
            vec!["12.5".to_owned(), "64".to_owned(), "-4.5".to_owned()],
            PermissionLevel::Admin,
            false,
            |_| {},
            |_| {},
        );
        let default_result = run(registry.execute("move", &mut admin_context)).unwrap();
        assert!(default_result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::MoveToPosition {
                x: 12.5,
                y: 64.0,
                z: -4.5,
                range: 1.0,
            }
        );

        let mut custom_range_context = CommandContext::new(
            "Alex",
            vec![
                "12".to_owned(),
                "64".to_owned(),
                "-4".to_owned(),
                "3".to_owned(),
            ],
            PermissionLevel::Admin,
            false,
            |_| {},
            |_| {},
        );
        let custom_range_result = run(registry.execute("goto", &mut custom_range_context)).unwrap();
        assert!(custom_range_result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::MoveToPosition {
                x: 12.0,
                y: 64.0,
                z: -4.0,
                range: 3.0,
            }
        );

        let mut invalid_context = CommandContext::new(
            "Alex",
            vec![
                "30000000".to_owned(),
                "64".to_owned(),
                "0".to_owned(),
                "1".to_owned(),
            ],
            PermissionLevel::Admin,
            false,
            |_| {},
            |_| {},
        );
        let invalid_result = run(registry.execute("goto", &mut invalid_context)).unwrap();
        assert!(!invalid_result.success);
        assert!(receiver.try_recv().is_err());

        let mut invalid_range_context = CommandContext::new(
            "Alex",
            vec![
                "12".to_owned(),
                "64".to_owned(),
                "-4".to_owned(),
                "51".to_owned(),
            ],
            PermissionLevel::Admin,
            false,
            |_| {},
            |_| {},
        );
        let invalid_range_result =
            run(registry.execute("goto", &mut invalid_range_context)).unwrap();
        assert!(!invalid_range_result.success);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn inventory_commands_schedule_read_only_queries_for_guest_users() {
        let registry = CommandRegistry::default();
        let (sender, receiver) = mpsc::channel();
        register_inventory_commands(&registry, sender).unwrap();
        let mut inventory_context = CommandContext::new(
            "Alex",
            Vec::new(),
            PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let inventory_result = run(registry.execute("inventory", &mut inventory_context)).unwrap();
        assert!(inventory_result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::Inventory { slot: None }
        );

        let mut slot_context = CommandContext::new(
            "Alex",
            vec!["35".to_owned()],
            PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let slot_result = run(registry.execute("inv", &mut slot_context)).unwrap();
        assert!(slot_result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::Inventory { slot: Some(35) }
        );

        let mut invalid_slot_context = CommandContext::new(
            "Alex",
            vec!["36".to_owned()],
            PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let invalid_slot_result =
            run(registry.execute("inventory", &mut invalid_slot_context)).unwrap();
        assert!(!invalid_slot_result.success);
        assert!(receiver.try_recv().is_err());

        let mut count_context = CommandContext::new(
            "Alex",
            vec!["minecraft:diamond".to_owned()],
            PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let count_result = run(registry.execute("countitem", &mut count_context)).unwrap();
        assert!(count_result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::ItemCount {
                name: "minecraft:diamond".to_owned(),
            }
        );

        let mut equipment_context = CommandContext::new(
            "Alex",
            Vec::new(),
            PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let equipment_result = run(registry.execute("gear", &mut equipment_context)).unwrap();
        assert!(equipment_result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::Equipment
        );
    }

    #[test]
    fn coords_command_supports_guest_aliases_and_rejects_arguments() {
        let registry = CommandRegistry::default();
        let (sender, receiver) = mpsc::channel();
        register_coordinate_commands(&registry, sender).unwrap();
        let mut context = CommandContext::new(
            "Alex",
            Vec::new(),
            PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let result = run(registry.execute("whereami", &mut context)).unwrap();
        assert!(result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::Coordinates
        );

        let mut invalid_context = CommandContext::new(
            "Alex",
            vec!["extra".to_owned()],
            PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let invalid_result = run(registry.execute("coords", &mut invalid_context)).unwrap();
        assert!(!invalid_result.success);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn mine_command_requires_admin_and_validates_block_names() {
        let registry = CommandRegistry::default();
        let (sender, receiver) = mpsc::channel();
        register_mining_commands(&registry, sender).unwrap();

        let mut guest_context = CommandContext::new(
            "Alex",
            vec!["diamond_ore".to_owned()],
            PermissionLevel::Guest,
            false,
            |_| {},
            |_| {},
        );
        let guest_result = run(registry.execute("mine", &mut guest_context)).unwrap();
        assert!(!guest_result.success);
        assert!(receiver.try_recv().is_err());

        let mut admin_context = CommandContext::new(
            "Alex",
            vec!["minecraft:diamond_ore".to_owned()],
            PermissionLevel::Admin,
            false,
            |_| {},
            |_| {},
        );
        let admin_result = run(registry.execute("mine", &mut admin_context)).unwrap();
        assert!(admin_result.success);
        assert_eq!(
            receiver.try_recv().unwrap(),
            RuntimeCommandAction::MineBlock {
                name: "diamond_ore".to_owned(),
            }
        );

        let mut invalid_context = CommandContext::new(
            "Alex",
            vec!["not_a_block".to_owned()],
            PermissionLevel::Admin,
            false,
            |_| {},
            |_| {},
        );
        let invalid_result = run(registry.execute("mine", &mut invalid_context)).unwrap();
        assert!(!invalid_result.success);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn runtime_uses_application_prefix_and_authenticates_admin_private_messages() {
        use crate::{
            command_registry::CommandDefinition,
            commands::{PermissionConfig, PermissionLevel},
        };
        use std::sync::Arc;

        let app_config = AppConfig::from_values(&std::collections::HashMap::from([
            ("PREFIX".to_owned(), ":".to_owned()),
            ("ADMIN_PASSWORD".to_owned(), "secret".to_owned()),
        ]))
        .unwrap();
        let mut runtime = MinecraftRuntime::from_app_config(app_config);

        let login = run(runtime.dispatch_chat_command(Some("Alex"), "$loginadmin secret", true))
            .unwrap()
            .unwrap();
        assert_eq!(login.replies[0].message, "✅ Admin login successful");
        assert!(matches!(
            login.replies[0].destination,
            ReplyDestination::Private
        ));
        assert_eq!(
            runtime.permissions.permission_level("Alex"),
            crate::commands::PermissionLevel::Admin
        );

        let mut protected_command = CommandDefinition::new(
            "secure",
            "Admin-only test command",
            Arc::new(|context, _| {
                Box::pin(async move {
                    context.reply("authorized");
                    Ok(())
                })
            }),
        );
        protected_command.permission = Some(PermissionConfig {
            level: PermissionLevel::Admin,
            ..PermissionConfig::default()
        });
        runtime
            .command_registry()
            .register(protected_command)
            .unwrap();

        let dispatch = run(runtime.dispatch_chat_command(Some("Alex"), ":secure", false))
            .unwrap()
            .unwrap();

        let MinecraftRuntimeEvent::CommandExecuted {
            command, result, ..
        } = dispatch.event
        else {
            panic!("expected command execution event");
        };
        assert_eq!(command, "secure");
        assert!(result.success);
        assert_eq!(dispatch.replies[0].message, "authorized");
    }
}
