use std::sync::Arc;
use tokio::sync::RwLock;

use mc_ai_bot_core::{
    bot::minecraft::MinecraftEvent,
    bot::runtime::{MinecraftRuntime, MinecraftRuntimeEvent},
    config::AppConfig,
    web::server::WebServerBuilder,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let app_config = Arc::new(AppConfig::from_env()?);
    let validation_errors = app_config.validate();
    if !validation_errors.is_empty() {
        return Err(format!("Invalid configuration: {}", validation_errors.join("; ")).into());
    }

    // Initialize and start web server
    let mut web_server = WebServerBuilder::new()
        .config(app_config.clone())
        .build()
        .await?;

    // Wrap runtime in Arc<RwLock> for sharing with web server
    let runtime = Arc::new(RwLock::new(MinecraftRuntime::from_app_config(
        app_config.as_ref().clone(),
    )));

    // Set runtime on web server
    web_server.set_runtime(runtime.clone()).await;

    // Start web server
    web_server.start().await?;

    let shutdown_signal = tokio::signal::ctrl_c();
    tokio::pin!(shutdown_signal);

    loop {
        tokio::select! {
            signal_result = &mut shutdown_signal => {
                signal_result?;
                log::info!("Shutdown signal received, stopping services...");
                runtime.write().await.shutdown()?;
                web_server.stop().await;
                break;
            }
            event_result = async {
                runtime.write().await.next_event().await
            } => {
                match event_result? {
                    Some(event) => {
                        println!("{event:?}");
                        // Update web state with connection if we just connected
                        if let MinecraftRuntimeEvent::Minecraft(MinecraftEvent::Login) = &event {
                            // The connection is now available in runtime, web server can access it via runtime
                        }
                    }
                    None => break,
                }
            }
        }
    }

    Ok(())
}
