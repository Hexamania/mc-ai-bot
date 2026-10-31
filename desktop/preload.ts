/**
 * Preload script - exposes safe IPC APIs to renderer via contextBridge
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  Settings,
  BotStatus,
  BotState,
  LogEntry,
  LogQuery,
  LogSearchQuery,
  LogExportOptions,
  UpdateInfo,
} from './renderer/src/types';

// Type-safe IPC invocation
const invoke = <TRequest, TResponse>(channel: string, request?: TRequest): Promise<TResponse> => {
  return ipcRenderer.invoke(channel, request);
};

// Expose API to renderer - flat structure matching ElectronAPI interface
contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () =>
    invoke<void, Settings & { portableMode: boolean; dataDirectory: string }>('settings:get'),
  saveSettings: (config: Partial<Settings>) =>
    invoke<Partial<Settings>, Settings>('settings:save', config),

  // Bot
  startBot: () => invoke<void, { status: string }>('bot:start'),
  stopBot: () => invoke<void, { status: string }>('bot:stop'),
  restartBot: () => invoke<void, { success: boolean; error?: string }>('bot:restart'),
  getBotStatus: () => invoke<void, BotStatus>('bot:status'),

  // Logs
  getLogs: (query?: LogQuery) => invoke<LogQuery | undefined, LogEntry[]>('logs:get', query),
  searchLogs: (query: LogSearchQuery) => invoke<LogSearchQuery, LogEntry[]>('logs:search', query),
  exportLogs: (options: LogExportOptions) =>
    invoke<LogExportOptions, { path: string }>('logs:export', options),
  clearLogs: () => invoke<void, void>('logs:clear'),
  copyLogs: (text: string) => invoke<string, void>('logs:copy', text),

  // Updater
  checkForUpdates: () => invoke<void, UpdateInfo>('updater:check'),
  downloadUpdate: () => invoke<void, { progress: number }>('updater:download'),
  installUpdate: () => invoke<void, void>('updater:install'),

  // System
  minimizeToTray: () => invoke<void, void>('system:minimizeToTray'),
  showWindow: () => invoke<void, void>('system:showWindow'),
  quitApp: () => invoke<void, void>('system:quit'),
  openExternal: (url: string) => invoke<string, void>('shell:openExternal', url),

  // Events
  onLifecycle: (callback: (data: { status: string; detail: string; running: boolean }) => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { status: string; detail: string; running: boolean }
    ) => callback(payload);
    ipcRenderer.on('app:lifecycle', listener);
    return () => ipcRenderer.off('app:lifecycle', listener);
  },
  onLog: (callback: (entry: LogEntry | string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, entry: LogEntry | string) => callback(entry);
    ipcRenderer.on('app:log', listener);
    return () => ipcRenderer.off('app:log', listener);
  },
  onBotState: (callback: (state: BotState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: BotState) => callback(state);
    ipcRenderer.on('app:bot-state', listener);
    return () => ipcRenderer.off('app:bot-state', listener);
  },
  onDashboardReady: (callback: (data: { url: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { url: string }) => callback(payload);
    ipcRenderer.on('app:dashboard-ready', listener);
    return () => ipcRenderer.off('app:dashboard-ready', listener);
  },
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, info: UpdateInfo) => callback(info);
    ipcRenderer.on('updater:update-available', listener);
    return () => ipcRenderer.off('updater:update-available', listener);
  },
  onUpdateProgress: (callback: (progress: number) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, progress: number) => callback(progress);
    ipcRenderer.on('updater:download-progress', listener);
    return () => ipcRenderer.off('updater:download-progress', listener);
  },
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },

  // Additional methods used by renderer but not in ElectronAPI interface
  // These are added for compatibility with renderer.ts
  getBotState: () => invoke<void, BotState>('bot:get-state'),
  onBotStatus: (callback: (status: BotStatus) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, status: BotStatus) => callback(status);
    ipcRenderer.on('bot:status-update', listener);
    return () => ipcRenderer.off('bot:status-update', listener);
  },
  onBulkUpdate: (callback: (state: BotState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: BotState) => callback(state);
    ipcRenderer.on('bot:bulk-update', listener);
    return () => ipcRenderer.off('bot:bulk-update', listener);
  },
  onPathUpdate: (callback: (path: { x: number; y: number; z: number }[]) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, path: { x: number; y: number; z: number }[]) =>
      callback(path);
    ipcRenderer.on('bot:path-update', listener);
    return () => ipcRenderer.off('bot:path-update', listener);
  },
  sendCommand: (command: string, args?: string) =>
    invoke<string, void>('bot:send-command', args ? `${command} ${args}` : command),

  // Platform info
  platform: process.platform,
  versions: process.versions,
  isPortable: process.env.AIRIOS_PORTABLE === '1',
});

contextBridge.exposeInMainWorld('versions', {
  node: process.versions.node,
  chrome: process.versions.chrome,
  electron: process.versions.electron,
  airi: process.env.APP_VERSION || '1.0.0',
});

// Type declarations for renderer are provided by ./renderer/src/types/index.ts
// This file imports those types, so the Window.api declaration is already available
