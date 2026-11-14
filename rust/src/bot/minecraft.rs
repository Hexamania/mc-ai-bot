use std::{str::FromStr, time::Duration};

use azalea::{
    auto_tool::AutoToolClientExt,
    blocks::{Block as BlockTrait, BlockState, BlockStates},
    ecs::query::With,
    entity::{metadata::Player, Position},
    inventory::SetSelectedHotbarSlotEvent,
    pathfinder::{
        goals::{Goal, RadiusGoal, ReachBlockPosGoal},
        PathfinderClientExt,
    },
    registry::Block as RegistryBlock,
    GameProfileComponent, Vec3,
};
use azalea::{mining::StopMiningBlockEvent, Account, BotClientExt, Client, Event};
use rand::Rng;
use thiserror::Error;
use tokio::{sync::mpsc::UnboundedReceiver, task::JoinHandle, time::sleep};

use crate::{
    bot::inventory::InventorySnapshot,
    bot::state_machine::{BotState, InvalidTransition, StateMachine},
    config::BotConfig,
};

pub const SUPPORTED_MINECRAFT_VERSION: &str = "1.21.1";
pub(crate) const MAX_WORLD_COORDINATE: f64 = 29_999_984.0;
pub(crate) const MAX_SUPPORTED_Y_COORDINATE: f64 = 2_048.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MinecraftEvent {
    Login,
    Chat {
        username: Option<String>,
        message: String,
        is_whisper: bool,
    },
    PlayerJoined(String),
    PlayerLeft(String),
    Death,
    Disconnected {
        reason: Option<String>,
    },
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum MinecraftTransportError {
    #[error("Minecraft host is required")]
    MissingHost,
    #[error("Minecraft port must be between 1 and 65535")]
    InvalidPort,
    #[error("Minecraft username is required")]
    MissingUsername,
    #[error("Minecraft version {0} is unsupported; this transport supports 1.21.1")]
    UnsupportedVersion(String),
    #[error("Authentication mode {0} is unsupported; use offline or microsoft")]
    UnsupportedAuthentication(String),
    #[error("Minecraft authentication failed: {0}")]
    Authentication(String),
    #[error("Minecraft connection failed: {0}")]
    Connection(String),
    #[error("Bot is not connected")]
    NotConnected,
    #[error("Invalid bot state transition: {0}")]
    StateTransition(#[from] InvalidTransition),
}

pub struct MinecraftConnection {
    client: Client,
    events: UnboundedReceiver<Event>,
    state_machine: StateMachine,
    follow_target: Option<String>,
    follow_task: Option<JoinHandle<()>>,
    roam_task: Option<JoinHandle<()>>,
    mining_task: Option<JoinHandle<()>>,
}

impl MinecraftConnection {
    pub async fn connect(config: &BotConfig) -> Result<Self, MinecraftTransportError> {
        validate_config(config)?;

        let mut state_machine = StateMachine::default();
        state_machine.transition(BotState::Connecting)?;
        let account = match config.auth.trim().to_ascii_lowercase().as_str() {
            "offline" => Account::offline(config.username.trim()),
            "microsoft" => match Account::microsoft(config.username.trim()).await {
                Ok(account) => account,
                Err(error) => {
                    state_machine.transition(BotState::Error)?;
                    return Err(MinecraftTransportError::Authentication(error.to_string()));
                }
            },
            authentication => {
                state_machine.transition(BotState::Error)?;
                return Err(MinecraftTransportError::UnsupportedAuthentication(
                    authentication.to_owned(),
                ));
            }
        };
        let address = server_address(&config.host, config.port);
        let (client, events) = match Client::join(&account, address.as_str()).await {
            Ok(connection) => connection,
            Err(error) => {
                state_machine.transition(BotState::Error)?;
                return Err(MinecraftTransportError::Connection(error.to_string()));
            }
        };
        state_machine.transition(BotState::Connected)?;

        Ok(Self {
            client,
            events,
            state_machine,
            follow_target: None,
            follow_task: None,
            roam_task: None,
            mining_task: None,
        })
    }

    pub fn state(&self) -> BotState {
        self.state_machine.state()
    }

    pub fn username(&self) -> &str {
        &self.client.profile.name
    }

    pub fn inventory_snapshot(&self) -> Result<InventorySnapshot, MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        let inventory = self.client.component::<azalea::inventory::Inventory>();
        Ok(InventorySnapshot::from_player(
            inventory.inventory_menu.as_player(),
            inventory.selected_hotbar_slot,
        ))
    }

    pub fn following_target(&self) -> Option<&str> {
        self.follow_task
            .as_ref()
            .filter(|task| !task.is_finished())
            .and(self.follow_target.as_deref())
    }

    pub fn start_following(
        &mut self,
        target: &str,
        range: f64,
    ) -> Result<bool, MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        let target = target.trim();
        if target.is_empty()
            || target.eq_ignore_ascii_case(self.username())
            || !range.is_finite()
            || range <= 0.0
        {
            return Ok(false);
        }

        let mut follow_client = self.client.clone();
        let Some(position) = player_position(&mut follow_client, target) else {
            return Ok(false);
        };
        if distance_squared(follow_client.position(), position) > 50.0_f64.powi(2) {
            return Ok(false);
        }

        self.stop_mining();
        self.stop_roaming();
        self.stop_following();
        follow_client.goto_without_mining(RadiusGoal {
            pos: position,
            radius: range as f32,
        });

        let target = target.to_owned();
        let task_target = target.clone();
        let task = tokio::spawn(async move {
            loop {
                sleep(Duration::from_secs(2)).await;
                let Some(position) = player_position(&mut follow_client, &task_target) else {
                    follow_client.stop_pathfinding();
                    break;
                };
                if distance_squared(follow_client.position(), position) > 50.0_f64.powi(2) {
                    follow_client.stop_pathfinding();
                    break;
                }
                follow_client.goto_without_mining(RadiusGoal {
                    pos: position,
                    radius: range as f32,
                });
            }
        });
        self.follow_target = Some(target);
        self.follow_task = Some(task);
        Ok(true)
    }

    pub fn start_roaming(
        &mut self,
        radius: u32,
        update_interval: Duration,
    ) -> Result<bool, MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        if !(1..=50).contains(&radius)
            || update_interval < Duration::from_secs(1)
            || update_interval > Duration::from_secs(60)
        {
            return Ok(false);
        }
        if self
            .roam_task
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            return Ok(false);
        }

        self.stop_mining();
        self.stop_following();
        self.stop_roaming();
        let mut roam_client = self.client.clone();
        let goal = roam_goal(roam_client.position(), radius);
        roam_client.goto_without_mining(goal);

        self.roam_task = Some(tokio::spawn(async move {
            loop {
                sleep(update_interval).await;
                let goal = roam_goal(roam_client.position(), radius);
                roam_client.goto_without_mining(goal);
            }
        }));
        Ok(true)
    }

    pub fn stop_roaming(&mut self) -> bool {
        let was_active = self.roam_task.take().is_some_and(|task| {
            let active = !task.is_finished();
            task.abort();
            active
        });
        if was_active && self.state() == BotState::Connected {
            self.client.stop_pathfinding();
        }
        was_active
    }

    pub fn move_to_position(
        &mut self,
        x: f64,
        y: f64,
        z: f64,
        range: f64,
    ) -> Result<bool, MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        if !x.is_finite()
            || !y.is_finite()
            || !z.is_finite()
            || x.abs() > MAX_WORLD_COORDINATE
            || z.abs() > MAX_WORLD_COORDINATE
            || y.abs() > MAX_SUPPORTED_Y_COORDINATE
            || !range.is_finite()
            || !(0.5..=50.0).contains(&range)
        {
            return Ok(false);
        }

        self.stop_mining();
        self.stop_following();
        self.stop_roaming();
        self.client.goto_without_mining(RadiusGoal {
            pos: Vec3::new(x, y, z),
            radius: range as f32,
        });
        Ok(true)
    }

    pub fn start_mining_block(
        &mut self,
        block_name: &str,
        requester: &str,
    ) -> Result<bool, MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        let Some(block) = parse_mineable_block(block_name) else {
            return Ok(false);
        };
        if self
            .mining_task
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            return Ok(false);
        }

        let block_states = BlockStates::from(block);
        let world = self.client.world();
        let world = world.read();
        let position = self.client.position();
        let Some((target, _)) = world
            .find_blocks(position, &block_states)
            .filter_map(|target| {
                if distance_squared(position, target.center()) > 32.0_f64.powi(2) {
                    return None;
                }
                let state = world.get_block_state(&target)?;
                let behavior = Box::<dyn BlockTrait>::from(state).behavior();
                (state != BlockState::AIR && behavior.destroy_time >= 0.0)
                    .then_some((target, state))
            })
            .min_by(|(first, _), (second, _)| {
                distance_squared(position, first.center())
                    .total_cmp(&distance_squared(position, second.center()))
            })
        else {
            return Ok(false);
        };
        let chunk_storage = world.chunks.clone();
        drop(world);

        self.stop_following();
        self.stop_roaming();

        let mut client = self.client.clone();
        let block_id = block.to_string();
        let block_name = block_id
            .strip_prefix("minecraft:")
            .unwrap_or(&block_id)
            .to_owned();
        let requester = requester.to_owned();
        self.mining_task = Some(tokio::spawn(async move {
            let result = mine_block_task(&mut client, target, block, chunk_storage).await;
            let message = match result {
                Ok(()) => format!("⛏️ Mined {block_name}."),
                Err(error) => format!("❌ Could not mine {block_name}: {error}"),
            };
            client.chat(&format!("/msg {requester} {message}"));
        }));
        Ok(true)
    }

    pub fn stop_mining(&mut self) -> bool {
        let Some(task) = self.mining_task.take() else {
            return false;
        };
        if task.is_finished() {
            return false;
        }

        stop_active_mining(&self.client);
        self.client.stop_pathfinding();
        task.abort();
        true
    }

    pub fn stop_movement(&mut self) {
        self.stop_mining();
        self.stop_following();
        self.stop_roaming();
        if self.state() == BotState::Connected {
            self.client.stop_pathfinding();
        }
    }

    pub fn stop_following(&mut self) -> Option<String> {
        let was_active = if let Some(task) = self.follow_task.take() {
            let active = !task.is_finished();
            task.abort();
            active
        } else {
            false
        };
        let target = self.follow_target.take();
        if was_active && self.state() == BotState::Connected {
            self.client.stop_pathfinding();
        }
        was_active.then_some(target).flatten()
    }

    pub fn send_chat(&self, message: &str) -> Result<(), MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        self.client.chat(message);
        Ok(())
    }

    pub fn disconnect(&mut self) -> Result<(), MinecraftTransportError> {
        if self.state() == BotState::Connected {
            self.stop_mining();
            self.client.disconnect();
            self.state_machine.transition(BotState::Disconnected)?;
        }
        Ok(())
    }

    pub async fn next_event(&mut self) -> Result<Option<MinecraftEvent>, MinecraftTransportError> {
        while let Some(event) = self.events.recv().await {
            let event = match event {
                Event::Login => Some(MinecraftEvent::Login),
                Event::Chat(packet) => {
                    let (username, message) = packet.split_sender_and_content();
                    Some(MinecraftEvent::Chat {
                        username,
                        message,
                        is_whisper: packet.is_whisper(),
                    })
                }
                Event::AddPlayer(player) => {
                    Some(MinecraftEvent::PlayerJoined(player.profile.name.clone()))
                }
                Event::RemovePlayer(player) => {
                    let username = player.profile.name.clone();
                    if self
                        .follow_target
                        .as_deref()
                        .is_some_and(|target| target.eq_ignore_ascii_case(&username))
                    {
                        self.stop_following();
                    }
                    Some(MinecraftEvent::PlayerLeft(username))
                }
                Event::Death(_) => {
                    self.stop_mining();
                    self.stop_following();
                    self.stop_roaming();
                    Some(MinecraftEvent::Death)
                }
                Event::Disconnect(reason) => {
                    self.stop_mining();
                    self.stop_following();
                    self.stop_roaming();
                    self.state_machine.transition(BotState::Disconnected)?;
                    Some(MinecraftEvent::Disconnected {
                        reason: reason.map(|message| message.to_string()),
                    })
                }
                _ => None,
            };
            if event.is_some() {
                return Ok(event);
            }
        }

        self.stop_following();
        self.stop_roaming();
        self.stop_mining();
        if self.state() != BotState::Disconnected {
            self.state_machine.transition(BotState::Disconnected)?;
        }
        Ok(None)
    }
}

