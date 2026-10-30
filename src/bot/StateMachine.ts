/**
 * StateMachine - Finite state machine for bot lifecycle management
 */

import { EventEmitter } from 'events';
import { BotState, BotEvents } from './types';

type StateHandler = (fromState: BotState, toState: BotState) => Promise<void> | void;
type TransitionValidator = (fromState: BotState, toState: BotState) => boolean | Promise<boolean>;

interface Transition {
  from: BotState | BotState[];
  to: BotState;
  validator?: TransitionValidator;
  onEnter?: StateHandler;
  onExit?: StateHandler;
}

export class StateMachine extends EventEmitter {
  private currentState: BotState;
  private transitions = new Map<string, Transition[]>();
  private globalOnEnter?: StateHandler;
  private globalOnExit?: StateHandler;
  private transitionHistory: { from: BotState; to: BotState; timestamp: number }[] = [];
  private maxHistorySize = 100;
  private isTransitioning = false;

  constructor(initialState: BotState = BotState.DISCONNECTED) {
    super();
    this.currentState = initialState;
    this.defineDefaultTransitions();
  }

  /**
   * Define default valid transitions for bot lifecycle
   */
  private defineDefaultTransitions(): void {
    const transitions: Transition[] = [
      // From DISCONNECTED
      { from: BotState.DISCONNECTED, to: BotState.CONNECTING },
      { from: BotState.DISCONNECTED, to: BotState.SHUTDOWN },

      // From CONNECTING
      { from: BotState.CONNECTING, to: BotState.CONNECTED },
      { from: BotState.CONNECTING, to: BotState.RECONNECTING },
      { from: BotState.CONNECTING, to: BotState.ERROR },
      { from: BotState.CONNECTING, to: BotState.DISCONNECTED },

      // From CONNECTED
      { from: BotState.CONNECTED, to: BotState.RECONNECTING },
      { from: BotState.CONNECTED, to: BotState.DISCONNECTED },
      { from: BotState.CONNECTED, to: BotState.ERROR },
      { from: BotState.CONNECTED, to: BotState.SHUTTING_DOWN },

      // From RECONNECTING
      { from: BotState.RECONNECTING, to: BotState.CONNECTING },
      { from: BotState.RECONNECTING, to: BotState.CONNECTED },
      { from: BotState.RECONNECTING, to: BotState.ERROR },
      { from: BotState.RECONNECTING, to: BotState.DISCONNECTED },

      // From ERROR
      { from: BotState.ERROR, to: BotState.RECONNECTING },
      { from: BotState.ERROR, to: BotState.DISCONNECTED },
      { from: BotState.ERROR, to: BotState.SHUTTING_DOWN },

      // From SHUTTING_DOWN
      { from: BotState.SHUTTING_DOWN, to: BotState.SHUTDOWN },
      { from: BotState.SHUTTING_DOWN, to: BotState.ERROR },

      // From SHUTDOWN (terminal state - no outgoing transitions)
    ];

    transitions.forEach(t => this.addTransition(t));
  }

  /**
   * Add a transition rule
   */
  addTransition(transition: Transition): this {
    const fromStates = Array.isArray(transition.from) ? transition.from : [transition.from];

    fromStates.forEach(from => {
      const key = `${from}->${transition.to}`;
      if (!this.transitions.has(key)) {
        this.transitions.set(key, []);
      }
      this.transitions.get(key)!.push(transition);
    });

    return this;
  }

  /**
   * Set global enter handler
   */
  onEnter(handler: StateHandler): this {
    this.globalOnEnter = handler;
    return this;
  }

  /**
   * Set global exit handler
   */
  onExit(handler: StateHandler): this {
    this.globalOnExit = handler;
    return this;
  }

  /**
   * Get current state
   */
  getState(): BotState {
    return this.currentState;
  }

  /**
   * Check if a transition is valid
   */
  canTransition(toState: BotState): boolean {
    const key = `${this.currentState}->${toState}`;
    const transitions = this.transitions.get(key);

    if (!transitions || transitions.length === 0) {
      return false;
    }

    // Check validators
    for (const transition of transitions) {
      if (transition.validator) {
        const result = transition.validator(this.currentState, toState);
        if (result instanceof Promise) {
          // For async validators, we'd need to handle differently
          // For now, assume sync validators only for canTransition
          continue;
        }
        if (!result) return false;
      }
    }

    return true;
  }

