/**
 * Auto-updater service using electron-updater
 */

import type { BrowserWindow } from 'electron';
import { app, shell } from 'electron';
import type { UpdateInfo } from 'electron-updater';
import { autoUpdater } from 'electron-updater';
import { EventEmitter } from 'events';
import type { LogService } from './LogService';

export interface UpdateCheckResult {
  updateInfo: UpdateInfo | null;
  error: string | null;
}

export class AutoUpdaterService extends EventEmitter {
  private logService: LogService;
  private mainWindow: BrowserWindow | null = null;
  private checkInProgress = false;

  constructor(logService: LogService) {
    super();
    this.logService = logService;
    this.setupAutoUpdater();
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  private setupAutoUpdater(): void {
    // Configure auto-updater
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    // Set up event handlers
    autoUpdater.on('checking-for-update', () => {
      this.logService.appendLog('system', 'Checking for updates...');
      this.emit('checking-for-update');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.logService.appendLog(
        'system',
        `Update available: ${info.version} (current: ${app.getVersion()})`
      );
      this.emit('update-available', info);
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.logService.appendLog('system', `No update available. Current version: ${info.version}`);
      this.emit('update-not-available', info);
    });

    autoUpdater.on('error', (error: Error) => {
      this.logService.appendLog('error', `Auto-updater error: ${error.message}`);
      this.emit('error', error.message);
    });

    autoUpdater.on('download-progress', (progress) => {
      const { percent, transferred, total } = progress;
      this.logService.appendLog(
        'system',
        `Downloading update: ${percent.toFixed(1)}% (${this.formatBytes(transferred)}/${this.formatBytes(total)})`
      );
      this.emit('download-progress', percent);
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.logService.appendLog('system', `Update downloaded: ${info.version}. Ready to install.`);
      this.emit('update-downloaded', info);
    });

    // Handle before quit to install update
    autoUpdater.on('before-quit-for-update', () => {
      this.logService.appendLog('system', 'Installing update before quit...');
    });
  }

  async checkForUpdates(): Promise<UpdateCheckResult> {
    if (this.checkInProgress) {
      return { updateInfo: null, error: 'Update check already in progress' };
    }

    this.checkInProgress = true;

    try {
      const result = await autoUpdater.checkForUpdates();
      this.checkInProgress = false;

      if (result && result.updateInfo) {
        return { updateInfo: result.updateInfo, error: null };
      }

      return { updateInfo: null, error: null };
    } catch (error) {
      this.checkInProgress = false;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logService.appendLog('error', `Update check failed: ${errorMessage}`);
      return { updateInfo: null, error: errorMessage };
    }
  }

  async downloadUpdate(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logService.appendLog('error', `Update download failed: ${errorMessage}`);
      throw error;
    }
  }

  async installUpdate(): Promise<void> {
    this.logService.appendLog('system', 'Installing update and restarting...');
    autoUpdater.quitAndInstall(true, true);
  }

  setFeedUrl(feedUrl: string): void {
    autoUpdater.setFeedURL({ url: feedUrl });
    this.logService.appendLog('system', `Auto-updater feed URL set to: ${feedUrl}`);
  }

  getFeedUrl(): string | null {
    return autoUpdater.getFeedURL()?.url ?? null;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Handle external protocol links (for update releases)
  handleExternalProtocol(url: string): void {
    shell.openExternal(url);
  }
}
