// Package usb is the helper's pipe to devices plugged into this computer with a USB cable.
//
// A TotTag plugged into a computer is a USB serial port. This package lists those ports, opens them,
// writes what the page sends and passes on what arrives, and knows nothing about what any of the
// bytes mean: which tag is on a port, and every command it takes, are the dashboard's, as they are
// over Bluetooth.
package usb

import (
	"errors"
	"io"
	"io/fs"
	"sort"
	"strconv"
	"sync"

	"go.bug.st/serial"
	"go.bug.st/serial/enumerator"

	"github.com/hedgetechllc/tottag-dashboard/tottag-helper/internal/protocol"
)

// Send delivers a reply or an event to the page.
type Send func(message any)

const (
	// maxChunkBytes is the most passed on in one message. Base64 makes it a third larger, which keeps
	// a message well inside Chrome's 1 MB limit.
	maxChunkBytes = 512 * 1024
	// maxPendingBytes is how far reading may get ahead of the page before it waits.
	maxPendingBytes = 8 * 1024 * 1024
	// baudRate is ignored by a USB device, but opening a port takes one.
	baudRate = 115200
)

// Port is what a link needs of an open port: io.ReadWriteCloser, where Close ends a Read in progress.
type Port = io.ReadWriteCloser

// Listed is a USB serial port, as usbList reports it.
type Listed struct {
	Port string `json:"port"`
	// VendorID and ProductID are the USB device's IDs.
	VendorID  int `json:"vendorId"`
	ProductID int `json:"productId"`
}

// Ports is every USB port one page has open.
type Ports struct {
	send Send
	list func() ([]Listed, error)
	open func(name string) (Port, error)

	mu      sync.Mutex
	links   map[string]*link
	counter int
}

// New makes the USB half of a session, which replies and reports events through send.
func New(send Send) *Ports {
	return NewWith(send, systemPorts, openSystemPort)
}

// NewWith is New with stand-ins for the system's ports, for tests.
func NewWith(send Send, list func() ([]Listed, error), open func(name string) (Port, error)) *Ports {
	return &Ports{send: send, list: list, open: open, links: map[string]*link{}}
}

// Handles is whether op is one of this package's.
func Handles(op string) bool {
	switch op {
	case "usbList", "usbOpen", "usbWrite", "usbClose":
		return true
	}
	return false
}

// Handle answers one of the requests Handles names.
func (p *Ports) Handle(request protocol.Request) (map[string]any, error) {
	switch request.Op {
	case "usbList":
		return p.listPorts(request.VendorID, request.ProductID)
	case "usbOpen":
		return p.openPort(request.Port)
	case "usbWrite":
		p.mu.Lock()
		l := p.links[request.Connection]
		p.mu.Unlock()
		if l == nil {
			return nil, protocol.Errorf("not-connected", "That USB port is no longer open.")
		}
		if err := l.write(request.Data); err != nil {
			return nil, protocol.Errorf("write-failed", "%s", err)
		}
		return map[string]any{}, nil
	case "usbClose":
		p.mu.Lock()
		l := p.links[request.Connection]
		delete(p.links, request.Connection)
		p.mu.Unlock()
		if l != nil {
			l.close()
		}
		return map[string]any{}, nil
	}
	return nil, protocol.Errorf("unknown-op", "The helper does not know %q.", request.Op)
}

// Close lets go of every port, for when the page has gone.
func (p *Ports) Close() {
	p.mu.Lock()
	links := p.links
	p.links = map[string]*link{}
	p.mu.Unlock()
	for _, l := range links {
		l.close()
	}
}

func (p *Ports) listPorts(vendor, product int) (map[string]any, error) {
	all, err := p.list()
	if err != nil {
		return nil, protocol.Errorf("usb-unavailable", "%s", err)
	}
	ports := []Listed{}
	for _, port := range all {
		if (vendor == 0 || port.VendorID == vendor) && (product == 0 || port.ProductID == product) {
			ports = append(ports, port)
		}
	}
	sort.Slice(ports, func(i, j int) bool { return ports[i].Port < ports[j].Port })
	return map[string]any{"ports": ports}, nil
}

func (p *Ports) openPort(name string) (map[string]any, error) {
	if name == "" {
		return nil, protocol.Errorf("no-port", "No USB port was named.")
	}
	port, err := p.open(name)
	if err != nil {
		var coded *protocol.Coded
		if errors.As(err, &coded) {
			return nil, err
		}
		return nil, protocol.Errorf("open-failed", "%s", err)
	}
	p.mu.Lock()
	p.counter++
	id := "u" + strconv.Itoa(p.counter)
	l := newLink(id, port, p.send, func() {
		p.mu.Lock()
		delete(p.links, id)
		p.mu.Unlock()
	})
	p.links[id] = l
	p.mu.Unlock()
	l.start()
	return map[string]any{"connection": id}, nil
}

