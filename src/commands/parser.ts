/**
 * Chat Command Parser
 * Parses chat messages and extracts commands with support for multiple formats
 */

import type { Bot } from 'mineflayer';
import type {
  ParsedMessage,
  ChatParserConfig,
  CommandContext,
  PermissionLevel,
  CommandRegistry,
} from './types';
import type { PermissionManager } from './permissions';

/**
 * Message parser result
 */
export interface MessageParseResult {
  /** Whether a command was found */
  isCommand: boolean;
  /** Parsed message data */
  message: ParsedMessage;
  /** Command name if found */
  commandName?: string;
  /** Command arguments */
  args?: string[];
  /** Whether it's an admin command */
  isAdminCommand?: boolean;
  /** Prefix used */
  prefix?: string;
}

/**
 * Chat parser class
 * Handles parsing of various chat message formats
 */
export class ChatParser {
  private config: ChatParserConfig;
  private bot: Bot | null = null;
  private permissionManager: PermissionManager | null = null;
  private registry: CommandRegistry | null = null;

  constructor(config: Partial<ChatParserConfig> = {}) {
    this.config = {
      publicPrefix: config.publicPrefix || '!',
      adminPrefix: config.adminPrefix || '$',
      ignoreBotMessages: config.ignoreBotMessages !== false,
      customParsers: config.customParsers || [],
    };
  }

  /**
   * Set bot instance
   */
  setBot(bot: Bot): void {
    this.bot = bot;
  }

  /**
   * Set permission manager
   */
  setPermissionManager(manager: PermissionManager): void {
    this.permissionManager = manager;
  }

  /**
   * Set command registry
   */
  setRegistry(registry: CommandRegistry): void {
    this.registry = registry;
  }

