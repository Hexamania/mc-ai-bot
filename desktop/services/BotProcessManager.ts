/**
 * Bot process manager - spawns, monitors, and restarts the bot worker process
 */

import type { UtilityProcess } from 'electron';
import { app, utilityProcess } from 'electron';
import * as path from 'node:path';
import { EventEmitter } from 'events';
import type { Settings } from '../renderer/src/types';
import type { LogService } from './LogService';

interface BotProcessState {
  running: boolean;
  pid: number | null;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'restarting';
  error: string | null;
  restartCount: number;
  lastRestart: number | null;
}

export class BotProcessManager extends EventEmitter {
  private botProcess: UtilityProcess | null = null;
  private state: BotProcessState = {
    running: false,
    pid: null,
    status: 'stopped',
    error: null,
    restartCount: 0,
    lastRestart: null,
  };
  private settings: Settings | null = null;
  private logService: LogService;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private maxRestarts = 5;
  private restartDelay = 5000;
  private maxRestartDelay = 60000;

  constructor(logService: LogService) {
    super();
    this.logService = logService;
    this.setMaxListeners(50);
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
  }

  getState(): BotProcessState {
    return { ...this.state };
  }

  isRunning(): boolean {
    return this.state.running && this.botProcess !== null;
  }

  async start(): Promise<void> {
    if (this.isRunning()) {
      throw new Error('Bot is already running');
    }

    if (!this.settings) {
      throw new Error('Settings not configured');
    }

    this.stopping = false;
    this.updateState({ status: 'starting', error: null });

    const config = this.settings;

    const childEnv = {
      ...process.env,
      MC_HOST: config.host,
      MC_PORT: String(config.port),
      MC_USERNAME: config.username,
      MC_VERSION: config.version,
      ENABLE_MEMORY: String(config.enableMemory),
      WEB_PORT: String(config.webPort),
      WEB_HOST: '127.0.0.1',
      MEMORY_FILE: path.join(app.getPath('userData'), 'memory.json'),
      OPENAI_KEY: config.openaiKey,
      OPENAI_API_KEY: '',
    };

    const entry = path.join(app.getAppPath(), 'desktop', 'bot-worker', 'main.js');

    this.logService.appendLog(
      'system',
      `Starting bot worker for ${config.host}:${config.port} (Minecraft ${config.version}).`
    );

    this.botProcess = utilityProcess.fork(entry, [], {
      cwd: app.getPath('userData'),
      env: childEnv,
      stdio: 'pipe',
      serviceName: 'Airi Minecraft Bot',
    });

    const buffers = { stdout: '', stderr: '' };

    this.botProcess.stdout?.on('data', (chunk: Buffer) => {
      this.pipeChildOutput('stdout', chunk, buffers);
    });

    this.botProcess.stderr?.on('data', (chunk: Buffer) => {
      this.pipeChildOutput('stderr', chunk, buffers);
    });

    this.botProcess.stdout?.on('error', (error: Error) => {
      this.logService.appendLog('error', `Could not read bot stdout: ${error.message}`);
    });

    this.botProcess.stderr?.on('error', (error: Error) => {
      this.logService.appendLog('error', `Could not read bot stderr: ${error.message}`);
    });

    this.botProcess.on('spawn', () => {
      this.logService.appendLog('system', `Bot worker started (PID ${this.botProcess?.pid}).`);
      this.updateState({
        running: true,
        pid: this.botProcess?.pid ?? null,
        status: 'running',
      });
      this.startHealthCheck();
    });

    this.botProcess.on('error', (error: Error) => {
      this.logService.appendLog(
        'error',
        `Bot worker failed to start: ${error.stack || error.message}`
      );
      this.updateState({ status: 'error', error: error.message });
      this.handleCrash();
    });

    this.botProcess.on('exit', (code: number) => {
      this.flushChildOutput(buffers);
      this.stopHealthCheck();

      const wasStopped = this.stopping;
      this.stopping = false;

      this.logService.appendLog(
        code === 0 ? 'system' : 'error',
        `Bot worker exited with code ${code}.`
      );

      this.botProcess = null;
      this.updateState({
        running: false,
        pid: null,
        status: wasStopped || code === 0 ? 'stopped' : 'error',
        error: wasStopped || code === 0 ? null : `Process exited with code ${code}`,
      });

      if (!wasStopped && code !== 0) {
        this.handleCrash();
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning() || !this.botProcess) {
      return;
    }

    this.stopping = true;
    this.updateState({ status: 'stopping' });
    this.logService.appendLog('system', 'Stop requested.');
    this.stopHealthCheck();

    this.botProcess.kill();
  }

  async restart(): Promise<{ success: boolean; error?: string }> {
    if (this.isRunning()) {
      await this.stop();
      // Wait for process to fully stop
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    try {
      await this.start();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  private pipeChildOutput(
    stream: 'stdout' | 'stderr',
    data: Buffer,
    buffers: { stdout: string; stderr: string }
  ): void {
    buffers[stream] = (buffers[stream] || '') + data.toString();
    const lines = buffers[stream].split(/\r?\n/);
    buffers[stream] = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        this.logService.appendLog(stream as 'stdout' | 'stderr', line);
      }
    }
  }

  private flushChildOutput(buffers: { stdout: string; stderr: string }): void {
    for (const [stream, line] of Object.entries(buffers)) {
      if (line && line.trim()) {
        this.logService.appendLog(stream as 'stdout' | 'stderr', line);
      }
    }
  }

  private updateState(partial: Partial<BotProcessState>): void {
    this.state = { ...this.state, ...partial };
    this.emit('state-changed', this.getState());
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(() => {
      if (this.botProcess && !this.botProcess.killed) {
        // Process is alive
        this.emit('health-check', { alive: true, pid: this.botProcess.pid });
      } else if (this.state.running) {
        // Process died unexpectedly
        this.logService.appendLog('error', 'Bot process died unexpectedly');
        this.handleCrash();
      }
    }, 5000);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private handleCrash(): void {
    if (this.stopping) return;

    this.state.restartCount++;
    this.state.lastRestart = Date.now();

    if (this.state.restartCount > this.maxRestarts) {
      this.logService.appendLog(
        'error',
        `Max restart attempts (${this.maxRestarts}) reached. Bot will not auto-restart.`
      );
      this.updateState({ status: 'error', error: 'Max restart attempts reached' });
      return;
    }

    const delay = Math.min(
      this.restartDelay * Math.pow(2, this.state.restartCount - 1),
      this.maxRestartDelay
    );
    this.logService.appendLog(
      'system',
      `Bot crashed. Restarting in ${delay}ms (attempt ${this.state.restartCount}/${this.maxRestarts})...`
    );

    this.updateState({ status: 'restarting' });

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      try {
        await this.start();
        this.state.restartCount = 0; // Reset on successful restart
      } catch (error) {
        this.logService.appendLog('error', `Restart failed: ${(error as Error).message}`);
        this.handleCrash();
      }
    }, delay);
  }

  shutdown(): void {
    this.stopping = true;
    this.stopHealthCheck();

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.botProcess) {
      this.botProcess.kill();
      this.botProcess = null;
    }

    this.updateState({
      running: false,
      pid: null,
      status: 'stopped',
    });
  }
}
