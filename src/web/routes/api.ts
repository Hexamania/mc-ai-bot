/**
 * REST API routes for web server
 * Provides HTTP endpoints for bot state, memory, commands, and configuration
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import type { BotManager } from '../../bot';
import {
  getMemory,
  rememberLocation,
  rememberFact,
  forgetFact,
  addRule,
  removeRule,
  persistMemory,
  getMemoryContext,
  clearMemory,
} from '../../memory';
import { getCommandRegistry, createCommandContext } from '../../commands';
import { getConfig } from '../../config';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  authMiddleware,
  optionalAuthMiddleware,
  requireAdmin,
  requireTrusted,
} from '../middleware/auth';
import { rateLimiters } from '../middleware/rateLimit';

const router = Router();

let botManager: BotManager | null = null;

/**
 * Initialize the router with bot manager instance
 */
export function initializeApiRoutes(bm: BotManager): void {
  botManager = bm;
}

/**
 * Apply rate limiting to all API routes
 */
router.use(rateLimiters.api);

/**
 * Health check endpoint (no auth required)
 */
router.get('/health', (req: Request, res: Response) => {
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
  });
});

/**
 * Bot status endpoint (no auth required for basic status)
 */
router.get('/status', optionalAuthMiddleware, (req: AuthenticatedRequest, res: Response) => {
  if (!botManager) {
    return res.status(503).json({
      success: false,
      error: 'Bot manager not initialized',
    });
  }

  res.json({
    success: true,
    data: botManager.getStatus(),
  });
});

/**
 * Full bot state endpoint (requires auth)
 */
router.get('/state', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  if (!botManager) {
    return res.status(503).json({
      success: false,
      error: 'Bot manager not initialized',
    });
  }

  res.json({
    success: true,
    data: botManager.getState(),
  });
});

/**
 * Bot vitals endpoint (health, food, position)
 */
router.get('/vitals', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  if (!botManager) {
    return res.status(503).json({
      success: false,
      error: 'Bot manager not initialized',
    });
  }

  const bot = botManager.getBot();
  if (!bot || !bot.entity) {
    return res.status(503).json({
      success: false,
      error: 'Bot not spawned',
    });
  }

  res.json({
    success: true,
    data: {
      health: bot.health,
      food: bot.food,
      saturation: bot.foodSaturation,
      position: bot.entity.position,
      yaw: bot.entity.yaw,
      pitch: bot.entity.pitch,
      dimension: bot.game?.dimension,
      time: bot.time?.timeOfDay,
      gamemode: bot.game?.gameMode,
    },
  });
});

/**
 * Inventory endpoint
 */
router.get('/inventory', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  if (!botManager) {
    return res.status(503).json({
      success: false,
      error: 'Bot manager not initialized',
    });
  }

  const bot = botManager.getBot();
  if (!bot) {
    return res.status(503).json({
      success: false,
      error: 'Bot not connected',
    });
  }

  const items = bot.inventory.slots.map((item: unknown, index: number) => {
    if (!item) return { slot: index, name: 'air', count: 0, displayName: 'Empty' };
    const itemObj = item as Record<string, unknown>;
    return {
      slot: index,
      name: itemObj.name as string,
      displayName: itemObj.displayName as string,
      count: itemObj.count as number,
      maxStackSize: (itemObj.maxStackSize as number) || (itemObj.stackSize as number) || 64,
    };
  });

  res.json({
    success: true,
    data: {
      items,
      usedSlots: bot.inventory.items().length,
      totalSlots: 36,
      heldItem: bot.heldItem
        ? {
            slot: bot.heldItem.slot,
            name: bot.heldItem.name,
            displayName: bot.heldItem.displayName,
            count: bot.heldItem.count,
          }
        : null,
    },
  });
});

/**
 * Equipment endpoint
 */
router.get('/equipment', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  if (!botManager) {
    return res.status(503).json({
      success: false,
      error: 'Bot manager not initialized',
    });
  }

  const bot = botManager.getBot();
  if (!bot) {
    return res.status(503).json({
      success: false,
      error: 'Bot not connected',
    });
  }

  res.json({
    success: true,
    data: {
      head: bot.inventory.slots[5]?.displayName || 'Empty',
      chest: bot.inventory.slots[6]?.displayName || 'Empty',
      legs: bot.inventory.slots[7]?.displayName || 'Empty',
      feet: bot.inventory.slots[8]?.displayName || 'Empty',
      hand: bot.heldItem?.displayName || 'Empty',
      offhand: bot.inventory.slots[45]?.displayName || 'Empty',
    },
  });
});

