#!/usr/bin/env bash
# Forge Open Bench launcher — bridge + backend + frontend (all default on)
# Usage: ./launch.sh [--dev] [--no-bridge] [--no-backend] [--no-frontend] [port]
#        ./launch.sh --shutdown

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/.venv"
# Parse port from arguments — only treat a bare number as the port,
# never a flag like --no-usb.
PORT="8000"
for arg in "$@"; do
    case "$arg" in
        --dev|--no-bridge|--no-usb|--no-backend|--no-frontend|--shutdown|--help|-h) ;;
        *)
            if [[ "$arg" =~ ^[0-9]+$ ]]; then
                PORT="$arg"
            fi
            ;;
    esac
done

# --- Help ---
for arg in "$@"; do
    if [ "$arg" = "--help" ] || [ "$arg" = "-h" ]; then
        cat <<EOF
Usage: ./launch.sh [OPTIONS] [PORT]

Start the Forge Open Bench stack (bridge + backend + frontend).

Options:
  --dev          Hot-reload the FastAPI backend
  --no-bridge    Skip starting the BLE bridge server (pokit_server.py, :8765)
  --no-usb       Skip starting the USB bridge server (usb_server.py, :8766)
  --no-backend   Skip starting the FastAPI backend
  --no-frontend  Skip starting the Vite dev server
  --shutdown     Kill all running servers and exit
  -h, --help     Show this help and exit

Default port: 8000

Logs are written to ./logs/bridge.log, ./logs/usb.log, ./logs/backend.log, ./logs/frontend.log
To tail all: multitail -i logs/bridge.log -i logs/usb.log -i logs/backend.log -i logs/frontend.log
EOF
        exit 0
    fi
done

# --- Shutdown mode: kill all running servers and exit ---
for arg in "$@"; do
    if [ "$arg" = "--shutdown" ]; then
        echo "[Forge] Shutting down all running servers..."
        killed=0
        for pattern in "pokit_server.py" "usb_server.py" "uvicorn" "node_modules/.bin/vite"; do
            pids=$(pgrep -f "$pattern" 2>/dev/null || true)
            if [ -n "$pids" ]; then
                echo "[Forge]  Killing $pattern (PIDs: $pids)"
                echo "$pids" | xargs -r kill -9 2>/dev/null || true
                killed=$((killed + $(echo "$pids" | wc -w)))
            fi
        done
        # Also force-release the backend port
        if command -v fuser >/dev/null 2>&1; then
            fuser -k "$PORT/tcp" 2>/dev/null || true
        fi
        sleep 0.5
        if [ "$killed" -gt 0 ]; then
            echo "[Forge] Killed $killed process(es)."
        else
            echo "[Forge] No running servers found."
        fi
        exit 0
    fi
done

# Parse flags
DEV_MODE=false
USE_BRIDGE=true
USE_USB=true
USE_BACKEND=true
USE_FRONTEND=true

for arg in "$@"; do
    case "$arg" in
        --dev) DEV_MODE=true ;;
        --no-bridge) USE_BRIDGE=false ;;
        --no-usb) USE_USB=false ;;
        --no-backend) USE_BACKEND=false ;;
        --no-frontend) USE_FRONTEND=false ;;
    esac
done

if [ ! -d "$VENV" ]; then
    echo "Creating virtualenv..."
    python3 -m venv "$VENV"
fi

# We do not source activate here; every command below uses "$VENV/bin/<tool>"
# explicitly, so the script works regardless of where the repo folder lives.

cd "$SCRIPT_DIR"

# Log directory
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Track PIDs so we can kill them (and their children) on Ctrl+C
PIDS=()

kill_tree() {
    local pid="$1"
    # Recursively kill children first, then the parent
    local children
    children=$(pgrep -P "$pid" 2>/dev/null || true)
    for child in $children; do
        kill_tree "$child"
    done
    kill "$pid" 2>/dev/null || true
}

cleanup() {
    echo "[Forge] Shutting down..."
    # Kill every tracked process and its children
    for pid in "${PIDS[@]}"; do
        kill_tree "$pid"
    done
    # Give them a moment, then force-kill any survivors
    sleep 1
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
            # Also nuke any remaining children
            pgrep -P "$pid" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
        fi
    done
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM
trap '' HUP

kill_stale() {
    local pattern="$1"
    local label="$2"
    local pids
    pids=$(pgrep -f "$pattern" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "[Forge]  Killing stale $label (PIDs: $pids)"
        echo "$pids" | xargs -r kill -9 2>/dev/null || true
        sleep 0.5
    fi
}

start_bg() {
    local name="$1"
    local log="$2"
    shift 2
    echo "[Forge] Starting $name (log: $log)"
    "$@" > "$log" 2>&1 &
    PIDS+=("$!")
}

# 1. BLE Bridge (standalone bleak server)
if [ "$USE_BRIDGE" = true ]; then
    kill_stale "pokit_server.py" "BLE bridge"
    BRIDGE_LOG="$LOG_DIR/bridge_${LOG_TIMESTAMP}.log"
    ln -sf "$BRIDGE_LOG" "$LOG_DIR/bridge.log"
    start_bg "BLE bridge on ws://0.0.0.0:8765" "logs/bridge.log" "$VENV/bin/python" server/pokit-bridge/pokit_server.py
fi

# 2. USB Bridge (Hantek / sigrok server)
if [ "$USE_USB" = true ]; then
    kill_stale "usb_server.py" "USB bridge"
    USB_LOG="$LOG_DIR/usb_${LOG_TIMESTAMP}.log"
    ln -sf "$USB_LOG" "$LOG_DIR/usb.log"
    start_bg "USB bridge on ws://0.0.0.0:8766" "logs/usb.log" "$VENV/bin/python" server/usb-bridge/usb_server.py
fi

# 3. FastAPI Backend
if [ "$USE_BACKEND" = true ]; then
    kill_stale "uvicorn backend.app:app" "backend"
    BACKEND_LOG="$LOG_DIR/backend_${LOG_TIMESTAMP}.log"
    ln -sf "$BACKEND_LOG" "$LOG_DIR/backend.log"
    if [ "$DEV_MODE" = true ]; then
        # Watch only backend source code; logs/ and other project files must not reload
        start_bg "backend on port $PORT" "logs/backend.log" "$VENV/bin/uvicorn" backend.app:app --host 0.0.0.0 --port "$PORT" --reload --reload-dir backend --log-level info
    else
        start_bg "backend on port $PORT" "logs/backend.log" "$VENV/bin/uvicorn" backend.app:app --host 0.0.0.0 --port "$PORT" --log-level info
    fi
fi

# 4. Frontend (Vite dev server — default; use --no-frontend to skip)
if [ "$USE_FRONTEND" = true ]; then
    kill_stale "node_modules/.bin/vite" "frontend dev server"
    FRONTEND_LOG="$LOG_DIR/frontend_${LOG_TIMESTAMP}.log"
    ln -sf "$FRONTEND_LOG" "$LOG_DIR/frontend.log"
    start_bg "frontend dev server" "logs/frontend.log" bash -c "cd '$SCRIPT_DIR/frontend' && npm run dev"
fi

# Wait for any background job to finish; if one dies, the launcher exits.
set +e  # disable errexit inside the loop — a background job failing must not kill the launcher
# Ctrl+C triggers the INT trap, which kills the whole tree.
while [ ${#PIDS[@]} -gt 0 ]; do
    wait -n 2>/dev/null || true
    # Remove dead PIDs from the array so we don't try to kill them again
    new_pids=()
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            new_pids+=("$pid")
        fi
    done
    PIDS=("${new_pids[@]}")
done
