#!/usr/bin/env bash
# Ubuntu/Linux equivalent of uninstall-autostart.bat.
set -uo pipefail

UNIT_FILE="$HOME/.config/systemd/user/mission-control.service"

if [ ! -f "$UNIT_FILE" ]; then
    echo "Nothing to remove — no autostart unit is installed."
    exit 0
fi

systemctl --user disable --now mission-control.service 2>/dev/null
rm -f "$UNIT_FILE"
systemctl --user daemon-reload

echo
echo "Removed. Mission Control will no longer start automatically at login."
echo "Any instance already running keeps running; this only affects future logins."
