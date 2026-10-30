<script setup lang="ts">
import { computed } from 'vue';
import { useUIStore } from '../stores/uiStore';

const uiStore = useUIStore();

const props = defineProps<{
  toast: {
    id: string;
    type: 'info' | 'success' | 'warning' | 'error';
    message: string;
  };
}>();

const remove = () => {
  uiStore.removeToast(props.toast.id);
};

const typeClasses = computed(() => ({
  'toast--info': props.toast.type === 'info',
  'toast--success': props.toast.type === 'success',
  'toast--warning': props.toast.type === 'warning',
  'toast--error': props.toast.type === 'error',
}));

const typeIcons = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '❌',
};
</script>

<template>
  <div
    class="toast"
    :class="typeClasses"
  >
    <span class="toast-icon">{{ typeIcons[props.toast.type] }}</span>
    <span class="toast-message">{{ props.toast.message }}</span>
    <button
      class="toast-close"
      aria-label="Dismiss"
      @click="remove"
    >
      ×
    </button>
  </div>
</template>

<style scoped>
.toast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 8px;
  background: rgba(15, 21, 33, 0.95);
  border: 1px solid rgba(149, 166, 197, 0.13);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(10px);
  min-width: 280px;
  max-width: 400px;
  animation: slide-in 0.3s ease-out;
}

.toast--info {
  border-left: 3px solid #7aa8ff;
}

.toast--success {
  border-left: 3px solid #73ebc2;
}

.toast--warning {
  border-left: 3px solid #f2c879;
}

.toast--error {
  border-left: 3px solid #ff858f;
}

.toast-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.toast-message {
  flex: 1;
  font-size: 13px;
  line-height: 1.4;
  color: #edf2fa;
}

.toast-close {
  background: none;
  border: none;
  color: #7c879b;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  opacity: 0.7;
  transition: opacity 0.2s;
}

.toast-close:hover {
  opacity: 1;
  color: #edf2fa;
}

@keyframes slide-in {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
</style>