package ble

import (
	"testing"

	"tinygo.org/x/bluetooth"
)

// On macOS, creating CoreBluetooth's managers is what asks for Bluetooth permission, on behalf of
// whatever started the program. The helper must not do it until a request needs Bluetooth: not
// when it starts, and not for any request that can be answered without it. Upstream, the library
// created them when the program started; third_party/bluetooth/TOTTAG-PATCH.md is why it no
// longer does, and this is what fails if that patch is ever lost.
func TestNothingButARequestThatNeedsBluetoothTouchesCoreBluetooth(t *testing.T) {
	if bluetooth.DefaultAdapter.ManagersCreated() {
		t.Fatal("CoreBluetooth's managers exist before anything asked for Bluetooth: the library creates them at start again")
	}
	s, _ := newSession()
	for _, request := range []map[string]any{
		{"id": "a", "op": "identify"},
		{"id": "b", "op": "format"},
		{"id": "c", "op": "connect", "device": "not-a-device"},
		{"id": "d", "op": "read", "connection": "c1"},
		{"id": "e", "op": "disconnect", "connection": "c1"},
		{"id": "f", "op": "scanStop"},
	} {
		handle(t, s, request)
	}
	s.Close()
	if bluetooth.DefaultAdapter.ManagersCreated() {
		t.Fatal("a request that does not need Bluetooth created CoreBluetooth's managers")
	}
}
