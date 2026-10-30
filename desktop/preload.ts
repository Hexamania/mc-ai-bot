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

// Type-safe event listening
const on = <T>(channel: string, listener: (event: Electron.IpcRendererEvent, payload: T) => void): (() => void) => {
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
};

const once = <T>(channel: string, listener: (event: Electron.IpcRendererEvent, payload: T) => void): (() => void) => {
  ipcRenderer.once(channel, listener);
  return () => ipcRenderer.off(channel, listener);
};

// Settings API
const settings = {
  get: () => invoke<void, Settings & { portableMode: boolean; dataDirectory: string }>('settings:get'),
  save: (config: Partial<Settings>) => invoke<Partial<Settings>, Settings>('settings:save', config),
};

// Bot API
const bot = {
  start: () => invoke<void, { status: string }>('bot:start'),
  stop: () => invoke<void, { status: string }>('bot:stop'),
  restart: () => invoke<void, { success: boolean; error?: string }>('bot:restart'),
  status: () => invoke<void, BotStatus>('bot:status'),
};

// Logs API
const logs = {
  get: (query?: LogQuery) => invoke<LogQuery | undefined, LogEntry[]>('logs:get', query),
  search: (query: LogSearchQuery) => invoke<LogSearchQuery, LogEntry[]>('logs:search', query),
  export: (options: LogExportOptions) => invoke<LogExportOptions, { path: string }>('logs:export', options),
  clear: () => invoke<void, void>('logs:clear'),
  copy: (text: string) => invoke<string, void>('logs:copy', text),
  onLog: (listener: (entry: LogEntry) => void) => on<LogEntry>('app:log', (_e, entry) => listener(entry)),
  onBotState: (listener: (state: BotState) => void) => on<BotState>('app:bot-state', (_e, state) => listener(state)),
};

// Updater API
const updater = {
  check: () => invoke<void, UpdateInfo>('updater:check'),
  download: () => invoke<void, { progress: number }>('updater:download'),
  install: () => invoke<void, void>('updater:install'),
  onUpdateAvailable: (listener: (info: UpdateInfo) => void) =>
    on<UpdateInfo>('updater:update-available', (_e, info) => listener(info)),
  onDownloadProgress: (listener: (progress: number) => void) =>
    on<number>('updater:download-progress', (_e, progress) => listener(progress)),
  onUpdateDownloaded: (listener: (info: UpdateInfo) => void) =>
    on<UpdateInfo>('updater:update-downloaded', (_e, info) => listener(info)),
  onError: (listener: (error: string) => void) =>
    on<string>('updater:error', (_e, error) => listener(error)),
};

// System API
const system = {
  minimizeToTray: () => invoke<void, void>('system:minimizeToTray'),
  showWindow: () => invoke<void, void>('system:showWindow'),
  quit: () => invoke<void, void>('system:quit'),
  openExternal: (url: string) => invoke<string, void>('shell:openExternal', url),
  onLifecycle: (listener: (status: { status: string; detail: string; running: boolean }) => void) =>
    on<{ status: string; detail: string; running: boolean }>('app:lifecycle', (_e, payload) => listener(payload)),
  onDashboardReady: (listener: (url: string) => void) =>
    on<{ url: string }>('app:dashboard-ready', (_e, payload) => listener(payload.url)),
};

// Clipboard API
const clipboard = {
  writeText: (text: string) => ipcRenderer.invoke('logs:copy', text),
  readText: () => navigator.clipboard?.readText() ?? Promise.resolve(''),
};

// Expose API to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  settings,
  bot,
  logs,
  updater,
  system,
  clipboard,
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

// Type declarations for renderer
declare global {
  interface Window {
    electronAPI: {
      settings: {
        get: () => Promise<Settings & { portableMode: boolean; dataDirectory: string }>;
        save: (config: Partial<Settings>) => Promise<Settings>;
      };
      bot: {
        start: () => Promise<{ status: string }>;
        stop: () => Promise<{ status: string }>;
        restart: () => Promise<{ success: boolean; error?: string }>;
        status: () => Promise<BotStatus>;
      };
      logs: {
        get: (query?: LogQuery) => Promise<LogEntry[]>;
        search: (query: LogSearchQuery) => Promise<LogEntry[]>;
        export: (options: LogExportOptions) => Promise<{ path: string }>;
        clear: () => Promise<void>;
        copy: (text: string) => Promise<void>;
        onLog: (listener: (entry: LogEntry) => void) => () => void;
        onBotState: (listener: (state: BotState) => void) => () => void;
      };
      updater: {
        check: () => Promise<UpdateInfo>;
        download: () => Promise<{ progress: number }>;
        install: () => Promise<void>;
        onUpdateAvailable: (listener: (info: UpdateInfo) => void) => () => void;
        onDownloadProgress: (listener: (progress: number) => void) => () => void;
        onUpdateDownloaded: (listener: (info: UpdateInfo) => void) => () => void;
        onError: (listener: (error: string) => void) => () => void;
      };
      system: {
        minimizeToTray: () => Promise<void>;
        showWindow: () => Promise<void>;
        quit: () => Promise<void>;
        openExternal: (url: string) => Promise<void>;
        onLifecycle: (listener: (status: { status: string; detail: string; running: boolean }) => void) => () => void;
        onDashboardReady: (listener: (url: string) => void) => () => void;
      };
      clipboard: {
        writeText: (text: string) => Promise<void>;
        readText: () => Promise<string>;
      };
      platform: NodeJS.Platform;
      versions: NodeJS.ProcessVersions;
      isPortable: boolean;
    };
    versions: {
      node: string;
      chrome: string;
      electron: string;
      airi: string;
    };
  }
}