// link is one open port, passing on everything that arrives, in order, until it closes.
type link struct {
	id     string
	port   Port
	send   Send
	forget func()

	writeMu sync.Mutex

	mu      sync.Mutex
	changed *sync.Cond
	pending []byte
	ended   bool
	endErr  error
	// closing is set when the page closed the link, which it needs no word about
	closing bool
}

func newLink(id string, port Port, send Send, forget func()) *link {
	l := &link{id: id, port: port, send: send, forget: forget}
	l.changed = sync.NewCond(&l.mu)
	return l
}

func (l *link) start() {
	go l.read()
	go l.pass()
}

// read takes in what the port receives as fast as it arrives, so the system's own buffer never fills,
// and waits only once it is far ahead of what the page has been sent.
func (l *link) read() {
	buffer := make([]byte, 64*1024)
	for {
		n, err := l.port.Read(buffer)
		l.mu.Lock()
		if n > 0 {
			for len(l.pending) >= maxPendingBytes && !l.closing {
				l.changed.Wait()
			}
			l.pending = append(l.pending, buffer[:n]...)
		}
		if err != nil {
			l.ended = true
			l.endErr = err
		}
		l.changed.Broadcast()
		done := l.ended || l.closing
		l.mu.Unlock()
		if done {
			return
		}
	}
}

// pass sends what has arrived, as much at a time as has built up while the last message went out,
// then says the port closed once everything before that has been sent.
func (l *link) pass() {
	for {
		l.mu.Lock()
		for len(l.pending) == 0 && !l.ended && !l.closing {
			l.changed.Wait()
		}
		if l.closing {
			l.mu.Unlock()
			return
		}
		if len(l.pending) == 0 {
			err := l.endErr
			l.mu.Unlock()
			l.forget()
			_ = l.port.Close()
			event := map[string]any{"event": "usbClosed", "connection": l.id}
			if err != nil {
				event["error"] = describeEnd(err)
			}
			l.send(event)
			return
		}
		chunk := l.pending
		if len(chunk) > maxChunkBytes {
			chunk = chunk[:maxChunkBytes:maxChunkBytes]
			l.pending = l.pending[maxChunkBytes:]
		} else {
			l.pending = nil
		}
		l.changed.Broadcast()
		l.mu.Unlock()
		l.send(map[string]any{"event": "usbData", "connection": l.id, "data": chunk})
	}
}

func (l *link) write(data []byte) error {
	l.writeMu.Lock()
	defer l.writeMu.Unlock()
	for len(data) > 0 {
		n, err := l.port.Write(data)
		if err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

func (l *link) close() {
	l.mu.Lock()
	l.closing = true
	l.changed.Broadcast()
	l.mu.Unlock()
	_ = l.port.Close()
}

func describeEnd(err error) string {
	var portErr *serial.PortError
	if errors.As(err, &portErr) && portErr.Code() == serial.PortClosed {
		return "The tag was unplugged."
	}
	if errors.Is(err, io.EOF) {
		return "The tag was unplugged."
	}
	return err.Error()
}

func systemPorts() ([]Listed, error) {
	details, err := enumerator.GetDetailedPortsList()
	if err != nil {
		return nil, err
	}
	var ports []Listed
	for _, port := range details {
		if !port.IsUSB {
			continue
		}
		vendor, _ := strconv.ParseUint(port.VID, 16, 16)
		product, _ := strconv.ParseUint(port.PID, 16, 16)
		ports = append(ports, Listed{Port: port.Name, VendorID: int(vendor), ProductID: int(product)})
	}
	return ports, nil
}

func openSystemPort(name string) (Port, error) {
	// DTR and RTS on, as a browser opening the same port sets them
	port, err := serial.Open(name, &serial.Mode{BaudRate: baudRate, InitialStatusBits: &serial.ModemOutputBits{DTR: true, RTS: true}})
	if errors.Is(err, fs.ErrNotExist) {
		return nil, protocol.Errorf("no-port", "That USB port is gone. Was the tag unplugged?")
	}
	var portErr *serial.PortError
	if err != nil && errors.As(err, &portErr) {
		switch portErr.Code() {
		case serial.PortBusy:
			return nil, protocol.Errorf("port-busy", "Another program is using that USB port.")
		case serial.PortNotFound:
			return nil, protocol.Errorf("no-port", "That USB port is gone. Was the tag unplugged?")
		case serial.PermissionDenied:
			return nil, protocol.Errorf("port-denied", "This computer does not let the TotTag Helper open that USB port.")
		}
	}
	return port, err
}
