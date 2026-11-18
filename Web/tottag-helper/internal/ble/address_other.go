//go:build !darwin

package ble

import "tinygo.org/x/bluetooth"

// parseAddress reads a device ID as a scan reported it: on Windows and Linux, the device's
// Bluetooth address, which for a TotTag is its own ID.
func parseAddress(id string) (bluetooth.Address, error) {
	mac, err := bluetooth.ParseMAC(id)
	if err != nil {
		return bluetooth.Address{}, err
	}
	return bluetooth.Address{MACAddress: bluetooth.MACAddress{MAC: mac}}, nil
}
