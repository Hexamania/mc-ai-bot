# Improved Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready Electron desktop app for Airi OS Minecraft bot with modern
architecture, reactive UI, encrypted settings, advanced logging, bot process management,
auto-updater, system tray, and native notifications.

**Architecture:** Merge the new TypeScript src/ architecture (BotManager, WebServer, PluginManager,
ConfigLoader) with Electron main process. Renderer uses TypeScript with reactive state management
(signals/observables). IPC bridges main and renderer securely via contextBridge. Bot runs in
utilityProcess for isolation. Auto-updater, system tray, and notifications integrated at main
process level.

**Tech Stack:** Electron 28+, TypeScript 5.9, mineflayer 4.39, express 4.19, socket.io 4.7,
electron-updater, electron-store (encrypted), node-notifier (native notifications), Vite for
renderer bundling.

**Spec:** This plan implements the 10 features requested: better main process, reactive renderer,
encrypted settings, log viewer, bot process management, dashboard embedding, auto-updater, portable
mode, system tray, native notifications.

## Global Constraints

- TypeScript strict mode, ES modules, target ES2022
- Electron security: contextIsolation=true, sandbox=true, nodeIntegration=false
- Settings encrypted via Electron safeStorage (Windows DPAPI)
- Bot process isolated via utilityProcess
- Portable mode: self-contained in executable directory with portable-data/
- Auto-updater: NSIS installer + portable zip, GitHub releases
- Windows 10/11 target, x64 only

## Review Focus

1. **IPC security** - Renderer cannot access Node APIs directly; all main<->renderer via typed IPC
2. **Bot process crashes** - utilityProcess should auto-restart with backoff, not crash main
3. **Settings encryption** - API key never in plaintext on disk; safeStorage unavailable handled
   gracefully
4. **Log viewer performance** - Search/filter/export on 500+ entries without UI blocking
5. **Auto-updater race conditions** - Download doesn't corrupt running app; portable mode handled

---

### Task 1: Project Setup & TypeScript Configuration

**Files:**

- Create: `tsconfig.json` (root, extends from src/tsconfig.json)
- Create: `desktop/tsconfig.json` (main process)
- Create: `desktop/renderer/tsconfig.json` (renderer)
- Modify: `package.json` (scripts, dependencies)

**Interfaces:**

- Consumes: existing package.json, src/tsconfig.json
- Produces: Build system ready for main + renderer TypeScript

- [ ] **Step 1: Update package.json with new dependencies and scripts**

```json
{
  "scripts": {
    "build:main": "tsc -p desktop/tsconfig.json",
    "build:renderer": "vite build --config desktop/renderer/vite.config.ts",
    "build": "npm run build:main && npm run build:renderer",
    "dev:main": "tsx watch desktop/main.ts",
    "dev:renderer": "vite --config desktop/renderer/vite.config.ts",
    "dev": "concurrently \"npm run dev:main\" \"npm run dev:renderer\"",
    "desktop": "electron dist/desktop/main.js",
    "desktop:dev": "npm run build && electron ."
  },
  "dependencies": {
    "electron-updater": "^6.1.0",
    "electron-store": "^10.0.0",
    "node-notifier": "^10.0.1",
    "signals": "^1.0.0"
  },
  "devDependencies": {
    "vite": "^5.0.0",
    "@vitejs/plugin-vue": "^5.0.0",
    "concurrently": "^8.2.0",
    "tsx": "^4.16.0"
  }
}
```

- [ ] **Step 2: Create root tsconfig.json**
- [ ] **Step 3: Create desktop/tsconfig.json for main process**
- [ ] **Step 4: Create desktop/renderer/tsconfig.json for renderer**
- [ ] **Step 5: Create desktop/renderer/vite.config.ts**
- [ ] **Step 6: Run build to verify**

---

### Task 2: Main Process Architecture (Better Architecture)

**Files:**

