<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useLogStore } from '../stores/logStore';
import { useUIStore } from '../stores/uiStore';

const logStore = useLogStore();
const uiStore = useUIStore();

const logContainer = ref<HTMLDivElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const isExporting = ref(false);
const showExportMenu = ref(false);

const activeFilter = computed(() => logStore.activeFilter);
const searchQuery = computed(() => logStore.searchQuery);
const filteredEntries = computed(() => logStore.filteredEntries);
const summary = computed(() => logStore.summary);
const isLoading = computed(() => logStore.isLoading);

function handleFilterChange(filter: 'all' | 'errors' | 'system') {
  logStore.setFilter(filter);
}

function handleSearchChange(event: Event) {
  const target = event.target as HTMLInputElement;
  logStore.setSearchQuery(target.value);
}

async function handleClear() {
  try {
    await logStore.clearLogs();
    uiStore.success('Log history cleared');
  } catch {
    uiStore.error('Failed to clear logs');
  }
}

async function handleCopy() {
  try {
    logStore.copyLogs();
    uiStore.success('Logs copied to clipboard');
  } catch {
    uiStore.error('Failed to copy logs');
  }
}

async function handleExport(format: 'json' | 'csv' | 'txt') {
  isExporting.value = true;
  try {
    const path = await logStore.exportLogs({ format, filter: activeFilter.value });
    uiStore.success(`Logs exported to ${path}`);
  } catch {
    uiStore.error('Failed to export logs');
  } finally {
    isExporting.value = false;
  }
}

function getStreamClass(stream: string) {
  switch (stream) {
    case 'stdout':
      return 'log--stdout';
    case 'stderr':
      return 'log--stderr';
    case 'error':
      return 'log--error';
    case 'system':
      return 'log--system';
    default:
      return '';
  }
}

function formatTime(time: string) {
  return new Date(time).toLocaleTimeString([], { hour12: false });
}

function getStreamLabel(stream: string) {
  switch (stream) {
    case 'stdout':
      return 'BOT';
    case 'stderr':
      return 'ERR';
    case 'error':
      return 'ERR';
    case 'system':
      return 'SYS';
    default:
      return stream.toUpperCase();
  }
}

function scrollToBottom() {
  const container = logContainer.value;
  if (container) {
    container.scrollTop = container.scrollHeight;
    logStore.setAutoScroll(true);
  }
}

const scrollHandler = () => {
  if (!logContainer.value) return;
  const { scrollTop, scrollHeight, clientHeight } = logContainer.value;
  const atBottom = scrollHeight - scrollTop - clientHeight < 50;
  logStore.setAutoScroll(atBottom);
};

onMounted(() => {
  logContainer.value?.addEventListener('scroll', scrollHandler);
  logStore.loadLogs();
});

onUnmounted(() => {
  logContainer.value?.removeEventListener('scroll', scrollHandler);
  logStore.cleanup();
});

// Auto-scroll to bottom when new logs arrive
let lastScrollHeight = 0;
const observer = new MutationObserver(() => {
  if (!logContainer.value) return;
  if (logStore.autoScroll && logContainer.value.scrollHeight > lastScrollHeight) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight;
  }
  lastScrollHeight = logContainer.value.scrollHeight;
});

onMounted(() => {
  if (logContainer.value) {
    observer.observe(logContainer.value, { childList: true, subtree: true });
  }
});

onUnmounted(() => {
  observer.disconnect();
});
</script>

<template>
  <div class="log-viewer">
    <div class="log-toolbar">
      <div class="log-title">
        <div class="logs-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <div>
          <h3>Application Output</h3>
          <p class="log-summary">
            {{ summary }}
          </p>
        </div>
      </div>

      <div class="log-controls">
        <div class="filter-group">
          <button
            class="filter-button"
            :class="{ selected: activeFilter === 'all' }"
            title="All logs"
            @click="handleFilterChange('all')"
          >
            All
          </button>
          <button
            class="filter-button"
            :class="{ selected: activeFilter === 'errors' }"
            title="Errors only"
            @click="handleFilterChange('errors')"
          >
            Errors
          </button>
          <button
            class="filter-button"
            :class="{ selected: activeFilter === 'system' }"
            title="System only"
            @click="handleFilterChange('system')"
          >
            System
          </button>
        </div>

        <div class="search-box">
          <input
            ref="searchInput"
            type="text"
            class="search-input"
            :value="searchQuery"
            placeholder="Search logs... (Ctrl+F)"
            @input="handleSearchChange"
            @keydown.ctrl.f.prevent="() => searchInput.value?.focus()"
          />
          <span class="search-icon">🔍</span>
        </div>

        <button class="btn btn--quiet" title="Copy visible logs (Ctrl+Shift+C)" @click="handleCopy">Copy</button>
        <button class="btn btn--quiet" title="Clear log history" @click="handleClear">Clear</button>
        <div class="export-dropdown">
          <button class="btn btn--quiet" @click="showExportMenu = !showExportMenu">Export ▼</button>
          <div v-if="showExportMenu" class="export-menu">
            <button @click="handleExport('json')">JSON</button>
            <button @click="handleExport('csv')">CSV</button>
            <button @click="handleExport('txt')">Text</button>
          </div>
        </div>
      </div>
    </div>

    <div ref="logContainer" class="log-stream" :class="{ 'log-stream--loading': isLoading }">
      <div class="log-entries">
        <div v-if="filteredEntries.length === 0" class="empty-logs">
          <span class="empty-glyph">⌁</span>
          <span>
            {{ activeFilter === 'errors' ? 'No errors recorded.' : 'Waiting for application output...' }}
          </span>
        </div>

        <div
          v-for="entry in filteredEntries"
          v-else
          :key="entry.id"
          class="log-entry"
          :class="getStreamClass(entry.stream)"
        >
          <span class="log-time">{{ formatTime(entry.time) }}</span>
          <span class="log-tag">{{ getStreamLabel(entry.stream) }}</span>
          <span class="log-text">{{ entry.line }}</span>
        </div>
      </div>

      <div v-if="!logStore.autoScroll && filteredEntries.length > 0" class="scroll-indicator">
        <button class="scroll-to-bottom" @click="scrollToBottom">↓ New logs</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.log-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(137, 157, 188, 0.16);
  background: rgba(15, 22, 34, 0.8);
  flex-shrink: 0;
}

