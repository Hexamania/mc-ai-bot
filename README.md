# ⚠️ AI-Assisted Code Notice: Parts of this project were built using generative AI. Also, heads up: this hasn't been fully tested on Windows yet, so expect some bugs or path/dependency quirks, Web Server Isnt Finished

# Mineflayer AI Bot & Web Dashboard

An autonomous, feature-packed Minecraft bot built with [Mineflayer](https://github.com/PrismarineJS/mineflayer) and [OpenAI](https://platform.openai.com/). It comes equipped with pathfinding, combat automation, resource gathering, an automated speedrun/progression sequence, and a real-time web dashboard.

---

## Features

- **Interactive Web Dashboard**: Real-time web UI on port `3000` showing bot health, hunger, coordinates, inventory, 2D radar, and controls (kill aura, building, mining, item management).
- **AI In-Game Chat**: Chat with the bot in-game via OpenAI (`:chat <message>`).
- **Progression Automation**: Automates basic tech progression up to nether and stronghold prep.
- **Combat & Survival**:
  - Auto-defense and retaliatory attacks.
  - Water-bucket MLG and lava safety management.
  - Smart shield blocking against incoming projectiles.
  - Auto-armor equip system based on best gear tier in inventory.
  - Emergency panic mode and safe mode against creepers.
- **Utilities**:
  - Tunnel mining (`:miner`) and tree logging (`:lumberjack`).
  - Container auto-sorting (`:sort`) and dumping (`:deposit`).
  - Base waypoint management (`:sbase`, `:home`).
  - Medical rescue missions and companion protection (`:rescue`, `:medic`).

---

## Prerequisites

- Node.js (v18 or higher recommended)
- A Minecraft server running version `1.21.1` (or compatible Java version)
- An OpenAI API Key (for the `:chat` command)

---

## Installation

1. **Clone the repository:**
   ```bash
   https://github.com/Hexamania/mc-ai-bot.git
   cd mc-ai-bot
   ```

2. **Install dependencies:**
   ```bash
   npm install dotenv mineflayer mineflayer-pathfinder minecraft-data openai express socket.io vec3
   ```

3. **Configure environment variables:**
   Create a `.env` file in the root directory:
   ```env
   MC_HOST=localhost
   MC_PORT=25565
   MC_USERNAME=Airi
   MC_VERSION=1.21.1
   OPENAI_KEY=your_openai_api_key_here
   ```

---

## Usage

1. **Start the bot:**
   ```bash
   node bot.js
   ```

2. **Access the Web Dashboard:**
   Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

---

## Command Reference

### Public Commands (`:` Prefix)
| Command | Description |
|---|---|
| `:ping` | Check bot responsiveness (replies with "pong"). |
| `:status` | View current progression objective and missing materials. |
| `:coords` | Outputs bot's current XYZ coordinates. |
| `:chat <msg>` | Queries OpenAI GPT-4 and responds in chat. |
| `:sbase [x y z]` | Sets home base coordinates (defaults to current position). |
| `:home` | Commands the bot to navigate back to the home base. |
| `:basechest` | Inspects the contents of a chest located at base. |
| `:miner <dir> [len]` | Digs a 1x2 tunnel (`north`, `south`, `east`, `west`). |
| `:lumberjack [radius]` | Cuts down logs in the specified radius. |
| `:roof [radius]` | Constructs a slab roof over the base location. |
| `:rescue` | Locates the nearest injured player and delivers food. |
| `:medic <player>` | Follows and guards a specific player. |
| `:sort` | Organizes nearby chest contents by item category. |
| `:deposit` | Deposits non-essential items into a nearby chest. |
| `:refuel` | Gathers nearby coal ore or smelts logs into charcoal. |
| `:help` | Displays available command list. |

### Admin Commands (`$` Prefix)
To authenticate as an admin, send a private message to the bot:
```
/msg Airi $loginadmin <ADMIN_PASSWORD>
```

Once authenticated, you gain access to admin actions:
| Command | Description |
|---|---|
| `$panic` | Equips shield, consumes golden apple (if available), and retreats to base. |
| `$stealth` | Toggles sneak mode to conceal the bot's nametag. |
| `$guard` | Holds position and defends the immediate area. |
| `$pvp <player>` | Aggressively pursues and attacks the specified player. |
| `$stoppvp` | Cancels ongoing PVP combat. |
| `$mine <block>` | Finds and mines the specified block type. |
| `$servercmd <cmd>` | Executes a server slash command through the bot. |
