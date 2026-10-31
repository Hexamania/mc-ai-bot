/**
 * Help System
 * Comprehensive help generation and display for commands
 */

import type {
  CommandDefinition,
  CommandRegistry,
  PermissionLevel,
  CommandArgument,
  CommandOption,
} from './types';

/**
 * Help theme configuration
 */
export interface HelpTheme {
  /** Header color/marker */
  header: string;
  /** Sub-header color/marker */
  subHeader: string;
  /** Command name color/marker */
  command: string;
  /** Argument color/marker */
  argument: string;
  /** Option color/marker */
  option: string;
  /** Description color/marker */
  description: string;
  /** Error color/marker */
  error: string;
  /** Success color/marker */
  success: string;
  /** Warning color/marker */
  warning: string;
  /** Info color/marker */
  info: string;
  /** Bullet point */
  bullet: string;
  /** Separator */
  separator: string;
}

/**
 * Default themes
 */
export const HelpThemes = {
  /** Markdown-style theme (for Discord/rich chat) */
  markdown: {
    header: '## ',
    subHeader: '### ',
    command: '**',
    argument: '`',
    option: '`',
    description: '',
    error: '❌ ',
    success: '✅ ',
    warning: '⚠️ ',
    info: 'ℹ️ ',
    bullet: '• ',
    separator: '---',
  } as HelpTheme,

  /** Plain text theme (for console/terminal) */
  plain: {
    header: '=== ',
    subHeader: '--- ',
    command: '',
    argument: '<',
    option: '--',
    description: '',
    error: '[ERROR] ',
    success: '[OK] ',
    warning: '[WARN] ',
    info: '[INFO] ',
    bullet: '- ',
    separator: '====================',
  } as HelpTheme,

  /** Minecraft chat theme (color codes) */
  minecraft: {
    header: '§6§l',
    subHeader: '§e§l',
    command: '§a',
    argument: '§b',
    option: '§d',
    description: '§7',
    error: '§c',
    success: '§a',
    warning: '§e',
    info: '§b',
    bullet: '§7- ',
    separator: '§7§m--------------------',
  } as HelpTheme,
};

/**
 * Help formatter options
 */
export interface HelpFormatterOptions {
  /** Theme to use */
  theme: HelpTheme;
  /** Command prefix */
  prefix: string;
  /** Show hidden commands */
  showHidden: boolean;
  /** Show deprecated commands */
  showDeprecated: boolean;
  /** Max width for text wrapping */
  maxWidth: number;
  /** Whether to use categories */
  useCategories: boolean;
  /** Custom category order */
  categoryOrder?: string[];
}

/**
 * Help formatter class
 * Generates formatted help text for commands
 */
export class HelpFormatter {
  private registry: CommandRegistry;
  private options: HelpFormatterOptions;

  constructor(registry: CommandRegistry, options: Partial<HelpFormatterOptions> = {}) {
    this.registry = registry;
    this.options = {
      theme: HelpThemes.markdown,
      prefix: '!',
      showHidden: false,
      showDeprecated: false,
      maxWidth: 120,
      useCategories: true,
      ...options,
    };
  }

  /**
   * Get formatted help for all commands
   */
  getFullHelp(userLevel: PermissionLevel = 'guest'): string {
    const commands = this.getFilteredCommands(userLevel);

    if (commands.length === 0) {
      return this.formatMessage('No commands available for your permission level.', 'warning');
    }

    if (this.options.useCategories) {
      return this.getCategorizedHelp(commands, userLevel);
    } else {
      return this.getFlatHelp(commands);
    }
  }

  /**
   * Get help for a specific command
   */
  getCommandHelp(commandName: string, prefix?: string): string | null {
    const command = this.registry.get(commandName);
    if (!command) return null;

    const p = prefix || this.options.prefix;
    return this.formatCommandHelp(command, p);
  }

  /**
   * Get categorized help
   */
  private getCategorizedHelp(commands: CommandDefinition[], userLevel: PermissionLevel): string {
    const categorized: Record<string, CommandDefinition[]> = {};

    for (const cmd of commands) {
      const category = cmd.category || 'General';
      if (!categorized[category]) {
        categorized[category] = [];
      }
      categorized[category].push(cmd);
    }

    const theme = this.options.theme;
    let output = '';

    // Header
    output += `${theme.header}Available Commands${theme.separator}\n`;
    output += `${theme.info}Prefix: \`${this.options.prefix}\` | Your level: ${userLevel}\n\n`;

    // Sort categories
    const categoryOrder = this.options.categoryOrder || Object.keys(categorized).sort();

    for (const category of categoryOrder) {
      const cmds = categorized[category];
      if (!cmds || cmds.length === 0) continue;

      output += `${theme.subHeader}${category}${theme.separator}\n`;

      for (const cmd of cmds.sort((a, b) => a.name.localeCompare(b.name))) {
        output += this.formatCommandSummary(cmd);
      }
      output += '\n';
    }

    output += `${theme.info}Use \`${this.options.prefix}help <command>\` for details on a specific command.`;

    return output;
  }

