/**
 * Feature/Plugin registry system for mc-ai-bot
 * Allows modular feature registration with dependency management
 */

import type { Bot } from 'mineflayer';
import type { Feature, FeatureRegistry } from '../types';

/**
 * Internal feature registry implementation
 */
class FeatureRegistryImpl implements FeatureRegistry {
  private features = new Map<string, Feature>();
  private initialized = new Set<string>();
  private initializationOrder: string[] = [];

  register(feature: Feature): void {
    if (!feature.name || typeof feature.name !== 'string') {
      throw new Error('Feature must have a valid name');
    }
    if (!feature.initialize || typeof feature.initialize !== 'function') {
      throw new Error(`Feature "${feature.name}" must have an initialize function`);
    }

    const normalizedName = feature.name.toLowerCase();

    if (this.features.has(normalizedName)) {
      console.warn(`[PLUGINS] Feature "${normalizedName}" is being overridden`);
    }

    this.features.set(normalizedName, feature);
    console.log(`[PLUGINS] Registered: ${normalizedName} v${feature.version} - ${feature.description}`);
  }

  unregister(name: string): void {
    const normalizedName = name.toLowerCase();
    const feature = this.features.get(normalizedName);

    if (feature) {
      // Shutdown if initialized
      if (this.initialized.has(normalizedName)) {
        try {
          feature.shutdown?.();
        } catch (error) {
          console.error(`[PLUGINS] Error shutting down "${normalizedName}":`, error);
        }
        this.initialized.delete(normalizedName);
      }

      this.features.delete(normalizedName);
      this.initializationOrder = this.initializationOrder.filter(n => n !== normalizedName);
      console.log(`[PLUGINS] Unregistered: ${normalizedName}`);
    }
  }

  get(name: string): Feature | undefined {
    return this.features.get(name.toLowerCase());
  }

  getAll(): Feature[] {
    return Array.from(this.features.values());
  }

  getDependencies(name: string): string[] {
    const feature = this.get(name);
    return feature?.dependencies || [];
  }

  /**
   * Initialize all features in dependency order
   */
  async initializeAll(bot: Bot): Promise<void> {
    // Topological sort based on dependencies
    const sorted = this.topologicalSort();

    for (const name of sorted) {
      const feature = this.features.get(name);
      if (!feature) continue;

      if (this.initialized.has(name)) {
        console.log(`[PLUGINS] ${name} already initialized, skipping`);
        continue;
      }

      // Check dependencies
      const deps = feature.dependencies || [];
      const missingDeps = deps.filter(dep => !this.initialized.has(dep.toLowerCase()));

      if (missingDeps.length > 0) {
        console.error(`[PLUGINS] Cannot initialize "${name}": missing dependencies: ${missingDeps.join(', ')}`);
        continue;
      }

      try {
        console.log(`[PLUGINS] Initializing: ${name}`);
        await feature.initialize(bot, this);
        this.initialized.add(name);
        this.initializationOrder.push(name);
        console.log(`[PLUGINS] Initialized: ${name}`);
      } catch (error) {
        console.error(`[PLUGINS] Failed to initialize "${name}":`, error);
      }
    }
  }

  /**
   * Shutdown all features in reverse initialization order
   */
  async shutdownAll(): Promise<void> {
    for (const name of this.initializationOrder.slice().reverse()) {
      const feature = this.features.get(name);
      if (!feature) continue;

      try {
        console.log(`[PLUGINS] Shutting down: ${name}`);
        await feature.shutdown?.();
        this.initialized.delete(name);
        console.log(`[PLUGINS] Shut down: ${name}`);
      } catch (error) {
        console.error(`[PLUGINS] Error shutting down "${name}":`, error);
      }
    }
  }

  /**
   * Topological sort of features based on dependencies
   */
  private topologicalSort(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: string[] = [];

    const visit = (name: string): void => {
      const normalized = name.toLowerCase();

      if (visiting.has(normalized)) {
        throw new Error(`Circular dependency detected involving "${name}"`);
      }

      if (visited.has(normalized)) {
        return;
      }

      visiting.add(normalized);

      const feature = this.features.get(normalized);
      if (feature && feature.dependencies) {
        for (const dep of feature.dependencies) {
          visit(dep);
        }
      }

      visiting.delete(normalized);
      visited.add(normalized);

      if (this.features.has(normalized)) {
        result.push(normalized);
      }
    };

    for (const name of this.features.keys()) {
      visit(name);
    }

    return result;
  }

  /**
   * Check if a feature is initialized
   */
  isInitialized(name: string): boolean {
    return this.initialized.has(name.toLowerCase());
  }

