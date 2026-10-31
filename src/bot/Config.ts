/**
 * Configuration loader for the bot
 * Supports loading from environment variables, JSON files, and defaults
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BotConfig, ConfigLoaderOptions } from './types';

export class ConfigLoader {
  private options: Required<ConfigLoaderOptions>;
  private config: BotConfig;

  constructor(options: ConfigLoaderOptions = {}) {
    this.options = {
      configPath: options.configPath || path.join(process.cwd(), 'bot.config.json'),
      envPrefix: options.envPrefix || 'BOT_',
      defaults: options.defaults || {},
    };

    this.config = this.getDefaultConfig();
  }

  /**
   * Get default configuration
   */
  private getDefaultConfig(): BotConfig {
    return {
      host: process.env.MC_HOST || 'localhost',
      port: parseInt(process.env.MC_PORT || '25565', 10),
      username: process.env.MC_USERNAME || 'Bot',
      password: process.env.MC_PASSWORD,
      version: process.env.MC_VERSION || '1.21.1',
      auth: (process.env.MC_AUTH as BotConfig['auth']) || 'offline',
      checkTimeoutInterval: parseInt(process.env.MC_CHECK_TIMEOUT || '60000', 10),
      reconnect: {
        enabled: true,
        maxAttempts: 10,
        baseDelay: 1000,
        maxDelay: 60000,
        exponentialBackoff: true,
      },
      plugins: [],
      ...this.options.defaults,
    };
  }

  /**
   * Load configuration from all sources
   * Priority: defaults < config file < environment variables
   */
  load(): BotConfig {
    // 1. Load from config file if exists
    this.loadFromFile();

    // 2. Override with environment variables
    this.loadFromEnv();

    // 3. Validate configuration
    this.validate();

    return this.config;
  }

  /**
   * Load configuration from JSON file
   */
  private loadFromFile(): void {
    try {
      if (fs.existsSync(this.options.configPath)) {
        const fileContent = fs.readFileSync(this.options.configPath, 'utf-8');
        const fileConfig = JSON.parse(fileContent);
        this.mergeConfig(fileConfig);
      }
    } catch (error) {
      console.warn(`[Config] Failed to load config file: ${(error as Error).message}`);
    }
  }

  /**
   * Load configuration from environment variables
   */
  private loadFromEnv(): void {
    const prefix = this.options.envPrefix;

    // Bot connection settings
    if (process.env[`${prefix}HOST`]) this.config.host = process.env[`${prefix}HOST`]!;
    if (process.env[`${prefix}PORT`])
      this.config.port = parseInt(process.env[`${prefix}PORT`]!, 10);
    if (process.env[`${prefix}USERNAME`]) this.config.username = process.env[`${prefix}USERNAME`]!;
    if (process.env[`${prefix}PASSWORD`]) this.config.password = process.env[`${prefix}PASSWORD`];
    if (process.env[`${prefix}VERSION`]) this.config.version = process.env[`${prefix}VERSION`]!;
    if (process.env[`${prefix}AUTH`])
      this.config.auth = process.env[`${prefix}AUTH`]! as BotConfig['auth'];
    if (process.env[`${prefix}CHECK_TIMEOUT`]) {
      this.config.checkTimeoutInterval = parseInt(process.env[`${prefix}CHECK_TIMEOUT`]!, 10);
    }

    // Reconnect settings
    if (process.env[`${prefix}RECONNECT_ENABLED`]) {
      this.config.reconnect.enabled = process.env[`${prefix}RECONNECT_ENABLED`] === 'true';
    }
    if (process.env[`${prefix}RECONNECT_MAX_ATTEMPTS`]) {
      this.config.reconnect.maxAttempts = parseInt(
        process.env[`${prefix}RECONNECT_MAX_ATTEMPTS`]!,
        10
      );
    }
    if (process.env[`${prefix}RECONNECT_BASE_DELAY`]) {
      this.config.reconnect.baseDelay = parseInt(process.env[`${prefix}RECONNECT_BASE_DELAY`]!, 10);
    }
    if (process.env[`${prefix}RECONNECT_MAX_DELAY`]) {
      this.config.reconnect.maxDelay = parseInt(process.env[`${prefix}RECONNECT_MAX_DELAY`]!, 10);
    }
    if (process.env[`${prefix}RECONNECT_EXPONENTIAL`]) {
      this.config.reconnect.exponentialBackoff =
        process.env[`${prefix}RECONNECT_EXPONENTIAL`] === 'true';
    }

    // Load plugins from environment (comma-separated)
    if (process.env[`${prefix}PLUGINS`]) {
      const pluginNames = process.env[`${prefix}PLUGINS`]!.split(',').map((s) => s.trim());
      this.config.plugins = pluginNames.map((name) => ({ name, enabled: true }));
    }
  }

  /**
   * Merge configuration object into current config
   */
  private mergeConfig(source: Partial<BotConfig>): void {
    if (!source) return;

    // Deep merge for nested objects
    if (source.reconnect) {
      this.config.reconnect = { ...this.config.reconnect, ...source.reconnect };
    }

    if (source.plugins) {
      this.config.plugins = source.plugins;
    }

    // Shallow merge for top-level properties
    Object.assign(this.config, source);

    // Restore nested objects that were overwritten
    if (source.reconnect) {
      this.config.reconnect = { ...this.config.reconnect, ...source.reconnect };
    }
  }

  /**
   * Validate configuration
   */
  private validate(): void {
    const errors: string[] = [];

    if (!this.config.host) errors.push('Host is required');
    if (!this.config.username) errors.push('Username is required');
    if (this.config.port < 1 || this.config.port > 65535) {
      errors.push('Port must be between 1 and 65535');
    }
    if (this.config.checkTimeoutInterval < 1000) {
      errors.push('Check timeout interval must be at least 1000ms');
    }
    if (this.config.reconnect.maxAttempts < 0) {
      errors.push('Max reconnect attempts must be non-negative');
    }
    if (this.config.reconnect.baseDelay < 100) {
      errors.push('Base reconnect delay must be at least 100ms');
    }
    if (this.config.reconnect.maxDelay < this.config.reconnect.baseDelay) {
      errors.push('Max reconnect delay must be greater than base delay');
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): BotConfig {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(updates: Partial<BotConfig>): BotConfig {
    this.mergeConfig(updates);
    this.validate();
    return this.getConfig();
  }

  /**
   * Save current configuration to file
   */
  saveToFile(filePath?: string): void {
    const targetPath = filePath || this.options.configPath;
    const dir = path.dirname(targetPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Don't save sensitive data like passwords
    const safeConfig = { ...this.config };
    if (safeConfig.password) {
      safeConfig.password = '***';
    }

    fs.writeFileSync(targetPath, JSON.stringify(safeConfig, null, 2), 'utf-8');
  }

  /**
   * Create a default config file
   */
  static createDefaultConfigFile(filePath: string): void {
    const defaultConfig: BotConfig = {
      host: 'localhost',
      port: 25565,
      username: 'Bot',
      version: '1.21.1',
      auth: 'offline',
      checkTimeoutInterval: 60000,
      reconnect: {
        enabled: true,
        maxAttempts: 10,
        baseDelay: 1000,
        maxDelay: 60000,
        exponentialBackoff: true,
      },
      plugins: [],
    };

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
  }
}

/**
 * Convenience function to load configuration
 */
export function loadConfig(options?: ConfigLoaderOptions): BotConfig {
  const loader = new ConfigLoader(options);
  return loader.load();
}

export default ConfigLoader;
