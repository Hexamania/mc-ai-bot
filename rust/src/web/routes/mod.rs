/**
 * Routes module for web server
 */
pub mod api;

use crate::web::WebState;
use axum::Router;
use std::sync::Arc;

/// Create all routes with state
pub fn create_routes(state: Arc<WebState>) -> Router<()> {
    api::create_api_router(state)
}
