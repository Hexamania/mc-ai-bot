/**
 * Renderer process for Airi OS desktop app
 * Handles the dashboard UI and communication with main process
 */

// This file will be bundled by the frontend build system
// For now, it's a placeholder showing the structure

interface BotStatus {
  online: boolean;
  username: string;
  status: string;
  event: string;
  reason: string | null;
  error: string | null;
  retryAt: number | null;
  retryInMs: number | null;
}

interface BotState {
  status: string;
  users: string[];
  admins: string[];
  logs: string[];
  settings: {
    theme: string;
    autoDefense: boolean;
    autoArmor: boolean;
    stealth: boolean;
  };
  botData: {
    health: number;
    food: number;
    pos: { x: number; y: number; z: number };
  };
  inventory: {
    slot: number;
    name: string;
    displayName: string;
    count: number;
  }[];
  currentPath: { x: number; y: number; z: number }[];
  favorites: Record<string, { x: number; y: number; z: number }>;
  equipment: {
    head: string;
    chest: string;
    legs: string;
    feet: string;
    hand: string;
    offhand: string;
  };
  mapData?: {
    blocks: { x: number; z: number; name: string }[];
    entities: { x: number; z: number; name: string; isPlayer: boolean }[];
  };
}

// Global state
let currentState: BotState | null = null;
let currentStatus: BotStatus | null = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initializeApp();
});

function initializeApp(): void {
  // Set up API listeners
  setupApiListeners();

  // Set up UI event handlers
  setupEventHandlers();

  // Request initial state
  window.api.getBotStatus().then((status: BotStatus) => {
    updateStatusDisplay(status);
  });

  window.api.getBotState().then((state: BotState) => {
    updateStateDisplay(state);
  });
}

function setupApiListeners(): void {
  // Bot status updates
  window.api.onBotStatus((status: BotStatus) => {
    currentStatus = status;
    updateStatusDisplay(status);
  });

  // Full state updates
  window.api.onBulkUpdate((state: BotState) => {
    currentState = state;
    updateStateDisplay(state);
  });

  // Log updates
  window.api.onLog((log: string) => {
    appendLog(log);
  });

  // Path updates
  window.api.onPathUpdate((path: { x: number; y: number; z: number }[]) => {
    updatePathDisplay(path);
  });
}

function setupEventHandlers(): void {
  // Command input
  const commandInput = document.getElementById('command-input') as HTMLInputElement;
  const sendButton = document.getElementById('send-command') as HTMLButtonElement;

  if (commandInput && sendButton) {
    sendButton.addEventListener('click', () => {
      const input = commandInput.value.trim();
      if (input) {
        sendCommand(input);
        commandInput.value = '';
      }
    });

    commandInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const input = commandInput.value.trim();
        if (input) {
          sendCommand(input);
          commandInput.value = '';
        }
      }
    });
  }

  // Quick action buttons
  setupQuickActions();
}

function setupQuickActions(): void {
  const actions: Record<string, { command: string; args?: string }> = {
    'btn-force-eat': { command: 'force_eat' },
    'btn-refuel': { command: 'refuel' },
    'btn-stop': { command: 'stop' },
    'btn-home': { command: 'goto', args: 'home' },
    'btn-save-memory': { command: 'save_memory' },
  };

  Object.entries(actions).forEach(([id, action]) => {
    const btn = document.getElementById(id) as HTMLButtonElement;
    if (btn) {
      btn.addEventListener('click', () => {
        window.api.sendCommand(action.command, action.args);
      });
    }
  });

  // Settings toggles
  const toggles: Record<string, string> = {
    'toggle-autodefense': 'toggle_defense',
    'toggle-autoarmor': 'toggle_armor',
    'toggle-stealth': 'toggle_stealth',
  };

  Object.entries(toggles).forEach(([id, command]) => {
    const toggle = document.getElementById(id) as HTMLInputElement;
    if (toggle) {
      toggle.addEventListener('change', () => {
        window.api.sendCommand(command, String(toggle.checked));
      });
    }
  });
}

function sendCommand(input: string): void {
  // Parse command and args
  const parts = input.split(' ');
  const command = parts[0].replace(/^[:$]/, '');
  const args = parts.slice(1).join(' ');

  // Add to log
  appendLog(`> ${input}`);

  // Send to bot
  window.api.sendCommand(command, args || undefined).catch((error: Error) => {
    appendLog(`[ERROR] ${error.message}`);
  });
}

function updateStatusDisplay(status: BotStatus): void {
  const statusEl = document.getElementById('bot-status');
  const usernameEl = document.getElementById('bot-username');
  const retryEl = document.getElementById('retry-info');

  if (statusEl) {
    statusEl.textContent = status.status;
    statusEl.className = `status-${status.status.toLowerCase()}`;
  }

  if (usernameEl) {
    usernameEl.textContent = status.username;
  }

  if (retryEl && status.retryInMs && status.retryInMs > 0) {
    retryEl.textContent = `Retrying in ${Math.ceil(status.retryInMs / 1000)}s...`;
    retryEl.style.display = 'block';
  } else if (retryEl) {
    retryEl.style.display = 'none';
  }
}

