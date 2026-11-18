# TotTag Helper

The native program the dashboard uses, through the [browser extension](../extension), to reach
TotTags without the browser's chooser. Over Bluetooth it scans for tags nearby, so several can be
picked at once from the dashboard's own list, and reached again later by the ID the scan reported,
with no browser grant to lose. Over USB it lists the ports a TotTag is plugged into, so tags plugged
in appear in the same list.

It is a thin pipe. It scans, connects, and reads, writes and subscribes to characteristics by UUID;
it lists, opens, writes to and passes on what arrives from USB ports; and it knows nothing about what
any of it means. Deployments, log downloads and everything else a tag does are in the dashboard
([`gattTag.ts`](../app/src/adapters/gattTag.ts) for Bluetooth, shared with Web Bluetooth, and
[`serialTag.ts`](../app/src/adapters/serialTag.ts) for USB, shared with Web Serial), so this rarely
needs a new release.

Written in Go, so it ships as one executable per platform with nothing else to install, on
[tinygo.org/x/bluetooth](https://github.com/tinygo-org/bluetooth) (CoreBluetooth on macOS, WinRT on
Windows, BlueZ on Linux) and [go.bug.st/serial](https://github.com/bugst/go-serial) for USB.

## What it does

One process serves one dashboard page, for as long as the page keeps its port to the extension
open: connections, subscriptions and open ports outlive the request that made them.

| Request | |
| --- | --- |
| `identify` | Version, platform and protocol, without touching Bluetooth. |
| `hello` | The same, after starting Bluetooth: `bluetooth` is `ready`, or why not. |
| `scanStart`, `scanStop` | Scan for devices whose name starts with `namePrefix`. |
| `connect` | A device by the ID a scan reported, now or in an earlier run; discovers only the `services` asked for. |
| `read`, `write`, `notify` | One characteristic, by `connection`, `service` and `characteristic`. |
| `disconnect` | Let go of a connection. |
| `usbList` | The USB serial ports with the `vendorId` and `productId` asked for: a TotTag's, from the page. |
| `usbOpen` | Open a port by name; another program holding it is `port-busy`. |
| `usbWrite`, `usbClose` | Bytes to an open port, by `connection`; let go of it. |

| Event | |
| --- | --- |
| `device` | A scan heard a device: its ID, name and signal strength. |
| `notification` | A subscribed characteristic's new value. |
| `disconnected` | A connection dropped. |
| `scanStopped` | The scan ended. |
| `usbData` | Bytes a port received, as many as arrived while the last message went out, up to 512 KB. |
| `usbClosed` | A port closed without being asked to, after everything it received has been passed on: the tag was unplugged. |

`ProtocolVersion` in [`internal/ble`](internal/ble/session.go) and `HELPER_PROTOCOL` in
[`app/src/lib/helper.ts`](../app/src/lib/helper.ts) change together whenever a request, reply or
event changes shape; a dashboard that needs a newer protocol than the installed helper speaks
reports it as outdated rather than calling it.

## macOS

- **Bluetooth permission is the helper's own.** The first time it starts Bluetooth, macOS asks
  whether it may, and it then appears under System Settings → Privacy & Security → Bluetooth. Its
  reason is in an Info.plist linked into the executable
  ([`packaging/macos/Info.plist`](packaging/macos/Info.plist)); macOS ends a program that uses
  Bluetooth without one. The installer puts the helper in an app, `TotTag Helper.app`, with the
  same Info.plist, signed as `net.tottag.helper` with a Developer ID: so the prompt and System
  Settings name it "TotTag Helper", with its icon, and the permission carries over to each update.
- **Nothing but a request that needs Bluetooth touches it.** `install`, `doctor` and `version` run
  from a terminal without asking for permission. The Bluetooth library is a patched copy for this:
  [`third_party/bluetooth/TOTTAG-PATCH.md`](third_party/bluetooth/TOTTAG-PATCH.md).
- A device's ID is CoreBluetooth's identifier for it, stable on that computer; macOS does not show
  programs Bluetooth addresses. On Windows and Linux it is the address.
- USB needs no permission. A port is opened exclusively, as a browser opens one, so a tag the
  dashboard has open is busy to every other program, the Python tools included, and the reverse.

## USB

A USB serial port says nothing about which tag is on it: every TotTag has the same vendor and
product IDs, and its serial-number string is a model name. So the dashboard asks each port which tag
it is, opening it for a moment to do so.

Nothing runs in the background, as for Bluetooth. The dashboard looks at the ports only while its
list of tags is open, every two seconds, as it scans only then; and when it is about to reach a tag
it knows, since a tag plugged into a computer turns its Bluetooth off and has to be reached over USB.
With nothing plugged in, that look is one request. A port's name comes from the socket, not the tag,
so another tag plugged into the same socket gets the same name: what a port said is trusted only for
as long as the list stays open, and asked again otherwise.

## Developing

Go 1.22 or later. From `Web/`:

```sh
npm run test:helper          # the helper's tests, which need no Bluetooth
npm run install-helper       # build it and register it with every Chromium browser found
npm run helper-doctor        # check the registrations, and that it answers
```

Then load the [extension](../extension) unpacked, and run the dashboard (`npm run dev`): it finds
the helper by itself, and says so at the foot of the sidebar. A rebuilt helper may be asked for
Bluetooth permission again, since an unsigned build is a different program to macOS each time.

[`test/spike.html`](test/spike.html) talks to the helper on its own, without the dashboard: serve
`test/` on localhost and open it in a browser with the extension loaded.

## Installing

People install it from the [latest release](https://github.com/hedgetechllc/tottag-dashboard/releases/latest),
built by [`packaging`](packaging) and the [release workflow](../../.github/workflows/tottag-helper-release.yml):

| Asset | |
| --- | --- |
| `TotTag-Helper-macOS.pkg` | `TotTag Helper.app`, universal, for macOS 13 or later. Signed with Developer ID, notarized, stapled. Installs to `/Library/Application Support/TotTag` and registers the helper for every user and for the person installing it. |
| `TotTag-Helper-Windows.exe` | x64 and ARM64, Windows 10 or later. Per-user, so no administrator rights to install. Signed through SignPath. |
| `tottag-helper_{amd64,arm64}.deb` | Registers system-wide for Chrome, Chromium and Edge, and installs a udev rule that lets the person at the computer open a TotTag's USB port without being in the `dialout` group. |
| `tottag-helper_linux_{amd64,arm64}.tar.gz` | With `install.sh`, for other distributions: `sudo ./install.sh`, or `./install.sh --user` for just you (and then USB needs the `dialout` group). |

Each registers the helper through its own `install` command, except the `.deb`, whose manifests
are files dpkg owns; all of them allow the extension ID in
[`internal/install`](internal/install/install.go). `tottag-helper doctor` checks an installation.

## Releasing

Commit and push to `main`, then from `Web/`:

```sh
npm run release:helper -- 0.1.0     # the first release: give the version
npm run release:helper              # after that, the next patch version, 0.1.0 → 0.1.1
npm run release:helper -- minor     # 0.1.0 → 0.2.0; or major, or an exact version like 0.4.2
```

It checks that `main` is committed and the same as GitHub's, and that the [TotTag Helper
workflow](../../.github/workflows/tottag-helper.yml) has passed on GitHub for the helper's code as
it is now — so push, and wait for that run to pass. It then shows what has changed in the helper
since the last release, and asks before tagging the commit `tottag-helper-v<version>` and pushing
the tag. The [release workflow](../../.github/workflows/tottag-helper-release.yml) then builds the
installers above, without running the tests again (`-- --without-ci-check` skips the check, for
when GitHub cannot be asked), installs each on its runner and runs `doctor`, and publishes them as
a GitHub release marked latest. Asset names carry no version, so the dashboard can link to
`releases/latest/download/<name>`; that relies on the helper's releases being this repository's
only ones.

A manual run of the release workflow (Actions → TotTag Helper release → Run workflow) from any
branch makes the same builds, unsigned, as artifacts of the run, without publishing anything: the
way to try a change to the packaging. Once SignPath signing is set up, each release waits for its
two signing requests to be approved in SignPath. A tag's build fails rather than publish a macOS
installer that is signed but not notarized, which Gatekeeper would refuse.

To build the macOS installer on a Mac, signed if the Developer ID identities are in the keychain
and ad hoc otherwise:

```sh
packaging/macos/build-pkg.sh 0.1.0                                  # → dist/TotTag-Helper-macOS.pkg
NOTARY_KEYCHAIN_PROFILE=tottag-notary packaging/macos/build-pkg.sh 0.1.0   # and notarized
```

### Version numbers

The version exists only in the tag: the workflow builds it into the executable, the installers'
metadata, the app's Info.plist and the release's name, so there is no file to edit. A local build
(`npm run helper:build`) names itself from `git describe`, such as `0.1.0-3-gab12cd3-dirty` for
three commits after 0.1.0 with uncommitted changes, and `tottag-helper version` or `doctor` says
which build is installed.

Patch for fixes, minor for new requests, major for anything that breaks an installed dashboard.
Separately, `ProtocolVersion` and `HELPER_PROTOCOL` change together whenever a request, reply or
event changes shape (see above), so release the helper before deploying a dashboard that needs it.

Installed helpers do not update themselves: people install the new release over the old one.
Publishing a release rebuilds the dashboard ([Pages workflow](../../.github/workflows/pages.yml)),
with the repository's tags, so that the dashboard can know the newest version and say "update
available" to anyone whose helper is older.

### Signing credentials

The macOS installer is signed with the same Apple Developer team as A3EM's card helper
(`D3TVN67UY9`), and the Windows one through the same SignPath organization, in a project of its
own. Run [`packaging/setup-signing.sh`](packaging/setup-signing.sh) on the Mac that holds the Apple
Developer account. It checks for the two Developer ID identities, stores notarization credentials
in the login keychain as the `tottag-notary` profile (or uses A3EM's `a3em-notary`), and, if
asked, copies what CI needs into encrypted secrets on a GitHub environment called
`tottag-helper-release` that only `tottag-helper-v*` tags can deploy to. Nothing it asks for is
echoed or written to a file.

| Where | Name | What |
| --- | --- | --- |
| Environment secret | `MACOS_CERTS_P12`, `MACOS_CERTS_PASSWORD` | The Developer ID Application and Installer identities, exported together |
| Environment secret | `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | For `notarytool`: an App Store Connect team API key with the Developer role (recommended) |
| Environment secret | `APPLE_ID`, `APPLE_APP_PASSWORD` | Or instead: an Apple ID and an app-specific password |
| Environment secret | `SIGNPATH_API_TOKEN` | A SignPath CI user's token, a Submitter on the signing policy |
| Repository variable | `APPLE_TEAM_ID` | `D3TVN67UY9` |
| Repository variable | `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG` | From SignPath; the script suggests `tottag-helper` and `release-signing` |

In SignPath, the project for this repository (`tottag-helper`) needs GitHub as its trusted build
system, linked to `hedgetechllc/tottag-dashboard`; a signing policy (`release-signing`) with the
CI user as a Submitter and an approver; and two artifact configurations, named `executables` and
`installer`, pasted from [`packaging/windows/signpath`](packaging/windows/signpath). Each release
makes two signing requests, which an approver accepts in SignPath; the workflow waits up to an
hour for each. Anything not configured is skipped with a warning, so an unsigned build still
completes.

## Code signing policy

The project's code signing policy, which SignPath Foundation asks to be published with the
project, is in [`CODE_SIGNING_POLICY.md`](CODE_SIGNING_POLICY.md).
