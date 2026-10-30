import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { BotStatus, BotState, Settings } from '../types';
import { useIpc } from '../composables/useIpc';

export const useBotStore = defineStore('bot', () => {
  const ipc = useIpc();

  // State
  const status = ref<BotStatus>({
    online: false,
    username: 'Airi',
    status: 'Stopped',
    event: 'stopped',
    reason: null,
    error: null,
    retryAt: null,
    retryInMs: null,
  });

  const state = ref<BotState | null>(null);
  const settings = ref<Settings | null>(null);
  const isConnecting = ref(false);
  const isStopping = ref(false);
  const lastError = ref<string | null>(null);

  // Computed
  const isOnline = computed(() => status.value.online);
  const isRunning = computed(() => ['starting', 'connecting', 'reconnecting', 'online'].includes(status.value.status));
  const canStart = computed(() => !isRunning.value && !isConnecting.value);
  const canStop = computed(() => isRunning.value && !isStopping.value);
  const displayStatus = computed(() => {
    const s = status.value;
    if (s.online) return 'Online';
    if (s.status === 'connecting' || s.status === 'starting') return 'Connecting';
    if (s.status === 'reconnecting') return 'Reconnecting';
    if (s.status === 'stopping') return 'Stopping';
    if (s.status === 'error') return 'Error';
    return 'Stopped';
  });

  const displayDetail = computed(() => status.value.reason || status.value.error || 'Ready when you are');

  // Actions
  async function fetchStatus() {
    try {
      status.value = await ipc.getBotStatus();
    } catch (error) {
      console.error('Failed to fetch bot status:', error);
      lastError.value = String(error);
    }
  }

  async function fetchSettings() {
    try {
      const s = await ipc.getSettings();
      settings.value = s;
      return s;
    } catch (error) {
      console.error('Failed to fetch settings:', error);
      lastError.value = String(error);
      throw error;
    }
  }

  async function saveSettings(newSettings: Partial<Settings>) {
    try {
      const saved = await ipc.saveSettings(newSettings);
      settings.value = saved;
      return saved;
    } catch (error) {
      console.error('Failed to save settings:', error);
      lastError.value = String(error);
      throw error;
    }
  }

  async function start() {
    if (!canStart.value) return;
    isConnecting.value = true;
    lastError.value = null;
    try {
      await ipc.startBot();
    } catch (error) {
      lastError.value = String(error);
      throw error;
    } finally {
      isConnecting.value = false;
    }
  }

  async function stop() {
    if (!canStop.value) return;
    isStopping.value = true;
    try {
      await ipc.stopBot();
    } catch (error) {
      lastError.value = String(error);
      throw error;
    } finally {
      isStopping.value = false;
    }
  }

  async function restart() {
    isStopping.value = true;
    isConnecting.value = true;
    try {
      await ipc.restartBot();
    } catch (error) {
      lastError.value = String(error);
      throw error;
    } finally {
      isStopping.value = false;
      isConnecting.value = false;
    }
  }

  function updateStatus(newStatus: Partial<BotStatus>) {
    status.value = { ...status.value, ...newStatus };
  }

  function updateState(newState: BotState) {
    state.value = newState;
  }

  function clearError() {
    lastError.value = null;
  }

  // Event handlers
  function onLifecycle(data: { status: string; detail: string; running: boolean }) {
    updateStatus({
      status: data.status,
      reason: data.detail,
      online: data.status === 'online',
    });
  }

  function onBotState(newState: BotState) {
    updateState(newState);
    if (newState.status === 'Online') {
      updateStatus({ online: true, status: 'Online', event: 'spawn' });
    }
  }

  function onDashboardReady(data: { url: string }) {
    // Dashboard URL is handled by the dashboard embed component
    console.log('Dashboard ready:', data.url);
  }

  // Initialize event listeners
  function initListeners() {
    ipc.onLifecycle(onLifecycle);
    ipc.onBotState(onBotState);
    ipc.onDashboardReady(onDashboardReady);
  }

  function cleanup() {
    ipc.removeAllListeners('app:lifecycle');
    ipc.removeAllListeners('app:bot-state');
    ipc.removeAllListeners('app:dashboard-ready');
  }

  return {
    // State
    status,
    state,
    settings,
    isConnecting,
    isStopping,
    lastError,
    // Computed
    isOnline,
    isRunning,
    canStart,
    canStop,
    displayStatus,
    displayDetail,
    // Actions
    fetchStatus,
    fetchSettings,
    saveSettings,
    start,
    stop,
    restart,
    updateStatus,
    updateState,
    clearError,
    initListeners,
    cleanup,
  };
});