- Create: `desktop/main.ts` (new main process entry)
- Create: `desktop/services/BotProcessManager.ts` (spawn, monitor, restart)
- Create: `desktop/services/SettingsService.ts` (encrypted settings)
- Create: `desktop/services/LogService.ts` (log persistence + search)
- Create: `desktop/services/AutoUpdaterService.ts` (electron-updater)
- Create: `desktop/services/SystemTrayService.ts` (system tray)
- Create: `desktop/services/NotificationService.ts` (native notifications)
- Create: `desktop/services/PortableService.ts` (portable mode)
- Create: `desktop/ipc/handlers.ts` (IPC handler registration)
- Create: `desktop/ipc/channels.ts` (typed IPC channel definitions)
- Modify: `desktop/preload.ts` (contextBridge API)

**Interfaces:**

- Consumes: src/bot/BotManager, src/web/WebServer, src/config/ConfigLoader
- Produces: Main process services, IPC API for renderer

- [ ] **Step 1: Create typed IPC channel definitions**

```typescript
// desktop/ipc/channels.ts
export const IPC_CHANNELS = {
  // Settings
  'settings:get': { request: void, response: Settings },
  'settings:save': { request: Partial<Settings>, response: Settings },
  // Bot
  'bot:start': { request: void, response: { success: boolean; error?: string } },
  'bot:stop': { request: void, response: { success: boolean } },
  'bot:restart': { request: void, response: { success: boolean; error?: string } },
  'bot:status': { request: void, response: BotStatus },
  // Logs
  'logs:get': { request: LogQuery, response: LogEntry[] },
  'logs:search': { request: LogSearchQuery, response: LogEntry[] },
  'logs:export': { request: LogExportOptions, response: { path: string } },
  'logs:clear': { request: void, response: void },
  // Auto-updater
  'updater:check': { request: void, response: UpdateInfo },
  'updater:download': { request: void, response: { progress: number } },
  'updater:install': { request: void, response: void },
  // System
  'system:minimizeToTray': { request: void, response: void },
  'system:showWindow': { request: void, response: void },
  'system:quit': { request: void, response: void },
} as const;
```

- [ ] **Step 2: Create BotProcessManager with spawn/monitor/restart**
- [ ] **Step 3: Create SettingsService with safeStorage encryption**
- [ ] **Step 4: Create LogService with search/filter/export**
- [ ] **Step 5: Create AutoUpdaterService with electron-updater**
- [ ] **Step 6: Create SystemTrayService with context menu**
- [ ] **Step 7: Create NotificationService with node-notifier**
- [ ] **Step 8: Create PortableService for portable mode detection**
- [ ] **Step 9: Create main.ts wiring all services together**
- [ ] **Step 10: Update preload.ts with new typed API**
- [ ] **Step 11: Build and test main process**

---

### Task 3: Renderer with Reactive State Management

**Files:**

- Create: `desktop/renderer/src/main.ts` (renderer entry)
- Create: `desktop/renderer/src/App.vue` (root component)
- Create: `desktop/renderer/src/stores/botStore.ts` (bot state + actions)
- Create: `desktop/renderer/src/stores/settingsStore.ts` (settings state)
- Create: `desktop/renderer/src/stores/logStore.ts` (log state + search/filter)
- Create: `desktop/renderer/src/stores/uiStore.ts` (UI state: sidebar, modals, toasts)
- Create: `desktop/renderer/src/components/BotStatus.vue`
- Create: `desktop/renderer/src/components/SettingsPanel.vue`
- Create: `desktop/renderer/src/components/LogViewer.vue`
- Create: `desktop/renderer/src/components/DashboardEmbed.vue`
- Create: `desktop/renderer/src/components/SystemTrayMenu.vue`
- Create: `desktop/renderer/src/composables/useIpc.ts` (typed IPC hooks)
- Create: `desktop/renderer/src/types/index.ts` (renderer types)
- Create: `desktop/renderer/index.html` (Vite entry HTML)
- Create: `desktop/renderer/style.css` (global styles)

**Interfaces:**

- Consumes: preload.ts exposed `window.api`
- Produces: Reactive UI components, stores

- [ ] **Step 1: Set up Vue 3 + Pinia (or signals) for reactive state**
- [ ] **Step 2: Create typed IPC composable**
- [ ] **Step 3: Create botStore with status, connection, commands**
- [ ] **Step 4: Create settingsStore with validation + encryption awareness**
- [ ] **Step 5: Create logStore with search, filter, pagination, export**
- [ ] **Step 6: Create UI store for toasts, modals, sidebar**
- [ ] **Step 7: Build BotStatus component with live indicators**
- [ ] **Step 8: Build SettingsPanel with form validation**
- [ ] **Step 9: Build LogViewer with virtual scrolling, search, filter, export**
- [ ] **Step 10: Build DashboardEmbed with iframe + Socket.io bridge**
- [ ] **Step 11: Wire everything in App.vue**
- [ ] **Step 12: Build renderer and test**

