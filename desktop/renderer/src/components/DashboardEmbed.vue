<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { useBotStore } from '../stores/botStore';
import { useUIStore } from '../stores/uiStore';

const botStore = useBotStore();
const uiStore = useUIStore();

const iframeRef = ref<HTMLIFrameElement | null>(null);
const isLoaded = ref(false);
const showPlaceholder = ref(true);
const dashboardUrl = ref('');

const isOnline = computed(() => botStore.isOnline);
const isRunning = computed(() => botStore.isRunning);

const placeholderRotation = ref(0);

onMounted(() => {
  // Start placeholder animation
  const animate = () => {
    placeholderRotation.value = (placeholderRotation.value + 1) % 360;
    requestAnimationFrame(animate);
  };
  animate();

  // Listen for dashboard ready event
  botStore.onDashboardReady((data) => {
    dashboardUrl.value = data.url;
    loadDashboard(data.url);
  });

  // If already have URL from state, load it
  if (botStore.state) {
    // Dashboard URL would come from state or we construct it
    const port = botStore.settings?.webPort || 3000;
    const url = `http://127.0.0.1:${port}`;
    dashboardUrl.value = url;
    loadDashboard(url);
  }
});

onUnmounted(() => {
  // Cleanup
});

function loadDashboard(url: string) {
  if (iframeRef.value) {
    iframeRef.value.src = url;
    showPlaceholder.value = true;
    isLoaded.value = false;
  }
}

function handleIframeLoad() {
  isLoaded.value = true;
  showPlaceholder.value = false;
}

function handleRefresh() {
  if (iframeRef.value && iframeRef.value.src && iframeRef.value.src !== 'about:blank') {
    iframeRef.value.contentWindow?.location.reload();
    uiStore.info('Dashboard refreshed');
  }
}

function handleOpenInBrowser() {
  if (dashboardUrl.value) {
    uiStore.openExternal(dashboardUrl.value);
  }
}
</script>