/**
 * Players endpoint
 */
router.get('/players', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  if (!botManager) {
    return res.status(503).json({
      success: false,
      error: 'Bot manager not initialized',
    });
  }

  const bot = botManager.getBot();
  if (!bot) {
    return res.status(503).json({
      success: false,
      error: 'Bot not connected',
    });
  }

  const players = Object.values(bot.players).map((player: unknown) => {
    const p = player as Record<string, unknown>;
    return {
      username: p.username as string,
      entityId: (p.entity as Record<string, unknown> | undefined)?.id as number | undefined,
      position: (p.entity as Record<string, unknown> | undefined)?.position,
      health: (p.entity as Record<string, unknown> | undefined)?.health as number | undefined,
      gamemode: p.gamemode as string | undefined,
      ping: p.ping as number | undefined,
      isBot: p.username === bot.username,
    };
  });

  const state = botManager.getState();
  res.json({
    success: true,
    data: {
      players,
      count: players.length,
      admins: state.admins,
    },
  });
});

/**
 * Map/World data endpoint
 */
router.get('/map', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  if (!botManager) {
    return res.status(503).json({
      success: false,
      error: 'Bot manager not initialized',
    });
  }

  const bot = botManager.getBot();
  if (!bot || !bot.entity) {
    return res.status(503).json({
      success: false,
      error: 'Bot not spawned',
    });
  }

  const radius = parseInt(req.query.radius as string) || 15;
  const mapBlocks: { x: number; y: number; z: number; name: string }[] = [];

  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      for (let y = -2; y <= 2; y++) {
        const block = bot.blockAt(bot.entity.position.offset(x, y, z));
        if (
          block &&
          block.name !== 'air' &&
          block.name !== 'cave_air' &&
          block.name !== 'void_air'
        ) {
          mapBlocks.push({
            x: Math.floor(block.position.x),
            y: Math.floor(block.position.y),
            z: Math.floor(block.position.z),
            name: block.name,
          });
        }
      }
    }
  }

  // Fix the Entity type overlap issue by using proper typing
  const entities = Object.values(bot.entities)
    .filter((e) => {
      if (!e || e === bot.entity) return false;
      // Check if entity has position with distanceTo method
      const ent = e as { position?: { distanceTo?: (pos: { x: number; y: number; z: number }) => number } };
      return (
        ent.position?.distanceTo &&
        ent.position.distanceTo(bot.entity.position) < radius
      );
    })
    .map((e) => {
      const ent = e as {
        id: number;
        username?: string;
        displayName?: string;
        name?: string;
        type?: string;
        position: { x: number; y: number; z: number; distanceTo: (pos: { x: number; y: number; z: number }) => number };
      };
      return {
        id: ent.id,
        username: ent.username,
        name: ent.displayName || ent.name || ent.username,
        position: {
          x: ent.position.x,
          y: ent.position.y,
          z: ent.position.z,
        },
        type: ent.type || 'unknown',
        isPlayer: ent.type === 'player',
        distance: ent.position.distanceTo(bot.entity.position),
      };
    });

  res.json({
    success: true,
    data: {
      blocks: mapBlocks,
      entities,
      center: bot.entity.position,
      radius,
    },
  });
});

/**
 * Logs endpoint
 */
router.get('/logs', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  if (!botManager) {
    return res.status(503).json({
      success: false,
      error: 'Bot manager not initialized',
    });
  }

  const limit = parseInt(req.query.limit as string) || 100;
  const logs = botManager.getState().logs.slice(-limit);

  res.json({
    success: true,
    data: { logs, total: botManager.getState().logs.length },
  });
});

/**
 * Settings endpoint - GET
 */
router.get('/settings', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  if (!botManager) {
    return res.status(503).json({
      success: false,
      error: 'Bot manager not initialized',
    });
  }

  res.json({
    success: true,
    data: botManager.getState().settings,
  });
});

