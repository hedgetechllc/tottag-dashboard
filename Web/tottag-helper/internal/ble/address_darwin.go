package ble

import "tinygo.org/x/bluetooth"

// parseAddress reads a device ID as a scan reported it. On macOS that is the identifier
// CoreBluetooth gives the device, stable on this computer: macOS does not show programs a
// device's Bluetooth address. CoreBluetooth remembers devices it has seen before, so a tag found
// by an earlier scan, even in an earlier run, can be connected to without scanning again.
func parseAddress(id string) (bluetooth.Address, error) {
	uuid, err := bluetooth.ParseUUID(id)
	if err != nil {
		return bluetooth.Address{}, err
	}
	return bluetooth.Address{UUID: uuid}, nil
}
