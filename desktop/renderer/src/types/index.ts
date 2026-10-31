// Renderer type definitions

export interface Settings {
  host: string;
  port: number;
  username: string;
  version: string;
  openaiKey: string;
  webPort: number;
  enableMemory: boolean;
}

export interface BotStatus {
  online: boolean;
  username: string;
  status: string;
  event: string;
  reason: string | null;
  error: string | null;
  retryAt: number | null;
  retryInMs: number | null;
}

export interface BotState {
  status: string;
  users: string[];
  admins: string[];
  logs: string[];
  settings: {
    theme: string;
    autoDefense: boolean;
    autoArmor: boolean;
    stealth: boolean;
  };
  botData: {
    health: number;
    food: number;
    pos: { x: number; y: number; z: number };
  };
  inventory: {
    slot: number;
    name: string;
    displayName: string;
    count: number;
  }[];
  currentPath: { x: number; y: number; z: number }[];
  favorites: Record<string, { x: number; y: number; z: number }>;
  equipment: {
    head: string;
    chest: string;
    legs: string;
    feet: string;
    hand: string;
    offhand: string;
  };
  mapData?: {
    blocks: { x: number; z: number; name: string }[];
    entities: { x: number; z: number; name: string; isPlayer: boolean }[];
  };
}

export interface LogEntry {
  id: string;
  time: string;
  stream: 'stdout' | 'stderr' | 'system' | 'error';
  line: string;
  level?: 'info' | 'warn' | 'error' | 'debug';
}

export interface LogQuery {
  limit?: number;
  offset?: number;
  filter?: 'all' | 'errors' | 'system';
}

export interface LogSearchQuery {
  query: string;
  filter?: 'all' | 'errors' | 'system';
  timeRange?: { start: number; end: number };
  limit?: number;
}

export interface LogExportOptions {
  format: 'json' | 'csv' | 'txt';
  filter?: 'all' | 'errors' | 'system';
  timeRange?: { start: number; end: number };
}

export interface UpdateInfo {
  available: boolean;
  version?: string;
  releaseNotes?: string;
  releaseDate?: string;
}

export interface Toast {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
  duration?: number;
}

export interface ElectronAPI {
  // Settings
  getSettings: () => Promise<Settings & { portableMode: boolean; dataDirectory: string }>;
  saveSettings: (settings: Partial<Settings>) => Promise<Settings>;
  // Bot
  startBot: () => Promise<{ status: string }>;
  stopBot: () => Promise<{ status: string }>;
  restartBot: () => Promise<{ success: boolean; error?: string }>;
  getBotStatus: () => Promise<BotStatus>;
  // Logs
  getLogs: () => Promise<LogEntry[]>;
  searchLogs: (query: LogSearchQuery) => Promise<LogEntry[]>;
  exportLogs: (options: LogExportOptions) => Promise<{ path: string }>;
  clearLogs: () => Promise<void>;
  copyLogs: (text: string) => Promise<void>;
  // Updater
  checkForUpdates: () => Promise<UpdateInfo>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  // System
  minimizeToTray: () => Promise<void>;
  showWindow: () => Promise<void>;
  quitApp: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  // Events
  onLifecycle: (
    callback: (data: { status: string; detail: string; running: boolean }) => void
  ) => void;
  onLog: (callback: (entry: LogEntry) => void) => void;
  onBotState: (callback: (state: BotState) => void) => void;
  onDashboardReady: (callback: (data: { url: string }) => void) => void;
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => void;
  onUpdateProgress: (callback: (progress: number) => void) => void;
  removeAllListeners: (channel: string) => void;
}

// Extend Window interface
declare global {
  interface Window {
    api: ElectronAPI;
  }
}
