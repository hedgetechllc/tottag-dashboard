// Package ble is the Bluetooth half of the helper: a thin pipe between the dashboard and the tags.
//
// It scans, connects, and reads, writes and subscribes to characteristics by UUID, and knows
// nothing about what any of it means. What a TotTag's characteristics hold, how a deployment is
// encoded and how a log download is framed all live in the dashboard, once, so that this program
// rarely needs a new release.
//
// One session serves one browser port for as long as it is open: connections and subscriptions
// outlive the request that made them, which is why Chrome keeps this process running rather
// than starting one per message. A session also holds the page's USB ports, and passes every
// request about them to package usb.
package ble

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"

	"tinygo.org/x/bluetooth"

	"github.com/hedgetechllc/tottag-dashboard/tottag-helper/internal/protocol"
	"github.com/hedgetechllc/tottag-dashboard/tottag-helper/internal/usb"
)

// ProtocolVersion changes whenever a request, reply or event changes shape. 2 added USB.
const ProtocolVersion = 2

// readBufferBytes is the largest value an attribute can hold.
const readBufferBytes = 512

// Send delivers a reply or an event to the page.
type Send func(message any)

// Session is everything one browser port has open.
type Session struct {
	adapter *bluetooth.Adapter
	usb     *usb.Ports
	send    Send
	version string

	enableMu sync.Mutex
	enabled  bool

	mu          sync.Mutex
	scanning    bool
	devices     map[string]bluetooth.Address
	connections map[string]*connection
	counter     int
}

type connection struct {
	id     string
	device bluetooth.Device
	// One operation at a time: the platform layer waits for each result on a channel per
	// characteristic, and CoreBluetooth answers a peripheral's requests in order anyway.
	mu    sync.Mutex
	chars map[string]bluetooth.DeviceCharacteristic
}

// New makes a session that replies and reports events through send.
func New(version string, send Send) *Session {
	return NewWith(version, send, usb.New(usb.Send(send)))
}

// NewWith is New with the USB half given, for tests.
func NewWith(version string, send Send, ports *usb.Ports) *Session {
	return &Session{
		adapter:     bluetooth.DefaultAdapter,
		usb:         ports,
		send:        send,
		version:     version,
		devices:     map[string]bluetooth.Address{},
		connections: map[string]*connection{},
	}
}

// enableAttempts is how many times the library's own ten-second wait for Bluetooth to come on is
// repeated while Bluetooth has not said whether it is on or off. The first time on macOS, that is the
// system asking the person whether the helper may use Bluetooth, which can take a while to answer.
const enableAttempts = 12

// enable starts Bluetooth, once it can. A failure is not kept: Bluetooth turned on, or permission
// given, after the first try is found by the next request that needs it.
func (s *Session) enable() error {
	s.enableMu.Lock()
	defer s.enableMu.Unlock()
	if s.enabled {
		return nil
	}
	var err error
	for attempt := 0; attempt < enableAttempts; attempt++ {
		if err = s.adapter.Enable(); err == nil || !stillWaiting(err) {
			break
		}
	}
	if err != nil {
		return err
	}
	s.enabled = true
	s.adapter.SetConnectHandler(s.connectionChanged)
	return nil
}

// stillWaiting is whether Bluetooth has not yet said whether it is on: the library's wait ran out,
// rather than Bluetooth reporting itself off, unsupported or not allowed.
func stillWaiting(err error) bool {
	return strings.Contains(err.Error(), "timeout enabling")
}

func (s *Session) connectionChanged(device bluetooth.Device, connected bool) {
	if connected {
		return
	}
	address := device.Address.String()
	s.mu.Lock()
	var gone []string
	for id, c := range s.connections {
		if c.device.Address.String() == address {
			gone = append(gone, id)
			delete(s.connections, id)
		}
	}
	s.mu.Unlock()
	for _, id := range gone {
		s.send(map[string]any{"event": "disconnected", "connection": id})
	}
}

