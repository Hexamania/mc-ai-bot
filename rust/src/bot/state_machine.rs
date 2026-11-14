use std::collections::VecDeque;

use chrono::Utc;
use thiserror::Error;

const HISTORY_LIMIT: usize = 100;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum BotState {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Error,
    ShuttingDown,
    Shutdown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransitionRecord {
    pub from: BotState,
    pub to: BotState,
    pub timestamp_ms: i64,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("invalid bot state transition: {from:?} -> {to:?}")]
pub struct InvalidTransition {
    pub from: BotState,
    pub to: BotState,
}

#[derive(Clone, Debug)]
pub struct StateMachine {
    current: BotState,
    history: VecDeque<TransitionRecord>,
}

impl Default for StateMachine {
    fn default() -> Self {
        Self::new(BotState::Disconnected)
    }
}

impl StateMachine {
    pub fn new(initial: BotState) -> Self {
        Self {
            current: initial,
            history: VecDeque::with_capacity(HISTORY_LIMIT),
        }
    }

    pub fn state(&self) -> BotState {
        self.current
    }

    pub fn can_transition(&self, to: BotState) -> bool {
        Self::is_allowed(self.current, to)
    }

    pub fn transition(&mut self, to: BotState) -> Result<bool, InvalidTransition> {
        if self.current == to {
            return Ok(true);
        }
        if !self.can_transition(to) {
            return Err(InvalidTransition {
                from: self.current,
                to,
            });
        }

        self.record_transition(to);
        Ok(true)
    }

    pub fn force_state(&mut self, to: BotState) {
        self.record_transition(to);
    }

    pub fn history(&self) -> &VecDeque<TransitionRecord> {
        &self.history
    }

    pub fn available_transitions(&self) -> Vec<BotState> {
        [
            BotState::Disconnected,
            BotState::Connecting,
            BotState::Connected,
            BotState::Reconnecting,
            BotState::Error,
            BotState::ShuttingDown,
            BotState::Shutdown,
        ]
        .into_iter()
        .filter(|to| Self::is_allowed(self.current, *to))
        .collect()
    }

    pub fn is_terminal(&self) -> bool {
        self.available_transitions().is_empty()
    }

    pub fn reset(&mut self, initial: BotState) {
        self.current = initial;
        self.history.clear();
    }

    fn record_transition(&mut self, to: BotState) {
        let from = self.current;
        self.current = to;
        if self.history.len() == HISTORY_LIMIT {
            self.history.pop_front();
        }
        self.history.push_back(TransitionRecord {
            from,
            to,
            timestamp_ms: Utc::now().timestamp_millis(),
        });
    }

    fn is_allowed(from: BotState, to: BotState) -> bool {
        use BotState::*;

        matches!(
            (from, to),
            (Disconnected, Connecting | Shutdown)
                | (Connecting, Connected | Reconnecting | Error | Disconnected)
                | (
                    Connected,
                    Reconnecting | Disconnected | Error | ShuttingDown
                )
                | (Reconnecting, Connecting | Connected | Error | Disconnected)
                | (Error, Reconnecting | Disconnected | ShuttingDown)
                | (ShuttingDown, Shutdown | Error)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permits_known_lifecycle_transitions_and_rejects_invalid_ones() {
        let mut machine = StateMachine::default();
        assert!(machine.transition(BotState::Connecting).unwrap());
        assert!(machine.transition(BotState::Connected).unwrap());
        assert_eq!(machine.state(), BotState::Connected);

        let error = machine.transition(BotState::Shutdown).unwrap_err();
        assert_eq!(
            error,
            InvalidTransition {
                from: BotState::Connected,
                to: BotState::Shutdown
            }
        );
        assert_eq!(machine.history().len(), 2);
    }

    #[test]
    fn shutdown_is_terminal_and_reset_clears_history() {
        let mut machine = StateMachine::default();
        machine.transition(BotState::Shutdown).unwrap();
        assert!(machine.is_terminal());

        machine.reset(BotState::Disconnected);
        assert!(!machine.is_terminal());
        assert!(machine.history().is_empty());
    }

    #[test]
    fn history_is_bounded_and_force_state_records_transitions() {
        let mut machine = StateMachine::default();
        for _ in 0..60 {
            machine.force_state(BotState::Connected);
            machine.force_state(BotState::Disconnected);
        }

        assert_eq!(machine.history().len(), HISTORY_LIMIT);
        assert_eq!(
            machine.history().back().map(|record| record.to),
            Some(BotState::Disconnected)
        );
    }
}
