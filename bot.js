require("dotenv").config()
const mineflayer = require("mineflayer")
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder")
const mcDataLoader = require("minecraft-data")
const { OpenAI } = require("openai")
const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const vec3 = require("vec3")
const path = require("path")

const app = express()
const server = http.createServer(app)
const io = new Server(server)

/* ================= CONFIG ================= */
const PREFIX = ":"
const ADMIN_PREFIX = "$"

const BOT_PASSWORD = "airi123qqqqqqqq"
const ADMIN_PASSWORD = "Player_ADMIN132"
const MC_VERSION = process.env.MC_VERSION?.trim() || "1.21.1"

/* ================= STATE ================= */
let roaming = false
let following = false
let followTarget = null
let pvpTarget = null
let miningBaseLocation = null
let safeModeActive = false
let killAuraActive = false
let lumberjackActive = false
let AUTO_QUICKIES = false
let medicMode = false
let medicTarget = null
let adminSessions = {}
let mcData = null
let movements = null
let isShielding = false
let autoDefense = true
let autoArmorEnabled = true
let stealthMode = false
let progressionActive = false
let waitingForHelp = false
let helpObjective = null
let baseLocation = null
let isDepositing = false
let isFarming = false
let isHandlingSafety = false
let currentObjective = "Idle"
let minerActive = false
let minerProgress = 0
let minerTotal = 0

/* ================= OPENAI ================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY
})

/* ================= BOT ================= */
let client = null
let reconnectTimer = null
let reconnectAttempt = 0
let dashboardInterval = null
let spawnLookInterval = null
let isOnline = false
let statusEvent = "connecting"
let statusReason = null
let statusError = null
let retryAt = null
const botListeners = []
let dispatchingBotListener = false

function attachBotListener(instance, record) {
  const wrapped = function (...args) {
    if (instance !== client) return
    const previousDispatchState = dispatchingBotListener
    dispatchingBotListener = true
    try {
      return record.listener.apply(this, args)
    } finally {
      dispatchingBotListener = previousDispatchState
    }
  }

  if (record.once) instance.once(record.event, wrapped)
  else instance.on(record.event, wrapped)
}

const bot = new Proxy({}, {
  get(_target, property) {
    if (!client) return undefined
    if (property === "on" || property === "once") {
      return (event, listener) => {
        const record = { event, listener, once: property === "once" }
        if (!dispatchingBotListener) botListeners.push(record)
        attachBotListener(client, record)
        return bot
      }
    }

    const value = client[property]
    return typeof value === "function" ? value.bind(client) : value
  },
  set(_target, property, value) {
    if (!client) return false
    client[property] = value
    return true
  }
})

/* ================= WEB STATE ================= */
let state = {
  status: 'Offline',
  users: [],
  admins: [],
  logs: ['Dashboard started'],
  settings: { theme: 'dark' },
  botData: { health: 20, food: 20, pos: { x: 0, y: 0, z: 0 } },
  inventory: [],
  currentPath: [],
  favorites: {}, // Store named coordinates here
  equipment: {}
};

function getBotStatus(extra = {}) {
  return {
    online: isOnline,
    username: client?.username || process.env.MC_USERNAME || "Airi",
    status: state.status,
    event: statusEvent,
    reason: statusReason,
    error: statusError,
    retryAt,
    retryInMs: retryAt ? Math.max(0, retryAt - Date.now()) : null,
    ...extra
  }
}

function emitBotStatus(extra = {}) {
  io.emit("bot_status", getBotStatus(extra))
}

function formatConnectionReason(reason) {
  if (typeof reason === "string") return reason
  if (reason && typeof reason === "object") {
    try {
      return JSON.stringify(reason)
    } catch (error) {
      return reason.toString()
    }
  }
  return reason == null ? "Unknown reason" : String(reason)
}

function scheduleReconnect(instance, reason, detail, status = "Reconnecting", event = "end") {
  if (instance !== client) return

  isOnline = false
  if (reconnectTimer) {
    if (status === "Error" && (state.status !== "Error" || event === "kicked")) {
      state.status = status
      statusEvent = event
      statusReason = reason
      statusError = detail || reason
    }
    emitBotStatus()
    return
  }

  state.status = status
  statusEvent = event
  statusReason = reason
  statusError = status === "Error" ? detail || reason : null
  const retryInMs = Math.min(1000 * (2 ** reconnectAttempt), 60000)
  reconnectAttempt += 1
  retryAt = Date.now() + retryInMs
  emitBotStatus()
  log("RECONNECT", `${reason}${detail ? `: ${detail}` : ""}. Retrying in ${Math.round(retryInMs / 1000)}s.`)

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectBot()
  }, retryInMs)
}

function connectBot() {
  state.status = "Connecting"
  statusEvent = "connecting"
  statusReason = null
  statusError = null
  retryAt = null
  isOnline = false
  emitBotStatus()
  try {
    const instance = mineflayer.createBot({
      host: process.env.MC_HOST,
      port: Number(process.env.MC_PORT) || 25565,
      username: process.env.MC_USERNAME,
      version: MC_VERSION,
      auth: "offline",
      // Mineflayer's protocol layer handles Minecraft keep-alive packets; this is
      // its local timeout for stalled connections, not a server-side AFK setting.
      checkTimeoutInterval: 60000
    })
    client = instance
    instance.loadPlugin(pathfinder)
    for (const listener of botListeners) attachBotListener(instance, listener)

    instance._client.on("finish_configuration", () => {
      setImmediate(() => {
        if (instance !== client) return
        if (instance._client.state === "play") {
          log("CONFIG", "Minecraft configuration finished; protocol client entered play state")
        } else {
          log("CONFIG-ERR", `Expected play state after finish_configuration, got "${instance._client.state}"`)
        }
      })
    })

    instance.on("login", () => {
      if (instance !== client) return
      state.status = "Connecting"
      statusEvent = "login"
      statusReason = null
      statusError = null
      retryAt = null
      emitBotStatus()
    })
    instance.on("end", reason => {
      if (instance !== client) return
      clearInterval(spawnLookInterval)
      spawnLookInterval = null
      scheduleReconnect(instance, "Disconnected", formatConnectionReason(reason), "Reconnecting", "end")
    })
    instance.on("kicked", kickReason => {
      if (instance !== client) return
      clearInterval(spawnLookInterval)
      spawnLookInterval = null
      const detail = formatConnectionReason(kickReason)
      scheduleReconnect(instance, "Kicked", detail, "Error", "kicked")
      log("KICKED", detail)
    })
    instance.on("error", error => {
      if (instance !== client) return
      clearInterval(spawnLookInterval)
      spawnLookInterval = null
      scheduleReconnect(instance, "Connection error", error.message, "Error", "error")
      log("ERROR", error.message)
    })
  } catch (error) {
    isOnline = false
    state.status = "Offline"
    emitBotStatus({ reason: "Connection setup failed" })
    log("ERROR", `Unable to create bot connection: ${error.message}`)
    scheduleReconnect(client, "Connection setup failed", error.message, "Error", "error")
  }
}

app.use(express.json());

// Ensure the dashboard is served correctly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Serve static assets if they exist in the test folder
app.use(express.static(path.join(__dirname, 'Website test', 'public')));
app.use(express.static(path.join(__dirname)));

app.get('/api/state', (req, res) => res.json(state));

server.listen(3000, () => log("WEB", "Dashboard running at http://localhost:3000"))

/* ================= UTILS ================= */
const log = (t, m) => {
  const entry = `[${t}] ${m}`;
  console.log(entry);
  state.logs.push(entry);
  if (state.logs.length > 100) state.logs.shift();
  io.emit("log", entry);
  if (t === "ERROR" || t.includes("ERR")) say(`⚠️ ${t}: ${m}`)
}
const say = (m) => {
  console.log("[BOT SAY]", m)
  if (isOnline && bot.entity) bot.chat(m)
}
const pm = (u, m) => { console.log(`[BOT PM -> ${u}]`, m); bot.chat(`/msg ${u} ${m}`) }

connectBot()

/* ================= PARSER ================= */
function parse(raw) {
  raw = raw.trim();
  // Support for [User -> me] Private Messages
  let pmMatch = raw.match(/^\[(.+?) -> me\] (.+)$/);
  if (pmMatch) return { user: pmMatch[1], msg: pmMatch[2], type: "pm" };

  // Support for "User whispers to you: message" (Found in your logs)
  let whisperMatch = raw.match(/^(.+?) whispers to you: (.+)$/);
  if (whisperMatch) return { user: whisperMatch[1], msg: whisperMatch[2], type: "pm" };

  // Support for <User> Message (Standard format seen in your logs)
  let chatMatch = raw.match(/^<(.+?)> (.+)$/);
  if (chatMatch) return { user: chatMatch[1], msg: chatMatch[2], type: "chat" };

  // Support for User » Message (Alternate format)
  if (raw.includes("»")) {
    const [l, r] = raw.split("»");
    const u = l.match(/(\.?[A-Za-z0-9_]{3,16})/);
    if (u) return { user: u[1], msg: r.trim(), type: "chat" };
  }
  return null;
}

/* ================= STATUS HELPER ================= */
function getStatusReport() {
  const registry = bot.registry
  const count = (name) => {
    const item = registry.itemsByName[name]
    return item ? bot.inventory.count(item.id) : 0
  }
  
  let report = `📊 Status: ${currentObjective} | `
  let missing = []
  
  if (count('oak_log') === 0 && count('oak_planks') < 4) missing.push("Wood")
  if (count('stone_pickaxe') === 0 && count('iron_ingot') < 3) missing.push("Iron")
  if (count('diamond') < 3) missing.push(`${3 - count('diamond')} Diamonds`)
  if (count('obsidian') < 10) missing.push(`${10 - count('obsidian')} Obsidian`)
  if (count('enchanting_table') === 0) missing.push("Enchanting Table")
  if (count('blaze_rod') > 0 && count('brewing_stand') === 0) missing.push("Brewing Stand")
  if (count('brewing_stand') > 0 && count('glistering_melon_slice') === 0) missing.push("Potion Ingredients")
  if (count('lapis_lazuli') < 3) missing.push("Lapis Lazuli")
  if (bot.experience.level < 30) missing.push(`${30 - bot.experience.level} XP Levels`)
  if (count('bookshelf') < 15) missing.push(`${15 - count('bookshelf')} Bookshelves`)
  if (count('flint_and_steel') === 0) missing.push("Flint & Steel")

  if (missing.length > 0) report += `Missing: ${missing.join(", ")}`
  else report += "All materials ready for Nether phase."
  
  return report
}