// Close stops a scan and lets go of every connection and USB port, for when the page has gone.
func (s *Session) Close() {
	s.usb.Close()
	s.mu.Lock()
	scanning := s.scanning
	connections := s.connections
	s.connections = map[string]*connection{}
	s.mu.Unlock()
	if scanning {
		_ = s.adapter.StopScan()
	}
	for _, c := range connections {
		_ = c.device.Disconnect()
	}
}

// Handle answers one request.
func (s *Session) Handle(raw json.RawMessage) any {
	var request protocol.Request
	if err := json.Unmarshal(raw, &request); err != nil {
		return protocol.Failure{Error: "The request could not be read: " + err.Error(), Code: "malformed"}
	}
	reply, err := s.handle(request)
	if err != nil {
		code := "failed"
		var coded *protocol.Coded
		if errors.As(err, &coded) {
			code = coded.Code
		}
		return protocol.Failure{ID: request.ID, Error: err.Error(), Code: code}
	}
	reply["id"] = request.ID
	reply["ok"] = true
	return reply
}

func (s *Session) identity() map[string]any {
	return map[string]any{"version": s.version, "platform": runtime.GOOS + "/" + runtime.GOARCH, "protocol": ProtocolVersion}
}

func (s *Session) handle(request protocol.Request) (map[string]any, error) {
	if usb.Handles(request.Op) {
		return s.usb.Handle(request)
	}
	switch request.Op {
	case "identify":
		// Answers without touching Bluetooth, for checks that must not prompt for permission
		return s.identity(), nil
	case "hello":
		reply := s.identity()
		if err := s.enable(); err != nil {
			reply["bluetooth"] = err.Error()
		} else {
			reply["bluetooth"] = "ready"
		}
		return reply, nil
	case "scanStart":
		return s.scanStart(request.NamePrefix)
	case "scanStop":
		s.mu.Lock()
		scanning := s.scanning
		s.mu.Unlock()
		if scanning {
			if err := s.adapter.StopScan(); err != nil {
				return nil, err
			}
		}
		return map[string]any{}, nil
	case "connect":
		return s.connect(request)
	case "read":
		return s.withCharacteristic(request, func(c bluetooth.DeviceCharacteristic) (map[string]any, error) {
			buffer := make([]byte, readBufferBytes)
			n, err := c.Read(buffer)
			if err != nil {
				return nil, err
			}
			return map[string]any{"data": buffer[:n]}, nil
		})
	case "write":
		return s.withCharacteristic(request, func(c bluetooth.DeviceCharacteristic) (map[string]any, error) {
			var err error
			if request.WithResponse {
				_, err = c.Write(request.Data)
			} else {
				_, err = c.WriteWithoutResponse(request.Data)
			}
			return map[string]any{}, err
		})
	case "notify":
		return s.withCharacteristic(request, func(c bluetooth.DeviceCharacteristic) (map[string]any, error) {
			if !request.On {
				return map[string]any{}, c.EnableNotifications(nil)
			}
			connection, service, characteristic := request.Connection, normalize(request.Service), normalize(request.Characteristic)
			return map[string]any{}, c.EnableNotifications(func(value []byte) {
				// The platform layer reuses its buffer, and the send happens later
				data := append([]byte(nil), value...)
				s.send(map[string]any{"event": "notification", "connection": connection, "service": service,
					"characteristic": characteristic, "data": data})
			})
		})
	case "disconnect":
		s.mu.Lock()
		c := s.connections[request.Connection]
		delete(s.connections, request.Connection)
		s.mu.Unlock()
		if c != nil {
			_ = c.device.Disconnect()
		}
		return map[string]any{}, nil
	default:
		return nil, protocol.Errorf("unknown-op", "The helper does not know %q.", request.Op)
	}
}