.log-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.logs-icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(112, 129, 161, 0.14);
  border-radius: 8px;
  background: #1a2332;
  color: #73ebc2;
  font-size: 14px;
  flex-shrink: 0;
}

.log-title h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}

.log-summary {
  margin: 2px 0 0;
  color: #6f7d92;
  font-size: 9px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.filter-group {
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  background: #090e16;
}

.filter-button {
  min-height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #7e8ba0;
  cursor: pointer;
  font-size: 9px;
  font-weight: 500;
  transition:
    background 0.15s,
    color 0.15s;
}

.filter-button:hover {
  color: #dce6f4;
}

.filter-button.selected {
  background: #202a39;
  color: #c4d0e1;
}

.search-box {
  position: relative;
  flex: 1;
  max-width: 280px;
  min-width: 180px;
}

.search-input {
  width: 100%;
  height: 26px;
  padding: 0 32px 0 10px;
  border: 1px solid rgba(137, 157, 188, 0.16);
  border-radius: 6px;
  outline: none;
  background: rgba(5, 10, 17, 0.6);
  color: #e6edf7;
  font-size: 10px;
  font-family: inherit;
  transition:
    border 0.2s,
    box-shadow 0.2s,
    background 0.2s;
}

.search-input:focus {
  border-color: rgba(115, 235, 194, 0.66);
  background: #0c1720;
  box-shadow: 0 0 0 3px rgba(115, 235, 194, 0.08);
}

.search-icon {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  color: #5f6c80;
  pointer-events: none;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 26px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 9px;
  font-weight: 600;
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
  opacity: 0.4;
}

.btn--quiet {
  border-color: transparent;
  background: transparent;
  color: #7e8ba0;
}

.btn--quiet:hover:not(:disabled) {
  border-color: rgba(137, 157, 188, 0.16);
  background: rgba(255, 255, 255, 0.02);
  color: #dce6f4;
}

.export-dropdown {
  position: relative;
}

.export-menu {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border: 1px solid rgba(137, 157, 188, 0.16);
  border-radius: 8px;
  background: rgba(15, 21, 33, 0.95);
  backdrop-filter: blur(10px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  z-index: 100;
}

.export-menu button {
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: #aab6c7;
  font-size: 10px;
  cursor: pointer;
  border-radius: 4px;
  text-align: left;
  white-space: nowrap;
  transition:
    background 0.15s,
    color 0.15s;
}

.export-menu button:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #edf2fa;
}

.log-stream {
  flex: 1;
  overflow: auto;
  padding: 8px 0;
  font:
    10px/1.6 'Cascadia Code',
    Consolas,
    monospace;
  scrollbar-color: #303c4e transparent;
  scrollbar-width: thin;
}

.log-stream--loading::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, #73ebc2, #7aa8ff, #c19bff);
  animation: loading-bar 1.5s ease-in-out infinite;
}

@keyframes loading-bar {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

.log-entries {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 14px;
}

.log-entry {
  display: grid;
  grid-template-columns: 70px 42px minmax(0, 1fr);
  gap: 10px;
  padding: 4px 12px;
  color: #aab6c7;
  border-radius: 4px;
  transition: background 0.15s;
}

.log-entry:hover {
  background: rgba(255, 255, 255, 0.02);
}

.log-time {
  color: #5f6c80;
  font-variant-numeric: tabular-nums;
}

.log-tag {
  color: #8a9bb4;
  text-transform: uppercase;
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 0.05em;
}

.log-text {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.log--stderr .log-tag,
.log--error .log-tag {
  color: #ff858f;
}

.log--stderr,
.log--error {
  background: linear-gradient(90deg, rgba(255, 125, 135, 0.06), transparent 70%);
}

.log--system .log-tag {
  color: #73ebc2;
}

.empty-logs {
  min-height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #657287;
  font:
    11px 'Segoe UI',
    sans-serif;
}

.empty-glyph {
  color: #61d5b6;
  font-size: 18px;
}

.scroll-indicator {
  position: sticky;
  bottom: 0;
  display: flex;
  justify-content: center;
  padding: 8px;
  background: linear-gradient(to top, rgba(8, 11, 18, 0.9), transparent);
  pointer-events: none;
}

.scroll-to-bottom {
  pointer-events: auto;
  min-height: 28px;
  padding: 0 14px;
  border: 1px solid rgba(115, 235, 194, 0.4);
  border-radius: 20px;
  background: rgba(115, 235, 194, 0.1);
  color: #73ebc2;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.2s,
    border-color 0.2s;
}

.scroll-to-bottom:hover {
  background: rgba(115, 235, 194, 0.2);
  border-color: #73ebc2;
}
</style>
