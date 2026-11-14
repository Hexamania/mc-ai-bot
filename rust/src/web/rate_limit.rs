/**
 * Rate limiting middleware for web server
 * Uses in-memory store with sliding window algorithm
 */
use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::warn;

use crate::config::AppConfig;

/// Rate limit entry for a key
#[derive(Debug, Clone)]
struct RateLimitEntry {
    count: u32,
    window_start: Instant,
}

/// Configuration for rate limiting
#[derive(Debug, Clone)]
pub struct RateLimitConfig {
    pub window: Duration,
    pub max_requests: u32,
    pub message: String,
    pub status_code: StatusCode,
    pub key_generator: fn(&Request, &HeaderMap) -> String,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            window: Duration::from_secs(60),
            max_requests: 100,
            message: "Too many requests, please try again later".to_string(),
            status_code: StatusCode::TOO_MANY_REQUESTS,
            key_generator: default_key_generator,
        }
    }
}

/// Default key generator using IP address
fn default_key_generator(request: &Request, _headers: &HeaderMap) -> String {
    // Try to get real IP from headers (for reverse proxy)
    if let Some(forwarded) = request.headers().get("x-forwarded-for") {
        if let Ok(ip) = forwarded.to_str() {
            return ip.split(',').next().unwrap_or("unknown").trim().to_string();
        }
    }
    if let Some(real_ip) = request.headers().get("x-real-ip") {
        if let Ok(ip) = real_ip.to_str() {
            return ip.to_string();
        }
    }

    // Fall back to socket address
    request
        .extensions()
        .get::<SocketAddr>()
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Rate limiter store
#[derive(Clone)]
pub struct RateLimiter {
    store: Arc<RwLock<HashMap<String, RateLimitEntry>>>,
    config: RateLimitConfig,
    cleanup_interval: Duration,
}

impl RateLimiter {
    /// Create a new rate limiter with default config
    pub fn new(config: RateLimitConfig) -> Self {
        let store = Arc::new(RwLock::new(HashMap::new()));
        let cleanup_interval = config.window;

        // Start cleanup task
        let store_clone = store.clone();
        let window = config.window;
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(cleanup_interval);
            loop {
                interval.tick().await;
                let now = Instant::now();
                let mut store = store_clone.write().await;
                store.retain(|_, entry| now.duration_since(entry.window_start) < window);
            }
        });

        Self {
            store,
            config,
            cleanup_interval,
        }
    }

    /// Create rate limiter for auth endpoints (strict)
    pub fn auth() -> Self {
        Self::new(RateLimitConfig {
            window: Duration::from_secs(15 * 60), // 15 minutes
            max_requests: 5,
            message: "Too many login attempts, please try again later".to_string(),
            status_code: StatusCode::TOO_MANY_REQUESTS,
            key_generator: default_key_generator,
        })
    }

    /// Create rate limiter for API endpoints (moderate)
    pub fn api() -> Self {
        Self::new(RateLimitConfig {
            window: Duration::from_secs(60), // 1 minute
            max_requests: 60,
            message: "Too many API requests, please slow down".to_string(),
            status_code: StatusCode::TOO_MANY_REQUESTS,
            key_generator: default_key_generator,
        })
    }

    /// Create rate limiter for static assets (lenient)
    pub fn static_assets() -> Self {
        Self::new(RateLimitConfig {
            window: Duration::from_secs(60),
            max_requests: 200,
            message: "Too many requests".to_string(),
            status_code: StatusCode::TOO_MANY_REQUESTS,
            key_generator: default_key_generator,
        })
    }

    /// Create rate limiter for command execution (strict)
    pub fn commands() -> Self {
        Self::new(RateLimitConfig {
            window: Duration::from_secs(60),
            max_requests: 30,
            message: "Too many commands, please wait".to_string(),
            status_code: StatusCode::TOO_MANY_REQUESTS,
            key_generator: command_key_generator,
        })
    }

    /// Create rate limiter for WebSocket connections
    pub fn websocket() -> Self {
        Self::new(RateLimitConfig {
            window: Duration::from_secs(60),
            max_requests: 20,
            message: "Too many connection attempts".to_string(),
            status_code: StatusCode::TOO_MANY_REQUESTS,
            key_generator: websocket_key_generator,
        })
    }

    /// Check and increment rate limit for a key
    pub async fn check(&self, key: &str) -> Result<RateLimitInfo, RateLimitExceeded> {
        let mut store = self.store.write().await;
        let now = Instant::now();

        let entry = store.entry(key.to_string()).or_insert(RateLimitEntry {
            count: 0,
            window_start: now,
        });

        // Reset window if expired
        if now.duration_since(entry.window_start) >= self.config.window {
            entry.count = 0;
            entry.window_start = now;
        }

        // Check limit
        if entry.count >= self.config.max_requests {
            let retry_after = self.config.window - now.duration_since(entry.window_start);
            return Err(RateLimitExceeded {
                retry_after: retry_after.as_secs(),
                limit: self.config.max_requests,
                remaining: 0,
                reset_time: (entry.window_start + self.config.window)
                    .elapsed()
                    .as_secs(),
            });
        }

        // Increment and return info
        entry.count += 1;
        Ok(RateLimitInfo {
            limit: self.config.max_requests,
            remaining: self.config.max_requests - entry.count,
            reset_time: (entry.window_start + self.config.window)
                .elapsed()
                .as_secs(),
        })
    }

    /// Get current rate limit status for a key
    pub async fn get_status(&self, key: &str) -> Option<RateLimitInfo> {
        let store = self.store.read().await;
        let now = Instant::now();

        store.get(key).and_then(|entry| {
            if now.duration_since(entry.window_start) >= self.config.window {
                None
            } else {
                Some(RateLimitInfo {
                    limit: self.config.max_requests,
                    remaining: self.config.max_requests.saturating_sub(entry.count),
                    reset_time: (entry.window_start + self.config.window)
                        .elapsed()
                        .as_secs(),
                })
            }
        })
    }

    /// Reset rate limit for a key
    pub async fn reset(&self, key: &str) {
        self.store.write().await.remove(key);
    }

    /// Clear all rate limits
    pub async fn clear_all(&self) {
        self.store.write().await.clear();
    }
}

