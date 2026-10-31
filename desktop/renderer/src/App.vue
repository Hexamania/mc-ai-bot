<script setup lang="ts">
import { onMounted, onUnmounted, computed, nextTick } from 'vue';
import { useBotStore } from './stores/botStore';
import { useLogStore } from './stores/logStore';
import { useUIStore } from './stores/uiStore';
import { useSettingsStore } from './stores/settingsStore';
import BotStatus from './components/BotStatus.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import LogViewer from './components/LogViewer.vue';
import DashboardEmbed from './components/DashboardEmbed.vue';
import Toast from './components/Toast.vue';

const botStore = useBotStore();
const logStore = useLogStore();
const uiStore = useUIStore();
const settingsStore = useSettingsStore();

const sidebarOpen = computed(() => uiStore.isSidebarOpen);
const activeView = computed(() => uiStore.activeView);

function handleStart() {
  void botStore.start();
}

function handleStop() {
  void botStore.stop();
}

function handleRestart() {
  void botStore.restart();
}

function handleOpenDashboard() {
  uiStore.setActiveView('dashboard');
}

function setActiveView(view: 'dashboard' | 'settings' | 'logs') {
  uiStore.setActiveView(view);
}

function toggleSidebar() {
  uiStore.toggleSidebar();
}

onMounted(async () => {
  // Initialize event listeners
  botStore.initListeners();
  logStore.loadLogs();

  // Load settings
  try {
    await settingsStore.loadSettings();
  } catch (error) {
    console.error('Failed to load settings:', error);
  }

  // Fetch initial bot status
  botStore.fetchStatus();

  // Set up keyboard shortcuts
  document.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  botStore.cleanup();
  logStore.cleanup();
  document.removeEventListener('keydown', handleKeydown);
});

function handleKeydown(event: KeyboardEvent) {
  // Ctrl+F for log search
  if (event.ctrlKey && event.key === 'f') {
    event.preventDefault();
    uiStore.setActiveView('logs');
    nextTick(() => {
      // Focus search input
      const input = document.querySelector('.search-input') as HTMLInputElement;
      input?.focus();
    });
  }

  // Ctrl+Shift+C for copy logs
  if (event.ctrlKey && event.shiftKey && event.key === 'C') {
    event.preventDefault();
    logStore.copyLogs();
    uiStore.success('Logs copied to clipboard');
  }

  // Escape to close modals/sidebars
  if (event.key === 'Escape') {
    // Could close modals here
  }
}

const currentView = computed(() => {
  switch (activeView.value) {
    case 'dashboard':
      return DashboardEmbed;
    case 'settings':
      return SettingsPanel;
    case 'logs':
      return LogViewer;
    default:
      return DashboardEmbed;
  }
});
</script>