---

### Task 4: Settings Persistence with Encryption

**Files:**

- Modify: `desktop/services/SettingsService.ts` (from Task 2)
- Create: `desktop/services/EncryptionService.ts` (safeStorage wrapper)
- Create: `desktop/types/settings.ts` (settings schema + validation)

**Interfaces:**

- Consumes: Electron safeStorage, ConfigLoader from src/
- Produces: Encrypted settings API

- [ ] **Step 1: Create EncryptionService with safeStorage + fallback**
- [ ] **Step 2: Define Settings schema with Zod validation**
- [ ] **Step 3: Implement SettingsService load/save with encryption**
- [ ] **Step 4: Handle safeStorage unavailable (portable/non-Windows)**
- [ ] **Step 5: Add migration from old settings format**
- [ ] **Step 6: Test encryption/decryption roundtrip**

---

### Task 5: Log Viewer with Search/Filter/Export

**Files:**

- Modify: `desktop/services/LogService.ts` (from Task 2)
- Create: `desktop/renderer/src/components/LogViewer.vue` (from Task 3)
- Create: `desktop/renderer/src/composables/useLogSearch.ts`

**Interfaces:**

- Consumes: LogService IPC, bot process stdout/stderr
- Produces: Searchable, filterable, exportable log viewer

- [ ] **Step 1: Implement LogService with file rotation, indexing**
- [ ] **Step 2: Add full-text search with lunr.js or simple index**
- [ ] **Step 3: Add filter by level, source, time range**
- [ ] **Step 4: Implement export to JSON/CSV/TXT**
- [ ] **Step 5: Build LogViewer with virtual scrolling**
- [ ] **Step 6: Add keyboard shortcuts (Ctrl+F, Ctrl+E)**
- [ ] **Step 7: Test with 1000+ log entries**

---

### Task 6: Bot Process Management

**Files:**

- Modify: `desktop/services/BotProcessManager.ts` (from Task 2)
- Create: `desktop/bot-worker/main.ts` (utilityProcess entry)
- Create: `desktop/bot-worker/ipc.ts` (worker<->main communication)

**Interfaces:**

- Consumes: src/bot/BotManager, src/web/WebServer
- Produces: Managed bot process with health monitoring

- [ ] **Step 1: Create bot-worker entry point using src/bot architecture**
- [ ] **Step 2: Implement BotProcessManager with utilityProcess.fork**
- [ ] **Step 3: Add health monitoring (heartbeat, memory, CPU)**
- [ ] **Step 4: Implement auto-restart with exponential backoff**
- [ ] **Step 5: Add graceful shutdown handling**
- [ ] **Step 6: Expose bot status/control via IPC**
- [ ] **Step 7: Test crash recovery and restart**

---

### Task 7: Dashboard Embedding with Communication

**Files:**

- Create: `desktop/renderer/src/components/DashboardEmbed.vue`
- Create: `desktop/renderer/src/composables/useDashboard.ts`
- Modify: `desktop/services/BotProcessManager.ts` (expose dashboard URL)

**Interfaces:**

- Consumes: WebServer from src/, Socket.io client
- Produces: Embedded dashboard with bi-directional communication

- [ ] **Step 1: Ensure WebServer serves dashboard at known path**
- [ ] **Step 2: Create DashboardEmbed component with iframe**
- [ ] **Step 3: Add Socket.io connection from renderer to dashboard**
- [ ] **Step 4: Bridge bot commands from UI to bot via Socket.io**
- [ ] **Step 5: Handle dashboard ready/load events**
- [ ] **Step 6: Add refresh, open-in-browser actions**

---

### Task 8: Auto-Updater Integration

**Files:**

- Modify: `desktop/services/AutoUpdaterService.ts` (from Task 2)
- Create: `desktop/renderer/src/components/UpdateBanner.vue`
- Modify: `package.json` build config for electron-builder