/* ================= TOOL SELECTION ================= */
async function equipToolForBlock(block) {
  if (!block) return;
  const registry = bot.registry;
  const pickaxes = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
  
  let minTier = 0; // 0: Wood, 1: Stone, 2: Iron, 3: Diamond/Netherite
  const name = block.name;

  if (name.includes('obsidian') || name.includes('ancient_debris')) minTier = 3;
  else if (name.includes('diamond_ore') || name.includes('gold_ore') || name.includes('emerald_ore') || name.includes('redstone_ore')) minTier = 2;
  else if (name.includes('iron_ore') || name.includes('copper_ore') || name.includes('lapis_ore')) minTier = 1;

  const availablePicks = bot.inventory.items().filter(i => pickaxes.includes(i.name));
  
  // Sort picks by tier index (lower index in 'pickaxes' array is better)
  availablePicks.sort((a, b) => pickaxes.indexOf(a.name) - pickaxes.indexOf(b.name));

  const bestPick = availablePicks.find(p => {
    const tier = 4 - pickaxes.indexOf(p.name); // Wooden=0, Stone=1... Netherite=4
    return tier >= minTier;
  });

  if (bestPick) {
    await bot.equip(bestPick, 'hand');
  } else if (minTier > 0) {
    log("TOOL-WARN", `No tool found suitable for ${name}. Tier ${minTier} required.`);
  }
}

/* ================= REFUEL LOGIC ================= */
async function refuel() {
  const registry = bot.registry;
  const coalBlocks = registry.blocksArray
    .filter(b => b.name === 'coal_ore' || b.name === 'deepslate_coal_ore')
    .map(b => b.id);

  say("⛏️ Refuel Protocol: Searching for coal...");
  
  let gathered = 0;
  for (let i = 0; i < 5; i++) {
    const block = bot.findBlock({ matching: coalBlocks, maxDistance: 32 });
    if (block) {
      try {
        await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world));
        await equipToolForBlock(block);
        await bot.dig(block);
        gathered++;
      } catch (e) { log("REFUEL-ERR", e.message); }
    } else {
      break;
    }
  }

  if (gathered === 0) {
    // Check for charcoal smelting if no ore found
    const logs = bot.inventory.items().find(i => i.name.includes('_log'));
    if (logs) {
      say("🪵 No coal ore found. Smelting logs for charcoal instead...");
      const furnaceBlock = bot.findBlock({ matching: registry.blocksByName.furnace.id, maxDistance: 10 });
      if (furnaceBlock) {
         const furnace = await bot.openFurnace(furnaceBlock);
         await furnace.putInput(logs.type, null, logs.count);
         // Put one plank as starter fuel if possible
      }
    } else {
      say("❌ No coal found nearby and no logs to smelt.");
    }
  } else say(`✅ Refuel complete. Gathered from ${gathered} veins.`);
}

