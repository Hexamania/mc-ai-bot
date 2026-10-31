import type {
  ElectronAPI,
  LogEntry,
  LogSearchQuery,
  LogExportOptions,
  BotState,
  Settings,
  UpdateInfo,
} from '../types';

/**
 * Typed IPC composable for communicating with main process
 */
export function useIpc() {
  const api = window.api as ElectronAPI;

  // Settings
  const getSettings = () => api.getSettings();
  const saveSettings = (settings: Partial<Settings>) => api.saveSettings(settings);

  // Bot
  const startBot = () => api.startBot();
  const stopBot = () => api.stopBot();
  const restartBot = () => api.restartBot();
  const getBotStatus = () => api.getBotStatus();

  // Logs
  const getLogs = () => api.getLogs();
  const searchLogs = (query: LogSearchQuery) => api.searchLogs(query);
  const exportLogs = (options: LogExportOptions) => api.exportLogs(options);
  const clearLogs = () => api.clearLogs();
  const copyLogs = (text: string) => api.copyLogs(text);

  // Updater
  const checkForUpdates = () => api.checkForUpdates();
  const downloadUpdate = () => api.downloadUpdate();
  const installUpdate = () => api.installUpdate();

  // System
  const minimizeToTray = () => api.minimizeToTray();
  const showWindow = () => api.showWindow();
  const quitApp = () => api.quitApp();
  const openExternal = (url: string) => api.openExternal(url);

  // Event listeners
  const onLifecycle = (
    callback: (data: { status: string; detail: string; running: boolean }) => void
  ) => {
    api.onLifecycle(callback);
  };

  const onLog = (callback: (entry: LogEntry | string) => void) => {
    api.onLog(callback);
  };

  const onBotState = (callback: (state: BotState) => void) => {
    api.onBotState(callback);
  };

  const onDashboardReady = (callback: (data: { url: string }) => void) => {
    api.onDashboardReady(callback);
  };

  const onUpdateAvailable = (callback: (info: UpdateInfo) => void) => {
    api.onUpdateAvailable(callback);
  };

  const onUpdateProgress = (callback: (progress: number) => void) => {
    api.onUpdateProgress(callback);
  };

  const removeAllListeners = (channel: string) => {
    api.removeAllListeners(channel);
  };

  return {
    // Settings
    getSettings,
    saveSettings,
    // Bot
    startBot,
    stopBot,
    restartBot,
    getBotStatus,
    // Logs
    getLogs,
    searchLogs,
    exportLogs,
    clearLogs,
    copyLogs,
    // Updater
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    // System
    minimizeToTray,
    showWindow,
    quitApp,
    openExternal,
    // Events
    onLifecycle,
    onLog,
    onBotState,
    onDashboardReady,
    onUpdateAvailable,
    onUpdateProgress,
    removeAllListeners,
  };
}

/**
 * Reactive IPC state for use in components
 */
export function createIpcState() {
  const api = window.api as ElectronAPI;

  return {
    // Event registration helpers
    on: <T>(_channel: string, _callback: (data: T) => void) => {
      // This would need to be implemented per channel
      console.warn('Direct event registration not implemented, use specific on* functions');
    },
    off: (channel: string) => {
      api.removeAllListeners(channel);
    },
  };
}