/**
 * Settings endpoint - UPDATE
 */
router.patch(
  '/settings',
  authMiddleware,
  requireTrusted,
  (req: AuthenticatedRequest, res: Response) => {
    if (!botManager) {
      return res.status(503).json({
        success: false,
        error: 'Bot manager not initialized',
      });
    }

    const state = botManager.getState();
    const newSettings = req.body;

    if (newSettings && typeof newSettings === 'object') {
      Object.assign(state.settings, newSettings);
      res.json({
        success: true,
        data: state.settings,
        message: 'Settings updated',
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Invalid settings object',
      });
    }
  }
);

/**
 * Favorites/locations endpoint - GET
 */
router.get('/locations', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const memory = getMemory();
  res.json({
    success: true,
    data: memory.locations,
  });
});

/**
 * Favorites/locations endpoint - POST (save location)
 */
router.post(
  '/locations',
  authMiddleware,
  requireTrusted,
  (req: AuthenticatedRequest, res: Response) => {
    const { name, position, type } = req.body;

    if (!name || !position) {
      return res.status(400).json({
        success: false,
        error: 'Name and position required',
      });
    }

    const success = rememberLocation(name, position, type || 'waypoint');

    if (success && botManager) {
      const state = botManager.getState();
      state.favorites[name] = position;
    }

    res.json({
      success,
      message: success ? `Location "${name}" saved` : 'Failed to save location',
    });
  }
);

/**
 * Favorites/locations endpoint - DELETE
 */
router.delete(
  '/locations/:name',
  authMiddleware,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    const { name } = req.params;

    // Note: The memory module doesn't have a deleteLocation function
    // We'd need to add one, or manually remove from memory
    const memory = getMemory();
    if (memory.locations[name]) {
      delete memory.locations[name];
      persistMemory();
      res.json({ success: true, message: `Location "${name}" deleted` });
    } else {
      res.status(404).json({ success: false, error: 'Location not found' });
    }
  }
);

/**
 * Memory endpoint - GET all
 */
router.get('/memory', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const memory = getMemory();
  res.json({
    success: true,
    data: memory,
  });
});

/**
 * Memory context endpoint (for AI)
 */
router.get('/memory/context', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const context = getMemoryContext();
  res.json({
    success: true,
    data: { context },
  });
});

/**
 * Memory facts endpoint - GET
 */
router.get('/memory/facts', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const memory = getMemory();
  res.json({
    success: true,
    data: memory.learnedFacts,
  });
});

/**
 * Memory facts endpoint - POST (remember fact)
 */
router.post(
  '/memory/facts',
  authMiddleware,
  requireTrusted,
  (req: AuthenticatedRequest, res: Response) => {
    const { key, fact } = req.body;

    if (!key || !fact) {
      return res.status(400).json({
        success: false,
        error: 'Key and fact required',
      });
    }

    const success = rememberFact(key, fact);
    res.json({
      success,
      message: success ? `Fact "${key}" remembered` : 'Failed to remember fact',
    });
  }
);

/**
 * Memory facts endpoint - DELETE
 */
router.delete(
  '/memory/facts/:key',
  authMiddleware,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    const { key } = req.params;
    const success = forgetFact(key);
    res.json({
      success,
      message: success ? `Fact "${key}" forgotten` : 'Fact not found',
    });
  }
);

/**
 * Memory rules endpoint - GET
 */
router.get('/memory/rules', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const memory = getMemory();
  res.json({
    success: true,
    data: memory.rules,
  });
});

/**
 * Memory rules endpoint - POST (add rule)
 */
router.post(
  '/memory/rules',
  authMiddleware,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    const { rule } = req.body;

    if (!rule) {
      return res.status(400).json({
        success: false,
        error: 'Rule required',
      });
    }

    const success = addRule(rule);
    res.json({
      success,
      message: success ? `Rule added` : 'Rule already exists or failed',
    });
  }
);

/**
 * Memory rules endpoint - DELETE
 */
router.delete(
  '/memory/rules/:rule',
  authMiddleware,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    const { rule } = req.params;
    const success = removeRule(rule);
    res.json({
      success,
      message: success ? `Rule removed` : 'Rule not found',
    });
  }
);

