/**
 * Main process entry point for Airi OS desktop app
 */

import { app, BrowserWindow, ipcMain, shell, protocol, clipboard } from 'electron';
import * as path from 'node:path';

// Services
import { SettingsService } from './services/SettingsService';
import { LogService } from './services/LogService';
import { BotProcessManager } from './services/BotProcessManager';
import { AutoUpdaterService } from './services/AutoUpdaterService';
import { SystemTrayService } from './services/SystemTrayService';
import { NotificationService } from './services/NotificationService';
import { PortableService } from './services/PortableService';

// IPC Channels
import type { EventName, EventPayload } from './ipc/channels';
import type { Settings } from './renderer/src/types';

// Global references
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

// Services
const settingsService = new SettingsService();
const logService = new LogService();
const botManager = new BotProcessManager(logService);
const autoUpdater = new AutoUpdaterService(logService);
const systemTray = new SystemTrayService(logService);
const notifications = new NotificationService(logService);
const portableService = new PortableService(logService);

// Initialize services
function initializeServices(): void {
  // Set main window references (mainWindow is guaranteed to exist at this point)
  if (!mainWindow) return;
  botManager.setMainWindow?.(mainWindow);
  autoUpdater.setMainWindow(mainWindow);
  systemTray.setMainWindow(mainWindow);
  notifications.setMainWindow(mainWindow);
  systemTray.setOptions({
    showWindow,
    hideWindow,
    startBot: () => startBot(),
    stopBot: () => stopBot(),
    isBotRunning: () => botManager.isRunning(),
    quitApp,
  });

  // Forward bot state changes to renderer
  botManager.on('state-changed', (state) => {
    sendEvent('app:bot-state', {
      connected: state.running,
      status: state.status,
      error: state.error,
      pid: state.pid,
      restartCount: state.restartCount,
      lastRestart: state.lastRestart,
    });
  });

  // Forward auto-updater events
  autoUpdater.on('update-available', (info) => {
    sendEvent('updater:update-available', info);
    notifications.showUpdateAvailable(info.version);
  });

  autoUpdater.on('update-not-available', (info) => {
    sendEvent('updater:update-not-available', info);
  });

  autoUpdater.on('download-progress', (progress) => {
    sendEvent('updater:download-progress', progress);
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendEvent('updater:update-downloaded', info);
    notifications.showUpdateDownloaded(info.version);
  });

  autoUpdater.on('error', (error) => {
    sendEvent('updater:error', error);
  });

  // Load initial settings into bot manager
  settingsService.load().then((settings) => {
    botManager.setSettings(settings);
  });
}

// Create main window
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'Airi OS',
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'desktop', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    show: false,
    backgroundColor: '#080b12',
    frame: true,
    titleBarStyle: 'default',
  });

  // Load renderer
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    sendEvent('app:lifecycle', { status: 'ready', detail: 'Window ready', running: true });
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && !process.env.AIRIOS_NO_TRAY) {
      event.preventDefault();
      hideWindow();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Initialize system tray
  systemTray.initialize();

  // Check for updates on startup (if not in dev)
  if (process.env.NODE_ENV !== 'development') {
    setTimeout(() => autoUpdater.checkForUpdates(), 5000);
  }
}

// Window management
function showWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function hideWindow(): void {
  if (mainWindow) {
    mainWindow.hide();
  }
}

function quitApp(): void {
  isQuitting = true;
  botManager.shutdown();
  app.quit();
}

// Bot management
async function startBot(): Promise<void> {
  try {
    const settings = await settingsService.load();
    botManager.setSettings(settings);
    await botManager.start();
  } catch (error) {
    logService.appendLog('error', `Failed to start bot: ${(error as Error).message}`);
    notifications.showBotError((error as Error).message);
  }
}

async function stopBot(): Promise<void> {
  await botManager.stop();
}

async function restartBot(): Promise<{ success: boolean; error?: string }> {
  return botManager.restart();
}

// IPC Handlers
function setupIpcHandlers(): void {
  // Settings
  ipcMain.handle('settings:get', async () => {
    return settingsService.load();
  });

  ipcMain.handle('settings:save', async (_event, config: Partial<Settings>) => {
    return settingsService.save(config);
  });

  // Bot control
  ipcMain.handle('bot:start', async () => {
    await startBot();
    return { status: 'started' };
  });

  ipcMain.handle('bot:stop', async () => {
    await stopBot();
    return { status: 'stopped' };
  });

  ipcMain.handle('bot:restart', async () => {
    return restartBot();
  });

  ipcMain.handle('bot:status', async () => {
    const state = botManager.getState();
    return {
      connected: state.running,
      status: state.status,
      pid: state.pid,
      error: state.error,
      restartCount: state.restartCount,
      lastRestart: state.lastRestart,
    };
  });

  // Logs
  ipcMain.handle('logs:get', async (_event, query) => {
    return logService.getLogs(query);
  });

  ipcMain.handle('logs:search', async (_event, query) => {
    return logService.searchLogs(query);
  });

  ipcMain.handle('logs:export', async (_event, options) => {
    return logService.exportLogs(options);
  });

  ipcMain.handle('logs:clear', async () => {
    logService.clearLogs();
  });

  ipcMain.handle('logs:copy', async (_event, text) => {
    clipboard.writeText(text);
  });

  // Auto-updater
  ipcMain.handle('updater:check', async () => {
    return autoUpdater.checkForUpdates();
  });

  ipcMain.handle('updater:download', async () => {
    await autoUpdater.downloadUpdate();
    return { progress: 100 };
  });

  ipcMain.handle('updater:install', async () => {
    await autoUpdater.installUpdate();
  });

  // System
  ipcMain.handle('system:minimizeToTray', async () => {
    hideWindow();
  });

  ipcMain.handle('system:showWindow', async () => {
    showWindow();
  });

  ipcMain.handle('system:quit', async () => {
    quitApp();
  });

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
  });
}

// Event emission helper
function sendEvent<T extends EventName>(event: T, payload: EventPayload<T>): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, payload);
  }
}

// App lifecycle
app.whenReady().then(() => {
  initializeServices();
  setupIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !isQuitting) {
    // On Windows/Linux, hide to tray instead of quitting
    if (!process.env.AIRIOS_NO_TRAY) {
      hideWindow();
      return;
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  botManager.shutdown();
});

// Security: prevent new window creation
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

// Handle protocol links (for auto-updater)
protocol.handle('airi-os', (request) => {
  const url = request.url.replace('airi-os://', '');
  shell.openExternal(url);
  return new Response(null, { status: 204 });
});

// Log startup
logService.appendLog('system', `Airi OS starting (v${app.getVersion()})`);
logService.appendLog('system', `Portable mode: ${portableService.isPortable()}`);
logService.appendLog('system', `Data directory: ${portableService.getDataDirectory()}`);

export {
  mainWindow,
  settingsService,
  logService,
  botManager,
  autoUpdater,
  systemTray,
  notifications,
  portableService,
};
