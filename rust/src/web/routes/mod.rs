/**
 * Routes module for web server
 */
pub mod api;

use crate::web::WebState;
use axum::Router;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Create all routes
pub fn create_routes(state: Arc<RwLock<WebState>>) -> Router {
    api::create_api_router(state)
}