  /**
   * Get flat (non-categorized) help
   */
  private getFlatHelp(commands: CommandDefinition[]): string {
    const theme = this.options.theme;
    let output = '';

    output += `${theme.header}Available Commands${theme.separator}\n`;
    output += `${theme.info}Prefix: \`${this.options.prefix}\`\n\n`;

    for (const cmd of commands.sort((a, b) => a.name.localeCompare(b.name))) {
      output += this.formatCommandSummary(cmd);
    }

    output += `\n${theme.info}Use \`${this.options.prefix}help <command>\` for details.`;

    return output;
  }

  /**
   * Format a command summary (for command list)
   */
  private formatCommandSummary(command: CommandDefinition): string {
    const theme = this.options.theme;
    const p = this.options.prefix;

    let line = `${theme.bullet}${theme.command}${p}${command.name}${theme.command}`;

    if (command.aliases && command.aliases.length > 0) {
      const aliases = command.aliases.map((a) => `${p}${a}`).join(', ');
      line += ` ${theme.description}(${aliases})`;
    }

    if (command.shortDescription) {
      line += ` ${theme.description}- ${command.shortDescription}`;
    } else if (command.description) {
      // Use first sentence of description
      const firstSentence = command.description.split('.')[0];
      line += ` ${theme.description}- ${firstSentence}`;
    }

    // Permission indicator
    if (command.permission?.level !== 'guest') {
      line += ` ${theme.warning}[${command.permission?.level.toUpperCase()}]`;
    }

    if (command.deprecated) {
      line += ` ${theme.error}[DEPRECATED]`;
    }

    return line + '\n';
  }

  /**
   * Format detailed help for a single command
   */
  private formatCommandHelp(command: CommandDefinition, prefix: string): string {
    const theme = this.options.theme;
    let output = '';

    // Header
    output += `${theme.header}${prefix}${command.name}${theme.separator}\n`;

    // Description
    if (command.description) {
      output += `${theme.description}${command.description}\n\n`;
    }

    // Usage
    output += `${theme.subHeader}Usage${theme.separator}\n`;
    output += `${theme.command}${this.formatUsage(command, prefix)}${theme.command}\n\n`;

    // Aliases
    if (command.aliases && command.aliases.length > 0) {
      output += `${theme.subHeader}Aliases${theme.separator}\n`;
      for (const alias of command.aliases) {
        output += `${theme.bullet}${theme.command}${prefix}${alias}${theme.command}\n`;
      }
      output += '\n';
    }

    // Arguments
    if (command.arguments && command.arguments.length > 0) {
      output += `${theme.subHeader}Arguments${theme.separator}\n`;
      for (const arg of command.arguments) {
        output += this.formatArgumentHelp(arg);
      }
      output += '\n';
    }

    // Options
    if (command.options && command.options.length > 0) {
      output += `${theme.subHeader}Options${theme.separator}\n`;
      for (const opt of command.options) {
        output += this.formatOptionHelp(opt);
      }
      output += '\n';
    }

    // Examples
    if (command.examples && command.examples.length > 0) {
      output += `${theme.subHeader}Examples${theme.separator}\n`;
      for (const example of command.examples) {
        output += `${theme.bullet}${theme.command}${prefix}${example}${theme.command}\n`;
      }
      output += '\n';
    }

    // Permissions
    output += `${theme.subHeader}Permissions${theme.separator}\n`;
    const permLevel = command.permission?.level ?? 'guest';
    output += `${theme.bullet}Level: ${theme.warning}${permLevel}${theme.description}\n`;
    if (command.permission?.pmOnly)
      output += `${theme.bullet}PM only: ${theme.warning}Yes${theme.description}\n`;
    if (command.permission?.publicOnly)
      output += `${theme.bullet}Public only: ${theme.warning}Yes${theme.description}\n`;
    if (command.permission?.allowedUsers?.length) {
      output += `${theme.bullet}Allowed users: ${command.permission.allowedUsers.join(', ')}\n`;
    }
    if (command.permission?.deniedUsers?.length) {
      output += `${theme.bullet}Denied users: ${command.permission.deniedUsers.join(', ')}\n`;
    }

    // Cooldown
    if (command.cooldown) {
      output += `\n${theme.subHeader}Cooldown${theme.separator}\n`;
      output += `${theme.bullet}${command.cooldown / 1000}s`;
      if (command.maxUses) {
        output += ` (max ${command.maxUses} uses per cooldown)`;
      }
      output += '\n';
    }

    // Deprecation notice
    if (command.deprecated) {
      output += `\n${theme.error}${theme.warning} DEPRECATED: ${command.deprecationMessage || 'This command is deprecated.'}${theme.description}\n`;
    }

    return output;
  }