/* ================= PROGRESSION & BREWING LOGIC ================= */
async function beatTheGame() {
  if (!progressionActive || isDepositing || minerActive) return
  
  const items = bot.inventory.items()
  const registry = bot.registry
  
  const tableBlock = bot.findBlock({ matching: registry.blocksByName.crafting_table.id, maxDistance: 4 })
  const brewingStandBlock = bot.findBlock({ matching: registry.blocksByName.brewing_stand.id, maxDistance: 4 })

  // Helper to check item count
  const count = (name) => {
    const item = registry.itemsByName[name]
    if (!item) return 0
    return bot.inventory.count(item.id)
  }

  // Check for Auto-Sleep
  if (bot.time.timeOfDay >= 13000 && bot.time.timeOfDay <= 23000) {
    await handleNightAndSleep();
  }

  // Hunt sheep for bed if missing
  if (count('white_wool') < 3 && !bot.inventory.items().find(i => i.name.includes('_bed'))) {
    const sheep = bot.nearestEntity(e => e.name === 'sheep');
    if (sheep) {
      await bot.pathfinder.goto(new goals.GoalFollow(sheep, 2));
      await bot.attack(sheep);
    }
  }

  // 0. Maintenance Check: Auto-Craft Broken Tools
  const brokenEssentials = [
    { name: 'iron_pickaxe', materials: { iron_ingot: 3, stick: 2 } },
    { name: 'iron_sword', materials: { iron_ingot: 2, stick: 1 } }
  ]

  for (const item of brokenEssentials) {
    if (count(item.name) === 0 && Object.entries(item.materials).every(([m, amt]) => count(m) >= amt)) {
      currentObjective = `Repairing ${item.name}`
      const recipe = bot.recipesFor(registry.itemsByName[item.name].id, null, 1, tableBlock)[0]
      if (recipe) {
        say(`🛠️ Maintenance: Replacing broken ${item.name.replace('_', ' ')}...`)
        if (!tableBlock) {
           const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0))
           await bot.placeBlock(ref, new vec3(0, 1, 0))
        }
        await bot.craft(recipe, 1, tableBlock)
      }
    }
  }

  // Ensure Armor is always equipped
  autoArmor()

  // 1. Collect Wood
  const logs = registry.blocksArray.filter(b => b.name.includes('_log')).map(b => b.id)
  if (count('oak_planks') < 4 && count('oak_log') === 0) {
    currentObjective = "Collecting Wood"
    const logBlock = bot.findBlock({ matching: logs, maxDistance: 32 })
    if (logBlock) {
      say("🌳 Objective: Collecting Wood...")
      await mineBlock(logBlock.name)
    } else {
      return askForHelp("Wood Logs")
    }
  }

  // 2. Craft Planks
  if (count('oak_log') > 0 && count('oak_planks') < 4) {
    currentObjective = "Crafting Planks"
    const recipe = bot.recipesFor(registry.itemsByName.oak_planks.id, null, 1, null)[0]
    if (recipe) await bot.craft(recipe, 1, null)
  }

  // 3. Craft Crafting Table
  if (count('oak_planks') >= 4 && count('crafting_table') === 0) {
    currentObjective = "Crafting Table"
    const recipe = bot.recipesFor(registry.itemsByName.crafting_table.id, null, 1, null)[0]
    if (recipe) await bot.craft(recipe, 1, null)
  }

  // 4. Place Table and Craft Tools (Sticks -> Pickaxe)
  if (count('crafting_table') > 0 && count('wooden_pickaxe') === 0) {
    currentObjective = "Crafting Basic Tools"
    if (count('stick') < 2) {
      const stickRecipe = bot.recipesFor(registry.itemsByName.stick.id, null, 1, null)[0]
      if (stickRecipe) await bot.craft(stickRecipe, 1, null)
    }
    
    const table = bot.findBlock({ matching: registry.blocksByName.crafting_table.id, maxDistance: 4 })
    if (!table) {
      const pos = bot.entity.position.offset(1, 0, 0)
      const referenceBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0))
      await bot.placeBlock(referenceBlock, new vec3(0, 1, 0))
    }
    
    const pickRecipe = bot.recipesFor(registry.itemsByName.wooden_pickaxe.id, null, 1, table)[0]
    if (pickRecipe) {
      say("⚒️ Crafting Wooden Pickaxe...")
      await bot.craft(pickRecipe, 1, table)
    }
  }

  // 5. Mining Stone
  if (count('wooden_pickaxe') > 0 && count('cobblestone') < 16) {
    currentObjective = "Mining Stone"
    const stone = bot.findBlock({ matching: registry.blocksByName.stone.id, maxDistance: 32 })
    if (stone) {
      say("🪨 Objective: Mining Stone...")
      await mineBlock('stone')
    } else {
      return askForHelp("Stone")
    }
  }

  // 6. Upgrade to Stone Pickaxe
  if (count('cobblestone') >= 3 && count('stone_pickaxe') === 0 && count('wooden_pickaxe') > 0) {
    currentObjective = "Upgrading Pickaxe"
    const recipe = bot.recipesFor(registry.itemsByName.stone_pickaxe.id, null, 1, tableBlock)[0]
    if (recipe) {
      say("⚒️ Upgrading to Stone Pickaxe...")
      await bot.craft(recipe, 1, tableBlock)
    }
  }

  // 7. Mining Iron
  if (count('stone_pickaxe') > 0 && count('iron_ingot') < 3 && count('raw_iron') === 0) {
    currentObjective = "Mining Iron"
    const ironBlocks = [registry.blocksByName.iron_ore.id, registry.blocksByName.deepslate_iron_ore.id]
    const iron = bot.findBlock({ matching: ironBlocks, maxDistance: 32 })
    if (iron) {
      say("⛏️ Objective: Mining Iron...")
      await mineBlock(iron.name)
    } else {
      return askForHelp("Iron Ore")
    }
  }

  // 8. Smelting Iron (Checks for Furnace and Fuel)
  if (count('raw_iron') > 0 && count('iron_ingot') < 3) {
    currentObjective = "Smelting Iron"
    let furnaceBlock = bot.findBlock({ matching: registry.blocksByName.furnace.id, maxDistance: 4 })
    
    if (!furnaceBlock) {
      if (count('furnace') > 0) {
        say("🔥 Placing furnace...")
        const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0))
        await bot.placeBlock(ref, new vec3(0, 1, 0))
        furnaceBlock = bot.findBlock({ matching: registry.blocksByName.furnace.id, maxDistance: 4 })
      } else if (count('cobblestone') >= 8) {
        const recipe = bot.recipesFor(registry.itemsByName.furnace.id, null, 1, tableBlock)[0]
        if (recipe) await bot.craft(recipe, 1, tableBlock)
      } else {
        return askForHelp("Cobblestone for Furnace")
      }
    }

    if (furnaceBlock) {
      const fuelItems = ['coal', 'charcoal', 'oak_log', 'oak_planks']
      const fuel = items.find(i => fuelItems.includes(i.name))
      if (!fuel) return askForHelp("Fuel (Coal or Wood)")

      say("🔥 Smelting iron ore...")
      try {
        const furnace = await bot.openFurnace(furnaceBlock)
        await furnace.putFuel(fuel.type, null, 1)
        await furnace.putInput(registry.itemsByName.raw_iron.id, null, count('raw_iron'))
        
        // Wait for smelting (approx 10s per item)
        setTimeout(async () => {
          await furnace.takeOutput()
          furnace.close()
        }, 12000)
      } catch (e) { log("SMELT-ERR", e.message) }
    }
  }

  // 9. Craft Bucket & Get Water
  if (count('iron_ingot') >= 3 && count('bucket') === 0 && count('water_bucket') === 0) {
    currentObjective = "Crafting Bucket"
    const recipe = bot.recipesFor(registry.itemsByName.bucket.id, null, 1, tableBlock)[0]
    if (recipe) {
      say("🪣 Crafting Iron Bucket...")
      await bot.craft(recipe, 1, tableBlock)
    }
  }

  if (count('bucket') > 0 && count('water_bucket') === 0) {
    currentObjective = "Collecting Water"
    const water = bot.findBlock({ matching: registry.blocksByName.water.id, maxDistance: 32 })
    if (water) {
      say("💧 Collecting water...")
      const bucket = bot.inventory.findInventoryItem(registry.itemsByName.bucket.id)
      await bot.equip(bucket, 'hand')
      await bot.pathfinder.goto(new goals.GoalLookAtBlock(water.position, bot.world))
      await bot.activateBlock(water)
    } else {
      return askForHelp("Water Source")
    }
  }

  // 10. Finding Lava
  if (count('iron_ingot') >= 3 || count('water_bucket') > 0) {
    currentObjective = "Finding Lava"
    const lava = bot.findBlock({ matching: registry.blocksByName.lava.id, maxDistance: 32 })
    if (lava) {
      say("🔥 Found Lava! Preparing portal steps...")
    } else {
      if (count('iron_ingot') >= 3) return askForHelp("Lava")
    }
  }

  // 11. Craft Iron Pickaxe (to mine diamonds)
  if (count('iron_ingot') >= 3 && count('iron_pickaxe') === 0) {
    currentObjective = "Upgrading Pickaxe"
    const recipe = bot.recipesFor(registry.itemsByName.iron_pickaxe.id, null, 1, tableBlock)[0]
    if (recipe) {
      say("⚒️ Upgrading to Iron Pickaxe...")
      await bot.craft(recipe, 1, tableBlock)
    }
  }

  // 12. Mining Diamonds
  if (count('iron_pickaxe') > 0 && count('diamond') < 27) {
    currentObjective = "Mining Diamonds"
    const diamondBlocks = [registry.blocksByName.diamond_ore.id, registry.blocksByName.deepslate_diamond_ore.id]
    const diamond = bot.findBlock({ matching: diamondBlocks, maxDistance: 64 })
    if (diamond) {
      say("💎 Objective: Mining Diamonds...")
      await mineBlock(diamond.name)
    } else {
      if (bot.entity.position.y > 0) {
        say("🧭 Diamonds are deep underground. Searching lower levels...")
      }
      return askForHelp("Diamond Ore")
    }
  }

  // 13. Craft Diamond Pickaxe
  if (count('diamond') >= 3 && count('diamond_pickaxe') === 0 && count('iron_pickaxe') > 0) {
    currentObjective = "Upgrading Pickaxe"
    const recipe = bot.recipesFor(registry.itemsByName.diamond_pickaxe.id, null, 1, tableBlock)[0]
    if (recipe) {
      say("⚒️ Upgrading to Diamond Pickaxe...")
      await bot.craft(recipe, 1, tableBlock)
    }
  }

  // 13.1 Mining Obsidian
  if (count('diamond_pickaxe') > 0 && count('obsidian') < 14) {
    currentObjective = "Mining Obsidian"
    const obsidian = bot.findBlock({ matching: registry.blocksByName.obsidian.id, maxDistance: 32 })
    if (obsidian) {
      say("🟣 Objective: Mining Obsidian...")
      await mineBlock('obsidian')
    }
  }

  // 13.2 Gathering for Books (Paper and Leather)
  if (count('obsidian') >= 4 && count('book') < 16) {
    const cane = bot.findBlock({ matching: registry.blocksByName.sugar_cane.id, maxDistance: 64 })
    if (count('sugar_cane') < 48 && cane) {
      currentObjective = "Collecting Sugar Cane"
      await mineBlock('sugar_cane')
    }
    
    const cow = bot.nearestEntity(e => e.name === 'cow')
    if (count('leather') < 16 && cow) {
      currentObjective = "Hunting Cows"
      await bot.pathfinder.goto(new goals.GoalFollow(cow, 2))
      await bot.attack(cow)
    }
  }

  // 13.3 Crafting Books
  if (count('sugar_cane') >= 3 && count('paper') < 48) {
    const paperRecipe = bot.recipesFor(registry.itemsByName.paper.id, null, 1, null)[0]
    if (paperRecipe) {
      currentObjective = "Crafting Paper"
      await bot.craft(paperRecipe, 1, null)
    }
  }
  if (count('paper') >= 3 && count('leather') >= 1 && count('book') < 16) {
    const bookRecipe = bot.recipesFor(registry.itemsByName.book.id, null, 1, null)[0]
    if (bookRecipe) {
      currentObjective = "Crafting Books"
      await bot.craft(bookRecipe, 1, null)
    }
  }

  // 13.4 Craft Enchanting Table
  if (count('obsidian') >= 4 && count('diamond') >= 2 && count('book') >= 1 && count('enchanting_table') === 0) {
    currentObjective = "Crafting Enchanting Table"
    if (tableBlock) {
      const recipe = bot.recipesFor(registry.itemsByName.enchanting_table.id, null, 1, tableBlock)[0]
      if (recipe) {
        say("🔮 Crafting Enchanting Table...")
        await bot.craft(recipe, 1, tableBlock)
      }
    }
  }

  // 13.5 Craft Diamond Armor
  const armorPieces = [
    { name: 'diamond_helmet', cost: 5 },
    { name: 'diamond_chestplate', cost: 8 },
    { name: 'diamond_leggings', cost: 7 },
    { name: 'diamond_boots', cost: 4 }
  ]
  for (const p of armorPieces) {
    if (count(p.name) === 0 && count('diamond') >= p.cost) {
      currentObjective = `Crafting ${p.name.replace('_', ' ')}`
      const recipe = bot.recipesFor(registry.itemsByName[p.name].id, null, 1, tableBlock)[0]
      if (recipe) {
        say(`⚒️ Upgrading protection: Crafting ${p.name.replace('_', ' ')}...`)
        await bot.craft(recipe, 1, tableBlock)
        // autoArmor function handles the equipping automatically
      }
    }
  }

  // 13.6 Craft Bookshelves
  if (count('enchanting_table') > 0 && count('book') >= 3 && count('oak_planks') >= 6 && count('bookshelf') < 15) {
    currentObjective = "Crafting Bookshelves"
    if (tableBlock) {
      const recipe = bot.recipesFor(registry.itemsByName.bookshelf.id, null, 1, tableBlock)[0]
      if (recipe) {
        say(`📚 Upgrading library: Crafting Bookshelf (${count('bookshelf') + 1}/15)...`)
        await bot.craft(recipe, 1, tableBlock)
      }
    }
  }

  // 13.7 Enchant Gear
  if (count('enchanting_table') > 0 && bot.experience.level >= 30 && count('lapis_lazuli') >= 3) {
    const enchantTable = bot.findBlock({ matching: registry.blocksByName.enchanting_table.id, maxDistance: 4 })
    if (enchantTable) {
      const gearToEnchant = bot.inventory.items().find(i => 
        (i.name.includes('diamond_') && !i.enchantments.length)
      )

      if (gearToEnchant) {
        currentObjective = `Enchanting ${gearToEnchant.name}`
        say(`✨ Level 30 reached! Enchanting my ${gearToEnchant.name}...`)
        
        try {
          const table = await bot.openEnchantmentTable(enchantTable)
          const lapis = bot.inventory.findInventoryItem(registry.itemsByName.lapis_lazuli.id)
          
          await table.putTargetItem(gearToEnchant)
          await table.putLapis(lapis)
          
          // Wait for server to sync enchantment options
          await new Promise(r => {
            const readyHandler = () => {
              table.enchant(2).then(() => {
                table.close()
                r()
              })
            }
            table.once('ready', readyHandler)
          })
        } catch (e) {
          log("ENCHANT-ERR", e.message)
        }
      }
    }
  }

  // 14. Search for Ancient Debris (Nether Only)
  if (count('diamond_pickaxe') > 0) {
    currentObjective = "Nether Search"
    if (bot.game.dimension === 'the_nether') {
      const debris = bot.findBlock({ 
        matching: registry.blocksByName.ancient_debris.id, 
        maxDistance: 32 
      })
      if (debris) {
        say("🔥 Found Ancient Debris! Mining...")
        await mineBlock('ancient_debris')
      } else {
        say("⛏️ Searching for Ancient Debris at lower levels (Y=15)...")
        // The bot will naturally scan as it moves
      }
    } else if (count('obsidian') < 10 && count('diamond_pickaxe') > 0) {
       say("🌌 I have a Diamond Pickaxe. I should find Obsidian to reach the Nether.")
    }
  }

  // 15. Build Nether Portal
  if (count('obsidian') >= 10 && count('flint_and_steel') > 0 && bot.game.dimension === 'overworld') {
    currentObjective = "Building Nether Portal"
    await buildNetherPortal()
  }

  // 15.5 Auto Travel to Nether
  if (bot.game.dimension === 'overworld') {
    const portalBlock = bot.findBlock({
      matching: registry.blocksByName.nether_portal.id,
      maxDistance: 16
    })
    if (portalBlock) {
      currentObjective = "Entering the Nether"
      say("🌌 Nether Portal detected! Crossing dimensions...")
      await bot.pathfinder.goto(new goals.GoalBlock(portalBlock.position.x, portalBlock.position.y, portalBlock.position.z))
    }
  }

  // 16. Craft Brewing Stand
  if (count('blaze_rod') > 0 && count('brewing_stand') === 0 && !brewingStandBlock) {
    currentObjective = "Crafting Brewing Stand"
    const recipe = bot.recipesFor(registry.itemsByName.brewing_stand.id, null, 1, tableBlock)[0]
    if (recipe) {
      say("🧪 Crafting Brewing Stand...")
      await bot.craft(recipe, 1, tableBlock)
    }
  }

  // 17. Brewing Health Potions
  if ((brewingStandBlock || count('brewing_stand') > 0) && count('blaze_rod') > 0) {
    if (!brewingStandBlock) {
      const ref = bot.blockAt(bot.entity.position.offset(0, -1, 1))
      await bot.placeBlock(ref, new vec3(0, 1, 0))
    }

    // Ensure we have Blaze Powder for fuel
    if (count('blaze_powder') < 2) {
      const recipe = bot.recipesFor(registry.itemsByName.blaze_powder.id, null, 1, null)[0]
      if (recipe) await bot.craft(recipe, 1, null)
    }

    // Need awkward potion first (Nether Wart)
    if (count('nether_wart') > 0 && count('potion') > 0) {
      currentObjective = "Brewing Potions"
      try {
        const stand = await bot.openContainer(brewingStandBlock || bot.findBlock({ matching: registry.blocksByName.brewing_stand.id }))
        
        // Add Fuel
        if (!stand.fuel) {
          const fuel = bot.inventory.findInventoryItem(registry.itemsByName.blaze_powder.id)
          await stand.putFuel(fuel.type, null, 1)
        }

        // Add Water Bottles
        const waterBottle = bot.inventory.items().find(i => i.name === 'potion' && !i.nbt)
        if (waterBottle) await stand.putInput(waterBottle.type, null, 1, 0)

        // Add Ingredient (Wart -> then Melon)
        const ingredient = count('nether_wart') > 0 ? 'nether_wart' : 'glistering_melon_slice'
        const item = bot.inventory.findInventoryItem(registry.itemsByName[ingredient].id)
        
        if (item) {
          await stand.putIngredient(item.type, null, 1)
          say(`⚗️ Brewing with ${ingredient}...`)
          await new Promise(r => setTimeout(r, 20000)) // Wait for brew cycle
          stand.close()
        }
      } catch (e) { log("BREW-ERR", e.message) }
    }
  }

  // 17.5 Craft Eyes of Ender
  if (count('ender_pearl') > 0 && (count('blaze_powder') > 0 || count('blaze_rod') > 0) && count('eye_of_ender') < 12) {
    currentObjective = "Crafting Eyes of Ender"
    if (count('blaze_powder') === 0 && count('blaze_rod') > 0) {
      const powderRecipe = bot.recipesFor(registry.itemsByName.blaze_powder.id, null, 1, null)[0]
      if (powderRecipe) {
        say("🔥 Processing Blaze Rods into Powder...")
        await bot.craft(powderRecipe, 1, null)
      }
    }
    
    if (count('blaze_powder') > 0 && count('ender_pearl') > 0) {
      const eyeRecipe = bot.recipesFor(registry.itemsByName.eye_of_ender.id, null, 1, null)[0]
      if (eyeRecipe) {
        say("👁️ Fusing Ender Pearl and Blaze Powder: Crafting Eye of Ender...")
        await bot.craft(eyeRecipe, 1, null)
      }
    }
  }

  // 18. Find and Activate Stronghold
  if (count('eye_of_ender') >= 12) {
    currentObjective = "Locating Stronghold"
    const portalFrame = bot.findBlock({
      matching: registry.blocksByName.end_portal_frame.id,
      maxDistance: 64
    })

    if (portalFrame) {
      say("🏛️ End Portal Frame detected! Moving to activate...")
      try {
        await bot.pathfinder.goto(new goals.GoalLookAtBlock(portalFrame.position, bot.world))
        
        const frames = bot.findBlocks({
          matching: registry.blocksByName.end_portal_frame.id,
          maxDistance: 10,
          count: 12
        })

        for (const framePos of frames) {
          const frame = bot.blockAt(framePos)
          const eye = bot.inventory.findInventoryItem(registry.itemsByName.eye_of_ender.id)
          if (eye) {
            await bot.equip(eye, 'hand')
            await bot.activateBlock(frame)
          }
        }
        say("🌌 End Portal Active! Progression Complete.")
        progressionActive = false 
      } catch (e) { log("PORTAL-ERR", e.message) }
    } else if (bot.game.dimension === 'overworld') {
      say("🧭 I have enough eyes. Searching for a Stronghold portal nearby...")
    }
  }

  if (progressionActive) setTimeout(beatTheGame, 3000)
}