  /**
   * Transition to a new state
   */
  async transition(toState: BotState): Promise<boolean> {
    if (this.isTransitioning) {
      throw new Error('State machine is already transitioning');
    }

    if (this.currentState === toState) {
      return true; // Already in target state
    }

    const key = `${this.currentState}->${toState}`;
    const transitions = this.transitions.get(key);

    if (!transitions || transitions.length === 0) {
      const error = new Error(`Invalid transition: ${this.currentState} -> ${toState}`);
      this.emit('error', error);
      return false;
    }

    // Run validators
    for (const transition of transitions) {
      if (transition.validator) {
        const result = await Promise.resolve(transition.validator(this.currentState, toState));
        if (!result) {
          const error = new Error(`Transition validator failed: ${this.currentState} -> ${toState}`);
          this.emit('error', error);
          return false;
        }
      }
    }

    this.isTransitioning = true;
    const fromState = this.currentState;

    try {
      // Call global exit handler
      if (this.globalOnExit) {
        await Promise.resolve(this.globalOnExit(fromState, toState));
      }

      // Call transition-specific exit handlers
      for (const transition of transitions) {
        if (transition.onExit) {
          await Promise.resolve(transition.onExit(fromState, toState));
        }
      }

      // Update state
      this.currentState = toState;

      // Record transition
      this.recordTransition(fromState, toState);

      // Call transition-specific enter handlers
      for (const transition of transitions) {
        if (transition.onEnter) {
          await Promise.resolve(transition.onEnter(fromState, toState));
        }
      }

      // Call global enter handler
      if (this.globalOnEnter) {
        await Promise.resolve(this.globalOnEnter(fromState, toState));
      }

      // Emit state change event
      this.emit('stateChange', toState, fromState);

      return true;
    } catch (error) {
      this.emit('error', error as Error);
      return false;
    } finally {
      this.isTransitioning = false;
    }
  }

  /**
   * Record transition in history
   */
  private recordTransition(from: BotState, to: BotState): void {
    this.transitionHistory.push({
      from,
      to,
      timestamp: Date.now()
    });

    // Trim history
    if (this.transitionHistory.length > this.maxHistorySize) {
      this.transitionHistory.shift();
    }
  }

  /**
   * Get transition history
   */
  getHistory(): { from: BotState; to: BotState; timestamp: number }[] {
    return [...this.transitionHistory];
  }

  /**
   * Get available transitions from current state
   */
  getAvailableTransitions(): BotState[] {
    const available: BotState[] = [];

    for (const [key, transitions] of this.transitions) {
      if (key.startsWith(`${this.currentState}->`)) {
        const toState = key.split('->')[1] as BotState;
        if (!available.includes(toState)) {
          available.push(toState);
        }
      }
    }

    return available;
  }

  /**
   * Check if in a specific state
   */
  isInState(state: BotState): boolean {
    return this.currentState === state;
  }

  /**
   * Check if in any of the given states
   */
  isInAnyState(states: BotState[]): boolean {
    return states.includes(this.currentState);
  }

  /**
   * Check if state is terminal (no outgoing transitions)
   */
  isTerminalState(state?: BotState): boolean {
    const checkState = state || this.currentState;
    return this.getAvailableTransitions().length === 0;
  }

  /**
   * Reset to initial state
   */
  reset(initialState: BotState = BotState.DISCONNECTED): void {
    this.currentState = initialState;
    this.transitionHistory = [];
    this.isTransitioning = false;
  }

  /**
   * Force set state (bypasses validation - use with caution)
   */
  forceState(state: BotState): void {
    const fromState = this.currentState;
    this.currentState = state;
    this.recordTransition(fromState, state);
    this.emit('stateChange', state, fromState);
  }

  /**
   * Get state machine status
   */
  getStatus(): {
    currentState: BotState;
    availableTransitions: BotState[];
    isTransitioning: boolean;
    historySize: number;
  } {
    return {
      currentState: this.currentState,
      availableTransitions: this.getAvailableTransitions(),
      isTransitioning: this.isTransitioning,
      historySize: this.transitionHistory.length
    };
  }
}

export default StateMachine;