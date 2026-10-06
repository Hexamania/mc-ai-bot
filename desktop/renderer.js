const form = document.getElementById("settings-form")
const notice = document.getElementById("notice")
const startButton = document.getElementById("start")
const stopButton = document.getElementById("stop")
const dashboardButton = document.getElementById("open-dashboard")
const refreshDashboardButton = document.getElementById("refresh-dashboard")
const iframe = document.getElementById("dashboard")
const placeholder = document.getElementById("dashboard-placeholder")
const logContainer = document.getElementById("logs")
const fields = Object.fromEntries([...form.elements].filter(element => element.name).map(element => [element.name, element]))
const logEntries = []
const pendingLogs = []
let historyLoaded = false
let activeFilter = "all"

function showNotice(message, isError = false) {
  notice.textContent = message
  notice.classList.toggle("error", isError)
}

function readForm() {
  return {
    host: fields.host.value,
    port: Number(fields.port.value),
    username: fields.username.value,
    version: fields.version.value,
    openaiKey: fields.openaiKey.value,
    webPort: Number(fields.webPort.value),
    enableMemory: fields.enableMemory.checked
  }
}

function fillForm(config) {
  fields.host.value = config.host || ""
  fields.port.value = config.port || 25565
  fields.username.value = config.username || "Airi"
  fields.version.value = config.version || "1.21.1"
  fields.openaiKey.value = config.openaiKey || ""
  fields.webPort.value = config.webPort || 3000
  fields.enableMemory.checked = config.enableMemory !== false
  if (config.portableMode) {
    document.getElementById("storage-note").textContent =
      `Portable settings and memory: ${config.dataDirectory}. API key encryption is tied to this Windows account.`
  } else {
    document.getElementById("storage-note").textContent =
      "Settings and memory are stored in your Windows profile. API key uses Windows secure storage."
  }
}

async function saveSettings() {
  const config = await window.airiDesktop.saveSettings(readForm())
  fillForm(config)
  showNotice("Settings saved on this device.")
  return config
}

function renderLogs() {
  const shouldStickToBottom = logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 36
  logContainer.replaceChildren()
  const filtered = logEntries.filter(entry => activeFilter === "all" ||
    entry.stream === "error" || entry.stream === "stderr")
  if (filtered.length === 0) {
    const empty = document.createElement("div")
    empty.className = "empty-logs"
    const glyph = document.createElement("span")
    glyph.className = "empty-glyph"
    glyph.textContent = "⌁"
    const message = document.createElement("span")
    message.textContent = activeFilter === "error" ? "No errors recorded." : "Waiting for application output…"
    empty.append(glyph, message)
    logContainer.appendChild(empty)
  }
  for (const entry of filtered) {
    const row = document.createElement("div")
    row.className = "log-entry"
    row.dataset.stream = entry.stream
    const time = document.createElement("span")
    time.className = "log-time"
    time.textContent = new Date(entry.time).toLocaleTimeString([], { hour12: false })
    const tag = document.createElement("span")
    tag.className = "log-tag"
    tag.textContent = entry.stream === "stdout" ? "BOT" :
      entry.stream === "stderr" || entry.stream === "error" ? "ERROR" :
        entry.stream.toUpperCase()
    const message = document.createElement("span")
    message.className = "log-text"
    message.textContent = entry.line
    row.append(time, tag, message)
    logContainer.appendChild(row)
  }
  const errors = logEntries.filter(entry => entry.stream === "error" || entry.stream === "stderr").length
  document.getElementById("log-summary").textContent = logEntries.length
    ? `${logEntries.length} recent events${errors ? ` · ${errors} ${errors === 1 ? "error" : "errors"}` : ""}`
    : "Startup and bot events appear here"
  if (shouldStickToBottom) logContainer.scrollTop = logContainer.scrollHeight
}

function appendLog(entry) {
  if (!entry || typeof entry.line !== "string") return
  if (!historyLoaded) {
    pendingLogs.push(entry)
    return
  }
  const key = entry.id || `${entry.time}|${entry.stream}|${entry.line}`
  if (logEntries.some(existing => (existing.id || `${existing.time}|${existing.stream}|${existing.line}`) === key)) return
  logEntries.push(entry)
  if (logEntries.length > 500) logEntries.splice(0, logEntries.length - 500)
  renderLogs()
}

