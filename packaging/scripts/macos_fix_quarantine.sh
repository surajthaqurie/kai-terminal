#!/usr/bin/env bash
set -euo pipefail

echo "========================================="
echo "Kai macOS Gatekeeper Quarantine Fixer"
echo "========================================="

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 /path/to/Kai.app (or /path/to/Kai.dmg)"
    echo ""
    echo "Example:"
    echo "  $0 /Applications/Kai.app"
    exit 1
fi

TARGET="$1"

if [ ! -e "$TARGET" ]; then
    echo "Error: Target '$TARGET' does not exist."
    exit 1
fi

echo "Inspecting quarantine attributes on: $TARGET"
if xattr "$TARGET" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo "Found quarantine attribute: com.apple.quarantine"
    echo "Removing quarantine attribute..."
    xattr -d com.apple.quarantine "$TARGET"
    echo "SUCCESS: Quarantine attribute removed!"
    echo "You can now launch $TARGET without Gatekeeper blocking it."
else
    echo "No quarantine attribute found on $TARGET. The application is ready to launch."
fi