function updateStateDisplay(state: BotState): void {
  // Update vitals
  updateVitals(state.botData);

  // Update inventory
  updateInventory(state.inventory);

  // Update equipment
  updateEquipment(state.equipment);

  // Update coordinates
  updateCoordinates(state.botData.pos);

  // Update users/admins
  updateUserList(state.users, state.admins);

  // Update settings
  updateSettings(state.settings);

  // Update map if present
  if (state.mapData) {
    updateMap(state.mapData);
  }
}

function updateVitals(data: BotState['botData']): void {
  const healthEl = document.getElementById('health-value');
  const foodEl = document.getElementById('food-value');

  if (healthEl) {
    healthEl.textContent = `${Math.floor(data.health)}/20`;
    const healthBar = document.getElementById('health-bar') as HTMLElement;
    if (healthBar) {
      healthBar.style.width = `${(data.health / 20) * 100}%`;
    }
  }

  if (foodEl) {
    foodEl.textContent = `${Math.floor(data.food)}/20`;
    const foodBar = document.getElementById('food-bar') as HTMLElement;
    if (foodBar) {
      foodBar.style.width = `${(data.food / 20) * 100}%`;
    }
  }
}

function updateInventory(inventory: BotState['inventory']): void {
  const container = document.getElementById('inventory-grid');
  if (!container) return;

  container.innerHTML = '';

  inventory.forEach((item, index) => {
    if (item.name === 'air' || item.count === 0) return;

    const slot = document.createElement('div');
    slot.className = 'inventory-slot';
    slot.dataset.slot = String(index);
    slot.title = `${item.displayName} x${item.count}`;

    slot.innerHTML = `
      <span class="item-count">${item.count > 1 ? item.count : ''}</span>
      <span class="item-name">${item.displayName}</span>
    `;

    container.appendChild(slot);
  });
}

function updateEquipment(equipment: BotState['equipment']): void {
  const slots = ['head', 'chest', 'legs', 'feet', 'hand', 'offhand'];

  slots.forEach((slot) => {
    const el = document.getElementById(`equip-${slot}`);
    if (el) {
      el.textContent = equipment[slot as keyof typeof equipment] || 'Empty';
    }
  });
}

function updateCoordinates(pos: { x: number; y: number; z: number }): void {
  const coordEl = document.getElementById('coordinates');
  if (coordEl) {
    coordEl.textContent = `X: ${Math.floor(pos.x)} Y: ${Math.floor(pos.y)} Z: ${Math.floor(pos.z)}`;
  }
}

function updateUserList(users: string[], admins: string[]): void {
  const userList = document.getElementById('user-list');
  const adminList = document.getElementById('admin-list');

  if (userList) {
    userList.innerHTML = users.map(u => `<li>${u}${admins.includes(u) ? ' ⭐' : ''}</li>`).join('');
  }

  if (adminList) {
    adminList.innerHTML = admins.map(u => `<li>${u}</li>`).join('');
  }
}

function updateSettings(settings: BotState['settings']): void {
  const toggles: Record<string, HTMLInputElement | null> = {
    'toggle-autodefense': document.getElementById('toggle-autodefense') as HTMLInputElement,
    'toggle-autoarmor': document.getElementById('toggle-autoarmor') as HTMLInputElement,
    'toggle-stealth': document.getElementById('toggle-stealth') as HTMLInputElement,
  };

  if (toggles['toggle-autodefense']) toggles['toggle-autodefense']!.checked = settings.autoDefense;
  if (toggles['toggle-autoarmor']) toggles['toggle-autoarmor']!.checked = settings.autoArmor;
  if (toggles['toggle-stealth']) toggles['toggle-stealth']!.checked = settings.stealth;
}

function updateMap(mapData: BotState['mapData']): void {
  // Map rendering would go here
  // For now, just log
  console.log('Map update:', mapData.blocks.length, 'blocks,', mapData.entities.length, 'entities');
}

function updatePathDisplay(path: { x: number; y: number; z: number }[]): void {
  // Path rendering would go here
  console.log('Path update:', path.length, 'nodes');
}

function appendLog(message: string): void {
  const logContainer = document.getElementById('log-container');
  if (!logContainer) return;

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logContainer.appendChild(entry);

  // Auto-scroll
  logContainer.scrollTop = logContainer.scrollHeight;

  // Limit log entries
  while (logContainer.children.length > 100) {
    logContainer.removeChild(logContainer.firstChild!);
  }
}

// Expose for global access
(window as any).app = {
  sendCommand,
  getState: () => currentState,
  getStatus: () => currentStatus,
};