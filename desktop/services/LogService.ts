/**
 * Log service with file persistence, search, filter, and export
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LogEntry, LogQuery, LogSearchQuery, LogExportOptions } from '../renderer/src/types';

const MAX_LOG_HISTORY = 500;
const MAX_LOG_FILE_BYTES = 512 * 1024;

export class LogService {
  private logHistory: LogEntry[] = [];
  private logSequence = 0;
  private logFilePath: string;
  private subscribers = new Set<(entry: LogEntry) => void>();

  constructor() {
    this.logFilePath = path.join(app.getPath('userData'), 'airi-os.log');
  }

  private getLogFilePath(): string {
    return this.logFilePath;
  }

  appendLog(stream: 'stdout' | 'stderr' | 'system' | 'error', message: string): LogEntry {
    const entry: LogEntry = {
      id: `${Date.now()}-${++this.logSequence}`,
      time: new Date().toISOString(),
      stream,
      line: String(message).trimEnd(),
    };

    if (!entry.line) return entry;

    this.logHistory.push(entry);
    if (this.logHistory.length > MAX_LOG_HISTORY) {
      this.logHistory.splice(0, this.logHistory.length - MAX_LOG_HISTORY);
    }

    this.persistLog(entry);
    this.notifySubscribers(entry);

    return entry;
  }

  private persistLog(entry: LogEntry): void {
    try {
      const file = this.getLogFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });

      if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_FILE_BYTES) {
        const lines = fs
          .readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-MAX_LOG_HISTORY / 2);
        fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
      }

      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      console.error(`Unable to persist application log: ${(error as Error).message}`);
    }
  }

  private notifySubscribers(entry: LogEntry): void {
    for (const callback of this.subscribers) {
      try {
        callback(entry);
      } catch (error) {
        console.error('Log subscriber error:', error);
      }
    }
  }

  subscribe(callback: (entry: LogEntry) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getLogs(query: LogQuery = {}): LogEntry[] {
    const { limit = MAX_LOG_HISTORY, offset = 0, filter = 'all' } = query;

    let logs = [...this.logHistory];

    if (filter === 'errors') {
      logs = logs.filter((e) => e.stream === 'error' || e.stream === 'stderr');
    } else if (filter === 'system') {
      logs = logs.filter((e) => e.stream === 'system');
    }

    return logs.slice(offset, offset + limit);
  }

  searchLogs(query: LogSearchQuery): LogEntry[] {
    const { query: searchQuery, filter = 'all', timeRange, limit = 100 } = query;

    let logs = [...this.logHistory];

    if (filter === 'errors') {
      logs = logs.filter((e) => e.stream === 'error' || e.stream === 'stderr');
    } else if (filter === 'system') {
      logs = logs.filter((e) => e.stream === 'system');
    }

    if (timeRange) {
      const start = new Date(timeRange.start).getTime();
      const end = new Date(timeRange.end).getTime();
      logs = logs.filter((e) => {
        const time = new Date(e.time).getTime();
        return time >= start && time <= end;
      });
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      logs = logs.filter(
        (e) => e.line.toLowerCase().includes(q) || e.stream.toLowerCase().includes(q)
      );
    }

    return logs.slice(-limit);
  }

  async exportLogs(options: LogExportOptions): Promise<{ path: string }> {
    const { format, filter = 'all', timeRange } = options;

    let logs = [...this.logHistory];

    if (filter === 'errors') {
      logs = logs.filter((e) => e.stream === 'error' || e.stream === 'stderr');
    } else if (filter === 'system') {
      logs = logs.filter((e) => e.stream === 'system');
    }

    if (timeRange) {
      const start = new Date(timeRange.start).getTime();
      const end = new Date(timeRange.end).getTime();
      logs = logs.filter((e) => {
        const time = new Date(e.time).getTime();
        return time >= start && time <= end;
      });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = format === 'json' ? 'json' : format === 'csv' ? 'csv' : 'txt';
    const exportPath = path.join(app.getPath('userData'), `airi-os-logs-${timestamp}.${ext}`);

    let content: string;

    switch (format) {
      case 'json':
        content = JSON.stringify(logs, null, 2);
        break;
      case 'csv':
        content =
          'id,time,stream,line\n' +
          logs
            .map((e) => `"${e.id}","${e.time}","${e.stream}","${e.line.replace(/"/g, '""')}"`)
            .join('\n');
        break;
      case 'txt':
      default:
        content = logs
          .map(
            (e) =>
              `${new Date(e.time).toLocaleTimeString([], { hour12: false })} [${e.stream.toUpperCase()}] ${e.line}`
          )
          .join('\n');
        break;
    }

    fs.writeFileSync(exportPath, content, 'utf8');
    return { path: exportPath };
  }

  clearLogs(): void {
    this.logHistory = [];
    this.logSequence = 0;

    try {
      fs.writeFileSync(this.getLogFilePath(), '', 'utf8');
    } catch (error) {
      console.error(`Unable to clear saved logs: ${(error as Error).message}`);
      throw error;
    }
  }

  readSavedLogs(): LogEntry[] {
    try {
      const file = this.getLogFilePath();
      if (!fs.existsSync(file)) return [];

      const lines = fs
        .readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-MAX_LOG_HISTORY);
      return lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as LogEntry];
        } catch {
          return [{ time: new Date().toISOString(), stream: 'system' as const, line }];
        }
      });
    } catch (error) {
      console.error(`Unable to read saved application logs: ${(error as Error).message}`);
      return [];
    }
  }

  getHistory(): LogEntry[] {
    return [...this.logHistory];
  }
}
