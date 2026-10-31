/**
 * Chat/AI Integration Feature
 * Handles OpenAI integration for AI chat responses
 */

import type { FeaturePluginConfig } from './BaseFeature.js';
import { BaseFeature } from './BaseFeature.js';
import type { OpenAI } from 'openai';

/**
 * ChatAI feature configuration
 */
export type ChatAIFeatureConfig = FeaturePluginConfig;

/**
 * ChatAI feature options
 */
export interface ChatAIFeatureOptions {
  /** OpenAI API key */
  apiKey?: string;
  /** Model to use */
  model?: string;
  /** System prompt */
  systemPrompt?: string;
  /** Maximum tokens per response */
  maxTokens?: number;
  /** Temperature for responses */
  temperature?: number;
  /** Enable AI chat */
  enabled?: boolean;
}

/**
 * Chat message
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * ChatAI Feature Class
 */
export class ChatAIFeature extends BaseFeature {
  public readonly name = 'chatAI';
  public readonly version = '1.0.0';
  public readonly description = 'OpenAI integration for AI chat responses';
  public readonly dependencies = ['core'];

  private openai: OpenAI | null = null;
  private apiKey = '';
  private model = 'gpt-4';
  private systemPrompt =
    'You are Airi, a Minecraft bot assistant. Use these persistent notes as context, but do not invent facts. Follow stored behavioral rules.';
  private maxTokens = 500;
  private temperature = 0.7;
  private conversationHistory: ChatMessage[] = [];

  constructor() {
    super('chatAI', '1.0.0', 'OpenAI integration for AI chat responses', ['core']);
  }

  /**
   * Initialize the ChatAI feature
   */
  protected async onEnable(): Promise<void> {
    // Configure from options
    this.configureFromOptions();

    // Initialize OpenAI if API key is provided
    if (this.apiKey) {
      await this.initializeOpenAI();
    }

    // Register commands
    this.registerCommands();

    console.log('[ChatAIFeature] Chat AI feature enabled');
  }

  /**
   * Disable the ChatAI feature
   */
  protected async onDisable(): Promise<void> {
    this.openai = null;
    this.conversationHistory = [];
    this.removeAllListeners();
    console.log('[ChatAIFeature] Chat AI feature disabled');
  }

  /**
   * Configure from options
   */
  private configureFromOptions(): void {
    const options = this.config.options as ChatAIFeatureOptions | undefined;
    if (!options) return;

    this.apiKey = options.apiKey ?? process.env.OPENAI_KEY ?? process.env.OPENAI_API_KEY ?? '';
    this.model = options.model ?? this.model;
    this.systemPrompt = options.systemPrompt ?? this.systemPrompt;
    this.maxTokens = options.maxTokens ?? this.maxTokens;
    this.temperature = options.temperature ?? this.temperature;
    this.enabled = options.enabled ?? this.enabled;
  }

  /**
   * Initialize OpenAI client
   */
  private async initializeOpenAI(): Promise<void> {
    try {
      const { OpenAI } = await import('openai');
      this.openai = new OpenAI({ apiKey: this.apiKey });
      console.log('[ChatAIFeature] OpenAI client initialized');
    } catch (error: unknown) {
      console.error('[ChatAIFeature] Failed to initialize OpenAI:', error);
    }
  }

  /**
   * Register AI chat commands
   */
  private registerCommands(): void {
    // Commands will be registered via the command system
  }

  // ========================================================================
  // Chat Methods
  // ========================================================================

  /**
   * Send a message to AI and get response
   */
  async chat(message: string, context?: string): Promise<string | null> {
    if (!this.enabled || !this.openai) {
      console.warn('[ChatAIFeature] AI chat not enabled or OpenAI not initialized');
      return null;
    }

    if (!message.trim()) return null;

    try {
      // Build messages array
      const messages: ChatMessage[] = [
        { role: 'system', content: this.systemPrompt + '\n\n' + (context ?? '') },
        ...this.conversationHistory.slice(-10), // Keep last 10 messages for context
        { role: 'user', content: message },
      ];

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
      });

      const reply = response.choices[0]?.message?.content;
      if (reply) {
        // Add to conversation history
        this.conversationHistory.push(
          { role: 'user', content: message },
          { role: 'assistant', content: reply }
        );

        // Limit history size
        if (this.conversationHistory.length > 20) {
          this.conversationHistory = this.conversationHistory.slice(-20);
        }
      }

      return reply ?? null;
    } catch (error: unknown) {
      console.error('[ChatAIFeature] Chat error:', error);
      return null;
    }
  }

  /**
   * Chat and send response to Minecraft chat
   */
  async chatAndSay(message: string, context?: string): Promise<void> {
    const reply = await this.chat(message, context);
    if (reply) {
      const bot = this.getBot();
      bot.chat(reply);
    }
  }

  /**
   * Set system prompt
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
    this.setOption('systemPrompt', prompt);
  }

  /**
   * Get system prompt
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * Set model
   */
  setModel(model: string): void {
    this.model = model;
    this.setOption('model', model);
  }

  /**
   * Get model
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Set API key
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.setOption('apiKey', apiKey);
    void this.initializeOpenAI();
  }

  /**
   * Check if AI is enabled
   */
  isEnabled(): boolean {
    return this.enabled && this.openai !== null;
  }

  /**
   * Enable/disable AI chat
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.setOption('enabled', enabled);
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Get conversation history
   */
  getHistory(): ChatMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Set memory context (from memory feature)
   */
  setMemoryContext(context: string): void {
    // The system prompt will include this context
    this.systemPrompt = `You are Airi, a Minecraft bot assistant. Use these persistent notes as context, but do not invent facts. Follow stored behavioral rules.\n\n${context}`;
  }
}

export default ChatAIFeature;
