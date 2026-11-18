# TotTag Helper's copy of tinygo.org/x/bluetooth

This is [tinygo.org/x/bluetooth](https://github.com/tinygo-org/bluetooth) **v0.17.0**, used through a
`replace` in [`../../go.mod`](../../go.mod), with one change and without the parts only TinyGo
builds for microcontrollers (`softdevice/`, `examples/`, `images/`).

## The change

Upstream, macOS's `DefaultAdapter` creates CoreBluetooth's central and peripheral managers as the
program starts. Creating one is what asks macOS for Bluetooth permission, on behalf of whatever
started the program. So every run of the helper asked: `tottag-helper version`, `install` or
`doctor` from a terminal asked on the terminal's behalf, and an installer's script on the
installer's, and macOS ends a program that asks on behalf of one that cannot say why it wants
Bluetooth.

Here the managers are created by the first `Enable()`, the call that is documented to start
Bluetooth, and nothing else:

- [`adapter_darwin.go`](adapter_darwin.go): `DefaultAdapter` no longer creates `cm` and `pm`;
  `Enable()` creates them when they do not exist yet. `Reset()` is unchanged: it makes new ones.
- [`tottag_darwin.go`](tottag_darwin.go): `ManagersCreated()`, which looks at the managers
  themselves, so the helper's tests can check that nothing but `Enable()` creates them.

## Updating

Copy the new release over this directory, delete the three directories above, and apply the same
change. `go test ./...` in the helper fails if a run of the helper that does not use Bluetooth
creates the managers.
