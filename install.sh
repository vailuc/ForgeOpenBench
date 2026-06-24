#!/usr/bin/env bash
# install.sh — Forge Open Bench setup script
# Idempotent: safe to re-run on an existing install.
# Tested on: Debian 12, Ubuntu 22.04/24.04, Raspberry Pi OS (bookworm)
#
# Usage:
#   chmod +x install.sh && ./install.sh
#
# What it does:
#   1. Detects OS and installs system deps (node, python3, sigrok-cli)
#   2. Creates Python venv and installs backend deps
#   3. Runs npm install for the frontend
#   4. Installs udev rule for Hantek 6022BL (no sudo needed at runtime)
#   5. Creates optional .desktop launcher

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
NODE_MIN=18

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[FOB]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()   { echo -e "${RED}[ERR]${NC}  $*" >&2; exit 1; }

# ── 1. Detect OS + install system deps ────────────────────────────────────────
info "Detecting OS..."

if command -v apt-get &>/dev/null; then
    PKG_MGR="apt"
elif command -v pacman &>/dev/null; then
    PKG_MGR="pacman"
elif command -v brew &>/dev/null; then
    PKG_MGR="brew"
else
    warn "Unknown package manager — skipping system dep install. Ensure node, python3, sigrok-cli are installed manually."
    PKG_MGR="none"
fi

install_pkg() {
    case "$PKG_MGR" in
        apt)    sudo apt-get install -y "$@" ;;
        pacman) sudo pacman -S --noconfirm "$@" ;;
        brew)   brew install "$@" ;;
        none)   warn "Skipping: $*" ;;
    esac
}

info "Checking system dependencies..."

# Node.js
if command -v node &>/dev/null; then
    NODE_VER=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
    if [ "$NODE_VER" -lt "$NODE_MIN" ]; then
        warn "Node.js $NODE_VER found, need >= $NODE_MIN"
        case "$PKG_MGR" in
            apt)
                curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
                sudo apt-get install -y nodejs
                ;;
            *) die "Please upgrade Node.js to >= $NODE_MIN manually." ;;
        esac
    else
        ok "Node.js $NODE_VER"
    fi
else
    info "Installing Node.js..."
    case "$PKG_MGR" in
        apt)
            curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
            sudo apt-get install -y nodejs
            ;;
        pacman) install_pkg nodejs npm ;;
        brew)   install_pkg node ;;
        none)   die "Node.js not found — install Node >= $NODE_MIN manually." ;;
    esac
fi

# Python 3.10+
if ! command -v python3 &>/dev/null; then
    info "Installing Python 3..."
    case "$PKG_MGR" in
        apt)    install_pkg python3 python3-venv python3-pip ;;
        pacman) install_pkg python python-pip ;;
        brew)   install_pkg python ;;
        none)   die "Python 3 not found." ;;
    esac
else
    ok "Python $(python3 --version)"
fi

# sigrok-cli + firmware
if ! command -v sigrok-cli &>/dev/null; then
    info "Installing sigrok-cli..."
    case "$PKG_MGR" in
        apt)    install_pkg sigrok-cli ;;
        pacman) install_pkg sigrok-cli ;;
        brew)   install_pkg sigrok-cli ;;
        none)   warn "sigrok-cli not found — WaveForge USB capture will not work." ;;
    esac
else
    ok "sigrok-cli $(sigrok-cli --version 2>&1 | head -1)"
fi

info "Installing sigrok firmware..."
case "$PKG_MGR" in
    apt)    install_pkg sigrok-firmware-free sigrok-firmware-fx2lafw sigrok-firmware-hantek-6xxx ;;
    pacman)
        # Arch splits sigrok firmware into per-device packages; the old
        # 'sigrok-firmware-free' meta-package does not exist.
        if pacman -Si sigrok-firmware-fx2lafw &>/dev/null; then
            install_pkg sigrok-firmware-fx2lafw
        else
            warn "sigrok-firmware-fx2lafw not found in pacman repos — install manually if WaveForge USB capture fails."
        fi
        ;;
    brew)   warn "Install sigrok-firmware-free/fx2lafw manually via brew if needed." ;;
    none)   warn "Could not install sigrok firmware — USB capture may fail." ;;
esac

