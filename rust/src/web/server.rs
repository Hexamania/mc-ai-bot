/**
 * Main web server for mc-ai-bot
 * Axum HTTP server with Socket.io for real-time dashboard
 */
use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{Method, header},
    middleware,
    routing::get,
};
use socketioxide::SocketIo;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower::ServiceBuilder;
use tower_http::{
    compression::CompressionLayer,
    cors::{Any, CorsLayer},
    services::ServeDir,
    trace::TraceLayer,
};
use tracing::{info, warn};

use crate::{
    bot::minecraft::MinecraftConnection,
    bot::runtime::MinecraftRuntime,
    config::AppConfig,
    web::{
        WebState,
        auth::{auth_middleware, optional_auth_middleware},
        rate_limit::RateLimiters,
        routes, socket,
    },
};

/// Web server wrapper
pub struct WebServer {
    config: Arc<AppConfig>,
    state: Arc<WebState>,
    app: Router,
    socket_io: Option<SocketIo>,
    socket_io_layer: Option<ServiceBuilder<socketioxide::layer::SocketIoLayer>>,
    server_handle: Option<tokio::task::JoinHandle<()>>,
}

impl WebServer {
    /// Create a new web server
    pub async fn new(
        config: Arc<AppConfig>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let state = Arc::new(WebState::new(config.clone()));

        // Initialize Socket.io
        let (socket_io_layer, socket_io) = socket::initialize_socket_io(state.clone())?;

        // Set socket_io on WebState for broadcast functions
        state.set_socket_io(socket_io.clone()).await;

        // Create the HTTP router
        let app = create_router(state.clone(), socket_io.clone(), socket_io_layer.clone());

        Ok(Self {
            config,
            state,
            app,
            socket_io: Some(socket_io),
            socket_io_layer: Some(socket_io_layer),
            server_handle: None,
        })
    }

    /// Set the Minecraft connection
    pub async fn set_connection(&self, connection: MinecraftConnection) {
        self.state.set_connection(connection).await;
    }

    /// Set the Minecraft runtime (shared with main loop)
    pub async fn set_runtime(&self, runtime: Arc<RwLock<MinecraftRuntime>>) {
        self.state.set_runtime(runtime).await;
    }

    /// Clear connection and runtime
    pub async fn clear(&self) {
        self.state.clear().await;
    }

    /// Start the web server
    pub async fn start(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let port = self.config.web.port;
        let host = self
            .config
            .web
            .host
            .clone()
            .unwrap_or_else(|| "0.0.0.0".to_string());

        let listener = tokio::net::TcpListener::bind(format!("{}:{}", host, port)).await?;
        info!("[WEB] Dashboard running at http://{}:{}", host, port);
        info!("[WEB] API available at http://{}:{}/api", host, port);

        let app = self.app.clone();
        let handle = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });

        self.server_handle = Some(handle);
        Ok(())
    }

    /// Stop the web server
    pub async fn stop(&mut self) {
        if let Some(handle) = self.server_handle.take() {
            handle.abort();
            info!("[WEB] Web server stopped");
        }
    }

    /// Get the web state
    pub fn state(&self) -> Arc<WebState> {
        self.state.clone()
    }

    /// Get the Socket.io instance
    pub fn socket_io(&self) -> Option<&SocketIo> {
        self.socket_io.as_ref()
    }
}

/// Create the main router with all middleware and routes
fn create_router(
    state: Arc<WebState>,
    socket_io: Option<SocketIo>,
    socket_io_layer: Option<ServiceBuilder<socketioxide::layer::SocketIoLayer>>,
) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION, header::COOKIE])
        .allow_credentials(true);

    let mut router = Router::new()
        // Health check (no auth, no rate limit)
        .route("/health", get(health_check))
        // Serve static files for dashboard
        .nest_service(
            "/",
            ServeDir::new("public").append_index_html_on_directories(true),
        )
        // API routes (with auth and rate limiting)
        .nest("/api", routes::create_routes(state.clone()));

    // Add Socket.io layer if available
    if let Some(layer) = socket_io_layer {
        router = router.layer(layer);
    }

    // Add global middleware
    router = router
        .layer(
            ServiceBuilder::new()
                .layer(TraceLayer::new_for_http())
                .layer(CompressionLayer::new())
                .layer(cors)
                .layer(DefaultBodyLimit::max(10 * 1024 * 1024)), // 10MB
        )
        .with_state(state);

    router
}

/// Health check endpoint
async fn health_check() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "status": "ok",
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "uptime": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64(),
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// Web server builder for easier configuration
pub struct WebServerBuilder {
    config: Option<Arc<AppConfig>>,
}

impl WebServerBuilder {
    /// Create a new builder
    pub fn new() -> Self {
        Self { config: None }
    }

    /// Set the configuration
    pub fn config(mut self, config: Arc<AppConfig>) -> Self {
        self.config = Some(config);
        self
    }

    /// Build the web server
    pub async fn build(self) -> Result<WebServer, Box<dyn std::error::Error + Send + Sync>> {
        let config = self.config.ok_or("Config is required")?;
        WebServer::new(config).await
    }
}

impl Default for WebServerBuilder {
    fn default() -> Self {
        Self::new()
    }
}
