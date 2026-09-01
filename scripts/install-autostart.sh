#!/usr/bin/env bash
# Ubuntu/Linux equivalent of install-autostart.bat. Registers a systemd
# --user unit that starts Mission Control when this user's session
# starts, instead of needing start.sh run by hand every time. Re-run
# this any time (e.g. after moving the project folder) to re-register
# with the current path/node binary; it overwrites the old unit.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WORKDIR="$(pwd)"
NODE_BIN="$(command -v node || true)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/mission-control.service"

if [ -z "$NODE_BIN" ]; then
    echo "Couldn't find 'node' on PATH — install Node.js first, or run this"
    echo "from a shell where 'node' resolves (e.g. after 'nvm use')."
    exit 1
fi

mkdir -p "$UNIT_DIR"
sed -e "s|__WORKDIR__|$WORKDIR|g" -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "scripts/mission-control.service.template" > "$UNIT_FILE"

systemctl --user daemon-reload
systemctl --user enable mission-control.service

echo
echo "Installed. Mission Control will start the next time this user's"
echo "systemd session starts (normally: on login). To start it right now"
echo "without logging out, run: systemctl --user start mission-control"
echo "To also run it with nobody logged in, run (needs sudo, one-time):"
echo "  sudo loginctl enable-linger $USER"
echo "To remove it later, run scripts/uninstall-autostart.sh."
