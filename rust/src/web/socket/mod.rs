/**
 * Socket.io module for web server
 */
pub mod events;
pub mod handlers;

use crate::web::WebState;
use socketioxide::SocketIo;
use std::sync::Arc;

/// Initialize Socket.io with all namespaces
pub fn initialize_socket_io(
    state: Arc<WebState>,
) -> Result<SocketIo, Box<dyn std::error::Error + Send + Sync>> {
    let (io, _) = SocketIo::new_serv();

    // Initialize all namespaces
    handlers::initialize_all_namespaces(&io, state)?;

    Ok(io)
}
