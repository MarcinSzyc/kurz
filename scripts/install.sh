#!/bin/sh
# Builds Kurz.app, signs it ad-hoc, and installs it into /Applications, replacing a running Kurz.
# Usage: scripts/install.sh [--no-open]
set -eu

cd "$(dirname "$0")/.."

APP="src-tauri/target/release/bundle/macos/Kurz.app"
DEST="/Applications/Kurz.app"
OPEN=1
[ "${1:-}" = "--no-open" ] && OPEN=0

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# rustup installs cargo here; a fresh terminal may not have it on PATH yet.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
for tool in cargo pnpm codesign ditto; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Missing $tool. See Requirements in README.md."; exit 1; }
done

step "1/5 Dependencies"
pnpm install --frozen-lockfile

step "2/5 Building Kurz.app (a few minutes the first time)"
pnpm tauri build --bundles app

step "3/5 Signing"
# A stable identity keeps Full Disk Access across builds; see scripts/setup-signing.sh.
IDENTITY="Kurz Local Signing"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
    codesign --force --deep --sign "$IDENTITY" "$APP"
    echo "Signed with \"$IDENTITY\"."
    STABLE=1
else
    codesign --force --deep --sign - "$APP"
    echo "Signed ad-hoc. Run scripts/setup-signing.sh once so new builds keep Full Disk Access."
    STABLE=0
fi
codesign --verify --deep --strict "$APP"

step "4/5 Installing into $DEST"
if pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; then
    echo "Quitting the running Kurz…"
    osascript -e 'tell application "Kurz" to quit' >/dev/null 2>&1 || true
    i=0
    while pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; do
        i=$((i + 1))
        [ "$i" -gt 40 ] && { echo "Kurz didn't quit. Quit it from the menu bar and run this again."; exit 1; }
        sleep 0.25
    done
fi
ditto "$APP" "$DEST"
codesign --verify --deep --strict "$DEST"

step "5/5 Done"
echo "Installed $(du -sh "$DEST" | cut -f1) at $DEST"
[ "$STABLE" = 0 ] && echo "An ad-hoc build has a new signature: macOS may ask again for folder access, and Full Disk Access may need turning on again."
[ "$OPEN" = 1 ] && open "$DEST"
exit 0
