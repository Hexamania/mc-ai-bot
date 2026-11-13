use std::time::Duration;

use thiserror::Error;
use tokio::time::sleep;

use crate::{
    bot::{
        minecraft::{MinecraftConnection, MinecraftEvent, MinecraftTransportError},
        state_machine::{BotState, StateMachine},
    },
    config::BotConfig,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MinecraftRuntimeEvent {
    Minecraft(MinecraftEvent),
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
    #[error("Invalid bot state transition: {0}")]
    StateTransition(#[from] crate::bot::state_machine::InvalidTransition),
}

pub struct MinecraftRuntime {
    config: BotConfig,
    connection: Option<MinecraftConnection>,
    state_machine: StateMachine,
    reconnect_attempt: u32,
    fatal_error: Option<MinecraftRuntimeError>,
}

impl MinecraftRuntime {
    pub fn new(config: BotConfig) -> Self {
        Self {
            config,
            connection: None,
            state_machine: StateMachine::default(),
            reconnect_attempt: 0,
            fatal_error: None,
        }
    }

    pub fn state(&self) -> BotState {
        self.state_machine.state()
    }

    pub fn username(&self) -> Option<&str> {
        self.connection.as_ref().map(MinecraftConnection::username)
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
            Some(event) => Ok(Some(MinecraftRuntimeEvent::Minecraft(event))),
        }
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
            BotState::Error => self.state_machine.transition(BotState::ShuttingDown)?,
            BotState::Disconnected | BotState::Connecting | BotState::Reconnecting => {
                self.state_machine.transition(BotState::Disconnected)?;
            }
            BotState::ShuttingDown => {}
        }
        self.state_machine.transition(BotState::Shutdown)?;
        Ok(())
    }
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
}
