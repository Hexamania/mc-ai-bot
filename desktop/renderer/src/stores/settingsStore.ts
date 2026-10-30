import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Settings } from '../types';
import { useBotStore } from './botStore';

export const useSettingsStore = defineStore('settings', () => {
  const botStore = useBotStore();

  // State
  const formSettings = ref<Partial<Settings>>({
    host: '',
    port: 25565,
    username: 'Airi',
    version: '1.21.1',
    openaiKey: '',
    webPort: 3000,
    enableMemory: true,
  });

  const isSaving = ref(false);
  const saveError = ref<string | null>(null);
  const isPortableMode = ref(false);
  const dataDirectory = ref('');

  // Computed
  const isValid = computed(() => {
    const s = formSettings.value;
    return !!(
      s.host?.trim() &&
      s.port >= 1 && s.port <= 65535 &&
      s.username?.trim() &&
      s.version?.trim() &&
      s.webPort >= 1 && s.webPort <= 65535 &&
      s.port !== s.webPort
    );
  });

  const validationErrors = computed(() => {
    const errors: string[] = [];
    const s = formSettings.value;
    if (!s.host?.trim()) errors.push('Server address is required');
    if (!s.port || s.port < 1 || s.port > 65535) errors.push('Port must be 1-65535');
    if (!s.username?.trim()) errors.push('Username is required');
    if (!s.version?.trim()) errors.push('Minecraft version is required');
    if (!s.webPort || s.webPort < 1 || s.webPort > 65535) errors.push('Dashboard port must be 1-65535');
    if (s.port === s.webPort) errors.push('Minecraft and dashboard ports must differ');
    return errors;
  });

  // Actions
  async function loadSettings() {
    try {
      const settings = await botStore.fetchSettings();
      formSettings.value = {
        host: settings.host,
        port: settings.port,
        username: settings.username,
        version: settings.version,
        openaiKey: settings.openaiKey,
        webPort: settings.webPort,
        enableMemory: settings.enableMemory,
      };
      isPortableMode.value = settings.portableMode;
      dataDirectory.value = settings.dataDirectory;
      return settings;
    } catch (error) {
      console.error('Failed to load settings:', error);
      saveError.value = String(error);
      throw error;
    }
  }

  async function save() {
    if (!isValid.value) {
      saveError.value = validationErrors.value.join(', ');
      return false;
    }

    isSaving.value = true;
    saveError.value = null;

    try {
      const saved = await botStore.saveSettings(formSettings.value as Settings);
      formSettings.value = saved;
      return true;
    } catch (error) {
      saveError.value = String(error);
      return false;
    } finally {
      isSaving.value = false;
    }
  }

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    formSettings.value[key] = value;
    saveError.value = null;
  }

  function resetForm() {
    formSettings.value = {
      host: '',
      port: 25565,
      username: 'Airi',
      version: '1.21.1',
      openaiKey: '',
      webPort: 3000,
      enableMemory: true,
    };
    saveError.value = null;
  }

  function clearError() {
    saveError.value = null;
  }

  return {
    // State
    formSettings,
    isSaving,
    saveError,
    isPortableMode,
    dataDirectory,
    // Computed
    isValid,
    validationErrors,
    // Actions
    loadSettings,
    save,
    updateSetting,
    resetForm,
    clearError,
  };
});