/// Rate limit info for headers
#[derive(Debug, Clone)]
pub struct RateLimitInfo {
    pub limit: u32,
    pub remaining: u32,
    pub reset_time: u64,
}

/// Rate limit exceeded error
#[derive(Debug, Clone)]
pub struct RateLimitExceeded {
    pub retry_after: u64,
    pub limit: u32,
    pub remaining: u32,
    pub reset_time: u64,
}

impl IntoResponse for RateLimitExceeded {
    fn into_response(self) -> Response {
        let mut response = Json(serde_json::json!({
            "success": false,
            "error": "Too many requests, please try again later",
            "code": "RATE_LIMIT_EXCEEDED",
            "retryAfter": self.retry_after,
        }))
        .into_response();

        let headers = response.headers_mut();
        headers.insert(
            header::RETRY_AFTER,
            self.retry_after.to_string().parse().unwrap(),
        );
        headers.insert("X-RateLimit-Limit", self.limit.to_string().parse().unwrap());
        headers.insert(
            "X-RateLimit-Remaining",
            self.remaining.to_string().parse().unwrap(),
        );
        headers.insert(
            "X-RateLimit-Reset",
            self.reset_time.to_string().parse().unwrap(),
        );

        *response.status_mut() = StatusCode::TOO_MANY_REQUESTS;
        response
    }
}

/// Rate limit key for different limiters
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitKey {
    Auth,
    Api,
    Static,
    Commands,
    WebSocket,
}

/// Rate limiter middleware
pub async fn rate_limit_middleware(
    State(limiters): State<Arc<RateLimiters>>,
    request: Request,
    next: Next,
) -> Response {
    // Determine which limiter to use based on path
    let path = request.uri().path();
    let key = if path.starts_with("/api/auth/") {
        limiters
            .auth
            .check(&default_key_generator(&request, request.headers()))
            .await
    } else if path.starts_with("/api/commands/") || path == "/api/commands/execute" {
        limiters
            .commands
            .check(&command_key_generator(&request, request.headers()))
            .await
    } else if path.starts_with("/api/") {
        limiters
            .api
            .check(&default_key_generator(&request, request.headers()))
            .await
    } else {
        limiters
            .static_assets
            .check(&default_key_generator(&request, request.headers()))
            .await
    };

    match key {
        Ok(info) => {
            let mut response = next.run(request).await;
            let headers = response.headers_mut();
            headers.insert("X-RateLimit-Limit", info.limit.to_string().parse().unwrap());
            headers.insert(
                "X-RateLimit-Remaining",
                info.remaining.to_string().parse().unwrap(),
            );
            headers.insert(
                "X-RateLimit-Reset",
                info.reset_time.to_string().parse().unwrap(),
            );
            response
        }
        Err(err) => err.into_response(),
    }
}

/// Command key generator includes user info
fn command_key_generator(request: &Request, _headers: &HeaderMap) -> String {
    let ip = default_key_generator(request, _headers);
    // Try to get username from auth claims
    let username = request
        .extensions()
        .get::<crate::web::auth::Claims>()
        .map(|c| c.sub.as_str())
        .unwrap_or("anonymous");
    format!("cmd:{}:{}", ip, username)
}

/// WebSocket key generator
fn websocket_key_generator(request: &Request, _headers: &HeaderMap) -> String {
    format!("ws:{}", default_key_generator(request, _headers))
}

/// Container for all rate limiters
#[derive(Clone)]
pub struct RateLimiters {
    pub auth: RateLimiter,
    pub api: RateLimiter,
    pub static_assets: RateLimiter,
    pub commands: RateLimiter,
    pub websocket: RateLimiter,
}

impl Default for RateLimiters {
    fn default() -> Self {
        Self {
            auth: RateLimiter::auth(),
            api: RateLimiter::api(),
            static_assets: RateLimiter::static_assets(),
            commands: RateLimiter::commands(),
            websocket: RateLimiter::websocket(),
        }
    }
}

/// Create rate limiters from config
pub fn create_rate_limiters(_config: &AppConfig) -> RateLimiters {
    RateLimiters::default()
}
