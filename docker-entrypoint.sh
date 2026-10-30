#!/bin/sh
# Airi OS Docker Entrypoint
# Handles initialization and graceful shutdown

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo -e "${BLUE}[Airi OS]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[Airi OS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[Airi OS]${NC} $1"
}

log_error() {
    echo -e "${RED}[Airi OS]${NC} $1"
}

# Handle shutdown signals
shutdown() {
    log "Received shutdown signal, stopping gracefully..."
    if [ -n "$CHILD_PID" ]; then
        kill -TERM "$CHILD_PID" 2>/dev/null
        wait "$CHILD_PID" 2>/dev/null
    fi
    log_success "Shutdown complete"
    exit 0
}

trap shutdown SIGTERM SIGINT

# Validate required environment variables
validate_config() {
    log "Validating configuration..."

    if [ -z "$MC_HOST" ]; then
        log_error "MC_HOST is required"
        exit 1
    fi

    if [ -z "$MC_USERNAME" ]; then
        log_error "MC_USERNAME is required"
        exit 1
    fi

    if [ -z "$MC_PORT" ]; then
        log_warn "MC_PORT not set, using default 25565"
        export MC_PORT=25565
    fi

    if [ -z "$WEB_PORT" ]; then
        log_warn "WEB_PORT not set, using default 3000"
        export WEB_PORT=3000
    fi

    if [ -z "$MC_VERSION" ]; then
        log_warn "MC_VERSION not set, using default 1.21.1"
        export MC_VERSION=1.21.1
    fi

    log_success "Configuration validated"
}

# Initialize memory file if it doesn't exist
init_memory() {
    if [ ! -f /app/memory.json ]; then
        log "Initializing memory.json..."
        cat > /app/memory.json << 'EOF'
{
  "version": 1,
  "locations": {},
  "players": {},
  "currentTask": null,
  "rules": [],
  "facts": {}
}
EOF
        log_success "memory.json initialized"
    fi
}

# Initialize users file if it doesn't exist
init_users() {
    if [ ! -f /app/users.json ]; then
        log "Initializing users.json..."
        cat > /app/users.json << 'EOF'
{
  "admins": [],
  "trusted": [],
  "blocked": []
}
EOF
        log_success "users.json initialized"
    fi
}

# Main function
main() {
    log "Starting Airi OS..."
    log "Node version: $(node --version)"
    log "Environment: ${NODE_ENV:-production}"

    validate_config
    init_memory
    init_users

    # Check if we're running the desktop app or the bot
    if [ "$1" = "desktop" ]; then
        log "Starting Electron desktop app..."
        # Note: Electron requires a display server, which may not be available in Docker
        # This is mainly for CI/CD builds
        exec npm run desktop
    else
        log "Starting bot with web dashboard on port $WEB_PORT..."
        log "Connecting to Minecraft server: $MC_HOST:$MC_PORT as $MC_USERNAME"
        log "Minecraft version: $MC_VERSION"

        # Start the application
        exec node dist/index.js &
        CHILD_PID=$!
        wait $CHILD_PID
    fi
}

# Run main function with all arguments
main "$@"