# Airi OS Dockerfile
# Multi-stage build for production deployment

# =============================================================================
# Base Stage - Common dependencies
# =============================================================================
FROM node:20-alpine AS base

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    dumb-init

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# =============================================================================
# Dependencies Stage - Install all dependencies
# =============================================================================
FROM base AS deps

# Install all dependencies (including devDependencies for build)
RUN npm ci --include=dev

# =============================================================================
# Build Stage - Compile TypeScript and build frontend
# =============================================================================
FROM deps AS builder

# Copy source code
COPY . .

# Build main TypeScript project
RUN npm run build

# Build desktop main process
RUN npm run build:main

# Build desktop renderer (Vue/Vite)
RUN npm run build:renderer

# =============================================================================
# Production Dependencies Stage - Only production dependencies
# =============================================================================
FROM base AS prod-deps

# Install only production dependencies
RUN npm ci --omit=dev

# =============================================================================
# Production Stage - Final runtime image
# =============================================================================
FROM node:20-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
    dumb-init \
    tini

# Create non-root user
RUN addgroup -g 1001 -S airi && \
    adduser -S -D -H -u 1001 -h /app -s /sbin/nologin -G airi airi

# Set working directory
WORKDIR /app

# Copy production dependencies
COPY --from=prod-deps --chown=airi:airi /app/node_modules ./node_modules

# Copy built application
COPY --from=builder --chown=airi:airi /app/dist ./dist
COPY --from=builder --chown=airi:airi /app/desktop/dist ./desktop/dist
COPY --from=builder --chown=airi:airi /app/desktop/renderer/dist ./desktop/renderer/dist

# Copy necessary config files
COPY --chown=airi:airi package.json ./
COPY --chown=airi:airi memory.json ./
COPY --chown=airi:airi users.json ./
COPY --chown=airi:airi index.html ./

# Copy entrypoint script
COPY --chown=airi:airi docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Switch to non-root user
USER airi

# Expose dashboard port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Use tini as init process for proper signal handling
ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]

# Default command
CMD ["node", "dist/index.js"]

# =============================================================================
# Development Stage - For development with hot reload
# =============================================================================
FROM deps AS development

# Copy source code
COPY . .

# Expose ports (dashboard + Vite dev server)
EXPOSE 3000 5173

# Default command for development
CMD ["npm", "run", "dev"]