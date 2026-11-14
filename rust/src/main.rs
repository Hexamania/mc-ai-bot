use std::error::Error;

use mc_ai_bot_core::{bot::runtime::MinecraftRuntime, config::AppConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let app_config = AppConfig::from_env()?;
    let validation_errors = app_config.validate();
    if !validation_errors.is_empty() {
        return Err(format!("Invalid configuration: {}", validation_errors.join("; ")).into());
    }

    let mut runtime = MinecraftRuntime::from_app_config(app_config);
    let shutdown_signal = tokio::signal::ctrl_c();
    tokio::pin!(shutdown_signal);

    loop {
        tokio::select! {
            signal_result = &mut shutdown_signal => {
                signal_result?;
                runtime.shutdown()?;
                break;
            }
            event_result = runtime.next_event() => {
                match event_result? {
                    Some(event) => println!("{event:?}"),
                    None => break,
                }
            }
        }
    }

    Ok(())
}