<template>
  <div class="dashboard-embed">
    <div class="dashboard-header">
      <div class="dashboard-url">
        <span class="url-label">LOCAL DASHBOARD</span>
        <span
          v-if="dashboardUrl"
          class="url-value"
        >{{ dashboardUrl.replace(/^https?:\/\//, '') }}</span>
        <span
          v-else
          class="url-value placeholder"
        >not running</span>
      </div>
      <div class="dashboard-actions">
        <button
          class="btn btn--icon"
          :disabled="!isRunning"
          title="Refresh dashboard"
          @click="handleRefresh"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="icon-spin"
          >
            <path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
        <button
          class="btn btn--icon"
          :disabled="!dashboardUrl"
          title="Open in browser"
          @click="handleOpenInBrowser"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line
              x1="10"
              y1="14"
              x2="21"
              y2="3"
            />
          </svg>
        </button>
      </div>
    </div>

    <div class="dashboard-content">
      <iframe
        id="dashboard-iframe"
        ref="iframeRef"
        :src="isRunning ? dashboardUrl : 'about:blank'"
        title="Airi OS Dashboard"
        class="dashboard-iframe"
        :class="{ loaded: isLoaded }"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        @load="handleIframeLoad"
      />

      <div
        v-show="showPlaceholder && !isLoaded"
        class="dashboard-placeholder"
      >
        <div class="placeholder-core">
          A
        </div>
        <div class="placeholder-orbit">
          <div
            class="orbit-ring"
            :style="{ transform: `rotate(${placeholderRotation}deg)` }"
          />
          <div
            class="orbit-ring"
            :style="{ transform: `rotate(${placeholderRotation + 120}deg)` }"
          />
          <div
            class="orbit-ring"
            :style="{ transform: `rotate(${placeholderRotation + 240}deg)` }"
          />
        </div>
        <p class="placeholder-text">
          Awaiting bot process
        </p>
        <h3>Dashboard <span>preview</span></h3>
        <p class="placeholder-desc">
          Save settings and start the bot to load the live dashboard.
          The web server runs on loopback and is embedded here for convenience.
        </p>
      </div>

      <div
        v-if="isRunning && !isLoaded && !showPlaceholder"
        class="dashboard-loading"
      >
        <div class="loading-spinner" />
        <p>Loading dashboard...</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard-embed {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: rgba(12, 18, 28, 0.85);
  border: 1px solid rgba(137, 157, 188, 0.16);
  border-radius: 12px;
  overflow: hidden;
}

.dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(137, 157, 188, 0.16);
  background: rgba(18, 26, 39, 0.7);
  flex-shrink: 0;
}

.dashboard-url {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.url-label {
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: #556176;
  font-family: "Cascadia Code", Consolas, monospace;
  text-transform: uppercase;
}

.url-value {
  font-size: 9px;
  font-family: "Cascadia Code", Consolas, monospace;
  color: #76849a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.url-value.placeholder {
  color: #556176;
  font-style: italic;
}

.dashboard-actions {
  display: flex;
  gap: 6px;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 26px;
  min-width: 26px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 9px;
  font-weight: 600;
  font-family: inherit;
  transition: transform 0.15s, border-color 0.15s, background 0.15s, box-shadow 0.15s, opacity 0.15s;
}

.btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.btn:active:not(:disabled) {
  transform: translateY(0) scale(0.99);
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.btn--icon {
  background: transparent;
  color: #8592a8;
  border: none;
  padding: 0;
}

.btn--icon:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.05);
  color: #73ebc2;
  transform: rotate(90deg);
}

.icon-spin {
  transition: transform 0.4s ease;
}

.dashboard-content {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.dashboard-iframe {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  background: #0a1019;
  opacity: 0;
  transition: opacity 0.5s ease;
  z-index: 1;
}

.dashboard-iframe.loaded {
  opacity: 1;
}

.dashboard-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px;
  text-align: center;
  background: radial-gradient(ellipse at 51% 44%, rgba(43, 65, 82, 0.36), transparent 46%), linear-gradient(150deg, #111a29, #0b111a 70%);
  z-index: 2;
  transition: opacity 0.4s, transform 0.4s;
}

.dashboard-placeholder[hidden] {
  display: none;
}

.placeholder-core {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border: 1px solid #91f1d080;
  border-radius: 14px;
  background: linear-gradient(145deg, #98f2d5, #76baf8);
  box-shadow: 0 0 40px #6bdcc744, inset 0 1px #ffffff88;
  color: #0c1620;
  font: 700 24px "Segoe UI Variable Display", "Segoe UI", sans-serif;
  animation: core-float 3s ease-in-out infinite;
}

.placeholder-orbit {
  position: relative;
  width: 120px;
  height: 120px;
}

.orbit-ring {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 100%;
  height: 100%;
  border: 1px solid #85e7d51b;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  transform-origin: center;
}

.orbit-ring::before {
  content: '';
  position: absolute;
  top: -4px;
  left: 50%;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #73ebc2;
  box-shadow: 0 0 12px #73ebc2;
  transform: translateX(-50%);
}

@keyframes core-float {
  0%, 100% { transform: translateY(0) rotate(-3deg); }
  50% { transform: translateY(-6px) rotate(3deg); }
}

.placeholder-text {
  position: relative;
  z-index: 1;
  margin: 0;
  color: #7c8ba1;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}

.placeholder-text + h3 {
  position: relative;
  z-index: 1;
  margin: 0;
  font: 500 clamp(22px, 2.8vw, 34px)/1.1 "Segoe UI Variable Display", "Segoe UI", sans-serif;
  letter-spacing: -0.05em;
}

.placeholder-text + h3 span {
  color: #73ebc2;
}

.placeholder-desc {
  position: relative;
  z-index: 1;
  max-width: 340px;
  margin: 0;
  color: #8794a9;
  font-size: 10px;
  line-height: 1.6;
}

.dashboard-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(12, 18, 28, 0.95);
  z-index: 3;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(115, 235, 194, 0.2);
  border-top-color: #73ebc2;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.dashboard-loading p {
  margin: 0;
  color: #7c8ba1;
  font-size: 11px;
}
</style>