/* ================= AUTO FARMING ================= */
async function autoFarmWheat() {
  if (isFarming) return;
  const registry = bot.registry;
  const wheatBlock = bot.findBlock({
    matching: (block) => {
      return block.name === 'wheat' && block.metadata === 7; // metadata 7 is fully grown
    },
    maxDistance: 32
  });

  if (wheatBlock) {
    isFarming = true;
    currentObjective = "Farming Wheat";
    say("🌾 Food low: Harvesting grown wheat...");
    try {
      await bot.pathfinder.goto(new goals.GoalLookAtBlock(wheatBlock.position, bot.world));
      await bot.dig(wheatBlock);
      
      // Replant logic
      const seeds = bot.inventory.items().find(i => i.name === 'wheat_seeds');
      if (seeds) {
        const farmland = bot.blockAt(wheatBlock.position.offset(0, -1, 0));
        if (farmland && farmland.name === 'farmland') {
          await bot.equip(seeds, 'hand');
          await bot.placeBlock(farmland, new vec3(0, 1, 0));
        }
      }
    } catch (e) { log("FARM-ERR", e.message); }
    isFarming = false;
    // Continue farming if food is still low and more wheat is found
    if (bot.food < 15) setTimeout(autoFarmWheat, 1000);
  } else {
    say("⚠️ No fully grown wheat found to harvest.");
  }
}

/* ================= SAFE MODE ================= */
async function safeModeLoop() {
  if (!safeModeActive) return;

  const creeper = bot.nearestEntity(e => 
    e.name === 'creeper' && 
    e.position.distanceTo(bot.entity.position) < 8
  );

  if (creeper) {
    const hasShield = bot.inventory.slots[45]?.name === 'shield' || bot.heldItem?.name === 'shield';
    
    if (!hasShield) {
      currentObjective = "Avoiding Creeper";
      log("SAFE-MODE", "Creeper detected! Running away (No shield equipped).");
      
      // Calculate escape position (opposite direction of creeper)
      const dir = bot.entity.position.minus(creeper.position).normalize().scaled(5);
      const escapePos = bot.entity.position.plus(dir);
      
      try {
        await bot.pathfinder.goto(new goals.GoalBlock(escapePos.x, escapePos.y, escapePos.z));
      } catch (e) {}
    } else {
      log("SAFE-MODE", "Creeper detected, but I have a shield. Standing ground.");
    }
  }

  setTimeout(safeModeLoop, 500);
}

/* ================= AUTO-SORT ================= */
async function autoSortChest() {
  const chestBlock = bot.findBlock({ 
    matching: bot.registry.blocksByName.chest.id, 
    maxDistance: 5 
  })
  
  if (!chestBlock) return say("❌ No chest found nearby to sort!")

  try {
    const chest = await bot.openContainer(chestBlock)
    const items = chest.containerItems()
    
    if (items.length === 0) {
      chest.close()
      return say("📦 Chest is empty, nothing to sort.")
    }

    say("🗂️ Auto-Sorting: Organizing items by category...")

    const categories = {
      tools: ['pickaxe', 'sword', 'axe', 'shovel', 'hoe', 'shears', 'flint', 'bucket', 'shield', 'bow', 'crossbow'],
      food: ['cooked', 'apple', 'bread', 'stew', 'carrot', 'potato', 'berry', 'melon', 'pie', 'bottle'],
      resources: ['ingot', 'diamond', 'emerald', 'coal', 'lapis', 'raw_', 'scrap', 'debris', 'quartz', 'dust', 'shard'],
      blocks: ['stone', 'cobble', 'dirt', 'planks', 'log', 'netherrack', 'obsidian', 'sand', 'gravel', 'brick', 'glass', 'wool']
    }

    const sorted = { tools: [], food: [], resources: [], blocks: [], others: [] }
    
    // Categorize items
    for (const item of items) {
      let found = false
      for (const [key, keywords] of Object.entries(categories)) {
        if (keywords.some(k => item.name.includes(k))) {
          sorted[key].push({ type: item.type, count: item.count })
          found = true; break
        }
      }
      if (!found) sorted.others.push({ type: item.type, count: item.count })
    }

    const flatSorted = [...sorted.tools, ...sorted.food, ...sorted.resources, ...sorted.blocks, ...sorted.others]

    // Safe sort: Withdraw everything then deposit in order
    for (const item of items) {
      if (bot.inventory.emptySlotCount() < 1) break
      await chest.withdraw(item.type, null, item.count)
    }

    for (const item of flatSorted) {
      const invItem = bot.inventory.findInventoryItem(item.type)
      if (invItem) await chest.deposit(invItem.type, null, invItem.count)
    }

    chest.close()
    say("✅ Chest organized by category.")
  } catch (e) { log("SORT-ERR", e.message) }
}

/* ================= DEPOSIT ALL ================= */
async function depositAllItems() {
  const chestBlock = bot.findBlock({ 
    matching: bot.registry.blocksByName.chest.id, 
    maxDistance: 5 
  })
  
  if (!chestBlock) return say("❌ No chest found nearby to deposit items!")

  try {
    const chest = await bot.openContainer(chestBlock)
    const toolKeywords = ['pickaxe', 'sword', 'axe', 'shovel', 'hoe', 'shears', 'shield', 'bow', 'crossbow', 'flint', 'bucket']
    const foodKeywords = ['cooked', 'apple', 'bread', 'stew', 'carrot', 'potato', 'berry', 'melon', 'pie', 'bottle']

    say("🎒 Depositing all items except tools and food...")
    for (const item of bot.inventory.items()) {
      const isTool = toolKeywords.some(k => item.name.includes(k))
      const isFood = foodKeywords.some(k => item.name.includes(k))
      
      if (!isTool && !isFood) {
        await chest.deposit(item.type, null, item.count)
      }
    }
    chest.close()
    say("✅ Inventory cleared of non-essentials.")
  } catch (e) { log("DEPOSIT-ERR", e.message) }
}

/* ================= KILL AURA ================= */
async function killAuraLoop() {
  if (!killAuraActive) return;
  
  const hostiles = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'slime', 'husk', 'drowned', 'pillager'];
  const mob = bot.nearestEntity(e => 
    e.type === 'mob' && 
    hostiles.includes(e.name) && 
    e.position.distanceTo(bot.entity.position) < 4.5
  );

  if (mob) {
    const weapon = findBestItem('weapon');
    if (weapon) await bot.equip(weapon, 'hand');
    await bot.lookAt(mob.position.offset(0, 1.6, 0), true);
    bot.attack(mob);
  }
  setTimeout(killAuraLoop, 200);
}

/* ================= AUTO SLEEP ================= */
async function handleNightAndSleep() {
  const time = bot.time.timeOfDay;
  if (time < 13000 || time > 23000) return; // Not night

  const registry = bot.registry;
  const bed = bot.inventory.items().find(i => i.name.includes('_bed'));
  
  if (bed) {
    currentObjective = "Sleeping";
    say("🌙 Night detected. Placing bed to skip...");
    try {
      const bedPos = bot.entity.position.floored().offset(1, 0, 0);
      if (bot.blockAt(bedPos).name === 'air') {
        const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        await bot.equip(bed, 'hand');
        await bot.placeBlock(ref, new vec3(0, 1, 0));
        const bedBlock = bot.findBlock({ matching: b => b.name.includes('_bed'), maxDistance: 5 });
        if (bedBlock) {
          await bot.sleep(bedBlock);
          say("😴 Sleeping... See you in the morning!");
        }
      }
    } catch (e) { log("SLEEP-ERR", e.message); }
  } else {
    say("🧶 It's night and I have no bed. Hunting sheep...");
    await mineBlock('white_wool'); // This will trigger the find sheep logic if wool is missing
  }
}