function setLifecycle({ status, detail, running: processRunning }) {
  const title = status === "online" ? "Online" :
    status === "connecting" || status === "starting" ? "Connecting" :
      status === "reconnecting" ? "Reconnecting" :
        status === "stopping" ? "Stopping" :
          status === "error" ? "Needs attention" : "Stopped"
  document.getElementById("status").textContent = title
  document.getElementById("connection-caption").textContent = detail || "Ready when you are"
  document.getElementById("bot-state").textContent = status === "online"
    ? "Minecraft connection active"
    : status === "error" ? "Check application output for details" :
      status === "reconnecting" ? "Retrying connection" :
        status === "starting" || status === "connecting" ? "Starting services" : "Standing by"
  document.getElementById("status-dot").className = `connection-led ${status}`
  document.querySelector(".live-pulse").className = `live-pulse ${status}`
  const running = typeof processRunning === "boolean"
    ? processRunning
    : ["online", "connecting", "starting", "reconnecting", "stopping"].includes(status)
  stopButton.disabled = !running
  startButton.disabled = running
}

form.addEventListener("submit", async event => {
  event.preventDefault()
  try {
    await saveSettings()
  } catch (error) {
    showNotice(error.message, true)
  }
})

startButton.addEventListener("click", async () => {
  try {
    await saveSettings()
    await window.airiDesktop.startBot()
    showNotice("Bot process started. Follow connection details in Application output.")
  } catch (error) {
    showNotice(error.message, true)
    appendLog({ time: new Date().toISOString(), stream: "error", line: error.message })
  }
})

stopButton.addEventListener("click", async () => {
  try {
    await window.airiDesktop.stopBot()
    showNotice("Bot stop requested.")
  } catch (error) {
    showNotice(error.message, true)
  }
})

dashboardButton.addEventListener("click", () => {
  if (iframe.src) iframe.contentWindow.location.reload()
})

refreshDashboardButton.addEventListener("click", () => {
  if (iframe.src) iframe.contentWindow.location.reload()
  refreshDashboardButton.classList.add("spinning")
  setTimeout(() => refreshDashboardButton.classList.remove("spinning"), 450)
})

iframe.addEventListener("load", () => {
  if (!iframe.src || iframe.src === "about:blank") return
  iframe.classList.add("loaded")
  placeholder.hidden = true
})

document.querySelectorAll(".filter-button").forEach(button => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter
    document.querySelectorAll(".filter-button").forEach(item => item.classList.toggle("selected", item === button))
    renderLogs()
  })
})

document.getElementById("clear-logs").addEventListener("click", async () => {
  try {
    await window.airiDesktop.clearLogs()
    logEntries.length = 0
    pendingLogs.length = 0
    renderLogs()
  } catch (error) {
    showNotice(error.message, true)
  }
})

document.getElementById("copy-logs").addEventListener("click", async () => {
  try {
    await window.airiDesktop.copyLogs(logEntries.map(entry =>
      `${new Date(entry.time).toLocaleTimeString([], { hour12: false })} [${entry.stream}] ${entry.line}`
    ).join("\n"))
    showNotice("Application output copied.")
  } catch (error) {
    showNotice(`Could not copy logs: ${error.message}`, true)
  }
})

window.airiDesktop.onLifecycle(setLifecycle)
window.airiDesktop.onLog(appendLog)
window.airiDesktop.onDashboardReady(({ url }) => {
  document.getElementById("dashboard-url").textContent = `LOCAL DASHBOARD · ${url.replace(/^https?:\/\//, "")}`
  dashboardButton.disabled = false
  const currentUrl = iframe.getAttribute("src")
  if (!currentUrl || new URL(currentUrl, window.location.href).href !== new URL(url, window.location.href).href) {
    iframe.src = url
  }
})
window.airiDesktop.onBotState(state => {
  const status = String(state.status || "").toLowerCase()
  if (status === "online") setLifecycle({ status: "online", detail: "Minecraft session connected" })
  else if (status === "error") setLifecycle({ status: "error", detail: state.error || state.reason || "Bot reported an error" })
})

Promise.all([window.airiDesktop.getSettings(), window.airiDesktop.getLogs()])
  .then(([config, savedLogs]) => {
    fillForm(config)
    const existingKeys = new Set()
    for (const entry of [...savedLogs, ...pendingLogs]) {
      if (!entry || typeof entry.line !== "string") continue
      const key = entry.id || `${entry.time}|${entry.stream}|${entry.line}`
      if (existingKeys.has(key)) continue
      existingKeys.add(key)
      logEntries.push(entry)
    }
    pendingLogs.length = 0
    while (logEntries.length > 500) logEntries.shift()
    historyLoaded = true
    renderLogs()
  })
  .catch(error => {
    historyLoaded = true
    showNotice(error.message, true)
    appendLog({ time: new Date().toISOString(), stream: "error", line: error.message })
    for (const entry of pendingLogs.splice(0)) appendLog(entry)
  })
