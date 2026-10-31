<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';

const settingsStore = useSettingsStore();
const uiStore = useUIStore();

const form = computed(() => settingsStore.formSettings);
const isSaving = computed(() => settingsStore.isSaving);
const saveError = computed(() => settingsStore.saveError);
const isValid = computed(() => settingsStore.isValid);
const validationErrors = computed(() => settingsStore.validationErrors);
const isPortableMode = computed(() => settingsStore.isPortableMode);
const dataDirectory = computed(() => settingsStore.dataDirectory);

async function handleSubmit(event: Event) {
  event.preventDefault();
  const success = await settingsStore.save();
  if (success) {
    uiStore.success('Settings saved successfully');
  } else {
    uiStore.error(saveError.value || 'Failed to save settings');
  }
}

function getStorageNote() {
  if (isPortableMode.value) {
    return `Portable settings and memory: ${dataDirectory.value}. API key encryption is tied to this Windows account.`;
  }
  return 'Settings and memory are stored in your Windows profile. API key uses Windows secure storage.';
}
</script>

<template>
  <form class="settings-form" @submit="handleSubmit">
    <div class="form-section">
      <h3 class="section-title">Server Connection</h3>

      <div class="form-field">
        <label for="host">Server Address <span class="required">*</span></label>
        <input
          id="host"
          v-model="form.host"
          type="text"
          placeholder="mc.example.com"
          autocomplete="off"
          @blur="settingsStore.clearError"
        />
      </div>

      <div class="form-row">
        <div class="form-field">
          <label for="port">Port <span class="optional">Default 25565</span></label>
          <input
            id="port"
            v-model.number="form.port"
            type="number"
            min="1"
            max="65535"
            placeholder="25565"
            @blur="settingsStore.clearError"
          />
        </div>

        <div class="form-field">
          <label for="username">Username <span class="optional">3–16 chars</span></label>
          <input
            id="username"
            v-model="form.username"
            type="text"
            maxlength="16"
            placeholder="Airi"
            autocomplete="off"
            @blur="settingsStore.clearError"
          />
        </div>
      </div>

      <div class="form-field">
        <label for="version">Minecraft Version <span class="optional">Protocol version</span></label>
        <input
          id="version"
          v-model="form.version"
          type="text"
          placeholder="1.21.1"
          autocomplete="off"
          @blur="settingsStore.clearError"
        />
      </div>
    </div>

    <div class="form-section">
      <h3 class="section-title">Dashboard & AI</h3>

      <div class="form-field">
        <label for="webPort">Dashboard Port <span class="optional">Local only</span></label>
        <input
          id="webPort"
          v-model.number="form.webPort"
          type="number"
          min="1"
          max="65535"
          placeholder="3000"
          @blur="settingsStore.clearError"
        />
      </div>

      <div class="form-field">
        <label for="openaiKey">OpenAI API Key <span class="optional">Optional, encrypted</span></label>
        <input
          id="openaiKey"
          v-model="form.openaiKey"
          type="password"
          placeholder="sk-..."
          autocomplete="new-password"
          @blur="settingsStore.clearError"
        />
      </div>
    </div>

    <div class="form-section">
      <h3 class="section-title">Features</h3>

      <label class="toggle-field">
        <input v-model="form.enableMemory" type="checkbox" />
        <div class="toggle-track">
          <span class="toggle-thumb" />
        </div>
        <div class="toggle-label">
          <strong>Persistent Memory</strong>
          <small>Store locations, players, tasks, and learned facts</small>
        </div>
      </label>
    </div>

    <div v-if="validationErrors.length > 0" class="form-errors">
      <ul>
        <li v-for="error in validationErrors" :key="error">
          {{ error }}
        </li>
      </ul>
    </div>

    <button type="submit" class="btn btn--primary btn--save" :disabled="!isValid || isSaving">
      <span>{{ isSaving ? 'Saving...' : 'Save Settings' }}</span>
      <span class="btn-arrow">→</span>
    </button>

    <p class="storage-note">
      <span class="secure-icon">🔒</span>
      {{ getStorageNote() }}
    </p>
  </form>
</template>

<style scoped>
.settings-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: #73ebc2;
  text-transform: uppercase;
  margin: 0;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-field label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 600;
  color: #9eabc0;
  letter-spacing: 0.02em;
}

.required {
  color: #ff858f;
}

.optional {
  color: #67768d;
  font:
    8px 'Cascadia Code',
    Consolas,
    monospace;
  letter-spacing: 0.08em;
  font-weight: normal;
}

.form-field input {
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border: 1px solid rgba(131, 151, 181, 0.18);
  border-radius: 8px;
  outline: none;
  background: rgba(5, 10, 17, 0.6);
  color: #e6edf7;
  font-size: 12px;
  font-family: inherit;
  transition:
    border 0.2s,
    box-shadow 0.2s,
    background 0.2s;
}

.form-field input:focus {
  border-color: rgba(115, 235, 194, 0.66);
  background: #0c1720;
  box-shadow: 0 0 0 3px rgba(115, 235, 194, 0.08);
}

.form-field input::placeholder {
  color: #59677c;
}

.toggle-field {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  min-height: 44px;
}

.toggle-field > input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.toggle-track {
  width: 34px;
  height: 18px;
  display: flex;
  align-items: center;
  padding: 3px;
  border: 1px solid #38445a;
  border-radius: 22px;
  background: #151d2a;
  transition:
    background 0.2s,
    border-color 0.2s;
  flex-shrink: 0;
}

.toggle-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #7c8797;
  transition:
    transform 0.2s cubic-bezier(0.2, 0.7, 0.2, 1),
    background 0.2s;
}

.toggle-field > input:checked + .toggle-track {
  border-color: #55c9a8;
  background: #184b42;
}

.toggle-field > input:checked + .toggle-track .toggle-thumb {
  transform: translateX(16px);
  background: #8cf0cf;
}

.toggle-field > input:focus-visible + .toggle-track {
  outline: 2px solid #73ebc2;
  outline-offset: 3px;
}

.toggle-label {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toggle-label strong {
  color: #c6d0df;
  font-size: 11px;
  font-weight: 500;
}

.toggle-label small {
  color: #77849a;
  font-size: 9px;
}

.form-errors {
  margin: 0;
  padding: 10px 12px;
  background: rgba(255, 133, 143, 0.1);
  border: 1px solid rgba(255, 133, 143, 0.3);
  border-radius: 8px;
  color: #ff929a;
  font-size: 11px;
}

.form-errors ul {
  margin: 0;
  padding-left: 18px;
}

.form-errors li {
  margin: 4px 0;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 11px;
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
  opacity: 0.4;
}

.btn--primary {
  background: linear-gradient(105deg, #87f0cd, #77cfe7);
  box-shadow:
    0 6px 20px rgba(98, 219, 186, 0.22),
    inset 0 1px rgba(255, 255, 255, 0.4);
  color: #081610;
  border-color: transparent;
}

.btn--primary:hover:not(:disabled) {
  box-shadow:
    0 8px 24px rgba(98, 219, 186, 0.35),
    inset 0 1px rgba(255, 255, 255, 0.5);
}

.btn-arrow {
  font-size: 14px;
}

.storage-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 8px 0 0;
  color: #718096;
  font-size: 9px;
  line-height: 1.5;
}

.secure-icon {
  color: #73ebc2;
  font-size: 9px;
  flex-shrink: 0;
  margin-top: 1px;
}
</style>
