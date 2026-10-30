import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, validateConfig, getConfig, resetConfig } from '../src/config';

// Mock process.env
const originalEnv = process.env;

describe('Config Module', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  describe('loadConfig', () => {
    it('should load default config when no env vars are set', () => {
      delete process.env.MC_HOST;
      delete process.env.MC_PORT;
      delete process.env.MC_USERNAME;
      delete process.env.MC_PASSWORD;
      delete process.env.MC_VERSION;
      delete process.env.WEB_PORT;
      delete process.env.WEB_HOST;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;
      delete process.env.ENABLE_MEMORY;
      delete process.env.MEMORY_FILE;
      delete process.env.ADMIN_PREFIX;
      delete process.env.ADMIN_PASSWORD;
      delete process.env.PREFIX;

      const config = loadConfig();

      expect(config.bot).toEqual({
        host: 'localhost',
        port: 25565,
        username: 'Airi',
        password: undefined,
        version: '1.21.1',
        auth: 'offline',
        checkTimeoutInterval: 60000,
      });

      expect(config.web).toEqual({
        port: 3000,
        host: undefined,
      });

      expect(config.openai).toEqual({
        apiKey: '',
        model: 'gpt-4',
      });

      expect(config.memory).toEqual({
        enabled: false,
        filePath: './memory.json',
      });

      expect(config.admin).toEqual({
        prefix: '$',
        password: 'admin',
      });

      expect(config.prefix).toEqual({
        public: ':',
        admin: '$',
      });
    });

    it('should load config from environment variables', () => {
      process.env.MC_HOST = 'test.example.com';
      process.env.MC_PORT = '12345';
      process.env.MC_USERNAME = 'TestBot';
      process.env.MC_PASSWORD = 'secret123';
      process.env.MC_VERSION = '1.20.4';
      process.env.WEB_PORT = '8080';
      process.env.WEB_HOST = '0.0.0.0';
      process.env.OPENAI_API_KEY = 'test-key-123';
      process.env.OPENAI_MODEL = 'gpt-3.5-turbo';
      process.env.ENABLE_MEMORY = 'true';
      process.env.MEMORY_FILE = './custom-memory.json';
      process.env.ADMIN_PREFIX = '!';
      process.env.ADMIN_PASSWORD = 'supersecret';
      process.env.PREFIX = '/';

      const config = loadConfig();

      expect(config.bot.host).toBe('test.example.com');
      expect(config.bot.port).toBe(12345);
      expect(config.bot.username).toBe('TestBot');
      expect(config.bot.password).toBe('secret123');
      expect(config.bot.version).toBe('1.20.4');

      expect(config.web.port).toBe(8080);
      expect(config.web.host).toBe('0.0.0.0');

      expect(config.openai.apiKey).toBe('test-key-123');
      expect(config.openai.model).toBe('gpt-3.5-turbo');

      expect(config.memory.enabled).toBe(true);
      expect(config.memory.filePath).toBe('./custom-memory.json');

      expect(config.admin.prefix).toBe('!');
      expect(config.admin.password).toBe('supersecret');

      expect(config.prefix.public).toBe('/');
      expect(config.prefix.admin).toBe('!');
    });

    it('should handle OPENAI_KEY as fallback for OPENAI_API_KEY', () => {
      process.env.OPENAI_KEY = 'fallback-key';
      delete process.env.OPENAI_API_KEY;

      const config = loadConfig();
      expect(config.openai.apiKey).toBe('fallback-key');
    });

    it('should trim MC_VERSION', () => {
      process.env.MC_VERSION = '  1.21.1  ';

      const config = loadConfig();
      expect(config.bot.version).toBe('1.21.1');
    });
  });

  describe('validateConfig', () => {
    it('should return no errors for valid config', () => {
      const config = loadConfig();
      const errors = validateConfig(config);
      expect(errors).toEqual([]);
    });

    it('should error when MC_HOST is missing', () => {
      const config = loadConfig();
      config.bot.host = '';
      const errors = validateConfig(config);
      expect(errors).toContain('MC_HOST is required');
    });

    it('should error when MC_USERNAME is missing', () => {
      const config = loadConfig();
      config.bot.username = '';
      const errors = validateConfig(config);
      expect(errors).toContain('MC_USERNAME is required');
    });

    it('should error when MC_PORT is out of range (too low)', () => {
      const config = loadConfig();
      config.bot.port = 0;
      const errors = validateConfig(config);
      expect(errors).toContain('MC_PORT must be between 1 and 65535');
    });

    it('should error when MC_PORT is out of range (too high)', () => {
      const config = loadConfig();
      config.bot.port = 65536;
      const errors = validateConfig(config);
      expect(errors).toContain('MC_PORT must be between 1 and 65535');
    });

    it('should error when WEB_PORT is out of range', () => {
      const config = loadConfig();
      config.web.port = 70000;
      const errors = validateConfig(config);
      expect(errors).toContain('WEB_PORT must be between 1 and 65535');
    });

    it('should return multiple errors when multiple fields are invalid', () => {
      const config = loadConfig();
      config.bot.host = '';
      config.bot.username = '';
      config.bot.port = 0;
      config.web.port = 70000;
      const errors = validateConfig(config);
      expect(errors.length).toBe(4);
    });
  });

  describe('getConfig', () => {
    it('should return cached config on subsequent calls', () => {
      const config1 = getConfig();
      const config2 = getConfig();
      expect(config1).toBe(config2);
    });

    it('should validate config on first load', () => {
      // This tests that validation runs
      const config = getConfig();
      expect(config).toBeDefined();
      expect(config.bot).toBeDefined();
      expect(config.web).toBeDefined();
    });
  });

  describe('resetConfig', () => {
    it('should reset the config singleton', () => {
      const config1 = getConfig();
      resetConfig();
      const config2 = getConfig();
      expect(config1).not.toBe(config2);
    });
  });
});