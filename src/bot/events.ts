/**
 * Event system for the bot - Provides typed event emission and handling
 */

import { EventEmitter } from 'events';
import type { BotEvents, BotState, TypedEventEmitter } from './types';

/**
 * Event names as constants for type safety
 */
export const EventNames = {
  // State events
  STATE_CHANGE: 'stateChange' as const,
  CONNECT: 'connect' as const,
  DISCONNECT: 'disconnect' as const,
  ERROR: 'error' as const,
  RECONNECT: 'reconnect' as const,
  RECONNECT_FAILED: 'reconnectFailed' as const,

  // Bot events
  SPAWN: 'spawn' as const,
  DEATH: 'death' as const,
  CHAT: 'chat' as const,
  COMMAND: 'command' as const,

  // Plugin events
  PLUGIN_LOAD: 'pluginLoad' as const,
  PLUGIN_UNLOAD: 'pluginUnload' as const,

  // Lifecycle events
  SHUTDOWN: 'shutdown' as const,
} as const;

export type EventName = (typeof EventNames)[keyof typeof EventNames];

/**
 * Event data types for each event
 */
export interface EventDataMap {
  [EventNames.STATE_CHANGE]: { newState: BotState; oldState: BotState; timestamp: number };
  [EventNames.CONNECT]: { bot: object; timestamp: number };
  [EventNames.DISCONNECT]: { reason: string; timestamp: number };
  [EventNames.ERROR]: { error: Error; timestamp: number; fatal?: boolean };
  [EventNames.RECONNECT]: { attempt: number; delay: number; timestamp: number };
  [EventNames.RECONNECT_FAILED]: { error: Error; attempts: number; timestamp: number };
  [EventNames.SPAWN]: { position: { x: number; y: number; z: number }; timestamp: number };
  [EventNames.DEATH]: { location: { x: number; y: number; z: number }; timestamp: number };
  [EventNames.CHAT]: { username: string; message: string; type: string; timestamp: number };
  [EventNames.COMMAND]: { command: string; args: string[]; username: string; timestamp: number };
  [EventNames.PLUGIN_LOAD]: { plugin: { name: string; version: string }; timestamp: number };
  [EventNames.PLUGIN_UNLOAD]: { pluginName: string; timestamp: number };
  [EventNames.SHUTDOWN]: { reason: string; timestamp: number };
}

/**
 * Extended event emitter with full type safety
 */
export class BotEventEmitter extends EventEmitter implements TypedEventEmitter<BotEvents> {
  private eventLog: { event: string; timestamp: number; args: unknown[] }[] = [];
  private maxLogSize = 1000;
  private loggingEnabled = true;

  constructor() {
    super();
    this.setMaxListeners(100); // Allow many listeners
  }

  /**
   * Enable/disable event logging
   */
  setLogging(enabled: boolean): this {
    this.loggingEnabled = enabled;
    return this;
  }

  /**
   * Set maximum event log size
   */
  setMaxLogSize(size: number): this {
    this.maxLogSize = size;
    return this;
  }

  /**
   * Get event log
   */
  getEventLog(): { event: string; timestamp: number; args: unknown[] }[] {
    return [...this.eventLog];
  }

  /**
   * Clear event log
   */
  clearEventLog(): this {
    this.eventLog = [];
    return this;
  }

  /**
   * Typed emit with logging
   */
  emit<K extends keyof BotEvents>(event: K, ...args: BotEvents[K]): boolean {
    const timestamp = Date.now();

    if (this.loggingEnabled) {
      this.eventLog.push({ event, timestamp, args: args as unknown[] });
      if (this.eventLog.length > this.maxLogSize) {
        this.eventLog.shift();
      }
    }

    return super.emit(event, ...args);
  }

