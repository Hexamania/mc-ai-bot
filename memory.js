const fs = require("node:fs")
const path = require("node:path")

const MEMORY_FILE = path.join(__dirname, "memory.json")

function createDefaultMemory() {
  return {
    schemaVersion: 1,
    locations: {},
    players: {},
    currentTask: null,
    rules: [],
    learnedFacts: {}
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function normalizeMemory(value) {
  if (!isRecord(value)) return createDefaultMemory()

  return {
    schemaVersion: 1,
    locations: isRecord(value.locations) ? value.locations : {},
    players: isRecord(value.players) ? value.players : {},
    currentTask: isRecord(value.currentTask) ? value.currentTask : null,
    rules: Array.isArray(value.rules)
      ? value.rules.filter(rule => typeof rule === "string")
      : [],
    learnedFacts: isRecord(value.learnedFacts) ? value.learnedFacts : {}
  }
}

function loadMemory(filePath = MEMORY_FILE) {
  if (process.env.ENABLE_MEMORY !== "true") return createDefaultMemory()

  try {
    if (!fs.existsSync(filePath)) return createDefaultMemory()
    return normalizeMemory(JSON.parse(fs.readFileSync(filePath, "utf8")))
  } catch (error) {
    console.error(`[MEMORY-ERR] Could not load memory file: ${error.message}`)
    return createDefaultMemory()
  }
}

function saveMemory(data, filePath = MEMORY_FILE) {
  if (process.env.ENABLE_MEMORY !== "true") return false
  if (!isRecord(data)) throw new TypeError("Memory data must be an object")

  const normalized = normalizeMemory(data)
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
    } catch (cleanupError) {
      console.error(`[MEMORY-ERR] Could not remove temporary memory file: ${cleanupError.message}`)
    }
    throw error
  }
  return true
}

module.exports = {
  createDefaultMemory,
  loadMemory,
  saveMemory
}