impl Drop for MinecraftConnection {
    fn drop(&mut self) {
        if let Some(task) = self.follow_task.take() {
            task.abort();
        }
        if let Some(task) = self.roam_task.take() {
            task.abort();
        }
        self.stop_mining();
        if self.state() == BotState::Connected {
            self.client.disconnect();
        }
    }
}

pub(crate) fn parse_mineable_block(name: &str) -> Option<RegistryBlock> {
    let name = name.trim().to_ascii_lowercase();
    let name = name.strip_prefix("minecraft:").unwrap_or(&name);
    let block = RegistryBlock::from_str(&format!("minecraft:{}", name.replace(' ', "_"))).ok()?;
    (!matches!(
        block,
        RegistryBlock::Air | RegistryBlock::CaveAir | RegistryBlock::VoidAir
    ))
    .then_some(block)
}

async fn mine_block_task(
    client: &mut Client,
    target: azalea::BlockPos,
    expected_block: RegistryBlock,
    chunk_storage: azalea::world::ChunkStorage,
) -> Result<(), &'static str> {
    let goal = ReachBlockPosGoal {
        pos: target,
        chunk_storage: chunk_storage.clone(),
    };
    client.goto_without_mining(ReachBlockPosGoal {
        pos: target,
        chunk_storage: chunk_storage.clone(),
    });

    let mut ticks = client.get_tick_broadcaster();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if goal.success(azalea::BlockPos::from(client.position())) {
            break;
        }
        match tokio::time::timeout_at(deadline, ticks.recv()).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => {
                client.stop_pathfinding();
                return Err("connection ended while approaching the target");
            }
            Err(_) => {
                client.stop_pathfinding();
                return Err("target is out of reach");
            }
        }
    }

    client.stop_pathfinding();
    let world = client.world();
    let world = world.read();
    let Some(state) = world.get_block_state(&target) else {
        return Err("target is no longer loaded");
    };
    if state.is_air()
        || RegistryBlock::from(state) != expected_block
        || Box::<dyn BlockTrait>::from(state).behavior().destroy_time < 0.0
    {
        return Err("target is no longer breakable");
    }
    drop(world);

    let best_tool = client.best_tool_in_hotbar_for_block(state);
    if best_tool.percentage_per_tick <= 0.0 {
        return Err("no suitable tool is available in the hotbar");
    }
    client.ecs.lock().send_event(SetSelectedHotbarSlotEvent {
        entity: client.entity,
        slot: best_tool.index as u8,
    });
    client.look_at(target.center());
    let mut ticks = client.get_tick_broadcaster();
    match tokio::time::timeout(Duration::from_secs(2), ticks.recv()).await {
        Ok(Ok(())) => {}
        _ => return Err("could not prepare the bot to mine"),
    }
    if tokio::time::timeout(Duration::from_secs(30), client.mine(target))
        .await
        .is_err()
    {
        stop_active_mining(client);
        return Err("mining timed out");
    }
    Ok(())
}