  /**
   * Typed on
   */
  on<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    return super.on(event, listener);
  }

  /**
   * Typed once
   */
  once<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    return super.once(event, listener);
  }

  /**
   * Typed off
   */
  off<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this {
    return super.off(event, listener);
  }

  /**
   * Wait for an event to fire (promise-based)
   */
  waitFor<K extends keyof BotEvents>(
    event: K,
    timeout = 30000,
    filter?: (...args: BotEvents[K]) => boolean
  ): Promise<BotEvents[K]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timeout waiting for event: ${event}`));
      }, timeout);

      const handler = (...args: BotEvents[K]) => {
        if (!filter || filter(...args)) {
          clearTimeout(timer);
          this.off(event, handler);
          resolve(args);
        }
      };

      this.once(event, handler);
    });
  }

  /**
   * Wait for one of multiple events
   */
  waitForAny<K extends keyof BotEvents>(
    events: K[],
    timeout = 30000
  ): Promise<{ event: K; args: BotEvents[K] }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        events.forEach((e) => this.off(e, handlers[e]));
        reject(new Error(`Timeout waiting for any of: ${events.join(', ')}`));
      }, timeout);

      const handlers: Record<string, (...args: BotEvents[K]) => void> = {};

      events.forEach((event) => {
        handlers[event] = (...args: BotEvents[K]) => {
          clearTimeout(timer);
          events.forEach((e) => this.off(e, handlers[e]));
          resolve({ event, args });
        };
        this.once(event, handlers[event]);
      });
    });
  }

  /**
   * Create a filtered event stream
   */
  filter<K extends keyof BotEvents>(
    event: K,
    predicate: (...args: BotEvents[K]) => boolean
  ): AsyncIterableIterator<BotEvents[K]> {
    const queue: BotEvents[K][] = [];
    let resolve: ((value: IteratorResult<BotEvents[K]>) => void) | null = null;
    let closed = false;

    const handler = (...args: BotEvents[K]) => {
      if (predicate(...args)) {
        if (resolve) {
          resolve({ value: args, done: false });
          resolve = null;
        } else {
          queue.push(args);
        }
      }
    };

    this.on(event, handler);

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<BotEvents[K]>> {
        if (queue.length > 0) {
          return { value: queue.shift()!, done: false };
        }
        if (closed) {
          return { value: undefined, done: true };
        }
        return new Promise((r) => {
          resolve = r;
        });
      },
      async return(): Promise<IteratorResult<BotEvents[K]>> {
        closed = true;
        this.off(event, handler);
        if (resolve) {
          resolve({ value: undefined, done: true });
        }
        return { value: undefined, done: true };
      },
    };
  }

  /**
   * Get listener count for an event
   */
  listenerCountTyped<K extends keyof BotEvents>(event: K): number {
    return this.listenerCount(event);
  }

  /**
   * Get all event names that have listeners
   */
  eventNamesTyped(): (keyof BotEvents)[] {
    return this.eventNames() as (keyof BotEvents)[];
  }
}

/**
 * Create a new bot event emitter
 */
export function createEventEmitter(): BotEventEmitter {
  return new BotEventEmitter();
}

/**
 * Event builder for constructing complex event data
 */
export class EventBuilder<T extends EventName> {
  private data: Partial<EventDataMap[T]>;
  private timestamp: number;

  constructor() {
    this.timestamp = Date.now();
    this.data = { timestamp: this.timestamp } as Partial<EventDataMap[T]>;
  }

  set<K extends keyof EventDataMap[T]>(key: K, value: EventDataMap[T][K]): this {
    (this.data as Record<K, EventDataMap[T][K]>)[key] = value;
    return this;
  }

  build(): EventDataMap[T] {
    return this.data as EventDataMap[T];
  }
}

/**
 * Helper to create event data with timestamp
 */
export function createEventData<T extends EventName>(
  eventName: T,
  data: Omit<EventDataMap[T], 'timestamp'>
): EventDataMap[T] {
  return {
    ...data,
    timestamp: Date.now(),
  } as EventDataMap[T];
}

export default BotEventEmitter;
