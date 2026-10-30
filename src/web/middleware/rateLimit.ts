/**
 * Rate limiting middleware for web server
 * Uses in-memory store with sliding window algorithm
 */

import type { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface RateLimitConfig {
  windowMs: number;        // Time window in milliseconds
  maxRequests: number;     // Maximum requests per window
  message?: string;        // Custom error message
  statusCode?: number;     // HTTP status code for rate limit
  keyGenerator?: (req: Request) => string; // Custom key generator
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

// In-memory store (use Redis in production)
const store = new Map<string, RateLimitEntry>();

/**
 * Default configuration
 */
const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60000,        // 1 minute
  maxRequests: 100,       // 100 requests per minute
  message: 'Too many requests, please try again later',
  statusCode: 429,
  keyGenerator: (req: Request) => req.ip || 'unknown',
};

interface RequestWithUser extends Request {
  user?: { username: string };
}

/**
 * Create rate limiting middleware
 */
export function createRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const options = { ...DEFAULT_CONFIG, ...config };

  // Clean up old entries periodically
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of Array.from(store.entries())) {
      if (now - entry.windowStart >= options.windowMs) {
        store.delete(key);
      }
    }
  }, options.windowMs);

  // Clean up on process exit
  process.on('exit', () => clearInterval(cleanupInterval));

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = options.keyGenerator!(req);
    const now = Date.now();

    let entry = store.get(key);

    // Initialize or reset window
    if (!entry || now - entry.windowStart >= options.windowMs) {
      entry = { count: 0, windowStart: now };
      store.set(key, entry);
    }

    // Check if limit exceeded
    if (entry.count >= options.maxRequests) {
      const retryAfter = Math.ceil((options.windowMs - (now - entry.windowStart)) / 1000);

      res.set('Retry-After', String(retryAfter));
      res.set('X-RateLimit-Limit', String(options.maxRequests));
      res.set('X-RateLimit-Remaining', '0');
      res.set('X-RateLimit-Reset', String(Math.ceil((entry.windowStart + options.windowMs) / 1000)));

      res.status(options.statusCode!).json({
        success: false,
        error: options.message,
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter,
      });
      return;
    }

    // Increment counter
    entry.count++;

    // Set rate limit headers
    res.set('X-RateLimit-Limit', String(options.maxRequests));
    res.set('X-RateLimit-Remaining', String(options.maxRequests - entry.count));
    res.set('X-RateLimit-Reset', String(Math.ceil((entry.windowStart + options.windowMs) / 1000)));

    next();
  };
}

/**
 * Pre-configured rate limiters
 */
export const rateLimiters = {
  // Strict rate limiting for auth endpoints
  auth: createRateLimiter({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    maxRequests: 5,            // 5 attempts per 15 minutes
    message: 'Too many login attempts, please try again later',
    statusCode: 429,
  }),

  // Moderate rate limiting for API endpoints
  api: createRateLimiter({
    windowMs: 60000,           // 1 minute
    maxRequests: 60,           // 60 requests per minute
    message: 'Too many API requests, please slow down',
  }),

  // Lenient rate limiting for static assets
  static: createRateLimiter({
    windowMs: 60000,
    maxRequests: 200,
    message: 'Too many requests',
  }),

  // Strict rate limiting for command execution
  commands: createRateLimiter({
    windowMs: 60000,
    maxRequests: 30,
    message: 'Too many commands, please wait',
    keyGenerator: (req: RequestWithUser) => `cmd:${req.ip}:${req.user?.username || 'anonymous'}`,
  }),

  // WebSocket connection rate limiting
  websocket: createRateLimiter({
    windowMs: 60000,
    maxRequests: 20,
    message: 'Too many connection attempts',
    keyGenerator: (req) => `ws:${req.ip}`,
  }),
};

/**
 * Rate limiter for Socket.io
 */
export function createSocketRateLimiter(maxEventsPerMinute = 60) {
  const socketStore = new Map<string, { count: number; windowStart: number }>();

  return (socket: any, next: (err?: Error) => void): void => {
    const key = socket.user?.username || socket.id;
    const now = Date.now();
    const windowMs = 60000;

    let entry = socketStore.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      socketStore.set(key, entry);
    }

    if (entry.count >= maxEventsPerMinute) {
      return next(new Error('Rate limit exceeded'));
    }

    entry.count++;
    next();
  };
}

/**
 * Get current rate limit status for a key
 */
export function getRateLimitStatus(key: string, windowMs = 60000): { count: number; remaining: number; resetTime: number } | null {
  const entry = store.get(key);
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.windowStart >= windowMs) return null;

  return {
    count: entry.count,
    remaining: Math.max(0, DEFAULT_CONFIG.maxRequests - entry.count),
    resetTime: entry.windowStart + windowMs,
  };
}

/**
 * Reset rate limit for a key
 */
export function resetRateLimit(key: string): void {
  store.delete(key);
}

/**
 * Clear all rate limits (for testing/admin)
 */
export function clearAllRateLimits(): void {
  store.clear();
}