/**
 * Memory current task endpoint
 */
router.get('/memory/task', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const memory = getMemory();
  res.json({
    success: true,
    data: memory.currentTask,
  });
});

/**
 * Memory players endpoint
 */
router.get('/memory/players', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const memory = getMemory();
  res.json({
    success: true,
    data: memory.players,
  });
});

/**
 * Persist memory endpoint
 */
router.post(
  '/memory/save',
  authMiddleware,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const success = persistMemory();
      res.json({
        success,
        message: success ? 'Memory saved' : 'Memory is disabled',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * Clear memory endpoint
 */
router.post(
  '/memory/clear',
  authMiddleware,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    const success = clearMemory();
    res.json({
      success,
      message: success ? 'Memory cleared' : 'Memory is disabled',
    });
  }
);

/**
 * Commands list endpoint
 */
router.get('/commands', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const registry = getCommandRegistry();
  const commands = registry.getAll().map((cmd: unknown) => {
    const c = cmd as Record<string, unknown>;
    return {
      name: c.name as string,
      aliases: (c.aliases as string[]) || [],
      description: c.description as string,
      usage: c.usage as string,
      category: (c.category as string) || 'General',
      permission: (c.permission as { level?: string } | undefined)?.level || 'guest',
      adminOnly: c.adminOnly as boolean | undefined,
      pmOnly: c.pmOnly as boolean | undefined,
      hidden: (c.hidden as boolean) || false,
    };
  });

  res.json({
    success: true,
    data: { commands },
  });
});

/**
 * Execute command endpoint
 */
router.post(
  '/commands/execute',
  authMiddleware,
  rateLimiters.commands,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!botManager) {
      return res.status(503).json({
        success: false,
        error: 'Bot manager not initialized',
      });
    }

    const bot = botManager.getBot();
    if (!bot) {
      return res.status(503).json({
        success: false,
        error: 'Bot not connected',
      });
    }

    const { command, args } = req.body;

    if (!command) {
      return res.status(400).json({
        success: false,
        error: 'Command required',
      });
    }

    try {
      const parsedArgs = Array.isArray(args) ? args : args ? [args] : [];
      const registry = getCommandRegistry();

      const context = createCommandContext(
        bot,
        req.user?.username || 'api',
        parsedArgs,
        req.user?.role === 'admin',
        true,
        () => {
          /* HTTP response doesn't support streaming */
        },
        () => {
          /* HTTP response doesn't support streaming */
        }
      );

      const result = await registry.execute(command, context);

      res.json({
        success: result,
        command,
        message: result ? 'Command executed' : 'Command failed or not found',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * Configuration endpoint
 */
router.get('/config', authMiddleware, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const config = getConfig();
  // Don't expose sensitive data
  const safeConfig = {
    bot: {
      host: config.bot.host,
      port: config.bot.port,
      username: config.bot.username,
      version: config.bot.version,
      auth: config.bot.auth,
    },
    web: {
      port: config.web.port,
      host: config.web.host,
    },
    memory: {
      enabled: config.memory.enabled,
      filePath: config.memory.filePath,
    },
    prefix: config.prefix,
  };

  res.json({
    success: true,
    data: safeConfig,
  });
});

/**
 * Dashboard stats endpoint
 */
router.get('/stats', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  if (!botManager) {
    return res.status(503).json({
      success: false,
      error: 'Bot manager not initialized',
    });
  }

  const bot = botManager.getBot();
  const state = botManager.getState();

  // Use the feature flags directly from botManager (old BotManager interface)
  res.json({
    success: true,
    data: {
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      bot: {
        online: botManager.getBot() !== null,
        username: bot?.username,
        health: bot?.health,
        food: bot?.food,
        position: bot?.entity?.position,
      },
      state: {
        logsCount: state.logs.length,
        inventoryCount: state.inventory.filter(
          (i: unknown) => (i as Record<string, unknown>).name !== 'air'
        ).length,
        favoritesCount: Object.keys(state.favorites).length,
        adminsCount: state.admins.length,
        usersCount: state.users.length,
      },
      features: {
        roaming: (botManager as unknown as Record<string, unknown>).roaming as boolean,
        following: (botManager as unknown as Record<string, unknown>).following as boolean,
        pvpTarget: (botManager as unknown as Record<string, unknown>).pvpTarget as string | null,
        safeMode: (botManager as unknown as Record<string, unknown>).safeModeActive as boolean,
        killAura: (botManager as unknown as Record<string, unknown>).killAuraActive as boolean,
        autoDefense: (botManager as unknown as Record<string, unknown>).autoDefense as boolean,
        autoArmor: (botManager as unknown as Record<string, unknown>).autoArmorEnabled as boolean,
        stealth: (botManager as unknown as Record<string, unknown>).stealthMode as boolean,
        progression: (botManager as unknown as Record<string, unknown>).progressionActive as boolean,
        mining: (botManager as unknown as Record<string, unknown>).minerActive as boolean,
        farming: (botManager as unknown as Record<string, unknown>).isFarming as boolean,
        lumberjack: (botManager as unknown as Record<string, unknown>).lumberjackActive as boolean,
      },
    },
  });
});

/**
 * Chat history endpoint
 */
router.get('/chat', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  // Chat history would be stored in bot manager
  // For now, return recent logs that look like chat
  if (!botManager) {
    return res.status(503).json({
      success: false,
      error: 'Bot manager not initialized',
    });
  }

  const limit = parseInt(req.query.limit as string) || 50;
  const logs = botManager
    .getState()
    .logs.filter((log: string) => log.includes('SERVER') || log.includes('CHAT'))
    .slice(-limit);

  res.json({
    success: true,
    data: { logs },
  });
});

/**
 * Send chat message endpoint
 */
router.post('/chat', authMiddleware, requireTrusted, (req: AuthenticatedRequest, res: Response) => {
  if (!botManager) {
    return res.status(503).json({
      success: false,
      error: 'Bot manager not initialized',
    });
  }

  const bot = botManager.getBot();
  if (!bot) {
    return res.status(503).json({
      success: false,
      error: 'Bot not online',
    });
  }

  const { message } = req.body;
  if (!message) {
    return res.status(400).json({
      success: false,
      error: 'Message required',
    });
  }

  bot.chat(message);
  res.json({
    success: true,
    message: 'Chat message sent',
  });
});

/**
 * Console command endpoint (admin only)
 */
router.post(
  '/console',
  authMiddleware,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    if (!botManager) {
      return res.status(503).json({
        success: false,
        error: 'Bot manager not initialized',
      });
    }

    const bot = botManager.getBot();
    if (!bot) {
      return res.status(503).json({
        success: false,
        error: 'Bot not online',
      });
    }

    const { command } = req.body;
    if (!command) {
      return res.status(400).json({
        success: false,
        error: 'Command required',
      });
    }

    bot.chat(`/${command}`);
    res.json({
      success: true,
      message: `Executed: /${command}`,
    });
  }
);

