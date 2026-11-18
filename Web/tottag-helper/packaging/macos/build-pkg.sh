#!/bin/sh
# Builds the macOS installer: TotTag Helper.app, around a universal binary and signed with the
# hardened runtime, in a signed and notarized .pkg that registers the helper with every Chromium
# browser.
#
#   packaging/macos/build-pkg.sh <version> [output dir]
#
# An app bundle rather than a bare executable because Bluetooth permission is the helper's own:
# macOS names a bundle by its Info.plist and icon in the permission prompt and in System
# Settings > Privacy & Security > Bluetooth, and keeps the permission across updates for as long
# as the bundle ID (net.tottag.helper) and the signing team stay the same.
#
# Signing and notarization happen when their credentials are present and are skipped, with a
# warning, when not, so the same script makes a local test build (signed ad hoc) and the release.
#
#   Signing: identities in a keychain on the search list. Found automatically by team, or named
#     by MACOS_APP_IDENTITY / MACOS_INSTALLER_IDENTITY.
#   Notarization, first match wins:
#     NOTARY_KEYCHAIN_PROFILE   a profile made by `xcrun notarytool store-credentials`
#                               (packaging/setup-signing.sh makes one called tottag-notary)
#     APPLE_API_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER   an App Store Connect team API
#                               key with the Developer role (the .p8 file, its ID, the issuer)
#     APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID   an Apple ID and app-specific password
set -eu
VERSION=${1:?usage: build-pkg.sh <version> [output dir]}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=${2:-$ROOT/dist}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
TEAM=${APPLE_TEAM_ID:-D3TVN67UY9}
ID=net.tottag.helper
# The oldest macOS the Go toolchain in go.mod supports (macOS 13 for Go 1.27). Without it,
# cgo's C compiler targets the macOS it runs on, and the helper would not start on anything older
# than the build machine. In the flags as well as the environment, because the flags are part of
# Go's build cache key and MACOSX_DEPLOYMENT_TARGET is not.
MIN_MACOS=13.0
export MACOSX_DEPLOYMENT_TARGET=$MIN_MACOS
export CGO_CFLAGS="-O2 -g -mmacosx-version-min=$MIN_MACOS"
export CGO_LDFLAGS="-O2 -g -mmacosx-version-min=$MIN_MACOS"
# Bundle versions are numbers only: "0.2.0-dev.7" is 0.2.0.
NUMERIC=${VERSION%%[-+]*}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# The Info.plist goes to the linker through -extldflags, which cannot carry a space.
case "$WORK" in *' '*) echo "error: the temporary folder $WORK has a space in it; set TMPDIR to one without" >&2; exit 1 ;; esac

APP="$WORK/root/Library/Application Support/TotTag/TotTag Helper.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# One Info.plist, both linked into the executable (as a development build has it) and the
# bundle's own, so the two can never disagree.
PLIST="$WORK/Info.plist"
cp "$HERE/Info.plist" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$NUMERIC" "$PLIST"
plutil -replace CFBundleVersion -string "$NUMERIC" "$PLIST"
plutil -replace LSMinimumSystemVersion -string "$MIN_MACOS" "$PLIST"
# The icon is the browser extension's, which is the same helper to the person using it.
ICONS="$ROOT/../extension/icons"
if [ -f "$ICONS/icon-128.png" ] && [ -f "$ICONS/icon-32.png" ] && [ -f "$ICONS/icon-16.png" ]; then
  mkdir "$WORK/AppIcon.iconset"
  cp "$ICONS/icon-16.png" "$WORK/AppIcon.iconset/icon_16x16.png"
  cp "$ICONS/icon-32.png" "$WORK/AppIcon.iconset/icon_16x16@2x.png"
  cp "$ICONS/icon-32.png" "$WORK/AppIcon.iconset/icon_32x32.png"
  cp "$ICONS/icon-128.png" "$WORK/AppIcon.iconset/icon_128x128.png"
  iconutil -c icns -o "$APP/Contents/Resources/AppIcon.icns" "$WORK/AppIcon.iconset"
  plutil -replace CFBundleIconFile -string AppIcon "$PLIST"
else
  echo "warning: no icons in $ICONS; the app has the generic icon" >&2
fi
plutil -lint "$PLIST" >/dev/null
cp "$PLIST" "$APP/Contents/Info.plist"

