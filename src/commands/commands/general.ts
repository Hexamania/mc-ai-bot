/**
 * General Commands
 * Basic utility commands like ping, help, status, etc.
 */

import type { CommandDefinition } from '../types';

/**
 * Ping command - check bot responsiveness
 */
export const pingCommand: CommandDefinition = {
  name: 'ping',
  aliases: ['p'],
  description: 'Check if the bot is responsive',
  shortDescription: 'Check bot responsiveness',
  category: 'General',
  permission: { level: 'guest' },
  execute: async (context) => {
    const start = Date.now();
    context.reply('🏓 Pong!');
    const latency = Date.now() - start;
    context.privateReply(`⏱️ Response time: ${latency}ms`);
  },
};

/**
 * Test command - simple test
 */
export const testCommand: CommandDefinition = {
  name: 'test',
  description: 'Test command to verify bot is active',
  shortDescription: 'Verify bot is active',
  category: 'General',
  permission: { level: 'guest' },
  execute: async (context) => {
    context.reply('✅ Bot is active and connected.');
    context.privateReply(
      `Bot: ${context.bot.username}\nHealth: ${context.bot.health}/20\nFood: ${context.bot.food}/20`
    );
  },
};

/**
 * Status command - show bot status
 */
export const statusCommand: CommandDefinition = {
  name: 'status',
  aliases: ['st', 'info'],
  description: 'Show detailed bot status and progression info',
  shortDescription: 'Show bot status',
  category: 'General',
  permission: { level: 'guest' },
  execute: async (context) => {
    const bot = context.bot;
    const pos = bot.entity?.position;

    let report = `📊 **Bot Status**\n`;
    report += `🤖 Username: ${bot.username}\n`;
    report += `❤️ Health: ${bot.health}/20\n`;
    report += `🍖 Food: ${bot.food}/20\n`;
    report += `📍 Position: ${pos ? `X:${Math.floor(pos.x)} Y:${Math.floor(pos.y)} Z:${Math.floor(pos.z)}` : 'Unknown'}\n`;
    report += `🌍 Dimension: ${bot.game?.dimension || 'Unknown'}\n`;
    report += `🕐 Time: ${bot.time?.timeOfDay || 'Unknown'}\n`;
    report += `📡 Ping: ${bot._client?.getLatency() || 'Unknown'}ms\n`;

    // Inventory summary
    const items = bot.inventory.items();
    report += `🎒 Inventory: ${items.length}/36 slots used\n`;

    // Equipment
    const equipment = [
      { slot: 'head', item: bot.inventory.slots[5] },
      { slot: 'chest', item: bot.inventory.slots[6] },
      { slot: 'legs', item: bot.inventory.slots[7] },
      { slot: 'feet', item: bot.inventory.slots[8] },
      { slot: 'hand', item: bot.heldItem },
      { slot: 'offhand', item: bot.inventory.slots[45] },
    ];

    report += `🛡️ Equipment:\n`;
    for (const eq of equipment) {
      const name = eq.item?.displayName || eq.item?.name || 'Empty';
      report += `  ${eq.slot}: ${name}\n`;
    }

    context.privateReply(report);
  },
};

/**
 * Coords command - show current coordinates
 */
export const coordsCommand: CommandDefinition = {
  name: 'coords',
  aliases: ['pos', 'position', 'whereami'],
  description: 'Show current coordinates',
  shortDescription: 'Show current position',
  category: 'General',
  permission: { level: 'guest' },
  execute: async (context) => {
    const bot = context.bot;
    if (!bot.entity) {
      context.reply('❌ Bot not spawned yet.');
      return;
    }
    const { x, y, z } = bot.entity.position;
    context.reply(
      `📍 Current Location: X: ${Math.floor(x)}, Y: ${Math.floor(y)}, Z: ${Math.floor(z)}`
    );
  },
};

/**
 * Version command - show bot version
 */
