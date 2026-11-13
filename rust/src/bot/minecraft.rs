use azalea::{Account, Client, Event};
use thiserror::Error;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::{
    bot::state_machine::{BotState, InvalidTransition, StateMachine},
    config::BotConfig,
};

pub const SUPPORTED_MINECRAFT_VERSION: &str = "1.21.1";

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

#[derive(Debug, Error, PartialEq, Eq)]
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
        })
    }

    pub fn state(&self) -> BotState {
        self.state_machine.state()
    }

    pub fn username(&self) -> &str {
        &self.client.profile.name
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
                    Some(MinecraftEvent::PlayerLeft(player.profile.name.clone()))
                }
                Event::Death(_) => Some(MinecraftEvent::Death),
                Event::Disconnect(reason) => {
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

        if self.state() != BotState::Disconnected {
            self.state_machine.transition(BotState::Disconnected)?;
        }
        Ok(None)
    }
}

impl Drop for MinecraftConnection {
    fn drop(&mut self) {
        if self.state() == BotState::Connected {
            self.client.disconnect();
        }
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
}