**Interfaces:**

- Consumes: electron-updater, GitHub releases
- Produces: Automatic update check, download, install

- [ ] **Step 1: Configure electron-builder for NSIS + portable**
- [ ] **Step 2: Implement AutoUpdaterService with event forwarding**
- [ ] **Step 3: Add update check on startup + periodic**
- [ ] **Step 4: Implement download progress UI**
- [ ] **Step 5: Handle portable mode updates (replace executable)**
- [ ] **Step 6: Add "Check for updates" menu item**
- [ ] **Step 7: Test with GitHub releases**

---

### Task 9: Portable Mode Improvements

**Files:**

- Modify: `desktop/services/PortableService.ts` (from Task 2)
- Modify: `desktop/services/SettingsService.ts` (portable data path)
- Modify: `desktop/services/LogService.ts` (portable log path)
- Modify: `desktop/main.ts` (portable detection)

**Interfaces:**

- Consumes: Portable detection logic
- Produces: Self-contained portable app

- [ ] **Step 1: Improve portable detection (portable.txt, env var, install dir)**
- [ ] **Step 2: Ensure all data paths use portableDataDirectory in portable mode**
- [ ] **Step 3: Handle portable executable replacement on update**
- [ ] **Step 4: Add portable mode indicator in UI**
- [ ] **Step 5: Test portable zip extraction and run**

---

### Task 10: System Tray Support

**Files:**

- Modify: `desktop/services/SystemTrayService.ts` (from Task 2)
- Create: `desktop/assets/tray-icon.png` (tray icon)
- Create: `desktop/assets/tray-icon.ico` (Windows tray icon)

**Interfaces:**

- Consumes: Electron Tray, BrowserWindow
- Produces: System tray with context menu

- [ ] **Step 1: Create tray icon assets**
- [ ] **Step 2: Implement SystemTrayService with context menu**
- [ ] **Step 3: Menu items: Show, Start/Stop Bot, Open Dashboard, Settings, Quit**
- [ ] **Step 4: Handle minimize to tray vs close**
- [ ] **Step 5: Add bot status tooltip on tray icon**
- [ ] **Step 6: Test minimize/restore/quit flows**

---

### Task 11: Native Notifications

**Files:**

- Modify: `desktop/services/NotificationService.ts` (from Task 2)
- Create: `desktop/renderer/src/composables/useNotifications.ts`

**Interfaces:**

- Consumes: node-notifier, Electron Notification API
- Produces: Cross-platform native notifications

- [ ] **Step 1: Implement NotificationService with node-notifier fallback**
- [ ] **Step 2: Add notification permissions handling**
- [ ] **Step 3: Create notification types: bot connected, error, chat mention, task complete**
- [ ] **Step 4: Add "Do not disturb" mode**
- [ ] **Step 5: Bridge renderer notification requests to main**
- [ ] **Step 6: Test on Windows 10/11**

---

### Task 12: Integration Testing & Polish

**Files:**

- Create: `desktop/renderer/src/views/DashboardView.vue`
- Create: `desktop/renderer/src/views/SettingsView.vue`
- Create: `desktop/renderer/src/views/LogsView.vue`
- Modify: All previous files for integration

**Interfaces:**

- Consumes: All previous tasks
- Produces: Complete working desktop app

- [ ] **Step 1: Build complete app with `npm run build`**
- [ ] **Step 2: Test all 10 features end-to-end**
- [ ] **Step 3: Test portable mode**
- [ ] **Step 4: Test auto-updater with mock release**
- [ ] **Step 5: Fix any integration issues**
- [ ] **Step 6: Build distributables with `npm run desktop:dist`**

---

## Task Dependencies

```
Task 1 (Setup)
    → Task 2 (Main Process)
        → Task 3 (Renderer)
            → Task 4 (Settings)
            → Task 5 (Logs)
            → Task 6 (Bot Process)
            → Task 7 (Dashboard)
            → Task 8 (Updater)
            → Task 9 (Portable)
            → Task 10 (Tray)
            → Task 11 (Notifications)
                → Task 12 (Integration)
```

Tasks 4-11 can be developed in parallel after Task 2 and 3 provide the foundation.
