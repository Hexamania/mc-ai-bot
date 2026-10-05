const { app, BrowserWindow, ipcMain, safeStorage, utilityProcess } = require("electron")
const fs = require("node:fs")
const path = require("node:path")

const executableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)
const portableMode = process.env.AIRIOS_PORTABLE === "1" ||
  Boolean(process.env.PORTABLE_EXECUTABLE_DIR) ||
  fs.existsSync(path.join(executableDirectory, "portable.txt"))

if (portableMode) {
  const portableDataDirectory = path.join(executableDirectory, "portable-data")
  fs.mkdirSync(portableDataDirectory, { recursive: true })
  app.setPath("userData", portableDataDirectory)
}

const DEFAULTS = {
  host: "",
  port: 25565,
  username: "Airi",
  version: "1.21.1",
  enableMemory: true,
  webPort: 3000,
  openaiKey: ""
}

let window
let botProcess
let serverMonitor
let lifecycle = "stopped"
let userConfig
let stoppingBot = false

function configPath() {
  return path.join(app.getPath("userData"), "settings.json")
}

function readStoredConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(configPath(), "utf8"))
    let openaiKey = ""
    if (stored.openaiKeyEncrypted) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable.")
      openaiKey = safeStorage.decryptString(Buffer.from(stored.openaiKeyEncrypted, "base64"))
    }
    return { ...DEFAULTS, ...stored, openaiKey }
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`Could not read desktop settings: ${error.message}`)
    return { ...DEFAULTS }
  }
}

function send(channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}

function setLifecycle(status, detail = "") {
  lifecycle = status
  send("app:lifecycle", { status, detail })
}

function validateConfig(value) {
  const config = {
    host: String(value.host || "").trim(),
    port: Number(value.port),
    username: String(value.username || "").trim(),
    version: String(value.version || "").trim(),
    enableMemory: Boolean(value.enableMemory),
    webPort: Number(value.webPort),
    openaiKey: String(value.openaiKey || "").trim()
  }
  if (!config.host) throw new Error("Enter a Minecraft server address.")
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("Minecraft port must be between 1 and 65535.")
  }
  if (!config.username) throw new Error("Enter a Minecraft username.")
  if (!config.version) throw new Error("Enter a Minecraft client version.")
  if (!Number.isInteger(config.webPort) || config.webPort < 1 || config.webPort > 65535) {
    throw new Error("Dashboard port must be between 1 and 65535.")
  }
  if (config.port === config.webPort) throw new Error("Minecraft and dashboard ports must be different.")
  if (config.openaiKey && !safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure Windows storage is unavailable, so the API key cannot be saved safely.")
  }
  return config
}

function saveConfig(value) {
  const config = validateConfig(value)
  const stored = {
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    enableMemory: config.enableMemory,
    webPort: config.webPort,
    openaiKeyEncrypted: config.openaiKey
      ? safeStorage.encryptString(config.openaiKey).toString("base64")
      : ""
  }
  fs.mkdirSync(app.getPath("userData"), { recursive: true })
  fs.writeFileSync(configPath(), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
  userConfig = config
  return { ...config }
}

function logLine(stream, chunk) {
  for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
    send("app:log", { stream, line })
  }
}

function stopBot() {
  clearInterval(serverMonitor)
  serverMonitor = null
  if (botProcess) {
    stoppingBot = true
    botProcess.kill()
    setLifecycle("stopping", "Stopping the bot process.")
    return
  }
  setLifecycle("stopped")
}

async function startBot() {
  if (botProcess) throw new Error("The bot is already running.")
  const config = saveConfig(userConfig)
  const webUrl = `http://127.0.0.1:${config.webPort}`
  const childEnv = {
    ...process.env,
    MC_HOST: config.host,
    MC_PORT: String(config.port),
    MC_USERNAME: config.username,
    MC_VERSION: config.version,
    ENABLE_MEMORY: String(config.enableMemory),
    WEB_PORT: String(config.webPort),
    WEB_HOST: "127.0.0.1",
    MEMORY_FILE: path.join(app.getPath("userData"), "memory.json"),
    OPENAI_KEY: config.openaiKey,
    OPENAI_API_KEY: ""
  }
  const entry = path.join(app.getAppPath(), "bot.js")
  botProcess = utilityProcess.fork(entry, [], {
    cwd: app.getAppPath(),
    env: childEnv,
    stdio: "pipe",
    serviceName: "Airi Minecraft Bot"
  })
  botProcess.stdout?.on("data", chunk => logLine("stdout", chunk))
  botProcess.stderr?.on("data", chunk => logLine("stderr", chunk))
  botProcess.on("spawn", () => setLifecycle("starting", "Starting the dashboard and Minecraft connection."))
  botProcess.on("error", error => {
    send("app:log", { stream: "stderr", line: error.message })
    setLifecycle("error", error.message)
  })
  botProcess.on("exit", code => {
    botProcess = null
    clearInterval(serverMonitor)
    serverMonitor = null
    const wasStopped = stoppingBot
    stoppingBot = false
    setLifecycle(wasStopped || code === 0 ? "stopped" : "error", `Bot process exited with code ${code}.`)
  })

  stoppingBot = false
  setLifecycle("starting", "Starting the dashboard and Minecraft connection.")
  clearInterval(serverMonitor)
  serverMonitor = setInterval(async () => {
    if (!botProcess) return
    try {
      const response = await fetch(`${webUrl}/api/state`, { signal: AbortSignal.timeout(1500) })
      if (!response.ok) throw new Error(`Dashboard returned HTTP ${response.status}`)
      const state = await response.json()
      send("app:bot-state", state)
      send("app:dashboard-ready", { url: webUrl })
      const botStatus = String(state.status || "").toLowerCase()
      const lifecycleStatus = botStatus === "online"
        ? "online"
        : botStatus.includes("error")
          ? "error"
          : botStatus.includes("reconnect")
            ? "reconnecting"
            : "connecting"
      setLifecycle(lifecycleStatus, state.status || "Waiting for the bot.")
    } catch {
      setLifecycle("starting", "Waiting for the dashboard to start.")
    }
  }, 1000)
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: "#0a1019",
    title: "Airi OS",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.loadFile(path.join(__dirname, "index.html"))
}

ipcMain.handle("settings:get", () => ({
  ...userConfig,
  portableMode,
  dataDirectory: app.getPath("userData")
}))
ipcMain.handle("settings:save", (_event, config) => saveConfig(config))
ipcMain.handle("bot:start", async () => {
  await startBot()
  return { status: lifecycle }
})
ipcMain.handle("bot:stop", () => {
  stopBot()
  return { status: lifecycle }
})
ipcMain.handle("dashboard:open", () => {
  if (!userConfig) throw new Error("Save settings before opening the dashboard.")
  return { url: `http://127.0.0.1:${userConfig.webPort}` }
})

app.whenReady().then(() => {
  userConfig = readStoredConfig()
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("before-quit", stopBot)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