echo "==> Building tottag-helper $VERSION (arm64 + x86_64, macOS $MIN_MACOS and later)"
cd "$ROOT"
for ARCH in arm64 amd64; do
  # cgo: CoreBluetooth for Bluetooth, IOKit for USB.
  CGO_ENABLED=1 GOOS=darwin GOARCH=$ARCH go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION -linkmode=external -extldflags=-Wl,-sectcreate,__TEXT,__info_plist,$PLIST" \
    -o "$WORK/tottag-helper-$ARCH" ./cmd/tottag-helper
done
lipo -create -output "$APP/Contents/MacOS/tottag-helper" "$WORK/tottag-helper-arm64" "$WORK/tottag-helper-amd64"
chmod 755 "$APP/Contents/MacOS/tottag-helper"

identity() {
  security find-identity -v -p basic 2>/dev/null | grep "\"$1: .*($TEAM)\"" | head -1 | sed 's/.*"\(.*\)"/\1/'
}
APP_IDENTITY=${MACOS_APP_IDENTITY:-$(identity "Developer ID Application")}
INSTALLER_IDENTITY=${MACOS_INSTALLER_IDENTITY:-$(identity "Developer ID Installer")}

# The signature's identifier is the bundle ID, from the Info.plist. Bluetooth needs no
# entitlement under the hardened runtime (only in the App Sandbox, which the helper is not in).
if [ -n "$APP_IDENTITY" ]; then
  echo "==> Signing with $APP_IDENTITY"
  codesign --force --options runtime --timestamp --sign "$APP_IDENTITY" "$APP"
else
  echo "warning: no Developer ID Application identity for team $TEAM; the app is signed ad hoc, and macOS will ask for Bluetooth permission again after every build" >&2
  codesign --force --options runtime --sign - "$APP"
fi
codesign --verify --strict --verbose=2 "$APP"

echo "==> Packaging"
# Installer moves a bundle to wherever another copy with the same ID already is ("relocation"),
# such as a development build, and skips one older than what is there. Neither is wanted: the
# browsers' registrations name this path, and installing a release means installing that release.
pkgbuild --analyze --root "$WORK/root" "$WORK/component.plist" >/dev/null
plutil -replace 0.BundleIsRelocatable -bool NO "$WORK/component.plist"
plutil -replace 0.BundleIsVersionChecked -bool NO "$WORK/component.plist"
pkgbuild --root "$WORK/root" --component-plist "$WORK/component.plist" --identifier "$ID" --version "$VERSION" \
  --scripts "$HERE/scripts" --install-location / "$WORK/component.pkg" >/dev/null
sed -e "s/@VERSION@/$VERSION/g" -e "s/@MIN_MACOS@/$MIN_MACOS/g" "$HERE/distribution.xml" > "$WORK/distribution.xml"
PKG="$OUT/TotTag-Helper-macOS.pkg"
if [ -n "$INSTALLER_IDENTITY" ]; then
  echo "==> Signing the installer with $INSTALLER_IDENTITY"
  productbuild --distribution "$WORK/distribution.xml" --resources "$HERE/resources" --package-path "$WORK" \
    --sign "$INSTALLER_IDENTITY" --timestamp "$PKG" >/dev/null
  pkgutil --check-signature "$PKG" | head -3
else
  echo "warning: no Developer ID Installer identity for team $TEAM; the installer is unsigned" >&2
  productbuild --distribution "$WORK/distribution.xml" --resources "$HERE/resources" --package-path "$WORK" "$PKG" >/dev/null
fi

if [ -n "$INSTALLER_IDENTITY" ]; then
  if [ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]; then
    set -- --keychain-profile "$NOTARY_KEYCHAIN_PROFILE"
  elif [ -n "${APPLE_API_KEY_PATH:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    set -- --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    set -- --apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$TEAM"
  else
    set --
  fi
  if [ $# -gt 0 ]; then
    echo "==> Notarizing (this usually takes a few minutes)"
    xcrun notarytool submit "$PKG" "$@" --wait --timeout 30m | tee "$WORK/notary.log"
    if ! grep -q "status: Accepted" "$WORK/notary.log"; then
      NOTARY_ID=$(awk '/^  id:/{print $2; exit}' "$WORK/notary.log")
      [ -n "$NOTARY_ID" ] && xcrun notarytool log "$NOTARY_ID" "$@" || true
      echo "error: notarization was not accepted" >&2
      exit 1
    fi
    xcrun stapler staple "$PKG"
    xcrun stapler validate "$PKG"
  else
    echo "warning: no notarization credentials; the installer is signed but not notarized" >&2
  fi
fi
shasum -a 256 "$PKG"
echo "==> $PKG"
