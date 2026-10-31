/**
 * Native notifications service
 */

import type { BrowserWindow } from 'electron';
import { app, nativeImage, Notification } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { LogService } from './LogService';

export interface NotificationOptions {
  title: string;
  body: string;
  silent?: boolean;
  icon?: string;
  actions?: { type: 'button'; text: string }[];
  closeButtonText?: string;
  timeout?: number;
  urgency?: 'normal' | 'critical' | 'low';
}

export class NotificationService {
  private logService: LogService;
  private mainWindow: BrowserWindow | null = null;
  private defaultIcon: Electron.NativeImage | undefined;

  constructor(logService: LogService) {
    this.logService = logService;
    this.loadDefaultIcon();
  }

  private loadDefaultIcon(): void {
    const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png');
    if (fs.existsSync(iconPath)) {
      this.defaultIcon = nativeImage.createFromPath(iconPath);
    }
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  show(options: NotificationOptions): void {
    // Check if notifications are supported
    if (!Notification.isSupported()) {
      this.logService.appendLog('system', 'Native notifications not supported on this platform');
      return;
    }

    const notification = new Notification({
      title: options.title,
      body: options.body,
      silent: options.silent ?? false,
      icon: options.icon ? nativeImage.createFromPath(options.icon) : this.defaultIcon,
      actions: options.actions,
      closeButtonText: options.closeButtonText,
      timeoutType: options.urgency === 'critical' ? 'never' : 'default',
    });

    notification.on('show', () => {
      this.logService.appendLog('system', `Notification shown: ${options.title}`);
    });

    notification.on('click', () => {
      this.logService.appendLog('system', `Notification clicked: ${options.title}`);
      // Focus the main window when notification is clicked
      if (this.mainWindow) {
        if (this.mainWindow.isMinimized()) {
          this.mainWindow.restore();
        }
        this.mainWindow.focus();
        this.mainWindow.show();
      }
    });

    notification.on('action', (event, index) => {
      this.logService.appendLog(
        'system',
        `Notification action ${index} triggered: ${options.title}`
      );
    });

    notification.on('close', () => {
      this.logService.appendLog('system', `Notification closed: ${options.title}`);
    });

    notification.on('failed', (event, error) => {
      this.logService.appendLog('error', `Notification failed: ${error}`);
    });

    notification.show();
  }

  showBotStarted(host: string, port: number): void {
    this.show({
      title: 'Airi OS - Bot Started',
      body: `Connected to ${host}:${port}`,
      icon: undefined,
    });
  }

  showBotStopped(reason?: string): void {
    this.show({
      title: 'Airi OS - Bot Stopped',
      body: reason || 'Bot was stopped manually',
      urgency: 'normal',
    });
  }

  showBotError(error: string): void {
    this.show({
      title: 'Airi OS - Bot Error',
      body: error,
      urgency: 'critical',
      silent: false,
    });
  }

  showBotReconnecting(attempt: number, maxAttempts: number): void {
    this.show({
      title: 'Airi OS - Reconnecting...',
      body: `Attempt ${attempt}/${maxAttempts}`,
      urgency: 'normal',
      silent: true,
    });
  }

  showUpdateAvailable(version: string): void {
    this.show({
      title: 'Airi OS - Update Available',
      body: `Version ${version} is ready to download`,
      actions: [{ type: 'button', text: 'Download' }],
      closeButtonText: 'Later',
    });
  }

  showUpdateDownloaded(version: string): void {
    this.show({
      title: 'Airi OS - Update Ready',
      body: `Version ${version} downloaded. Restart to install.`,
      actions: [{ type: 'button', text: 'Restart Now' }],
      closeButtonText: 'Later',
    });
  }

  showMemoryAlert(message: string): void {
    this.show({
      title: 'Airi OS - Memory Alert',
      body: message,
      urgency: 'low',
    });
  }

  // Test notification
  showTest(): void {
    this.show({
      title: 'Airi OS Test',
      body: 'Native notifications are working correctly!',
      urgency: 'normal',
    });
  }
}