<template>
  <div class="app">
    <!-- Ambient background effects -->
    <div class="ambient ambient-one" />
    <div class="ambient ambient-two" />

    <!-- Topbar -->
    <header class="topbar">
      <button class="sidebar-toggle" aria-label="Toggle sidebar" @click="toggleSidebar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      <a class="brand" href="https://github.com/Hexamania" target="_blank" rel="noopener">
        <div class="brand-mark"><span>A</span></div>
        <div class="brand-copy">
          <strong>Airi OS</strong>
          <small>Minecraft Bot Dashboard</small>
        </div>
      </a>

      <div class="topbar-center">
        <BotStatus />
      </div>

      <div class="topbar-actions">
        <a class="repo-link" href="https://github.com/Hexamania" target="_blank" rel="noopener">
          <span class="repo-glyph">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path
                d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"
              />
            </svg>
          </span>
          <span>GitHub</span>
        </a>
      </div>
    </header>

    <!-- Main App Shell -->
    <div class="app-shell">
      <!-- Sidebar -->
      <aside class="settings-rail" :class="{ collapsed: !sidebarOpen }">
        <div class="rail-header">
          <div v-show="sidebarOpen" class="intro">
            <p class="eyebrow">Configuration</p>
            <h1 v-show="sidebarOpen">Airi <span>OS</span></h1>
            <p v-show="sidebarOpen">
              Enter your server details, choose a Minecraft version, and optionally add an OpenAI key for in-game AI
              chat.
            </p>
          </div>
        </div>

        <nav v-show="sidebarOpen" class="rail-nav">
          <button class="nav-item" :class="{ active: activeView === 'dashboard' }" @click="setActiveView('dashboard')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="nav-icon">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            <span>Dashboard</span>
          </button>
          <button class="nav-item" :class="{ active: activeView === 'settings' }" @click="setActiveView('settings')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="nav-icon">
              <circle cx="12" cy="12" r="3" />
              <path
                d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 21.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"
              />
            </svg>
            <span>Settings</span>
          </button>
          <button class="nav-item" :class="{ active: activeView === 'logs' }" @click="setActiveView('logs')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="nav-icon">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span>Logs</span>
          </button>
        </nav>

        <div v-show="sidebarOpen" class="rail-footer">
          <div class="quick-actions">
            <button class="btn btn--primary btn--launch" :disabled="!botStore.canStart" @click="handleStart">
              <span>Save & Start Bot</span>
              <span class="launch-icon">▶</span>
            </button>
            <div class="secondary-actions">
              <button class="btn btn--stop" :disabled="!botStore.canStop" @click="handleStop">Stop Bot</button>
              <button class="btn btn--dashboard" :disabled="!botStore.isOnline" @click="handleOpenDashboard">
                Open Dashboard
              </button>
            </div>
            <button class="btn btn--dashboard" :disabled="!botStore.isRunning" @click="handleRestart">
              <span>Restart Bot</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="launch-icon">
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
              </svg>
            </button>
          </div>

          <p v-if="settingsStore.saveError" id="notice" class="notice">
            {{ settingsStore.saveError }}
          </p>

          <div class="rail-footer-info">
            <p class="storage-note">
              <span class="secure-icon">🔒</span>
              {{
                settingsStore.isPortableMode
                  ? `Portable settings and memory: ${settingsStore.dataDirectory}. API key encryption is tied to this Windows account.`
                  : 'Settings and memory are stored in your Windows profile. API key uses Windows secure storage.'
              }}
            </p>
            <p class="maker-note"><span class="maker-dot">●</span>Created by <strong>Hexamania</strong></p>
          </div>
        </div>
      </aside>

      <!-- Main Workspace -->
      <section class="workspace">
        <component :is="currentView" />
      </section>
    </div>

    <!-- Toast Container -->
    <div class="toast-container" aria-live="polite" aria-atomic="true">
      <Toast v-for="toast in uiStore.visibleToasts" :key="toast.id" :toast="toast" />
    </div>
  </div>
</template>

<style scoped>
.app {
  position: relative;
  width: 100%;
  height: 100vh;
  overflow: hidden;
  background: radial-gradient(ellipse at 77% -20%, rgba(81, 87, 159, 0.15), transparent 45%), #080b12;
  font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
  color-scheme: dark;
}

.ambient {
  position: fixed;
  z-index: -1;
  width: 380px;
  height: 380px;
  pointer-events: none;
  border-radius: 50%;
  filter: blur(110px);
  opacity: 0.12;
  animation: ambient-drift 14s ease-in-out infinite alternate;
}

.ambient-one {
  top: 21%;
  left: -260px;
  background: #45d9bc;
}

.ambient-two {
  right: -260px;
  bottom: -200px;
  background: #705cf0;
  animation-delay: -5s;
}

.topbar {
  height: 72px;
  position: relative;
  z-index: 10;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  padding: 0 24px;
  gap: 16px;
  border-bottom: 1px solid rgba(149, 166, 197, 0.13);
  background: rgba(9, 13, 21, 0.78);
  backdrop-filter: blur(18px);
  animation: slide-down 0.55s cubic-bezier(0.2, 0.7, 0.2, 1) both;
}

.sidebar-toggle {
  display: none;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #a9b4c7;
  cursor: pointer;
  transition:
    background 0.2s,
    color 0.2s;
}

.sidebar-toggle:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #edf2fa;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  color: inherit;
  text-decoration: none;
}

