package ble

// None of these start Bluetooth: every request here is one the helper must answer without it,
// so they run anywhere, with no tag nearby and no permission prompt.

import (
	"encoding/json"
	"errors"
	"runtime"
	"strings"
	"testing"

	"tinygo.org/x/bluetooth"

	"github.com/hedgetechllc/tottag-dashboard/tottag-helper/internal/protocol"
	"github.com/hedgetechllc/tottag-dashboard/tottag-helper/internal/usb"
)

func newSession() (*Session, *[]any) {
	var sent []any
	return New("1.2.3", func(message any) { sent = append(sent, message) }), &sent
}

func handle(t *testing.T, s *Session, request map[string]any) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(request)
	reply, _ := json.Marshal(s.Handle(raw))
	var out map[string]any
	if err := json.Unmarshal(reply, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestIdentifyAnswersWithoutBluetooth(t *testing.T) {
	s, _ := newSession()
	reply := handle(t, s, map[string]any{"id": "r1", "op": "identify"})
	if reply["ok"] != true || reply["id"] != "r1" || reply["version"] != "1.2.3" || reply["protocol"] != float64(ProtocolVersion) {
		t.Fatalf("got %v", reply)
	}
	if reply["platform"] != runtime.GOOS+"/"+runtime.GOARCH {
		t.Fatalf("platform %v", reply["platform"])
	}
	if _, asked := reply["bluetooth"]; asked {
		t.Fatalf("identify reported on Bluetooth, so it may have started it: %v", reply)
	}
}

func TestARequestThatIsNotJSONIsRefused(t *testing.T) {
	s, _ := newSession()
	reply, _ := json.Marshal(s.Handle(json.RawMessage(`{"op":`)))
	var failure protocol.Failure
	_ = json.Unmarshal(reply, &failure)
	if failure.OK || failure.Code != "malformed" {
		t.Fatalf("got %s", reply)
	}
}

func TestAnUnknownRequestIsRefusedByName(t *testing.T) {
	s, _ := newSession()
	reply := handle(t, s, map[string]any{"id": "r2", "op": "format"})
	if reply["ok"] != false || reply["id"] != "r2" || reply["code"] != "unknown-op" {
		t.Fatalf("got %v", reply)
	}
}

func TestSomethingThatIsNotADeviceIDIsRefusedBeforeBluetoothStarts(t *testing.T) {
	s, _ := newSession()
	reply := handle(t, s, map[string]any{"id": "r3", "op": "connect", "device": "not-a-device"})
	if reply["ok"] != false || reply["code"] != "unknown-device" {
		t.Fatalf("got %v", reply)
	}
}

func TestADeviceIDIsReadTheWayThisPlatformReportsIt(t *testing.T) {
	id := "C0:98:E5:42:02:31"
	if runtime.GOOS == "darwin" {
		id = "a86f0191-9d8a-ea30-6dde-1a294afae649"
	}
	address, err := parseAddress(id)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(address.String(), id) {
		t.Fatalf("read %q back as %q", id, address.String())
	}
}

func TestNothingCanBeDoneOnAConnectionThatIsNotOpen(t *testing.T) {
	s, _ := newSession()
	for _, op := range []string{"read", "write", "notify"} {
		reply := handle(t, s, map[string]any{"id": op, "op": op, "connection": "c9",
			"service": "0000180a-0000-1000-8000-00805f9b34fb", "characteristic": "00002a23-0000-1000-8000-00805f9b34fb"})
		if reply["ok"] != false || reply["code"] != "not-connected" {
			t.Errorf("%s: got %v", op, reply)
		}
	}
}

func TestACharacteristicTheConnectionDidNotDiscoverIsNamed(t *testing.T) {
	s, _ := newSession()
	s.connections["c1"] = &connection{id: "c1", chars: map[string]bluetooth.DeviceCharacteristic{}}
	reply := handle(t, s, map[string]any{"id": "r4", "op": "read", "connection": "c1",
		"service": "0000180A-0000-1000-8000-00805F9B34FB", "characteristic": "00002A26-0000-1000-8000-00805F9B34FB"})
	if reply["ok"] != false || reply["code"] != "no-characteristic" {
		t.Fatalf("got %v", reply)
	}
}

func TestDisconnectingWhatIsNotConnectedIsNotAnError(t *testing.T) {
	s, _ := newSession()
	if reply := handle(t, s, map[string]any{"id": "r5", "op": "disconnect", "connection": "c7"}); reply["ok"] != true {
		t.Fatalf("got %v", reply)
	}
}

func TestClosingASessionThatNeverUsedBluetoothSendsNothing(t *testing.T) {
	s, sent := newSession()
	s.Close()
	if len(*sent) != 0 {
		t.Fatalf("sent %v", *sent)
	}
}

func TestUUIDsAreComparedWithoutRegardToCase(t *testing.T) {
	if key("0000180A-0000-1000-8000-00805F9B34FB", "00002A23-0000-1000-8000-00805F9B34FB") !=
		key("0000180a-0000-1000-8000-00805f9b34fb", "00002a23-0000-1000-8000-00805f9b34fb") {
		t.Fatal("the same characteristic written in different cases was taken for two")
	}
}

func TestOnlyBluetoothNotYetAnsweringIsWaitedOutRatherThanReported(t *testing.T) {
	// The library's own words, in third_party/bluetooth/adapter_darwin.go: its wait ran out while the
	// system was still asking whether the helper may use Bluetooth
	if !stillWaiting(errors.New("timeout enabling CentralManager")) {
		t.Fatal("a wait that ran out was taken for an answer")
	}
	for _, answer := range []string{"bluetooth is powered off", "bluetooth is not authorized for this app", "bluetooth is not supported on this device"} {
		if stillWaiting(errors.New(answer)) {
			t.Errorf("%q was waited out rather than reported", answer)
		}
	}
}

func TestUSBRequestsGoToTheUSBHalfWithoutStartingBluetooth(t *testing.T) {
	ports := usb.NewWith(func(any) {}, func() ([]usb.Listed, error) {
		return []usb.Listed{{Port: "/dev/cu.usbmodem1101", VendorID: 0x1209, ProductID: 0x2828}}, nil
	}, nil)
	s := NewWith("1.2.3", func(any) {}, ports)
	reply := handle(t, s, map[string]any{"id": "r6", "op": "usbList", "vendorId": 0x1209, "productId": 0x2828})
	listed, _ := reply["ports"].([]any)
	if reply["ok"] != true || reply["id"] != "r6" || len(listed) != 1 {
		t.Fatalf("got %v", reply)
	}
	if s.enabled {
		t.Fatal("listing USB ports started Bluetooth")
	}
}

func TestManufacturerDataIsPassedOnAsHexByCompany(t *testing.T) {
	// A TotTag on its charger: company 0x02E0, role byte 13
	raw, _ := json.Marshal(manufacturerData([]bluetooth.ManufacturerDataElement{{CompanyID: 0x02e0, Data: []byte{13}}}))
	if string(raw) != `[{"company":736,"data":"0d"}]` {
		t.Fatalf("got %s", raw)
	}
	// Nothing advertised is an empty list, not null, so the page can tell it from an older helper
	raw, _ = json.Marshal(manufacturerData(nil))
	if string(raw) != `[]` {
		t.Fatalf("got %s", raw)
	}
}
