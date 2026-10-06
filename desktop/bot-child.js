console.log(`[BOT-WORKER] Starting bot entrypoint from ${__dirname}.`)

process.on("uncaughtException", error => {
  console.error("[BOT-WORKER] Uncaught exception:", error.stack || error)
  process.exit(1)
})

process.on("unhandledRejection", reason => {
  const detail = reason instanceof Error ? reason.stack || reason.message : String(reason)
  console.error("[BOT-WORKER] Unhandled rejection:", detail)
})

try {
  require("../bot.js")
  console.log("[BOT-WORKER] Bot entrypoint loaded.")
} catch (error) {
  console.error("[BOT-WORKER] Bot startup failed:", error.stack || error)
  process.exit(1)
}
