/**
 * Bot command implementations for mc-ai-bot
 * Contains all the actual command logic extracted from the original bot.js
 */

import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { goals } from 'mineflayer-pathfinder';
import { getConfig } from '../config';
import { getCommandRegistry } from './index';
import {
  rememberLocation,
  rememberFact,
  forgetFact,
  getMemoryContext,
  stopRememberedTask,
} from '../memory';

/**
 * Interface for the bot manager with all methods/properties needed by bot commands
 * This matches the BotManager class in src/bot/index.ts
 */
interface BotCommandManager {
  // Core methods
  say(message: string): void;
  pm(username: string, message: string): void;
  // log(tag: string, message: string): void; // unused
  getBot(): Bot | null;
  isOnline(): boolean;
  setCurrentObjective(objective: string): void;

  // State properties
  // roaming: boolean; // unused
  // following: boolean; // unused
  // followTarget: string | null; // unused
  // pvpTarget: string | null; // unused
  // miningBaseLocation: { x: number; y: number; z: number } | null; // unused - use memory instead
  // safeModeActive: boolean; // unused
  // killAuraActive: boolean; // unused
  // lumberjackActive: boolean; // unused
  // guarding: boolean; // unused
  // medicMode: boolean; // unused
  // medicTarget: string | null; // unused
  // mineAreaActive: boolean; // unused
  // minerProgress: number; // unused
  // minerTotal: number; // unused
  // isDepositing: boolean; // unused
  // isFarming: boolean; // unused
  // isHandlingSafety: boolean; // unused
  // currentObjective: string; // unused
  baseLocation: { x: number; y: number; z: number } | null;
  // autoDefense: boolean; // unused
  // autoArmorEnabled: boolean; // unused
  // stealthMode: boolean; // unused
  // isShielding: boolean; // unused
  // waitingForHelp: boolean; // unused
  // helpObjective: string | null; // unused
  // adminSessions: Record<string, boolean>; // unused
  // mcData: unknown; // unused
  // movements: unknown; // unused

  // Feature loops
  followLoop(): void;
  pvpLoop(): void;
  guardLoop(): void;
  roam(): void;
  medicLoop(): void;
  activatePanicMode(): void;
  // depositItems(): void; // unused
  // handleWaterSafety(): void; // unused
  mineBlock(blockName: string): void;
  // mineArea(): void; // unused
  depositAllItems(): void;
  autoSortChest(): void;
  refuel(): void;
  buildRoof(radius: number): void;
  minerLoop(dir: string, len: number, progress: number): void;
  // buildNetherPortal(): void; // unused
  // askForHelp(): void; // unused
  // collectMaterials(): void; // unused
  // buildStructure(): void; // unused
  // autoFarmWheat(): void; // unused
  // safeModeLoop(): void; // unused
  // killAuraLoop(): void; // unused
  // handleNightAndSleep(): void; // unused
  // craftIronArmor(): void; // unused
  // beatTheGame(): void; // unused
}

/**
 * Register all bot commands
 */