  /**
   * Update parser configuration
   */
  updateConfig(config: Partial<ChatParserConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Parse a raw chat message
   */
  parse(raw: string): MessageParseResult | null {
    // Parse the message format
    const message = this.parseMessageFormat(raw);
    if (!message) return null;

    // Ignore bot's own messages if configured
    if (this.config.ignoreBotMessages && this.bot && message.username === this.bot.username) {
      return null;
    }

    // Check for command prefixes
    const commandCheck = this.checkCommandPrefix(message.content);
    if (!commandCheck.isCommand) {
      return {
        isCommand: false,
        message,
      };
    }

    // Extract command and arguments
    const { commandName, args, isAdminCommand, prefix } = commandCheck;

    // Check if command exists in registry
    if (this.registry && commandName) {
      const commandExists = this.registry.has(commandName);
      // Command existence is checked but not enforced here - registry.execute will handle it
      void commandExists; // Suppress unused variable warning
    }

    return {
      isCommand: true,
      message,
      commandName,
      args,
      isAdminCommand,
      prefix,
    };
  }

  /**
   * Parse message format to extract username and content
   * Supports multiple formats:
   * - <User> Message
   * - [User -> me] Message (PM)
   * - User whispers to you: Message
   * - User » Message
   * - * User Message (action)
   */
  private parseMessageFormat(raw: string): ParsedMessage | null {
    const trimmed = raw.trim();

    // Try custom parsers first
    if (this.config.customParsers) {
      for (const parser of this.config.customParsers) {
        const result = parser(trimmed);
        if (result) return result;
      }
    }

    // Format: [User -> me] Private Message
    const pmMatch = trimmed.match(/^\[(.+?) -> me\]\s*(.+)$/);
    if (pmMatch) {
      return {
        username: pmMatch[1],
        content: pmMatch[2],
        type: 'pm',
        raw: trimmed,
      };
    }

    // Format: User whispers to you: Message
    const whisperMatch = trimmed.match(/^(.+?)\s+whispers? to you:\s*(.+)$/i);
    if (whisperMatch) {
      return {
        username: whisperMatch[1],
        content: whisperMatch[2],
        type: 'whisper',
        raw: trimmed,
      };
    }

    // Format: <User> Message (standard)
    const chatMatch = trimmed.match(/^<(.+?)>\s*(.+)$/);
    if (chatMatch) {
      return {
        username: chatMatch[1],
        content: chatMatch[2],
        type: 'chat',
        raw: trimmed,
      };
    }

    // Format: User » Message (alternate)
    if (trimmed.includes('»')) {
      const parts = trimmed.split('»');
      if (parts.length >= 2) {
        const userPart = parts[0].trim();
        const msgPart = parts.slice(1).join('»').trim();
        // Extract username from userPart
        const userMatch = userPart.match(/([A-Za-z0-9_]{3,16})/);
        if (userMatch) {
          return {
            username: userMatch[1],
            content: msgPart,
            type: 'chat',
            raw: trimmed,
          };
        }
      }
    }

    // Format: * User Message (action/emote)
    const actionMatch = trimmed.match(/^\*\s*(.+?)\s+(.+)$/);
    if (actionMatch) {
      return {
        username: actionMatch[1],
        content: actionMatch[2],
        type: 'chat',
        raw: trimmed,
      };
    }

    // Format: [Server] Message
    const serverMatch = trimmed.match(/^\[(Server|Console|System)\]\s*(.+)$/i);
    if (serverMatch) {
      return {
        username: serverMatch[1],
        content: serverMatch[2],
        type: 'system',
        raw: trimmed,
      };
    }

    // Format: (User) Message - some servers use this
    const parenMatch = trimmed.match(/^\((.+?)\)\s*(.+)$/);
    if (parenMatch) {
      return {
        username: parenMatch[1],
        content: parenMatch[2],
        type: 'chat',
        raw: trimmed,
      };
    }

    // Unknown format
    return null;
  }

  /**
   * Check if message starts with a command prefix
   */
  private checkCommandPrefix(content: string): {
    isCommand: boolean;
    commandName?: string;
    args?: string[];
    isAdminCommand?: boolean;
    prefix?: string;
  } {
    const trimmed = content.trim();

    // Check admin prefix first (higher priority)
    if (trimmed.startsWith(this.config.adminPrefix)) {
      const contentWithoutPrefix = trimmed.slice(this.config.adminPrefix.length).trim();
      if (!contentWithoutPrefix) {
        return { isCommand: false };
      }

      const parts = this.splitArgs(contentWithoutPrefix);
      return {
        isCommand: true,
        commandName: parts[0].toLowerCase(),
        args: parts.slice(1),
        isAdminCommand: true,
        prefix: this.config.adminPrefix,
      };
    }

    // Check public prefix
    if (trimmed.startsWith(this.config.publicPrefix)) {
      const contentWithoutPrefix = trimmed.slice(this.config.publicPrefix.length).trim();
      if (!contentWithoutPrefix) {
        return { isCommand: false };
      }

      const parts = this.splitArgs(contentWithoutPrefix);
      return {
        isCommand: true,
        commandName: parts[0].toLowerCase(),
        args: parts.slice(1),
        isAdminCommand: false,
        prefix: this.config.publicPrefix,
      };
    }

    // Check for slash commands (Minecraft native)
    if (trimmed.startsWith('/')) {
      const contentWithoutPrefix = trimmed.slice(1).trim();
      if (!contentWithoutPrefix) {
        return { isCommand: false };
      }

      const parts = this.splitArgs(contentWithoutPrefix);
      return {
        isCommand: true,
        commandName: parts[0].toLowerCase(),
        args: parts.slice(1),
        isAdminCommand: false,
        prefix: '/',
      };
    }

    return { isCommand: false };
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
   * Create a command context from parsed message
   */
  createContext(
    parseResult: MessageParseResult,
    replyFn: (msg: string) => void,
    privateReplyFn: (msg: string) => void
  ): CommandContext | null {
    if (!parseResult.isCommand || !parseResult.commandName || !this.bot) {
      return null;
    }

    const { message, args, isAdminCommand, prefix } = parseResult;
    const username = message.username;

    // Determine permission level
    let permissionLevel: PermissionLevel = 'guest';
    let isAdmin = false;
    let isTrusted = false;

    if (this.permissionManager) {
      permissionLevel = this.permissionManager.getPermissionLevel(username);
      isAdmin = permissionLevel === 'admin';
      isTrusted = permissionLevel === 'trusted' || isAdmin;
    } else if (this.bot) {
      // Fallback: check admin sessions
      // This would need access to adminSessions from bot.js
      isAdmin = false; // Will be set by caller
      isTrusted = false;
    }

    // Determine if PM
    const isPM = message.type === 'pm' || message.type === 'whisper';

    // Check if command requires admin and user is not admin
    if (this.registry && parseResult.commandName) {
      const command = this.registry.get(parseResult.commandName);
      if (command?.permission?.level === 'admin' && !isAdmin) {
        // Command requires admin but user is not admin
        // We still create context but registry.execute will handle permission check
      }
    }

    return {
      bot: this.bot,
      username,
      args: {
        args: args || [],
        options: {},
        raw: args || [],
      },
      rawArgs: args || [],
      isAdmin,
      isTrusted,
      isPM,
      hasPermission: true, // Will be checked by registry
      reply: replyFn,
      privateReply: privateReplyFn,
      error: (msg: string) => privateReplyFn(`❌ ${msg}`),
      permissionLevel,
      commandName: parseResult.commandName,
      fullCommand: `${prefix}${parseResult.commandName} ${(args || []).join(' ')}`.trim(),
      timestamp: Date.now(),
      metadata: {
        messageType: message.type,
        isAdminCommand,
        rawMessage: message.raw,
      },
    };
  }
}

/**
 * Create a chat parser instance
 */
export function createChatParser(config?: Partial<ChatParserConfig>): ChatParser {
  return new ChatParser(config);
}

/**
 * Default message format parsers for common server types
 */
export const DefaultMessageParsers = {
  /**
   * Parser for standard Minecraft chat format
   * <Username> Message
   */
  standard: (raw: string): ParsedMessage | null => {
    const match = raw.match(/^<(.+?)>\s*(.+)$/);
    if (match) {
      return {
        username: match[1],
        content: match[2],
        type: 'chat',
        raw,
      };
    }
    return null;
  },

  /**
   * Parser for Essentials-style chat
   * [World] Username: Message
   */
  essentials: (raw: string): ParsedMessage | null => {
    const match = raw.match(/^\[.+?\]\s*(.+?):\s*(.+)$/);
    if (match) {
      return {
        username: match[1],
        content: match[2],
        type: 'chat',
        raw,
      };
    }
    return null;
  },

  /**
   * Parser for LuckPerms-style chat
   * [Rank] Username: Message
   */
  luckperms: (raw: string): ParsedMessage | null => {
    const match = raw.match(/^\[.+?\]\s*(.+?):\s*(.+)$/);
    if (match) {
      return {
        username: match[1],
        content: match[2],
        type: 'chat',
        raw,
      };
    }
    return null;
  },

  /**
   * Parser for DiscordSRV relay format
   * [Discord] Username: Message
   */
  discordsrv: (raw: string): ParsedMessage | null => {
    const match = raw.match(/^\[Discord\]\s*(.+?):\s*(.+)$/);
    if (match) {
      return {
        username: match[1],
        content: match[2],
        type: 'chat',
        raw,
      };
    }
    return null;
  },

  /**
   * Parser for Tellraw/JSON message format
   * Handles messages like: {"text":"[Admin] User: Hello"}
   */
  tellraw: (raw: string): ParsedMessage | null => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.text) {
        const text = parsed.text;
        const match = text.match(/^\[.+?\]\s*(.+?):\s*(.+)$/);
        if (match) {
          return {
            username: match[1],
            content: match[2],
            type: 'chat',
            raw,
          };
        }
        // Try standard format
        const standardMatch = text.match(/^<(.+?)>\s*(.+)$/);
        if (standardMatch) {
          return {
            username: standardMatch[1],
            content: standardMatch[2],
            type: 'chat',
            raw,
          };
        }
      }
    } catch {
      // Not JSON
    }
    return null;
  },
};

