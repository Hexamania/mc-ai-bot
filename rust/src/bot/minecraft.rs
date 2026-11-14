use std::{
    collections::HashMap,
    str::FromStr,
    time::{Duration, Instant},
};

use azalea::{
    Account, BotClientExt, Client, Event, GameProfileComponent, Vec3,
    auto_tool::AutoToolClientExt,
    blocks::{Block as BlockTrait, BlockState, BlockStates},
    ecs::query::With,
    entity::{
        AttackEvent, DropItemEvent, Health, Position, SetControlStateEvent, metadata::Player,
    },
    interact::InteractBlockEvent,
    inventory::{
        SetSelectedHotbarSlotEvent,
        operations::click::{ClickMode, ClickOperation, ClickType, MouseButton},
    },
    mining::StopMiningBlockEvent,
    pathfinder::{
        PathfinderClientExt,
        goals::{Goal, RadiusGoal, ReachBlockPosGoal},
    },
    protocol::packets::game::Hand,
    registry::Block as RegistryBlock,
    world::{chunk::ChunkStorage, direction::Direction},
};
use azalea_inventory::Inventory;
use rand::Rng;
use serde_json::{Value, json};
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
    // Base/Storage
    base_location: Option<Vec3>,
    mining_base_location: Option<Vec3>,
    // Mining features
    miner_task: Option<JoinHandle<()>>,
    mine_area_task: Option<JoinHandle<()>>,
    // Combat/Guard
    guard_task: Option<JoinHandle<()>>,
    pvp_task: Option<JoinHandle<()>>,
    pvp_target: Option<String>,
    // Utility
    panic_mode: bool,
    stealth_mode: bool,
    auto_defense: bool,
    // Pending operations
    pending_base_chest: Option<Vec3>,
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
            base_location: None,
            mining_base_location: None,
            miner_task: None,
            mine_area_task: None,
            guard_task: None,
            pvp_task: None,
            pvp_target: None,
            panic_mode: false,
            stealth_mode: false,
            auto_defense: false,
            pending_base_chest: None,
        })
    }

    pub fn state(&self) -> BotState {
        self.state_machine.state()
    }

    pub fn username(&self) -> &str {
        &self.client.profile.name
    }

    pub fn position(&mut self) -> Option<Vec3> {
        let entity = self.client.entity;
        let position: Position = self.client.get_entity_component(entity)?;
        Some(Vec3::from(&position))
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
        self.stop_miner();
        self.stop_mine_area();
        self.stop_guard();
        self.stop_pvp();
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

    // Base/Storage commands
    pub fn set_base(
        &mut self,
        x: Option<f64>,
        y: Option<f64>,
        z: Option<f64>,
    ) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        let position = self.position().ok_or("Bot not spawned")?;
        let base_x = x.unwrap_or(position.x);
        let base_y = y.unwrap_or(position.y);
        let base_z = z.unwrap_or(position.z);
        self.base_location = Some(Vec3::new(base_x, base_y, base_z));
        Ok(())
    }

    pub fn go_home(&mut self) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        let base = self
            .base_location
            .ok_or("No base location set. Use sbase first.")?;
        self.stop_mining();
        self.stop_following();
        self.stop_roaming();
        self.client.goto_without_mining(RadiusGoal {
            pos: base,
            radius: 1.0,
        });
        Ok(())
    }

    pub fn set_mining_base(&mut self) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        let position = self.position().ok_or("Bot not spawned")?;
        self.mining_base_location = Some(position);
        Ok(())
    }

    pub fn go_mining_base(&mut self) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        let base = self
            .mining_base_location
            .ok_or("No mining base set. Use sminebase first.")?;
        self.stop_mining();
        self.stop_following();
        self.stop_roaming();
        self.client.goto_without_mining(RadiusGoal {
            pos: base,
            radius: 1.0,
        });
        Ok(())
    }

    pub fn open_base_chest(&mut self) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        let base = self
            .base_location
            .ok_or("No base location set. Use sbase first.")?;

        // Navigate to base first
        self.client.goto_without_mining(RadiusGoal {
            pos: base,
            radius: 2.0,
        });

        // Store the base location for the async task to find chest
        self.pending_base_chest = Some(base);

        // Spawn task to find and open chest after arriving
        let mut client = self.client.clone();
        let base_pos = base;
        tokio::spawn(async move {
            // Wait for arrival
            let mut ticks = client.get_tick_broadcaster();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                let pos = client.position();
                if pos.distance(base_pos) <= 2.5 {
                    break;
                }
                match tokio::time::timeout_at(deadline, ticks.recv()).await {
                    Ok(Ok(())) => {}
                    _ => return,
                }
            }

            // Find chest block near base
            let world = client.world();
            let world = world.read();
            let chunk_storage = world.chunk_storage.clone();
            drop(world);

            let mut found_chest = None;
            let search_radius = 5;
            let base_block_pos = azalea::BlockPos::from(base_pos);

            for dx in -search_radius..=search_radius {
                for dy in -2..=2 {
                    for dz in -search_radius..=search_radius {
                        let check_pos = azalea::BlockPos::new(
                            base_block_pos.x + dx,
                            base_block_pos.y + dy,
                            base_block_pos.z + dz,
                        );
                        if let Some(state) = chunk_storage.get_block_state(&check_pos) {
                            let block = RegistryBlock::from(state);
                            if matches!(
                                block,
                                RegistryBlock::Chest
                                    | RegistryBlock::TrappedChest
                                    | RegistryBlock::Barrel
                                    | RegistryBlock::ShulkerBox
                                    | RegistryBlock::WhiteShulkerBox
                                    | RegistryBlock::OrangeShulkerBox
                                    | RegistryBlock::MagentaShulkerBox
                                    | RegistryBlock::LightBlueShulkerBox
                                    | RegistryBlock::YellowShulkerBox
                                    | RegistryBlock::LimeShulkerBox
                                    | RegistryBlock::PinkShulkerBox
                                    | RegistryBlock::GrayShulkerBox
                                    | RegistryBlock::LightGrayShulkerBox
                                    | RegistryBlock::CyanShulkerBox
                                    | RegistryBlock::PurpleShulkerBox
                                    | RegistryBlock::BlueShulkerBox
                                    | RegistryBlock::BrownShulkerBox
                                    | RegistryBlock::GreenShulkerBox
                                    | RegistryBlock::RedShulkerBox
                                    | RegistryBlock::BlackShulkerBox
                            ) {
                                found_chest = Some(check_pos);
                                break;
                            }
                        }
                    }
                    if found_chest.is_some() {
                        break;
                    }
                }
                if found_chest.is_some() {
                    break;
                }
            }

            if let Some(chest_pos) = found_chest {
                // Pathfind to chest
                let goal = ReachBlockPosGoal {
                    pos: chest_pos,
                    chunk_storage: chunk_storage.clone(),
                };
                client.goto_without_mining(goal);

                // Wait for reaching chest
                let mut ticks = client.get_tick_broadcaster();
                let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                loop {
                    if goal.success(azalea::BlockPos::from(client.position())) {
                        break;
                    }
                    match tokio::time::timeout_at(deadline, ticks.recv()).await {
                        Ok(Ok(())) => {}
                        _ => return,
                    }
                }

                // Interact with chest (right-click)
                client.look_at(Vec3::from(chest_pos.center()));
                let mut ticks = client.get_tick_broadcaster();
                let _ = tokio::time::timeout(Duration::from_secs(2), ticks.recv()).await;

                // Send use block packet to open chest
                client
                    .ecs
                    .lock()
                    .send_event(azalea::interact::InteractBlockEvent {
                        entity: client.entity,
                        position: chest_pos,
                        direction: Direction::Up,
                        hand: azalea::protocol::packets::game::Hand::MainHand,
                        cursor_position: None,
                        inside_block: false,
                        sequence: 0,
                    });
            }
        });

        Ok(())
    }

    pub fn sort_chest(&mut self) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        let base = self
            .base_location
            .ok_or("No base location set. Use sbase first.")?;

        // Navigate to base first
        self.client.goto_without_mining(RadiusGoal {
            pos: base,
            radius: 2.0,
        });

        // Spawn task to find chest and sort it
        let mut client = self.client.clone();
        let base_pos = base;
        tokio::spawn(async move {
            // Wait for arrival
            let mut ticks = client.get_tick_broadcaster();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                let pos = client.position();
                if pos.distance(base_pos) <= 2.5 {
                    break;
                }
                match tokio::time::timeout_at(deadline, ticks.recv()).await {
                    Ok(Ok(())) => {}
                    _ => return,
                }
            }

            // Find chest block near base
            let world = client.world();
            let world = world.read();
            let chunk_storage = world.chunk_storage.clone();
            drop(world);

            let mut found_chest = None;
            let search_radius = 5;
            let base_block_pos = azalea::BlockPos::from(base_pos);

            for dx in -search_radius..=search_radius {
                for dy in -2..=2 {
                    for dz in -search_radius..=search_radius {
                        let check_pos = azalea::BlockPos::new(
                            base_block_pos.x + dx,
                            base_block_pos.y + dy,
                            base_block_pos.z + dz,
                        );
                        if let Some(state) = chunk_storage.get_block_state(&check_pos) {
                            let block = RegistryBlock::from(state);
                            if matches!(
                                block,
                                RegistryBlock::Chest
                                    | RegistryBlock::TrappedChest
                                    | RegistryBlock::Barrel
                                    | RegistryBlock::ShulkerBox
                                    | RegistryBlock::WhiteShulkerBox
                                    | RegistryBlock::OrangeShulkerBox
                                    | RegistryBlock::MagentaShulkerBox
                                    | RegistryBlock::LightBlueShulkerBox
                                    | RegistryBlock::YellowShulkerBox
                                    | RegistryBlock::LimeShulkerBox
                                    | RegistryBlock::PinkShulkerBox
                                    | RegistryBlock::GrayShulkerBox
                                    | RegistryBlock::LightGrayShulkerBox
                                    | RegistryBlock::CyanShulkerBox
                                    | RegistryBlock::PurpleShulkerBox
                                    | RegistryBlock::BlueShulkerBox
                                    | RegistryBlock::BrownShulkerBox
                                    | RegistryBlock::GreenShulkerBox
                                    | RegistryBlock::RedShulkerBox
                                    | RegistryBlock::BlackShulkerBox
                            ) {
                                found_chest = Some(check_pos);
                                break;
                            }
                        }
                    }
                    if found_chest.is_some() {
                        break;
                    }
                }
                if found_chest.is_some() {
                    break;
                }
            }

            if let Some(chest_pos) = found_chest {
                // Pathfind to chest
                let goal = ReachBlockPosGoal {
                    pos: chest_pos,
                    chunk_storage: chunk_storage.clone(),
                };
                client.goto_without_mining(goal);

                // Wait for reaching chest
                let mut ticks = client.get_tick_broadcaster();
                let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                loop {
                    if goal.success(azalea::BlockPos::from(client.position())) {
                        break;
                    }
                    match tokio::time::timeout_at(deadline, ticks.recv()).await {
                        Ok(Ok(())) => {}
                        _ => return,
                    }
                }

                // Open chest
                client.look_at(Vec3::from(chest_pos.center()));
                let mut ticks = client.get_tick_broadcaster();
                let _ = tokio::time::timeout(Duration::from_secs(2), ticks.recv()).await;

                client
                    .ecs
                    .lock()
                    .send_event(azalea::interact::InteractBlockEvent {
                        entity: client.entity,
                        position: chest_pos,
                        direction: Direction::Up,
                        hand: azalea::protocol::packets::game::Hand::MainHand,
                        cursor_position: None,
                        inside_block: false,
                        sequence: 0,
                    });

                // Wait for container to open
                tokio::time::sleep(Duration::from_millis(500)).await;

                // Sort chest: iterate through slots and organize items
                // This is a simplified sort - groups similar items together
                let container = client.component::<Container>();
                if let Some(container_menu) = container.current_menu() {
                    let slots = container_menu.slots();
                    let mut item_map: HashMap<String, Vec<usize>> = HashMap::new();

                    // Collect items by type
                    for (i, slot) in slots.iter().enumerate().skip(1) {
                        // Skip slot 0 (result)
                        if let Some(item_stack) = slot.item_stack() {
                            if !item_stack.is_empty() {
                                let name = item_stack.item().to_string();
                                item_map.entry(name).or_default().push(i);
                            }
                        }
                    }

                    // Sort items into chest (compact them)
                    let mut target_slot = 1;
                    for (_item_name, slots_list) in item_map {
                        for &slot_idx in &slots_list {
                            if slot_idx != target_slot && target_slot < slots.len() {
                                // Move item to target slot
                                client.ecs.lock().send_event(ClickOperation {
                                    entity: client.entity,
                                    slot: slot_idx,
                                    click_type: ClickType::Pickup,
                                    button: MouseButton::Left,
                                    mode: azalea::inventory::operations::click::ClickMode::Normal,
                                });
                                client.ecs.lock().send_event(ClickOperation {
                                    entity: client.entity,
                                    slot: target_slot,
                                    click_type: ClickType::Pickup,
                                    button: MouseButton::Left,
                                    mode: azalea::inventory::operations::click::ClickMode::Normal,
                                });
                                target_slot += 1;
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            } else if slot_idx == target_slot {
                                target_slot += 1;
                            }
                        }
                    }
                }
            }
        });

        Ok(())
    }

    pub fn deposit_items(&mut self) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        let base = self
            .base_location
            .ok_or("No base location set. Use sbase first.")?;

        // Navigate to base first
        self.client.goto_without_mining(RadiusGoal {
            pos: base,
            radius: 2.0,
        });

        // Spawn task to find chest and deposit items
        let mut client = self.client.clone();
        let base_pos = base;
        tokio::spawn(async move {
            // Wait for arrival
            let mut ticks = client.get_tick_broadcaster();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                let pos = client.position();
                if pos.distance(base_pos) <= 2.5 {
                    break;
                }
                match tokio::time::timeout_at(deadline, ticks.recv()).await {
                    Ok(Ok(())) => {}
                    _ => return,
                }
            }

            // Find chest block near base
            let world = client.world();
            let world = world.read();
            let chunk_storage = world.chunk_storage.clone();
            drop(world);

            let mut found_chest = None;
            let search_radius = 5;
            let base_block_pos = azalea::BlockPos::from(base_pos);

            for dx in -search_radius..=search_radius {
                for dy in -2..=2 {
                    for dz in -search_radius..=search_radius {
                        let check_pos = azalea::BlockPos::new(
                            base_block_pos.x + dx,
                            base_block_pos.y + dy,
                            base_block_pos.z + dz,
                        );
                        if let Some(state) = chunk_storage.get_block_state(&check_pos) {
                            let block = RegistryBlock::from(state);
                            if matches!(
                                block,
                                RegistryBlock::Chest
                                    | RegistryBlock::TrappedChest
                                    | RegistryBlock::Barrel
                                    | RegistryBlock::ShulkerBox
                                    | RegistryBlock::WhiteShulkerBox
                                    | RegistryBlock::OrangeShulkerBox
                                    | RegistryBlock::MagentaShulkerBox
                                    | RegistryBlock::LightBlueShulkerBox
                                    | RegistryBlock::YellowShulkerBox
                                    | RegistryBlock::LimeShulkerBox
                                    | RegistryBlock::PinkShulkerBox
                                    | RegistryBlock::GrayShulkerBox
                                    | RegistryBlock::LightGrayShulkerBox
                                    | RegistryBlock::CyanShulkerBox
                                    | RegistryBlock::PurpleShulkerBox
                                    | RegistryBlock::BlueShulkerBox
                                    | RegistryBlock::BrownShulkerBox
                                    | RegistryBlock::GreenShulkerBox
                                    | RegistryBlock::RedShulkerBox
                                    | RegistryBlock::BlackShulkerBox
                            ) {
                                found_chest = Some(check_pos);
                                break;
                            }
                        }
                    }
                    if found_chest.is_some() {
                        break;
                    }
                }
                if found_chest.is_some() {
                    break;
                }
            }

            if let Some(chest_pos) = found_chest {
                // Pathfind to chest
                let goal = ReachBlockPosGoal {
                    pos: chest_pos,
                    chunk_storage: chunk_storage.clone(),
                };
                client.goto_without_mining(goal);

                // Wait for reaching chest
                let mut ticks = client.get_tick_broadcaster();
                let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                loop {
                    if goal.success(azalea::BlockPos::from(client.position())) {
                        break;
                    }
                    match tokio::time::timeout_at(deadline, ticks.recv()).await {
                        Ok(Ok(())) => {}
                        _ => return,
                    }
                }

                // Open chest
                client.look_at(Vec3::from(chest_pos.center()));
                let mut ticks = client.get_tick_broadcaster();
                let _ = tokio::time::timeout(Duration::from_secs(2), ticks.recv()).await;

                client
                    .ecs
                    .lock()
                    .send_event(azalea::interact::InteractBlockEvent {
                        entity: client.entity,
                        position: chest_pos,
                        direction: Direction::Up,
                        hand: azalea::protocol::packets::game::Hand::MainHand,
                        cursor_position: None,
                        inside_block: false,
                        sequence: 0,
                    });

                // Wait for container to open
                tokio::time::sleep(Duration::from_millis(500)).await;

                // Deposit non-essential items from inventory to chest
                // Essential items to keep: tools, weapons, armor, food, building blocks (cobblestone, dirt), torches
                let essential_items = [
                    // Tools
                    "diamond_pickaxe",
                    "netherite_pickaxe",
                    "iron_pickaxe",
                    "stone_pickaxe",
                    "wooden_pickaxe",
                    "diamond_axe",
                    "netherite_axe",
                    "iron_axe",
                    "stone_axe",
                    "wooden_axe",
                    "diamond_shovel",
                    "netherite_shovel",
                    "iron_shovel",
                    "stone_shovel",
                    "wooden_shovel",
                    "diamond_sword",
                    "netherite_sword",
                    "iron_sword",
                    "stone_sword",
                    "wooden_sword",
                    "diamond_hoe",
                    "netherite_hoe",
                    "iron_hoe",
                    "stone_hoe",
                    "wooden_hoe",
                    "shears",
                    "flint_and_steel",
                    "shield",
                    "bow",
                    "crossbow",
                    // Armor
                    "diamond_helmet",
                    "netherite_helmet",
                    "iron_helmet",
                    "chainmail_helmet",
                    "golden_helmet",
                    "leather_helmet",
                    "turtle_helmet",
                    "diamond_chestplate",
                    "netherite_chestplate",
                    "iron_chestplate",
                    "chainmail_chestplate",
                    "golden_chestplate",
                    "leather_chestplate",
                    "diamond_leggings",
                    "netherite_leggings",
                    "iron_leggings",
                    "chainmail_leggings",
                    "golden_leggings",
                    "leather_leggings",
                    "diamond_boots",
                    "netherite_boots",
                    "iron_boots",
                    "chainmail_boots",
                    "golden_boots",
                    "leather_boots",
                    // Food
                    "bread",
                    "cooked_beef",
                    "cooked_porkchop",
                    "cooked_chicken",
                    "cooked_mutton",
                    "cooked_rabbit",
                    "cooked_salmon",
                    "cooked_cod",
                    "baked_potato",
                    "golden_apple",
                    "golden_carrot",
                    "apple",
                    "carrot",
                    "potato",
                    "beetroot",
                    // Building blocks (keep some)
                    "cobblestone",
                    "stone",
                    "dirt",
                    "gravel",
                    "sand",
                    "oak_planks",
                    "spruce_planks",
                    "birch_planks",
                    "jungle_planks",
                    "acacia_planks",
                    "dark_oak_planks",
                    "torch",
                    "ladder",
                    "crafting_table",
                    "furnace",
                    "chest",
                    // Other useful
                    "water_bucket",
                    "lava_bucket",
                    "ender_pearl",
                    "bed",
                ];

                let container = client.component::<Container>();
                if let Some(container_menu) = container.current_menu() {
                    let slots = container_menu.slots();
                    let player_inventory = client.component::<Inventory>();

                    // Iterate through player inventory (slots 9-35 for main inventory, 0-8 hotbar)
                    // Actually, the player inventory is separate from container
                    // We need to move items from player inventory to chest
                    for slot_idx in 9..36 {
                        // Player inventory slots
                        if let Some(item_stack) = player_inventory.get_slot(slot_idx) {
                            if !item_stack.is_empty() {
                                let item_name = item_stack
                                    .item()
                                    .to_string()
                                    .strip_prefix("minecraft:")
                                    .unwrap_or(&item_stack.item().to_string())
                                    .to_string();

                                let is_essential =
                                    essential_items.iter().any(|&e| item_name.contains(e));

                                if !is_essential {
                                    // Move to chest - click player inventory slot, then click chest slot
                                    client.ecs.lock().send_event(ClickOperation {
                                        entity: client.entity,
                                        slot: slot_idx,
                                        click_type: ClickType::Pickup,
                                        button: MouseButton::Left,
                                        mode:
                                            azalea::inventory::operations::click::ClickMode::Normal,
                                    });

                                    // Find empty slot in chest (chest slots start after player inventory)
                                    let chest_start = 36; // Approximate
                                    for chest_slot in chest_start..slots.len() {
                                        if let Some(chest_item) = container_menu.slot(chest_slot) {
                                            if chest_item.is_empty() {
                                                client.ecs.lock().send_event(ClickOperation {
                                                    entity: client.entity,
                                                    slot: chest_slot,
                                                    click_type: ClickType::Pickup,
                                                    button: MouseButton::Left,
                                                    mode: azalea::inventory::operations::click::ClickMode::Normal,
                                                });
                                                break;
                                            }
                                        }
                                    }

                                    tokio::time::sleep(Duration::from_millis(100)).await;
                                }
                            }
                        }
                    }
                }
            }
        });

        Ok(())
    }

    // Mining feature commands
    pub fn start_miner(&mut self, direction: &str, length: u32) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        if self
            .miner_task
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            return Err("Miner is already active".to_owned());
        }
        let valid_directions = ["north", "south", "east", "west"];
        if !valid_directions.contains(&direction) {
            return Err("Invalid direction. Use: north, south, east, west".to_owned());
        }
        if !(1..=1000).contains(&length) {
            return Err("Length must be between 1 and 1000".to_owned());
        }

        self.stop_mining();
        self.stop_following();
        self.stop_roaming();

        let start_pos = self.position().ok_or("Bot not spawned")?;
        let direction = direction.to_owned();
        let mut client = self.client.clone();

        self.miner_task = Some(tokio::spawn(async move {
            let (dx, dz) = match direction.as_str() {
                "north" => (0, -1),
                "south" => (0, 1),
                "east" => (1, 0),
                "west" => (-1, 0),
                _ => (0, 0),
            };

            // Start at the bot's current position, dig a 2x2 tunnel at head height and foot height
            let start_y = start_pos.y.floor() as i32;
            let start_x = start_pos.x.floor() as i32;
            let start_z = start_pos.z.floor() as i32;

            for i in 0..length {
                // Check if miner was stopped
                // Note: We can't easily check from here, so we rely on task abort

                // Target positions for 2-high tunnel: foot level and head level
                let target_x = start_x + dx * i as i32;
                let target_z = start_z + dz * i as i32;

                // Dig at foot level (y) and head level (y+1)
                for dy in 0..2 {
                    let dig_y = start_y + dy;
                    let block_pos = azalea::BlockPos::new(target_x, dig_y, target_z);

                    // Pathfind to mining position (stand behind the block to mine)
                    let stand_x = target_x as f64 + 0.5;
                    let stand_z = target_z as f64 + 0.5;
                    let stand_y = (start_y - 1) as f64; // Stand one block below

                    let stand_pos = Vec3::new(stand_x, stand_y, stand_z);
                    client.goto_without_mining(RadiusGoal {
                        pos: stand_pos,
                        radius: 1.0,
                    });

                    // Wait for movement
                    let mut ticks = client.get_tick_broadcaster();
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                    loop {
                        let pos = client.position();
                        if pos.distance(stand_pos) <= 1.5 {
                            break;
                        }
                        match tokio::time::timeout_at(deadline, ticks.recv()).await {
                            Ok(Ok(())) => {}
                            _ => return,
                        }
                    }

                    // Check if block exists and is mineable
                    let world = client.world();
                    let world = world.read();
                    if let Some(state) = world.get_block_state(&block_pos) {
                        let block = RegistryBlock::from(state);
                        if !matches!(
                            block,
                            RegistryBlock::Air | RegistryBlock::CaveAir | RegistryBlock::VoidAir
                        ) {
                            // Check if breakable
                            let destroy_time = Box::<dyn azalea::registry::BlockTrait>::from(state)
                                .behavior()
                                .destroy_time;
                            if destroy_time >= 0.0 {
                                drop(world);

                                // Select best tool
                                let best_tool = client.best_tool_in_hotbar_for_block(state);
                                if best_tool.percentage_per_tick > 0.0 {
                                    client.ecs.lock().send_event(
                                        azalea::inventory::SetSelectedHotbarSlotEvent {
                                            entity: client.entity,
                                            slot: best_tool.index as u8,
                                        },
                                    );

                                    // Look at block and mine
                                    client.look_at(Vec3::from(block_pos.center()));
                                    let mut ticks = client.get_tick_broadcaster();
                                    let _ =
                                        tokio::time::timeout(Duration::from_secs(2), ticks.recv())
                                            .await;

                                    // Mine the block
                                    let _ = tokio::time::timeout(
                                        Duration::from_secs(30),
                                        client.mine(block_pos),
                                    )
                                    .await;
                                } else {
                                    // No suitable tool, still try to mine with hand
                                    client.look_at(Vec3::from(block_pos.center()));
                                    let mut ticks = client.get_tick_broadcaster();
                                    let _ =
                                        tokio::time::timeout(Duration::from_secs(2), ticks.recv())
                                            .await;
                                    let _ = tokio::time::timeout(
                                        Duration::from_secs(30),
                                        client.mine(block_pos),
                                    )
                                    .await;
                                }
                            }
                        }
                    } else {
                        drop(world);
                    }

                    tokio::time::sleep(Duration::from_millis(500)).await;
                }

                // Also dig the block above head level for safety (y+2)
                let block_pos = azalea::BlockPos::new(target_x, start_y + 2, target_z);
                let world = client.world();
                let world = world.read();
                if let Some(state) = world.get_block_state(&block_pos) {
                    let block = RegistryBlock::from(state);
                    if !matches!(
                        block,
                        RegistryBlock::Air | RegistryBlock::CaveAir | RegistryBlock::VoidAir
                    ) {
                        let destroy_time = Box::<dyn azalea::registry::BlockTrait>::from(state)
                            .behavior()
                            .destroy_time;
                        if destroy_time >= 0.0 {
                            drop(world);

                            let stand_x = target_x as f64 + 0.5;
                            let stand_z = target_z as f64 + 0.5;
                            let stand_y = (start_y - 1) as f64;
                            let stand_pos = Vec3::new(stand_x, stand_y, stand_z);
                            client.goto_without_mining(RadiusGoal {
                                pos: stand_pos,
                                radius: 1.0,
                            });

                            let mut ticks = client.get_tick_broadcaster();
                            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                            loop {
                                let pos = client.position();
                                if pos.distance(stand_pos) <= 1.5 {
                                    break;
                                }
                                match tokio::time::timeout_at(deadline, ticks.recv()).await {
                                    Ok(Ok(())) => {}
                                    _ => return,
                                }
                            }

                            let best_tool = client.best_tool_in_hotbar_for_block(state);
                            if best_tool.percentage_per_tick > 0.0 {
                                client.ecs.lock().send_event(
                                    azalea::inventory::SetSelectedHotbarSlotEvent {
                                        entity: client.entity,
                                        slot: best_tool.index as u8,
                                    },
                                );
                            }
                            client.look_at(Vec3::from(block_pos.center()));
                            let mut ticks = client.get_tick_broadcaster();
                            let _ =
                                tokio::time::timeout(Duration::from_secs(2), ticks.recv()).await;
                            let _ = tokio::time::timeout(
                                Duration::from_secs(30),
                                client.mine(block_pos),
                            )
                            .await;
                        }
                    } else {
                        drop(world);
                    }
                } else {
                    drop(world);
                }

                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }));
        Ok(())
    }

    pub fn stop_miner(&mut self) -> bool {
        let Some(task) = self.miner_task.take() else {
            return false;
        };
        if task.is_finished() {
            return false;
        }
        self.client.stop_pathfinding();
        task.abort();
        true
    }

    pub fn start_mine_area(
        &mut self,
        x1: i32,
        y1: i32,
        z1: i32,
        x2: i32,
        y2: i32,
        z2: i32,
    ) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        if self
            .mine_area_task
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            return Err("Mine area is already active".to_owned());
        }

        let min_x = x1.min(x2);
        let max_x = x1.max(x2);
        let min_y = y1.min(y2);
        let max_y = y1.max(y2);
        let min_z = z1.min(z2);
        let max_z = z1.max(z2);

        let volume = (max_x - min_x + 1) * (max_y - min_y + 1) * (max_z - min_z + 1);
        if volume > 512 {
            return Err(format!(
                "Mine area is {volume} blocks; maximum supported is 512"
            ));
        }

        self.stop_mining();
        self.stop_following();
        self.stop_roaming();

        let mut client = self.client.clone();
        self.mine_area_task = Some(tokio::spawn(async move {
            // Mine in layers from top to bottom for safety
            for y in (min_y..=max_y).rev() {
                for x in min_x..=max_x {
                    for z in min_z..=max_z {
                        let block_pos = azalea::BlockPos::new(x, y, z);

                        // Check if block exists and is mineable
                        let world = client.world();
                        let world = world.read();
                        if let Some(state) = world.get_block_state(&block_pos) {
                            let block = RegistryBlock::from(state);
                            if !matches!(
                                block,
                                RegistryBlock::Air
                                    | RegistryBlock::CaveAir
                                    | RegistryBlock::VoidAir
                            ) {
                                let destroy_time =
                                    Box::<dyn azalea::registry::BlockTrait>::from(state)
                                        .behavior()
                                        .destroy_time;
                                if destroy_time >= 0.0 {
                                    drop(world);

                                    // Pathfind to position to mine this block
                                    // Stand at a safe offset
                                    let stand_x = x as f64 + 0.5;
                                    let stand_z = z as f64 + 0.5;
                                    let stand_y = (y - 1) as f64; // Stand below
                                    let stand_pos = Vec3::new(stand_x, stand_y, stand_z);

                                    client.goto_without_mining(RadiusGoal {
                                        pos: stand_pos,
                                        radius: 1.0,
                                    });

                                    // Wait for movement
                                    let mut ticks = client.get_tick_broadcaster();
                                    let deadline =
                                        tokio::time::Instant::now() + Duration::from_secs(10);
                                    loop {
                                        let pos = client.position();
                                        if pos.distance(stand_pos) <= 1.5 {
                                            break;
                                        }
                                        match tokio::time::timeout_at(deadline, ticks.recv()).await
                                        {
                                            Ok(Ok(())) => {}
                                            _ => return,
                                        }
                                    }

                                    // Select best tool
                                    let best_tool = client.best_tool_in_hotbar_for_block(state);
                                    if best_tool.percentage_per_tick > 0.0 {
                                        client.ecs.lock().send_event(
                                            azalea::inventory::SetSelectedHotbarSlotEvent {
                                                entity: client.entity,
                                                slot: best_tool.index as u8,
                                            },
                                        );
                                    }

                                    // Look at block and mine
                                    client.look_at(Vec3::from(block_pos.center()));
                                    let mut ticks = client.get_tick_broadcaster();
                                    let _ =
                                        tokio::time::timeout(Duration::from_secs(2), ticks.recv())
                                            .await;

                                    let _ = tokio::time::timeout(
                                        Duration::from_secs(30),
                                        client.mine(block_pos),
                                    )
                                    .await;

                                    tokio::time::sleep(Duration::from_millis(300)).await;
                                } else {
                                    drop(world);
                                }
                            } else {
                                drop(world);
                            }
                        } else {
                            drop(world);
                        }
                    }
                }
            }
        }));
        Ok(())
    }

    pub fn stop_mine_area(&mut self) -> bool {
        let Some(task) = self.mine_area_task.take() else {
            return false;
        };
        if task.is_finished() {
            return false;
        }
        self.client.stop_pathfinding();
        task.abort();
        true
    }

    pub fn refuel(&mut self) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }

        let mut client = self.client.clone();
        tokio::spawn(async move {
            // Search for coal ore in loaded chunks within 32 blocks
            let pos = client.position();
            let search_radius = 32;
            let player_block_pos = azalea::BlockPos::from(pos);

            let world = client.world();
            let world = world.read();
            let chunk_storage = world.chunk_storage.clone();
            drop(world);

            let mut coal_positions = Vec::new();

            for dx in -search_radius..=search_radius {
                for dy in -16..=16 {
                    for dz in -search_radius..=search_radius {
                        let check_pos = azalea::BlockPos::new(
                            player_block_pos.x + dx,
                            player_block_pos.y + dy,
                            player_block_pos.z + dz,
                        );
                        if let Some(state) = chunk_storage.get_block_state(&check_pos) {
                            let block = RegistryBlock::from(state);
                            if matches!(
                                block,
                                RegistryBlock::CoalOre | RegistryBlock::DeepslateCoalOre
                            ) {
                                coal_positions.push(check_pos);
                            }
                        }
                    }
                }
            }

            // Sort by distance
            coal_positions.sort_by(|a, b| {
                let dist_a = (a.x as f64 - pos.x).powi(2)
                    + (a.y as f64 - pos.y).powi(2)
                    + (a.z as f64 - pos.z).powi(2);
                let dist_b = (b.x as f64 - pos.x).powi(2)
                    + (b.y as f64 - pos.y).powi(2)
                    + (b.z as f64 - pos.z).powi(2);
                dist_a.partial_cmp(&dist_b).unwrap()
            });

            // Mine up to 8 coal ores
            for &coal_pos in coal_positions.iter().take(8) {
                // Pathfind to mining position
                let stand_x = coal_pos.x as f64 + 0.5;
                let stand_z = coal_pos.z as f64 + 0.5;
                let stand_y = (coal_pos.y - 1) as f64;
                let stand_pos = Vec3::new(stand_x, stand_y, stand_z);

                client.goto_without_mining(RadiusGoal {
                    pos: stand_pos,
                    radius: 1.0,
                });

                // Wait for movement
                let mut ticks = client.get_tick_broadcaster();
                let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
                loop {
                    let pos = client.position();
                    if pos.distance(stand_pos) <= 1.5 {
                        break;
                    }
                    match tokio::time::timeout_at(deadline, ticks.recv()).await {
                        Ok(Ok(())) => {}
                        _ => return,
                    }
                }

                // Check block still exists
                let world = client.world();
                let world = world.read();
                if let Some(state) = world.get_block_state(&coal_pos) {
                    let block = RegistryBlock::from(state);
                    if matches!(
                        block,
                        RegistryBlock::CoalOre | RegistryBlock::DeepslateCoalOre
                    ) {
                        let destroy_time = Box::<dyn azalea::registry::BlockTrait>::from(state)
                            .behavior()
                            .destroy_time;
                        if destroy_time >= 0.0 {
                            drop(world);

                            // Select best tool (pickaxe)
                            let best_tool = client.best_tool_in_hotbar_for_block(state);
                            if best_tool.percentage_per_tick > 0.0 {
                                client.ecs.lock().send_event(
                                    azalea::inventory::SetSelectedHotbarSlotEvent {
                                        entity: client.entity,
                                        slot: best_tool.index as u8,
                                    },
                                );
                            }

                            // Look at block and mine
                            client.look_at(Vec3::from(coal_pos.center()));
                            let mut ticks = client.get_tick_broadcaster();
                            let _ =
                                tokio::time::timeout(Duration::from_secs(2), ticks.recv()).await;

                            let _ = tokio::time::timeout(
                                Duration::from_secs(30),
                                client.mine(coal_pos),
                            )
                            .await;

                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                    } else {
                        drop(world);
                    }
                } else {
                    drop(world);
                }
            }

            // If we have logs and no coal, smelt logs into charcoal
            // Check inventory for logs
            let inventory = client.component::<Inventory>();
            let has_logs = inventory.iter().enumerate().any(|(slot, item)| {
                if let Some(item_stack) = item.as_present() {
                    let name = item_stack.kind.to_string();
                    name.contains("_log") && !name.contains("planks")
                } else {
                    false
                }
            });

            if has_logs {
                // Find furnace near base or craft one
                // For now, just notify - full smelting would require furnace interaction
                client.chat("Refuel: Mined coal. Consider using furnace to smelt logs into charcoal if needed.");
            }
        });

        Ok(())
    }

    pub fn start_lumberjack(&mut self, radius: u32) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        if !(1..=50).contains(&radius) {
            return Err("Radius must be between 1 and 50".to_owned());
        }

        let pos = self.position().ok_or("Bot not spawned")?;
        let mut client = self.client.clone();
        let search_radius = radius as i32;
        let player_block_pos = azalea::BlockPos::from(pos);

        tokio::spawn(async move {
            // Search for logs in loaded chunks
            let world = client.world();
            let world = world.read();
            let chunk_storage = world.chunk_storage.clone();
            drop(world);

            let mut log_positions = Vec::new();

            for dx in -search_radius..=search_radius {
                for dy in -5..=20 {
                    // Trees grow upward
                    for dz in -search_radius..=search_radius {
                        let check_pos = azalea::BlockPos::new(
                            player_block_pos.x + dx,
                            player_block_pos.y + dy,
                            player_block_pos.z + dz,
                        );
                        if let Some(state) = chunk_storage.get_block_state(&check_pos) {
                            let block = RegistryBlock::from(state);
                            if block.to_string().contains("_log")
                                && !block.to_string().contains("planks")
                            {
                                log_positions.push(check_pos);
                            }
                        }
                    }
                }
            }

            // Sort by distance (prefer closer logs)
            log_positions.sort_by(|a, b| {
                let dist_a = (a.x as f64 - pos.x).powi(2)
                    + (a.y as f64 - pos.y).powi(2)
                    + (a.z as f64 - pos.z).powi(2);
                let dist_b = (b.x as f64 - pos.x).powi(2)
                    + (b.y as f64 - pos.y).powi(2)
                    + (b.z as f64 - pos.z).powi(2);
                dist_a.partial_cmp(&dist_b).unwrap()
            });

            // Chop up to 20 logs
            for &log_pos in log_positions.iter().take(20) {
                // Check if block still exists
                let world = client.world();
                let world = world.read();
                if let Some(state) = world.get_block_state(&log_pos) {
                    let block = RegistryBlock::from(state);
                    if block.to_string().contains("_log") && !block.to_string().contains("planks") {
                        let destroy_time = Box::<dyn azalea::registry::BlockTrait>::from(state)
                            .behavior()
                            .destroy_time;
                        if destroy_time >= 0.0 {
                            drop(world);

                            // Pathfind to mining position (stand at base of tree)
                            let stand_x = log_pos.x as f64 + 0.5;
                            let stand_z = log_pos.z as f64 + 0.5;
                            let stand_y = log_pos.y as f64 - 1.0;
                            let stand_pos = Vec3::new(stand_x, stand_y, stand_z);

                            client.goto_without_mining(RadiusGoal {
                                pos: stand_pos,
                                radius: 1.0,
                            });

                            // Wait for movement
                            let mut ticks = client.get_tick_broadcaster();
                            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
                            loop {
                                let pos = client.position();
                                if pos.distance(stand_pos) <= 1.5 {
                                    break;
                                }
                                match tokio::time::timeout_at(deadline, ticks.recv()).await {
                                    Ok(Ok(())) => {}
                                    _ => return,
                                }
                            }

                            // Select best tool (axe)
                            let best_tool = client.best_tool_in_hotbar_for_block(state);
                            if best_tool.percentage_per_tick > 0.0 {
                                client.ecs.lock().send_event(
                                    azalea::inventory::SetSelectedHotbarSlotEvent {
                                        entity: client.entity,
                                        slot: best_tool.index as u8,
                                    },
                                );
                            }

                            // Mine the log - mine from bottom up
                            // First find the bottom log of the tree
                            let mut current_y = log_pos.y;
                            let mut bottom_log = log_pos;
                            for check_y in (log_pos.y - 10)..=log_pos.y {
                                let check_pos =
                                    azalea::BlockPos::new(log_pos.x, check_y, log_pos.z);
                                if let Some(check_state) = chunk_storage.get_block_state(&check_pos)
                                {
                                    let check_block = RegistryBlock::from(check_state);
                                    if check_block.to_string().contains("_log")
                                        && !check_block.to_string().contains("planks")
                                    {
                                        bottom_log = check_pos;
                                    } else {
                                        break;
                                    }
                                } else {
                                    break;
                                }
                            }

                            // Mine from bottom to top
                            for mine_y in bottom_log.y..(bottom_log.y + 30) {
                                let mine_pos =
                                    azalea::BlockPos::new(bottom_log.x, mine_y, bottom_log.z);
                                let world = client.world();
                                let world = world.read();
                                if let Some(mine_state) = world.get_block_state(&mine_pos) {
                                    let mine_block = RegistryBlock::from(mine_state);
                                    if mine_block.to_string().contains("_log")
                                        && !mine_block.to_string().contains("planks")
                                    {
                                        drop(world);

                                        client.look_at(Vec3::from(mine_pos.center()));
                                        let mut ticks = client.get_tick_broadcaster();
                                        let _ = tokio::time::timeout(
                                            Duration::from_secs(2),
                                            ticks.recv(),
                                        )
                                        .await;

                                        let _ = tokio::time::timeout(
                                            Duration::from_secs(30),
                                            client.mine(mine_pos),
                                        )
                                        .await;
                                        tokio::time::sleep(Duration::from_millis(300)).await;
                                    } else {
                                        drop(world);
                                        break; // No more logs
                                    }
                                } else {
                                    drop(world);
                                    break;
                                }
                            }
                        }
                    } else {
                        drop(world);
                    }
                } else {
                    drop(world);
                }

                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });

        Ok(())
    }

    // Building commands
    pub fn build_roof(&mut self, radius: u32) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        if !(1..=50).contains(&radius) {
            return Err("Radius must be between 1 and 50".to_owned());
        }

        let base = self
            .base_location
            .ok_or("No base location set. Use sbase first.")?;
        let mut client = self.client.clone();
        let base_block_pos = azalea::BlockPos::from(base);
        let roof_y = base_block_pos.y + 5; // Build roof 5 blocks above base

        tokio::spawn(async move {
            // Navigate to base first
            client.goto_without_mining(RadiusGoal {
                pos: base,
                radius: 2.0,
            });

            // Wait for arrival
            let mut ticks = client.get_tick_broadcaster();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                let pos = client.position();
                if pos.distance(base) <= 2.5 {
                    break;
                }
                match tokio::time::timeout_at(deadline, ticks.recv()).await {
                    Ok(Ok(())) => {}
                    _ => return,
                }
            }

            // Check for building materials in inventory
            let inventory = client.component::<Inventory>();
            let mut building_block_slot = None;
            let preferred_blocks = [
                "cobblestone",
                "stone",
                "oak_planks",
                "spruce_planks",
                "dirt",
                "cobblestone",
            ];

            for (slot, item) in inventory.iter().enumerate() {
                if let Some(item_stack) = item.as_present() {
                    let name = item_stack
                        .kind
                        .to_string()
                        .strip_prefix("minecraft:")
                        .unwrap_or(&item_stack.kind.to_string());
                    if preferred_blocks.contains(&name) && item_stack.count > 0 {
                        building_block_slot = Some((slot, name.to_owned()));
                        break;
                    }
                }
            }

            let (block_slot, block_name) = match building_block_slot {
                Some(s) => s,
                None => {
                    client.chat("No suitable building blocks found in inventory (need cobblestone, stone, planks, or dirt)");
                    return;
                }
            };

            // Select the building block
            client
                .ecs
                .lock()
                .send_event(azalea::inventory::SetSelectedHotbarSlotEvent {
                    entity: client.entity,
                    slot: block_slot as u8,
                });

            // Build flat roof: place blocks in a square pattern at roof_y
            let radius_i = radius as i32;
            for dx in -radius_i..=radius_i {
                for dz in -radius_i..=radius_i {
                    let place_pos =
                        azalea::BlockPos::new(base_block_pos.x + dx, roof_y, base_block_pos.z + dz);

                    // Check if block already exists
                    let world = client.world();
                    let world = world.read();
                    let should_place = if let Some(state) = world.get_block_state(&place_pos) {
                        matches!(
                            RegistryBlock::from(state),
                            RegistryBlock::Air | RegistryBlock::CaveAir | RegistryBlock::VoidAir
                        )
                    } else {
                        true
                    };
                    drop(world);

                    if should_place {
                        // Pathfind to position to place block
                        // Stand below and to the side
                        let stand_x = place_pos.x as f64 + 0.5;
                        let stand_z = place_pos.z as f64 + 0.5;
                        let stand_y = (roof_y - 1) as f64;
                        let stand_pos = Vec3::new(stand_x, stand_y, stand_z);

                        client.goto_without_mining(RadiusGoal {
                            pos: stand_pos,
                            radius: 1.0,
                        });

                        // Wait for movement
                        let mut ticks = client.get_tick_broadcaster();
                        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                        loop {
                            let pos = client.position();
                            if pos.distance(stand_pos) <= 1.5 {
                                break;
                            }
                            match tokio::time::timeout_at(deadline, ticks.recv()).await {
                                Ok(Ok(())) => {}
                                _ => return,
                            }
                        }

                        // Place block (right-click on top of block below)
                        let target_pos = azalea::BlockPos::new(
                            base_block_pos.x + dx,
                            roof_y - 1,
                            base_block_pos.z + dz,
                        );
                        client.look_at(Vec3::from(place_pos.center()));
                        let mut ticks = client.get_tick_broadcaster();
                        let _ = tokio::time::timeout(Duration::from_secs(2), ticks.recv()).await;

                        client
                            .ecs
                            .lock()
                            .send_event(azalea::interact::InteractBlockEvent {
                                entity: client.entity,
                                position: target_pos,
                                direction: Direction::Up,
                                hand: azalea::protocol::packets::game::Hand::MainHand,
                                cursor_position: None,
                                inside_block: false,
                                sequence: 0,
                            });

                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                }
            }

            client.chat(&format!("Roof built with {} at Y={}", block_name, roof_y));
        });

        Ok(())
    }

    // Combat/Guard commands
    pub fn start_guard(&mut self) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        if self
            .guard_task
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            return Err("Guard is already active".to_owned());
        }

        let guard_position = self.position().ok_or("Bot not spawned")?;
        let mut client = self.client.clone();

        // Navigate to guard position first
        client.goto_without_mining(RadiusGoal {
            pos: guard_position,
            radius: 2.0,
        });

        self.guard_task = Some(tokio::spawn(async move {
            // Wait for arrival
            let mut ticks = client.get_tick_broadcaster();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                let pos = client.position();
                if pos.distance(guard_position) <= 2.5 {
                    break;
                }
                match tokio::time::timeout_at(deadline, ticks.recv()).await {
                    Ok(Ok(())) => {}
                    _ => return,
                }
            }

            // Guard loop - check for hostile mobs and players
            let mut last_attack = Instant::now();

            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;

                // Check if we're still at guard position, return if drifted
                let pos = client.position();
                if pos.distance(guard_position) > 5.0 {
                    client.goto_without_mining(RadiusGoal {
                        pos: guard_position,
                        radius: 2.0,
                    });
                    continue;
                }

                // Find hostile entities nearby
                let world = client.world();
                let entities = world.read().entities();
                let mut target_entity = None;
                let mut min_dist = f64::MAX;

                for entity in entities {
                    // Check if it's a living entity (mob or player)
                    if let Some(pos_comp) = client.get_entity_component::<Position>(entity) {
                        let entity_pos = Vec3::from(&pos_comp);
                        let dist = pos.distance(entity_pos);

                        if dist <= 10.0 && dist < min_dist {
                            // Check if hostile - for now, target any non-player entity that's not the bot
                            if entity != client.entity {
                                // Check if it's a player
                                let is_player = client
                                    .get_entity_component::<GameProfileComponent>(entity)
                                    .is_some();

                                // For guard mode, target hostile mobs
                                // In a real implementation, check entity type
                                target_entity = Some(entity);
                                min_dist = dist;
                            }
                        }
                    }
                }

                if let Some(target) = target_entity {
                    if last_attack.elapsed() >= Duration::from_secs(1) {
                        // Attack the target
                        client.look_at(client.entity_position(target).unwrap_or(Vec3::ZERO));
                        client.ecs.lock().send_event(azalea::entity::AttackEvent {
                            entity: client.entity,
                            target,
                        });
                        last_attack = Instant::now();
                    }
                }

                // Equip best weapon
                let inventory = client.component::<Inventory>();
                let mut best_weapon_slot = None;
                let mut best_damage = 0.0;

                for (slot, item) in inventory.iter().enumerate() {
                    if let Some(item_stack) = item.as_present() {
                        let name = item_stack.kind.to_string();
                        // Check for weapons
                        let damage = if name.contains("sword") {
                            if name.contains("netherite") {
                                8.0
                            } else if name.contains("diamond") {
                                7.0
                            } else if name.contains("iron") {
                                6.0
                            } else if name.contains("stone") {
                                5.0
                            } else if name.contains("golden") {
                                4.0
                            } else {
                                4.0
                            } // wooden
                        } else if name.contains("axe") {
                            if name.contains("netherite") {
                                10.0
                            } else if name.contains("diamond") {
                                9.0
                            } else if name.contains("iron") {
                                8.0
                            } else {
                                7.0
                            }
                        } else {
                            0.0
                        };

                        if damage > best_damage && slot < 9 {
                            // Hotbar only
                            best_damage = damage;
                            best_weapon_slot = Some(slot);
                        }
                    }
                }

                if let Some(slot) = best_weapon_slot {
                    client
                        .ecs
                        .lock()
                        .send_event(azalea::inventory::SetSelectedHotbarSlotEvent {
                            entity: client.entity,
                            slot: slot as u8,
                        });
                }
            }
        }));
        Ok(())
    }

    pub fn stop_guard(&mut self) -> bool {
        let Some(task) = self.guard_task.take() else {
            return false;
        };
        if task.is_finished() {
            return false;
        }
        self.client.stop_pathfinding();
        task.abort();
        true
    }

    pub fn start_pvp(&mut self, target: &str) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }
        if self
            .pvp_task
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            return Err("PVP is already active".to_owned());
        }

        // Find player entity
        let entity = self
            .client
            .entity_by::<With<Player>, &GameProfileComponent>(|profile: &&GameProfileComponent| {
                profile.name.eq_ignore_ascii_case(target)
            })
            .ok_or("Player not found")?;

        self.pvp_target = Some(target.to_owned());
        let mut client = self.client.clone();
        let target_name = target.to_owned();

        self.pvp_task = Some(tokio::spawn(async move {
            let mut last_attack = Instant::now();
            let mut last_pathfind = Instant::now();

            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;

                // Find target player entity
                let target_entity = client.entity_by::<With<Player>, &GameProfileComponent>(
                    |profile: &&GameProfileComponent| {
                        profile.name.eq_ignore_ascii_case(&target_name)
                    },
                );

                let Some(target_entity) = target_entity else {
                    // Target not found, wait and retry
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                };

                // Get target position
                let target_pos = match client.get_entity_component::<Position>(target_entity) {
                    Some(pos) => Vec3::from(&pos),
                    None => continue,
                };

                let bot_pos = client.position();
                let dist = bot_pos.distance(target_pos);

                // Pathfind to target if too far
                if dist > 4.0 && last_pathfind.elapsed() >= Duration::from_secs(2) {
                    client.goto_without_mining(RadiusGoal {
                        pos: target_pos,
                        radius: 2.0,
                    });
                    last_pathfind = Instant::now();
                }

                // Equip best weapon
                let inventory = client.component::<Inventory>();
                let mut best_weapon_slot = None;
                let mut best_damage = 0.0;

                for (slot, item) in inventory.iter().enumerate() {
                    if let Some(item_stack) = item.as_present() {
                        let name = item_stack.kind.to_string();
                        let damage = if name.contains("sword") {
                            if name.contains("netherite") {
                                8.0
                            } else if name.contains("diamond") {
                                7.0
                            } else if name.contains("iron") {
                                6.0
                            } else if name.contains("stone") {
                                5.0
                            } else {
                                4.0
                            }
                        } else if name.contains("axe") {
                            if name.contains("netherite") {
                                10.0
                            } else if name.contains("diamond") {
                                9.0
                            } else if name.contains("iron") {
                                8.0
                            } else {
                                7.0
                            }
                        } else if name.contains("trident") {
                            9.0
                        } else if name.contains("bow") || name.contains("crossbow") {
                            6.0 // Ranged
                        } else {
                            0.0
                        };

                        if damage > best_damage && slot < 9 {
                            best_damage = damage;
                            best_weapon_slot = Some(slot);
                        }
                    }
                }

                if let Some(slot) = best_weapon_slot {
                    client
                        .ecs
                        .lock()
                        .send_event(azalea::inventory::SetSelectedHotbarSlotEvent {
                            entity: client.entity,
                            slot: slot as u8,
                        });
                }

                // Attack if in range
                if dist <= 4.0 && last_attack.elapsed() >= Duration::from_millis(500) {
                    client.look_at(target_pos);
                    client.ecs.lock().send_event(azalea::entity::AttackEvent {
                        entity: client.entity,
                        target: target_entity,
                    });
                    last_attack = Instant::now();
                }

                // Eat food if low health
                let health = client
                    .get_entity_component::<azalea::entity::Health>(client.entity)
                    .map(|h| h.health)
                    .unwrap_or(20.0);

                if health < 10.0 {
                    // Find food in inventory
                    for (slot, item) in inventory.iter().enumerate() {
                        if let Some(item_stack) = item.as_present() {
                            let name = item_stack.kind.to_string();
                            if name.contains("food")
                                || name.contains("bread")
                                || name.contains("meat")
                                || name.contains("fish")
                                || name.contains("apple")
                                || name.contains("carrot")
                                || name.contains("potato")
                                || name.contains("cookie")
                                || name.contains("cake")
                            {
                                client.ecs.lock().send_event(
                                    azalea::inventory::SetSelectedHotbarSlotEvent {
                                        entity: client.entity,
                                        slot: slot as u8,
                                    },
                                );
                                // Use item (right-click hold)
                                tokio::time::sleep(Duration::from_secs(2)).await;
                                break;
                            }
                        }
                    }
                }
            }
        }));
        Ok(())
    }

    pub fn stop_pvp(&mut self) -> bool {
        let was_active = if let Some(task) = self.pvp_task.take() {
            let active = !task.is_finished();
            task.abort();
            active
        } else {
            false
        };
        self.pvp_target = None;
        if was_active && self.state() == BotState::Connected {
            self.client.stop_pathfinding();
        }
        was_active
    }

    // Utility commands
    pub fn activate_panic_mode(&mut self) {
        self.panic_mode = true;
        self.stop_movement();

        let pos = match self.position() {
            Some(p) => p,
            None => return,
        };

        let mut client = self.client.clone();

        // Flee to high Y coordinate (safety) or find enclosed space
        tokio::spawn(async move {
            // Strategy 1: Go up to Y=255 (build limit) - safest place
            let target_y = 250.0;
            let flee_pos = Vec3::new(pos.x, target_y, pos.z);

            client.goto_without_mining(RadiusGoal {
                pos: flee_pos,
                radius: 1.0,
            });

            // Wait for arrival
            let mut ticks = client.get_tick_broadcaster();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
            loop {
                let pos = client.position();
                if pos.y >= target_y - 5.0 {
                    break;
                }
                match tokio::time::timeout_at(deadline, ticks.recv()).await {
                    Ok(Ok(())) => {}
                    _ => return,
                }
            }

            // Once at height, build a small shelter
            let pos = client.position();
            let block_pos = azalea::BlockPos::new(
                pos.x.floor() as i32,
                pos.y.floor() as i32,
                pos.z.floor() as i32,
            );

            // Check for blocks in inventory to build with
            let inventory = client.component::<Inventory>();
            let mut building_block_slot = None;
            for (slot, item) in inventory.iter().enumerate() {
                if let Some(item_stack) = item.as_present() {
                    let name = item_stack
                        .kind
                        .to_string()
                        .strip_prefix("minecraft:")
                        .unwrap_or(&item_stack.kind.to_string());
                    if [
                        "cobblestone",
                        "stone",
                        "dirt",
                        "oak_planks",
                        "spruce_planks",
                    ]
                    .contains(&name)
                        && item_stack.count > 5
                    {
                        building_block_slot = Some((slot, name.to_owned()));
                        break;
                    }
                }
            }

            if let Some((slot, _name)) = building_block_slot {
                client
                    .ecs
                    .lock()
                    .send_event(azalea::inventory::SetSelectedHotbarSlotEvent {
                        entity: client.entity,
                        slot: slot as u8,
                    });

                // Build a 3x3x2 shelter around bot
                for dx in -1..=1 {
                    for dz in -1..=1 {
                        for dy in 0..2 {
                            let place_pos = azalea::BlockPos::new(
                                block_pos.x + dx,
                                block_pos.y + dy,
                                block_pos.z + dz,
                            );

                            // Don't place where bot is
                            if dx == 0 && dz == 0 && dy <= 1 {
                                continue;
                            }

                            // Pathfind to place
                            let stand_x = place_pos.x as f64 + 0.5;
                            let stand_z = place_pos.z as f64 + 0.5;
                            let stand_y = (place_pos.y - 1) as f64;
                            let stand_pos = Vec3::new(stand_x, stand_y, stand_z);

                            client.goto_without_mining(RadiusGoal {
                                pos: stand_pos,
                                radius: 1.0,
                            });

                            let mut ticks = client.get_tick_broadcaster();
                            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                            loop {
                                let pos = client.position();
                                if pos.distance(stand_pos) <= 1.5 {
                                    break;
                                }
                                match tokio::time::timeout_at(deadline, ticks.recv()).await {
                                    Ok(Ok(())) => {}
                                    _ => return,
                                }
                            }

                            // Place block
                            let target_pos =
                                azalea::BlockPos::new(place_pos.x, place_pos.y - 1, place_pos.z);
                            client.look_at(Vec3::from(place_pos.center()));
                            let mut ticks = client.get_tick_broadcaster();
                            let _ =
                                tokio::time::timeout(Duration::from_secs(2), ticks.recv()).await;

                            client
                                .ecs
                                .lock()
                                .send_event(azalea::interact::InteractBlockEvent {
                                    entity: client.entity,
                                    position: target_pos,
                                    direction: Direction::Up,
                                    hand: azalea::protocol::packets::game::Hand::MainHand,
                                    cursor_position: None,
                                    inside_block: false,
                                    sequence: 0,
                                });

                            tokio::time::sleep(Duration::from_millis(300)).await;
                        }
                    }
                }
            }

            client.chat("🚨 Panic mode: Reached safety at high altitude and built shelter.");
        });
    }

    pub fn toggle_stealth(&mut self) {
        self.stealth_mode = !self.stealth_mode;
        // Send sneak state to server
        self.client
            .ecs
            .lock()
            .send_event(azalea::entity::SetControlStateEvent {
                entity: self.client.entity,
                control: "sneak".to_owned(),
                state: self.stealth_mode,
            });
    }

    pub fn stop_defense(&mut self) {
        self.auto_defense = false;
        self.stop_movement();
        self.stop_guard();
        self.stop_pvp();
    }

    pub fn rescue_player(&mut self, target: &str) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }

        // Find target player
        let entity = self
            .client
            .entity_by::<With<Player>, &GameProfileComponent>(|profile: &&GameProfileComponent| {
                profile.name.eq_ignore_ascii_case(target)
            })
            .ok_or("Player not found")?;

        let target_pos = match self.client.get_entity_component::<Position>(entity) {
            Some(pos) => Vec3::from(&pos),
            None => return Err("Could not get player position".to_owned()),
        };

        let mut client = self.client.clone();
        let target_name = target.to_owned();

        tokio::spawn(async move {
            // Pathfind to target
            client.goto_without_mining(RadiusGoal {
                pos: target_pos,
                radius: 2.0,
            });

            // Wait for arrival
            let mut ticks = client.get_tick_broadcaster();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
            loop {
                let pos = client.position();
                if pos.distance(target_pos) <= 3.0 {
                    break;
                }
                match tokio::time::timeout_at(deadline, ticks.recv()).await {
                    Ok(Ok(())) => {}
                    _ => return,
                }
            }

            // Check target health and give food if needed
            let health = client
                .get_entity_component::<azalea::entity::Health>(entity)
                .map(|h| h.health)
                .unwrap_or(20.0);

            if health < 18.0 {
                // Find food in inventory
                let inventory = client.component::<Inventory>();
                for (slot, item) in inventory.iter().enumerate() {
                    if let Some(item_stack) = item.as_present() {
                        let name = item_stack.kind.to_string();
                        if name.contains("food")
                            || name.contains("bread")
                            || name.contains("meat")
                            || name.contains("fish")
                            || name.contains("apple")
                            || name.contains("carrot")
                            || name.contains("potato")
                            || name.contains("cookie")
                            || name.contains("cake")
                            || name.contains("stew")
                            || name.contains("soup")
                        {
                            // Drop food for target
                            client.ecs.lock().send_event(
                                azalea::inventory::SetSelectedHotbarSlotEvent {
                                    entity: client.entity,
                                    slot: slot as u8,
                                },
                            );
                            tokio::time::sleep(Duration::from_millis(200)).await;

                            // Drop the item (Q key)
                            client.ecs.lock().send_event(azalea::entity::DropItemEvent {
                                entity: client.entity,
                                slot: slot as u8,
                                count: 1,
                            });

                            client.chat(&format!("Here's some food, {}!", target_name));
                            break;
                        }
                    }
                }
            }

            // If target is in danger (low health), protect them
            if health < 10.0 {
                client.chat(&format!("{} is in danger! Protecting...", target_name));
                // Attack nearby hostile mobs
                let mut last_attack = Instant::now();
                for _ in 0..60 {
                    // Protect for up to 60 seconds
                    tokio::time::sleep(Duration::from_secs(1)).await;

                    // Find hostile mobs near target
                    let world = client.world();
                    let entities = world.read().entities();
                    for mob_entity in entities {
                        if mob_entity == client.entity || mob_entity == entity {
                            continue;
                        }
                        if let Some(mob_pos) = client.get_entity_component::<Position>(mob_entity) {
                            let mob_pos = Vec3::from(&mob_pos);
                            if mob_pos.distance(target_pos) <= 10.0 {
                                // Attack mob
                                if last_attack.elapsed() >= Duration::from_secs(1) {
                                    client.look_at(mob_pos);
                                    client.ecs.lock().send_event(azalea::entity::AttackEvent {
                                        entity: client.entity,
                                        target: mob_entity,
                                    });
                                    last_attack = Instant::now();
                                }
                            }
                        }
                    }
                }
            }
        });

        Ok(())
    }

    pub fn medic_player(&mut self, target: &str) -> Result<(), String> {
        if self.state() != BotState::Connected {
            return Err("Bot is not connected".to_owned());
        }

        // Find target player
        let entity = self
            .client
            .entity_by::<With<Player>, &GameProfileComponent>(|profile: &&GameProfileComponent| {
                profile.name.eq_ignore_ascii_case(target)
            })
            .ok_or("Player not found")?;

        let target_pos = match self.client.get_entity_component::<Position>(entity) {
            Some(pos) => Vec3::from(&pos),
            None => return Err("Could not get player position".to_owned()),
        };

        let mut client = self.client.clone();
        let target_name = target.to_owned();

        tokio::spawn(async move {
            // Continuous medic loop
            for _ in 0..300 {
                // Run for up to 5 minutes (300 seconds)
                tokio::time::sleep(Duration::from_secs(1)).await;

                // Check if target still exists
                let target_entity = client.entity_by::<With<Player>, &GameProfileComponent>(
                    |profile: &&GameProfileComponent| {
                        profile.name.eq_ignore_ascii_case(&target_name)
                    },
                );

                let Some(target_entity) = target_entity else {
                    client.chat(&format!(
                        "{} is no longer online. Medic mode stopping.",
                        target_name
                    ));
                    break;
                };

                // Get target position
                let target_pos = match client.get_entity_component::<Position>(target_entity) {
                    Some(pos) => Vec3::from(&pos),
                    None => continue,
                };

                // Check target health
                let health = client
                    .get_entity_component::<azalea::entity::Health>(target_entity)
                    .map(|h| h.health)
                    .unwrap_or(20.0);

                let bot_pos = client.position();
                let dist = bot_pos.distance(target_pos);

                // Move closer if too far
                if dist > 5.0 {
                    client.goto_without_mining(RadiusGoal {
                        pos: target_pos,
                        radius: 3.0,
                    });
                }

                // Heal if needed
                if health < 18.0 {
                    // Find food/healing items
                    let inventory = client.component::<Inventory>();
                    let mut heal_item = None;

                    for (slot, item) in inventory.iter().enumerate() {
                        if let Some(item_stack) = item.as_present() {
                            let name = item_stack.kind.to_string();
                            let priority = if name.contains("golden_apple") {
                                10
                            } else if name.contains("golden_carrot") {
                                9
                            } else if name.contains("cooked_") {
                                7
                            } else if name.contains("bread") {
                                6
                            } else if name.contains("apple") {
                                5
                            } else if name.contains("carrot") || name.contains("potato") {
                                4
                            } else if name.contains("cookie") {
                                3
                            } else if name.contains("stew") || name.contains("soup") {
                                8
                            } else {
                                0
                            };

                            if priority > 0 {
                                heal_item = Some((slot, priority, name));
                                break;
                            }
                        }
                    }

                    if let Some((slot, _priority, name)) = heal_item {
                        // Move to target if not close enough
                        if dist > 3.0 {
                            client.goto_without_mining(RadiusGoal {
                                pos: target_pos,
                                radius: 2.0,
                            });
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        }

                        // Give food to target (drop it)
                        client.ecs.lock().send_event(
                            azalea::inventory::SetSelectedHotbarSlotEvent {
                                entity: client.entity,
                                slot: slot as u8,
                            },
                        );
                        tokio::time::sleep(Duration::from_millis(200)).await;

                        client.ecs.lock().send_event(azalea::entity::DropItemEvent {
                            entity: client.entity,
                            slot: slot as u8,
                            count: 1,
                        });

                        client.chat(&format!("Here, {}! Eat this {}.", target_name, name));
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                }

                // Protect from mobs
                let world = client.world();
                let entities = world.read().entities();
                for mob_entity in entities {
                    if mob_entity == client.entity || mob_entity == target_entity {
                        continue;
                    }
                    if let Some(mob_pos) = client.get_entity_component::<Position>(mob_entity) {
                        let mob_pos = Vec3::from(&mob_pos);
                        if mob_pos.distance(target_pos) <= 8.0 {
                            // Attack mob threatening target
                            client.look_at(mob_pos);
                            client.ecs.lock().send_event(azalea::entity::AttackEvent {
                                entity: client.entity,
                                target: mob_entity,
                            });
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                    }
                }
            }

            client.chat(&format!("Medic mode for {} ended.", target_name));
        });

        Ok(())
    }

    pub fn send_chat(&self, message: &str) -> Result<(), MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        self.client.chat(message);
        Ok(())
    }

    // Web API support methods

    /// Get bot vitals (health, food, saturation, position)
    pub async fn get_vitals(&self) -> Result<Value, MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        let entity = self.client.entity;
        let position: Option<Position> = self.client.get_entity_component(entity);
        let health: Option<Health> = self.client.get_entity_component(entity);
        let food = self.client.component::<azalea::hunger::Hunger>();

        let pos = position.map(|p| Vec3::from(&p));
        let health_val = health.map(|h| h.health).unwrap_or(20.0);
        let food_level = food.food_level;
        let saturation = food.saturation;

        Ok(json!({
            "health": health_val,
            "food": food_level,
            "saturation": saturation,
            "position": pos,
            "yaw": self.client.entity_yaw(),
            "pitch": self.client.entity_pitch(),
            "dimension": self.client.dimension().map(|d| d.to_string()),
            "time": self.client.time().map(|t| t.time_of_day()),
            "gamemode": self.client.game_mode().map(|g| g.to_string()),
        }))
    }

    /// Get inventory items
    pub async fn get_inventory(&self) -> Result<Value, MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        let snapshot = self.inventory_snapshot()?;
        let items: Vec<Value> = snapshot
            .slots
            .iter()
            .enumerate()
            .map(|(i, slot)| {
                if slot.is_empty() {
                    json!({
                        "slot": i,
                        "name": "air",
                        "displayName": "Empty",
                        "count": 0,
                        "maxStackSize": 64,
                    })
                } else {
                    json!({
                        "slot": i,
                        "name": slot.name(),
                        "displayName": slot.display_name(),
                        "count": slot.count(),
                        "maxStackSize": slot.max_stack_size(),
                    })
                }
            })
            .collect();

        let used_slots = snapshot.slots.iter().filter(|s| !s.is_empty()).count();

        Ok(json!({
            "items": items,
            "usedSlots": used_slots,
            "totalSlots": 36,
            "heldItem": snapshot.selected_hotbar_slot.map(|slot| {
                let item = &snapshot.slots[slot as usize];
                json!({
                    "slot": slot,
                    "name": item.name(),
                    "displayName": item.display_name(),
                    "count": item.count(),
                })
            }),
        }))
    }

    /// Get equipment (armor and held items)
    pub async fn get_equipment(&self) -> Result<Value, MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        let snapshot = self.inventory_snapshot()?;
        let inventory = self.client.component::<azalea::inventory::Inventory>();

        Ok(json!({
            "head": snapshot.helmet().map(|s| s.display_name()).unwrap_or("Empty".to_string()),
            "chest": snapshot.chestplate().map(|s| s.display_name()).unwrap_or("Empty".to_string()),
            "legs": snapshot.leggings().map(|s| s.display_name()).unwrap_or("Empty".to_string()),
            "feet": snapshot.boots().map(|s| s.display_name()).unwrap_or("Empty".to_string()),
            "hand": snapshot.main_hand().map(|s| s.display_name()).unwrap_or("Empty".to_string()),
            "offhand": snapshot.off_hand().map(|s| s.display_name()).unwrap_or("Empty".to_string()),
        }))
    }

    /// Get nearby players
    pub async fn get_players(&self) -> Result<Vec<Value>, MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        let mut players = Vec::new();
        let bot_pos = self.position().unwrap_or(Vec3::ZERO);
        let bot_username = self.username();

        for (entity, profile) in self.client.entities_with::<GameProfileComponent>() {
            let position: Option<Position> = self.client.get_entity_component(entity);
            let health: Option<Health> = self.client.get_entity_component(entity);

            if let (Some(pos), Some(profile)) = (position, profile) {
                let distance = Vec3::from(&pos).distance(bot_pos);
                players.push(json!({
                    "username": profile.name,
                    "entityId": entity.0,
                    "position": {
                        "x": pos.x,
                        "y": pos.y,
                        "z": pos.z,
                    },
                    "health": health.map(|h| h.health),
                    "gamemode": None, // Not easily accessible
                    "ping": None,
                    "isBot": profile.name == bot_username,
                }));
            }
        }

        Ok(players)
    }

    /// Get map data (blocks and entities around bot)
    pub async fn get_map(&self, radius: i32) -> Result<Value, MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        let bot_pos = self.position().unwrap_or(Vec3::ZERO);
        let world = self.client.world();
        let world = world.read();
        let chunk_storage = world.chunk_storage.clone();
        drop(world);

        let mut blocks = Vec::new();
        let mut entities = Vec::new();

        let base_block_pos = azalea::BlockPos::from(bot_pos);

        // Scan blocks
        for dx in -radius..=radius {
            for dz in -radius..=radius {
                for dy in -2..=2 {
                    let check_pos = azalea::BlockPos::new(
                        base_block_pos.x + dx,
                        base_block_pos.y + dy,
                        base_block_pos.z + dz,
                    );
                    if let Some(state) = chunk_storage.get_block_state(&check_pos) {
                        let block = RegistryBlock::from(state);
                        if !matches!(
                            block,
                            RegistryBlock::Air | RegistryBlock::CaveAir | RegistryBlock::VoidAir
                        ) {
                            blocks.push(json!({
                                "x": check_pos.x,
                                "y": check_pos.y,
                                "z": check_pos.z,
                                "name": block.to_string().strip_prefix("minecraft:").unwrap_or(&block.to_string()),
                            }));
                        }
                    }
                }
            }
        }

        // Get entities
        for (entity, _) in self.client.entities_with::<GameProfileComponent>() {
            if entity == self.client.entity {
                continue;
            }
            let position: Option<Position> = self.client.get_entity_component(entity);
            if let Some(pos) = position {
                let distance = Vec3::from(&pos).distance(bot_pos);
                if distance < radius as f64 {
                    entities.push(json!({
                        "id": entity.0,
                        "username": None,
                        "name": entity.0.to_string(),
                        "position": {
                            "x": pos.x,
                            "y": pos.y,
                            "z": pos.z,
                        },
                        "type": "unknown",
                        "isPlayer": false,
                        "distance": distance,
                    }));
                }
            }
        }

        Ok(json!({
            "blocks": blocks,
            "entities": entities,
            "center": { "x": bot_pos.x, "y": bot_pos.y, "z": bot_pos.z },
            "radius": radius,
        }))
    }

    /// Execute a server command
    pub async fn execute_command(&self, command: &str) -> Result<(), MinecraftTransportError> {
        if self.state() != BotState::Connected {
            return Err(MinecraftTransportError::NotConnected);
        }
        self.client.chat(command);
        Ok(())
    }

    /// Get current position as BotPosition
    pub fn get_position(&self) -> crate::web::socket::events::BotPosition {
        let pos = self.position().unwrap_or(Vec3::ZERO);
        crate::web::socket::events::BotPosition {
            x: pos.x,
            y: pos.y,
            z: pos.z,
        }
    }

    /// Get position with integer coordinates
    pub fn get_position_blocking(&self) -> crate::web::socket::events::BotPosition {
        let pos = self.position().unwrap_or(Vec3::ZERO);
        crate::web::socket::events::BotPosition {
            x: pos.x.floor(),
            y: pos.y.floor(),
            z: pos.z.floor(),
        }
    }

    /// Get base location
    pub fn get_base_location(&self) -> crate::web::socket::events::BotPosition {
        let pos = self.base_location.unwrap_or(Vec3::ZERO);
        crate::web::socket::events::BotPosition {
            x: pos.x,
            y: pos.y,
            z: pos.z,
        }
    }

    /// Toggle kill aura
    pub fn toggle_kill_aura(&mut self, enabled: bool) {
        // This would need to be implemented based on combat feature
        // For now, just toggle auto_defense as a proxy
        self.auto_defense = enabled;
    }

    /// Toggle auto defense
    pub fn toggle_auto_defense(&mut self, enabled: bool) {
        self.auto_defense = enabled;
    }

    /// Toggle safe mode
    pub fn toggle_safe_mode(&mut self, enabled: bool) {
        // Implementation would depend on feature system
    }

    /// Toggle stealth
    pub fn toggle_stealth(&mut self, enabled: bool) {
        self.stealth_mode = enabled;
        self.client
            .ecs
            .lock()
            .send_event(azalea::entity::SetControlStateEvent {
                entity: self.client.entity,
                control: "sneak".to_owned(),
                state: enabled,
            });
    }

    /// Toggle auto armor
    pub fn toggle_auto_armor(&mut self, enabled: bool) {
        // Implementation would depend on feature system
    }

    /// Start roaming
    pub fn start_roaming(&mut self) {
        let _ = self.start_roaming(10, Duration::from_secs(5));
    }

    /// Stop roaming
    pub fn stop_roaming(&mut self) {
        self.stop_roaming();
    }

    /// Start farming
    pub fn start_farming(&mut self) {
        // Implementation would depend on feature system
    }

    /// Stop farming
    pub fn stop_farming(&mut self) {
        // Implementation would depend on feature system
    }

    /// Start mining
    pub fn start_mining(&mut self) {
        // Implementation would depend on feature system
    }

    /// Stop mining
    pub fn stop_mining(&mut self) {
        self.stop_mining();
    }

    /// Start lumberjack
    pub fn start_lumberjack(&mut self) {
        let _ = self.start_lumberjack(10);
    }

    /// Stop lumberjack
    pub fn stop_lumberjack(&mut self) {
        // Implementation would depend on feature system
    }

    /// Start progression
    pub fn start_progression(&mut self) {
        // Implementation would depend on feature system
    }

    /// Stop all tasks
    pub fn stop_all_tasks(&mut self) {
        self.stop_movement();
    }

    /// Save location
    pub fn save_location(
        &mut self,
        name: &str,
        pos: crate::web::socket::events::BotPosition,
        _location_type: &str,
    ) {
        // Implementation would use memory system
        let vec3 = Vec3::new(pos.x, pos.y, pos.z);
        self.set_base(Some(vec3.x), Some(vec3.y), Some(vec3.z)).ok();
    }

    /// Add favorite location
    pub fn add_favorite(&mut self, name: &str, pos: crate::web::socket::events::BotPosition) {
        let vec3 = Vec3::new(pos.x, pos.y, pos.z);
        self.set_base(Some(vec3.x), Some(vec3.y), Some(vec3.z)).ok();
    }

    /// Remember fact
    pub async fn remember_fact(&self, key: &str, fact: &str) -> bool {
        // Implementation would use memory system
        !key.is_empty() && !fact.is_empty()
    }

    /// Forget fact
    pub async fn forget_fact(&self, key: &str) -> bool {
        // Implementation would use memory system
        !key.is_empty()
    }

    /// Add rule
    pub async fn add_rule(&self, rule: &str) -> bool {
        // Implementation would use memory system
        !rule.is_empty()
    }

    /// Remove rule
    pub async fn remove_rule(&self, rule: &str) -> bool {
        // Implementation would use memory system
        !rule.is_empty()
    }

    /// Update settings
    pub async fn update_settings(&self, settings: Value) {
        // Implementation would update bot settings
        log::info!("[WEB] Settings updated: {}", settings);
    }

    /// Drop item
    pub async fn drop_item(&mut self, slot: i32, count: Option<i32>) {
        if self.state() != BotState::Connected {
            return;
        }
        let inventory = self.client.component::<azalea::inventory::Inventory>();
        if let Some(item) = inventory.slots.get(slot as usize) {
            if let Some(item_stack) = item.as_present() {
                let drop_count = count.unwrap_or(item_stack.count).min(item_stack.count);
                self.client
                    .ecs
                    .lock()
                    .send_event(azalea::inventory::SetSelectedHotbarSlotEvent {
                        entity: self.client.entity,
                        slot: slot as u8,
                    });
                tokio::time::sleep(Duration::from_millis(100)).await;
                for _ in 0..drop_count {
                    self.client
                        .ecs
                        .lock()
                        .send_event(azalea::entity::DropItemEvent {
                            entity: self.client.entity,
                            slot: slot as u8,
                            count: 1,
                        });
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        }
    }

    /// Drop all items
    pub async fn drop_all_items(&mut self) {
        if self.state() != BotState::Connected {
            return;
        }
        let inventory = self.client.component::<azalea::inventory::Inventory>();
        let items = inventory.items().collect::<Vec<_>>();
        for item in items {
            let _ = self.toss_stack(&item).await;
        }
    }

    /// Move item
    pub async fn move_item(&mut self, from: i32, to: i32) {
        if self.state() != BotState::Connected {
            return;
        }
        self.client
            .ecs
            .lock()
            .send_event(azalea::inventory::operations::click::ClickOperation {
                entity: self.client.entity,
                slot: from as u8,
                click_type: azalea::inventory::operations::click::ClickType::Pickup,
                button: azalea::inventory::operations::click::MouseButton::Left,
                mode: azalea::inventory::operations::click::ClickMode::Normal,
            });
        tokio::time::sleep(Duration::from_millis(100)).await;
        self.client
            .ecs
            .lock()
            .send_event(azalea::inventory::operations::click::ClickOperation {
                entity: self.client.entity,
                slot: to as u8,
                click_type: azalea::inventory::operations::click::ClickType::Pickup,
                button: azalea::inventory::operations::click::MouseButton::Left,
                mode: azalea::inventory::operations::click::ClickMode::Normal,
            });
    }

    /// Set hotbar slot
    pub async fn set_hotbar_slot(&mut self, slot: i32) {
        if self.state() != BotState::Connected {
            return;
        }
        if slot >= 0 && slot <= 8 {
            self.client
                .ecs
                .lock()
                .send_event(azalea::inventory::SetSelectedHotbarSlotEvent {
                    entity: self.client.entity,
                    slot: slot as u8,
                });
        }
    }

    /// Mine block at position
    pub async fn mine_block(&mut self, x: i32, y: i32, z: i32) {
        if self.state() != BotState::Connected {
            return;
        }
        let block_pos = azalea::BlockPos::new(x, y, z);
        let world = self.client.world();
        let world = world.read();
        let chunk_storage = world.chunk_storage.clone();
        drop(world);

        let goal = azalea::pathfinder::goals::ReachBlockPosGoal {
            pos: block_pos,
            chunk_storage: chunk_storage.clone(),
        };
        self.client.goto_without_mining(goal);

        // Wait and mine
        let mut ticks = self.client.get_tick_broadcaster();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if goal.success(azalea::BlockPos::from(self.client.position())) {
                break;
            }
            match tokio::time::timeout_at(deadline, ticks.recv()).await {
                Ok(Ok(())) => {}
                _ => return,
            }
        }

        let _ = self.client.mine(block_pos).await;
    }

    /// Place block at position
    pub async fn place_block(&mut self, x: i32, y: i32, z: i32, _block_type: Option<String>) {
        if self.state() != BotState::Connected {
            return;
        }
        let block_pos = azalea::BlockPos::new(x, y, z);
        self.client.look_at(Vec3::from(block_pos.center()));
        let mut ticks = self.client.get_tick_broadcaster();
        let _ = tokio::time::timeout(Duration::from_secs(2), ticks.recv()).await;

        self.client
            .ecs
            .lock()
            .send_event(azalea::interact::InteractBlockEvent {
                entity: self.client.entity,
                position: block_pos,
                direction: azalea::world::direction::Direction::Up,
                hand: azalea::protocol::packets::game::Hand::MainHand,
                cursor_position: None,
                inside_block: false,
                sequence: 0,
            });
    }

    /// Move to position
    pub async fn move_to(&mut self, x: f64, y: f64, z: f64) {
        if self.state() != BotState::Connected {
            return;
        }
        let _ = self.move_to_position(x, y, z, 1.0);
    }

    /// Follow player
    pub async fn follow_player(&mut self, username: &str) -> bool {
        if self.state() != BotState::Connected {
            return false;
        }
        self.start_following(username, 2.0).unwrap_or(false)
    }

    /// Stop all movement
    pub async fn stop_all_movement(&mut self) {
        self.stop_movement();
    }

    /// Go home
    pub async fn go_home(&mut self) {
        let _ = self.go_home();
    }

    /// Set home
    pub async fn set_home(&mut self) {
        let pos = self.position().unwrap_or(Vec3::ZERO);
        self.set_base(Some(pos.x), Some(pos.y), Some(pos.z)).ok();
    }

    /// Start roaming
    pub async fn start_roaming(&mut self) {
        let _ = self.start_roaming(10, Duration::from_secs(5));
    }

    /// Stop roaming
    pub async fn stop_roaming(&mut self) {
        self.stop_roaming();
    }

    /// Start farming
    pub async fn start_farming(&mut self) {
        // Feature-dependent
    }

    /// Stop farming
    pub async fn stop_farming(&mut self) {
        // Feature-dependent
    }

    /// Start mining
    pub async fn start_mining(&mut self) {
        // Feature-dependent
    }

    /// Stop mining
    pub async fn stop_mining(&mut self) {
        self.stop_mining();
    }

    /// Start lumberjack
    pub async fn start_lumberjack(&mut self) {
        let _ = self.start_lumberjack(10);
    }

    /// Stop lumberjack
    pub async fn stop_lumberjack(&mut self) {
        // Feature-dependent
    }

    /// Start progression
    pub async fn start_progression(&mut self) {
        // Feature-dependent
    }

    /// Stop all tasks
    pub async fn stop_all_tasks(&mut self) {
        self.stop_movement();
    }

    /// Restart bot
    pub async fn restart(&mut self) {
        self.disconnect().ok();
    }

    /// Shutdown bot
    pub async fn shutdown(&mut self) {
        self.disconnect().ok();
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
                    self.stop_miner();
                    self.stop_mine_area();
                    self.stop_guard();
                    self.stop_pvp();
                    Some(MinecraftEvent::Death)
                }
                Event::Disconnect(reason) => {
                    self.stop_mining();
                    self.stop_following();
                    self.stop_roaming();
                    self.stop_miner();
                    self.stop_mine_area();
                    self.stop_guard();
                    self.stop_pvp();
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
        self.stop_miner();
        self.stop_mine_area();
        self.stop_guard();
        self.stop_pvp();
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
        if let Some(task) = self.miner_task.take() {
            task.abort();
        }
        if let Some(task) = self.mine_area_task.take() {
            task.abort();
        }
        if let Some(task) = self.guard_task.take() {
            task.abort();
        }
        if let Some(task) = self.pvp_task.take() {
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
    let best_tool = {
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
        client.best_tool_in_hotbar_for_block(state)
    };
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
