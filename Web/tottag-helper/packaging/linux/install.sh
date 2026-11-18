#!/bin/sh
# Installs the helper from this tarball, for distributions without dpkg.
#   sudo ./install.sh          system-wide: Chrome, Chromium and Edge, for every user, and a udev
#                              rule so that a TotTag's USB port needs no dialout group
#   ./install.sh --user        just you, in ~/.local: also Brave and Vivaldi, no root (USB then
#                              needs the dialout group, or the system-wide udev rule)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = "--user" ]; then
  DEST="$HOME/.local/lib/tottag-helper"
  mkdir -p "$DEST"
  install -m 755 "$HERE/tottag-helper" "$DEST/tottag-helper"
  "$DEST/tottag-helper" install
  echo "Installed for $(id -un)."
  "$DEST/tottag-helper" doctor || true
  exit 0
fi
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo, or with --user to install just for yourself." >&2; exit 1; }
BIN=/usr/lib/tottag-helper/tottag-helper
install -D -m 755 "$HERE/tottag-helper" "$BIN"
ln -sf "$BIN" /usr/bin/tottag-helper
install -D -m 644 "$HERE/70-tottag.rules" /etc/udev/rules.d/70-tottag.rules
udevadm control --reload-rules 2>/dev/null || true
"$BIN" install --system
echo "Installed. A TotTag already plugged in needs unplugging and plugging in again."
"$BIN" doctor || true
