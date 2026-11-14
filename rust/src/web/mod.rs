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
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Socket-specific data stored by socket ID
#[derive(Debug, Clone, Default)]
pub struct SocketData {
    pub user: Option<crate::web::auth::UserRole>,
    pub username: Option<String>,
    pub handshake_auth: Option<serde_json::Value>,
    pub handshake_query: Option<serde_json::Value>,
}

/// Web server state shared between HTTP and Socket.io handlers
#[derive(Clone)]
pub struct WebState {
    pub config: Arc<AppConfig>,
    pub connection: Arc<RwLock<Option<MinecraftConnection>>>,
    pub runtime: Arc<RwLock<Option<Arc<RwLock<MinecraftRuntime>>>>>,
    pub socket_io: Arc<RwLock<Option<socketioxide::SocketIo>>>,
    pub socket_data: Arc<RwLock<HashMap<String, SocketData>>>,
}

impl WebState {
    pub fn new(config: Arc<AppConfig>) -> Self {
        Self {
            config,
            connection: Arc::new(RwLock::new(None)),
            runtime: Arc::new(RwLock::new(None)),
            socket_io: Arc::new(RwLock::new(None)),
            socket_data: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn set_connection(&self, conn: MinecraftConnection) {
        *self.connection.write().await = Some(conn);
    }

    pub async fn set_runtime(&self, runtime: Arc<RwLock<MinecraftRuntime>>) {
        *self.runtime.write().await = Some(runtime);
    }

    pub async fn set_socket_io(&self, socket_io: Option<socketioxide::SocketIo>) {
        *self.socket_io.write().await = socket_io;
    }

    pub async fn get_socket_io(&self) -> Result<socketioxide::SocketIo, String> {
        self.socket_io
            .read()
            .await
            .clone()
            .ok_or_else(|| "Socket.io not initialized".to_string())
    }

    /// Get socket data by socket ID
    pub async fn get_socket_data(&self, socket_id: &str) -> Option<SocketData> {
        self.socket_data.read().await.get(socket_id).cloned()
    }

    /// Set socket data by socket ID
    pub async fn set_socket_data(&self, socket_id: String, data: SocketData) {
        self.socket_data.write().await.insert(socket_id, data);
    }

    /// Remove socket data by socket ID (on disconnect)
    pub async fn remove_socket_data(&self, socket_id: &str) {
        self.socket_data.write().await.remove(socket_id);
    }

    pub async fn clear(&self) {
        *self.connection.write().await = None;
        // Note: runtime is not cleared as it's shared with main
    }
}

pub use auth::{Claims, TokenPayload, generate_token, verify_token};
pub use rate_limit::{RateLimitConfig, RateLimitKey, RateLimiter};
pub use server::WebServer;