# ── 2. Rust DSO capture binary (WaveForge scope mode) ─────────────────────────
RUST_BIN="$SCRIPT_DIR/server/usb-bridge/hantek-capture/target/release/hantek-capture"
if [ ! -f "$RUST_BIN" ]; then
    if command -v cargo &>/dev/null; then
        info "Building Rust DSO capture binary..."
        (cd "$SCRIPT_DIR/server/usb-bridge/hantek-capture" && cargo build --release) || warn "Rust build failed — DSO scope mode will not work."
    else
        warn "cargo not found and pre-built Rust binary missing — DSO scope mode will not work."
    fi
else
    ok "Rust DSO capture binary present"
fi

# ── 3. Python venv + backend deps ─────────────────────────────────────────────
info "Setting up Python venv at $VENV_DIR..."

if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi

"$VENV_DIR/bin/pip" install --upgrade pip --quiet

REQ_FILES=(
    "$SCRIPT_DIR/backend/requirements.txt"
    "$SCRIPT_DIR/server/pokit-bridge/requirements.txt"
    "$SCRIPT_DIR/server/usb-bridge/requirements.txt"
)

for req in "${REQ_FILES[@]}"; do
    if [ -f "$req" ]; then
        info "Installing Python deps from $(basename "$(dirname "$req")")/requirements.txt..."
        "$VENV_DIR/bin/pip" install -r "$req" --quiet
        ok "$(basename "$(dirname "$req")") deps installed"
    fi
done

# ── 3. Frontend npm install ────────────────────────────────────────────────────
FRONTEND_DIR="$SCRIPT_DIR/frontend"
if [ -f "$FRONTEND_DIR/package.json" ]; then
    info "Installing frontend npm packages..."
    cd "$FRONTEND_DIR"
    npm install --silent
    ok "npm packages installed"
    cd "$SCRIPT_DIR"
else
    warn "frontend/package.json not found — skipping npm install."
fi

# ── 4. udev rules for USB instruments (WaveForge / Hantek / FX2) ────────────
UDEV_SRC="$SCRIPT_DIR/server/usb-bridge/99-waveforge.rules"
UDEV_FILE="/etc/udev/rules.d/99-waveforge.rules"

if [ -f "$UDEV_SRC" ] && [ ! -f "$UDEV_FILE" ]; then
    info "Installing udev rules for USB instruments..."
    sudo cp "$UDEV_SRC" "$UDEV_FILE"
    sudo udevadm control --reload-rules 2>/dev/null || true
    sudo udevadm trigger 2>/dev/null || true
    ok "udev rules installed ($UDEV_FILE)"
else
    ok "udev rules already present"
fi

# Ensure plugdev group exists, then add current user if not already a member
if command -v groups &>/dev/null && ! groups | grep -qw plugdev; then
    if ! getent group plugdev >/dev/null 2>&1; then
        info "Creating plugdev group..."
        sudo groupadd plugdev >/dev/null 2>&1 || warn "Could not create plugdev group; you may need to create it manually."
    fi
    if getent group plugdev >/dev/null 2>&1; then
        info "Adding $USER to plugdev group..."
        sudo usermod -aG plugdev "$USER" >/dev/null 2>&1 && warn "Log out and back in for plugdev group to take effect." || warn "Could not add $USER to plugdev group."
    fi
fi

# ── 5. .desktop launcher (optional) ───────────────────────────────────────────
DESKTOP_FILE="$HOME/.local/share/applications/ForgeOpenBench.desktop"
if [ ! -f "$DESKTOP_FILE" ] && [ -d "$HOME/.local/share/applications" ]; then
    info "Creating .desktop launcher..."
    cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=Forge Open Bench
Comment=Hardware bench IDE
Exec=bash -c "cd $SCRIPT_DIR && ./launch.sh" %u
Icon=$SCRIPT_DIR/frontend/public/favicon.ico
Terminal=true
Type=Application
Categories=Development;Electronics;
EOF
    ok ".desktop launcher created"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Forge Open Bench — installation complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Start the bench:  ${CYAN}./launch.sh${NC}"
echo -e "  Skip BLE bridge:  ${CYAN}./launch.sh --no-bridge${NC}"
echo -e "  Skip USB bridge:  ${CYAN}./launch.sh --no-usb${NC}"
echo -e "  Dev mode:         ${CYAN}./launch.sh --dev${NC}"
echo ""