/* ================= ARMOR CRAFTING ================= */
async function craftIronArmor() {
  const registry = bot.registry;
  const count = (name) => {
    const item = registry.itemsByName[name]
    return item ? bot.inventory.count(item.id) : 0
  }

  const totalIronAvailable = count('iron_ingot') + count('raw_iron');
  if (totalIronAvailable < 24) return say(`❌ Not enough iron! Need 24, have ${totalIronAvailable}.`);

  if (count('iron_ingot') < 24) {
    return say("🔥 I have enough raw iron, but it needs to be smelted first! Use :beat_game or place a furnace to start smelting.");
  }

  let tableBlock = bot.findBlock({ matching: registry.blocksByName.crafting_table.id, maxDistance: 5 });
  if (!tableBlock && count('crafting_table') > 0) {
    const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
    await bot.equip(tableItem, 'hand');
    const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    await bot.placeBlock(ref, new vec3(0, 1, 0));
    tableBlock = bot.findBlock({ matching: registry.blocksByName.crafting_table.id, maxDistance: 5 });
  }

  if (!tableBlock) return say("❌ I need a crafting table nearby to craft armor!");

  const armorPieces = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  for (const name of armorPieces) {
    if (count(name) > 0) continue;
    const recipe = bot.recipesFor(registry.itemsByName[name].id, null, 1, tableBlock)[0];
    if (recipe) {
      try { await bot.craft(recipe, 1, tableBlock); } catch (e) { log("CRAFT-ERR", e.message); }
    }
  }
  autoArmor();
  say("🛡️ Iron armor sequence complete. Gear equipped.");
}

/* ================= ROOF BUILDER ================= */
async function buildRoof(radius = 5) {
  if (!baseLocation) return say("❌ No base set. Use :sbase first.");
  const slab = bot.inventory.items().find(i => i.name.includes('slab'));
  if (!slab) return say("❌ I need slabs to build a roof!");

  const roofY = baseLocation.y + 3;
  say(`🏗️ Constructing roof at height ${Math.floor(roofY)}...`);

  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      const pos = new vec3(baseLocation.x + x, roofY, baseLocation.z + z);
      if (bot.blockAt(pos).name !== 'air') continue;

      const material = bot.inventory.items().find(i => i.name.includes('slab'));
      if (!material) {
        say("⚠️ Out of slabs! Roof build paused.");
        return;
      }

      try {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 4));
        // Find a neighbor to place against
        const neighbors = [new vec3(0,-1,0), new vec3(1,0,0), new vec3(-1,0,0), new vec3(0,0,1), new vec3(0,0,-1)];
        for (const d of neighbors) {
          const ref = bot.blockAt(pos.plus(d));
          if (ref && ref.name !== 'air') {
            await bot.equip(material, 'hand');
            await bot.placeBlock(ref, d.scaled(-1));
            break;
          }
        }
      } catch (e) {}
    }
  }
  say("✅ Roof construction complete.");
}

/* ================= LUMBERJACK PROTOCOL ================= */
async function lumberjackLoop(radius = 20) {
  if (!lumberjackActive) return;

  const logBlocks = bot.registry.blocksArray
    .filter(b => b.name.includes('_log'))
    .map(b => b.id);

  const tree = bot.findBlock({
    matching: logBlocks,
    maxDistance: radius
  });

  if (tree) {
    currentObjective = "Chopping trees";
    try {
      await bot.pathfinder.goto(new goals.GoalLookAtBlock(tree.position, bot.world));
      const axe = bot.inventory.items().find(i => i.name.includes('_axe'));
      if (axe) await bot.equip(axe, 'hand');
      
      // Chop the whole trunk upward
      let currentLog = tree;
      while (currentLog && currentLog.name.includes('_log')) {
        await bot.dig(currentLog);
        currentLog = bot.blockAt(currentLog.position.offset(0, 1, 0));
      }
    } catch (e) { log("LUMBER-ERR", e.message); }
    setTimeout(() => lumberjackLoop(radius), 500);
  } else {
    say("🌲 Area cleared of trees.");
    lumberjackActive = false;
  }
}

/* ================= MINER LOGIC ================= */
async function minerLoop(direction, length, current) {
  if (!minerActive || current >= length) {
    minerActive = false;
    return say(`✅ Tunneling complete. Dug ${current} blocks.`);
  }

  const offsets = {
    north: { x: 0, z: -1 }, south: { x: 0, z: 1 },
    east: { x: 1, z: 0 }, west: { x: -1, z: 0 }
  };
  const off = offsets[direction];
  if (!off) return say("❌ Invalid direction for miner.");
  
  try {
    const b1 = bot.blockAt(bot.entity.position.offset(off.x, 0, off.z));
    const b2 = bot.blockAt(bot.entity.position.offset(off.x, 1, off.z));

    if (b1 && b1.name !== 'air') await bot.dig(b1);
    if (b2 && b2.name !== 'air') await bot.dig(b2);

    const goal = new goals.GoalBlock(bot.entity.position.x + off.x, bot.entity.position.y, bot.entity.position.z + off.z);
    await bot.pathfinder.goto(goal);
    
    setTimeout(() => minerLoop(direction, length, current + 1), 500);
  } catch (e) {
    log("MINER-ERR", e.message);
    minerActive = false;
  }
}

async function buildNetherPortal() {
  const obsidianId = bot.registry.itemsByName.obsidian.id
  const flintId = bot.registry.itemsByName.flint_and_steel.id

  const startPos = bot.entity.position.floored().offset(2, 0, 0)
  say(`🏗️ Building Nether Portal at ${startPos.x}, ${startPos.y}, ${startPos.z}`)

  const frameOffsets = [
    [1, 0, 0], [2, 0, 0], // Bottom
    [0, 1, 0], [0, 2, 0], [0, 3, 0], // Left
    [3, 1, 0], [3, 2, 0], [3, 3, 0], // Right
    [1, 4, 0], [2, 4, 0]  // Top
  ]

  for (const offset of frameOffsets) {
    const p = startPos.offset(...offset)
    if (bot.blockAt(p).name === 'obsidian') continue
    
    await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 4))
    const item = bot.inventory.findInventoryItem(obsidianId)
    if (!item) return
    await bot.equip(item, 'hand')
    
    const neighbors = [ [0,-1,0], [0,1,0], [1,0,0], [-1,0,0], [0,0,1], [0,0,-1] ]
    for (const n of neighbors) {
        const ref = bot.blockAt(p.offset(...n))
        if (ref && ref.name !== 'air') {
            try { await bot.placeBlock(ref, new vec3(...n).scaled(-1)); break } catch(e) {}
        }
    }
  }

  const flint = bot.inventory.findInventoryItem(flintId)
  const portalInside = startPos.offset(1, 1, 0)
  if (flint && bot.blockAt(portalInside).name === 'air') {
    await bot.equip(flint, 'hand')
    await bot.lookAt(portalInside, true)
    await bot.activateBlock(bot.blockAt(portalInside.offset(0, -1, 0)))
  }
}

function askForHelp(material) {
  helpObjective = material
  waitingForHelp = true
  progressionActive = false
  say(`❌ I can't find ${material}, can you help me? Say "yes" to make me follow you, or "no" to make me stay still!`)
}

/* ================= MATERIAL GATHERING ================= */
async function collectMaterials() {
  say("⛏️ Out of building blocks! Gathering dirt/cobblestone...");
  const targetBlocks = bot.registry.blocksArray
    .filter(b => ['dirt', 'cobblestone', 'netherrack', 'deepslate', 'grass_block'].includes(b.name))
    .map(b => b.id);
  
  for (let i = 0; i < 32; i++) {
    const block = bot.findBlock({ matching: targetBlocks, maxDistance: 32 });
    if (block) {
      try {
        await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world));
        await equipToolForBlock(block);
        await bot.dig(block);
      } catch (e) { log("GATHER-ERR", e.message); }
    }
  }
  say("✅ Materials collected. Resuming build.");
}

/* ================= EAT LOGIC ================= */
async function forceEat() {
  const foodItems = ['cooked_beef', 'cooked_porkchop', 'golden_apple', 'bread', 'apple', 'cooked_chicken', 'cooked_mutton', 'cooked_salmon', 'cooked_cod'];
  const inventory = bot.inventory.items();
  const food = foodItems.map(name => inventory.find(item => item.name === name)).find(Boolean);
  if (food) {
    try {
      roaming = false; following = false; progressionActive = false;
      await bot.equip(food, 'hand');
      await bot.consume();
      say(`🍴 Yum! Eating ${food.name}`);
      return true;
    } catch (e) { log("EAT-ERR", e.message); }
  } else {
    say("❌ I have no food to eat!");
  }
}

/* ================= BUILDING LOGIC ================= */
async function placeBlockAt(pos) {
  if (bot.blockAt(pos).name !== 'air') return;
  
  let material = bot.inventory.items().find(i => 
    ['cobblestone', 'dirt', 'oak_planks', 'stone', 'netherrack', 'planks'].some(m => i.name.includes(m))
  );

  if (!material) {
    await collectMaterials();
    material = bot.inventory.items().find(i => 
      ['cobblestone', 'dirt', 'oak_planks', 'stone', 'netherrack', 'planks'].some(m => i.name.includes(m))
    );
    if (!material) throw new Error("Out of materials");
  }

  const neighbors = [
    new vec3(0, -1, 0), new vec3(0, 1, 0),
    new vec3(1, 0, 0), new vec3(-1, 0, 0),
    new vec3(0, 0, 1), new vec3(0, 0, -1)
  ];
  
  for (const d of neighbors) {
    const ref = bot.blockAt(pos.plus(d));
    if (ref && ref.name !== 'air' && ref.name !== 'water' && ref.name !== 'lava') {
      try {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 4));
        await bot.equip(material, 'hand');
        await bot.lookAt(ref.position);
        await bot.placeBlock(ref, d.scaled(-1));
        return;
      } catch (e) {}
    }
  }
}

