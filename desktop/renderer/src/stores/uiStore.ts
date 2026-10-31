import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Toast } from '../types';

export const useUIStore = defineStore('ui', () => {
  // State
  const toasts = ref<Toast[]>([]);
  const isSidebarOpen = ref(true);
  const activeView = ref<'dashboard' | 'settings' | 'logs'>('dashboard');
  const isSettingsModalOpen = false;
  const isLogExportModalOpen = false;
  const isUpdateBannerVisible = ref(false);
  const updateInfo = ref<{ version: string; releaseNotes?: string } | null>(null);
  const doNotDisturb = ref(false);

  // Computed
  const visibleToasts = computed(() => toasts.value.filter((t) => !t.duration || t.duration > 0));

  // Actions
  function showToast(message: string, type: Toast['type'] = 'info', duration = 5000) {
    if (doNotDisturb.value && type !== 'error') return;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const toast: Toast = { id, type, message, duration };
    toasts.value.push(toast);

    if (duration > 0) {
      setTimeout(() => removeToast(id), duration);
    }

    return id;
  }

  function removeToast(id: string) {
    const index = toasts.value.findIndex((t) => t.id === id);
    if (index !== -1) {
      toasts.value.splice(index, 1);
    }
  }

  function clearToasts() {
    toasts.value = [];
  }

  function toggleSidebar() {
    isSidebarOpen.value = !isSidebarOpen.value;
  }

  function setActiveView(view: 'dashboard' | 'settings' | 'logs') {
    activeView.value = view;
  }

  function showUpdateBanner(version: string, releaseNotes?: string) {
    isUpdateBannerVisible.value = true;
    updateInfo.value = { version, releaseNotes };
  }

  function hideUpdateBanner() {
    isUpdateBannerVisible.value = false;
    updateInfo.value = null;
  }

  function setDoNotDisturb(value: boolean) {
    doNotDisturb.value = value;
  }

  function toggleDoNotDisturb() {
    doNotDisturb.value = !doNotDisturb.value;
  }

  // Convenience methods for different toast types
  function success(message: string, duration?: number) {
    return showToast(message, 'success', duration);
  }

  function error(message: string, duration?: number) {
    return showToast(message, 'error', duration || 10000);
  }

  function warning(message: string, duration?: number) {
    return showToast(message, 'warning', duration);
  }

  function info(message: string, duration?: number) {
    return showToast(message, 'info', duration);
  }

  return {
    // State
    toasts,
    isSidebarOpen,
    activeView,
    isSettingsModalOpen,
    isLogExportModalOpen,
    isUpdateBannerVisible,
    updateInfo,
    doNotDisturb,
    // Computed
    visibleToasts,
    // Actions
    showToast,
    removeToast,
    clearToasts,
    toggleSidebar,
    setActiveView,
    showUpdateBanner,
    hideUpdateBanner,
    setDoNotDisturb,
    toggleDoNotDisturb,
    success,
    error,
    warning,
    info,
  };
});
