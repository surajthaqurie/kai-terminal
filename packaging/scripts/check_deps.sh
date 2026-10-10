#!/usr/bin/env bash
set -euo pipefail

echo "========================================="
echo "Kai Linux Runtime & Build Dependency Checker"
echo "========================================="

MISSING_BUILD=()
MISSING_RUNTIME=()

# Helper function to check command existence
check_cmd() {
    if command -v "$1" >/dev/null 2>&1; then
        echo "  [OK] Found command: $1"
    else
        echo "  [MISSING] Command: $1"
        MISSING_BUILD+=("$1")
    fi
}

# Helper function to check library via pkg-config or ldconfig
check_lib() {
    local lib_name="$1"
    local pkg_name="$2"
    if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists "$pkg_name" >/dev/null 2>&1; then
        echo "  [OK] Found library: $lib_name ($pkg_name)"
    elif ldconfig -p 2>/dev/null | grep -i "$lib_name" >/dev/null 2>&1; then
        echo "  [OK] Found library: $lib_name (via ldconfig)"
    else
        echo "  [MISSING] Library: $lib_name ($pkg_name)"
        MISSING_RUNTIME+=("$pkg_name")
    fi
}

echo ""
echo "1. Checking Build Tools..."
check_cmd gcc
check_cmd g++
check_cmd pkg-config
check_cmd make

echo ""
echo "2. Checking Desktop & PTY System Libraries..."
check_lib "libgtk-3" "gtk+-3.0"
check_lib "libwebkit2gtk-4.1" "webkit2gtk-4.1"
check_lib "libayatana-appindicator3" "ayatana-appindicator3-0.1"

echo ""
if [ ${#MISSING_BUILD[@]} -eq 0 ] && [ ${#MISSING_RUNTIME[@]} -eq 0 ]; then
    echo "========================================="
    echo "SUCCESS: All required libraries and build tools are present!"
    echo "========================================="
    exit 0
else
    echo "========================================="
    echo "WARNING: Some dependencies are missing!"
    echo ""
    echo "To install missing dependencies on Debian/Ubuntu/Kali:"
    echo "  sudo apt update && sudo apt install -y \\"
    echo "    build-essential pkg-config libssl-dev \\"
    echo "    libwebkit2gtk-4.1-dev libgtk-3-dev \\"
    echo "    libayatana-appindicator3-dev librsvg2-dev"
    echo ""
    echo "To install missing dependencies on Fedora/RHEL:"
    echo "  sudo dnf install -y \\"
    echo "    gcc gcc-c++ pkgconf-pkg-config openssl-devel \\"
    echo "    webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel"
    echo ""
    echo "To install missing dependencies on Arch Linux:"
    echo "  sudo pacman -S --needed \\"
    echo "    base-devel pkgconf openssl webkit2gtk-4.1 gtk3 libappindicator-gtk3"
    echo "========================================="
    exit 1
fi
