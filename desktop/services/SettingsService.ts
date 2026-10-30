/**
 * Settings service with encrypted storage using Electron's safeStorage
 */

import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Settings } from '../renderer/src/types';

const DEFAULTS: Settings = {
  host: '',
  port: 25565,
  username: 'Airi',
  version: '1.21.1',
  enableMemory: true,
  webPort: 3000,
  openaiKey: '',
};

interface StoredSettings {
  host: string;
  port: number;
  username: string;
  version: string;
  enableMemory: boolean;
  webPort: number;
  openaiKeyEncrypted: string;
}

export class SettingsService {
  private userConfig: Settings | null = null;
  private portableMode: boolean;
  private portableDataDirectory: string;
  private portableDataError: string | null = null;

  constructor() {
    // Detect portable mode
    const executableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
    this.portableMode = process.env.AIRIOS_PORTABLE === '1' ||
      Boolean(process.env.PORTABLE_EXECUTABLE_DIR) ||
      fs.existsSync(path.join(executableDirectory, 'portable.txt'));

    this.portableDataDirectory = path.join(executableDirectory, 'portable-data');

    if (this.portableMode) {
      try {
        fs.mkdirSync(this.portableDataDirectory, { recursive: true });
        app.setPath('userData', this.portableDataDirectory);
      } catch (error) {
        this.portableDataError = `Cannot use portable data folder "${this.portableDataDirectory}": ${(error as Error).message}`;
      }
    }
  }

  private getConfigPath(): string {
    return path.join(app.getPath('userData'), 'settings.json');
  }

  isPortableMode(): boolean {
    return this.portableMode;
  }

  getPortableDataError(): string | null {
    return this.portableDataError;
  }

  getDataDirectory(): string {
    return app.getPath('userData');
  }

  validateConfig(value: Partial<Settings>): Settings {
    const config: Settings = {
      host: String(value.host || '').trim(),
      port: Number(value.port),
      username: String(value.username || '').trim(),
      version: String(value.version || '').trim(),
      enableMemory: Boolean(value.enableMemory),
      webPort: Number(value.webPort),
      openaiKey: String(value.openaiKey || '').trim(),
    };

    if (!config.host) throw new Error('Enter a Minecraft server address.');
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error('Minecraft port must be between 1 and 65535.');
    }
    if (!config.username) throw new Error('Enter a Minecraft username.');
    if (!config.version) throw new Error('Enter a Minecraft client version.');
    if (!Number.isInteger(config.webPort) || config.webPort < 1 || config.webPort > 65535) {
      throw new Error('Dashboard port must be between 1 and 65535.');
    }
    if (config.port === config.webPort) throw new Error('Minecraft and dashboard ports must be different.');
    if (config.openaiKey && !safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure Windows storage is unavailable, so the API key cannot be saved safely.');
    }

    return config;
  }

  async load(): Promise<Settings & { portableMode: boolean; dataDirectory: string }> {
    try {
      const stored = JSON.parse(fs.readFileSync(this.getConfigPath(), 'utf8')) as StoredSettings;
      let openaiKey = '';

      if (stored.openaiKeyEncrypted) {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('Windows secure storage is unavailable.');
        }
        openaiKey = safeStorage.decryptString(Buffer.from(stored.openaiKeyEncrypted, 'base64'));
      }

      this.userConfig = { ...DEFAULTS, ...stored, openaiKey };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Could not read desktop settings: ${(error as Error).stack || (error as Error).message}`);
      }
      this.userConfig = { ...DEFAULTS };
    }

    return {
      ...this.userConfig,
      portableMode: this.portableMode,
      dataDirectory: this.getDataDirectory(),
    };
  }

  async save(config: Partial<Settings>): Promise<Settings> {
    if (this.portableDataError) throw new Error(this.portableDataError);

    const validated = this.validateConfig(config);

    const stored: StoredSettings = {
      host: validated.host,
      port: validated.port,
      username: validated.username,
      version: validated.version,
      enableMemory: validated.enableMemory,
      webPort: validated.webPort,
      openaiKeyEncrypted: validated.openaiKey
        ? safeStorage.encryptString(validated.openaiKey).toString('base64')
        : '',
    };

    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(this.getConfigPath(), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });

    this.userConfig = validated;
    return { ...validated };
  }

  getConfig(): Settings | null {
    return this.userConfig ? { ...this.userConfig } : null;
  }
}