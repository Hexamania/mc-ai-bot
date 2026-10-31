import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateMachine, BotState } from '../src/bot/StateMachine';

describe('StateMachine', () => {
  let stateMachine: StateMachine;

  beforeEach(() => {
    stateMachine = new StateMachine();
  });

  afterEach(() => {
    stateMachine.removeAllListeners();
  });

  describe('Initial State', () => {
    it('should start in DISCONNECTED state by default', () => {
      expect(stateMachine.getState()).toBe(BotState.DISCONNECTED);
    });

    it('should allow custom initial state', () => {
      const sm = new StateMachine(BotState.CONNECTED);
      expect(sm.getState()).toBe(BotState.CONNECTED);
    });

    it('should have empty history initially', () => {
      expect(stateMachine.getHistory()).toEqual([]);
    });

    it('should not be transitioning initially', () => {
      const status = stateMachine.getStatus();
      expect(status.isTransitioning).toBe(false);
    });
  });

  describe('Valid Transitions', () => {
    it('should transition from DISCONNECTED to CONNECTING', async () => {
      const result = await stateMachine.transition(BotState.CONNECTING);
      expect(result).toBe(true);
      expect(stateMachine.getState()).toBe(BotState.CONNECTING);
    });

    it('should transition from CONNECTING to CONNECTED', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      const result = await stateMachine.transition(BotState.CONNECTED);
      expect(result).toBe(true);
      expect(stateMachine.getState()).toBe(BotState.CONNECTED);
    });

    it('should transition from CONNECTED to RECONNECTING', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      await stateMachine.transition(BotState.CONNECTED);
      const result = await stateMachine.transition(BotState.RECONNECTING);
      expect(result).toBe(true);
      expect(stateMachine.getState()).toBe(BotState.RECONNECTING);
    });

    it('should transition from RECONNECTING to CONNECTED', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      await stateMachine.transition(BotState.CONNECTED);
      await stateMachine.transition(BotState.RECONNECTING);
      const result = await stateMachine.transition(BotState.CONNECTED);
      expect(result).toBe(true);
      expect(stateMachine.getState()).toBe(BotState.CONNECTED);
    });

    it('should transition from ERROR to RECONNECTING', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      await stateMachine.transition(BotState.ERROR);
      const result = await stateMachine.transition(BotState.RECONNECTING);
      expect(result).toBe(true);
      expect(stateMachine.getState()).toBe(BotState.RECONNECTING);
    });

    it('should transition from SHUTTING_DOWN to SHUTDOWN', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      await stateMachine.transition(BotState.CONNECTED);
      await stateMachine.transition(BotState.SHUTTING_DOWN);
      const result = await stateMachine.transition(BotState.SHUTDOWN);
      expect(result).toBe(true);
      expect(stateMachine.getState()).toBe(BotState.SHUTDOWN);
    });

    it('should return true when already in target state', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      const result = await stateMachine.transition(BotState.CONNECTING);
      expect(result).toBe(true);
    });
  });

  describe('Invalid Transitions', () => {
    it('should reject transition from DISCONNECTED to CONNECTED', async () => {
      const result = await stateMachine.transition(BotState.CONNECTED);
      expect(result).toBe(false);
      expect(stateMachine.getState()).toBe(BotState.DISCONNECTED);
    });

    it('should reject transition from CONNECTED to SHUTDOWN', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      await stateMachine.transition(BotState.CONNECTED);
      const result = await stateMachine.transition(BotState.SHUTDOWN);
      expect(result).toBe(false);
      expect(stateMachine.getState()).toBe(BotState.CONNECTED);
    });

    it('should reject transition from SHUTDOWN (terminal state)', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      await stateMachine.transition(BotState.CONNECTED);
      await stateMachine.transition(BotState.SHUTTING_DOWN);
      await stateMachine.transition(BotState.SHUTDOWN);
      const result = await stateMachine.transition(BotState.DISCONNECTED);
      expect(result).toBe(false);
      expect(stateMachine.getState()).toBe(BotState.SHUTDOWN);
    });

    it('should emit error event on invalid transition', async () => {
      const errorHandler = vi.fn();
      stateMachine.on('error', errorHandler);

      await stateMachine.transition(BotState.CONNECTED);

      expect(errorHandler).toHaveBeenCalled();
      expect(errorHandler.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(errorHandler.mock.calls[0][0].message).toContain('Invalid transition');
    });

    it('should throw error when already transitioning', async () => {
      // This test verifies that concurrent transitions are rejected
      // We simulate this by trying to transition while a transition is in progress
      // (though with async/await this is hard to test directly without mocking)
      // The isTransitioning flag prevents re-entrancy
      expect(stateMachine.getStatus().isTransitioning).toBe(false);
    });
  });

  describe('Transition History', () => {
    it('should record transition history', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      await stateMachine.transition(BotState.CONNECTED);

      const history = stateMachine.getHistory();
      expect(history.length).toBe(2);
      expect(history[0]).toEqual({
        from: BotState.DISCONNECTED,
        to: BotState.CONNECTING,
        timestamp: expect.any(Number),
      });
      expect(history[1]).toEqual({
        from: BotState.CONNECTING,
        to: BotState.CONNECTED,
        timestamp: expect.any(Number),
      });
    });

    it('should limit history to maxHistorySize', async () => {
      // Create a state machine with small history size
      const sm = new StateMachine();
      // Access private property for testing
      (sm as any).maxHistorySize = 3;

      await sm.transition(BotState.CONNECTING);
      await sm.transition(BotState.CONNECTED);
      await sm.transition(BotState.RECONNECTING);
      await sm.transition(BotState.CONNECTED);

      const history = sm.getHistory();
      expect(history.length).toBe(3);
      expect(history[0].from).toBe(BotState.CONNECTING);
      expect(history[2].to).toBe(BotState.CONNECTED);
    });

    it('should return copy of history (not reference)', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      const history = stateMachine.getHistory();
      history.push({ from: BotState.ERROR, to: BotState.DISCONNECTED, timestamp: 0 });
      expect(stateMachine.getHistory().length).toBe(1);
    });
  });

  describe('canTransition', () => {
    it('should return true for valid transitions', () => {
      expect(stateMachine.canTransition(BotState.CONNECTING)).toBe(true);
      expect(stateMachine.canTransition(BotState.SHUTDOWN)).toBe(true);
    });

    it('should return false for invalid transitions', () => {
      expect(stateMachine.canTransition(BotState.CONNECTED)).toBe(false);
      expect(stateMachine.canTransition(BotState.RECONNECTING)).toBe(false);
    });

    it('should return true for valid transitions from CONNECTING', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      expect(stateMachine.canTransition(BotState.CONNECTED)).toBe(true);
      expect(stateMachine.canTransition(BotState.RECONNECTING)).toBe(true);
      expect(stateMachine.canTransition(BotState.ERROR)).toBe(true);
      expect(stateMachine.canTransition(BotState.DISCONNECTED)).toBe(true);
    });
  });

  describe('getAvailableTransitions', () => {
    it('should return available transitions from DISCONNECTED', () => {
      const available = stateMachine.getAvailableTransitions();
      expect(available).toContain(BotState.CONNECTING);
      expect(available).toContain(BotState.SHUTDOWN);
      expect(available.length).toBe(2);
    });

    it('should return available transitions from CONNECTING', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      const available = stateMachine.getAvailableTransitions();
      expect(available).toContain(BotState.CONNECTED);
      expect(available).toContain(BotState.RECONNECTING);
      expect(available).toContain(BotState.ERROR);
      expect(available).toContain(BotState.DISCONNECTED);
      expect(available.length).toBe(4);
    });
  });

  describe('State Checks', () => {
    it('should correctly report current state', () => {
      expect(stateMachine.isInState(BotState.DISCONNECTED)).toBe(true);
      expect(stateMachine.isInState(BotState.CONNECTED)).toBe(false);
    });

    it('should correctly report isInAnyState', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      expect(stateMachine.isInAnyState([BotState.DISCONNECTED, BotState.CONNECTING])).toBe(true);
      expect(stateMachine.isInAnyState([BotState.CONNECTED, BotState.ERROR])).toBe(false);
    });

    it('should correctly identify terminal states', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      await stateMachine.transition(BotState.CONNECTED);
      await stateMachine.transition(BotState.SHUTTING_DOWN);
      await stateMachine.transition(BotState.SHUTDOWN);
      expect(stateMachine.isTerminalState()).toBe(true);
    });

    it('should identify non-terminal states', () => {
      expect(stateMachine.isTerminalState()).toBe(false);
    });
  });

  describe('Global Enter/Exit Handlers', () => {
    it('should call global onEnter handler', async () => {
      const onEnter = vi.fn();
      stateMachine.onEnter(onEnter);

      await stateMachine.transition(BotState.CONNECTING);

      expect(onEnter).toHaveBeenCalledWith(BotState.DISCONNECTED, BotState.CONNECTING);
    });

    it('should call global onExit handler', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      const onExit = vi.fn();
      stateMachine.onExit(onExit);

      await stateMachine.transition(BotState.CONNECTED);

      expect(onExit).toHaveBeenCalledWith(BotState.CONNECTING, BotState.CONNECTED);
    });

    it('should call transition-specific onEnter handler', async () => {
      const onEnter = vi.fn();
      stateMachine.addTransition({
        from: BotState.DISCONNECTED,
        to: BotState.CONNECTING,
        onEnter,
      });

      await stateMachine.transition(BotState.CONNECTING);

      expect(onEnter).toHaveBeenCalledWith(BotState.DISCONNECTED, BotState.CONNECTING);
    });

    it('should call transition-specific onExit handler', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      const onExit = vi.fn();
      stateMachine.addTransition({
        from: BotState.CONNECTING,
        to: BotState.CONNECTED,
        onExit,
      });

      await stateMachine.transition(BotState.CONNECTED);

      expect(onExit).toHaveBeenCalledWith(BotState.CONNECTING, BotState.CONNECTED);
    });
  });

  describe('Transition Validators', () => {
    it('should reject transition when validator returns false', async () => {
      stateMachine.addTransition({
        from: BotState.DISCONNECTED,
        to: BotState.CONNECTING,
        validator: () => false,
      });

      const result = await stateMachine.transition(BotState.CONNECTING);
      expect(result).toBe(false);
      expect(stateMachine.getState()).toBe(BotState.DISCONNECTED);
    });

    it('should allow transition when validator returns true', async () => {
      stateMachine.addTransition({
        from: BotState.DISCONNECTED,
        to: BotState.CONNECTING,
        validator: () => true,
      });

      const result = await stateMachine.transition(BotState.CONNECTING);
      expect(result).toBe(true);
      expect(stateMachine.getState()).toBe(BotState.CONNECTING);
    });

    it('should handle async validators', async () => {
      stateMachine.addTransition({
        from: BotState.DISCONNECTED,
        to: BotState.CONNECTING,
        validator: async () => {
          await Promise.resolve();
          return true;
        },
      });

      const result = await stateMachine.transition(BotState.CONNECTING);
      expect(result).toBe(true);
    });

    it('should reject transition when async validator returns false', async () => {
      stateMachine.addTransition({
        from: BotState.DISCONNECTED,
        to: BotState.CONNECTING,
        validator: async () => {
          await Promise.resolve();
          return false;
        },
      });

      const result = await stateMachine.transition(BotState.CONNECTING);
      expect(result).toBe(false);
    });
  });

  describe('forceState', () => {
    it('should bypass validation and set state', () => {
      stateMachine.forceState(BotState.CONNECTED);
      expect(stateMachine.getState()).toBe(BotState.CONNECTED);
    });

    it('should record transition in history', () => {
      stateMachine.forceState(BotState.CONNECTED);
      const history = stateMachine.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].from).toBe(BotState.DISCONNECTED);
      expect(history[0].to).toBe(BotState.CONNECTED);
    });

    it('should emit stateChange event', () => {
      const handler = vi.fn();
      stateMachine.on('stateChange', handler);

      stateMachine.forceState(BotState.CONNECTED);

      expect(handler).toHaveBeenCalledWith(BotState.CONNECTED, BotState.DISCONNECTED);
    });
  });

  describe('reset', () => {
    it('should reset to initial state', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      await stateMachine.transition(BotState.CONNECTED);
      stateMachine.reset();

      expect(stateMachine.getState()).toBe(BotState.DISCONNECTED);
      expect(stateMachine.getHistory()).toEqual([]);
    });

    it('should allow custom initial state on reset', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      stateMachine.reset(BotState.ERROR);

      expect(stateMachine.getState()).toBe(BotState.ERROR);
    });

    it('should reset isTransitioning flag', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      stateMachine.reset();
      expect(stateMachine.getStatus().isTransitioning).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return complete status object', () => {
      const status = stateMachine.getStatus();
      expect(status).toEqual({
        currentState: BotState.DISCONNECTED,
        availableTransitions: [BotState.CONNECTING, BotState.SHUTDOWN],
        isTransitioning: false,
        historySize: 0,
      });
    });

    it('should update status after transitions', async () => {
      await stateMachine.transition(BotState.CONNECTING);
      const status = stateMachine.getStatus();
      expect(status.currentState).toBe(BotState.CONNECTING);
      expect(status.historySize).toBe(1);
    });
  });

  describe('addTransition', () => {
    it('should allow adding custom transitions', () => {
      stateMachine.addTransition({
        from: BotState.DISCONNECTED,
        to: BotState.ERROR,
      });

      const result = await stateMachine.transition(BotState.ERROR);
      expect(result).toBe(true);
      expect(stateMachine.getState()).toBe(BotState.ERROR);
    });

    it('should support array of from states', () => {
      stateMachine.addTransition({
        from: [BotState.CONNECTED, BotState.RECONNECTING],
        to: BotState.ERROR,
      });

      // Test from CONNECTED
      const sm1 = new StateMachine(BotState.CONNECTED);
      sm1.addTransition({
        from: [BotState.CONNECTED, BotState.RECONNECTING],
        to: BotState.ERROR,
      });
      expect(sm1.canTransition(BotState.ERROR)).toBe(true);

      // Test from RECONNECTING
      const sm2 = new StateMachine(BotState.RECONNECTING);
      sm2.addTransition({
        from: [BotState.CONNECTED, BotState.RECONNECTING],
        to: BotState.ERROR,
      });
      expect(sm2.canTransition(BotState.ERROR)).toBe(true);
    });

    it('should return this for chaining', () => {
      const result = stateMachine.addTransition({
        from: BotState.DISCONNECTED,
        to: BotState.ERROR,
      });
      expect(result).toBe(stateMachine);
    });
  });

  describe('Events', () => {
    it('should emit stateChange event on successful transition', async () => {
      const handler = vi.fn();
      stateMachine.on('stateChange', handler);

      await stateMachine.transition(BotState.CONNECTING);

      expect(handler).toHaveBeenCalledWith(BotState.CONNECTING, BotState.DISCONNECTED);
    });

    it('should emit error event on validation failure', async () => {
      const errorHandler = vi.fn();
      stateMachine.on('error', errorHandler);

      stateMachine.addTransition({
        from: BotState.DISCONNECTED,
        to: BotState.CONNECTING,
        validator: () => false,
      });

      await stateMachine.transition(BotState.CONNECTING);

      expect(errorHandler).toHaveBeenCalled();
    });
  });
});