async function buildStructure(payload) {
  const type = typeof payload === 'string' ? payload : payload.type;
  const customData = payload.data || null;
  const start = bot.entity.position.floored().offset(1, 0, 1);
  let blocks = [];
  if (type === 'shelter') {
    for (let y = -1; y <= 1; y++) {
      for (let x = 0; x < 3; x++) {
        for (let z = 0; z < 3; z++) {
          if (y === -1 || y === 1 || x === 0 || x === 2 || z === 0 || z === 2) {
            if (!(y === 0 && x === 1 && z === 0)) blocks.push(start.offset(x, y, z));
          }
        }
      }
    }
  } else if (type === 'house') {
    for (let x = 0; x < 5; x++) {
      for (let z = 0; z < 5; z++) {
        blocks.push(start.offset(x, -1, z));
        for (let y = 0; y < 3; y++) {
          if (x === 0 || x === 4 || z === 0 || z === 4) {
            if (!(x === 2 && z === 0 && y < 2)) blocks.push(start.offset(x, y, z));
          }
        }
        blocks.push(start.offset(x, 3, z));
      }
    }
  } else if (type === 'schematic' && Array.isArray(customData)) {
    const origin = bot.entity.position.floored();
    blocks = customData.map(b => origin.offset(b.x, b.y, b.z));
    say(`🏗️ Starting custom schematic build (${customData.length} blocks)...`);
  }
  say(`🏗️ Building ${type}...`);
  try {
    for (const p of blocks) await placeBlockAt(p);
    say(`✅ Build complete: ${type}`);
  } catch (e) { say("❌ Build stopped: Out of blocks."); }
}

async function mineBlock(name) {
  const blockType = bot.registry.blocksByName[name]
  if (!blockType) return
  
  const block = bot.findBlock({ matching: blockType.id, maxDistance: 32 })
  if (!block) return
  
  if (!movements) {
    mcData = mcDataLoader(bot.version) || mcDataLoader(MC_VERSION)
    movements = new Movements(bot, mcData)
  }

  try {
    // Temporarily allow digging for progression
    const oldDig = movements.canDig
    movements.canDig = true
    await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world))
    await equipToolForBlock(block);
    await bot.dig(block)
    movements.canDig = oldDig
  } catch (e) { log("MINE-ERR", e.message) }
}

/* ================= BASE & DEPOSIT LOGIC ================= */
async function depositItems() {
  if (!baseLocation || isDepositing) return
  
  // Check if inventory is full (less than 2 slots left)
  if (bot.inventory.emptySlotCount() < 2) {
    isDepositing = true
    const wasProgressionActive = progressionActive
    progressionActive = false
    
    say("🎒 Inventory full! Returning to base to store items.")
    await bot.pathfinder.goto(new goals.GoalBlock(baseLocation.x, baseLocation.y, baseLocation.z))
    
    const chestBlock = bot.findBlock({ matching: bot.registry.blocksByName.chest.id, maxDistance: 5 })
    if (chestBlock) {
      const chest = await bot.openContainer(chestBlock)
      const essential = ['pickaxe', 'sword', 'axe', 'food', 'table', 'furnace', 'bucket']
      for (const item of bot.inventory.items()) {
        if (!essential.some(name => item.name.includes(name))) {
          await chest.deposit(item.type, null, item.count)
        }
      }
      chest.close()
      say("📥 Items deposited. Resuming activities.")
    } else { say("⚠️ Base reached but no chest found!") }
    
    isDepositing = false
    progressionActive = wasProgressionActive
  }
}

/* ================= SAFETY LOGIC ================= */
async function handleWaterSafety() {
  if (isHandlingSafety || isDepositing) return
  const waterBucket = bot.inventory.findInventoryItem(bot.registry.itemsByName.water_bucket.id)
  if (!waterBucket) return

  // 1. MLG Logic (Safe descent from high cliffs)
  if (bot.entity.velocity.y < -0.6 && !bot.entity.onGround) {
    isHandlingSafety = true
    try {
      await bot.equip(waterBucket, 'hand')
      await bot.lookAt(bot.entity.position.offset(0, -2, 0), true)
      bot.activateItem()
      await new Promise(r => setTimeout(r, 800))
      // Try to pick water back up
      const emptyBucket = bot.inventory.findInventoryItem(bot.registry.itemsByName.bucket.id)
      if (emptyBucket) {
        await bot.equip(emptyBucket, 'hand')
        bot.activateItem()
      }
    } catch (e) {} finally { isHandlingSafety = false }
  }

  // 2. Lava Safety (Turn lava into obsidian/cobblestone to cross)
  const lava = bot.findBlock({ matching: bot.registry.blocksByName.lava.id, maxDistance: 3 })
  if (lava && !progressionActive) {
    isHandlingSafety = true
    try {
      await bot.equip(waterBucket, 'hand')
      await bot.lookAt(lava.position, true)
      bot.activateItem()
      setTimeout(() => bot.activateItem(), 1000) // Pick it back up
    } catch (e) {} finally { isHandlingSafety = false }
  }
}

/* ================= ITEM SELECTION HELPERS ================= */
// Helper to find the best item of a given category (e.g., 'weapon', 'shield')
function findBestItem(category) {
  const items = bot.inventory.items();
  let bestItem = null;
  let bestTier = -1; // Higher is better

  const weaponTiers = {
    // Swords
    netherite_sword: 5,
    diamond_sword: 4,
    iron_sword: 3,
    golden_sword: 2,
    stone_sword: 1,
    wooden_sword: 0,
    // Axes (can be used as weapons in a pinch)
    netherite_axe: 4.5, // Slightly less preferred than sword for pure damage, but still good
    diamond_axe: 3.5,
    iron_axe: 2.5,
    golden_axe: 1.5,
    stone_axe: 0.5,
    wooden_axe: 0,
  };

  for (const item of items) {
    const itemName = item.name;

    if (category === 'weapon') {
      const itemTier = weaponTiers[itemName];
      if (itemTier !== undefined && itemTier > bestTier) {
        bestTier = itemTier;
        bestItem = item;
      }
    } else if (category === 'shield' && itemName === 'shield') {
      return item; // Found a shield, return it immediately
    }
  }
  return bestItem;
}

/* ================= AUTO ARMOR ================= */
function autoArmor() {
  if (!autoArmorEnabled || !bot.inventory) return
  const registry = bot.registry
  const armorSlots = {
    head: [registry.itemsByName.diamond_helmet?.id, registry.itemsByName.iron_helmet?.id, registry.itemsByName.golden_helmet?.id, registry.itemsByName.chainmail_helmet?.id, registry.itemsByName.leather_helmet?.id],
    torso: [registry.itemsByName.diamond_chestplate?.id, registry.itemsByName.iron_chestplate?.id, registry.itemsByName.golden_chestplate?.id, registry.itemsByName.chainmail_chestplate?.id, registry.itemsByName.leather_chestplate?.id],
    legs: [registry.itemsByName.diamond_leggings?.id, registry.itemsByName.iron_leggings?.id, registry.itemsByName.golden_leggings?.id, registry.itemsByName.chainmail_leggings?.id, registry.itemsByName.leather_leggings?.id],
    feet: [registry.itemsByName.diamond_boots?.id, registry.itemsByName.iron_boots?.id, registry.itemsByName.golden_boots?.id, registry.itemsByName.chainmail_boots?.id, registry.itemsByName.leather_boots?.id]
  }

  for (const [slot, ids] of Object.entries(armorSlots)) {
    const items = bot.inventory.items().filter(i => ids.includes(i.type))
    if (items.length === 0) continue
    
    // Sort by "bestness" (Diamond > Iron > Gold > Chain > Leather)
    items.sort((a, b) => ids.indexOf(a.type) - ids.indexOf(b.type))
    const best = items[0]
    
    const current = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]
    if (!current || current.type !== best.type) {
      bot.equip(best, slot).catch(() => {})
    }
  }
}

/* ================= SPAWN / AUTH ================= */
bot.on("resourcePack", () => {
  // minecraft-protocol auto-accepts configuration packs after this synchronous
  // event; do not send a second status packet during the handshake.
  if (bot._client?.state !== "play") return
  const packClient = bot._client
  setImmediate(() => {
    if (packClient !== client?._client || packClient.state !== "play") return
    try {
      bot.acceptResourcePack()
      log("RESOURCE-PACK", "Accepted server resource pack")
    } catch (error) {
      log("RESOURCE-PACK-ERR", `Failed to accept server resource pack: ${error.message}`)
    }
  })
})