  /**
   * Get initialization order
   */
  getInitializationOrder(): string[] {
    return [...this.initializationOrder];
  }
}

/**
 * Singleton feature registry instance
 */
let featureRegistryInstance: FeatureRegistryImpl | null = null;

export function getFeatureRegistry(): FeatureRegistry {
  if (!featureRegistryInstance) {
    featureRegistryInstance = new FeatureRegistryImpl();
  }
  return featureRegistryInstance;
}

export function createFeatureRegistry(): FeatureRegistry {
  return new FeatureRegistryImpl();
}

/**
 * Base feature class for easier feature creation
 */
export abstract class BaseFeature implements Feature {
  public readonly name: string;
  public readonly version: string;
  public readonly description: string;
  public readonly dependencies: string[];

  constructor(name: string, version: string, description: string, dependencies: string[] = []) {
    this.name = name;
    this.version = version;
    this.description = description;
    this.dependencies = dependencies;
  }

  abstract initialize(bot: Bot, registry: FeatureRegistry): Promise<void> | void;
  abstract shutdown(): Promise<void> | void;
}

/**
 * Feature decorator for class-based features
 */
export function feature(config: { name: string; version: string; description: string; dependencies?: string[] }) {
  return function <T extends new (...args: unknown[]) => Feature>(target: T): T {
    // Store metadata on the class
    (target as unknown as { _featureConfig: typeof config })._featureConfig = config;
    return target;
  };
}

/**
 * Create a feature from a class with @feature decorator
 */
export function createFeatureFromClass<T extends Feature>(FeatureClass: new (...args: unknown[]) => T, ...args: unknown[]): T {
  const instance = new FeatureClass(...args);
  return instance;
}

/**
 * Built-in features
 */

// Core bot feature - handles basic bot lifecycle
export const coreFeature: Feature = {
  name: 'core',
  version: '1.0.0',
  description: 'Core bot functionality and lifecycle management',
  dependencies: [],
  initialize: async (bot: Bot) => {
    console.log('[CORE] Core feature initialized');
  },
  shutdown: async () => {
    console.log('[CORE] Core feature shut down');
  },
};

// Movement feature - pathfinding and navigation
export const movementFeature: Feature = {
  name: 'movement',
  version: '1.0.0',
  description: 'Pathfinding, movement, and navigation utilities',
  dependencies: ['core'],
  initialize: async (bot: Bot) => {
    console.log('[MOVEMENT] Movement feature initialized');
  },
  shutdown: async () => {
    console.log('[MOVEMENT] Movement feature shut down');
  },
};

// Combat feature - PvP, kill aura, defense
export const combatFeature: Feature = {
  name: 'combat',
  version: '1.0.0',
  description: 'Combat mechanics, PvP, and auto-defense',
  dependencies: ['core', 'movement'],
  initialize: async (bot: Bot) => {
    console.log('[COMBAT] Combat feature initialized');
  },
  shutdown: async () => {
    console.log('[COMBAT] Combat feature shut down');
  },
};

// Automation feature - mining, farming, building
export const automationFeature: Feature = {
  name: 'automation',
  version: '1.0.0',
  description: 'Automation tasks: mining, farming, building, progression',
  dependencies: ['core', 'movement'],
  initialize: async (bot: Bot) => {
    console.log('[AUTOMATION] Automation feature initialized');
  },
  shutdown: async () => {
    console.log('[AUTOMATION] Automation feature shut down');
  },
};

// Memory feature - persistent memory
export const memoryFeature: Feature = {
  name: 'memory',
  version: '1.0.0',
  description: 'Persistent memory system for locations, players, tasks',
  dependencies: ['core'],
  initialize: async (bot: Bot, registry: FeatureRegistry) => {
    console.log('[MEMORY] Memory feature initialized');
  },
  shutdown: async () => {
    console.log('[MEMORY] Memory feature shut down');
  },
};

// Web dashboard feature
export const webFeature: Feature = {
  name: 'web',
  version: '1.0.0',
  description: 'Web dashboard and Socket.io server',
  dependencies: ['core', 'memory'],
  initialize: async (bot: Bot, registry: FeatureRegistry) => {
    console.log('[WEB] Web feature initialized');
  },
  shutdown: async () => {
    console.log('[WEB] Web feature shut down');
  },
};

/**
 * Register all built-in features
 */
export function registerBuiltinFeatures(registry: FeatureRegistry): void {
  registry.register(coreFeature);
  registry.register(movementFeature);
  registry.register(combatFeature);
  registry.register(automationFeature);
  registry.register(memoryFeature);
  registry.register(webFeature);
}