fn stop_active_mining(client: &Client) {
    let mut ecs = client.ecs.lock();
    if ecs.get::<azalea::mining::Mining>(client.entity).is_some() {
        ecs.send_event(StopMiningBlockEvent {
            entity: client.entity,
        });
    }
}

fn player_position(client: &mut Client, username: &str) -> Option<Vec3> {
    let entity = client.entity_by::<With<Player>, &GameProfileComponent>(
        |profile: &&GameProfileComponent| profile.name.eq_ignore_ascii_case(username),
    )?;
    let position: Position = client.get_entity_component(entity)?;
    Some(Vec3::from(&position))
}

fn distance_squared(first: Vec3, second: Vec3) -> f64 {
    let dx = first.x - second.x;
    let dy = first.y - second.y;
    let dz = first.z - second.z;
    dx * dx + dy * dy + dz * dz
}

fn roam_goal(position: Vec3, radius: u32) -> RadiusGoal {
    let mut random = rand::thread_rng();
    let radius = radius as i32;
    let x = position.x.floor() as i32 + random.gen_range(-radius..=radius);
    let z = position.z.floor() as i32 + random.gen_range(-radius..=radius);
    RadiusGoal {
        pos: Vec3::new(x as f64, position.y.floor(), z as f64),
        radius: 1.0,
    }
}