bot.once("spawn", () => {
  log("SPAWN", "Bot online")
  isOnline = true
  reconnectAttempt = 0
  state.status = "Online"
  statusEvent = "spawn"
  statusReason = null
  statusError = null
  retryAt = null
  emitBotStatus()
  // Send real, tiny look updates without moving or fabricating protocol packets.
  let lookDirection = 1
  const nudgeLook = () => {
    if (!isOnline || !bot.entity) return
    bot.look(bot.entity.yaw + lookDirection * Math.PI / 90, bot.entity.pitch, true)
      .catch(error => log("LOOK-ERR", `Spawn look update failed: ${error.message}`))
    lookDirection *= -1
  }
  clearInterval(spawnLookInterval)
  nudgeLook()
  spawnLookInterval = setInterval(nudgeLook, 15000)
  say("🤖 Airi online | :help")

  // Initialize data once on spawn
  mcData = mcDataLoader(bot.version) || mcDataLoader(MC_VERSION)
  movements = new Movements(bot, mcData)

  // Projectile Defense Logic
  bot.on('physicsTick', () => {
    handleWaterSafety()
    if (isHandlingSafety) return

    const projectile = bot.nearestEntity((e) => e.type === 'projectile' && e.position.distanceTo(bot.entity.position) < 8)
    if (projectile) {
      const shield = findBestItem('shield')
      if (shield && !isShielding) {
        bot.equip(shield, 'off-hand').then(() => { bot.activateItem(true); isShielding = true }).catch(() => {})
      }
    } else if (isShielding) {
      bot.deactivateItem()
      isShielding = false
    }
  })

  // Pathfinding visualizer support
  bot.on('path_update', (r) => {
    state.currentPath = r.path.map(p => ({ x: p.x, y: p.y, z: p.z }));
    io.emit("path_update", state.currentPath);
  });

  bot.on('goal_reached', () => {
    state.currentPath = [];
    io.emit("path_update", []);
  });

  // Smarter pathfinding defaults
  movements.canDig = true // Enabled: Allow breaking blocks to reach goals
  movements.allowBridging = true // Enabled: Allow placing blocks to cross gaps
  movements.allowParkour = true // Allow jumping over gaps for better chasing
  movements.allowSprinting = true
  movements.climbMax = 1
  bot.pathfinder.setMovements(movements)

  bot.on('playerCollect', () => setTimeout(autoArmor, 500))
  // Initial check
  setTimeout(autoArmor, 2000)

  // Monitor food levels for auto-farming
  bot.on('health', () => { if (bot.food < 10) autoFarmWheat(); });

  // Periodic status updates to Dashboard
  clearInterval(dashboardInterval)
  dashboardInterval = setInterval(() => {
    if (bot.entity) {
      depositItems()

      const botData = {
        health: bot.health,
        food: bot.food,
        pos: bot.entity.position
      };
      
      // Map full inventory grid (slots 0-45) for the website
      const inventory = bot.inventory.slots.map((item, index) => {
        if (!item) return { slot: index, name: 'air', count: 0, displayName: 'Empty' };
        return {
          slot: index,
          name: item.name,
          displayName: item.displayName,
          count: item.count
        };
      });

      const equipment = {
        head: bot.inventory.slots[5]?.displayName || 'Empty',
        chest: bot.inventory.slots[6]?.displayName || 'Empty',
        legs: bot.inventory.slots[7]?.displayName || 'Empty',
        feet: bot.inventory.slots[8]?.displayName || 'Empty',
        hand: bot.heldItem?.displayName || 'Empty',
        offhand: bot.inventory.slots[45]?.displayName || 'Empty'
      };

      state.admins = Object.keys(adminSessions).filter(u => adminSessions[u]);
      state.users = Object.keys(bot.players);

      // Generate surroundings map data
      const mapRadius = 15;
      const mapBlocks = [];
      for (let x = -mapRadius; x <= mapRadius; x++) {
        for (let z = -mapRadius; z <= mapRadius; z++) {
          // Check both floor and ground for better map depth
          const b = bot.blockAt(bot.entity.position.offset(x, -1, z)) || bot.blockAt(bot.entity.position.offset(x, -2, z));
          if (b && b.name !== 'air') {
            mapBlocks.push({ x, z, name: b.name });
          }
        }
      }

      const entities = Object.values(bot.entities)
        .filter(e => e !== bot.entity && e.position.distanceTo(bot.entity.position) < mapRadius)
        .map(e => ({
          x: e.position.x - bot.entity.position.x,
          z: e.position.z - bot.entity.position.z,
          name: e.username || e.displayName || e.name,
          isPlayer: e.type === 'player'
        }));

      const mapData = { blocks: mapBlocks, entities };
      
      // Sync local state for API consistency
      state.botData = botData;
      state.inventory = inventory;
      state.equipment = equipment;
      state.mapData = mapData;

      // Consolidate into one efficient emit
      io.emit("bulk_update", { ...state, botData, inventory, equipment, mapData });
    }
  }, 500)
})

/* ================= AUTO RESPAWN ================= */
bot.on("death", () => {
  log("DEATH", "Respawning...")
  setTimeout(() => bot.emit("respawn"), 1000)
})

/* ================= MESSAGE HANDLER ================= */
bot.on("message", async (msg) => {
  const raw = msg.toString()
  // Log is now handled by the utility which emits to socket
  log("SERVER", raw)

  const parsed = parse(raw)
  if (!parsed) return

  const { user, msg: content, type } = parsed
  const isAdmin = adminSessions[user] === true

  /* ===== ADMIN LOGIN via PM only ===== */
  if (waitingForHelp) {
    if (content.toLowerCase() === 'yes') {
      waitingForHelp = false
      following = true
      followTarget = user
      say(`🤝 Okay! Leading the way to ${helpObjective}.`)
      return followLoop()
    } else if (content.toLowerCase() === 'no') {
      waitingForHelp = false
      bot.pathfinder.setGoal(null)
      say("🤷 Okay, I will wait here until I am needed or attacked.")
      return
    }
  }

  if (type === "pm" && content.startsWith(ADMIN_PREFIX)) {
    const args = content.slice(1).split(" ")
    if (args[0] === "loginadmin" && args.slice(1).join(" ") === ADMIN_PASSWORD) {
      adminSessions[user] = true
      pm(user, "✅ Admin login successful")
      log("ADMIN", `${user} logged in`)
    }
    return
  }

  // Only process commands
  const isPublic = content.startsWith(PREFIX);
  const isAdminCmd = content.startsWith(ADMIN_PREFIX);
  
  if (!isPublic && !isAdminCmd) return;

  const args = content.slice(1).split(" ");
  const cmd = args.shift().toLowerCase();

  /* ===== PUBLIC COMMANDS ===== */
  if (content.startsWith(PREFIX)) {
    switch (cmd) {
      case "ping": return say("pong 🏓")
      case "status": return say(getStatusReport())
      case "test": return say("✅ Bot is active and connected.")
      case "miner": {
        progressionActive = false;
        const dir = args[0];
        const len = parseInt(args[1]) || 10;
        if (!['north', 'south', 'east', 'west'].includes(dir)) return say("❌ Usage: :miner <north|south|east|west> [length]");
        minerActive = true;
        say(`⛏️ Starting ${len} block tunnel to the ${dir}...`);
        return minerLoop(dir, len, 0);
      }
      case "coords": 
        const { x, y, z } = bot.entity.position
        return say(`📍 Current Location: X: ${Math.floor(x)}, Y: ${Math.floor(y)}, Z: ${Math.floor(z)}`)
      case "sbase":
        if (args.length >= 3) {
          baseLocation = { x: parseFloat(args[0]), y: parseFloat(args[1]), z: parseFloat(args[2]) }
        } else {
          const p = bot.entity.position
          baseLocation = { x: p.x, y: p.y, z: p.z }
        }
        return say(`🏠 Base location set to X: ${Math.floor(baseLocation.x)}, Y: ${Math.floor(baseLocation.y)}, Z: ${Math.floor(baseLocation.z)}`)
      case "home":
        if (!baseLocation) return say("❌ No base location set. Use :sbase first.")
        progressionActive = false
        roaming = false
        following = false
        pvpTarget = null
        bot.pathfinder.setGoal(null)
        bot.pathfinder.setGoal(new goals.GoalBlock(baseLocation.x, baseLocation.y, baseLocation.z))
        return say("🏃 Heading home to base location.")
      case "basechest":
        if (!baseLocation) return say("❌ No base location set. Use :sbase first.")
        progressionActive = false
        roaming = false
        following = false
        say("🔍 Navigating to base to inspect chest...")
        await bot.pathfinder.goto(new goals.GoalBlock(baseLocation.x, baseLocation.y, baseLocation.z))
        const chestBlock = bot.findBlock({ matching: bot.registry.blocksByName.chest.id, maxDistance: 5 })
        if (chestBlock) {
          const chest = await bot.openContainer(chestBlock)
          const items = chest.items()
          if (items.length === 0) {
            say("📦 The base chest is currently empty.")
          } else {
            const itemList = items.map(i => `${i.count}x ${i.name}`).join(", ")
            say(`📦 Base Chest contains: ${itemList}`)
          }
          chest.close()
        } else say("❌ No chest found at base coordinates.")
        return
      case "rescue":
        // Find the nearest player who is hurt (health is less than max 20)
        const rescueTarget = bot.nearestEntity((e) => e.type === 'player' && e.health < 20)
        if (!rescueTarget) return say("🆘 No injured players found nearby.")
        
        progressionActive = false
        roaming = false
        following = false
        say(`🚁 Search and Rescue: Moving to provide aid to ${rescueTarget.username}!`)
        
        await bot.pathfinder.goto(new goals.GoalFollow(rescueTarget, 2))
        
        const foodItems = ['apple', 'bread', 'steak', 'cooked_beef', 'cooked_chicken', 'cooked_porkchop', 'golden_apple']
        const availableFood = bot.inventory.items().find(i => foodItems.includes(i.name))
        
        if (availableFood) {
          await bot.equip(availableFood, 'hand')
          await bot.tossStack(availableFood)
          say(`🍖 I brought you some food, ${rescueTarget.username}! Stay alive.`)
        } else {
          say("❌ Rescue mission failed: I reached the target but have no food in my backpack!")
        }
        return
      case "medic":
        const targetName = args[0]
        const mTarget = bot.players[targetName]?.entity
        if (!mTarget) return say("🚑 Medic: Player not found in range.")
        
        progressionActive = false
        roaming = false
        following = false
        medicMode = true
        medicTarget = targetName
        
        say(`🚑 Medic protocol active. Protecting ${targetName}.`)
        return medicLoop()
      case "refuel":
        refuel();
        return;
      case "sort":
        autoSortChest()
        return;
      case "deposit":
        depositAllItems()
        return;
      case "sminebase":
        const p = bot.entity.position;
        miningBaseLocation = { x: p.x, y: p.y, z: p.z };
        return say(`⛏️ Mining base set to X: ${Math.floor(p.x)}, Y: ${Math.floor(p.y)}, Z: ${Math.floor(p.z)}`);
      case "minebase":
        if (!miningBaseLocation) return say("❌ No mining base set. Use :sminebase first.");
        progressionActive = false; roaming = false; following = false;
        bot.pathfinder.setGoal(new goals.GoalBlock(miningBaseLocation.x, miningBaseLocation.y, miningBaseLocation.z));
        return say("🏃 Heading to mining operations base.");
      case "roof":
        buildRoof(parseInt(args[0]) || 5);
        return;
      case "lumberjack":
        lumberjackActive = !lumberjackActive;
        if (lumberjackActive) lumberjackLoop(parseInt(args[0]) || 20);
        return say(lumberjackActive ? "🌲 Lumberjack Protocol: Engaged" : "🌲 Lumberjack Protocol: Disengaged");
      case "roam":
        if (!isAdmin) return pm(user, "❌ Access Denied.");
        roaming = true; roam();
        return say("🚶 Roaming protocol active");
      case "stop":
        roaming = false; following = false; pvpTarget = null; progressionActive = false; minerActive = false; lumberjackActive = false;
        bot.pathfinder.setGoal(null);
        return say("⛔ All operations halted.");
      case "follow":
        if (!isAdmin) return pm(user, "❌ Access Denied.");
        const target = args[0] || user;
        following = true; followTarget = target; followLoop();
        return say(`👣 Following ${target}`);
      case "unfollow":
        following = false; followTarget = null;
        bot.pathfinder.setGoal(null);
        return say("🛑 Stopped following.");
      case "help": return say("Public: :ping, :status, :coords, :home, :sminebase, :minebase, :roof, :lumberjack, :rescue, :medic, :sort, :deposit | Admin: :follow, :roam, :stop, :guard, :pvp, $mine, $stealth, $panic")
      case "chat": {
        const msgContent = args.join(" ")
        if (!msgContent) return pm(user, "❌ Usage: :chat <msg>")
        try {
          const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: msgContent }]
          })
          const reply = response.choices[0].message.content
          say(reply)
        } catch {
          pm(user, "❌ AI Error")
        }
        return
      }
      case "roam": case "stop": case "follow": case "unfollow":
      case "guard": case "pvp": case "stoppvp": case "servercmd":
        if (!isAdmin) {
          pm(user, "❌ Access Denied. Please request xXdariavXx (Owner) to add you to users.json or ask for admin password.")
          return
        }
        break // allow execution below
    }
  }

  /* ===== ADMIN COMMANDS ===== */
  if (isAdmin) {
    switch (cmd) {
      case "servercmd":
        bot.chat("/" + args.join(" "))
        return
      case "mine":
        if (args[0]) mineBlock(args[0])
        return
      case "panic":
        activatePanicMode();
        return;
      case "stealth":
        stealthMode = !stealthMode
        bot.setControlState('sneak', stealthMode)
        say(stealthMode ? "👻 Stealth Mode Engaged" : "👁️ Stealth Mode Disengaged")
        return
      case "dstop":
        pvpTarget = null
        bot.pathfinder.setGoal(null)
        bot.setControlState('sprint', false)
        return say("🛑 Auto-defense halted and target cleared.")
      case "guard":
        say("🛡️ Guarding current location")
        return guardLoop()
      case "pvp": {
        const t = args[0]
        const p = bot.players[t]?.entity
        if (!p) return pm(user, "player not found")
        pvpTarget = t
        say(`⚔️ PVP engaged vs ${t}`)
        return pvpLoop();
      }
      case "stoppvp":
        pvpTarget = null
        bot.pathfinder.setGoal(null)
        return say("🛑 PVP stopped")
    }
  }
})