func (s *Session) scanStart(prefix string) (map[string]any, error) {
	if err := s.enable(); err != nil {
		return nil, protocol.Errorf("bluetooth-unavailable", "%s", err)
	}
	s.mu.Lock()
	if s.scanning {
		s.mu.Unlock()
		return map[string]any{}, nil
	}
	s.scanning = true
	s.mu.Unlock()
	go func() {
		err := s.adapter.Scan(func(_ *bluetooth.Adapter, result bluetooth.ScanResult) {
			name := result.LocalName()
			if prefix != "" && !strings.HasPrefix(name, prefix) {
				return
			}
			id := result.Address.String()
			s.mu.Lock()
			s.devices[id] = result.Address
			s.mu.Unlock()
			s.send(map[string]any{"event": "device", "device": id, "name": name, "rssi": result.RSSI})
		})
		s.mu.Lock()
		s.scanning = false
		s.mu.Unlock()
		if err != nil {
			s.send(map[string]any{"event": "scanStopped", "error": err.Error()})
		} else {
			s.send(map[string]any{"event": "scanStopped"})
		}
	}()
	return map[string]any{}, nil
}

func (s *Session) connect(request protocol.Request) (map[string]any, error) {
	// A tag found by this session's scan, or one remembered from an earlier run by the ID a scan
	// reported then: the system keeps what it has seen, so that is usually enough to reach it
	s.mu.Lock()
	address, known := s.devices[request.Device]
	s.mu.Unlock()
	if !known {
		parsed, err := parseAddress(request.Device)
		if err != nil {
			return nil, protocol.Errorf("unknown-device", "%q is not a device ID a scan reports.", request.Device)
		}
		address = parsed
	}
	if err := s.enable(); err != nil {
		return nil, protocol.Errorf("bluetooth-unavailable", "%s", err)
	}
	device, err := s.adapter.Connect(address, bluetooth.ConnectionParams{})
	if err != nil {
		return nil, protocol.Errorf("connect-failed", "%s", err)
	}

	// Only the services asked for: discovering everything on a tag is most of what a connection
	// costs, and the page knows which ones it uses
	var wanted []bluetooth.UUID
	for _, text := range request.Services {
		uuid, err := bluetooth.ParseUUID(text)
		if err != nil {
			_ = device.Disconnect()
			return nil, protocol.Errorf("malformed", "%q is not a UUID.", text)
		}
		wanted = append(wanted, uuid)
	}
	services, err := device.DiscoverServices(wanted)
	if err != nil {
		_ = device.Disconnect()
		return nil, protocol.Errorf("discovery-failed", "%s", err)
	}
	c := &connection{device: device, chars: map[string]bluetooth.DeviceCharacteristic{}}
	found := []map[string]any{}
	for _, service := range services {
		characteristics, err := service.DiscoverCharacteristics(nil)
		if err != nil {
			_ = device.Disconnect()
			return nil, protocol.Errorf("discovery-failed", "%s", err)
		}
		names := []string{}
		for _, characteristic := range characteristics {
			c.chars[key(service.UUID().String(), characteristic.UUID().String())] = characteristic
			names = append(names, normalize(characteristic.UUID().String()))
		}
		found = append(found, map[string]any{"uuid": normalize(service.UUID().String()), "characteristics": names})
	}

	s.mu.Lock()
	s.counter++
	c.id = fmt.Sprintf("c%d", s.counter)
	s.connections[c.id] = c
	s.mu.Unlock()
	mtu := 0
	for _, characteristic := range c.chars {
		if value, err := characteristic.GetMTU(); err == nil {
			mtu = int(value)
		}
		break
	}
	return map[string]any{"connection": c.id, "services": found, "mtu": mtu}, nil
}

func (s *Session) withCharacteristic(request protocol.Request, do func(bluetooth.DeviceCharacteristic) (map[string]any, error)) (map[string]any, error) {
	s.mu.Lock()
	c := s.connections[request.Connection]
	s.mu.Unlock()
	if c == nil {
		return nil, protocol.Errorf("not-connected", "That tag is no longer connected.")
	}
	characteristic, ok := c.chars[key(request.Service, request.Characteristic)]
	if !ok {
		return nil, protocol.Errorf("no-characteristic", "The tag has no characteristic %s in service %s.", request.Characteristic, request.Service)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return do(characteristic)
}

func normalize(uuid string) string { return strings.ToLower(uuid) }

func key(service, characteristic string) string {
	return normalize(service) + "/" + normalize(characteristic)
}
