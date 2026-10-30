/**
 * Authentication middleware for web server
 * JWT-based authentication with role-based access control
 */

import type { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { getConfig } from '../../config';

interface TokenPayload {
  username: string;
  role: 'guest' | 'trusted' | 'admin';
  iat: number;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

/**
 * JWT secret key - in production, use a strong secret from environment
 */
const JWT_SECRET = process.env.JWT_SECRET || 'mc-ai-bot-secret-change-in-production';
const JWT_EXPIRY = '24h';

/**
 * Generate a JWT token for a user
 */
export function generateToken(username: string, role: 'guest' | 'trusted' | 'admin' = 'guest'): string {
  return jwt.sign({ username, role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

/**
 * Verify a JWT token
 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Extract token from request (header, cookie, or query)
 */
function extractToken(req: Request): string | null {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Check cookie
  if (req.cookies?.token) {
    return req.cookies.token;
  }

  // Check query parameter (for Socket.io)
  if (req.query?.token && typeof req.query.token === 'string') {
    return req.query.token;
  }

  return null;
}

/**
 * Authentication middleware - requires valid token
 */
export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
      code: 'AUTH_REQUIRED'
    });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
      code: 'AUTH_INVALID'
    });
    return;
  }

  req.user = payload;
  next();
}

/**
 * Optional authentication middleware - adds user if token is valid but doesn't require it
 */
export function optionalAuthMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.user = payload;
    }
  }

  next();
}

/**
 * Role-based authorization middleware
 */
export function requireRole(...allowedRoles: ('guest' | 'trusted' | 'admin')[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
        code: 'AUTH_FORBIDDEN',
        required: allowedRoles,
        current: req.user.role
      });
      return;
    }

    next();
  };
}

/**
 * Admin only middleware
 */
export const requireAdmin = requireRole('admin');

/**
 * Trusted or admin middleware
 */
export const requireTrusted = requireRole('trusted', 'admin');

/**
 * Login endpoint handler
 */
export function createLoginHandler(adminPassword: string) {
  return (req: Request, res: Response): void => {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        error: 'Username and password required'
      });
      return;
    }

    // Check if it's admin login
    let role: 'guest' | 'trusted' | 'admin' = 'guest';

    if (password === adminPassword) {
      role = 'admin';
    } else {
      // For non-admin, you could check against a user database
      // For now, we'll allow any username with a non-admin password as 'guest'
      role = 'guest';
    }

    const token = generateToken(username, role);

    // Set cookie (httpOnly for security)
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    res.json({
      success: true,
      token,
      user: { username, role },
      expiresIn: JWT_EXPIRY,
    });
  };
}

/**
 * Logout endpoint handler
 */
export function logoutHandler(req: Request, res: Response): void {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully' });
}

/**
 * Get current user info
 */
export function meHandler(req: AuthenticatedRequest, res: Response): void {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: 'Not authenticated'
    });
    return;
  }

  res.json({
    success: true,
    user: {
      username: req.user.username,
      role: req.user.role,
    },
  });
}

/**
 * Socket.io authentication middleware
 */
export function socketAuthMiddleware(socket: any, next: (err?: Error) => void): void {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;

  if (!token) {
    return next(new Error('Authentication required'));
  }

  const payload = verifyToken(token);
  if (!payload) {
    return next(new Error('Invalid or expired token'));
  }

  socket.user = payload;
  next();
}

/**
 * Socket.io role-based authorization
 */
export function socketRequireRole(socket: any, ...allowedRoles: ('guest' | 'trusted' | 'admin')[]): boolean {
  if (!socket.user || !allowedRoles.includes(socket.user.role)) {
    return false;
  }
  return true;
}