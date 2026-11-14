# Rust Migration Status

**Status: in progress.** This is an inventory of the Rust rewrite as of
2026-11-14. The Node.js/TypeScript application remains the full-featured
implementation; the Rust binary is not yet a replacement for it.

## Converted and verified

| Area | Current Rust coverage |
| --- | --- |
| Configuration and lifecycle | Environment-backed configuration and validation, bot lifecycle states, startup, and graceful shutdown. |
| Minecraft connection | Azalea transport and event mapping for Minecraft `1.21.1`; offline and Microsoft authentication. Unsupported protocol versions and auth modes are rejected. |
| Reconnection | Transient connection failures retry with exponential backoff; configuration and authentication errors are not retried. |
| Command infrastructure | Chat parsing, typed arguments/options, aliases, help, async handlers, permission checks, cooldowns, execution statistics, and private/public replies. |
| Admin login | Private `$loginadmin <password>` authenticates an admin session. |
| Memory core | Legacy-to-v2 normalization, atomic file writes, and remembered-fact operations. |
| Runnable Rust process | The Rust executable loads configuration, starts the runtime, and handles Ctrl+C shutdown. |

### Rust chat commands currently registered

| Command | Access and scope |
| --- | --- |
| `!help`, `!ping` | General command help and responsiveness. |
| `!coords` (`!pos`, `!position`, `!whereami`) | Guest-accessible floored player coordinates; reports if the bot has not spawned. |
| `!follow`, `!stopfollow` | Follow a nearby player without breaking blocks; stop following. |
| `!roam` | Admin roaming with bounded radius and interval. |
| `!stoproam` | Stop roaming. |
| `!goto` (`!move`, `!moveto`) | Admin coordinate navigation without breaking blocks. |
| `!stop` (`!stopall`) | Stop movement and active mining. |
| `!inventory` (`!inv`), `!itemcount` (`!countitem`), `!equipment` (`!gear`) | Read-only inventory, item-count, and equipment queries. |
| `!mine <block-name>` | Admin-only targeted mining of the nearest loaded, breakable matching block within 32 blocks. |
| `!sbase` (`!setbase`) | Set base location (current position or coordinates). |
| `!home` | Return to base location. |
| `!sminebase` | Set mining base location at current position. |
| `!minebase` | Go to mining base location. |
| `!basechest` | View base chest contents (navigates to base, opens chest). |
| `!sort` | Auto-sort nearby chest (groups similar items). |
| `!deposit` | Deposit non-essential items to chest (keeps tools, armor, food, building blocks). |
| `!miner <dir> [len]` | Admin: start mining 2-high tunnel (north/south/east/west) with block breaking. |
| `!stopminer` | Admin: stop mining tunnel. |
| `!minearea <x1> <y1> <z1> <x2> <y2> <z2>` | Admin: mine area between two positions (top-down, with block breaking). |
| `!stopminearea` | Admin: stop mining area. |
| `!refuel` | Search for and mine coal ore / deepslate coal ore (up to 8). |
| `!lumberjack [radius]` | Find and chop trees in radius (bottom-to-top, up to 20 logs). |
| `!roof [radius]` | Admin: build flat roof at base with blocks from inventory. |
| `!guard` | Admin: guard current location (attacks nearby hostile mobs). |
| `!stopguard` | Admin: stop guarding. |
| `!pvp <player>` | Admin: engage PVP with player (combat loop with weapon switching, eating). |
| `!stoppvp` | Admin: stop PVP. |
| `!panic` | Admin: activate panic mode (flee to Y=250, build shelter). |
| `!stealth` | Admin: toggle stealth/sneak mode. |
| `!dstop` | Admin: stop auto-defense (guard, PVP). |
| `!remember <key>=<fact>` | Remember a fact to persistent memory. |
| `!forget <key>` | Forget a remembered fact. |
| `!chat <message>` | Chat with AI assistant (placeholder). |
| `!servercmd <command>` | Admin: execute server command. |
| **New General Commands** | |
| `!status` (`!info`) | Show bot status (state, position, uptime). |
| `!test` | Test if bot is responsive. |
| `!version` (`!ver`) | Show version information. |
| `!uptime` | Show bot uptime. |
| `!list` (`!commands`, `!help`) | List all available commands. |
| **New Survival Commands** | |
| `!rescue <player>` | Rescue a player (pathfind, give food, protect from mobs). |
| `!medic <player>` | Continuous heal/protect loop for target player. |

Command names use the Rust runtime's configured prefixes. The defaults shown in
the current README use `!` for public commands and `$` for the private admin
login.

## Partially converted

- **Inventory:** Rust can inspect carried slots and equipment. Sorting,
  depositing, refueling, and chest operations are now implemented with
  full integration with Azalea's inventory and container APIs.
- **Mining:** Tunnel mining (`miner`), area mining (`minearea`), refuel,
  and lumberjack commands are fully implemented with block breaking
  and pathfinding integration.
- **Movement:** Follow, roaming, coordinate navigation, miner, mine area,
  and base navigation are fully implemented with pathfinding.
- **Minecraft support:** The Rust transport currently targets `1.21.1` and
  offline or Microsoft authentication, not every protocol/auth mode supported
  elsewhere in the project.
- **Building/Combat:** Guard, PVP, roof building, panic mode, stealth,
  rescue, and medic commands are fully implemented.

## Not yet converted

The following Node command families and their integrations are not available in
the Rust runtime yet:

- The TypeScript plugin/feature system and full Node bot command integrations.
- Existing TypeScript feature modules for auto-farming, building, combat/defense,
  and automated inventory management.
- The HTTP and Socket.IO web dashboard, its bot-control integrations, and the
  Electron/Vue desktop application and installer.

This list describes the current Rust port, not removed Node functionality. The
existing Node.js application remains available while these areas are ported.

## Verification

The Windows `Rust core` workflow runs formatting, all-target checking, and Rust
tests. The latest verified command slice passed all three checks:
[CI run 43551569848](https://github.com/Hexamania/mc-ai-bot/actions/runs/43551569848).
See the [targeted mining guide](./rust-targeted-mining.md) for the mining
feature's detailed behavior and limits.
