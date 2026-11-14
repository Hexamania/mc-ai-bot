/**
 * Socket.io module for web server
 */
pub mod events;
pub mod handlers;

use crate::web::WebState;
use socketioxide::SocketIo;
use std::sync::Arc;
use tower::ServiceBuilder;

/// Initialize Socket.io with all namespaces
pub fn initialize_socket_io(
    state: Arc<WebState>,
) -> Result<
    (ServiceBuilder<socketioxide::layer::SocketIoLayer>, SocketIo),
    Box<dyn std::error::Error + Send + Sync>,
> {
    let (layer, io) = SocketIo::new_layer();

    // Initialize all namespaces
    handlers::initialize_all_namespaces(&io, state)?;

    Ok((layer, io))
}
