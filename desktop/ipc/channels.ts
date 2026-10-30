/**
 * Typed IPC channel definitions for main <-> renderer communication
 */

import type { Settings, BotStatus, BotState, LogEntry, LogQuery, LogSearchQuery, LogExportOptions, UpdateInfo } from '../renderer/src/types';

// Channel definition type
export interface ChannelDefinition<TRequest, TResponse> {
  request: TRequest;
  response: TResponse;
}

// Settings channels
export interface SettingsGetChannel extends ChannelDefinition<void, Settings & { portableMode: boolean; dataDirectory: string }> {}
export interface SettingsSaveChannel extends ChannelDefinition<Partial<Settings>, Settings> {}

// Bot control channels
export interface BotStartChannel extends ChannelDefinition<void, { status: string }> {}
export interface BotStopChannel extends ChannelDefinition<void, { status: string }> {}
export interface BotRestartChannel extends ChannelDefinition<void, { success: boolean; error?: string }> {}
export interface BotStatusChannel extends ChannelDefinition<void, BotStatus> {}

// Logs channels
export interface LogsGetChannel extends ChannelDefinition<LogQuery | undefined, LogEntry[]> {}
export interface LogsSearchChannel extends ChannelDefinition<LogSearchQuery, LogEntry[]> {}
export interface LogsExportChannel extends ChannelDefinition<LogExportOptions, { path: string }> {}
export interface LogsClearChannel extends ChannelDefinition<void, void> {}
export interface LogsCopyChannel extends ChannelDefinition<string, void> {}

// Updater channels
export interface UpdaterCheckChannel extends ChannelDefinition<void, UpdateInfo> {}
export interface UpdaterDownloadChannel extends ChannelDefinition<void, { progress: number }> {}
export interface UpdaterInstallChannel extends ChannelDefinition<void, void> {}

// System channels
export interface SystemMinimizeToTrayChannel extends ChannelDefinition<void, void> {}
export interface SystemShowWindowChannel extends ChannelDefinition<void, void> {}
export interface SystemQuitChannel extends ChannelDefinition<void, void> {}
export interface ShellOpenExternalChannel extends ChannelDefinition<string, void> {}

// Event payloads (main -> renderer)
export interface AppLifecycleEvent {
  status: string;
  detail: string;
  running: boolean;
}

export interface AppLogEvent extends LogEntry {}

export interface AppBotStateEvent extends BotState {}

export interface AppDashboardReadyEvent {
  url: string;
}

export interface UpdaterUpdateAvailableEvent extends UpdateInfo {}

export interface UpdaterDownloadProgressEvent extends ChannelDefinition<void, number> {}

export interface UpdaterUpdateDownloadedEvent extends UpdateInfo {}

export interface UpdaterErrorEvent extends ChannelDefinition<void, string> {}

// Type maps for channel names to request/response types
export interface ChannelMap {
  'settings:get': SettingsGetChannel;
  'settings:save': SettingsSaveChannel;
  'bot:start': BotStartChannel;
  'bot:stop': BotStopChannel;
  'bot:restart': BotRestartChannel;
  'bot:status': BotStatusChannel;
  'logs:get': LogsGetChannel;
  'logs:search': LogsSearchChannel;
  'logs:export': LogsExportChannel;
  'logs:clear': LogsClearChannel;
  'logs:copy': LogsCopyChannel;
  'updater:check': UpdaterCheckChannel;
  'updater:download': UpdaterDownloadChannel;
  'updater:install': UpdaterInstallChannel;
  'system:minimizeToTray': SystemMinimizeToTrayChannel;
  'system:showWindow': SystemShowWindowChannel;
  'system:quit': SystemQuitChannel;
  'shell:openExternal': ShellOpenExternalChannel;
}

export interface EventMap {
  'app:lifecycle': AppLifecycleEvent;
  'app:log': AppLogEvent;
  'app:bot-state': AppBotStateEvent;
  'app:dashboard-ready': AppDashboardReadyEvent;
  'updater:update-available': UpdaterUpdateAvailableEvent;
  'updater:download-progress': number;
  'updater:update-downloaded': UpdaterUpdateDownloadedEvent;
  'updater:error': string;
}

// Type helpers
export type ChannelName = keyof ChannelMap;
export type EventName = keyof EventMap;

export type ChannelRequest<T extends ChannelName> = ChannelMap[T]['request'];
export type ChannelResponse<T extends ChannelName> = ChannelMap[T]['response'];

export type EventPayload<T extends EventName> = EventMap[T];

// Runtime channel/event names (for validation)
export const CHANNEL_NAMES = [
  'settings:get',
  'settings:save',
  'bot:start',
  'bot:stop',
  'bot:restart',
  'bot:status',
  'logs:get',
  'logs:search',
  'logs:export',
  'logs:clear',
  'logs:copy',
  'updater:check',
  'updater:download',
  'updater:install',
  'system:minimizeToTray',
  'system:showWindow',
  'system:quit',
  'shell:openExternal',
] as const;

export const EVENT_NAMES = [
  'app:lifecycle',
  'app:log',
  'app:bot-state',
  'app:dashboard-ready',
  'updater:update-available',
  'updater:download-progress',
  'updater:update-downloaded',
  'updater:error',
] as const;