/**
 * Configuration system for mc-ai-bot
 * Loads configuration from environment variables with validation
 */

import type { AppConfig, BotConfig, WebConfig, OpenAIConfig, MemoryConfig, AdminConfig, BotPrefixConfig } from '../types';

/**
 * Load and validate configuration from environment variables
 */
export function loadConfig(): AppConfig {
  // Bot configuration
  const botConfig: BotConfig = {
    host: process.env.MC_HOST || 'localhost',
    port: parseInt(process.env.MC_PORT || '25565', 10),
    username: process.env.MC_USERNAME || 'Airi',
    password: process.env.MC_PASSWORD,
    version: process.env.MC_VERSION?.trim() || '1.21.1',
    auth: 'offline',
    checkTimeoutInterval: 60000,
  };

  // Web server configuration
  const webConfig: WebConfig = {
    port: parseInt(process.env.WEB_PORT || '3000', 10),
    host: process.env.WEB_HOST,
  };

  // OpenAI configuration
  const openaiConfig: OpenAIConfig = {
    apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4',
  };

  // Memory configuration
  const memoryConfig: MemoryConfig = {
    enabled: process.env.ENABLE_MEMORY === 'true',
    filePath: process.env.MEMORY_FILE || './memory.json',
  };

  // Admin configuration
  const adminConfig: AdminConfig = {
    prefix: process.env.ADMIN_PREFIX || '$',
    password: process.env.ADMIN_PASSWORD || 'admin',
  };

  // Command prefix configuration
  const prefixConfig: BotPrefixConfig = {
    public: process.env.PREFIX || ':',
    admin: adminConfig.prefix,
  };

  return {
    bot: botConfig,
    web: webConfig,
    openai: openaiConfig,
    memory: memoryConfig,
    admin: adminConfig,
    prefix: prefixConfig,
  };
}

/**
 * Validate configuration and return any errors
 */
export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];

  // Validate bot config
  if (!config.bot.host) {
    errors.push('MC_HOST is required');
  }
  if (!config.bot.username) {
    errors.push('MC_USERNAME is required');
  }
  if (config.bot.port < 1 || config.bot.port > 65535) {
    errors.push('MC_PORT must be between 1 and 65535');
  }

  // Validate web config
  if (config.web.port < 1 || config.web.port > 65535) {
    errors.push('WEB_PORT must be between 1 and 65535');
  }

  // Validate OpenAI config (optional but warn)
  if (!config.openai.apiKey) {
    console.warn('[CONFIG] OpenAI API key not set - AI chat features will be disabled');
  }

  return errors;
}

/**
 * Configuration singleton
 */
let configInstance: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!configInstance) {
    configInstance = loadConfig();
    const errors = validateConfig(configInstance);
    if (errors.length > 0) {
      console.error('[CONFIG] Configuration errors:');
      errors.forEach(err => console.error(`  - ${err}`));
    }
  }
  return configInstance;
}

export function resetConfig(): void {
  configInstance = null;
}