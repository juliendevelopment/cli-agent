#!/usr/bin/env bash
set -e

# CLI-Agent Installer
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/juliendevelopment/cli-agent/main/install.sh | bash
#   or locally: ./install.sh

REPO="juliendevelopment/cli-agent"
INSTALL_DIR="${HOME}/.cli-agent"
BIN_DIR="${HOME}/.local/bin"

# Colors
C_RESET='\033[0m'
C_BOLD='\033[1m'
C_CYAN='\033[0;36m'
C_GREEN='\033[0;32m'
C_YELLOW='\033[0;33m'
C_RED='\033[0;31m'
C_GRAY='\033[0;90m'

echo -e "${C_CYAN}${C_BOLD}"
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║             🤖 CLI-AGENT INSTALLER                ║"
echo "  ║        AI Agent Terminal Workspace Manager        ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo -e "${C_RESET}"

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
    echo -e "${C_RED}❌ Node.js is not installed.${C_RESET}"
    echo -e "Please install Node.js (v18+) before installing cli-agent:"
    echo -e "  - Ubuntu/Debian : sudo apt install nodejs npm"
    echo -e "  - Fedora/RHEL   : sudo dnf install nodejs"
    echo -e "  - macOS         : brew install node"
    exit 1
fi

NODE_VERSION=$(node -v)
echo -e "${C_GREEN}✓${C_RESET} Node.js detected (${NODE_VERSION})"

# 2. Check Tmux
if ! command -v tmux >/dev/null 2>&1; then
    echo -e "${C_YELLOW}⚠️ tmux is not installed. Installing it with your package manager (may ask for your sudo password)...${C_RESET}"
    if command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y tmux
    elif command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update && sudo apt-get install -y tmux
    elif command -v brew >/dev/null 2>&1; then
        brew install tmux
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm tmux
    else
        echo -e "${C_RED}Could not install tmux automatically. Please install it manually.${C_RESET}"
        exit 1
    fi
fi

TMUX_VERSION=$(tmux -V)
echo -e "${C_GREEN}✓${C_RESET} tmux detected (${TMUX_VERSION})"

# The quick switcher popup needs tmux >= 3.2
TMUX_MAJOR=$(echo "${TMUX_VERSION}" | sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\1/')
TMUX_MINOR=$(echo "${TMUX_VERSION}" | sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\2/')
if [ -n "${TMUX_MAJOR}" ] && { [ "${TMUX_MAJOR}" -lt 3 ] || { [ "${TMUX_MAJOR}" -eq 3 ] && [ "${TMUX_MINOR}" -lt 2 ]; }; }; then
    echo -e "${C_YELLOW}⚠️ tmux >= 3.2 is recommended (the Ctrl+E switcher popup will not work).${C_RESET}"
fi

# Optional: clipboard tool (never installed silently)
if ! command -v wl-copy >/dev/null 2>&1 && ! command -v xclip >/dev/null 2>&1 && ! command -v pbcopy >/dev/null 2>&1; then
    echo -e "${C_YELLOW}ℹ️  No clipboard tool found. Mouse selections will rely on OSC 52 only.${C_RESET}"
    echo -e "${C_GRAY}   Optional: install wl-clipboard (Wayland) or xclip (X11) with your package manager.${C_RESET}"
fi

# 3. Create destination directories
mkdir -p "${INSTALL_DIR}"
mkdir -p "${BIN_DIR}"

# 4. Install files (No git checkout / no .git folder needed)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"

if [ -f "${SCRIPT_DIR}/bin/cli-agent.js" ] && [ "${SCRIPT_DIR}" != "${INSTALL_DIR}" ]; then
    echo -e "${C_CYAN}📦 Installing from local source files...${C_RESET}"
    cp -r "${SCRIPT_DIR}"/* "${INSTALL_DIR}/"
else
    # Latest tagged release, falling back to main when none is published yet
    TARBALL_URL=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
        | sed -n 's/.*"tarball_url": *"\([^"]*\)".*/\1/p' | head -n 1 || true)
    if [ -z "${TARBALL_URL}" ]; then
        TARBALL_URL="https://api.github.com/repos/${REPO}/tarball/main"
    fi
    echo -e "${C_CYAN}📦 Downloading ${TARBALL_URL##*/}...${C_RESET}"
    curl -fsSL "${TARBALL_URL}" | tar -xz --strip-components=1 -C "${INSTALL_DIR}"
fi

# 5. Make executable & create symlink
chmod +x "${INSTALL_DIR}/bin/cli-agent.js"
ln -sf "${INSTALL_DIR}/bin/cli-agent.js" "${BIN_DIR}/cli-agent"
echo -e "${C_GREEN}✓${C_RESET} Executable linked at ${BIN_DIR}/cli-agent"

# Short alias `ca` (never replaces another program)
ALIAS="${BIN_DIR}/ca"
if [ -L "${ALIAS}" ] && [[ "$(readlink "${ALIAS}")" == "${INSTALL_DIR}/"* ]]; then
    ln -sf "${INSTALL_DIR}/bin/cli-agent.js" "${ALIAS}"
elif [ ! -e "${ALIAS}" ] && [ ! -L "${ALIAS}" ] && ! command -v ca >/dev/null 2>&1; then
    ln -s "${INSTALL_DIR}/bin/cli-agent.js" "${ALIAS}"
    echo -e "${C_GREEN}✓${C_RESET} Short alias: ca"
else
    echo -e "${C_YELLOW}ℹ️  A 'ca' command already exists: the short alias was not created.${C_RESET}"
fi

# 6. Ensure BIN_DIR is in PATH
PATH_UPDATED=0
if [[ ":$PATH:" != *":${BIN_DIR}:"* ]]; then
    export PATH="${BIN_DIR}:${PATH}"
    for rc in "${HOME}/.bashrc" "${HOME}/.zshrc"; do
        if [ -f "${rc}" ]; then
            if ! grep -q 'export PATH=.*\.local/bin' "${rc}"; then
                echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${rc}"
                echo -e "${C_GREEN}✓${C_RESET} Added ~/.local/bin to PATH in ${rc}"
                PATH_UPDATED=1
            fi
        fi
    done
fi

echo -e ""
echo -e "${C_GREEN}${C_BOLD}✨ Installation completed successfully!${C_RESET}"
echo -e ""
echo -e "To launch the workspace, simply run:"
echo -e "  ${C_BOLD}${C_CYAN}cli-agent${C_RESET}   (or ${C_BOLD}${C_CYAN}ca${C_RESET})"
echo -e ""
echo -e "Useful commands:"
echo -e "  ${C_YELLOW}cli-agent add \"My Project\" .${C_RESET}   Add current folder as a bookmark"
echo -e "  ${C_YELLOW}cli-agent list${C_RESET}                 List all saved bookmarks"
echo -e "  ${C_YELLOW}cli-agent update${C_RESET}               Update to the latest version"
echo -e "  ${C_YELLOW}cli-agent help${C_RESET}                 Show help and shortcuts"
echo -e ""

if [ $PATH_UPDATED -eq 1 ]; then
    echo -e "${C_YELLOW}Note: Please reload your shell or run 'source ~/.bashrc' (or ~/.zshrc) to refresh your PATH.${C_RESET}"
fi
