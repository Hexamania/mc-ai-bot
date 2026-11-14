use std::{sync::mpsc, time::Duration};

use thiserror::Error;
use tokio::time::sleep;

use crate::{
    arguments::{ArgumentConstraint, ArgumentDefinition, ArgumentType, ArgumentValue},
    bot::minecraft::MinecraftEvent::Chat,
    bot::{
        minecraft::{
            parse_mineable_block, MinecraftConnection, MinecraftEvent, MinecraftTransportError,
            MAX_SUPPORTED_Y_COORDINATE, MAX_WORLD_COORDINATE,
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
            .and_then(|_| register_mining_commands(&command_registry, action_sender))
            .err()
            .map(MinecraftRuntimeError::CommandRegistry);

        let mut permissions = PermissionManager::default();
        if let Some(password) = admin_password {
            permissions.set_admin_password(password);
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
                Ok(connection) => {
                    self.chat_parser
                        .set_bot_username(Some(connection.username().to_owned()));
                    self.state_machine.transition(BotState::Connected)?;
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
                        )
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
    inventory.arguments = vec![ArgumentDefinition::new("slot", ArgumentType::Number, false)
        .with_constraint(ArgumentConstraint::Integer)
        .with_constraint(ArgumentConstraint::Minimum(0.0))
        .with_constraint(ArgumentConstraint::Maximum(35.0))];
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
