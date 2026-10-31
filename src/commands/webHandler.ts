/**
 * Web Command Handler
 * Handles commands sent from the web dashboard via Socket.io
 */

import type { Server, Socket } from 'socket.io';
import type { Bot } from 'mineflayer';
import type {
  CommandRegistry,
  CommandContext,
  CommandResult,
  WebCommandConfig,
  PermissionLevel,
} from './types';
import type { PermissionManager } from './permissions';

// Extended Bot type to include properties used in web commands
// Note: We don't override any existing Bot properties.
// The base Bot type already has _client, game, time, entity with their proper types.
// We just use the base Bot type and access properties with type assertions when needed.
type ExtendedBot = Bot;

/**
 * Web command request from dashboard
 */
export interface WebCommandRequest {
  /** Command name */
  command: string;
  /** Command arguments */
  args?: string | string[];
  /** Options/flags */
  options?: Record<string, unknown>;
  /** Request ID for response correlation */
  requestId?: string;
  /** Username of the dashboard user */
  username?: string;
  /** Whether to send response via socket */
  respond?: boolean;
}

/**
 * Web command response
 */
export interface WebCommandResponse {
  /** Request ID */
  requestId?: string;
  /** Whether command succeeded */
  success: boolean;
  /** Command result */
  result?: CommandResult;
  /** Output message */
  output?: string;
  /** Error message */
  error?: string;
  /** Execution time */
  executionTime?: number;
}

/**
 * Web command handler class
 * Processes commands from the web dashboard
 */
export class WebCommandHandler {
  private io: Server | null = null;
  private bot: ExtendedBot | null = null;
  private registry: CommandRegistry | null = null;
  private permissionManager: PermissionManager | null = null;
  private config: WebCommandConfig;
  private rateLimitMap = new Map<string, { count: number; windowStart: number }>();
  private commandHistory: {
    command: string;
    username: string;
    timestamp: number;
    success: boolean;
  }[] = [];
  private maxHistorySize = 100;

  constructor(config: Partial<WebCommandConfig> = {}) {
    this.config = {
      enabled: config.enabled !== false,
      allowedOrigins: config.allowedOrigins || [],
      rateLimit: config.rateLimit || 60, // per minute
      requireAuth: config.requireAuth !== false,
    };
  }

  /**
   * Initialize the web command handler
   */
  initialize(
    io: Server,
    bot: Bot,
    registry: CommandRegistry,
    permissionManager: PermissionManager
  ): void {
    this.io = io;
    this.bot = bot as ExtendedBot;
    this.registry = registry;
    this.permissionManager = permissionManager;

    this.setupSocketHandlers();
    console.log('[WEB-COMMANDS] Web command handler initialized');
  }

  /**
   * Setup Socket.io event handlers
   */
  private setupSocketHandlers(): void {
    if (!this.io) return;

    this.io.on('connection', (socket: Socket) => {
      // Handle command from dashboard
      socket.on('send_command', async (data: WebCommandRequest) => {
        await this.handleCommand(socket, data);
      });

      // Handle batch commands
      socket.on('send_commands', async (data: WebCommandRequest[]) => {
        await this.handleBatchCommands(socket, data);
      });

      // Get command list
      socket.on('get_commands', (callback) => {
        if (callback) {
          callback(this.getCommandList());
        }
      });

      // Get command help
      socket.on('get_command_help', (data: { command: string; prefix?: string }, callback) => {
        if (callback) {
          const help = this.registry?.getHelp(data.command, data.prefix || '!') || null;
          callback({ help });
        }
      });

      // Get command history
      socket.on('get_command_history', (callback) => {
        if (callback) {
          callback({ history: this.commandHistory.slice(-50) });
        }
      });

      // Clear command history
      socket.on('clear_command_history', () => {
        this.commandHistory = [];
        socket.emit('command_history_cleared');
      });
    });
  }

