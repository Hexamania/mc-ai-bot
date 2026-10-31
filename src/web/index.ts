/**
 * Web server module for mc-ai-bot
 * Express server with Socket.io for real-time dashboard
 *
 * Features:
 * - Express app with proper middleware (cors, helmet, compression, body parsing)
 * - Socket.io server with namespaces/rooms
 * - REST API endpoints (/api/state, /api/memory, /api/commands, etc.)
 * - Real-time event system (bot -> web, web -> bot)
 * - JWT-based authentication/authorization
 * - Rate limiting
 * - Static file serving
 * - Dashboard HTML serving
 */

import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import http from 'http';
import type { Socket } from 'socket.io';
import { Server as SocketIOServer } from 'socket.io';
import * as path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import type { BotManager } from '../bot';
import { getConfig } from '../config';
import type { BotState, BotStatus, BotPosition } from '../types';
import { initializeApiRoutes, apiRouter } from './routes/api';
import {
  initializeAllNamespaces,
  broadcastBotStatus,
  broadcastBotState,
  broadcastLog,
  broadcastChatMessage,
} from './socket/handlers';
import { createLoginHandler, logoutHandler, meHandler } from './middleware/auth';
import { rateLimiters } from './middleware/rateLimit';

/**
 * Web server manager
 */
export class WebServer {
  private app: Express;
  private server: http.Server;
  private io: SocketIOServer;
  private botManager: BotManager;
  private config = getConfig();
  private dashboardConnected = false;