export const versionCommand: CommandDefinition = {
  name: 'version',
  aliases: ['ver', 'v'],
  description: 'Show bot version information',
  shortDescription: 'Show version info',
  category: 'General',
  permission: { level: 'guest' },
  execute: async (context) => {
    const bot = context.bot;
    context.privateReply(
      `🤖 **Airi Bot Version Info**\n` +
        `Version: 1.0.0\n` +
        `Minecraft: ${bot.game?.version || 'Unknown'}\n` +
        `Protocol: ${bot._client?.protocolVersion || 'Unknown'}\n` +
        `Node: ${process.version}\n` +
        `Platform: ${process.platform}\n` +
        `Uptime: ${Math.floor(process.uptime())}s`
    );
  },
};

/**
 * Uptime command - show bot uptime
 */
export const uptimeCommand: CommandDefinition = {
  name: 'uptime',
  aliases: ['up'],
  description: 'Show bot uptime',
  shortDescription: 'Show uptime',
  category: 'General',
  permission: { level: 'guest' },
  execute: async (context) => {
    // This would need to be tracked from spawn time
    context.privateReply(
      `⏱️ Bot uptime tracking not implemented yet. Process uptime: ${Math.floor(process.uptime())}s`
    );
  },
};

/**
 * List command - list various things
 */
export const listCommand: CommandDefinition = {
  name: 'list',
  aliases: ['ls', 'players'],
  description: 'List online players',
  shortDescription: 'List online players',
  category: 'General',
  permission: { level: 'guest' },
  arguments: [
    {
      name: 'type',
      description: 'What to list (players, entities, items)',
      required: false,
      type: 'enum',
      enumValues: ['players', 'entities', 'items', 'chests'],
      defaultValue: 'players',
    },
  ],
  execute: async (context) => {
    const bot = context.bot;
    const type = (context.args.args[0] as string) || 'players';

    switch (type) {
      case 'players': {
        const players = Object.values(bot.players);
        if (players.length === 0) {
          context.privateReply('👥 No players online');
          return;
        }
        const playerList = players
          .map(
            (p) =>
              `${p.username}${p.entity ? ` (${Math.floor(p.entity.position.distanceTo(bot.entity?.position || { x: 0, y: 0, z: 0 }))}m)` : ''}`
          )
          .join('\n');
        context.privateReply(`👥 **Online Players (${players.length}):**\n${playerList}`);
        break;
      }
      case 'entities': {
        const entities = Object.values(bot.entities)
          .filter((e) => e !== bot.entity)
          .slice(0, 20);
        const entityList = entities
          .map(
            (e) =>
              `${e.name || e.username || 'Unknown'} (${e.kind}) - ${Math.floor(e.position.distanceTo(bot.entity?.position || { x: 0, y: 0, z: 0 }))}m`
          )
          .join('\n');
        context.privateReply(
          `👻 **Nearby Entities (${entities.length}):**\n${entityList || 'None'}`
        );
        break;
      }
      case 'items': {
        const items = bot.inventory.items();
        const itemList = items
          .map((item, i) => `${i}: ${item.count}x ${item.displayName || item.name}`)
          .join('\n');
        context.privateReply(`🎒 **Inventory (${items.length}/36):**\n${itemList || 'Empty'}`);
        break;
      }
      case 'chests': {
        const chests = bot.findBlocks({
          matching: bot.registry.blocksByName.chest?.id,
          maxDistance: 20,
          count: 10,
        });
        if (chests.length === 0) {
          context.privateReply('📦 No chests found nearby');
          return;
        }
        const chestList = chests
          .map((pos) => `Chest at ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`)
          .join('\n');
        context.privateReply(`📦 **Nearby Chests:**\n${chestList}`);
        break;
      }
      default:
        context.error(`Unknown list type: ${type}. Use: players, entities, items, chests`);
    }
  },
};

export const generalCommands = [
  pingCommand,
  testCommand,
  statusCommand,
  coordsCommand,
  versionCommand,
  uptimeCommand,
  listCommand,
];
