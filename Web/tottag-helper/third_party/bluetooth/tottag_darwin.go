package bluetooth

import "github.com/tinygo-org/cbgo"

// ManagersCreated reports whether either of CoreBluetooth's managers exists, which is what asks
// macOS for Bluetooth permission. TotTag Helper patch, for the helper's tests: it looks at the
// managers themselves, so it also catches them being created somewhere other than Enable, such
// as when the program starts. See TOTTAG-PATCH.md.
func (a *Adapter) ManagersCreated() bool {
	return a.cm != (cbgo.CentralManager{}) || a.pm != (cbgo.PeripheralManager{})
}
