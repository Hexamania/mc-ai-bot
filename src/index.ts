/**
 * Main entry point for mc-ai-bot
 * Initializes and coordinates all modules
 */

import type { BotManager } from './bot';
import { createBotManager } from './bot';
import { createWebServer, type WebServer } from './web';
import {
  getCommandRegistry,
  registerHelpCommand,
  registerPingCommand,
  registerCoordsCommand,
} from './commands';
import { registerBotCommands } from './commands/botCommands';
import { loadMemory, persistMemory } from './memory';
import { registerBuiltinFeatures, getFeatureRegistry } from './plugins';
import { getConfig } from './config';

/**
 * Application class - main coordinator
 */
export class Application {
  private botManager: BotManager;
  private webServer: WebServer;
  private isShuttingDown = false;

  constructor() {
    // Load configuration
    void getConfig();

    // Load persistent memory
    loadMemory();

    // Create bot manager
    this.botManager = createBotManager();

    // Create web server
    this.webServer = createWebServer(this.botManager);

    // Register built-in features
    const featureRegistry = getFeatureRegistry();
    registerBuiltinFeatures(featureRegistry);

    // Register all bot commands
    registerBotCommands(this.botManager);

    // Register core commands
    this.registerCoreCommands();

    // Set up graceful shutdown
    this.setupShutdownHandlers();
  }

  /**
   * Register core commands (help, ping, coords, etc.)
   */
  private registerCoreCommands(): void {
    const registry = getCommandRegistry();
    const config = getConfig();

    // Help command
    registerHelpCommand(registry, config.prefix.public);

    // Ping command
    registerPingCommand(registry);

    // Coords command
    registerCoordsCommand(registry);
  }

  /**
   * Set up graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      console.log(`\n[APP] Received ${signal}, shutting down gracefully...`);

      try {
        // Shutdown bot manager
        await this.botManager.shutdown();

        // Stop web server
        await this.webServer.stop();

        // Save memory
        persistMemory();

        console.log('[APP] Shutdown complete');
        process.exit(0);
      } catch (error) {
        console.error('[APP] Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('[APP] Uncaught exception:', error);
      if (!this.isShuttingDown) {
        void shutdown('uncaughtException').catch(() => {
          /* ignore */
        });
      }
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[APP] Unhandled rejection:', reason);
    });
  }

  /**
   * Start the application
   */
  async start(): Promise<void> {
    console.log('[APP] Starting mc-ai-bot...');

    // Start web server
    await this.webServer.start();

    // Connect bot (this is async and runs in background)
    this.botManager.connectBot();

    console.log('[APP] Application started successfully');
  }

  /**
   * Get bot manager instance
   */
  getBotManager(): BotManager {
    return this.botManager;
  }

  /**
   * Get web server instance
   */
  getWebServer(): WebServer {
    return this.webServer;
  }
}

/**
 * Create and start the application
 */
export async function createApp(): Promise<Application> {
  const app = new Application();
  await app.start();
  return app;
}

// Auto-start if this is the main module
// Using CommonJS check since TypeScript compiles to CommonJS output
const isMainModule = typeof require !== 'undefined' && require.main === module;

if (isMainModule) {
  createApp().catch((error) => {
    console.error('[APP] Failed to start:', error);
    process.exit(1);
  });
}

export { Application as default };
