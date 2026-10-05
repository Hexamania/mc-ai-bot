const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("airiDesktop", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: settings => ipcRenderer.invoke("settings:save", settings),
  startBot: () => ipcRenderer.invoke("bot:start"),
  stopBot: () => ipcRenderer.invoke("bot:stop"),
  openDashboard: () => ipcRenderer.invoke("dashboard:open"),
  onLifecycle: callback => ipcRenderer.on("app:lifecycle", (_event, data) => callback(data)),
  onLog: callback => ipcRenderer.on("app:log", (_event, data) => callback(data)),
  onBotState: callback => ipcRenderer.on("app:bot-state", (_event, data) => callback(data)),
  onDashboardReady: callback => ipcRenderer.on("app:dashboard-ready", (_event, data) => callback(data))
})