  constructor(botManager: BotManager) {
    this.botManager = botManager;
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: this.config.web.host
          ? `http://${this.config.web.host}:${this.config.web.port}`
          : '*',
        methods: ['GET', 'POST'],
        credentials: true,
      },
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketHandlers();
    this.botManager.setSocketIO(this.io);
    this.setupBotEventForwarding();
  }

  /**
   * Set up Express middleware
   */
  private setupMiddleware(): void {
    // Trust proxy for rate limiting behind reverse proxy
    this.app.set('trust proxy', 1);

    // Security headers
    this.app.use(
      helmet({
        contentSecurityPolicy: false, // Disable for development, configure for production
        crossOriginEmbedderPolicy: false,
      })
    );

    // CORS configuration
    this.app.use(
      cors({
        origin: this.config.web.host
          ? `http://${this.config.web.host}:${this.config.web.port}`
          : true,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      })
    );

    // Compression
    this.app.use(compression());

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Cookie parser
    this.app.use(cookieParser());

    // Request logging (development)
    if (process.env.NODE_ENV !== 'production') {
      this.app.use((req: Request, res: Response, next: NextFunction) => {
        const start = Date.now();
        res.on('finish', () => {
          const duration = Date.now() - start;
          console.log(`[HTTP] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
        });
        next();
      });
    }

    // Static file serving
    const publicPath = path.join(__dirname, '../../Website test/public');
    const rootPath = path.join(__dirname, '../../');

    this.app.use(
      express.static(publicPath, {
        maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
        etag: true,
      })
    );

    this.app.use(
      express.static(rootPath, {
        maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
        etag: true,
      })
    );

    // Apply global rate limiting
    this.app.use(rateLimiters.static);
  }

  /**
   * Set up HTTP routes
   */
  private setupRoutes(): void {
    // Initialize API routes with bot manager
    initializeApiRoutes(this.botManager);

    // Auth endpoints (with stricter rate limiting)
    this.app.post(
      '/api/auth/login',
      rateLimiters.auth,
      createLoginHandler(this.config.admin.password)
    );
    this.app.post('/api/auth/logout', logoutHandler);
    this.app.get('/api/auth/me', meHandler);

    // API routes
    this.app.use('/api', apiRouter);

    // Main dashboard route
    this.app.get('/', (req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, '../../index.html'));
    });

    // Dashboard routes (serve index.html for SPA routing)
    this.app.get('/dashboard*', (req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, '../../index.html'));
    });

    // Health check (no auth)
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    });

    // 404 handler for non-API routes
    this.app.use((req: Request, res: Response) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({
          success: false,
          error: 'API endpoint not found',
          code: 'NOT_FOUND',
        });
      } else {
        // Serve index.html for SPA fallback
        res.sendFile(path.join(__dirname, '../../index.html'));
      }
    });

    // Error handling middleware
    this.app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
      console.error('[WEB] Server error:', err);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    });
  }

  /**
   * Set up Socket.io event handlers with namespaces
   */
  private setupSocketHandlers(): void {
    // Initialize all namespaces
    initializeAllNamespaces(this.io, this.botManager);

    // Global connection logging
    this.io.of('/').on('connection', (_socket: Socket) => {
      if (!this.dashboardConnected) {
        this.dashboardConnected = true;
        this.botManager.log('WEB', 'Dashboard connected');
      }
    });

    this.io.of('/').on('disconnect', (socket: Socket) => {
      this.botManager.log('WEB', `Dashboard disconnected: ${socket.id}`);
    });
  }

  /**
   * Set up bot event forwarding to web clients
   */
  private setupBotEventForwarding(): void {
    // Forward bot status changes
    this.botManager.on('status', (status: BotStatus) => {
      broadcastBotStatus(this.io, status);
    });

    // Forward state updates
    this.botManager.on('state', (state: BotState) => {
      broadcastBotState(this.io, state);
    });

    // Forward log entries
    this.botManager.on('log', (entry: string) => {
      broadcastLog(this.io, {
        level: entry.includes('ERROR') || entry.includes('ERR') ? 'error' : 'info',
        tag: entry.match(/^\[(.*?)\]/)?.[1] || 'BOT',
        message: entry.replace(/^\[.*?\]\s*/, ''),
      });
    });

    // Forward chat messages
    this.botManager.on('chat', (username: string, message: string, type: string) => {
      broadcastChatMessage(this.io, username, message, type as 'chat' | 'whisper' | 'broadcast');
    });

    // Forward path updates
    this.botManager.on('path_update', (path: BotPosition[]) => {
      this.io.of('/').to('all').emit('path_update', path);
    });
  }

  /**
   * Start the web server
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      const port = this.config.web.port;
      const host = this.config.web.host;

      const onListening = () => {
        this.botManager.log('WEB', `Dashboard running at http://${host || '127.0.0.1'}:${port}`);
        this.botManager.log('WEB', `API available at http://${host || '127.0.0.1'}:${port}/api`);
        resolve();
      };

      if (host) {
        this.server.listen(port, host, onListening);
      } else {
        this.server.listen(port, onListening);
      }
    });
  }

  /**
   * Stop the web server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all socket connections
      void this.io.close(() => {
        this.server.close(() => {
          this.botManager.log('WEB', 'Web server stopped');
          resolve();
        });
      });
    });
  }

  /**
   * Get Express app instance
   */
  getApp(): Express {
    return this.app;
  }

  /**
   * Get Socket.io instance
   */
  getIO(): SocketIOServer {
    return this.io;
  }

  /**
   * Get HTTP server instance
   */
  getServer(): http.Server {
    return this.server;
  }
}

/**
 * Create and return a WebServer instance
 */
export function createWebServer(botManager: BotManager): WebServer {
  return new WebServer(botManager);
}

// Re-export commonly used functions and types
export {
  broadcastBotStatus,
  broadcastBotState,
  broadcastLog,
  broadcastChatMessage,
} from './socket/handlers';

export { apiRouter, initializeApiRoutes } from './routes/api';

export {
  createLoginHandler,
  logoutHandler,
  meHandler,
  authMiddleware,
  optionalAuthMiddleware,
  requireAdmin,
  requireTrusted,
  generateToken,
  verifyToken,
} from './middleware/auth';

export { createRateLimiter, rateLimiters, createSocketRateLimiter } from './middleware/rateLimit';

export { NAMESPACES, SERVER_EVENTS, CLIENT_EVENTS, ROOMS, ROOM_EVENTS } from './socket/events';

export type { BotStatusPayload, BotStatePayload, BulkUpdatePayload } from './socket/events';

export { WebServer as default };