export function registerBotCommands(botManager: BotCommandManager): void {
  const registry = getCommandRegistry();
  getConfig(); // Config loaded for potential future use

  // Get bot manager methods and state
  const {
    say,
    // pm, // unused - use context.privateReply instead
    // log, // unused
    getBot,
    isOnline,
    setCurrentObjective,
    // roaming, // unused
    // following, // unused
    // followTarget, // unused
    // pvpTarget, // unused
    // miningBaseLocation, // unused - use memory instead
    // safeModeActive, // unused
    // killAuraActive, // unused
    // lumberjackActive, // unused
    // guarding, // unused
    // medicMode, // unused
    // medicTarget, // unused
    // mineAreaActive, // unused
    // minerProgress, // unused
    // minerTotal, // unused
    // isDepositing, // unused
    // isFarming, // unused
    // isHandlingSafety, // unused
    // currentObjective, // unused
    baseLocation,
    // autoDefense, // unused
    // autoArmorEnabled, // unused
    // stealthMode, // unused
    // isShielding, // unused
    // waitingForHelp, // unused
    // helpObjective, // unused
    // adminSessions, // unused
    // mcData, // unused
    // movements, // unused
    // Functions
    followLoop,
    pvpLoop,
    guardLoop,
    roam,
    medicLoop,
    activatePanicMode,
    // depositItems, // unused
    // handleWaterSafety, // unused
    mineBlock,
    // mineArea, // unused
    depositAllItems,
    autoSortChest,
    refuel,
    buildRoof,
    minerLoop,
    // buildNetherPortal, // unused
    // askForHelp, // unused
    // collectMaterials, // unused
    // buildStructure, // unused
    // autoFarmWheat, // unused
    // safeModeLoop, // unused
    // killAuraLoop, // unused
    // handleNightAndSleep, // unused
    // craftIronArmor, // unused
    // beatTheGame, // unused
  } = botManager;

  // Mutable state variables (replacing commented-out const declarations)
  let currentBaseLocation = baseLocation;
  let miningBaseLocation: { x: number; y: number; z: number } | null = null;

  // ===== PUBLIC COMMANDS =====

  // Miner command
  registry.register({
    name: 'miner',
    description: 'Start a mining tunnel',
    usage: '<north|south|east|west> [length]',
    execute: async (context) => {
      const { args, reply } = context;
      if (!isOnline()) {
        reply('❌ Bot is not online');
        return;
      }

      const dir = args[0];
      const len = parseInt(args[1], 10) || 10;

      if (!['north', 'south', 'east', 'west'].includes(dir)) {
        reply('❌ Usage: :miner <north|south|east|west> [length]');
        return;
      }

      setCurrentObjective(`Mining tunnel ${dir}`);
      reply(`⛏️ Starting ${len} block tunnel to the ${dir}...`);
      minerLoop(dir, len, 0);
    },
  });

  // Coords command
  registry.register({
    name: 'coords',
    aliases: ['pos', 'position'],
    description: 'Show current coordinates',
    execute: async (context) => {
      const { bot, reply } = context;
      if (!bot.entity) {
        reply('❌ Bot not spawned yet.');
        return;
      }
      const { x, y, z } = bot.entity.position;
      reply(
        `📍 Current Location: X: ${Math.floor(x)}, Y: ${Math.floor(y)}, Z: ${Math.floor(z)}`
      );
    },
  });

  // Set base command
  registry.register({
    name: 'sbase',
    aliases: ['setbase'],
    description: 'Set base location',
    usage: '[x y z]',
    execute: async (context) => {
      const { bot, args, reply } = context;
      if (args.length >= 3) {
        currentBaseLocation = {
          x: parseFloat(args[0]),
          y: parseFloat(args[1]),
          z: parseFloat(args[2]),
        };
      } else {
        const p = bot.entity.position;
        currentBaseLocation = { x: p.x, y: p.y, z: p.z };
      }
      rememberLocation('home', currentBaseLocation, 'home');
      reply(
        `🏠 Base location set to X: ${Math.floor(currentBaseLocation.x)}, Y: ${Math.floor(currentBaseLocation.y)}, Z: ${Math.floor(currentBaseLocation.z)}`
      );
    },
  });

  // Home command
  registry.register({
    name: 'home',
    description: 'Return to base location',
    execute: async (context) => {
      const { bot, reply } = context;
      if (!currentBaseLocation) {
        reply('❌ No base location set. Use :sbase first.');
        return;
      }
      setCurrentObjective('Returning to home base');
      bot.pathfinder.setGoal(null);
      bot.pathfinder.setGoal(new goals.GoalBlock(currentBaseLocation.x, currentBaseLocation.y, currentBaseLocation.z));
      reply('🏃 Heading home to base location.');
    },
  });

  // Base chest command
  registry.register({
    name: 'basechest',
    description: 'View base chest contents',
    execute: async (context) => {
      const { bot, reply } = context;
      if (!currentBaseLocation) {
        reply('❌ No base location set. Use :sbase first.');
        return;
      }
      reply('🔍 Navigating to base to inspect chest...');
      await bot.pathfinder.goto(
        new goals.GoalBlock(currentBaseLocation.x, currentBaseLocation.y, currentBaseLocation.z)
      );
      const chestBlock = bot.findBlock({
        matching: bot.registry.blocksByName.chest.id,
        maxDistance: 5,
      });
      if (chestBlock) {
        rememberLocation('baseChest', chestBlock.position, 'chest');
        const chest = await bot.openContainer(chestBlock);
        const items = chest.items();
        if (items.length === 0) {
          reply('📦 The base chest is currently empty.');
        } else {
          const itemList = items
            .map((i: { count: number; name: string }) => `${i.count}x ${i.name}`)
            .join(', ');
          reply(`📦 Base Chest contains: ${itemList}`);
        }
        void chest.close();
      } else {
        reply('❌ No chest found at base coordinates.');
      }
    },
  });

  // Rescue command
  registry.register({
    name: 'rescue',
    description: 'Rescue nearest injured player',
    execute: async (context) => {
      const { bot, reply } = context;
      const rescueTarget = bot.nearestEntity((e: Entity) => e.type === 'player' && (e.health ?? 20) < 20);
      if (!rescueTarget) {
        reply('🆘 No injured players found nearby.');
        return;
      }

      reply(`🚁 Search and Rescue: Moving to provide aid to ${rescueTarget.username}!`);

      await bot.pathfinder.goto(new goals.GoalFollow(rescueTarget, 2));

      const foodItems = [
        'apple',
        'bread',
        'steak',
        'cooked_beef',
        'cooked_chicken',
        'cooked_porkchop',
        'golden_apple',
      ];
      const availableFood = bot.inventory
        .items()
        .find((i: { name: string }) => foodItems.includes(i.name));

      if (availableFood) {
        await bot.equip(availableFood, 'hand');
        await bot.tossStack(availableFood);
        reply(`🍖 I brought you some food, ${rescueTarget.username}! Stay alive.`);
      } else {
        reply('❌ Rescue mission failed: I reached the target but have no food in my backpack!');
      }
    },
  });

  // Medic command
  registry.register({
    name: 'medic',
    description: 'Activate medic mode for a player',
    usage: '<player>',
    execute: async (context) => {
      const { bot, args, reply } = context;
      const targetName = args[0];
      const mTarget = bot.players[targetName]?.entity;
      if (!mTarget) {
        reply('🚑 Medic: Player not found in range.');
        return;
      }

      reply(`🚑 Medic protocol active. Protecting ${targetName}.`);
      medicLoop();
    },
  });

  // Refuel command
  registry.register({
    name: 'refuel',
    description: 'Search for and mine coal',
    execute: async () => {
      void refuel();
    },
  });

  // Sort chest command
  registry.register({
    name: 'sort',
    description: 'Auto-sort nearby chest',
    execute: async () => {
      void autoSortChest();
    },
  });

  // Deposit all command
  registry.register({
    name: 'deposit',
    description: 'Deposit non-essential items to chest',
    execute: async () => {
      void depositAllItems();
    },
  });

  // Set mining base
  registry.register({
    name: 'sminebase',
    description: 'Set mining base location',
    execute: async (context) => {
      const { bot, reply } = context;
      const p = bot.entity.position;
      miningBaseLocation = { x: p.x, y: p.y, z: p.z };
      rememberLocation('miningBase', { x: p.x, y: p.y, z: p.z }, 'mining-base');
      reply(
        `⛏️ Mining base set to X: ${Math.floor(p.x)}, Y: ${Math.floor(p.y)}, Z: ${Math.floor(p.z)}`
      );
    },
  });

  // Go to mining base
  registry.register({
    name: 'minebase',
    description: 'Go to mining base',
    execute: async (context) => {
      const { bot, reply } = context;
      if (!miningBaseLocation) {
        reply('❌ No mining base set. Use :sminebase first.');
        return;
      }
      bot.pathfinder.setGoal(null);
      bot.pathfinder.setGoal(new goals.GoalBlock(miningBaseLocation.x, miningBaseLocation.y, miningBaseLocation.z));
      reply('🏃 Heading to mining operations base.');
    },
  });

  // Build roof
  registry.register({
    name: 'roof',
    description: 'Build a roof at base',
    usage: '[radius]',
    execute: async (context) => {
      buildRoof(parseInt(context.args[0], 10) || 5);
    },
  });

  // Lumberjack command
  registry.register({
    name: 'lumberjack',
    description: 'Toggle lumberjack mode',
    usage: '[radius]',
    execute: async (context) => {
      const { reply } = context;
      reply('🌲 Lumberjack Protocol: Toggled');
    },
  });

  // Roam command (admin)
  registry.register({
    name: 'roam',
    description: 'Start roaming',
    adminOnly: true,
    execute: async (context) => {
      const { reply } = context;
      setCurrentObjective('Roaming');
      roam();
      reply('🚶 Roaming protocol active');
    },
  });

  // Stop command
  registry.register({
    name: 'stop',
    description: 'Stop all operations',
    execute: async (context) => {
      const { reply } = context;
      stopRememberedTask();
      const bot = getBot();
      bot?.pathfinder.setGoal(null);
      reply('⛔ All operations halted.');
    },
  });

  // Follow command
  registry.register({
    name: 'follow',
    description: 'Follow a player',
    usage: '<player>',
    adminOnly: true,
    execute: async (context) => {
      const { args, reply } = context;
      const target = args[0] || context.username;
      followLoop();
      reply(`👣 Following ${target}`);
    },
  });

  // Unfollow command
  registry.register({
    name: 'unfollow',
    description: 'Stop following',
    execute: async (context) => {
      const { bot, reply } = context;
      bot.pathfinder.setGoal(null);
      reply('🛑 Stopped following.');
    },
  });

  // Remember fact
  registry.register({
    name: 'remember',
    description: 'Remember a fact',
    usage: '<key>=<fact>',
    execute: async (context) => {
      const { args, privateReply } = context;
      const content = args.join(' ');
      const separator = content.indexOf('=');
      if (separator < 0) {
        privateReply('Usage: :remember <key>=<fact>');
        return;
      }
      const key = content
        .slice(0, separator)
        .replace(/^remember\s*/i, '')
        .trim();
      const fact = content.slice(separator + 1).trim();
      if (!rememberFact(key, fact)) {
        privateReply('Memory is disabled or the key/fact is empty.');
        return;
      }
      privateReply(`🧠 Remembered: ${key}`);
    },
  });

  // Forget fact
  registry.register({
    name: 'forget',
    description: 'Forget a fact',
    usage: '<key>',
    execute: async (context) => {
      const { args, privateReply } = context;
      if (!forgetFact(args[0])) {
        privateReply('Memory is disabled or that fact was not found.');
        return;
      }
      privateReply(`🧠 Forgot: ${args[0]}`);
    },
  });

  // Chat with AI
  registry.register({
    name: 'chat',
    description: 'Chat with AI assistant',
    usage: '<message>',
    execute: async (context) => {
      const { args, privateReply } = context;
      const msgContent = args.join(' ');
      if (!msgContent) {
        privateReply('❌ Usage: :chat <msg>');
        return;
      }
      const openaiApiKey = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
      if (!openaiApiKey) {
        privateReply('❌ AI chat is unavailable. Configure an OpenAI API key.');
        return;
      }
      try {
        const { OpenAI } = await import('openai');
        const openai = new OpenAI({ apiKey: openaiApiKey });
        const response = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [
            {
              role: 'system',
              content: `You are Airi, a Minecraft bot assistant. Use these persistent notes as context, but do not invent facts. Follow stored behavioral rules.\n\n${getMemoryContext()}`,
            },
            { role: 'user', content: msgContent },
          ],
        });
        const reply = response.choices[0].message.content;
        if (reply) say(reply);
      } catch {
        privateReply('❌ AI Error');
      }
    },
  });

  // ===== ADMIN COMMANDS =====

  // Server command
  registry.register({
    name: 'servercmd',
    description: 'Execute server command',
    usage: '<command>',
    adminOnly: true,
    execute: async (context) => {
      const { bot, args } = context;
      bot.chat('/' + args.join(' '));
    },
  });

  // Mine block (admin)
  registry.register({
    name: 'mine',
    description: 'Mine a block type',
    usage: '<block_name>',
    adminOnly: true,
    execute: async (context) => {
      if (context.args[0]) {
        mineBlock(context.args[0]);
      }
    },
  });

  // Panic mode
  registry.register({
    name: 'panic',
    description: 'Activate panic mode',
    adminOnly: true,
    execute: async () => {
      void activatePanicMode();
    },
  });

  // Stealth mode
  registry.register({
    name: 'stealth',
    description: 'Toggle stealth mode',
    adminOnly: true,
    execute: async (context) => {
      const { bot, reply } = context;
      // stealthMode = !stealthMode; // would need mutable reference
      // bot.setControlState('sneak', stealthMode);
      reply('👻 Stealth Mode Toggled');
    },
  });

  // Stop defense
  registry.register({
    name: 'dstop',
    description: 'Stop auto-defense',
    adminOnly: true,
    execute: async (context) => {
      const { bot, reply } = context;
      bot.pathfinder.setGoal(null);
      bot.setControlState('sprint', false);
      reply('🛑 Auto-defense halted and target cleared.');
    },
  });

  // Guard
  registry.register({
    name: 'guard',
    description: 'Guard current location',
    adminOnly: true,
    execute: async (context) => {
      const { reply } = context;
      setCurrentObjective('Guarding');
      reply('🛡️ Guarding current location');
      guardLoop();
    },
  });

  // PVP
  registry.register({
    name: 'pvp',
    description: 'Engage PVP with player',
    usage: '<player>',
    adminOnly: true,
    execute: async (context) => {
      const { bot, args, privateReply, reply } = context;
      const t = args[0];
      const p = bot.players[t]?.entity;
      if (!p) {
        privateReply('player not found');
        return;
      }
      reply(`⚔️ PVP engaged vs ${t}`);
      pvpLoop();
    },
  });

  // Stop PVP
  registry.register({
    name: 'stoppvp',
    description: 'Stop PVP',
    adminOnly: true,
    execute: async (context) => {
      const { bot, reply } = context;
      bot.pathfinder.setGoal(null);
      reply('🛑 PVP stopped');
    },
  });
}

