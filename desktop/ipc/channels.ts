/**
 * Typed IPC channel definitions for main <-> renderer communication
 */

import type {
  Settings,
  BotStatus,
  BotState,
  LogEntry,
  LogQuery,
  LogSearchQuery,
  LogExportOptions,
  UpdateInfo,
} from '../renderer/src/types';

// Channel definition type
export interface ChannelDefinition<TRequest, TResponse> {
  request: TRequest;
  response: TResponse;
}

// Settings channels
export type SettingsGetChannel = ChannelDefinition<
  void,
  Settings & { portableMode: boolean; dataDirectory: string }
>;
export type SettingsSaveChannel = ChannelDefinition<Partial<Settings>, Settings>;

// Bot control channels
export type BotStartChannel = ChannelDefinition<void, { status: string }>;
export type BotStopChannel = ChannelDefinition<void, { status: string }>;
export type BotRestartChannel = ChannelDefinition<void, { success: boolean; error?: string }>;
export type BotStatusChannel = ChannelDefinition<void, BotStatus>;

// Logs channels
export type LogsGetChannel = ChannelDefinition<LogQuery | undefined, LogEntry[]>;
export type LogsSearchChannel = ChannelDefinition<LogSearchQuery, LogEntry[]>;
export type LogsExportChannel = ChannelDefinition<LogExportOptions, { path: string }>;
export type LogsClearChannel = ChannelDefinition<void, void>;
export type LogsCopyChannel = ChannelDefinition<string, void>;

// Updater channels
export type UpdaterCheckChannel = ChannelDefinition<void, UpdateInfo>;
export type UpdaterDownloadChannel = ChannelDefinition<void, { progress: number }>;
export type UpdaterInstallChannel = ChannelDefinition<void, void>;

// System channels
export type SystemMinimizeToTrayChannel = ChannelDefinition<void, void>;
export type SystemShowWindowChannel = ChannelDefinition<void, void>;
export type SystemQuitChannel = ChannelDefinition<void, void>;
export type ShellOpenExternalChannel = ChannelDefinition<string, void>;

// Event payloads (main -> renderer)
export interface AppLifecycleEvent {
  status: string;
  detail: string;
  running: boolean;
}

export type AppLogEvent = LogEntry;

export type AppBotStateEvent = BotState;

export interface AppDashboardReadyEvent {
  url: string;
}

export type UpdaterUpdateAvailableEvent = UpdateInfo;

export type UpdaterDownloadProgressEvent = ChannelDefinition<void, number>;

export type UpdaterUpdateDownloadedEvent = UpdateInfo;

export type UpdaterErrorEvent = ChannelDefinition<void, string>;

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