/* ================= HELPER FUNCTIONS ================= */
async function activatePanicMode() {
  log("PANIC", "Activating Panic Mode!");
  say("🚨 Panic Mode activated! Seeking safety!");

  roaming = false;
  following = false;
  pvpTarget = null;
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();

  const shield = findBestItem('shield');
  if (shield) await bot.equip(shield, 'off-hand');

  const gap = bot.inventory.items().find(i => i.name === 'golden_apple');
  if (gap) await bot.consume(gap);

  if (baseLocation) {
    bot.pathfinder.setGoal(new goals.GoalBlock(baseLocation.x, baseLocation.y, baseLocation.z));
  }
}

function medicLoop() {
  if (!medicMode || !medicTarget) return;
  const target = bot.players[medicTarget]?.entity;
  if (!target) return;

  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  setTimeout(medicLoop, 1000);
}

/* ================= WEB CONTROL ================= */
io.on("connection", (socket) => {
  log("WEB", "Dashboard session established")
  socket.emit("bot_status", getBotStatus())
  socket.emit("state", state);
  socket.emit("bulk_update", state)

  // Missing listeners for Web-to-Bot interactions
  socket.on("mine_block", async (data) => {
    const { x, y, z } = data;
    const block = bot.blockAt(new vec3(x, y, z));
    if (block) {
      log("WEB-MINE", `Mining ${block.name} at ${x}, ${y}, ${z}`);
      mineBlock(block.name);
    }
  });

  socket.on("place_block", async (data) => {
    const { x, y, z } = data;
    log("WEB-PLACE", `Placing block at ${x}, ${y}, ${z}`);
    placeBlockAt(new vec3(x, y, z));
  });

  socket.on("set_hotbar", (slot) => {
    if (slot >= 0 && slot <= 8) bot.setQuickBarSlot(slot);
  });

  // Drop entire inventory
  socket.on("drop_all", async () => {
    log("WEB", "Dropping entire inventory...");
    const items = bot.inventory.items();
    if (items.length === 0) return say("⚠️ My inventory is already empty!");
    
    for (const item of items) {
      try {
        await bot.tossStack(item);
      } catch (err) {
        log("DROP-ERR", `Failed to drop ${item.name}: ${err.message}`);
      }
    }
    say("🗑️ Dashboard triggered: Dropped entire inventory.");
  });

  // Move items between slots (Interactive Inventory)
  socket.on("move_item", async (data) => {
    const { from, to } = data;
    log("WEB", `Moving item from slot ${from} to ${to}`);
    try {
      await bot.simpleClick.leftMouse(from);
      await bot.simpleClick.leftMouse(to);
    } catch (err) { log("MOVE-ERR", err.message); }
  });

  // Safe Mode toggle from Website
  socket.on("toggle_safemode", (enabled) => {
    safeModeActive = enabled;
    log("WEB", `Safe Mode ${enabled ? 'Enabled' : 'Disabled'}`);
    if (safeModeActive) safeModeLoop();
  });

  socket.on("start_farming", () => {
    autoFarmWheat();
  });

  // Kill Aura toggle from Website
  socket.on("toggle_killaura", (enabled) => {
    killAuraActive = enabled;
    log("WEB", `Kill Aura ${enabled ? 'Enabled' : 'Disabled'}`);
    if (killAuraActive) killAuraLoop();
  });

  // Craft Iron Armor Set via Web Dashboard
  socket.on("craft_armor", async (data) => {
    log("WEB", `Dashboard request: Crafting ${data.type || 'iron'} armor`);
    if (!data.type || data.type === 'iron') await craftIronArmor();
  });

  // Handler for saving favorite locations
  socket.on("save_location", (data) => {
    const { name, pos } = data;
    if (!name) return;
    // Use provided pos or current bot position
    state.favorites[name] = pos || (bot.entity ? { ...bot.entity.position } : null);
    if (!state.favorites[name]) return;
    log("WEB", `Saved favorite location: ${name}`);
    io.emit("bulk_update", state);
  });

  socket.on("send_command", (data) => {
    const { command, args } = data
    log("WEB-CMD", `Executing: ${command} ${args || ""}`)
    if (!isOnline || !bot.entity) {
      log("WEB", `Ignored "${command}" because the bot is offline.`)
      return
    }
    
    switch(command) {
      case "stop":
        roaming = false; following = false; pvpTarget = null;
        bot.pathfinder.setGoal(null);
        say("⛔ Movement halted via dashboard");
        break;
      case "roam":
        roaming = true; roam();
        say("🚶 Roaming protocol active");
        break;
      case "guard":
        guardLoop();
        say("🛡️ Static guard initiated");
        break;
      case "follow":
        if (args) { following = true; followTarget = args; followLoop(); }
        break;
      case "goto":
        let target = args;
        if (typeof args === 'string') {
          const p = args.split(/[ ,]+/);
          target = { x: parseFloat(p[0]), y: parseFloat(p[1]), z: parseFloat(p[2]) };
        }
        if (target && !isNaN(target.x) && !isNaN(target.y) && !isNaN(target.z)) {
          roaming = false; following = false; progressionActive = false; medicMode = false;
          mcData = mcDataLoader(bot.version) || mcDataLoader(MC_VERSION);
          movements = new Movements(bot, mcData);
          const goal = new goals.GoalBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
          bot.pathfinder.setMovements(movements);
          bot.pathfinder.setGoal(goal);
          say(`📍 Dashboard: Heading to ${Math.floor(target.x)}, ${Math.floor(target.y)}, ${Math.floor(target.z)}`);
        }
        break;
      case "pvp":
        if (args) { pvpTarget = args; pvpLoop(); }
        break;
      case "servercmd":
        // Allow the web dashboard to send both commands and plain chat
        if (args) bot.chat(args);
        break;
      case "set_control":
        bot.setControlState(data.control, data.state);
        break;
      case "look_at_nearest":
        const nearest = bot.nearestEntity(e => e.type === 'player');
        if (nearest) bot.lookAt(nearest.position.offset(0, 1.6, 0));
        break;
      case "move_item":
        if (args && args.from !== undefined) {
          bot.simpleClick.leftMouse(args.from);
          bot.simpleClick.leftMouse(args.to);
        }
        break;
      case "toggle_stealth":
        stealthMode = !stealthMode;
        bot.setControlState('sneak', stealthMode);
        say(stealthMode ? "👻 Stealth Mode enabled via Dashboard" : "👁️ Stealth Mode disabled via Dashboard");
        break;
      case "beat_game":
        if (progressionActive) return;
        progressionActive = true;
        say("🚀 Speedrun Protocol initiated! Starting from basics.");
        beatTheGame();
        break;
      case "force_eat":
        forceEat();
        break;
      case "refuel":
        refuel();
        break;
      case "build":
        buildStructure(args);
        break;
    }
  })
})

/* ================= FOLLOW LOOP ================= */
function followLoop() {
  if (!following || !followTarget) return
  const p = bot.players[followTarget]?.entity
  if (!p) return

  bot.pathfinder.setMovements(movements)
  bot.pathfinder.setGoal(new goals.GoalFollow(p, 2), true)

  setTimeout(followLoop, 2000)
}

/* ================= PVP LOOP ================= */
async function pvpLoop() {
  if (!pvpTarget) {
    bot.setControlState('sprint', false);
    return;
  }
  const target = bot.players[pvpTarget]?.entity
  if (!target) {
    bot.setControlState('sprint', false);
    return;
  }

  bot.pathfinder.setMovements(movements)
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)

  const dist = bot.entity.position.distanceTo(target.position);
  if (dist < 4) {
    bot.setControlState('sprint', true); // Sprinting is key for knockback
    await bot.lookAt(target.position.offset(0, 1.6, 0), true);
    if (dist < 3.5) bot.attack(target);
  } else {
    bot.setControlState('sprint', false);
  }

  setTimeout(pvpLoop, 600); // 600ms aligns better with attack cooldowns
}

/* ================= GUARD LOOP ================= */
function guardLoop() {
  const pos = bot.entity.position
  bot.pathfinder.setGoal(new goals.GoalBlock(pos.x, pos.y, pos.z))
  setTimeout(guardLoop, 2000)
}

/* ================= ROAM ================= */
function roam() {
  if (!roaming) return
  bot.pathfinder.setMovements(movements)
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

/* ================= AUTO DEFENSE ================= */
bot.on('hurt', () => {
  if (pvpTarget || !autoDefense) return
  // Detect the nearest player within 6 blocks to counter-attack
  const attacker = bot.nearestEntity((e) => e.type === 'player' && e.position.distanceTo(bot.entity.position) < 6)
  if (attacker && attacker.username) {
    pvpTarget = attacker.username
    log("DEFENSE", `Under attack! Counter-attacking ${pvpTarget}`)
    pvpLoop()
  }
})

/* ================= ERRORS ================= */
bot.on("kicked", r => console.error("[KICKED]", r))