pub fn validate_config(config: &BotConfig) -> Result<(), MinecraftTransportError> {
    if config.host.trim().is_empty() {
        return Err(MinecraftTransportError::MissingHost);
    }
    if config.port == 0 {
        return Err(MinecraftTransportError::InvalidPort);
    }
    if config.username.trim().is_empty() {
        return Err(MinecraftTransportError::MissingUsername);
    }
    if config.version.trim() != SUPPORTED_MINECRAFT_VERSION {
        return Err(MinecraftTransportError::UnsupportedVersion(
            config.version.clone(),
        ));
    }
    if !matches!(
        config.auth.trim().to_ascii_lowercase().as_str(),
        "offline" | "microsoft"
    ) {
        return Err(MinecraftTransportError::UnsupportedAuthentication(
            config.auth.clone(),
        ));
    }
    Ok(())
}

fn server_address(host: &str, port: u16) -> String {
    let host = host.trim();
    if host.starts_with('[') && host.ends_with(']') {
        format!("{host}:{port}")
    } else if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_config() -> BotConfig {
        BotConfig {
            host: "localhost".to_owned(),
            port: 25565,
            username: "Airi".to_owned(),
            password: None,
            version: SUPPORTED_MINECRAFT_VERSION.to_owned(),
            auth: "offline".to_owned(),
            check_timeout_interval: 60_000,
        }
    }

    #[test]
    fn accepts_the_supported_protocol_and_authentication_modes() {
        assert_eq!(validate_config(&default_config()), Ok(()));
        let mut config = default_config();
        config.auth = "microsoft".to_owned();
        assert_eq!(validate_config(&config), Ok(()));
    }

    #[test]
    fn rejects_missing_connection_values_and_unsupported_protocols() {
        let mut config = default_config();
        config.host.clear();
        assert_eq!(
            validate_config(&config),
            Err(MinecraftTransportError::MissingHost)
        );

        let mut config = default_config();
        config.port = 0;
        assert_eq!(
            validate_config(&config),
            Err(MinecraftTransportError::InvalidPort)
        );

        let mut config = default_config();
        config.username = "  ".to_owned();
        assert_eq!(
            validate_config(&config),
            Err(MinecraftTransportError::MissingUsername)
        );

        let mut config = default_config();
        config.version = "1.20.4".to_owned();
        assert_eq!(
            validate_config(&config),
            Err(MinecraftTransportError::UnsupportedVersion(
                "1.20.4".to_owned()
            ))
        );
    }

    #[test]
    fn rejects_unsupported_authentication_without_connecting() {
        let mut config = default_config();
        config.auth = "mojang".to_owned();
        assert_eq!(
            validate_config(&config),
            Err(MinecraftTransportError::UnsupportedAuthentication(
                "mojang".to_owned()
            ))
        );
    }

    #[test]
    fn formats_ipv6_server_addresses_without_ambiguous_colons() {
        assert_eq!(server_address("::1", 25565), "[::1]:25565");
        assert_eq!(server_address("[::1]", 25565), "[::1]:25565");
        assert_eq!(server_address("localhost", 25565), "localhost:25565");
    }

    #[test]
    fn roam_goals_stay_within_horizontal_radius_and_preserve_height() {
        let origin = Vec3::new(0.9, 64.5, -4.4);
        for _ in 0..100 {
            let goal = roam_goal(origin, 3);
            assert!((goal.pos.x as i32).abs() <= 3);
            assert!((goal.pos.z as i32 + 5).abs() <= 3);
            assert_eq!(goal.pos.y, 64.0);
            assert_eq!(goal.radius, 1.0);
        }
    }

    #[test]
    fn mineable_block_names_accept_namespaced_and_case_insensitive_ids() {
        assert_eq!(parse_mineable_block("Stone"), Some(RegistryBlock::Stone));
        assert_eq!(
            parse_mineable_block("minecraft:diamond_ore"),
            Some(RegistryBlock::DiamondOre)
        );
        assert_eq!(parse_mineable_block("not_a_block"), None);
        assert_eq!(parse_mineable_block("air"), None);
    }
}