/**
 * Combined parser that tries multiple formats
 */
export function createMultiFormatParser(
  config: Partial<ChatParserConfig> = {},
  customParsers: ((raw: string) => ParsedMessage | null)[] = []
): ChatParser {
  const allParsers = [
    DefaultMessageParsers.standard,
    DefaultMessageParsers.essentials,
    DefaultMessageParsers.luckperms,
    DefaultMessageParsers.discordsrv,
    DefaultMessageParsers.tellraw,
    ...customParsers,
  ];

  return new ChatParser({
    ...config,
    customParsers: allParsers,
  });
}

/**
 * Command argument parser for chat input
 * Parses raw chat arguments into structured data
 */
export class ChatArgumentParser {
  /**
   * Parse arguments from chat message
   * Handles quoted strings, escapes, etc.
   */
  static parseArgs(raw: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';
    let escaped = false;

    for (const char of raw) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }

      if (char === '\\' && inQuotes) {
        escaped = true;
        continue;
      }

      if ((char === '"' || char === "'") && !escaped) {
        if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else if (char === quoteChar) {
          inQuotes = false;
          quoteChar = '';
        } else {
          current += char;
        }
      } else if ((char === ' ' || char === '\t') && !inQuotes) {
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
   * Join arguments back into a string (for logging/re-display)
   */
  static joinArgs(args: string[]): string {
    return args
      .map((arg) => {
        if (arg.includes(' ') || arg.includes('"') || arg.includes("'")) {
          // Escape quotes
          const escaped = arg.replace(/"/g, '\\"');
          return `"${escaped}"`;
        }
        return arg;
      })
      .join(' ');
  }

  /**
   * Parse key=value pairs from arguments
   */
  static parseKeyValue(args: string[]): Record<string, string> {
    const result: Record<string, string> = {};

    for (const arg of args) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex > 0) {
        const key = arg.slice(0, eqIndex);
        const value = arg.slice(eqIndex + 1);
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Extract flags from arguments (--flag or -f)
   */
  static parseFlags(args: string[]): {
    flags: Record<string, boolean | string>;
    positional: string[];
  } {
    const flags: Record<string, boolean | string> = {};
    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg.startsWith('--')) {
        const flagName = arg.slice(2);
        const eqIndex = flagName.indexOf('=');
        if (eqIndex > 0) {
          flags[flagName.slice(0, eqIndex)] = flagName.slice(eqIndex + 1);
        } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          flags[flagName] = args[++i];
        } else {
          flags[flagName] = true;
        }
      } else if (arg.startsWith('-') && arg.length > 1) {
        // Short flags: -abc or -a -b -c
        const shortFlags = arg.slice(1).split('');
        for (const flag of shortFlags) {
          flags[flag] = true;
        }
      } else {
        positional.push(arg);
      }
    }

    return { flags, positional };
  }
}