/**
 * Restart bot endpoint (admin only)
 */
router.post(
  '/bot/restart',
  authMiddleware,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!botManager) {
      return res.status(503).json({
        success: false,
        error: 'Bot manager not initialized',
      });
    }

    try {
      await botManager.shutdown();
      // Note: connectBot doesn't exist on the new BotManager interface
      // The old BotManager had it, but we'll use restart instead if available
      if (typeof (botManager as { connectBot?: () => void }).connectBot === 'function') {
        (botManager as { connectBot?: () => void }).connectBot?.();
      } else if (typeof (botManager as { restart?: () => Promise<void> }).restart === 'function') {
        await (botManager as { restart?: () => Promise<void> }).restart?.();
      }
      res.json({
        success: true,
        message: 'Bot restart initiated',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * Shutdown bot endpoint (admin only)
 */
router.post(
  '/bot/shutdown',
  authMiddleware,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!botManager) {
      return res.status(503).json({
        success: false,
        error: 'Bot manager not initialized',
      });
    }

    try {
      await botManager.shutdown();
      res.json({
        success: true,
        message: 'Bot shut down',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * Error handling middleware
 */
router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[API] Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

/**
 * 404 handler for API routes
 */
router.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'API endpoint not found',
    code: 'NOT_FOUND',
    path: req.path,
  });
});

export { router as apiRouter };