  /**
   * Format argument help
   */
  private formatArgumentHelp(arg: CommandArgument): string {
    const theme = this.options.theme;
    const required = arg.required ? 'required' : 'optional';

    let typeStr: string = arg.type;
    if (arg.type === 'enum' && arg.enumValues) {
      typeStr = arg.enumValues.join(' | ');
    }

    let line = `${theme.bullet}${theme.argument}${arg.name}${theme.argument} ${theme.description}(${typeStr}, ${required})`;

    if (arg.defaultValue !== undefined) {
      line += ` ${theme.info}[default: ${arg.defaultValue}]`;
    }
    if (arg.greedy) {
      line += ` ${theme.info}[greedy]`;
    }
    line += `: ${arg.description}`;

    return line + '\n';
  }

  /**
   * Format option help
   */
  private formatOptionHelp(opt: CommandOption): string {
    const theme = this.options.theme;
    const aliasStr = opt.alias ? `, ${theme.option}-${opt.alias}${theme.option}` : '';
    const valueStr = opt.hasValue ? ` ${theme.argument}<${opt.type}>${theme.argument}` : '';

    let line = `${theme.bullet}${theme.option}--${opt.name}${theme.option}${aliasStr}${valueStr}`;
    if (opt.defaultValue !== undefined) {
      line += ` ${theme.info}[default: ${opt.defaultValue}]`;
    }
    line += `: ${opt.description}`;

    return line + '\n';
  }

  /**
   * Format usage string
   */
  private formatUsage(command: CommandDefinition, prefix: string): string {
    let usage = `${prefix}${command.name}`;

    if (command.arguments && command.arguments.length > 0) {
      const argStrings = command.arguments.map((arg) => {
        const bracket = arg.required ? '<' : '[';
        const endBracket = arg.required ? '>' : ']';
        let argStr = `${bracket}${arg.name}${endBracket}`;
        if (arg.greedy) argStr += '...';
        return argStr;
      });
      usage += ` ${argStrings.join(' ')}`;
    }

    if (command.options && command.options.length > 0) {
      usage += ` [options...]`;
    }

    return usage;
  }

  /**
   * Get filtered commands based on user permission level
   */
  private getFilteredCommands(userLevel: PermissionLevel): CommandDefinition[] {
    const allCommands = this.registry.getAll();
    const hierarchy: Record<PermissionLevel, number> = {
      guest: 0,
      trusted: 1,
      admin: 2,
    };
    const userLevelValue = hierarchy[userLevel];

    return allCommands.filter((cmd) => {
      // Skip hidden unless showHidden
      if (cmd.hidden && !this.options.showHidden) return false;
      // Skip deprecated unless showDeprecated
      if (cmd.deprecated && !this.options.showDeprecated) return false;
      // Check permission level
      const cmdLevelValue = hierarchy[cmd.permission?.level ?? 'guest'];
      return cmdLevelValue <= userLevelValue;
    });
  }

  /**
   * Format a message with theme
   */
  private formatMessage(message: string, type: 'error' | 'success' | 'warning' | 'info'): string {
    const theme = this.options.theme;
    const prefix = theme[type];
    return `${prefix}${message}${theme.description}`;
  }