  /**
   * Handle a single command from dashboard
   */
  private async handleCommand(socket: Socket, request: WebCommandRequest): Promise<void> {
    const startTime = Date.now();
    const requestId =
      request.requestId || `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const username = request.username || 'dashboard';

    // Check if enabled
    if (!this.config.enabled) {
      this.sendResponse(socket, requestId, {
        success: false,
        error: 'Web commands are disabled',
        executionTime: Date.now() - startTime,
      });
      return;
    }

    // Check rate limit
    if (!this.checkRateLimit(socket.id)) {
      this.sendResponse(socket, requestId, {
        success: false,
        error: 'Rate limit exceeded. Please wait before sending more commands.',
        executionTime: Date.now() - startTime,
      });
      return;
    }

    // Check authentication
    if (this.config.requireAuth && !this.isAuthenticated(socket)) {
      this.sendResponse(socket, requestId, {
        success: false,
        error: 'Authentication required',
        executionTime: Date.now() - startTime,
      });
      return;
    }

    // Validate bot connection
    if (!this.bot || !this.registry) {
      this.sendResponse(socket, requestId, {
        success: false,
        error: 'Bot not connected or registry not available',
        executionTime: Date.now() - startTime,
      });
      return;
    }

    try {
      // Parse arguments
      const args = this.parseArgs(request.args);
      const options = request.options || {};

      // Create command context
      const context = this.createWebContext(username, args, options);

      // Execute command
      const result = await this.registry.execute(request.command, context);

      // Record in history
      this.addToHistory(request.command, username, result.success);

      // Send response
      this.sendResponse(socket, requestId, {
        success: result.success,
        result,
        output: result.success ? 'Command executed successfully' : result.error,
        error: result.error,
        executionTime: result.executionTime,
      });

      // Emit event for logging
      this.io?.emit('command_executed', {
        command: request.command,
        username,
        success: result.success,
        timestamp: Date.now(),
        executionTime: result.executionTime,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[WEB-COMMANDS] Error executing command:', error);

      this.sendResponse(socket, requestId, {
        success: false,
        error: errorMessage,
        executionTime: Date.now() - startTime,
      });

      this.addToHistory(request.command, username, false);
    }
  }

  /**
   * Handle batch commands
   */
  private async handleBatchCommands(socket: Socket, requests: WebCommandRequest[]): Promise<void> {
    const results: WebCommandResponse[] = [];

    for (const request of requests) {
      const requestId =
        request.requestId || `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const startTime = Date.now();

      try {
        const args = this.parseArgs(request.args);
        const options = request.options || {};
        const context = this.createWebContext(request.username || 'dashboard', args, options);

        const result = await this.registry!.execute(request.command, context);

        this.addToHistory(request.command, request.username || 'dashboard', result.success);

        results.push({
          requestId,
          success: result.success,
          result,
          output: result.success ? 'Command executed successfully' : result.error,
          error: result.error,
          executionTime: result.executionTime,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.push({
          requestId,
          success: false,
          error: errorMessage,
          executionTime: Date.now() - startTime,
        });
        this.addToHistory(request.command, request.username || 'dashboard', false);
      }
    }

    socket.emit('batch_command_results', { results });
  }

  /**
   * Create a command context for web commands
   */
  private createWebContext(
    username: string,
    args: string[],
    options: Record<string, unknown>
  ): CommandContext {
    const isAdmin = this.permissionManager?.isAdmin(username) ?? false;
    const isTrusted = this.permissionManager?.isTrusted(username) ?? false;
    const permissionLevel = this.permissionManager?.getPermissionLevel(username) ?? 'guest';

    return {
      bot: this.bot!,
      username,
      args: {
        args,
        options,
        raw: args,
      },
      rawArgs: args,
      isAdmin,
      isTrusted,
      isPM: true, // Web commands are treated as PM
      hasPermission: true, // Registry will check
      reply: (msg: string) =>
        this.broadcastToDashboard('command_output', { message: msg, type: 'reply' }),
      privateReply: (msg: string) =>
        this.broadcastToDashboard('command_output', { message: msg, type: 'private' }),
      error: (msg: string) =>
        this.broadcastToDashboard('command_output', { message: msg, type: 'error' }),
      permissionLevel,
      commandName: '',
      fullCommand: '',
      timestamp: Date.now(),
      metadata: {
        source: 'web',
        dashboardUser: username,
      },
    };
  }

  /**
   * Parse arguments from request
   */
  private parseArgs(args?: string | string[]): string[] {
    if (!args) return [];
    if (Array.isArray(args)) return args;
    if (typeof args === 'string') {
      // Split string arguments respecting quotes
      return this.splitArgs(args);
    }
    return [];
  }

  /**
   * Split arguments respecting quotes
   */
  private splitArgs(str: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      if ((char === '"' || char === "'") && (i === 0 || str[i - 1] !== '\\')) {
        if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else if (char === quoteChar) {
          inQuotes = false;
          quoteChar = '';
        } else {
          current += char;
        }
      } else if (char === ' ' && !inQuotes) {
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      args.push(current);
    }

    return args;
  }

  /**
   * Check rate limit for a socket
   */
  private checkRateLimit(socketId: string): boolean {
    if (!this.config.rateLimit) return true;

    const now = Date.now();
    const windowMs = 60000; // 1 minute

    const entry = this.rateLimitMap.get(socketId);
    if (!entry || now - entry.windowStart >= windowMs) {
      this.rateLimitMap.set(socketId, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= this.config.rateLimit) {
      return false;
    }

    entry.count++;
    return true;
  }

  /**
   * Check if socket is authenticated
   * In a real implementation, this would check session/token
   */
  private isAuthenticated(_socket: Socket): boolean {
    // For now, assume authenticated if connected
    // In production, check socket.handshake.auth or session
    return true;
  }

  /**
   * Send response to dashboard
   */
  private sendResponse(socket: Socket, requestId: string, response: WebCommandResponse): void {
    if (response.requestId === undefined) {
      response.requestId = requestId;
    }
    socket.emit('command_response', response);
  }

  /**
   * Broadcast message to all dashboard clients
   */
  private broadcastToDashboard(event: string, data: unknown): void {
    this.io?.emit(event, data);
  }

  /**
   * Add command to history
   */
  private addToHistory(command: string, username: string, success: boolean): void {
    this.commandHistory.push({
      command,
      username,
      timestamp: Date.now(),
      success,
    });

    // Trim history
    if (this.commandHistory.length > this.maxHistorySize) {
      this.commandHistory.shift();
    }
  }

  /**
   * Get list of available commands for dashboard
   */
  getCommandList(): {
    name: string;
    aliases: string[];
    description: string;
    usage?: string;
    category: string;
    permission: string;
    hidden: boolean;
    deprecated: boolean;
  }[] {
    if (!this.registry) return [];

    return this.registry.getAll().map((cmd) => ({
      name: cmd.name,
      aliases: cmd.aliases || [],
      description: cmd.description,
      usage: cmd.usage,
      category: cmd.category || 'General',
      permission: cmd.permission?.level ?? 'guest',
      hidden: cmd.hidden || false,
      deprecated: cmd.deprecated || false,
    }));
  }

  /**
   * Get command categories
   */
  getCategories(): string[] {
    return this.registry?.getCategories() || [];
  }

  /**
   * Execute a command programmatically (for internal use)
   */
  async executeCommand(
    command: string,
    args: string[] = [],
    options: Record<string, unknown> = {},
    username = 'system'
  ): Promise<CommandResult> {
    if (!this.registry || !this.bot) {
      return {
        success: false,
        found: false,
        error: 'Registry or bot not available',
      };
    }

    const context = this.createWebContext(username, args, options);
    return this.registry.execute(command, context);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<WebCommandConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): WebCommandConfig {
    return { ...this.config };
  }

  /**
   * Get command history
   */
  getHistory(limit = 50): typeof this.commandHistory {
    return this.commandHistory.slice(-limit);
  }

  /**
   * Clear command history
   */
  clearHistory(): void {
    this.commandHistory = [];
  }

  /**
   * Clear rate limits
   */
  clearRateLimits(): void {
    this.rateLimitMap.clear();
  }
}

/**
 * Create a web command handler instance
 */
export function createWebCommandHandler(config?: Partial<WebCommandConfig>): WebCommandHandler {
  return new WebCommandHandler(config);
}

/**
 * Web command middleware for Express/Socket.io integration
 */
export function createWebCommandMiddleware(handler: WebCommandHandler) {
  return (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    // Add helper to execute commands from HTTP endpoints
    req.executeBotCommand = async (
      command: string,
      args: string[] = [],
      options: Record<string, unknown> = {}
    ) => {
      return handler.executeCommand(
        command,
        args,
        options,
        (req.user as { username?: string } | undefined)?.username || 'api'
      );
    };
    next();
  };
}

/**
 * Dashboard command definitions for web-only commands
 */
export const WebOnlyCommands = {
  /**
   * Get bot status
   */
  status: {
    name: 'status',
    description: 'Get detailed bot status',
    category: 'Web',
    permission: { level: 'guest' as PermissionLevel },
    execute: async (context: CommandContext) => {
      const bot = context.bot as ExtendedBot;
      if (!bot) {
        context.error('Bot not connected');
        return;
      }
      const pos = bot.entity?.position;
      const latency = bot._client?.latency;
      // Use type assertions for properties that exist on Bot but with different types
      const dimension = (bot as unknown as { game?: { dimension?: string } }).game?.dimension;
      const timeOfDay = (bot as unknown as { time?: { timeOfDay?: number } }).time?.timeOfDay;

      context.privateReply(
        `🤖 **Bot Status**\n` +
          `Online: ${bot.entity ? 'Yes' : 'No'}\n` +
          `Username: ${bot.username}\n` +
          `Health: ${bot.health}/20\n` +
          `Food: ${bot.food}/20\n` +
          `Position: ${pos ? `X:${Math.floor(pos.x)} Y:${Math.floor(pos.y)} Z:${Math.floor(pos.z)}` : 'Unknown'}\n` +
          `Dimension: ${dimension || 'Unknown'}\n` +
          `Time: ${timeOfDay !== undefined ? timeOfDay : 'Unknown'}\n` +
          `Ping: ${latency !== undefined ? `${latency}ms` : 'Unknown'}`
      );
    },
  },

  /**
   * Get inventory
   */
  inventory: {
    name: 'inventory',
    description: 'Get bot inventory',
    category: 'Web',
    permission: { level: 'guest' as PermissionLevel },
    arguments: [
      {
        name: 'slot',
        description: 'Specific slot to inspect',
        required: false,
        type: 'number',
      },
    ],
    execute: async (context: CommandContext) => {
      const bot = context.bot as ExtendedBot;
      if (!bot) {
        context.error('Bot not connected');
        return;
      }

      const items = bot.inventory.items();
      if (items.length === 0) {
        context.privateReply('📦 Inventory is empty');
        return;
      }

      const slotArg = context.args.args[0] as number | undefined;
      if (slotArg !== undefined && slotArg >= 0 && slotArg < 36) {
        const item = bot.inventory.slots[slotArg];
        if (item) {
          context.privateReply(
            `📦 Slot ${slotArg}: ${item.count}x ${item.displayName || item.name}`
          );
        } else {
          context.privateReply(`📦 Slot ${slotArg}: Empty`);
        }
        return;
      }

      const inventoryList = items
        .map((item, i) => `${i}: ${item.count}x ${item.displayName || item.name}`)
        .join('\n');
      context.privateReply(`📦 **Inventory** (${items.length}/36 slots used):\n${inventoryList}`);
    },
  },

  /**
   * Send raw chat message
   */
  say: {
    name: 'say',
    description: 'Make the bot say something in chat',
    category: 'Web',
    permission: { level: 'trusted' as PermissionLevel },
    arguments: [
      {
        name: 'message',
        description: 'Message to send',
        required: true,
        type: 'string',
        greedy: true,
      },
    ],
    execute: async (context: CommandContext) => {
      const bot = context.bot as ExtendedBot;
      if (!bot) {
        context.error('Bot not connected');
        return;
      }

      const message = context.args.args.join(' ');
      if (!message) {
        context.error('No message provided');
        return;
      }

      bot.chat(message);
      context.privateReply(`✅ Sent: ${message}`);
    },
  },

  /**
   * Execute console command
   */
  console: {
    name: 'console',
    description: 'Execute a server console command (requires op)',
    category: 'Web',
    permission: { level: 'admin' as PermissionLevel },
    arguments: [
      {
        name: 'command',
        description: 'Command to execute (without /)',
        required: true,
        type: 'string',
        greedy: true,
      },
    ],
    execute: async (context: CommandContext) => {
      const bot = context.bot as ExtendedBot;
      if (!bot) {
        context.error('Bot not connected');
        return;
      }

      const command = context.args.args.join(' ');
      if (!command) {
        context.error('No command provided');
        return;
      }

      bot.chat(`/${command}`);
      context.privateReply(`✅ Executed: /${command}`);
    },
  },
};

/**
 * Register web-only commands to registry
 */
export function registerWebCommands(registry: CommandRegistry): void {
  for (const [, cmd] of Object.entries(WebOnlyCommands)) {
    registry.register(cmd as Parameters<typeof registry.register>[0]);
  }
}
