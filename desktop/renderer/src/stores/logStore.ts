import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { LogEntry, LogQuery, LogSearchQuery, LogExportOptions } from '../types';
import { useIpc } from '../composables/useIpc';

export const useLogStore = defineStore('logs', () => {
  const ipc = useIpc();

  // State
  const entries = ref<LogEntry[]>([]);
  const filteredEntries = ref<LogEntry[]>([]);
  const isLoading = ref(false);
  const searchQuery = ref('');
  const activeFilter = ref<'all' | 'errors' | 'system'>('all');
  const autoScroll = ref(true);
  const maxEntries = 500;
  const errorCount = ref(0);

  // Computed
  const hasEntries = computed(() => filteredEntries.value.length > 0);
  const summary = computed(() => {
    const total = entries.value.length;
    const errors = entries.value.filter(e => e.stream === 'error' || e.stream === 'stderr').length;
    if (total === 0) return 'Startup and bot events appear here';
    return `${total} recent events${errors ? ` · ${errors} ${errors === 1 ? 'error' : 'errors'}` : ''}`;
  });

  // Actions
  async function loadLogs(query: LogQuery = {}) {
    isLoading.value = true;
    try {
      const logs = await ipc.getLogs();
      entries.value = logs.slice(-maxEntries);
      applyFilter();
    } catch (error) {
      console.error('Failed to load logs:', error);
    } finally {
      isLoading.value = false;
    }
  }

  async function searchLogs(query: LogSearchQuery) {
    isLoading.value = true;
    try {
      const results = await ipc.searchLogs(query);
      filteredEntries.value = results;
    } catch (error) {
      console.error('Failed to search logs:', error);
    } finally {
      isLoading.value = false;
    }
  }

  async function exportLogs(options: LogExportOptions) {
    try {
      const result = await ipc.exportLogs(options);
      return result.path;
    } catch (error) {
      console.error('Failed to export logs:', error);
      throw error;
    }
  }

  async function clearLogs() {
    try {
      await ipc.clearLogs();
      entries.value = [];
      filteredEntries.value = [];
      errorCount.value = 0;
    } catch (error) {
      console.error('Failed to clear logs:', error);
      throw error;
    }
  }

  function copyLogs() {
    const text = filteredEntries.value.map(entry =>
      `${new Date(entry.time).toLocaleTimeString([], { hour12: false })} [${entry.stream}] ${entry.line}`
    ).join('\n');
    ipc.copyLogs(text);
  }

  function appendLog(entry: LogEntry) {
    // Check for duplicates
    const key = entry.id || `${entry.time}|${entry.stream}|${entry.line}`;
    if (entries.value.some(e => (e.id || `${e.time}|${e.stream}|${e.line}`) === key)) {
      return;
    }

    entries.value.push(entry);
    if (entries.value.length > maxEntries) {
      entries.value.splice(0, entries.value.length - maxEntries);
    }

    // Update error count
    if (entry.stream === 'error' || entry.stream === 'stderr') {
      errorCount.value++;
    }

    applyFilter();
  }

  function applyFilter() {
    let result = [...entries.value];

    // Apply filter
    if (activeFilter.value === 'errors') {
      result = result.filter(e => e.stream === 'error' || e.stream === 'stderr');
    } else if (activeFilter.value === 'system') {
      result = result.filter(e => e.stream === 'system');
    }

    // Apply search query
    if (searchQuery.value.trim()) {
      const query = searchQuery.value.toLowerCase().trim();
      result = result.filter(e =>
        e.line.toLowerCase().includes(query) ||
        e.stream.toLowerCase().includes(query)
      );
    }

    filteredEntries.value = result;
  }

  function setFilter(filter: 'all' | 'errors' | 'system') {
    activeFilter.value = filter;
    applyFilter();
  }

  function setSearchQuery(query: string) {
    searchQuery.value = query;
    applyFilter();
  }

  function setAutoScroll(value: boolean) {
    autoScroll.value = value;
  }

  function onLog(entry: LogEntry) {
    appendLog(entry);
  }

  function cleanup() {
    ipc.removeAllListeners('app:log');
  }

  return {
    // State
    entries,
    filteredEntries,
    isLoading,
    searchQuery,
    activeFilter,
    autoScroll,
    errorCount,
    // Computed
    hasEntries,
    summary,
    // Actions
    loadLogs,
    searchLogs,
    exportLogs,
    clearLogs,
    copyLogs,
    appendLog,
    setFilter,
    setSearchQuery,
    setAutoScroll,
    applyFilter,
    onLog,
    cleanup,
  };
});