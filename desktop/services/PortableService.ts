/**
 * Portable mode service - handles portable-specific functionality
 */

import { app, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LogService } from './LogService';

export interface PortableInfo {
  isPortable: boolean;
  executableDir: string;
  dataDir: string;
  configDir: string;
  error: string | null;
}

export class PortableService {
  private logService: LogService;
  private portableInfo: PortableInfo | null = null;

  constructor(logService: LogService) {
    this.logService = logService;
    this.detectPortableMode();
  }

  private detectPortableMode(): void {
    // Detect portable mode
    const executableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
    const isPortable = process.env.AIRIOS_PORTABLE === '1' ||
      Boolean(process.env.PORTABLE_EXECUTABLE_DIR) ||
      fs.existsSync(path.join(executableDirectory, 'portable.txt'));

    let dataDir = app.getPath('userData');
    let configDir = app.getPath('userData');
    let error: string | null = null;

    if (isPortable) {
      const portableDataDir = path.join(executableDirectory, 'portable-data');
      const portableConfigDir = path.join(executableDirectory, 'portable-config');

      try {
        fs.mkdirSync(portableDataDir, { recursive: true });
        fs.mkdirSync(portableConfigDir, { recursive: true });

        // Override app paths for portable mode
        app.setPath('userData', portableDataDir);
        app.setPath('userConfig', portableConfigDir);
        app.setPath('logs', path.join(portableDataDir, 'logs'));

        dataDir = portableDataDir;
        configDir = portableConfigDir;

        this.logService.appendLog('system', `Portable mode enabled. Data directory: ${dataDir}`);
      } catch (err) {
        error = `Cannot use portable data folder "${portableDataDir}": ${(err as Error).message}`;
        this.logService.appendLog('error', error);
      }
    }

    this.portableInfo = {
      isPortable,
      executableDir: executableDirectory,
      dataDir,
      configDir,
      error,
    };
  }

  getPortableInfo(): PortableInfo {
    if (!this.portableInfo) {
      this.detectPortableMode();
    }
    return { ...this.portableInfo! };
  }

  isPortable(): boolean {
    return this.portableInfo?.isPortable ?? false;
  }

  getDataDirectory(): string {
    return this.portableInfo?.dataDir ?? app.getPath('userData');
  }

  getConfigDirectory(): string {
    return this.portableInfo?.configDir ?? app.getPath('userConfig');
  }

  getError(): string | null {
    return this.portableInfo?.error ?? null;
  }

  // Create portable marker file
  async createPortableMarker(): Promise<void> {
    const executableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
    const markerPath = path.join(executableDirectory, 'portable.txt');

    try {
      fs.writeFileSync(markerPath, `Airi OS Portable Mode\nCreated: ${new Date().toISOString()}\n`, 'utf8');
      this.logService.appendLog('system', 'Portable marker created');
    } catch (error) {
      this.logService.appendLog('error', `Failed to create portable marker: ${(error as Error).message}`);
      throw error;
    }
  }

  // Remove portable marker file
  async removePortableMarker(): Promise<void> {
    const executableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
    const markerPath = path.join(executableDirectory, 'portable.txt');

    try {
      if (fs.existsSync(markerPath)) {
        fs.unlinkSync(markerPath);
        this.logService.appendLog('system', 'Portable marker removed');
      }
    } catch (error) {
      this.logService.appendLog('error', `Failed to remove portable marker: ${(error as Error).message}`);
      throw error;
    }
  }

  // Open data directory in file explorer
  openDataDirectory(): void {
    const dataDir = this.getDataDirectory();
    shell.openPath(dataDir);
  }

  // Open config directory in file explorer
  openConfigDirectory(): void {
    const configDir = this.getConfigDirectory();
    shell.openPath(configDir);
  }

  // Get all portable paths for debugging
  getPaths(): Record<string, string> {
    const info = this.getPortableInfo();
    return {
      executableDir: info.executableDir,
      dataDir: info.dataDir,
      configDir: info.configDir,
      userData: app.getPath('userData'),
      userConfig: app.getPath('userConfig'),
      logs: app.getPath('logs'),
      temp: app.getPath('temp'),
      home: app.getPath('home'),
      appData: app.getPath('appData'),
      exe: process.execPath,
    };
  }

  // Backup portable data
  async backupPortableData(backupPath: string): Promise<void> {
    if (!this.isPortable()) {
      throw new Error('Not in portable mode');
    }

    const dataDir = this.getDataDirectory();
    const configDir = this.getConfigDirectory();

    try {
      fs.mkdirSync(backupPath, { recursive: true });

      // Copy data directory
      this.copyDirectory(dataDir, path.join(backupPath, 'portable-data'));

      // Copy config directory
      this.copyDirectory(configDir, path.join(backupPath, 'portable-config'));

      this.logService.appendLog('system', `Portable data backed up to ${backupPath}`);
    } catch (error) {
      this.logService.appendLog('error', `Portable backup failed: ${(error as Error).message}`);
      throw error;
    }
  }

  private copyDirectory(src: string, dest: string): void {
    if (!fs.existsSync(src)) return;

    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  // Restore portable data from backup
  async restorePortableData(backupPath: string): Promise<void> {
    if (!this.isPortable()) {
      throw new Error('Not in portable mode');
    }

    const dataDir = this.getDataDirectory();
    const configDir = this.getConfigDirectory();

    try {
      // Restore data directory
      const backupDataDir = path.join(backupPath, 'portable-data');
      if (fs.existsSync(backupDataDir)) {
        this.copyDirectory(backupDataDir, dataDir);
      }

      // Restore config directory
      const backupConfigDir = path.join(backupPath, 'portable-config');
      if (fs.existsSync(backupConfigDir)) {
        this.copyDirectory(backupConfigDir, configDir);
      }

      this.logService.appendLog('system', `Portable data restored from ${backupPath}`);
    } catch (error) {
      this.logService.appendLog('error', `Portable restore failed: ${(error as Error).message}`);
      throw error;
    }
  }
}