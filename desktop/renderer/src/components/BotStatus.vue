<script setup lang="ts">
import { computed } from 'vue';
import { useBotStore } from '../stores/botStore';

const botStore = useBotStore();

const statusClasses = computed(() => ({
  'status--online': botStore.isOnline,
  'status--connecting': botStore.status.status === 'connecting' || botStore.status.status === 'starting',
  'status--reconnecting': botStore.status.status === 'reconnecting',
  'status--stopping': botStore.status.status === 'stopping',
  'status--error': botStore.status.status === 'error',
  'status--stopped': !botStore.isRunning,
}));

const pulseClasses = computed(() => ({
  'pulse--online': botStore.isOnline,
  'pulse--connecting': ['starting', 'connecting', 'reconnecting'].includes(botStore.status.status),
  'pulse--error': botStore.status.status === 'error',
}));
</script>

<template>
  <div class="bot-status">
    <div class="status-indicator">
      <div
        class="connection-led"
        :class="['connection-led', statusClasses]"
      >
        <div
          class="live-pulse"
          :class="pulseClasses"
        />
      </div>
      <div class="status-info">
        <div class="status-title">
          {{ botStore.displayStatus }}
        </div>
        <div class="status-detail">
          {{ botStore.displayDetail }}
        </div>
      </div>
    </div>

    <div
      v-if="botStore.isRunning"
      class="status-actions"
    >
      <div class="status-meta">
        <span
          v-if="botStore.state?.botData"
          class="meta-item"
        >
          ❤️ {{ botStore.state.botData.health }}/20
        </span>
        <span
          v-if="botStore.state?.botData"
          class="meta-item"
        >
          🍖 {{ botStore.state.botData.food }}/20
        </span>
        <span
          v-if="botStore.state?.botData?.pos"
          class="meta-item"
        >
          📍 {{ Math.floor(botStore.state.botData.pos.x) }}, {{ Math.floor(botStore.state.botData.pos.y) }}, {{ Math.floor(botStore.state.botData.pos.z) }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bot-status {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: rgba(15, 21, 33, 0.8);
  border: 1px solid rgba(149, 166, 197, 0.13);
  border-radius: 12px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 12px;
}

.connection-led {
  position: relative;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #68748a;
  flex-shrink: 0;
}

.connection-led.status--online {
  background: #73ebc2;
  box-shadow: 0 0 16px #73ebc2a6;
}

.connection-led.status--connecting,
.connection-led.status--reconnecting,
.connection-led.status--stopping {
  background: #f2c879;
  box-shadow: 0 0 16px #f2c87983;
}

.connection-led.status--error {
  background: #ff858f;
  box-shadow: 0 0 16px #ff858f80;
}

.live-pulse {
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  opacity: 0;
}

.live-pulse.pulse--online {
  background: #73ebc2;
  animation: pulse 1.8s ease-out infinite;
  opacity: 0.6;
}

.live-pulse.pulse--connecting {
  background: #f2c879;
  animation: pulse 1.3s ease-out infinite;
  opacity: 0.6;
}

.live-pulse.pulse--error {
  background: #ff858f;
  opacity: 0.4;
}

@keyframes pulse {
  0% { transform: scale(0.8); opacity: 0.6; }
  70% { transform: scale(1.5); opacity: 0; }
  100% { transform: scale(1.5); opacity: 0; }
}

.status-info {
  flex: 1;
  min-width: 0;
}

.status-title {
  font-size: 14px;
  font-weight: 600;
  color: #edf2fa;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-detail {
  font-size: 11px;
  color: #7c879b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.status-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.status-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 11px;
  font-family: "Cascadia Code", Consolas, monospace;
  color: #a9b4c7;
}

.meta-item {
  padding: 2px 8px;
  background: rgba(5, 10, 17, 0.5);
  border-radius: 4px;
  border: 1px solid rgba(131, 151, 181, 0.1);
}
</style>