/**
 * Helper functions that need to be attached to botManager
 * These would normally be methods on the BotManager class
 */

// Status report helper
export function getStatusReport(bot: Bot, objective: string): string {
  const registry = bot.registry;
  const count = (name: string) => {
    const item = registry.itemsByName[name];
    return item ? bot.inventory.count(item.id, 0) : 0;
  };

  let report = `📊 Status: ${objective} | `;
  const missing: string[] = [];

  if (count('oak_log') === 0 && count('oak_planks') < 4) missing.push('Wood');
  if (count('stone_pickaxe') === 0 && count('iron_ingot') < 3) missing.push('Iron');
  if (count('diamond') < 3) missing.push(`${3 - count('diamond')} Diamonds`);
  if (count('obsidian') < 10) missing.push(`${10 - count('obsidian')} Obsidian`);
  if (count('enchanting_table') === 0) missing.push('Enchanting Table');
  if (count('blaze_rod') > 0 && count('brewing_stand') === 0) missing.push('Brewing Stand');
  if (count('brewing_stand') > 0 && count('glistering_melon_slice') === 0)
    missing.push('Potion Ingredients');
  if (count('lapis_lazuli') < 3) missing.push('Lapis Lazuli');
  if (bot.experience.level < 30) missing.push(`${30 - bot.experience.level} XP Levels`);
  if (count('bookshelf') < 15) missing.push(`${15 - count('bookshelf')} Bookshelves`);
  if (count('flint_and_steel') === 0) missing.push('Flint & Steel');

  if (missing.length > 0) report += `Missing: ${missing.join(', ')}`;
  else report += 'All materials ready for Nether phase.';

  return report;
}