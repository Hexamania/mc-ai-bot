/**
 * Web server module for mc-ai-bot
 * Axum server with Socket.io for real-time dashboard
 */
pub mod auth;
pub mod rate_limit;
pub mod routes;
pub mod server;
pub mod socket;

use crate::{
    bot::minecraft::MinecraftConnection, bot::runtime::MinecraftRuntime, config::AppConfig,
};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Web server state shared between HTTP and Socket.io handlers
#[derive(Clone)]
pub struct WebState {
    pub config: Arc<AppConfig>,
    pub connection: Arc<RwLock<Option<MinecraftConnection>>>,
    pub runtime: Option<Arc<RwLock<MinecraftRuntime>>>,
}

impl WebState {
    pub fn new(config: Arc<AppConfig>) -> Self {
        Self {
            config,
            connection: Arc::new(RwLock::new(None)),
            runtime: None,
        }
    }

    pub async fn set_connection(&self, conn: MinecraftConnection) {
        *self.connection.write().await = Some(conn);
    }

    pub fn set_runtime(&mut self, runtime: Arc<RwLock<MinecraftRuntime>>) {
        self.runtime = Some(runtime);
    }

    pub async fn clear(&self) {
        *self.connection.write().await = None;
        // Note: runtime is not cleared as it's shared with main
    }
}

pub use auth::{Claims, TokenPayload, generate_token, verify_token};
pub use rate_limit::{RateLimitConfig, RateLimitKey, RateLimiter};
pub use server::WebServer;
