/**
 * System tray service for minimize-to-tray functionality
 */

import type { BrowserWindow } from 'electron';
import { app, Menu, Tray, nativeImage } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { LogService } from './LogService';

export interface TrayMenuOptions {
  showWindow: () => void;
  hideWindow: () => void;
  startBot: () => void;
  stopBot: () => void;
  isBotRunning: () => boolean;
  quitApp: () => void;
}

export class SystemTrayService {
  private tray: Tray | null = null;
  private mainWindow: BrowserWindow | null = null;
  private logService: LogService;
  private options: TrayMenuOptions | null = null;
  private botRunning = false;

  constructor(logService: LogService) {
    this.logService = logService;
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  setOptions(options: TrayMenuOptions): void {
    this.options = options;
  }

  setBotRunning(running: boolean): void {
    this.botRunning = running;
    this.updateTrayMenu();
  }

  initialize(): void {
    // Create tray icon
    const iconPath = this.getIconPath();
    const icon = nativeImage.createFromPath(iconPath);

    if (icon.isEmpty()) {
      this.logService.appendLog('error', `Failed to load tray icon from ${iconPath}`);
      // Create a fallback empty icon
      const fallback = nativeImage.createEmpty();
      this.tray = new Tray(fallback.resize({ width: 16, height: 16 }));
    } else {
      this.tray = new Tray(icon.resize({ width: 16, height: 16 }));
    }

    this.tray.setToolTip('Airi OS - Minecraft Bot Dashboard');
    this.updateTrayMenu();

    // Handle tray click (double-click to show/hide window)
    this.tray.on('double-click', () => {
      this.toggleWindow();
    });

    // Handle single click (optional: show context menu)
    this.tray.on('click', () => {
      // Optional: could show window on single click
    });

    this.tray.on('right-click', () => {
      this.tray?.popUpContextMenu();
    });

    this.logService.appendLog('system', 'System tray initialized');
  }

  private getIconPath(): string {
    // Try multiple locations for the tray icon
    const possiblePaths = [
      path.join(app.getAppPath(), 'assets', 'tray-icon.png'),
      path.join(app.getAppPath(), 'build', 'tray-icon.png'),
      path.join(app.getAppPath(), 'desktop', 'assets', 'tray-icon.png'),
      path.join(__dirname, '..', 'assets', 'tray-icon.png'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Return first path as fallback (will log error if not found)
    return possiblePaths[0];
  }

  private updateTrayMenu(): void {
    if (!this.tray || !this.options) return;

    const isWindowVisible = this.mainWindow?.isVisible() ?? false;
    const isBotRunning = this.botRunning;

    const template: (Electron.MenuItemConstructorOptions | Electron.MenuItem)[] = [
      {
        label: isWindowVisible ? 'Hide Window' : 'Show Window',
        click: () => {
          if (isWindowVisible) {
            this.options?.hideWindow();
          } else {
            this.options?.showWindow();
          }
        },
      },
      { type: 'separator' },
      {
        label: isBotRunning ? 'Stop Bot' : 'Start Bot',
        enabled: this.options !== null,
        click: () => {
          if (isBotRunning) {
            this.options?.stopBot();
          } else {
            this.options?.startBot();
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Airi OS',
        click: () => {
          this.options?.quitApp();
        },
      },
    ];

    const contextMenu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(contextMenu);
  }

  private toggleWindow(): void {
    if (!this.mainWindow) return;

    if (this.mainWindow.isVisible()) {
      this.options?.hideWindow();
    } else {
      this.options?.showWindow();
    }
  }

  showBalloon(title: string, content: string): void {
    if (this.tray && process.platform === 'win32') {
      this.tray.displayBalloon({
        title,
        content,
        iconType: 'info',
      });
    }
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
      this.logService.appendLog('system', 'System tray destroyed');
    }
  }
}
