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
  Bluetooth without one.
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
