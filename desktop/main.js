const { app, BrowserWindow, clipboard, ipcMain, safeStorage, utilityProcess } = require("electron")
const fs = require("node:fs")
const path = require("node:path")

const executableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)
const portableMode = process.env.AIRIOS_PORTABLE === "1" ||
  Boolean(process.env.PORTABLE_EXECUTABLE_DIR) ||
  fs.existsSync(path.join(executableDirectory, "portable.txt"))
const portableDataDirectory = path.join(executableDirectory, "portable-data")
let portableDataError = null

if (portableMode) {
  try {
    fs.mkdirSync(portableDataDirectory, { recursive: true })
    app.setPath("userData", portableDataDirectory)
  } catch (error) {
    portableDataError = `Cannot use portable data folder "${portableDataDirectory}": ${error.message}`
  }
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
let dashboardReadySent = false
let lifecycle = "stopped"
let userConfig
let stoppingBot = false
let logSequence = 0
const logHistory = []
const MAX_LOG_HISTORY = 500
const MAX_LOG_FILE_BYTES = 512 * 1024

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
    if (error.code !== "ENOENT") appendAppLog("error", `Could not read desktop settings: ${error.stack || error.message}`)
    return { ...DEFAULTS }
  }
}

function send(channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}

function setLifecycle(status, detail = "") {
  lifecycle = status
  send("app:lifecycle", { status, detail, running: Boolean(botProcess) })
}

function logFilePath() {
  return path.join(app.getPath("userData"), "airi-os.log")
}

function appendAppLog(stream, message) {
  const entry = {
    id: `${Date.now()}-${++logSequence}`,
    time: new Date().toISOString(),
    stream,
    line: String(message).trimEnd()
  }
  if (!entry.line) return
  logHistory.push(entry)
  if (logHistory.length > MAX_LOG_HISTORY) logHistory.splice(0, logHistory.length - MAX_LOG_HISTORY)

  try {
    const file = logFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_FILE_BYTES) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-MAX_LOG_HISTORY / 2)
      fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8")
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8")
  } catch (error) {
    console.error(`Unable to persist application log: ${error.message}`)
  }
  send("app:log", entry)
}

function readAppLog() {
  try {
    const file = logFilePath()
    if (!fs.existsSync(file)) return logHistory.slice()
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-MAX_LOG_HISTORY)
    return lines.flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return [{ time: new Date().toISOString(), stream: "system", line }]
      }
    })
  } catch (error) {
    appendAppLog("error", `Unable to read saved application logs: ${error.message}`)
    return logHistory.slice()
  }
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
  if (portableDataError) throw new Error(portableDataError)
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

function pipeChildOutput(stream, data, buffers) {
  buffers[stream] = (buffers[stream] || "") + data.toString()
  const lines = buffers[stream].split(/\r?\n/)
  buffers[stream] = lines.pop()
  for (const line of lines) appendAppLog(stream, line)
}

function flushChildOutput(buffers) {
  for (const [stream, line] of Object.entries(buffers)) {
    if (line) appendAppLog(stream, line)
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
  dashboardReadySent = false
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
  const entry = path.join(app.getAppPath(), "desktop", "bot-child.js")
  const buffers = { stdout: "", stderr: "" }
  appendAppLog("system", `Starting bot worker for ${config.host}:${config.port} (Minecraft ${config.version}).`)
  botProcess = utilityProcess.fork(entry, [], {
    // app.getAppPath() is usually inside app.asar and cannot be used as a process cwd.
    cwd: app.getPath("userData"),
    env: childEnv,
    stdio: "pipe",
    serviceName: "Airi Minecraft Bot"
  })
  botProcess.stdout?.on("data", chunk => pipeChildOutput("stdout", chunk, buffers))
  botProcess.stderr?.on("data", chunk => pipeChildOutput("stderr", chunk, buffers))
  botProcess.stdout?.on("error", error => appendAppLog("error", `Could not read bot stdout: ${error.message}`))
  botProcess.stderr?.on("error", error => appendAppLog("error", `Could not read bot stderr: ${error.message}`))
  botProcess.on("spawn", () => {
    appendAppLog("system", `Bot worker started (PID ${botProcess.pid}).`)
    setLifecycle("starting", "Starting the dashboard and Minecraft connection.")
  })
  botProcess.on("error", error => {
    appendAppLog("error", `Bot worker failed to start: ${error.stack || error.message}`)
    setLifecycle("error", error.message)
  })
  botProcess.on("exit", code => {
    flushChildOutput(buffers)
    appendAppLog(code === 0 ? "system" : "error", `Bot worker exited with code ${code}.`)
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
      if (!dashboardReadySent) {
        dashboardReadySent = true
        send("app:dashboard-ready", { url: webUrl })
      }
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
ipcMain.handle("logs:get", () => readAppLog())
ipcMain.handle("logs:clear", () => {
  logHistory.length = 0
  try {
    fs.writeFileSync(logFilePath(), "", "utf8")
  } catch (error) {
    appendAppLog("error", `Unable to clear saved logs: ${error.message}`)
    throw error
  }
})
ipcMain.handle("logs:copy", (_event, text) => {
  clipboard.writeText(String(text || ""))
})
ipcMain.handle("bot:start", async () => {
  try {
    await startBot()
    return { status: lifecycle }
  } catch (error) {
    appendAppLog("error", `Could not start the bot: ${error.stack || error.message}`)
    setLifecycle("error", error.message)
    throw error
  }
})
ipcMain.handle("bot:stop", () => {
  appendAppLog("system", "Stop requested.")
  stopBot()
  return { status: lifecycle }
})
ipcMain.handle("dashboard:open", () => {
  if (!userConfig) throw new Error("Save settings before opening the dashboard.")
  return { url: `http://127.0.0.1:${userConfig.webPort}` }
})

app.whenReady().then(() => {
  userConfig = readStoredConfig()
  appendAppLog("system", `Airi OS started${portableMode ? " in portable mode" : ""}.`)
  createWindow()
  if (portableDataError) {
    appendAppLog("error", portableDataError)
    setLifecycle("error", "Portable folder is not writable.")
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("before-quit", stopBot)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
