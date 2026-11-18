#!/bin/sh
# Builds the Linux packages: a .deb per architecture, and a tarball with an install script
# for other distributions.
#
#   packaging/linux/build-deb.sh <version> [output dir]
#
# The .deb registers the helper system-wide for Chrome, Chromium and Edge, and installs a udev
# rule that lets the person at the computer open a TotTag's USB port without being in the
# dialout group. (Chromium installed as a snap cannot start native helpers at all; that is the
# snap's rule.) Bluetooth is BlueZ's, over D-Bus, so the helper needs no cgo and no libraries.
set -eu
VERSION=${1:?usage: build-deb.sh <version> [output dir]}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=${2:-$ROOT/dist}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
LIB=/usr/lib/tottag-helper
BIN=$LIB/tottag-helper
HOST=net.tottag.helper
# The extension allowed to start the helper: the same ID the helper's own `install` writes.
EXTENSION_ID=$(sed -n 's/^const ExtensionID = "\([a-p]\{32\}\)"$/\1/p' "$ROOT/internal/install/install.go")
[ -n "$EXTENSION_ID" ] || { echo "error: no ExtensionID in internal/install/install.go" >&2; exit 1; }
MANIFEST_DIRS="/etc/opt/chrome/native-messaging-hosts /etc/chromium/native-messaging-hosts /etc/opt/edge/native-messaging-hosts"

for ARCH in amd64 arm64; do
  echo "==> $ARCH"
  PKG="$WORK/deb-$ARCH"
  mkdir -p "$PKG/DEBIAN" "$PKG$LIB" "$PKG/usr/bin" "$PKG/usr/lib/udev/rules.d" "$PKG/usr/share/doc/tottag-helper"
  (cd "$ROOT" && CGO_ENABLED=0 GOOS=linux GOARCH=$ARCH go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$PKG$BIN" ./cmd/tottag-helper)
  ln -s "$BIN" "$PKG/usr/bin/tottag-helper"
  : > "$PKG/DEBIAN/conffiles"
  for DIR in $MANIFEST_DIRS; do
    mkdir -p "$PKG$DIR"
    sed -e "s|@PATH@|$BIN|" -e "s|@EXTENSION_ID@|$EXTENSION_ID|" "$HERE/$HOST.json" > "$PKG$DIR/$HOST.json"
    echo "$DIR/$HOST.json" >> "$PKG/DEBIAN/conffiles"
  done
  cp "$HERE/70-tottag.rules" "$PKG/usr/lib/udev/rules.d/70-tottag.rules"
  cp "$HERE/copyright" "$PKG/usr/share/doc/tottag-helper/copyright"
  SIZE=$(du -sk "$PKG" | cut -f1)
  sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" -e "s/@SIZE@/$SIZE/" "$HERE/control" > "$PKG/DEBIAN/control"
  dpkg-deb --root-owner-group --build "$PKG" "$OUT/tottag-helper_${ARCH}.deb" >/dev/null

  TAR="$WORK/tottag-helper"
  rm -rf "$TAR" && mkdir -p "$TAR"
  cp "$PKG$BIN" "$TAR/tottag-helper"
  cp "$HERE/70-tottag.rules" "$HERE/install.sh" "$TAR/"
  chmod 755 "$TAR/install.sh"
  tar -C "$WORK" -czf "$OUT/tottag-helper_linux_${ARCH}.tar.gz" tottag-helper
done
(cd "$OUT" && sha256sum tottag-helper_*.deb tottag-helper_linux_*.tar.gz)