.brand-mark {
  width: 37px;
  height: 37px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(151, 242, 221, 0.35);
  border-radius: 12px;
  background: linear-gradient(145deg, #9af4d8 0%, #6ec9ff 100%);
  box-shadow:
    0 0 26px rgba(93, 217, 195, 0.19),
    inset 0 1px 0 #ffffff80;
  color: #09111b;
  font:
    700 22px 'Segoe UI Variable Display',
    'Segoe UI',
    sans-serif;
}

.brand-mark span {
  transform: translateY(-1px);
}

.brand-copy strong {
  display: block;
  font:
    600 14px 'Segoe UI Variable Display',
    'Segoe UI',
    sans-serif;
  letter-spacing: -0.03em;
}

.brand-copy small {
  display: block;
  margin-top: 3px;
  color: #69758a;
  font:
    8px 'Cascadia Code',
    Consolas,
    monospace;
  letter-spacing: 0.13em;
}

.topbar-center {
  justify-self: center;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.topbar-actions {
  justify-self: end;
}

.repo-link {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #b3bed0;
  font-size: 10px;
  text-decoration: none;
  transition: color 0.2s;
}

.repo-link:hover {
  color: #73ebc2;
}

.repo-glyph {
  display: grid;
  width: 25px;
  height: 25px;
  place-items: center;
  border: 1px solid rgba(149, 166, 197, 0.13);
  border-radius: 8px;
  color: #73ebc2;
}

.app-shell {
  width: min(1600px, 100%);
  height: calc(100vh - 72px);
  margin: 0 auto;
  display: grid;
  grid-template-columns: 330px minmax(0, 1fr);
  transition: grid-template-columns 0.3s ease;
}

.app-shell.sidebar-collapsed {
  grid-template-columns: 60px minmax(0, 1fr);
}

.settings-rail {
  position: relative;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 24px 22px 14px;
  overflow-x: hidden;
  overflow-y: auto;
  border-right: 1px solid rgba(149, 166, 197, 0.13);
  background: linear-gradient(165deg, rgba(17, 25, 39, 0.78), rgba(10, 14, 22, 0.88));
  animation: slide-right 0.65s 0.08s cubic-bezier(0.2, 0.7, 0.2, 1) both;
  transition:
    padding 0.3s ease,
    width 0.3s ease;
}

.settings-rail.collapsed {
  padding-left: 16px;
  padding-right: 16px;
}

.rail-header {
  flex-shrink: 0;
}

.intro {
  padding: 20px 0 16px;
}

.eyebrow {
  margin: 0 0 8px;
  color: #73ebc2;
  font:
    8px 'Cascadia Code',
    Consolas,
    monospace;
  letter-spacing: 0.17em;
}

h1 {
  margin: 0 0 8px;
  font:
    500 28px/0.98 'Segoe UI Variable Display',
    'Segoe UI',
    sans-serif;
  letter-spacing: -0.06em;
}

h1 > span {
  color: #7f8da5;
}

.intro > p:last-child {
  max-width: 225px;
  margin: 0;
  color: #7c879b;
  font-size: 10px;
  line-height: 1.6;
}

.rail-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0 16px;
  flex-shrink: 0;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: #9aa8bb;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.03);
  border-color: rgba(149, 166, 197, 0.1);
  color: #dce6f4;
}

.nav-item.active {
  background: rgba(115, 235, 194, 0.1);
  border-color: rgba(115, 235, 194, 0.3);
  color: #73ebc2;
}

.nav-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: inherit;
}

.quick-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: auto;
  padding-top: 16px;
  border-top: 1px solid rgba(149, 166, 197, 0.13);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 10px;
  font-weight: 700;
  font-family: inherit;
  transition:
    transform 0.15s,
    border-color 0.15s,
    background 0.15s,
    box-shadow 0.15s,
    opacity 0.15s;
}

.btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.btn:active:not(:disabled) {
  transform: translateY(0) scale(0.99);
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

.btn--primary {
  background: linear-gradient(105deg, #87f0cd, #77cfe7);
  box-shadow:
    0 7px 23px rgba(98, 219, 186, 0.22),
    inset 0 1px rgba(255, 255, 255, 0.4);
  color: #081610;
}

.btn--primary:hover:not(:disabled) {
  box-shadow:
    0 9px 26px rgba(98, 219, 186, 0.35),
    inset 0 1px rgba(255, 255, 255, 0.5);
}

.btn--launch {
  min-height: 44px;
}

.launch-icon {
  margin-left: 2px;
  font-size: 10px;
}

.secondary-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.btn--stop {
  min-height: 34px;
  border-color: rgba(149, 166, 197, 0.16);
  background: rgba(17, 24, 36, 0.85);
  color: #9aa8bb;
  font-size: 9px;
}

.btn--stop:hover:not(:disabled) {
  border-color: #bd5662;
  color: #ff9fa6;
}

.btn--dashboard {
  min-height: 34px;
  border-color: rgba(149, 166, 197, 0.16);
  background: rgba(17, 24, 36, 0.85);
  color: #9aa8bb;
  font-size: 9px;
}

.btn--dashboard:hover:not(:disabled) {
  border-color: #55c9a8;
  color: #73ebc2;
}

.notice {
  min-height: 23px;
  margin: 8px 0 0;
  color: #73ebc2;
  font-size: 10px;
  line-height: 1.5;
}

.notice.error {
  color: #ff929a;
}

.rail-footer-info {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid rgba(149, 166, 197, 0.13);
}

.storage-note {
  display: flex;
  gap: 7px;
  color: #718096;
  font-size: 8px;
  line-height: 1.5;
}

.secure-icon {
  color: #73ebc2;
  font-size: 8px;
  flex-shrink: 0;
  margin-top: 1px;
}

.maker-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  color: #66748a;
  font:
    7px 'Cascadia Code',
    Consolas,
    monospace;
  letter-spacing: 0.08em;
}

.maker-note strong {
  color: #aab7ca;
  font-weight: 500;
}

.maker-dot {
  color: #73ebc2;
  font-size: 11px;
}

.workspace {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(300px, 1fr);
  gap: 12px;
  padding: 18px 20px 10px;
  animation: rise-in 0.68s 0.13s cubic-bezier(0.2, 0.7, 0.2, 1) both;
}

.toast-container {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 420px;
  pointer-events: none;
}

.toast-container > * {
  pointer-events: auto;
}

@keyframes slide-down {
  from {
    opacity: 0;
    transform: translateY(-12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes slide-right {
  from {
    opacity: 0;
    transform: translateX(-14px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes rise-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes ambient-drift {
  from {
    transform: translateY(-15px) scale(0.9);
  }
  to {
    transform: translateY(25px) scale(1.1);
  }
}

@media (max-width: 1100px) {
  .app-shell {
    grid-template-columns: 290px minmax(0, 1fr);
  }
  .settings-rail {
    padding-right: 18px;
    padding-left: 18px;
  }
  .workspace {
    padding-right: 14px;
    padding-left: 14px;
  }
}

@media (max-width: 920px) {
  .sidebar-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .app-shell {
    grid-template-columns: 1fr;
  }

  .settings-rail {
    position: fixed;
    top: 72px;
    left: 0;
    bottom: 0;
    width: 330px;
    max-width: 85vw;
    z-index: 100;
    border-right: none;
    border-bottom: 1px solid rgba(149, 166, 197, 0.13);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
    transform: translateX(-100%);
    transition: transform 0.3s ease;
  }

  .settings-rail:not(.collapsed) {
    transform: translateX(0);
  }

  .rail-header {
    display: none;
  }

  .workspace {
    padding-top: 12px;
    padding-bottom: 8px;
  }
}

@media (max-height: 760px) {
  .settings-rail {
    padding-top: 14px;
    padding-bottom: 8px;
  }
  .intro {
    padding: 12px 0 10px;
  }
  h1 {
    font-size: 24px;
  }
  .workspace {
    padding-top: 10px;
    padding-bottom: 6px;
  }
  .topbar {
    height: 62px;
  }
  .app-shell {
    height: calc(100vh - 62px);
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
