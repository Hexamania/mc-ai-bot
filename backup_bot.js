require("dotenv").config()
const mineflayer = require("mineflayer")
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder")
const mcDataLoader = require("minecraft-data")

/* ================= CONFIG ================= */
const PREFIX = ":"
const ADMIN_PREFIX = "$"

const BOT_PASSWORD = "airi123qqqqqqqq"
const ADMIN_PASSWORD = "Player_ADMIN132"
const MC_VERSION = process.env.MC_VERSION || "1.21.1"

/* ================= STATE ================= */
let roaming = false
let following = false
let followTarget = null
let pvpTarget = null
let AUTO_QUICKIES = false
let adminSessions = {}
let didAuth = false

/* ================= BOT ================= */
const bot = mineflayer.createBot({
  host: process.env.MC_HOST,
  port: Number(process.env.MC_PORT),
  username: process.env.MC_USERNAME,
  version: MC_VERSION,
  auth: "offline"
})

bot.loadPlugin(pathfinder)

/* ================= UTILS ================= */
const log = (t, m) => console.log(`[${t}]`, m)
const say = (m) => { console.log("[BOT SAY]", m); bot.chat(m) }
const pm = (u, m) => { console.log(`[BOT PM -> ${u}]`, m); bot.chat(`/msg ${u} ${m}`) }

/* ================= PARSER ================= */
function parse(raw) {
  raw = raw.trim()

  let pmMatch = raw.match(/^\[(.+?) -> me\] (.+)$/)
  if (pmMatch) return { user: pmMatch[1], msg: pmMatch[2], type: "pm" }

  if (raw.includes("»")) {
    const [l, r] = raw.split("»")
    const u = l.match(/(\.?[A-Za-z0-9_]{3,16})/)
    if (!u) return null
    return { user: u[1], msg: r.trim(), type: "chat" }
  }
  return null
}

/* ================= SPAWN / AUTH ================= */
bot.once("spawn", () => {
  log("SPAWN", "Bot online")
  say("🤖 Airi online | :help")

  if (!didAuth) {
    bot.chat(`/register ${BOT_PASSWORD} ${BOT_PASSWORD}`)
    bot.chat(`/login ${BOT_PASSWORD}`)
    didAuth = true
    log("AUTH", "register/login sent")
  }
})

/* ================= AUTO RESPAWN ================= */
bot.on("death", () => {
  log("DEATH", "Respawning...")
  setTimeout(() => bot.emit("respawn"), 1000)
})

/* ================= MESSAGE HANDLER ================= */
bot.on("message", (msg) => {
  const raw = msg.toString()
  log("SERVER", raw)

  const parsed = parse(raw)
  if (!parsed) return

  const { user, msg: content, type } = parsed
  const isAdmin = adminSessions[user] === true

  log("AUTH CHECK", `user=${user} | admin=${isAdmin}`)

  /* ===== ADMIN LOGIN ===== */
  if (type === "pm" && content.startsWith(ADMIN_PREFIX)) {
    const args = content.slice(1).split(" ")
    if (args[0] === "loginadmin" && args.slice(1).join(" ") === ADMIN_PASSWORD) {
      adminSessions[user] = true
      pm(user, "✅ admin login success")
      log("ADMIN", user)
    }
    return
  }

  if (!content.startsWith(PREFIX)) return
  const args = content.slice(1).split(" ")
  const cmd = args.shift().toLowerCase()

  log("CMD", `${user}${isAdmin ? " (ADMIN)" : ""} -> ${cmd}`)

  /* ===== PUBLIC ===== */
  if (cmd === "ping") return say("pong 🏓")
  if (cmd === "test") return say("✅ bot alive")

  if (cmd === "help") {
    return say(":ping :test :follow <p> :unfollow :roam :stop :pvp <p> :stoppvp :servercmd <cmd>")
  }

  /* ===== FOLLOW ===== */
  if (cmd === "follow") {
    const t = args[0]
    const p = bot.players[t]?.entity
    if (!p) return say("player not found")
    following = true
    followTarget = t
    say(`👣 following ${t}`)
    return followLoop()
  }

  if (cmd === "unfollow") {
    following = false
    followTarget = null
    bot.pathfinder.setGoal(null)
    return say("🛑 stopped following")
  }

  /* ===== PVP (ADMIN ONLY) ===== */
  if (cmd === "pvp") {
    if (!isAdmin) return say("❌ admin only")
    const t = args[0]
    const p = bot.players[t]?.entity
    if (!p) return say("player not found")
    pvpTarget = t
    say(`⚔️ PVP engaged vs ${t}`)
    return pvpLoop()
  }

  if (cmd === "stoppvp") {
    pvpTarget = null
    bot.pathfinder.setGoal(null)
    return say("🛑 PVP stopped")
  }

  /* ===== SERVER CMD ===== */
  if (cmd === "servercmd") {
    if (!isAdmin) return say("❌ admin only")
    bot.chat("/" + args.join(" "))
    return
  }

  /* ===== ROAM ===== */
  if (cmd === "roam") {
    roaming = true
    say("🚶 roaming")
    return roam()
  }

  if (cmd === "stop") {
    roaming = false
    following = false
    pvpTarget = null
    bot.pathfinder.setGoal(null)
    return say("⛔ all movement stopped")
  }
})

/* ================= FOLLOW LOOP ================= */
function followLoop() {
  if (!following || !followTarget) return
  const p = bot.players[followTarget]?.entity
  if (!p) return

  const mcData = mcDataLoader(bot.version) || mcDataLoader(MC_VERSION)
  const m = new Movements(bot, mcData)
  bot.pathfinder.setMovements(m)
  bot.pathfinder.setGoal(new goals.GoalFollow(p, 2), true)

  setTimeout(followLoop, 2000)
}

/* ================= PVP LOOP ================= */
function pvpLoop() {
  if (!pvpTarget) return
  const target = bot.players[pvpTarget]?.entity
  if (!target) return

  const mcData = mcDataLoader(bot.version) || mcDataLoader(MC_VERSION)
  const m = new Movements(bot, mcData)
  bot.pathfinder.setMovements(m)
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 1), true)

  if (bot.entity.position.distanceTo(target.position) < 3) {
    bot.lookAt(target.position.offset(0, 1.6, 0))
    bot.attack(target)
  }

  setTimeout(pvpLoop, 500)
}

/* ================= ROAM ================= */
function roam() {
  if (!roaming) return
  const mcData = mcDataLoader(bot.version) || mcDataLoader(MC_VERSION)
  const m = new Movements(bot, mcData)
  bot.pathfinder.setMovements(m)
  const p = bot.entity.position
  bot.pathfinder.setGoal(
    new goals.GoalBlock(
      Math.floor(p.x + Math.random() * 6 - 3),
      Math.floor(p.y),
      Math.floor(p.z + Math.random() * 6 - 3)
    )
  )
  setTimeout(roam, 7000)
}

/* ================= ERRORS ================= */
bot.on("kicked", r => console.error("[KICKED]", r))
bot.on("error", e => console.error("[ERROR]", e))