  /**
   * Update formatter options
   */
  setOptions(options: Partial<HelpFormatterOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Set theme
   */
  setTheme(theme: HelpTheme): void {
    this.options.theme = theme;
  }

  /**
   * Get current formatter options
   */
  getOptions(): HelpFormatterOptions {
    return { ...this.options };
  }
}

/**
 * Help command builder
 * Creates a help command with customizable behavior
 */
export function createHelpCommand(
  registry: CommandRegistry,
  formatter: HelpFormatter,
  prefix: string
): CommandDefinition {
  return {
    name: 'help',
    aliases: ['h', 'commands', 'cmds'],
    description: 'Show available commands or get help for a specific command',
    usage: '[command]',
    shortDescription: 'Show command list or get detailed help',
    category: 'General',
    permission: { level: 'guest' },
    arguments: [
      {
        name: 'command',
        description: 'Command to get help for',
        required: false,
        type: 'string',
      },
    ],
    options: [
      {
        name: 'category',
        alias: 'c',
        description: 'Show commands in a specific category',
        hasValue: true,
        type: 'string',
      },
      {
        name: 'all',
        alias: 'a',
        description: 'Show all commands including hidden/deprecated',
        hasValue: false,
        type: 'boolean',
      },
    ],
    examples: ['help', 'help ping', 'help follow', 'help --category Movement', 'help --all'],
    execute: async (context) => {
      const { args, privateReply, permissionLevel } = context;

      // Check for category option
      if (args.options.category) {
        const category = args.options.category as string;
        const commands = registry.getByCategory(category);
        if (commands.length === 0) {
          privateReply(`❌ No commands found in category: ${category}`);
          return;
        }
        const oldUseCategories = formatter.getOptions().useCategories;
        formatter.setOptions({ useCategories: false });
        privateReply(formatter.getFullHelp(permissionLevel));
        formatter.setOptions({ useCategories: oldUseCategories });
        return;
      }

      // Check for all option
      if (args.options.all) {
        const oldOptions = formatter.getOptions();
        formatter.setOptions({ showHidden: true, showDeprecated: true });
        privateReply(formatter.getFullHelp(permissionLevel));
        formatter.setOptions({ showHidden: oldOptions.showHidden, showDeprecated: oldOptions.showDeprecated });
        return;
      }

      // Specific command help
      if (args.args.length > 0) {
        const help = formatter.getCommandHelp(args.args[0] as string, prefix);
        if (help) {
          privateReply(help);
        } else {
          privateReply(`❌ Command "${args.args[0]}" not found.`);
        }
        return;
      }

      // Full help
      privateReply(formatter.getFullHelp(permissionLevel));
    },
    autocomplete: async (context, partial) => {
      const commands = registry.getCommandNames();
      return commands.filter((cmd) => cmd.startsWith(partial.toLowerCase()));
    },
  };
}

/**
 * Create a categories command
 */
export function createCategoriesCommand(
  registry: CommandRegistry,
  _prefix: string
): CommandDefinition {
  return {
    name: 'categories',
    aliases: ['cats', 'commandcategories'],
    description: 'List all command categories',
    shortDescription: 'List all command categories',
    category: 'General',
    permission: { level: 'guest' },
    execute: async (context) => {
      const categories = registry.getCategories();
      if (categories.length === 0) {
        context.privateReply('No categories found.');
        return;
      }

      let output = `📁 **Command Categories**\n\n`;
      for (const cat of categories) {
        const cmds = registry.getByCategory(cat);
        output += `• **${cat}** (${cmds.length} commands)\n`;
      }
      context.privateReply(output);
    },
  };
}

/**
 * Help system utilities
 */
export const HelpUtils = {
  /**
   * Wrap text to max width
   */
  wrapText(text: string, maxWidth: number): string {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= maxWidth) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);

    return lines.join('\n');
  },

  /**
   * Truncate text with ellipsis
   */
  truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  },

  /**
   * Format permission level for display
   */
  formatPermissionLevel(level: PermissionLevel): string {
    const icons: Record<PermissionLevel, string> = {
      guest: '👤',
      trusted: '⭐',
      admin: '👑',
    };
    return `${icons[level]} ${level.charAt(0).toUpperCase() + level.slice(1)}`;
  },

  /**
   * Generate command signature
   */
  generateSignature(command: CommandDefinition, prefix: string): string {
    let sig = `${prefix}${command.name}`;

    if (command.arguments?.length) {
      const args = command.arguments.map((arg) => {
        const open = arg.required ? '<' : '[';
        const close = arg.required ? '>' : ']';
        let name = arg.name;
        if (arg.greedy) name += '...';
        return `${open}${name}${close}`;
      });
      sig += ` ${args.join(' ')}`;
    }

    return sig;
  },
};

/**
 * Interactive help pager
 * For displaying long help texts in chunks
 */
export class HelpPager {
  private pages: string[] = [];
  private currentPage = 0;
  private linesPerPage = 15;

  constructor(content: string, linesPerPage = 15) {
    this.linesPerPage = linesPerPage;
    this.pages = this.paginate(content);
  }

  private paginate(content: string): string[] {
    const lines = content.split('\n');
    const pages: string[] = [];

    for (let i = 0; i < lines.length; i += this.linesPerPage) {
      pages.push(lines.slice(i, i + this.linesPerPage).join('\n'));
    }

    return pages;
  }

  getCurrentPage(): string {
    if (this.pages.length === 0) return 'No content';
    return this.pages[this.currentPage];
  }

  nextPage(): string {
    if (this.currentPage < this.pages.length - 1) {
      this.currentPage++;
    }
    return this.getCurrentPage();
  }

  previousPage(): string {
    if (this.currentPage > 0) {
      this.currentPage--;
    }
    return this.getCurrentPage();
  }

  goToPage(page: number): string {
    if (page >= 0 && page < this.pages.length) {
      this.currentPage = page;
    }
    return this.getCurrentPage();
  }

  getTotalPages(): number {
    return this.pages.length;
  }

  getCurrentPageNumber(): number {
    return this.currentPage + 1;
  }

  hasNext(): boolean {
    return this.currentPage < this.pages.length - 1;
  }

  hasPrevious(): boolean {
    return this.currentPage > 0;
  }
}
