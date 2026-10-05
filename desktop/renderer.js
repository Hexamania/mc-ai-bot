const form = document.getElementById("settings-form")
const notice = document.getElementById("notice")
const startButton = document.getElementById("start")
const stopButton = document.getElementById("stop")
const dashboardButton = document.getElementById("open-dashboard")
const iframe = document.getElementById("dashboard")
const placeholder = document.getElementById("dashboard-placeholder")
const logs = document.getElementById("logs")
const fields = Object.fromEntries([...form.elements].filter(element => element.name).map(element => [element.name, element]))

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
      `Portable mode: settings and memory are stored beside the app in ${config.dataDirectory}. The API key remains Windows-user encrypted.`
  }
}

async function saveSettings() {
  const config = await window.airiDesktop.saveSettings(readForm())
  fillForm(config)
  showNotice("Settings saved securely on this computer.")
  return config
}

function appendLog({ stream, line }) {
  const prefix = stream === "stderr" ? "[ERROR]" : "[BOT]"
  logs.textContent += `${prefix} ${line}\n`
  const lines = logs.textContent.split("\n")
  if (lines.length > 500) logs.textContent = lines.slice(-501).join("\n")
  logs.scrollTop = logs.scrollHeight
}

function setLifecycle({ status, detail }) {
  document.getElementById("status").textContent = detail || status
  document.getElementById("bot-state").textContent = status === "online"
    ? "Minecraft bot online"
    : status === "connecting" || status === "starting"
      ? "Connecting"
      : status === "error" ? "Needs attention" : "Waiting to start"
  document.getElementById("status-dot").className = `dot ${status}`
  const running = ["online", "connecting", "starting", "reconnecting", "stopping"].includes(status)
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
    showNotice("Bot process started. Connecting to Minecraft…")
  } catch (error) {
    showNotice(error.message, true)
  }
})

stopButton.addEventListener("click", async () => {
  try {
    await window.airiDesktop.stopBot()
    showNotice("Bot stopped.")
  } catch (error) {
    showNotice(error.message, true)
  }
})

dashboardButton.addEventListener("click", async () => {
  try {
    const { url } = await window.airiDesktop.openDashboard()
    iframe.src = url
  } catch (error) {
    showNotice(error.message, true)
  }
})

document.getElementById("clear-logs").addEventListener("click", () => { logs.textContent = "" })

window.airiDesktop.onLifecycle(setLifecycle)
window.airiDesktop.onLog(appendLog)
window.airiDesktop.onDashboardReady(({ url }) => {
  if (iframe.src !== url) iframe.src = url
  placeholder.hidden = true
  dashboardButton.disabled = false
})
window.airiDesktop.onBotState(state => {
  document.getElementById("bot-state").textContent = state.status || "Connecting"
})

window.airiDesktop.getSettings()
  .then(fillForm)
  .catch(error => showNotice(error.message, true))
